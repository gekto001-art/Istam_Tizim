import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction, type RequestCtx } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { decimal, idParam, optText } from '../lib/util.js';

/**
 * Xomashyo skladi — Sheets "Xomashyo Sklad" varaqlari bo'yicha:
 *  Prixod (Ta'minot orqali): partiyaning yo'ldagi tovari qabul qilinadi (fakt miqdor), kargo/bojxona/boshqa xarajatlar
 *    qatorlarga Miqdor real ulushida taqsimlanadi (Sheets formulasi);
 *  Prixod: oddiy kirim yoki postavshikka vozvrat;
 *  Rasxod (Zayavka): partiya uchun kroy / tsexga peremesheniya yoki vozvrat; Rasxod: oddiy chiqim; Sotuv;
 *  Ostatka: qoldiq, o'rtacha tannarx = (prixod − vozvrat summasi) ÷ (prixod − vozvrat miqdori).
 * Chiqimda "Farq" (qoldiq − chiqim) manfiy bo'lmasligi kerak.
 */
export const stockRouter = Router();
stockRouter.use(requireAction('stock.read'));

const CURRENCY = z.enum(['UZS', 'USD', 'CNY', 'EUR', 'RUB']);
const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));
const PRIXOD_KINDS = ['prixod_taminot', 'prixod'];
const LOCK = 'SELECT pg_advisory_xact_lock(740106)'; // sklad yozuvlari ketma-ket

/** Xomashyo kaliti (Sheets "Umumiy nomi"): nomi + rangi + rang kodi + razmeri */
const itemSchema = {
  material_id: idParam,
  material_color_id: idParam.nullish().transform((v) => v ?? null),
  color_code: optText(50),
  material_size: optText(50),
};
export interface Item {
  material_id: number;
  material_color_id: number | null;
  color_code: string | null;
  material_size: string | null;
}
const keyOf = (i: Item) => [i.material_id, i.material_color_id ?? '', i.color_code ?? '', i.material_size ?? ''].join('|');
const SAME_ITEM = `x.material_id = $1 AND x.material_color_id IS NOT DISTINCT FROM $2 AND x.color_code IS NOT DISTINCT FROM $3
                   AND x.material_size IS NOT DISTINCT FROM $4`;
const itemArgs = (i: Item) => [i.material_id, i.material_color_id, i.color_code, i.material_size];
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Jamini og'irliklar ulushida bo'lish (2 xona, oxirgisi — qoldiq) */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!total || !sum) return weights.map(() => 0);
  let acc = 0;
  return weights.map((w, i) => {
    if (i === weights.length - 1) return r2(total - acc);
    const v = r2((total * w) / sum);
    acc += v;
    return v;
  });
}

async function rateOf(db: Db, currency: string, rate: number | null | undefined, on: string): Promise<number> {
  if (currency === 'UZS') return 1;
  if (rate) return rate;
  const r = (await db.query('SELECT rate_at($1, $2::date) AS r', [currency, on])).rows[0].r;
  if (r == null) throw badRequest(`${currency} uchun kurs kiritilmagan`);
  return Number(r);
}

/** Xomashyo qoldig'i va o'rtacha tannarxi (so'mda) */
export async function itemState(db: Db, i: Item) {
  const r = (
    await db.query(
      `SELECT coalesce(sum(x.dir * x.qty), 0) AS qty,
              sum(x.dir * x.cost_uzs) FILTER (WHERE d.kind = ANY($5::text[])) AS pcost,
              sum(x.dir * x.qty) FILTER (WHERE d.kind = ANY($5::text[])) AS pqty
         FROM stock_moves x JOIN stock_docs d ON d.id = x.doc_id WHERE ${SAME_ITEM}`,
      [...itemArgs(i), PRIXOD_KINDS],
    )
  ).rows[0];
  const pqty = Number(r.pqty ?? 0);
  return { qty: Number(r.qty), avg: pqty > 0 ? Number(r.pcost) / pqty : 0 };
}

async function itemName(db: Db, i: Item) {
  const r = (
    await db.query('SELECT m.name, m.unit, c.name AS color FROM materials m LEFT JOIN colors c ON c.id = $2 WHERE m.id = $1', [i.material_id, i.material_color_id])
  ).rows[0];
  if (!r) throw notFound('Xomashyo');
  return { label: [r.name, r.color, i.color_code, i.material_size].filter(Boolean).join(' '), unit: r.unit as string };
}

/** Chiqim tekshiruvi (Sheets "Farq"): har xomashyo bo'yicha qoldiq − chiqim ≥ 0 */
async function assertStock(db: Db, rows: (Item & { qty: number; dir: number })[]) {
  const net = new Map<string, { item: Item; delta: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    const e = net.get(k) ?? { item: r, delta: 0 };
    e.delta += r.dir * r.qty;
    net.set(k, e);
  }
  for (const { item, delta } of net.values()) {
    if (delta >= 0) continue;
    const st = await itemState(db, item);
    if (st.qty + delta < -1e-9) {
      const n = await itemName(db, item);
      throw badRequest(`${n.label}: omborda ${st.qty} ${n.unit}, chiqim ${-delta} ${n.unit} — Farq manfiy`);
    }
  }
}

interface MoveIn extends Item {
  dir: 1 | -1;
  qty: number;
  sent_qty?: number | null;
  price: number;
  currency: string;
  rate: number;
  amount_uzs: number;
  extra_uzs?: number;
  cost_uzs: number;
  destination?: string | null;
  producer_id?: number | null;
  order_id?: number | null;
  purchase_line_id?: number | null;
}

async function insertDoc(
  db: Db,
  ctx: RequestCtx,
  doc: { kind: string; op: string; doc_date: string; order_id?: number | null; supplier_id?: number | null; counterparty?: string | null; currency?: string | null; rate?: number | null; note?: string | null },
  moves: MoveIn[],
  expenses: { category: string; supplier_id: number; amount: number; currency: string; rate: number; amount_uzs: number }[] = [],
) {
  const goods = r2(moves.reduce((a, m) => a + m.amount_uzs, 0));
  const extra = r2(expenses.reduce((a, e) => a + e.amount_uzs, 0));
  const id = (
    await db.query(
      `INSERT INTO stock_docs (kind, op, doc_date, order_id, supplier_id, counterparty, currency, rate, note, goods_uzs, extra_uzs, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [doc.kind, doc.op, doc.doc_date, doc.order_id ?? null, doc.supplier_id ?? null, doc.counterparty ?? null, doc.currency ?? null, doc.rate ?? null, doc.note ?? null, goods, extra, ctx.userId],
    )
  ).rows[0].id as number;
  for (const m of moves) {
    await db.query(
      `INSERT INTO stock_moves (doc_id, material_id, material_color_id, color_code, material_size, dir, qty, sent_qty, price, currency, rate,
                                amount_uzs, extra_uzs, cost_uzs, destination, producer_id, order_id, purchase_line_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        id, m.material_id, m.material_color_id, m.color_code, m.material_size, m.dir, m.qty, m.sent_qty ?? null, m.price, m.currency, m.rate,
        m.amount_uzs, m.extra_uzs ?? 0, m.cost_uzs, m.destination ?? null, m.producer_id ?? null, m.order_id ?? null, m.purchase_line_id ?? null,
      ],
    );
  }
  for (const e of expenses) {
    await db.query('INSERT INTO stock_expenses (doc_id, category, supplier_id, amount, currency, rate, amount_uzs) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      id, e.category, e.supplier_id, e.amount, e.currency, e.rate, e.amount_uzs,
    ]);
  }
  await audit(db, ctx, 'stock_doc', id, doc.kind, undefined, { ...doc, moves: moves.length, goods_uzs: goods, extra_uzs: extra });
  return id;
}

const expensesSchema = z
  .array(z.object({ category: z.string().trim().min(1).max(60), supplier_id: idParam, amount: decimal.positive().max(1e13), currency: CURRENCY, rate: decimal.positive().max(1e9).nullish() }))
  .max(20)
  .default([]);

async function expensesOf(db: Db, list: z.infer<typeof expensesSchema>, on: string) {
  const out = [];
  for (const e of list) {
    if (!(await db.query('SELECT 1 FROM suppliers WHERE id = $1', [e.supplier_id])).rowCount) throw notFound('Kontragent');
    const rate = await rateOf(db, e.currency, e.rate, on);
    out.push({ ...e, rate, amount_uzs: r2(e.amount * rate) });
  }
  return out;
}

// ---------- Ostatka ----------
const BALANCE = `
  SELECT x.material_id, mt.name AS material_name, mt.code AS material_code, mt.unit, x.material_color_id, c.name AS material_color_name,
         x.color_code, x.material_size, round(sum(x.dir * x.qty), 3) AS qty,
         round(sum(x.dir * x.cost_uzs) FILTER (WHERE d.kind = ANY($1::text[]))
               / nullif(sum(x.dir * x.qty) FILTER (WHERE d.kind = ANY($1::text[])), 0), 4) AS avg_cost
    FROM stock_moves x JOIN stock_docs d ON d.id = x.doc_id
    JOIN materials mt ON mt.id = x.material_id LEFT JOIN colors c ON c.id = x.material_color_id`;

stockRouter.get('/balance', async (req, res) => {
  const q = z.object({ material_id: idParam.optional(), all: z.coerce.boolean().optional() }).parse(req.query);
  const rows = (
    await pool.query(
      `${BALANCE} WHERE ($2::int IS NULL OR x.material_id = $2)
        GROUP BY x.material_id, mt.name, mt.code, mt.unit, x.material_color_id, c.name, x.color_code, x.material_size
       HAVING $3 OR round(sum(x.dir * x.qty), 3) <> 0
        ORDER BY lower(mt.name), mt.code, c.name NULLS FIRST, x.color_code, x.material_size`,
      [PRIXOD_KINDS, q.material_id ?? null, q.all ?? false],
    )
  ).rows.map((r) => ({ ...r, value_uzs: r.avg_cost == null ? null : (Number(r.qty) * Number(r.avg_cost)).toFixed(2) }));
  res.json(rows);
});

// ---------- Prixod (Ta'minot orqali) ----------
/** Yo'ldagi tovar (Sheets "Ostatka Yo'ldagi Tovar"): yo'lga chiqqan − omborga qabul qilingan, buyurtma qatori bo'yicha */
const TRANSIT = `
  WITH t AS (
    SELECT l.id AS purchase_line_id, p.order_id,
           (SELECT coalesce(sum(s.qty), 0) FROM purchase_shipments s WHERE s.line_id = l.id) AS shipped,
           (SELECT coalesce(sum(m.dir * m.qty), 0) FROM stock_moves m WHERE m.purchase_line_id = l.id) AS received
      FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE l.status <> 'cancelled')`;

stockRouter.get('/transit', async (_req, res) => {
  const rows = (
    await pool.query(
      `${TRANSIT}
       SELECT o.id AS order_id, o.partiya_no, pt.name AS product_type_name, count(*) AS lines
         FROM t JOIN orders o ON o.id = t.order_id JOIN product_types pt ON pt.id = o.product_type_id
        WHERE round(t.shipped - t.received, 3) > 0
        GROUP BY o.id, o.partiya_no, pt.name ORDER BY o.id DESC`,
    )
  ).rows;
  res.json(rows);
});

async function transitLines(db: Db | typeof pool, orderId: number) {
  return (
    await db.query(
      `${TRANSIT}
       SELECT t.purchase_line_id, s.name AS supplier_name, l.material_id, mt.name AS material_name, mt.code AS material_code, mt.unit,
              l.material_color_id, c.name AS material_color_name, l.color_code, l.material_size,
              round(t.shipped - t.received, 3) AS transit_qty, coalesce(l.fact_price, l.price) AS price, l.currency, l.rate
         FROM t JOIN purchase_order_lines l ON l.id = t.purchase_line_id JOIN purchase_orders p ON p.id = l.po_id
         JOIN suppliers s ON s.id = p.supplier_id JOIN materials mt ON mt.id = l.material_id LEFT JOIN colors c ON c.id = l.material_color_id
        WHERE t.order_id = $1 AND round(t.shipped - t.received, 3) > 0
        ORDER BY p.stage DESC, mt.name, c.name NULLS FIRST, l.id`,
      [orderId],
    )
  ).rows;
}

stockRouter.get('/transit/:orderId', async (req, res) => {
  res.json(await transitLines(pool, idParam.parse(req.params.orderId)));
});

stockRouter.post('/prixod-taminot', requireAction('stock.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      order_id: idParam,
      doc_date: date,
      rows: z.array(z.object({ purchase_line_id: idParam, fact_qty: decimal.positive().max(1e9).nullish() })).min(1).max(1000),
      expenses: expensesSchema,
      note: optText(500),
    })
    .parse(req.body);
  const id = await tx(async (db) => {
    await db.query(LOCK);
    const lines = new Map((await transitLines(db, b.order_id)).map((l) => [l.purchase_line_id as number, l]));
    const seen = new Set<number>();
    const moves: MoveIn[] = b.rows.map((r) => {
      const l = lines.get(r.purchase_line_id);
      if (!l) throw badRequest('Qator bu partiyaning yo\'ldagi tovari emas');
      if (seen.has(r.purchase_line_id)) throw badRequest('Qator takrorlangan');
      seen.add(r.purchase_line_id);
      const sent = Number(l.transit_qty);
      const qty = r.fact_qty ?? sent; // Miqdor real: fakt kiritilmasa — yuborilgan
      const rate = Number(l.rate);
      const amount = r2(qty * Number(l.price) * rate);
      return {
        material_id: l.material_id, material_color_id: l.material_color_id, color_code: l.color_code, material_size: l.material_size,
        dir: 1, qty, sent_qty: sent, price: Number(l.price), currency: l.currency, rate, amount_uzs: amount, cost_uzs: amount,
        order_id: b.order_id, purchase_line_id: r.purchase_line_id,
      };
    });
    const expenses = await expensesOf(db, b.expenses, b.doc_date);
    const extra = allocate(r2(expenses.reduce((a, e) => a + e.amount_uzs, 0)), moves.map((m) => m.qty));
    moves.forEach((m, i) => {
      m.extra_uzs = extra[i];
      m.cost_uzs = r2(m.amount_uzs + extra[i]);
    });
    const supplier = (await db.query('SELECT p.supplier_id FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE l.id = $1', [b.rows[0].purchase_line_id])).rows[0].supplier_id;
    return insertDoc(db, ctx, { kind: 'prixod_taminot', op: 'prixod', doc_date: b.doc_date, order_id: b.order_id, supplier_id: supplier, note: b.note }, moves, expenses);
  });
  res.status(201).json({ id });
});

// ---------- Prixod (oddiy) ----------
stockRouter.post('/prixod', requireAction('stock.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      doc_date: date,
      op: z.enum(['prixod', 'vozvrat']),
      supplier_id: idParam,
      currency: CURRENCY,
      rate: decimal.positive().max(1e9).nullish(),
      rows: z.array(z.object({ ...itemSchema, qty: decimal.positive().max(1e9), price: decimal.min(0).max(1e12) })).min(1).max(1000),
      expenses: expensesSchema,
      note: optText(500),
    })
    .parse(req.body);
  if (b.op === 'vozvrat' && b.expenses.length) throw badRequest('Vozvratda qo\'shimcha xarajat bo\'lmaydi');
  const id = await tx(async (db) => {
    await db.query(LOCK);
    if (!(await db.query('SELECT 1 FROM suppliers WHERE id = $1', [b.supplier_id])).rowCount) throw notFound('Kontragent');
    const rate = await rateOf(db, b.currency, b.rate, b.doc_date);
    const dir = b.op === 'prixod' ? 1 : -1;
    const moves: MoveIn[] = b.rows.map((r) => {
      const amount = r2(r.qty * r.price * rate);
      return { ...r, dir, currency: b.currency, rate, amount_uzs: amount, cost_uzs: amount };
    });
    for (const m of moves) await itemName(db, m);
    if (dir < 0) await assertStock(db, moves);
    const expenses = await expensesOf(db, b.expenses, b.doc_date);
    const extra = allocate(r2(expenses.reduce((a, e) => a + e.amount_uzs, 0)), moves.map((m) => m.qty));
    moves.forEach((m, i) => {
      m.extra_uzs = extra[i];
      m.cost_uzs = r2(m.amount_uzs + extra[i]);
    });
    return insertDoc(db, ctx, { kind: 'prixod', op: b.op, doc_date: b.doc_date, supplier_id: b.supplier_id, currency: b.currency, rate, note: b.note }, moves, expenses);
  });
  res.status(201).json({ id });
});

// ---------- Rasxod (Zayavka) ----------
/** Partiya bo'yicha qoldiq: shu partiyaga kirgan − shu partiyaga berilgan */
const PARTIYA_LEFT = `
  SELECT x.order_id, x.material_id, x.material_color_id, x.color_code, x.material_size,
         round(sum(x.qty * x.dir) FILTER (WHERE d.kind = ANY($1::text[])), 3) AS received,
         round(coalesce(-sum(x.qty * x.dir) FILTER (WHERE d.kind IN ('rasxod_zayavka', 'rasxod')), 0), 3) AS issued
    FROM stock_moves x JOIN stock_docs d ON d.id = x.doc_id
   WHERE x.order_id IS NOT NULL
   GROUP BY x.order_id, x.material_id, x.material_color_id, x.color_code, x.material_size`;

stockRouter.get('/zayavka', async (_req, res) => {
  const rows = (
    await pool.query(
      `WITH p AS (${PARTIYA_LEFT})
       SELECT o.id AS order_id, o.partiya_no, pt.name AS product_type_name, pr.name AS producer_name, count(*) AS items
         FROM p JOIN orders o ON o.id = p.order_id JOIN product_types pt ON pt.id = o.product_type_id LEFT JOIN producers pr ON pr.id = o.producer_id
        WHERE coalesce(p.received, 0) - p.issued > 0
        GROUP BY o.id, o.partiya_no, pt.name, pr.name ORDER BY o.id DESC`,
      [PRIXOD_KINDS],
    )
  ).rows;
  res.json(rows);
});

stockRouter.get('/zayavka/:orderId', async (req, res) => {
  const orderId = idParam.parse(req.params.orderId);
  const order = (
    await pool.query('SELECT o.id, o.partiya_no, o.producer_id, pr.name AS producer_name FROM orders o LEFT JOIN producers pr ON pr.id = o.producer_id WHERE o.id = $1', [orderId])
  ).rows[0];
  if (!order) throw notFound('Zakaz');
  const items = (
    await pool.query(
      `WITH p AS (${PARTIYA_LEFT}),
            b AS (SELECT x.material_id, x.material_color_id, x.color_code, x.material_size, sum(x.dir * x.qty) AS stock,
                         sum(x.dir * x.cost_uzs) FILTER (WHERE d.kind = ANY($1::text[])) / nullif(sum(x.dir * x.qty) FILTER (WHERE d.kind = ANY($1::text[])), 0) AS avg_cost
                    FROM stock_moves x JOIN stock_docs d ON d.id = x.doc_id
                   GROUP BY x.material_id, x.material_color_id, x.color_code, x.material_size)
       SELECT p.material_id, mt.name AS material_name, mt.code AS material_code, mt.unit, p.material_color_id, c.name AS material_color_name,
              p.color_code, p.material_size, coalesce(p.received, 0) AS received, p.issued, round(coalesce(p.received, 0) - p.issued, 3) AS left_qty,
              round(b.stock, 3) AS stock, round(b.avg_cost, 4) AS avg_cost
         FROM p JOIN materials mt ON mt.id = p.material_id LEFT JOIN colors c ON c.id = p.material_color_id
         JOIN b ON b.material_id = p.material_id AND b.material_color_id IS NOT DISTINCT FROM p.material_color_id
               AND b.color_code IS NOT DISTINCT FROM p.color_code AND b.material_size IS NOT DISTINCT FROM p.material_size
        WHERE p.order_id = $2
        ORDER BY lower(mt.name), mt.code, c.name NULLS FIRST, p.color_code, p.material_size`,
      [PRIXOD_KINDS, orderId],
    )
  ).rows;
  res.json({ order, items });
});

const DEST = z.enum(['kroy', 'producer', 'other']);

stockRouter.post('/rasxod', requireAction('stock.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      kind: z.enum(['rasxod_zayavka', 'rasxod']),
      doc_date: date,
      op: z.enum(['peremesheniya', 'vozvrat']),
      order_id: idParam.nullish(),
      rows: z
        .array(z.object({ ...itemSchema, qty: decimal.positive().max(1e9), destination: DEST.nullish(), producer_id: idParam.nullish() }))
        .min(1)
        .max(1000),
      note: optText(500),
    })
    .parse(req.body);
  if (b.kind === 'rasxod_zayavka' && !b.order_id) throw badRequest('Qaysi zakaz uchunligini tanlang');
  const id = await tx(async (db) => {
    await db.query(LOCK);
    if (b.order_id && !(await db.query('SELECT 1 FROM orders WHERE id = $1', [b.order_id])).rowCount) throw notFound('Zakaz');
    const dir = b.op === 'peremesheniya' ? -1 : 1;
    const moves: MoveIn[] = [];
    for (const r of b.rows) {
      const n = await itemName(db, r);
      if (!r.destination) throw badRequest(`${n.label}: qayergaligini tanlang`);
      if (r.destination === 'producer') {
        if (!r.producer_id) throw badRequest(`${n.label}: korxonani tanlang`);
        if (!(await db.query('SELECT 1 FROM producers WHERE id = $1', [r.producer_id])).rowCount) throw notFound('Korxona');
      }
      const { avg } = await itemState(db, r);
      const cost = r2(r.qty * avg);
      moves.push({
        ...r, dir, price: Math.round(avg * 10000) / 10000, currency: 'UZS', rate: 1, amount_uzs: cost, cost_uzs: cost,
        producer_id: r.destination === 'producer' ? r.producer_id : null, order_id: b.order_id ?? null,
      });
    }
    if (dir < 0) await assertStock(db, moves);
    return insertDoc(db, ctx, { kind: b.kind, op: b.op, doc_date: b.doc_date, order_id: b.order_id ?? null, note: b.note }, moves);
  });
  res.status(201).json({ id });
});

// ---------- Sotuv ----------
stockRouter.post('/sotuv', requireAction('stock.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      doc_date: date,
      op: z.enum(['sotuv', 'vozvrat']),
      counterparty: z.string().trim().min(1, 'Qayergaligini (mijozni) kiriting').max(200),
      rows: z.array(z.object({ ...itemSchema, qty: decimal.positive().max(1e9), price: decimal.min(0).max(1e12) })).min(1).max(1000),
      note: optText(500),
    })
    .parse(req.body);
  const id = await tx(async (db) => {
    await db.query(LOCK);
    const dir = b.op === 'sotuv' ? -1 : 1;
    const moves: MoveIn[] = [];
    for (const r of b.rows) {
      await itemName(db, r);
      const { avg } = await itemState(db, r);
      moves.push({ ...r, dir, currency: 'UZS', rate: 1, amount_uzs: r2(r.qty * r.price), cost_uzs: r2(r.qty * avg) });
    }
    if (dir < 0) await assertStock(db, moves);
    return insertDoc(db, ctx, { kind: 'sotuv', op: b.op, doc_date: b.doc_date, counterparty: b.counterparty, note: b.note }, moves);
  });
  res.status(201).json({ id });
});

// ---------- Baza (jurnal) ----------
const MOVES = `
  SELECT x.id, x.doc_id, d.kind, d.op, d.doc_date, d.created_at, u.full_name AS created_by_name,
         x.material_id, mt.name AS material_name, mt.code AS material_code, mt.unit, mc.name AS material_color_name, x.color_code, x.material_size,
         x.dir, x.qty, x.sent_qty, x.price, x.currency, x.rate, x.amount_uzs, x.extra_uzs, x.cost_uzs,
         x.destination, pr.name AS producer_name, o.partiya_no, x.order_id, coalesce(s.name, d.counterparty) AS counterparty
    FROM stock_moves x JOIN stock_docs d ON d.id = x.doc_id JOIN materials mt ON mt.id = x.material_id
    LEFT JOIN colors mc ON mc.id = x.material_color_id LEFT JOIN producers pr ON pr.id = x.producer_id
    LEFT JOIN orders o ON o.id = x.order_id LEFT JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN users u ON u.id = d.created_by`;

stockRouter.get('/moves', async (req, res) => {
  const q = z
    .object({
      kind: z.string().max(100).optional(), // vergul bilan
      order_id: idParam.optional(),
      material_id: idParam.optional(),
      limit: z.coerce.number().int().min(1).max(5000).default(500),
    })
    .parse(req.query);
  const kinds = q.kind ? q.kind.split(',').map((k) => k.trim()).filter(Boolean) : null;
  const rows = (
    await pool.query(
      `${MOVES} WHERE ($1::text[] IS NULL OR d.kind = ANY($1)) AND ($2::int IS NULL OR x.order_id = $2) AND ($3::int IS NULL OR x.material_id = $3)
        ORDER BY d.doc_date DESC, x.doc_id DESC, x.id LIMIT $4`,
      [kinds, q.order_id ?? null, q.material_id ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

stockRouter.get('/expenses', async (req, res) => {
  const q = z.object({ kind: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(5000).default(500) }).parse(req.query);
  const kinds = q.kind ? q.kind.split(',').map((k) => k.trim()).filter(Boolean) : null;
  const rows = (
    await pool.query(
      `SELECT e.id, e.doc_id, d.kind, d.doc_date, d.created_at, e.category, s.name AS supplier_name, e.amount, e.currency, e.rate, e.amount_uzs, o.partiya_no
         FROM stock_expenses e JOIN stock_docs d ON d.id = e.doc_id JOIN suppliers s ON s.id = e.supplier_id LEFT JOIN orders o ON o.id = d.order_id
        WHERE ($1::text[] IS NULL OR d.kind = ANY($1)) ORDER BY d.doc_date DESC, e.doc_id DESC, e.id LIMIT $2`,
      [kinds, q.limit],
    )
  ).rows;
  res.json(rows);
});

/** Hujjatni o'chirish: kirim o'chsa qoldiq manfiy bo'lmasligi kerak */
stockRouter.delete('/docs/:id', requireAction('stock.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    await db.query(LOCK);
    const doc = (await db.query('SELECT * FROM stock_docs WHERE id = $1', [id])).rows[0];
    if (!doc) throw notFound('Hujjat');
    const moves = (await db.query('SELECT * FROM stock_moves WHERE doc_id = $1', [id])).rows;
    // o'chirish = teskari harakat
    await assertStock(db, moves.map((m) => ({ ...m, qty: Number(m.qty), dir: -m.dir })));
    await db.query('DELETE FROM stock_docs WHERE id = $1', [id]);
    await audit(db, ctx, 'stock_doc', id, 'delete', { ...doc, moves: moves.length }, undefined);
  });
  res.status(204).end();
});

// ---------- Nakladnoy ----------
stockRouter.get('/nakladnoy', async (_req, res) => {
  const rows = (
    await pool.query(
      `SELECT DISTINCT o.id AS order_id, o.partiya_no FROM stock_moves x JOIN stock_docs d ON d.id = x.doc_id JOIN orders o ON o.id = x.order_id
        WHERE d.kind IN ('rasxod_zayavka', 'rasxod') ORDER BY o.id DESC`,
    )
  ).rows;
  res.json(rows);
});

stockRouter.get('/nakladnoy/:orderId', async (req, res) => {
  const orderId = idParam.parse(req.params.orderId);
  const order = (
    await pool.query(
      `SELECT o.id, o.partiya_no, o.artikul, o.model, pt.name AS product_type_name, pr.name AS producer_name
         FROM orders o JOIN product_types pt ON pt.id = o.product_type_id LEFT JOIN producers pr ON pr.id = o.producer_id WHERE o.id = $1`,
      [orderId],
    )
  ).rows[0];
  if (!order) throw notFound('Zakaz');
  const rows = (await pool.query(`${MOVES} WHERE d.kind IN ('rasxod_zayavka', 'rasxod') AND x.order_id = $1 ORDER BY d.doc_date, x.doc_id, x.id`, [orderId])).rows;
  res.json({ order, rows });
});
