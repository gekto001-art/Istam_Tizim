import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, optText } from '../lib/util.js';

/**
 * Sotuv bo'limi — alohida biznes. 1-qism: ishlab chiqarishdan prixod va hisob-kitob.
 *  - tayyor mahsulot skladi Sotuv bo'limiga o'tkazma yuboradi: narx — zakazdagi «Sotuv bo'limiga narx» (1 / 2 sort),
 *    tannarx — skladdagi o'rtacha; yuborilganda mahsulot skladdan chiqadi;
 *  - Sotuv bo'limi qabul qiladi (qarz bo'ladi) yoki rad etadi (mahsulot skladga qaytadi);
 *  - Sotuvning ishlab chiqarishga to'lovlari qarzni yopadi;
 *  - ishlab chiqarish foydasi = ichki narx − tannarx (qabul qilinganlar bo'yicha).
 */
export const salesRouter = Router();
salesRouter.use(requireAction('sales.read'));

const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));
const LOCK = 'SELECT pg_advisory_xact_lock(740111)'; // tayyor mahsulot skladidan chiqim ketma-ket
const cents = (v: string | number | null) => Math.round(Number(v ?? 0) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);

// ---------- O'tkazmalar ----------
const TRANSFERS = `
  SELECT t.id, t.doc_date, t.status, t.note, t.created_at, t.decided_date, t.decided_at, t.reject_reason,
         uc.full_name AS created_by_name, ud.full_name AS decided_by_name,
         sum(i.qty)::int AS qty, sum(i.qty * i.price) AS amount_uzs, sum(i.qty * i.unit_cost_uzs) AS cost_uzs,
         json_agg(json_build_object(
           'order_id', i.order_id, 'partiya_no', o.partiya_no, 'product_type_name', pt.name, 'artikul', o.artikul, 'model', o.model,
           'color_id', i.color_id, 'color_name', c.name, 'size_id', i.size_id, 'size_name', s.name, 'sort', i.sort,
           'qty', i.qty, 'price', i.price, 'unit_cost_uzs', i.unit_cost_uzs
         ) ORDER BY o.partiya_no, lower(c.name), s.sort, i.sort) AS items
    FROM sales_transfers t JOIN sales_transfer_items i ON i.transfer_id = t.id
    JOIN orders o ON o.id = i.order_id JOIN product_types pt ON pt.id = o.product_type_id
    JOIN colors c ON c.id = i.color_id JOIN sizes s ON s.id = i.size_id
    LEFT JOIN users uc ON uc.id = t.created_by LEFT JOIN users ud ON ud.id = t.decided_by`;

salesRouter.get('/transfers', async (req, res) => {
  const q = z
    .object({
      status: z.enum(['sent', 'decided', 'all']).default('all'),
      from: date.optional(),
      to: date.optional(),
      limit: z.coerce.number().int().min(1).max(2000).default(300),
    })
    .parse(req.query);
  const cond = { sent: "t.status = 'sent'", decided: "t.status <> 'sent'", all: 'true' }[q.status];
  const rows = (
    await pool.query(
      `${TRANSFERS} WHERE ${cond} AND ($1::date IS NULL OR t.doc_date >= $1) AND ($2::date IS NULL OR t.doc_date <= $2)
        GROUP BY t.id, uc.full_name, ud.full_name
        ORDER BY ${q.status === 'sent' ? 't.doc_date, t.id' : 'coalesce(t.decided_at, t.created_at) DESC, t.id DESC'} LIMIT $3`,
      [q.from ?? null, q.to ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

salesRouter.post('/transfers', requireAction('sales.transfer'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      doc_date: date,
      note: optText(500),
      rows: z
        .array(z.object({ order_id: idParam, color_id: idParam, size_id: idParam, sort: z.union([z.literal(1), z.literal(2)]), qty: z.coerce.number().int().min(1).max(1e7) }))
        .min(1)
        .max(1000),
    })
    .parse(req.body);
  const keys = new Set(b.rows.map((r) => `${r.order_id}:${r.color_id}:${r.size_id}:${r.sort}`));
  if (keys.size !== b.rows.length) throw badRequest('Bir xil mahsulot (partiya, rang, razmer, sort) ikki marta yozilgan');
  const data = await tx(async (db) => {
    await db.query(LOCK);
    const id = (
      await db.query('INSERT INTO sales_transfers (doc_date, note, created_by) VALUES ($1, $2, $3) RETURNING id', [b.doc_date, b.note, ctx.userId])
    ).rows[0].id as number;
    for (const r of b.rows) {
      const x = (
        await db.query(
          `SELECT o.partiya_no, o.sale_price1, o.sale_price2, c.name AS color_name, s.name AS size_name,
                  (SELECT coalesce(sum(m.dir * m.qty), 0)::int FROM fg_moves m
                    WHERE m.order_id = o.id AND m.color_id = c.id AND m.size_id = s.id AND m.sort = $4) AS left_qty,
                  (SELECT round(sum(m.qty * m.unit_cost_uzs) / nullif(sum(m.qty), 0), 2) FROM fg_moves m
                    WHERE m.order_id = o.id AND m.color_id = c.id AND m.size_id = s.id AND m.dir = 1) AS avg_cost
             FROM orders o, colors c, sizes s WHERE o.id = $1 AND c.id = $2 AND s.id = $3`,
          [r.order_id, r.color_id, r.size_id, r.sort],
        )
      ).rows[0];
      if (!x) throw notFound('Mahsulot (partiya, rang yoki razmer)');
      const what = `Partiya ${x.partiya_no}, ${x.color_name} ${x.size_name}, ${r.sort} sort`;
      const price = r.sort === 1 ? x.sale_price1 : x.sale_price2;
      if (price == null) throw badRequest(`${what}: Sotuv bo'limiga ${r.sort} sort narxi belgilanmagan (zakazda belgilanadi)`);
      if (r.qty > x.left_qty) throw badRequest(`${what}: skladda ${x.left_qty} dona — ${r.qty} dona yuborib bo'lmaydi`);
      const cost = x.avg_cost ?? 0;
      await db.query(
        `INSERT INTO sales_transfer_items (transfer_id, order_id, color_id, size_id, sort, qty, price, unit_cost_uzs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, r.order_id, r.color_id, r.size_id, r.sort, r.qty, price, cost],
      );
      await db.query(
        `INSERT INTO fg_moves (move_date, kind, order_id, color_id, size_id, sort, dir, qty, unit_cost_uzs, transfer_id, created_by)
         VALUES ($1, 'transfer', $2, $3, $4, $5, -1, $6, $7, $8, $9)`,
        [b.doc_date, r.order_id, r.color_id, r.size_id, r.sort, r.qty, cost, id, ctx.userId],
      );
    }
    const t = (await db.query(`${TRANSFERS} WHERE t.id = $1 GROUP BY t.id, uc.full_name, ud.full_name`, [id])).rows[0];
    await audit(db, ctx, 'sales_transfer', id, 'create', undefined, b);
    return t;
  });
  res.status(201).json(data);
});

salesRouter.post('/transfers/:id/decide', requireAction('sales.accept'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = z.object({ decision: z.enum(['accepted', 'rejected']), decided_date: date, reason: optText(500) }).parse(req.body);
  if (b.decision === 'rejected' && !b.reason) throw badRequest('Rad etish sababini yozing');
  const data = await tx(async (db) => {
    const t = (await db.query('SELECT * FROM sales_transfers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!t) throw notFound('O\'tkazma');
    if (t.status !== 'sent') throw conflict(`O'tkazma №${id}: munosabat allaqachon berilgan`);
    if (b.decided_date < t.doc_date) throw badRequest('Qabul sanasi o\'tkazma sanasidan oldin bo\'lishi mumkin emas');
    await db.query(
      'UPDATE sales_transfers SET status = $2, decided_date = $3, reject_reason = $4, decided_by = $5, decided_at = now() WHERE id = $1',
      [id, b.decision, b.decided_date, b.decision === 'rejected' ? b.reason : null, ctx.userId],
    );
    // rad etilsa mahsulot tayyor mahsulot skladiga qaytadi
    if (b.decision === 'rejected') await db.query('DELETE FROM fg_moves WHERE transfer_id = $1', [id]);
    await audit(db, ctx, 'sales_transfer', id, 'decide', { status: 'sent' }, b);
    return (await db.query(`${TRANSFERS} WHERE t.id = $1 GROUP BY t.id, uc.full_name, ud.full_name`, [id])).rows[0];
  });
  res.json(data);
});

salesRouter.delete('/transfers/:id', requireAction('sales.transfer'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const t = (await db.query('SELECT * FROM sales_transfers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!t) throw notFound('O\'tkazma');
    if (t.status !== 'sent') throw conflict('Sotuv bo\'limi munosabat bildirgan o\'tkazmani o\'chirib bo\'lmaydi');
    const items = (await db.query('SELECT * FROM sales_transfer_items WHERE transfer_id = $1', [id])).rows;
    await db.query('DELETE FROM sales_transfers WHERE id = $1', [id]); // qatorlar va sklad chiqimi ham o'chadi
    await audit(db, ctx, 'sales_transfer', id, 'delete', { ...t, items }, undefined);
  });
  res.status(204).end();
});

// ---------- To'lovlar (Sotuv → ishlab chiqarish) ----------
const METHOD = z.enum(['naqd', 'plastik', 'bank']);

salesRouter.get('/payments', async (req, res) => {
  const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
  const rows = (
    await pool.query(
      `SELECT p.*, u.full_name AS created_by_name FROM sales_payments p LEFT JOIN users u ON u.id = p.created_by
        WHERE ($1::date IS NULL OR p.pay_date >= $1) AND ($2::date IS NULL OR p.pay_date <= $2)
        ORDER BY p.pay_date DESC, p.id DESC`,
      [q.from ?? null, q.to ?? null],
    )
  ).rows;
  res.json(rows);
});

salesRouter.post('/payments', requireAction('sales.pay'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({ pay_date: date, amount_uzs: z.coerce.number().finite().positive().max(1e13), method: METHOD, note: optText(500) })
    .parse(req.body);
  const row = await tx(async (db) => {
    const p = (
      await db.query('INSERT INTO sales_payments (pay_date, amount_uzs, method, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [
        b.pay_date, b.amount_uzs, b.method, b.note, ctx.userId,
      ])
    ).rows[0];
    await audit(db, ctx, 'sales_payment', p.id, 'create', undefined, p);
    return p;
  });
  res.status(201).json(row);
});

salesRouter.delete('/payments/:id', requireAction('sales.pay'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const p = (await db.query('DELETE FROM sales_payments WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!p) throw notFound('To\'lov');
    await audit(db, ctx, 'sales_payment', id, 'delete', p, undefined);
  });
  res.status(204).end();
});

// ---------- Hisob-kitob (akt sverka): qabul qilingan o'tkazma — qarz, to'lov — kamaytiradi ----------
salesRouter.get('/ledger', async (req, res) => {
  const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
  if (q.from && q.to && q.to < q.from) throw badRequest('Sanagacha sanadan oldin bo\'lishi mumkin emas');
  const from = q.from ?? null;
  const to = q.to ?? null;
  const LINES = `
    SELECT t.decided_date AS date, 'transfer' AS kind, t.id AS ref_id, t.note,
           sum(i.qty * i.price) AS debit, 0::numeric AS credit, sum(i.qty * i.unit_cost_uzs) AS cost, sum(i.qty)::int AS qty
      FROM sales_transfers t JOIN sales_transfer_items i ON i.transfer_id = t.id WHERE t.status = 'accepted' GROUP BY t.id
    UNION ALL
    SELECT p.pay_date, 'payment', p.id, concat_ws(' · ', p.method, p.note), 0, p.amount_uzs, 0, NULL FROM sales_payments p`;
  const opening = (
    await pool.query(`SELECT coalesce(sum(debit - credit), 0) AS bal FROM (${LINES}) l WHERE $1::date IS NOT NULL AND l.date < $1`, [from])
  ).rows[0].bal;
  const lines = (
    await pool.query(
      `SELECT * FROM (${LINES}) l WHERE ($1::date IS NULL OR l.date >= $1) AND ($2::date IS NULL OR l.date <= $2)
        ORDER BY l.date, l.kind DESC, l.ref_id`,
      [from, to],
    )
  ).rows;
  let bal = cents(opening);
  let debit = 0;
  let credit = 0;
  let cost = 0;
  const rows = lines.map((l) => {
    debit += cents(l.debit);
    credit += cents(l.credit);
    cost += cents(l.cost);
    bal += cents(l.debit) - cents(l.credit);
    return { ...l, balance: fromCents(bal) };
  });
  const pending = (
    await pool.query(
      `SELECT count(DISTINCT t.id)::int AS count, coalesce(sum(i.qty * i.price), 0) AS amount_uzs
         FROM sales_transfers t JOIN sales_transfer_items i ON i.transfer_id = t.id WHERE t.status = 'sent'`,
    )
  ).rows[0];
  res.json({
    opening: fromCents(cents(opening)),
    rows,
    totals: { debit: fromCents(debit), credit: fromCents(credit), closing: fromCents(bal), cost: fromCents(cost), margin: fromCents(debit - cost) },
    pending,
  });
});
