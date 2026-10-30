import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { idParam, optText } from '../lib/util.js';

/**
 * Kassa — Sheets "Kassa ISTAM Moliya bo'limi" (Kassa kiritish, Kassa Baza, Kassa hisobot, Avans-Hisobot) o'rniga.
 *  - har yozuv bitta hamyon va valyutada: kirim yoki chiqim, kurs (so'mga), tranzaksiya turi, markaz, xarajat elementi;
 *  - ichki transfer / avans-hisobot: chiqim + boshqa hamyonga kirim (juftlik); valyuta ayriboshlash: bir valyutada chiqim, boshqasida kirim;
 *  - avans-hisobot: avans hamyoniga ma'sul shaxs nomiga o'tkaziladi, u shu hamyondan xarajat qiladi — qoldiq shaxs bo'yicha.
 */
export const cashRouter = Router();
cashRouter.use(requireAction('cash.read'));

const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));
const CURRENCY = z.enum(['UZS', 'USD', 'CNY', 'EUR', 'RUB']);
const amount = z.coerce.number().finite().min(0).max(1e13);
const r2 = (v: number) => Math.round(v * 100) / 100;

// ---------- Ma'lumotnomalar ----------
cashRouter.get('/meta', async (_req, res) => {
  const [wallets, ops, centers, items, cps, resp, deps] = await Promise.all([
    pool.query('SELECT * FROM cash_wallets ORDER BY is_active DESC, sort, lower(name)'),
    pool.query('SELECT * FROM cash_op_types ORDER BY sort, id'),
    pool.query('SELECT * FROM cash_centers ORDER BY kind DESC, id'),
    pool.query('SELECT i.*, g.name AS group_name, (i.code / 1000) * 1000 AS group_code FROM cash_items i LEFT JOIN cash_item_groups g ON g.code = (i.code / 1000) * 1000 ORDER BY i.code'),
    pool.query(`SELECT counterparty AS v FROM cash_entries WHERE counterparty IS NOT NULL GROUP BY counterparty ORDER BY max(entry_date) DESC LIMIT 1000`),
    pool.query(`SELECT responsible AS v FROM cash_entries WHERE responsible IS NOT NULL GROUP BY responsible ORDER BY count(*) DESC LIMIT 200`),
    pool.query(`SELECT department AS v FROM cash_entries WHERE department IS NOT NULL GROUP BY department ORDER BY count(*) DESC LIMIT 100`),
  ]);
  res.json({
    wallets: wallets.rows,
    op_types: ops.rows,
    centers: centers.rows,
    items: items.rows,
    counterparties: cps.rows.map((r) => r.v),
    responsibles: resp.rows.map((r) => r.v),
    departments: [...new Set(['MB', 'TB', 'FTB', 'IB', 'ITMT', 'TTMT', ...deps.rows.map((r) => r.v)])],
  });
});

const walletBody = z.object({
  name: z.string().trim().min(1).max(100),
  business: z.enum(['moliya', 'tijorat', 'ishlab']).default('moliya'),
  kind: z.enum(['naqd', 'karta', 'bank', 'avans', 'boshqa']).default('naqd'),
  sort: z.coerce.number().int().min(0).max(10000).default(0),
  is_active: z.boolean().optional(),
});

cashRouter.post('/wallets', requireAction('cash.manage'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = walletBody.parse(req.body);
  const row = await tx(async (db) => {
    const w = (await db.query('INSERT INTO cash_wallets (name, business, kind, sort) VALUES ($1, $2, $3, $4) RETURNING *', [b.name, b.business, b.kind, b.sort])).rows[0];
    await audit(db, ctx, 'cash_wallet', w.id, 'create', undefined, w);
    return w;
  });
  res.status(201).json(row);
});

cashRouter.patch('/wallets/:id', requireAction('cash.manage'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = walletBody.partial().parse(req.body);
  const row = await tx(async (db) => {
    const old = (await db.query('SELECT * FROM cash_wallets WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw notFound('Hamyon');
    const w = (
      await db.query(
        `UPDATE cash_wallets SET name = coalesce($2, name), business = coalesce($3, business), kind = coalesce($4, kind), sort = coalesce($5, sort),
                is_active = coalesce($6, is_active) WHERE id = $1 RETURNING *`,
        [id, b.name ?? null, b.business ?? null, b.kind ?? null, b.sort ?? null, b.is_active ?? null],
      )
    ).rows[0];
    await audit(db, ctx, 'cash_wallet', id, 'update', old, w);
    return w;
  });
  res.json(row);
});

cashRouter.post('/items', requireAction('cash.manage'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z.object({ code: z.coerce.number().int().min(1000).max(99999), name: z.string().trim().min(1).max(200) }).parse(req.body);
  const row = await tx(async (db) => {
    const i = (await db.query('INSERT INTO cash_items (code, name) VALUES ($1, $2) RETURNING *', [b.code, b.name])).rows[0];
    await audit(db, ctx, 'cash_item', i.id, 'create', undefined, i);
    return i;
  });
  res.status(201).json(row);
});

cashRouter.patch('/items/:id', requireAction('cash.manage'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = z.object({ name: z.string().trim().min(1).max(200), is_active: z.boolean() }).partial().parse(req.body);
  const row = await tx(async (db) => {
    const old = (await db.query('SELECT * FROM cash_items WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw notFound('Xarajat elementi');
    const i = (await db.query('UPDATE cash_items SET name = coalesce($2, name), is_active = coalesce($3, is_active) WHERE id = $1 RETURNING *', [id, b.name ?? null, b.is_active ?? null])).rows[0];
    await audit(db, ctx, 'cash_item', id, 'update', old, i);
    return i;
  });
  res.json(row);
});

// ---------- Kassa yozuvlari ----------
const rowSchema = z.object({
  wallet_id: idParam,
  op_type_id: idParam,
  center_id: idParam.nullish(),
  item_id: idParam.nullish(),
  counterparty: optText(200),
  department: optText(50),
  responsible: optText(100),
  note: optText(500),
  currency: CURRENCY.default('UZS'),
  rate: z.coerce.number().positive().max(1e7).nullish(),
  amount_in: amount.default(0),
  amount_out: amount.default(0),
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .nullish(),
  order_id: idParam.nullish(),
  to_wallet_id: idParam.nullish(), // transfer / avans: qaysi hamyonga
  to_currency: CURRENCY.nullish(), // ayriboshlash: qaysi valyutaga
  to_amount: amount.nullish(),
  to_rate: z.coerce.number().positive().max(1e7).nullish(),
});
type Row = z.infer<typeof rowSchema>;

async function rateFor(db: Db, currency: string, day: string, given?: number | null) {
  if (currency === 'UZS') return 1;
  if (given) return given;
  const r = (await db.query('SELECT rate_at($1, $2) AS r', [currency, day])).rows[0].r;
  if (r == null) throw badRequest(`${currency} kursi kiritilmagan — kursni yozing yoki ma'lumotnomaga qo'shing`);
  return Number(r);
}

const INSERT = `INSERT INTO cash_entries (entry_date, wallet_id, op_type_id, center_id, item_id, counterparty, department, responsible, note, currency, rate,
                  amount_in, amount_out, period, order_id, pair_id, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`;

cashRouter.post('/entries', requireAction('cash.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z.object({ entry_date: date, rows: z.array(rowSchema).min(1).max(500) }).parse(req.body);
  const data = await tx(async (db) => {
    const wallets = new Map((await db.query('SELECT * FROM cash_wallets')).rows.map((w) => [w.id as number, w]));
    const ops = new Map((await db.query('SELECT * FROM cash_op_types')).rows.map((o) => [o.id as number, o]));
    const centers = new Map((await db.query('SELECT * FROM cash_centers')).rows.map((c) => [c.id as number, c]));
    const items = new Map((await db.query('SELECT * FROM cash_items')).rows.map((i) => [i.id as number, i]));
    let saved = 0;
    for (const [n, r] of b.rows.entries()) {
      const at = `${n + 1}-qator`;
      const w = wallets.get(r.wallet_id);
      const op = ops.get(r.op_type_id);
      if (!w) throw notFound('Hamyon');
      if (!op) throw notFound('Tranzaksiya turi');
      if (!w.is_active) throw badRequest(`${at}: «${w.name}» hamyoni yopilgan`);
      if (r.center_id && !centers.has(r.center_id)) throw notFound('Markaz');
      if (r.item_id && !items.has(r.item_id)) throw notFound('Xarajat elementi');
      const period = r.period ? `${r.period}-01` : null;
      const rate = await rateFor(db, r.currency, b.entry_date, r.rate);
      const base = [b.entry_date, r.wallet_id, r.op_type_id, r.center_id ?? null, r.item_id ?? null, r.counterparty, r.department];
      const tail = (pair: number | null) => [period, r.order_id ?? null, pair, ctx.userId];

      if (op.special === 'transfer' || op.special === 'exchange') {
        if (!(r.amount_out > 0)) throw badRequest(`${at}: chiqim summasini kiriting`);
        const toId = r.to_wallet_id ?? (op.special === 'exchange' ? r.wallet_id : null);
        if (!toId) throw badRequest(`${at}: qaysi hamyonga o'tkazilishini tanlang`);
        const to = wallets.get(toId);
        if (!to) throw notFound('Hamyon');
        if (!to.is_active) throw badRequest(`${at}: «${to.name}» hamyoni yopilgan`);
        let toCur = r.currency;
        let toAmount = r.amount_out;
        let toRate = rate;
        if (op.special === 'transfer') {
          if (toId === r.wallet_id) throw badRequest(`${at}: transfer boshqa hamyonga bo'ladi`);
        } else {
          if (!r.to_currency || r.to_currency === r.currency) throw badRequest(`${at}: ayriboshlashda boshqa valyutani tanlang`);
          if (!(r.to_amount && r.to_amount > 0)) throw badRequest(`${at}: olingan summani kiriting`);
          toCur = r.to_currency;
          toAmount = r.to_amount;
          toRate = await rateFor(db, toCur, b.entry_date, r.to_rate);
        }
        if ((w.kind === 'avans' || to.kind === 'avans') && !r.responsible) throw badRequest(`${at}: avans-hisobot — ma'sul shaxsni yozing`);
        const outId = (await db.query(INSERT, [...base, r.responsible, r.note, r.currency, rate, 0, r.amount_out, ...tail(null)])).rows[0].id as number;
        await db.query('UPDATE cash_entries SET pair_id = $1 WHERE id = $1', [outId]);
        await db.query(INSERT, [b.entry_date, toId, r.op_type_id, null, null, r.counterparty, r.department, r.responsible, r.note, toCur, toRate, toAmount, 0, ...tail(outId)]);
        saved += 2;
        continue;
      }

      const isIn = r.amount_in > 0;
      if (isIn === r.amount_out > 0) throw badRequest(`${at}: kirim yoki chiqimdan bittasini kiriting`);
      if (op.flow === 'in' && !isIn) throw badRequest(`${at}: «${op.name}» — faqat kirim`);
      if (op.flow === 'out' && isIn) throw badRequest(`${at}: «${op.name}» — faqat chiqim`);
      if (op.special === 'expense') {
        if (!r.item_id) throw badRequest(`${at}: xarajat elementini tanlang`);
        if (!r.center_id) throw badRequest(`${at}: markazni tanlang`);
      }
      if (w.kind === 'avans' && !r.responsible) throw badRequest(`${at}: avans-hisobot hamyoni — ma'sul shaxsni yozing`);
      await db.query(INSERT, [...base, r.responsible, r.note, r.currency, rate, r.amount_in, r.amount_out, ...tail(null)]);
      saved++;
    }
    await audit(db, ctx, 'cash_entries', null, 'create', undefined, b);
    return { saved };
  });
  res.status(201).json(data);
});

const ENTRIES = `
  SELECT e.id, e.entry_date, e.wallet_id, w.name AS wallet_name, w.kind AS wallet_kind, e.op_type_id, o.name AS op_name, o.special,
         e.center_id, c.name AS center_name, c.kind AS center_kind, e.item_id, i.code AS item_code, i.name AS item_name,
         e.counterparty, e.department, e.responsible, e.note, e.currency, e.rate, e.amount_in, e.amount_out,
         round((e.amount_in - e.amount_out) * e.rate, 2) AS net_uzs, to_char(e.period, 'YYYY-MM') AS period, e.order_id, od.partiya_no, e.pair_id,
         (SELECT pw.name || ' · ' || p.currency FROM cash_entries p JOIN cash_wallets pw ON pw.id = p.wallet_id WHERE p.pair_id = e.pair_id AND p.id <> e.id LIMIT 1) AS pair_wallet,
         e.created_at, u.full_name AS created_by_name
    FROM cash_entries e JOIN cash_wallets w ON w.id = e.wallet_id JOIN cash_op_types o ON o.id = e.op_type_id
    LEFT JOIN cash_centers c ON c.id = e.center_id LEFT JOIN cash_items i ON i.id = e.item_id LEFT JOIN orders od ON od.id = e.order_id
    LEFT JOIN users u ON u.id = e.created_by`;

cashRouter.get('/entries', async (req, res) => {
  const q = z
    .object({
      from: date.optional(),
      to: date.optional(),
      wallet_id: idParam.optional(),
      op_type_id: idParam.optional(),
      item_id: idParam.optional(),
      currency: CURRENCY.optional(),
      q: z.string().trim().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(10000).default(2000),
    })
    .parse(req.query);
  const like = q.q ? `%${q.q.toLowerCase()}%` : null;
  const rows = (
    await pool.query(
      `${ENTRIES} WHERE ($1::date IS NULL OR e.entry_date >= $1) AND ($2::date IS NULL OR e.entry_date <= $2)
          AND ($3::int IS NULL OR e.wallet_id = $3) AND ($4::int IS NULL OR e.op_type_id = $4) AND ($5::int IS NULL OR e.item_id = $5)
          AND ($6::text IS NULL OR e.currency = $6)
          AND ($7::text IS NULL OR lower(concat_ws(' ', e.counterparty, e.note, e.responsible, e.department)) LIKE $7)
        ORDER BY e.entry_date DESC, e.id DESC LIMIT $8`,
      [q.from ?? null, q.to ?? null, q.wallet_id ?? null, q.op_type_id ?? null, q.item_id ?? null, q.currency ?? null, like, q.limit],
    )
  ).rows;
  res.json(rows);
});

cashRouter.delete('/entries/:id', requireAction('cash.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const n = await tx(async (db) => {
    const e = (await db.query('SELECT * FROM cash_entries WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!e) throw notFound('Kassa yozuvi');
    const rows = (await db.query('DELETE FROM cash_entries WHERE id = $1 OR (pair_id IS NOT NULL AND pair_id = $2) RETURNING *', [id, e.pair_id])).rows;
    await audit(db, ctx, 'cash_entry', id, 'delete', rows, undefined);
    return rows.length;
  });
  res.json({ deleted: n });
});

// ---------- Qoldiqlar va hisobot ----------
cashRouter.get('/balances', async (req, res) => {
  const q = z.object({ on: date.optional() }).parse(req.query);
  const rows = (
    await pool.query(
      `SELECT w.id AS wallet_id, w.name AS wallet_name, w.kind, w.business, e.currency, sum(e.amount_in - e.amount_out) AS balance,
              round(sum((e.amount_in - e.amount_out) * e.rate), 2) AS balance_uzs_hist
         FROM cash_entries e JOIN cash_wallets w ON w.id = e.wallet_id
        WHERE ($1::date IS NULL OR e.entry_date <= $1)
        GROUP BY w.id, e.currency HAVING sum(e.amount_in - e.amount_out) <> 0
        ORDER BY w.sort, lower(w.name), e.currency`,
      [q.on ?? null],
    )
  ).rows;
  res.json(rows);
});

/** Kassa hisobot: hamyon × valyuta (boshi, sotuvdan kirim, boshqa kirim, chiqim, oxiri), tranzaksiya turi va xarajat elementlari bo'yicha */
cashRouter.get('/report', async (req, res) => {
  const q = z.object({ from: date, to: date }).parse(req.query);
  if (q.to < q.from) throw badRequest('Sanagacha sanadan oldin bo\'lishi mumkin emas');
  const [wallets, byOp, byItem] = await Promise.all([
    pool.query(
      `SELECT w.id AS wallet_id, w.name AS wallet_name, w.kind, w.business, e.currency,
              coalesce(sum(e.amount_in - e.amount_out) FILTER (WHERE e.entry_date < $1), 0) AS opening,
              coalesce(sum(e.amount_in) FILTER (WHERE e.entry_date >= $1 AND o.name = 'Sotuvdan tushum'), 0) AS sales_in,
              coalesce(sum(e.amount_in) FILTER (WHERE e.entry_date >= $1 AND o.name <> 'Sotuvdan tushum'), 0) AS other_in,
              coalesce(sum(e.amount_out) FILTER (WHERE e.entry_date >= $1), 0) AS out,
              sum(e.amount_in - e.amount_out) AS closing
         FROM cash_entries e JOIN cash_wallets w ON w.id = e.wallet_id JOIN cash_op_types o ON o.id = e.op_type_id
        WHERE e.entry_date <= $2
        GROUP BY w.id, e.currency
       HAVING sum(e.amount_in - e.amount_out) <> 0 OR count(*) FILTER (WHERE e.entry_date >= $1) > 0
        ORDER BY w.sort, lower(w.name), e.currency`,
      [q.from, q.to],
    ),
    pool.query(
      `SELECT o.id AS op_type_id, o.name AS op_name, o.special, e.currency, sum(e.amount_in) AS amount_in, sum(e.amount_out) AS amount_out,
              sum(e.amount_in - e.amount_out) AS net, round(sum((e.amount_in - e.amount_out) * e.rate), 2) AS net_uzs
         FROM cash_entries e JOIN cash_op_types o ON o.id = e.op_type_id
        WHERE e.entry_date BETWEEN $1 AND $2 GROUP BY o.id, e.currency ORDER BY o.sort, e.currency`,
      [q.from, q.to],
    ),
    pool.query(
      `SELECT i.id AS item_id, i.code, i.name, (i.code / 1000) * 1000 AS group_code, g.name AS group_name, c.kind AS center_kind, c.name AS center_name,
              round(sum((e.amount_out - e.amount_in) * e.rate), 2) AS amount_uzs
         FROM cash_entries e JOIN cash_items i ON i.id = e.item_id LEFT JOIN cash_item_groups g ON g.code = (i.code / 1000) * 1000
         LEFT JOIN cash_centers c ON c.id = e.center_id
        WHERE e.entry_date BETWEEN $1 AND $2 GROUP BY i.id, g.name, c.kind, c.name ORDER BY i.code, c.name`,
      [q.from, q.to],
    ),
  ]);
  res.json({ wallets: wallets.rows, by_op: byOp.rows, by_item: byItem.rows });
});

/** Avans-hisobot: ma'sul shaxs bo'yicha — davr boshi, topshirilgan (avans hamyoniga kirim), hisobot bergan (chiqim), davr oxiri */
cashRouter.get('/avans', async (req, res) => {
  const q = z.object({ from: date, to: date }).parse(req.query);
  const rows = (
    await pool.query(
      `SELECT max(e.responsible) AS responsible, e.currency,
              coalesce(sum(e.amount_in - e.amount_out) FILTER (WHERE e.entry_date < $1), 0) AS opening,
              coalesce(sum(e.amount_in) FILTER (WHERE e.entry_date >= $1), 0) AS given,
              coalesce(sum(e.amount_out) FILTER (WHERE e.entry_date >= $1), 0) AS reported,
              sum(e.amount_in - e.amount_out) AS closing
         FROM cash_entries e JOIN cash_wallets w ON w.id = e.wallet_id
        WHERE w.kind = 'avans' AND e.entry_date <= $2
        GROUP BY lower(trim(e.responsible)), e.currency
       HAVING sum(e.amount_in - e.amount_out) <> 0 OR count(*) FILTER (WHERE e.entry_date >= $1) > 0
        ORDER BY lower(max(e.responsible)), e.currency`,
      [q.from, q.to],
    )
  ).rows;
  res.json(rows.map((r) => ({ ...r, closing: r2(Number(r.closing)).toFixed(2) })));
});
