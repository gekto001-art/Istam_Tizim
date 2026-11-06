import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, optText } from '../lib/util.js';
import { deleteCashBySource, postSupplierPayment } from '../services/cash.js';

/**
 * Sotuv bo'limi skladi (4.2) — /api/sales/sklad/...:
 *  - tovarlar: o'zimizniki (ishlab chiqarishdan qabul qilinganda o'zi yaratiladi) va boshqa postavshiklarniki;
 *  - hujjatlar: postavshikdan prixod, do'konga jo'natish, do'kondan qaytish, inventarizatsiya (±);
 *  - qoldiq va o'rtacha tannarx (Sotuv uchun: ichki narx yoki xarid narxi);
 *  - postavshiklar: qarz = prixod − to'lov; to'lov hamyon tanlansa kassaga «Tovar xaridi» chiqimi;
 *  - Billz bilan solishtirish (barcode bo'yicha).
 */
export const salesStockRouter = Router();

const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));
const LOCK = 'SELECT pg_advisory_xact_lock(740112)'; // Sotuv skladi harakatlari ketma-ket
const cents = (v: string | number | null) => Math.round(Number(v ?? 0) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);

// ---------- Ishlab chiqarishdan qabul qilingan o'tkazma → Sotuv skladiga kirim ----------
export async function receiveTransfer(db: Db, transferId: number, moveDate: string, userId: number) {
  await db.query(LOCK);
  await db.query(
    `INSERT INTO sales_products (source, order_id, color_id, size_id, sort, name, artikul, color_name, size_name)
     SELECT 'own', i.order_id, i.color_id, i.size_id, i.sort, concat_ws(' ', pt.name, nullif(o.model, '')), o.artikul, c.name, s.name
       FROM sales_transfer_items i JOIN orders o ON o.id = i.order_id JOIN product_types pt ON pt.id = o.product_type_id
       JOIN colors c ON c.id = i.color_id JOIN sizes s ON s.id = i.size_id
      WHERE i.transfer_id = $1
     ON CONFLICT (order_id, color_id, size_id, sort) DO NOTHING`,
    [transferId],
  );
  await db.query(
    `INSERT INTO sales_moves (move_date, kind, product_id, dir, qty, unit_cost, transfer_id, created_by)
     SELECT $2, 'transfer', p.id, 1, i.qty, i.price, i.transfer_id, $3
       FROM sales_transfer_items i
       JOIN sales_products p ON p.order_id = i.order_id AND p.color_id = i.color_id AND p.size_id = i.size_id AND p.sort = i.sort
      WHERE i.transfer_id = $1`,
    [transferId, moveDate, userId],
  );
}

// ---------- Tovarlar va qoldiq ----------
const STOCK = `
  SELECT p.id, p.source, p.order_id, o.partiya_no, p.color_id, p.size_id, p.sort, p.name, p.artikul, p.color_name, p.size_name,
         p.barcode, p.supplier_id, sp.name AS supplier_name, p.is_active,
         coalesce(sum(m.dir * m.qty), 0)::int AS qty,
         coalesce(sum(m.qty) FILTER (WHERE m.kind IN ('transfer', 'purchase')), 0)::int AS received,
         (coalesce(sum(m.qty) FILTER (WHERE m.kind = 'shop'), 0) - coalesce(sum(m.qty) FILTER (WHERE m.kind = 'shop_return'), 0))::int AS to_shops,
         round(sum(m.qty * m.unit_cost) FILTER (WHERE m.kind IN ('transfer', 'purchase'))
               / nullif(sum(m.qty) FILTER (WHERE m.kind IN ('transfer', 'purchase')), 0), 2) AS avg_cost
    FROM sales_products p LEFT JOIN sales_moves m ON m.product_id = p.id
    LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN sales_suppliers sp ON sp.id = p.supplier_id`;
const STOCK_GROUP = 'GROUP BY p.id, o.partiya_no, sp.name';

salesStockRouter.get('/stock', async (req, res) => {
  const q = z
    .object({
      q: z.string().trim().max(100).optional(),
      source: z.enum(['own', 'other', 'all']).default('all'),
      only: z.enum(['positive', 'all']).default('positive'),
    })
    .parse(req.query);
  const rows = (
    await pool.query(
      `SELECT x.*, round(x.qty * coalesce(x.avg_cost, 0), 2) AS value FROM (
         ${STOCK}
          WHERE ($1::text = 'all' OR p.source = $1)
            AND ($2::text IS NULL OR lower(concat_ws(' ', o.partiya_no, p.name, p.artikul, p.color_name, p.size_name, p.barcode, sp.name)) LIKE $2)
          ${STOCK_GROUP}) x
        WHERE $3::text = 'all' OR x.qty <> 0
        ORDER BY x.source, x.partiya_no NULLS LAST, lower(x.name), lower(x.color_name), x.size_name, x.sort NULLS LAST`,
      [q.source, q.q ? `%${q.q.toLowerCase()}%` : null, q.only],
    )
  ).rows;
  let qty = 0;
  let value = 0;
  for (const r of rows) {
    qty += r.qty;
    value += cents(r.value);
  }
  res.json({ rows, totals: { qty, value: fromCents(value) } });
});

salesStockRouter.get('/products/:id/moves', async (req, res) => {
  const id = idParam.parse(req.params.id);
  const p = (await pool.query(`${STOCK} WHERE p.id = $1 ${STOCK_GROUP}`, [id])).rows[0];
  if (!p) throw notFound('Tovar');
  const moves = (
    await pool.query(
      `SELECT m.id, m.move_date, m.kind, m.dir, m.qty, m.unit_cost, m.transfer_id, m.doc_id, d.shop_name, sp.name AS supplier_name, d.note,
              sum(m.dir * m.qty) OVER (ORDER BY m.move_date, m.id)::int AS balance, u.full_name AS created_by_name
         FROM sales_moves m LEFT JOIN sales_docs d ON d.id = m.doc_id LEFT JOIN sales_suppliers sp ON sp.id = d.supplier_id
         LEFT JOIN users u ON u.id = m.created_by
        WHERE m.product_id = $1 ORDER BY m.move_date DESC, m.id DESC`,
      [id],
    )
  ).rows;
  res.json({ product: p, moves });
});

const barcode = z
  .string()
  .trim()
  .max(64)
  .nullish()
  .transform((v) => (v ? v : null));

async function checkBarcode(db: Db, code: string | null, selfId: number | null) {
  if (!code) return;
  const other = (await db.query('SELECT id, name FROM sales_products WHERE barcode = $1 AND id IS DISTINCT FROM $2', [code, selfId])).rows[0];
  if (other) throw conflict(`Barcode ${code} boshqa tovarda bor: «${other.name}» (№${other.id})`);
}

const productBody = z.object({
  name: z.string().trim().min(1).max(200),
  artikul: optText(100),
  color_name: optText(100),
  size_name: optText(50),
  barcode,
  supplier_id: idParam.nullish(),
});

salesStockRouter.post('/products', requireAction('sales.stock'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = productBody.parse(req.body);
  const row = await tx(async (db) => {
    await checkBarcode(db, b.barcode, null);
    const p = (
      await db.query(
        `INSERT INTO sales_products (source, name, artikul, color_name, size_name, barcode, supplier_id)
         VALUES ('other', $1, $2, $3, $4, $5, $6) RETURNING *`,
        [b.name, b.artikul, b.color_name, b.size_name, b.barcode, b.supplier_id ?? null],
      )
    ).rows[0];
    await audit(db, ctx, 'sales_product', p.id, 'create', undefined, p);
    return p;
  });
  res.status(201).json(row);
});

salesStockRouter.put('/products/:id', requireAction('sales.stock'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = productBody.partial().extend({ is_active: z.boolean().optional() }).parse(req.body);
  const row = await tx(async (db) => {
    const old = (await db.query('SELECT * FROM sales_products WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw notFound('Tovar');
    if (old.source === 'own' && (b.name !== undefined || b.artikul !== undefined || b.color_name !== undefined || b.size_name !== undefined || b.supplier_id !== undefined)) {
      throw badRequest('O\'zimiz ishlab chiqargan tovarda faqat barcode va faollikni o\'zgartirish mumkin — nomi zakazdan olinadi');
    }
    if (b.barcode !== undefined) await checkBarcode(db, b.barcode, id);
    const next = { ...old, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    const p = (
      await db.query(
        `UPDATE sales_products SET name = $2, artikul = $3, color_name = $4, size_name = $5, barcode = $6, supplier_id = $7, is_active = $8
          WHERE id = $1 RETURNING *`,
        [id, next.name, next.artikul, next.color_name, next.size_name, next.barcode, next.supplier_id ?? null, next.is_active],
      )
    ).rows[0];
    await audit(db, ctx, 'sales_product', id, 'update', old, p);
    return p;
  });
  res.json(row);
});

// ---------- Hujjatlar ----------
const DOCS = `
  SELECT d.id, d.kind, d.doc_date, d.supplier_id, sp.name AS supplier_name, d.shop_id, d.shop_name, d.note, d.created_at,
         u.full_name AS created_by_name,
         sum(m.qty)::int AS qty, sum(m.dir * m.qty)::int AS net_qty, sum(m.qty * m.unit_cost) AS amount_uzs,
         json_agg(json_build_object(
           'product_id', p.id, 'source', p.source, 'partiya_no', o.partiya_no, 'name', p.name, 'artikul', p.artikul,
           'color_name', p.color_name, 'size_name', p.size_name, 'sort', p.sort, 'barcode', p.barcode,
           'dir', m.dir, 'qty', m.qty, 'unit_cost', m.unit_cost
         ) ORDER BY m.id) AS items
    FROM sales_docs d JOIN sales_moves m ON m.doc_id = d.id JOIN sales_products p ON p.id = m.product_id
    LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN sales_suppliers sp ON sp.id = d.supplier_id
    LEFT JOIN users u ON u.id = d.created_by`;
const DOCS_GROUP = 'GROUP BY d.id, sp.name, u.full_name';

salesStockRouter.get('/docs', async (req, res) => {
  const q = z
    .object({
      kind: z.enum(['purchase', 'shop', 'shop_return', 'adjust', 'all']).default('all'),
      supplier_id: idParam.optional(),
      from: date.optional(),
      to: date.optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    })
    .parse(req.query);
  const rows = (
    await pool.query(
      `${DOCS} WHERE ($1::text = 'all' OR d.kind = $1) AND ($2::int IS NULL OR d.supplier_id = $2)
          AND ($3::date IS NULL OR d.doc_date >= $3) AND ($4::date IS NULL OR d.doc_date <= $4)
        ${DOCS_GROUP} ORDER BY d.doc_date DESC, d.id DESC LIMIT $5`,
      [q.kind, q.supplier_id ?? null, q.from ?? null, q.to ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

salesStockRouter.post('/docs', requireAction('sales.stock'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      kind: z.enum(['purchase', 'shop', 'shop_return', 'adjust']),
      doc_date: date,
      supplier_id: idParam.nullish(),
      shop_id: optText(100),
      shop_name: optText(200),
      note: optText(500),
      rows: z
        .array(
          z.object({
            product_id: idParam,
            qty: z.coerce.number().int().min(-1e7).max(1e7),
            price: z.coerce.number().finite().min(0).max(1e12).nullish(),
          }),
        )
        .min(1)
        .max(2000),
    })
    .parse(req.body);
  if (new Set(b.rows.map((r) => r.product_id)).size !== b.rows.length) throw badRequest('Bitta tovar ikki marta yozilgan');
  for (const r of b.rows) {
    if (r.qty === 0 || (b.kind !== 'adjust' && r.qty < 0)) throw badRequest(b.kind === 'adjust' ? 'Inventarizatsiyada son 0 bo\'lmasin (+ ortiqcha, − kamomad)' : 'Soni musbat bo\'lishi kerak');
    if (b.kind === 'purchase' && r.price == null) throw badRequest('Prixodda har tovar narxini kiriting');
  }
  if (b.kind === 'purchase' && !b.supplier_id) throw badRequest('Postavshikni tanlang');
  if (b.kind !== 'purchase' && b.supplier_id) throw badRequest('Postavshik faqat prixodda tanlanadi');
  if ((b.kind === 'shop' || b.kind === 'shop_return') && !b.shop_id && !b.shop_name) throw badRequest('Do\'konni tanlang');
  if (b.kind === 'adjust' && !b.note) throw badRequest('Inventarizatsiya sababini yozing (izohda)');

  const doc = await tx(async (db) => {
    await db.query(LOCK);
    let shopName = b.shop_name;
    if (b.shop_id) {
      const s = (await db.query('SELECT name FROM billz_shops WHERE id = $1', [b.shop_id])).rows[0];
      if (!s) throw notFound('Do\'kon');
      shopName = s.name;
    }
    if (b.supplier_id) {
      const s = (await db.query('SELECT * FROM sales_suppliers WHERE id = $1', [b.supplier_id])).rows[0];
      if (!s) throw notFound('Postavshik');
      if (!s.is_active) throw badRequest(`«${s.name}» postavshigi yopilgan`);
    }
    const id = (
      await db.query(
        `INSERT INTO sales_docs (kind, doc_date, supplier_id, shop_id, shop_name, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [b.kind, b.doc_date, b.supplier_id ?? null, b.kind === 'shop' || b.kind === 'shop_return' ? b.shop_id : null, b.kind === 'shop' || b.kind === 'shop_return' ? shopName : null, b.note, ctx.userId],
      )
    ).rows[0].id as number;
    for (const r of b.rows) {
      const p = (await db.query(`${STOCK} WHERE p.id = $1 ${STOCK_GROUP}`, [r.product_id])).rows[0];
      if (!p) throw notFound('Tovar');
      const what = [p.partiya_no && `Partiya ${p.partiya_no}`, p.name, p.color_name, p.size_name, p.sort && `${p.sort} sort`].filter(Boolean).join(', ');
      if (b.kind === 'purchase' && p.source === 'own') throw badRequest(`${what}: o'zimiz ishlab chiqargan tovar postavshikdan kirmaydi — ishlab chiqarishdan o'tkazma orqali keladi`);
      const dir = b.kind === 'shop' || (b.kind === 'adjust' && r.qty < 0) ? -1 : 1;
      const qty = Math.abs(r.qty);
      if (dir === -1 && qty > p.qty) throw badRequest(`${what}: skladda ${p.qty} dona — ${qty} dona chiqarib bo'lmaydi`);
      const cost = b.kind === 'purchase' ? r.price! : Number(p.avg_cost ?? 0);
      await db.query(
        `INSERT INTO sales_moves (move_date, kind, product_id, dir, qty, unit_cost, doc_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [b.doc_date, b.kind, r.product_id, dir, qty, cost, id, ctx.userId],
      );
    }
    await audit(db, ctx, 'sales_doc', id, 'create', undefined, b);
    return (await db.query(`${DOCS} WHERE d.id = $1 ${DOCS_GROUP}`, [id])).rows[0];
  });
  res.status(201).json(doc);
});

salesStockRouter.delete('/docs/:id', requireAction('sales.stock'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    await db.query(LOCK);
    const d = (await db.query(`${DOCS} WHERE d.id = $1 ${DOCS_GROUP}`, [id])).rows[0];
    if (!d) throw notFound('Hujjat');
    // kirimni o'chirganda qoldiq manfiy bo'lmasin
    const short = (
      await db.query(
        `SELECT p.name, p.color_name, p.size_name, x.left_qty, x.doc_qty FROM (
           SELECT m.product_id,
                  (SELECT sum(a.dir * a.qty) FROM sales_moves a WHERE a.product_id = m.product_id)::int AS left_qty,
                  sum(m.dir * m.qty)::int AS doc_qty
             FROM sales_moves m WHERE m.doc_id = $1 GROUP BY m.product_id) x
         JOIN sales_products p ON p.id = x.product_id
        WHERE x.left_qty - x.doc_qty < 0 LIMIT 1`,
        [id],
      )
    ).rows[0];
    if (short) {
      throw conflict(`${[short.name, short.color_name, short.size_name].filter(Boolean).join(', ')}: skladda ${short.left_qty} dona qolgan — hujjatni o'chirsa qoldiq manfiy bo'ladi`);
    }
    await db.query('DELETE FROM sales_docs WHERE id = $1', [id]);
    await audit(db, ctx, 'sales_doc', id, 'delete', d, undefined);
  });
  res.status(204).end();
});

// ---------- Postavshiklar ----------
const BALANCES = `
  SELECT s.*,
         coalesce((SELECT sum(m.qty * m.unit_cost) FROM sales_moves m JOIN sales_docs d ON d.id = m.doc_id
                    WHERE d.kind = 'purchase' AND d.supplier_id = s.id), 0) AS purchased,
         coalesce((SELECT sum(p.amount_uzs) FROM sales_supplier_payments p WHERE p.supplier_id = s.id), 0) AS paid
    FROM sales_suppliers s`;

salesStockRouter.get('/suppliers', async (_req, res) => {
  const rows = (await pool.query(`SELECT x.*, x.purchased - x.paid AS debt FROM (${BALANCES}) x ORDER BY NOT x.is_active, lower(x.name)`)).rows;
  res.json(rows);
});

const supplierBody = z.object({ name: z.string().trim().min(1).max(200), phone: optText(50), note: optText(500), is_active: z.boolean().optional() });

salesStockRouter.post('/suppliers', requireAction('sales.stock'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = supplierBody.parse(req.body);
  const row = await tx(async (db) => {
    if ((await db.query('SELECT 1 FROM sales_suppliers WHERE lower(name) = lower($1)', [b.name])).rowCount) throw conflict(`«${b.name}» postavshigi bor`);
    const s = (await db.query('INSERT INTO sales_suppliers (name, phone, note) VALUES ($1, $2, $3) RETURNING *', [b.name, b.phone, b.note])).rows[0];
    await audit(db, ctx, 'sales_supplier', s.id, 'create', undefined, s);
    return s;
  });
  res.status(201).json(row);
});

salesStockRouter.put('/suppliers/:id', requireAction('sales.stock'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = supplierBody.parse(req.body);
  const row = await tx(async (db) => {
    const old = (await db.query('SELECT * FROM sales_suppliers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw notFound('Postavshik');
    if ((await db.query('SELECT 1 FROM sales_suppliers WHERE lower(name) = lower($1) AND id <> $2', [b.name, id])).rowCount) throw conflict(`«${b.name}» postavshigi bor`);
    const s = (
      await db.query('UPDATE sales_suppliers SET name = $2, phone = $3, note = $4, is_active = $5 WHERE id = $1 RETURNING *', [id, b.name, b.phone, b.note, b.is_active ?? old.is_active])
    ).rows[0];
    await audit(db, ctx, 'sales_supplier', id, 'update', old, s);
    return s;
  });
  res.json(row);
});

/** Postavshik bilan akt sverka: prixod — qarz, to'lov — kamaytiradi */
salesStockRouter.get('/suppliers/:id/ledger', async (req, res) => {
  const id = idParam.parse(req.params.id);
  const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
  if (q.from && q.to && q.to < q.from) throw badRequest('Sanagacha sanadan oldin bo\'lishi mumkin emas');
  const s = (await pool.query('SELECT * FROM sales_suppliers WHERE id = $1', [id])).rows[0];
  if (!s) throw notFound('Postavshik');
  const LINES = `
    SELECT d.doc_date AS date, 'purchase' AS kind, d.id AS ref_id, d.note, sum(m.qty * m.unit_cost) AS debit, 0::numeric AS credit, sum(m.qty)::int AS qty
      FROM sales_docs d JOIN sales_moves m ON m.doc_id = d.id WHERE d.kind = 'purchase' AND d.supplier_id = $1 GROUP BY d.id
    UNION ALL
    SELECT p.pay_date, 'payment', p.id, concat_ws(' · ', p.method, w.name, p.note), 0, p.amount_uzs, NULL
      FROM sales_supplier_payments p LEFT JOIN cash_wallets w ON w.id = p.wallet_id WHERE p.supplier_id = $1`;
  const opening = (
    await pool.query(`SELECT coalesce(sum(debit - credit), 0) AS bal FROM (${LINES}) l WHERE $2::date IS NOT NULL AND l.date < $2`, [id, q.from ?? null])
  ).rows[0].bal;
  const lines = (
    await pool.query(
      `SELECT * FROM (${LINES}) l WHERE ($2::date IS NULL OR l.date >= $2) AND ($3::date IS NULL OR l.date <= $3) ORDER BY l.date, l.kind DESC, l.ref_id`,
      [id, q.from ?? null, q.to ?? null],
    )
  ).rows;
  let bal = cents(opening);
  let debit = 0;
  let credit = 0;
  const rows = lines.map((l) => {
    debit += cents(l.debit);
    credit += cents(l.credit);
    bal += cents(l.debit) - cents(l.credit);
    return { ...l, balance: fromCents(bal) };
  });
  res.json({ supplier: s, opening: fromCents(cents(opening)), rows, totals: { debit: fromCents(debit), credit: fromCents(credit), closing: fromCents(bal) } });
});

salesStockRouter.post('/supplier-payments', requireAction('sales.pay'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      pay_date: date,
      supplier_id: idParam,
      amount_uzs: z.coerce.number().finite().positive().max(1e13),
      method: z.enum(['naqd', 'plastik', 'bank']),
      wallet_id: idParam.nullish(),
      note: optText(500),
    })
    .parse(req.body);
  const row = await tx(async (db) => {
    const s = (await db.query('SELECT * FROM sales_suppliers WHERE id = $1', [b.supplier_id])).rows[0];
    if (!s) throw notFound('Postavshik');
    const p = (
      await db.query(
        `INSERT INTO sales_supplier_payments (pay_date, supplier_id, amount_uzs, method, wallet_id, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [b.pay_date, b.supplier_id, b.amount_uzs, b.method, b.wallet_id ?? null, b.note, ctx.userId],
      )
    ).rows[0];
    if (b.wallet_id) {
      await postSupplierPayment(db, { id: p.id, pay_date: p.pay_date, wallet_id: b.wallet_id, amount: p.amount_uzs, method: b.method, note: b.note, supplier: s.name }, ctx.userId);
    }
    await audit(db, ctx, 'sales_supplier_payment', p.id, 'create', undefined, p);
    return p;
  });
  res.status(201).json(row);
});

salesStockRouter.delete('/supplier-payments/:id', requireAction('sales.pay'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const p = (await db.query('DELETE FROM sales_supplier_payments WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!p) throw notFound('To\'lov');
    await deleteCashBySource(db, 'sales_supplier_payment', id); // kassadagi chiqim ham o'chadi
    await audit(db, ctx, 'sales_supplier_payment', id, 'delete', p, undefined);
  });
  res.status(204).end();
});

salesStockRouter.get('/shops', async (_req, res) => {
  res.json((await pool.query('SELECT id, name FROM billz_shops ORDER BY name')).rows);
});

// ---------- Billz bilan solishtirish (barcode bo'yicha) ----------
/**
 * Har tovar: do'konlarga jo'natilgan (net) − Billz'da sotilgan (net) = kutilgan qoldiq; Billz'dagi haqiqiy qoldiq bilan farq.
 * Billz sotuvi faqat sozlamadagi «sotuv boshlanish sanasi»dan olinadi — undan oldingi sotuvlar hisobga kirmaydi.
 */
salesStockRouter.get('/billz', async (req, res) => {
  const q = z.object({ shop_id: z.string().trim().max(100).optional() }).parse(req.query);
  const shop = q.shop_id || null;
  const rows = (
    await pool.query(
      `WITH ours AS (
         SELECT p.id, p.source, o.partiya_no, p.name, p.artikul, p.color_name, p.size_name, p.sort, p.barcode,
                coalesce(sum(m.dir * m.qty), 0)::int AS qty,
                (coalesce(sum(m.qty) FILTER (WHERE m.kind = 'shop' AND ($1::text IS NULL OR d.shop_id = $1)), 0)
                 - coalesce(sum(m.qty) FILTER (WHERE m.kind = 'shop_return' AND ($1::text IS NULL OR d.shop_id = $1)), 0))::int AS to_shops
           FROM sales_products p LEFT JOIN sales_moves m ON m.product_id = p.id LEFT JOIN sales_docs d ON d.id = m.doc_id
           LEFT JOIN orders o ON o.id = p.order_id
          WHERE p.barcode IS NOT NULL GROUP BY p.id, o.partiya_no),
       bs AS (SELECT barcode, sum(qty) AS billz_qty FROM billz_stock WHERE barcode IS NOT NULL AND ($1::text IS NULL OR shop_id = $1) GROUP BY barcode),
       bl AS (SELECT barcode, sum(net_sold) AS billz_sold FROM billz_sales WHERE barcode IS NOT NULL AND ($1::text IS NULL OR shop_id = $1) GROUP BY barcode)
       SELECT ours.*, coalesce(bs.billz_qty, 0)::float8 AS billz_qty, coalesce(bl.billz_sold, 0)::float8 AS billz_sold
         FROM ours LEFT JOIN bs ON bs.barcode = ours.barcode LEFT JOIN bl ON bl.barcode = ours.barcode
        WHERE ours.to_shops <> 0 OR bs.billz_qty IS NOT NULL OR bl.billz_sold IS NOT NULL
        ORDER BY ours.source, ours.partiya_no NULLS LAST, lower(ours.name), ours.color_name, ours.size_name`,
      [shop],
    )
  ).rows.map((r) => {
    const expected = r.to_shops - r.billz_sold;
    return { ...r, expected, diff: Math.round((r.billz_qty - expected) * 1000) / 1000 };
  });
  const unmatched = (
    await pool.query(
      `SELECT s.barcode, max(s.product_name) AS product_name, max(s.sku) AS sku, sum(s.qty)::float8 AS billz_qty
         FROM billz_stock s WHERE s.barcode IS NOT NULL AND ($1::text IS NULL OR s.shop_id = $1)
          AND NOT EXISTS (SELECT 1 FROM sales_products p WHERE p.barcode = s.barcode)
        GROUP BY s.barcode HAVING sum(s.qty) <> 0 ORDER BY sum(s.qty) DESC LIMIT 200`,
      [shop],
    )
  ).rows;
  const meta = (
    await pool.query(
      `SELECT (SELECT sales_start FROM billz_settings WHERE id = 1) AS sales_start,
              (SELECT max(synced_at) FROM billz_stock) AS synced_at,
              (SELECT count(*)::int FROM sales_products p WHERE p.barcode IS NULL AND p.is_active
                  AND EXISTS (SELECT 1 FROM sales_moves m WHERE m.product_id = p.id)) AS no_barcode`,
    )
  ).rows[0];
  const shops = (await pool.query('SELECT id, name FROM billz_shops ORDER BY name')).rows;
  res.json({ rows, unmatched, shops, ...meta });
});
