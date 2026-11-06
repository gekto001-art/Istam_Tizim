import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, optText } from '../lib/util.js';
import { deleteCashBySource, postClientPayment } from '../services/cash.js';
import { LOCK, STOCK, STOCK_GROUP } from './salesStock.js';

/**
 * Agentlar va ulgurji savdo (4.3) — /api/sales/ulgurji/...:
 *  - agentlar (komissiya foizi) va mijozlar (agentga biriktirilgan, nasiya chegarasi);
 *  - nakladnoy: sotuv — Sotuv skladidan chiqim, vozvrat — skladga qaytadi (mijoz olganidan ko'p emas);
 *  - nasiya: mijoz qarzi = sotuv − vozvrat − to'lov; muddati o'tgani (eski nakladnoylardan boshlab yopiladi);
 *  - mijoz to'lovi hamyon tanlansa kassaga «Sotuvdan tushum» kirimi;
 *  - hisobot: agent va mijoz bo'yicha sotuv, vozvrat, tannarx, foyda, yig'ilgan pul, komissiya.
 */
export const wholesaleRouter = Router();

const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));
const cents = (v: string | number | null) => Math.round(Number(v ?? 0) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);
const nameUnique = async (db: Db, table: 'sales_agents' | 'sales_clients', name: string, selfId: number | null, what: string) => {
  if ((await db.query(`SELECT 1 FROM ${table} WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2`, [name, selfId])).rowCount) throw conflict(`«${name}» ${what} bor`);
};

// ---------- Agentlar ----------
const agentBody = z.object({
  name: z.string().trim().min(1).max(200),
  phone: optText(50),
  commission_pct: z.coerce.number().finite().min(0).max(100).default(0),
  note: optText(500),
  is_active: z.boolean().optional(),
});

wholesaleRouter.get('/agents', async (_req, res) => {
  const rows = (
    await pool.query(
      `SELECT a.*, (SELECT count(*)::int FROM sales_clients c WHERE c.agent_id = a.id AND c.is_active) AS clients
         FROM sales_agents a ORDER BY NOT a.is_active, lower(a.name)`,
    )
  ).rows;
  res.json(rows);
});

wholesaleRouter.post('/agents', requireAction('sales.wholesale'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = agentBody.parse(req.body);
  const row = await tx(async (db) => {
    await nameUnique(db, 'sales_agents', b.name, null, 'agenti');
    const a = (await db.query('INSERT INTO sales_agents (name, phone, commission_pct, note) VALUES ($1, $2, $3, $4) RETURNING *', [b.name, b.phone, b.commission_pct, b.note])).rows[0];
    await audit(db, ctx, 'sales_agent', a.id, 'create', undefined, a);
    return a;
  });
  res.status(201).json(row);
});

wholesaleRouter.put('/agents/:id', requireAction('sales.wholesale'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = agentBody.parse(req.body);
  const row = await tx(async (db) => {
    const old = (await db.query('SELECT * FROM sales_agents WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw notFound('Agent');
    await nameUnique(db, 'sales_agents', b.name, id, 'agenti');
    const a = (
      await db.query('UPDATE sales_agents SET name = $2, phone = $3, commission_pct = $4, note = $5, is_active = $6 WHERE id = $1 RETURNING *', [
        id, b.name, b.phone, b.commission_pct, b.note, b.is_active ?? old.is_active,
      ])
    ).rows[0];
    await audit(db, ctx, 'sales_agent', id, 'update', old, a);
    return a;
  });
  res.json(row);
});

// ---------- Mijozlar va nasiya ----------
/** Mijoz qoldig'i: sotuv, vozvrat, to'lov; muddati o'tgan qarz — to'lov va vozvrat eng eski nakladnoylarni yopadi deb hisoblanadi */
const CLIENTS = `
  SELECT x.*, x.sold - x.returned - x.paid AS debt,
         greatest(x.due_sold - x.returned - x.paid, 0) AS overdue
    FROM (
      SELECT c.*, a.name AS agent_name,
             coalesce((SELECT sum(m.qty * m.price) FROM sales_moves m JOIN sales_invoices i ON i.id = m.invoice_id WHERE i.client_id = c.id AND i.kind = 'sale'), 0) AS sold,
             coalesce((SELECT sum(m.qty * m.price) FROM sales_moves m JOIN sales_invoices i ON i.id = m.invoice_id WHERE i.client_id = c.id AND i.kind = 'return'), 0) AS returned,
             coalesce((SELECT sum(p.amount_uzs) FROM sales_client_payments p WHERE p.client_id = c.id), 0) AS paid,
             coalesce((SELECT sum(m.qty * m.price) FROM sales_moves m JOIN sales_invoices i ON i.id = m.invoice_id
                        WHERE i.client_id = c.id AND i.kind = 'sale' AND coalesce(i.due_date, i.doc_date) < current_date), 0) AS due_sold,
             (SELECT max(i.doc_date) FROM sales_invoices i WHERE i.client_id = c.id AND i.kind = 'sale') AS last_sale,
             (SELECT max(p.pay_date) FROM sales_client_payments p WHERE p.client_id = c.id) AS last_payment
        FROM sales_clients c LEFT JOIN sales_agents a ON a.id = c.agent_id) x`;

wholesaleRouter.get('/clients', async (req, res) => {
  const q = z.object({ agent_id: idParam.optional(), q: z.string().trim().max(100).optional() }).parse(req.query);
  const rows = (
    await pool.query(
      `${CLIENTS} WHERE ($1::int IS NULL OR x.agent_id = $1) AND ($2::text IS NULL OR lower(concat_ws(' ', x.name, x.phone, x.address)) LIKE $2)
        ORDER BY NOT x.is_active, lower(x.name)`,
      [q.agent_id ?? null, q.q ? `%${q.q.toLowerCase()}%` : null],
    )
  ).rows;
  res.json(rows);
});

const clientBody = z.object({
  name: z.string().trim().min(1).max(200),
  phone: optText(50),
  address: optText(300),
  agent_id: idParam.nullish(),
  credit_limit: z.coerce.number().finite().min(0).max(1e13).nullish(),
  note: optText(500),
  is_active: z.boolean().optional(),
});

wholesaleRouter.post('/clients', requireAction('sales.wholesale'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = clientBody.parse(req.body);
  const row = await tx(async (db) => {
    await nameUnique(db, 'sales_clients', b.name, null, 'mijozi');
    const c = (
      await db.query('INSERT INTO sales_clients (name, phone, address, agent_id, credit_limit, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [
        b.name, b.phone, b.address, b.agent_id ?? null, b.credit_limit ?? null, b.note,
      ])
    ).rows[0];
    await audit(db, ctx, 'sales_client', c.id, 'create', undefined, c);
    return c;
  });
  res.status(201).json(row);
});

wholesaleRouter.put('/clients/:id', requireAction('sales.wholesale'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = clientBody.parse(req.body);
  const row = await tx(async (db) => {
    const old = (await db.query('SELECT * FROM sales_clients WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw notFound('Mijoz');
    await nameUnique(db, 'sales_clients', b.name, id, 'mijozi');
    const c = (
      await db.query(
        'UPDATE sales_clients SET name = $2, phone = $3, address = $4, agent_id = $5, credit_limit = $6, note = $7, is_active = $8 WHERE id = $1 RETURNING *',
        [id, b.name, b.phone, b.address, b.agent_id ?? null, b.credit_limit ?? null, b.note, b.is_active ?? old.is_active],
      )
    ).rows[0];
    await audit(db, ctx, 'sales_client', id, 'update', old, c);
    return c;
  });
  res.json(row);
});

/** Mijoz bilan akt sverka: sotuv — qarz, vozvrat va to'lov — kamaytiradi */
wholesaleRouter.get('/clients/:id/ledger', async (req, res) => {
  const id = idParam.parse(req.params.id);
  const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
  if (q.from && q.to && q.to < q.from) throw badRequest('Sanagacha sanadan oldin bo\'lishi mumkin emas');
  const client = (await pool.query(`${CLIENTS} WHERE x.id = $1`, [id])).rows[0];
  if (!client) throw notFound('Mijoz');
  const LINES = `
    SELECT i.doc_date AS date, i.kind, i.id AS ref_id, concat_ws(' · ', a.name, i.note) AS note, i.due_date,
           CASE WHEN i.kind = 'sale' THEN sum(m.qty * m.price) ELSE 0 END AS debit,
           CASE WHEN i.kind = 'return' THEN sum(m.qty * m.price) ELSE 0 END AS credit, sum(m.qty)::int AS qty
      FROM sales_invoices i JOIN sales_moves m ON m.invoice_id = i.id LEFT JOIN sales_agents a ON a.id = i.agent_id
     WHERE i.client_id = $1 GROUP BY i.id, a.name
    UNION ALL
    SELECT p.pay_date, 'payment', p.id, concat_ws(' · ', p.method, a.name, w.name, p.note), NULL, 0, p.amount_uzs, NULL
      FROM sales_client_payments p LEFT JOIN sales_agents a ON a.id = p.agent_id LEFT JOIN cash_wallets w ON w.id = p.wallet_id
     WHERE p.client_id = $1`;
  const opening = (
    await pool.query(`SELECT coalesce(sum(debit - credit), 0) AS bal FROM (${LINES}) l WHERE $2::date IS NOT NULL AND l.date < $2`, [id, q.from ?? null])
  ).rows[0].bal;
  const lines = (
    await pool.query(
      `SELECT * FROM (${LINES}) l WHERE ($2::date IS NULL OR l.date >= $2) AND ($3::date IS NULL OR l.date <= $3)
        ORDER BY l.date, CASE l.kind WHEN 'sale' THEN 0 WHEN 'return' THEN 1 ELSE 2 END, l.ref_id`,
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
  res.json({ client, opening: fromCents(cents(opening)), rows, totals: { debit: fromCents(debit), credit: fromCents(credit), closing: fromCents(bal) } });
});

// ---------- Nakladnoy: sotuv va vozvrat ----------
const INVOICES = `
  SELECT i.id, i.kind, i.doc_date, i.due_date, i.client_id, c.name AS client_name, c.phone AS client_phone, c.address AS client_address,
         i.agent_id, a.name AS agent_name, i.note, i.created_at, u.full_name AS created_by_name,
         sum(m.qty)::int AS qty, sum(m.qty * m.price) AS amount_uzs, sum(m.qty * m.unit_cost) AS cost_uzs,
         json_agg(json_build_object(
           'product_id', p.id, 'source', p.source, 'partiya_no', o.partiya_no, 'name', p.name, 'artikul', p.artikul,
           'color_name', p.color_name, 'size_name', p.size_name, 'sort', p.sort, 'barcode', p.barcode,
           'qty', m.qty, 'price', m.price, 'unit_cost', m.unit_cost
         ) ORDER BY m.id) AS items
    FROM sales_invoices i JOIN sales_moves m ON m.invoice_id = i.id JOIN sales_products p ON p.id = m.product_id
    JOIN sales_clients c ON c.id = i.client_id LEFT JOIN sales_agents a ON a.id = i.agent_id
    LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = i.created_by`;
const INVOICES_GROUP = 'GROUP BY i.id, c.name, c.phone, c.address, a.name, u.full_name';

wholesaleRouter.get('/invoices', async (req, res) => {
  const q = z
    .object({
      kind: z.enum(['sale', 'return', 'all']).default('all'),
      client_id: idParam.optional(),
      agent_id: idParam.optional(),
      from: date.optional(),
      to: date.optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    })
    .parse(req.query);
  const rows = (
    await pool.query(
      `${INVOICES} WHERE ($1::text = 'all' OR i.kind = $1) AND ($2::int IS NULL OR i.client_id = $2) AND ($3::int IS NULL OR i.agent_id = $3)
          AND ($4::date IS NULL OR i.doc_date >= $4) AND ($5::date IS NULL OR i.doc_date <= $5)
        ${INVOICES_GROUP} ORDER BY i.doc_date DESC, i.id DESC LIMIT $6`,
      [q.kind, q.client_id ?? null, q.agent_id ?? null, q.from ?? null, q.to ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

wholesaleRouter.get('/invoices/:id', async (req, res) => {
  const id = idParam.parse(req.params.id);
  const inv = (await pool.query(`${INVOICES} WHERE i.id = $1 ${INVOICES_GROUP}`, [id])).rows[0];
  if (!inv) throw notFound('Nakladnoy');
  const debt = (await pool.query(`${CLIENTS} WHERE x.id = $1`, [inv.client_id])).rows[0].debt;
  res.json({ ...inv, client_debt: debt });
});

wholesaleRouter.post('/invoices', requireAction('sales.wholesale'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      kind: z.enum(['sale', 'return']),
      doc_date: date,
      client_id: idParam,
      agent_id: idParam.nullish(),
      due_date: date.nullish(),
      note: optText(500),
      rows: z
        .array(z.object({ product_id: idParam, qty: z.coerce.number().int().min(1).max(1e7), price: z.coerce.number().finite().min(0).max(1e12) }))
        .min(1)
        .max(1000),
    })
    .parse(req.body);
  if (new Set(b.rows.map((r) => r.product_id)).size !== b.rows.length) throw badRequest('Bitta tovar ikki marta yozilgan');
  if (b.due_date && b.due_date < b.doc_date) throw badRequest('To\'lov muddati nakladnoy sanasidan oldin bo\'lishi mumkin emas');
  if (b.kind === 'return' && b.due_date) throw badRequest('Vozvratda to\'lov muddati bo\'lmaydi');

  const inv = await tx(async (db) => {
    await db.query(LOCK);
    const c = (await db.query(`${CLIENTS} WHERE x.id = $1`, [b.client_id])).rows[0];
    if (!c) throw notFound('Mijoz');
    if (b.kind === 'sale' && !c.is_active) throw badRequest(`«${c.name}» mijozi yopilgan`);
    const agentId = b.agent_id ?? c.agent_id ?? null;
    if (agentId) {
      const a = (await db.query('SELECT * FROM sales_agents WHERE id = $1', [agentId])).rows[0];
      if (!a) throw notFound('Agent');
      if (!a.is_active && b.agent_id) throw badRequest(`«${a.name}» agenti yopilgan`);
    }
    if (b.kind === 'sale' && c.credit_limit != null) {
      const amount = b.rows.reduce((s, r) => s + Math.round(r.qty * r.price * 100), 0);
      const after = cents(c.debt) + amount;
      if (after > cents(c.credit_limit)) {
        throw badRequest(`«${c.name}»: nasiya chegarasi ${fromCents(cents(c.credit_limit))} so'm — hozirgi qarz ${fromCents(cents(c.debt))}, bu nakladnoy bilan ${fromCents(after)} bo'ladi`);
      }
    }
    const id = (
      await db.query(
        'INSERT INTO sales_invoices (kind, doc_date, client_id, agent_id, due_date, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [b.kind, b.doc_date, b.client_id, agentId, b.due_date ?? null, b.note, ctx.userId],
      )
    ).rows[0].id as number;
    for (const r of b.rows) {
      const p = (await db.query(`${STOCK} WHERE p.id = $1 ${STOCK_GROUP}`, [r.product_id])).rows[0];
      if (!p) throw notFound('Tovar');
      const what = [p.partiya_no && `Partiya ${p.partiya_no}`, p.name, p.color_name, p.size_name, p.sort && `${p.sort} sort`].filter(Boolean).join(', ');
      if (b.kind === 'sale' && r.qty > p.qty) throw badRequest(`${what}: skladda ${p.qty} dona — ${r.qty} dona sotib bo'lmaydi`);
      if (b.kind === 'return') {
        const bought = (
          await db.query(
            `SELECT coalesce(sum(CASE i.kind WHEN 'sale' THEN m.qty ELSE -m.qty END), 0)::int AS n
               FROM sales_moves m JOIN sales_invoices i ON i.id = m.invoice_id WHERE i.client_id = $1 AND m.product_id = $2 AND i.id <> $3`,
            [b.client_id, r.product_id, id],
          )
        ).rows[0].n as number;
        if (r.qty > bought) throw badRequest(`${what}: mijoz ${bought} dona olgan (vozvratlarni hisobga olib) — ${r.qty} dona qaytarib bo'lmaydi`);
      }
      await db.query(
        `INSERT INTO sales_moves (move_date, kind, product_id, dir, qty, unit_cost, price, invoice_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [b.doc_date, b.kind, r.product_id, b.kind === 'sale' ? -1 : 1, r.qty, Number(p.avg_cost ?? 0), r.price, id, ctx.userId],
      );
    }
    await audit(db, ctx, 'sales_invoice', id, 'create', undefined, b);
    return (await db.query(`${INVOICES} WHERE i.id = $1 ${INVOICES_GROUP}`, [id])).rows[0];
  });
  res.status(201).json(inv);
});

wholesaleRouter.delete('/invoices/:id', requireAction('sales.wholesale'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    await db.query(LOCK);
    const inv = (await db.query(`${INVOICES} WHERE i.id = $1 ${INVOICES_GROUP}`, [id])).rows[0];
    if (!inv) throw notFound('Nakladnoy');
    if (inv.kind === 'return') {
      // vozvrat o'chsa tovar skladdan chiqadi — qoldiq manfiy bo'lmasin
      const short = (
        await db.query(
          `SELECT p.name, (SELECT sum(a.dir * a.qty) FROM sales_moves a WHERE a.product_id = m.product_id)::int AS left_qty
             FROM sales_moves m JOIN sales_products p ON p.id = m.product_id
            WHERE m.invoice_id = $1 AND (SELECT sum(a.dir * a.qty) FROM sales_moves a WHERE a.product_id = m.product_id) < m.qty LIMIT 1`,
          [id],
        )
      ).rows[0];
      if (short) throw conflict(`${short.name}: skladda ${short.left_qty} dona qolgan — vozvratni o'chirib bo'lmaydi`);
    }
    await db.query('DELETE FROM sales_invoices WHERE id = $1', [id]);
    await audit(db, ctx, 'sales_invoice', id, 'delete', inv, undefined);
  });
  res.status(204).end();
});

// ---------- Mijoz to'lovlari ----------
wholesaleRouter.post('/client-payments', requireAction('sales.pay'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      pay_date: date,
      client_id: idParam,
      agent_id: idParam.nullish(),
      amount_uzs: z.coerce.number().finite().positive().max(1e13),
      method: z.enum(['naqd', 'plastik', 'bank']),
      wallet_id: idParam.nullish(),
      note: optText(500),
    })
    .parse(req.body);
  const row = await tx(async (db) => {
    const c = (await db.query('SELECT * FROM sales_clients WHERE id = $1', [b.client_id])).rows[0];
    if (!c) throw notFound('Mijoz');
    const agentId = b.agent_id ?? c.agent_id ?? null;
    const agent = agentId ? (await db.query('SELECT name FROM sales_agents WHERE id = $1', [agentId])).rows[0] : null;
    if (agentId && !agent) throw notFound('Agent');
    const p = (
      await db.query(
        `INSERT INTO sales_client_payments (pay_date, client_id, agent_id, amount_uzs, method, wallet_id, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [b.pay_date, b.client_id, agentId, b.amount_uzs, b.method, b.wallet_id ?? null, b.note, ctx.userId],
      )
    ).rows[0];
    if (b.wallet_id) {
      await postClientPayment(db, { id: p.id, pay_date: p.pay_date, wallet_id: b.wallet_id, amount: p.amount_uzs, note: b.note, client: c.name, agent: agent?.name ?? null }, ctx.userId);
    }
    await audit(db, ctx, 'sales_client_payment', p.id, 'create', undefined, p);
    return p;
  });
  res.status(201).json(row);
});

wholesaleRouter.delete('/client-payments/:id', requireAction('sales.pay'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const p = (await db.query('DELETE FROM sales_client_payments WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!p) throw notFound('To\'lov');
    await deleteCashBySource(db, 'sales_client_payment', id); // kassadagi kirim ham o'chadi
    await audit(db, ctx, 'sales_client_payment', id, 'delete', p, undefined);
  });
  res.status(204).end();
});

// ---------- Hisobot: agent va mijoz bo'yicha ----------
wholesaleRouter.get('/report', async (req, res) => {
  const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
  if (q.from && q.to && q.to < q.from) throw badRequest('Sanagacha sanadan oldin bo\'lishi mumkin emas');
  const args = [q.from ?? null, q.to ?? null];
  const SUMS = (key: 'agent_id' | 'client_id') => `
    SELECT i.${key} AS id,
           coalesce(sum(m.qty) FILTER (WHERE i.kind = 'sale'), 0)::int AS sold_qty,
           coalesce(sum(m.qty) FILTER (WHERE i.kind = 'return'), 0)::int AS returned_qty,
           coalesce(sum(m.qty * m.price) FILTER (WHERE i.kind = 'sale'), 0) AS sales,
           coalesce(sum(m.qty * m.price) FILTER (WHERE i.kind = 'return'), 0) AS returns,
           coalesce(sum(m.qty * m.unit_cost) FILTER (WHERE i.kind = 'sale'), 0) - coalesce(sum(m.qty * m.unit_cost) FILTER (WHERE i.kind = 'return'), 0) AS cost
      FROM sales_invoices i JOIN sales_moves m ON m.invoice_id = i.id
     WHERE ($1::date IS NULL OR i.doc_date >= $1) AND ($2::date IS NULL OR i.doc_date <= $2)
     GROUP BY i.${key}`;
  const PAID = (key: 'agent_id' | 'client_id') => `
    SELECT p.${key} AS id, sum(p.amount_uzs) AS paid FROM sales_client_payments p
     WHERE ($1::date IS NULL OR p.pay_date >= $1) AND ($2::date IS NULL OR p.pay_date <= $2) GROUP BY p.${key}`;
  const COLS = `coalesce(s.sold_qty, 0) AS sold_qty, coalesce(s.returned_qty, 0) AS returned_qty, coalesce(s.sales, 0) AS sales,
                coalesce(s.returns, 0) AS returns, coalesce(s.cost, 0) AS cost, coalesce(pd.paid, 0) AS paid`;
  type Num = string | number | null;
  const shape = <T extends { sales: Num; returns: Num; cost: Num; paid: Num }>(r: T) => {
    const net = cents(r.sales) - cents(r.returns);
    return { ...r, net_sales: fromCents(net), margin: fromCents(net - cents(r.cost)), paid: fromCents(cents(r.paid)) };
  };
  const agents = (
    await pool.query(
      `SELECT a.id, coalesce(a.name, 'Agentsiz') AS name, a.commission_pct, ${COLS}
         FROM (SELECT id FROM (${SUMS('agent_id')}) s UNION SELECT id FROM (${PAID('agent_id')}) pd) k
         LEFT JOIN (${SUMS('agent_id')}) s ON s.id IS NOT DISTINCT FROM k.id
         LEFT JOIN (${PAID('agent_id')}) pd ON pd.id IS NOT DISTINCT FROM k.id
         LEFT JOIN sales_agents a ON a.id = k.id
        ORDER BY a.name NULLS LAST`,
      args,
    )
  ).rows.map((r) => {
    const x = shape(r);
    return { ...x, commission: fromCents(Math.round(((cents(x.net_sales) * Number(r.commission_pct ?? 0)) / 100))) };
  });
  const clients = (
    await pool.query(
      `SELECT c.id, c.name, a.name AS agent_name, ${COLS}
         FROM (SELECT id FROM (${SUMS('client_id')}) s UNION SELECT id FROM (${PAID('client_id')}) pd) k
         JOIN sales_clients c ON c.id = k.id LEFT JOIN sales_agents a ON a.id = c.agent_id
         LEFT JOIN (${SUMS('client_id')}) s ON s.id = k.id
         LEFT JOIN (${PAID('client_id')}) pd ON pd.id = k.id
        ORDER BY coalesce(s.sales, 0) - coalesce(s.returns, 0) DESC, c.name`,
      args,
    )
  ).rows.map(shape);
  const total = { sales: 0, returns: 0, cost: 0, paid: 0, commission: 0 };
  for (const a of agents) {
    total.sales += cents(a.sales as string);
    total.returns += cents(a.returns as string);
    total.cost += cents(a.cost as string);
    total.paid += cents(a.paid);
    total.commission += cents(a.commission);
  }
  const net = total.sales - total.returns;
  res.json({
    agents,
    clients,
    totals: {
      sales: fromCents(total.sales),
      returns: fromCents(total.returns),
      net_sales: fromCents(net),
      cost: fromCents(total.cost),
      margin: fromCents(net - total.cost),
      paid: fromCents(total.paid),
      commission: fromCents(total.commission),
    },
  });
});
