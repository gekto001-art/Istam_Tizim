import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, optText } from '../lib/util.js';
import { itemState } from './stock.js';

/**
 * Tsex (ishlab chiqarish) — Sheets "Ishlab Chiqarish ko'ylak / Shim" bo'yicha (har tsex — korxona):
 *  1) Prixod_Kroy: kroydan kelgan yarim tayyor — Tasdiqlash (tsexga kiradi) yoki Rad etish (kroyga qaytadi);
 *  2) Ishlab chiqarish: rang × razmer bo'yicha tikilgan fakt ≤ tikilmagan soni (Ish/Chiq GP);
 *     furnitura sarfi = zakazdagi norma (asosiy matodan tashqari) × fakt (Ish/Chiq Xa);
 *  3) Ostatka: tasdiqlangan prixod − tikilgani.
 */
export const tsexRouter = Router();
tsexRouter.use(requireAction('tsex.read'));

const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));
const int = z.coerce.number().int();
const r2 = (v: number) => Math.round(v * 100) / 100;
const LOCK = 'SELECT pg_advisory_xact_lock(740108)';

// ---------- Prixod_Kroy ----------
const ISSUES = `
  SELECT x.id, x.issue_no, x.issue_date, x.created_at, x.order_id, o.partiya_no, pt.name AS product_type_name, o.artikul, o.model,
         x.producer_id, pr.name AS producer_name, x.color_id, c.name AS color_name, x.size_id, s.name AS size_name, x.qty, x.status,
         x.decided_date, ud.full_name AS decided_by_name, u.full_name AS created_by_name
    FROM kroy_issues x JOIN orders o ON o.id = x.order_id JOIN product_types pt ON pt.id = o.product_type_id
    JOIN producers pr ON pr.id = x.producer_id JOIN colors c ON c.id = x.color_id JOIN sizes s ON s.id = x.size_id
    LEFT JOIN users u ON u.id = x.created_by LEFT JOIN users ud ON ud.id = x.decided_by`;

tsexRouter.get('/issues', async (req, res) => {
  const q = z
    .object({
      producer_id: idParam.optional(),
      status: z.enum(['pending', 'decided', 'all']).default('all'),
      limit: z.coerce.number().int().min(1).max(5000).default(1000),
    })
    .parse(req.query);
  const cond = { pending: "x.status = 'pending'", decided: "x.status <> 'pending'", all: 'true' }[q.status];
  const rows = (
    await pool.query(
      `${ISSUES} WHERE ${cond} AND ($1::int IS NULL OR x.producer_id = $1)
        ORDER BY ${q.status === 'pending' ? 'x.issue_date, x.id' : 'coalesce(x.decided_at, x.created_at) DESC, x.id DESC'} LIMIT $2`,
      [q.producer_id ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

tsexRouter.post('/accept', requireAction('tsex.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      decided_date: date,
      rows: z.array(z.object({ issue_id: idParam, decision: z.enum(['accepted', 'rejected']) })).min(1).max(1000),
    })
    .parse(req.body);
  const result = await tx(async (db) => {
    const out = { accepted: 0, rejected: 0 };
    for (const r of b.rows) {
      const x = (await db.query('SELECT * FROM kroy_issues WHERE id = $1 FOR UPDATE', [r.issue_id])).rows[0];
      if (!x) throw notFound('Kroydan rasxod');
      if (x.status !== 'pending') throw conflict(`${x.issue_no}: munosabat allaqachon berilgan`);
      await db.query('UPDATE kroy_issues SET status = $2, decided_date = $3, decided_by = $4, decided_at = now() WHERE id = $1', [
        r.issue_id, r.decision, b.decided_date, ctx.userId,
      ]);
      out[r.decision]++;
    }
    await audit(db, ctx, 'tsex_accept', b.rows[0].issue_id, 'decide', undefined, b);
    return out;
  });
  res.json(result);
});

// ---------- Ostatka ----------
/** Tsexdagi yarim tayyor: tasdiqlangan prixod − tikilgani; kutilayotgan (javob berilmagan) alohida */
const BALANCE = `
  WITH t AS (
    SELECT x.order_id, x.producer_id, x.color_id, x.size_id,
           CASE WHEN x.status = 'accepted' THEN x.qty ELSE 0 END AS recv, CASE WHEN x.status = 'pending' THEN x.qty ELSE 0 END AS pend, 0 AS made
      FROM kroy_issues x WHERE x.status <> 'rejected'
    UNION ALL
    SELECT d.order_id, d.producer_id, o.color_id, o.size_id, 0, 0, o.fact_qty FROM tsex_outputs o JOIN tsex_docs d ON d.id = o.doc_id)
  SELECT t.order_id, o.partiya_no, pt.name AS product_type_name, t.producer_id, pr.name AS producer_name,
         t.color_id, c.name AS color_name, t.size_id, s.name AS size_name,
         sum(t.recv)::int AS received, sum(t.pend)::int AS pending, sum(t.made)::int AS produced, (sum(t.recv) - sum(t.made))::int AS left_qty
    FROM t JOIN orders o ON o.id = t.order_id JOIN product_types pt ON pt.id = o.product_type_id JOIN producers pr ON pr.id = t.producer_id
    JOIN colors c ON c.id = t.color_id JOIN sizes s ON s.id = t.size_id`;
const BALANCE_GROUP = 'GROUP BY t.order_id, o.partiya_no, pt.name, t.producer_id, pr.name, t.color_id, c.name, t.size_id, s.name, s.sort';

async function balance(db: Db | typeof pool, f: { producer_id?: number | null; order_id?: number | null; all?: boolean }) {
  return (
    await db.query(
      `${BALANCE} WHERE ($1::int IS NULL OR t.producer_id = $1) AND ($2::int IS NULL OR t.order_id = $2) ${BALANCE_GROUP}
       HAVING $3 OR sum(t.recv) - sum(t.made) <> 0 OR sum(t.pend) <> 0
        ORDER BY t.order_id DESC, pr.name, lower(c.name), s.sort`,
      [f.producer_id ?? null, f.order_id ?? null, f.all ?? false],
    )
  ).rows;
}

tsexRouter.get('/balance', async (req, res) => {
  const q = z.object({ producer_id: idParam.optional(), order_id: idParam.optional(), all: z.coerce.boolean().optional() }).parse(req.query);
  res.json(await balance(pool, q));
});

// ---------- Ishlab chiqarish ----------
/** Zakazdagi furnitura normasi (asosiy matodan tashqari) — rang bo'yicha, razmer bo'yicha yoki "hammasi" */
async function norms(db: Db | typeof pool, orderId: number) {
  return (
    await db.query(
      `SELECT m.color_id, m.size_id, m.material_id, mt.name AS material_name, mt.code AS material_code, mt.unit,
              m.material_color_id, mc.name AS material_color_name, m.color_code, m.material_size, m.per_unit
         FROM order_materials m JOIN materials mt ON mt.id = m.material_id LEFT JOIN colors mc ON mc.id = m.material_color_id
        WHERE m.order_id = $1 AND NOT m.is_main ORDER BY m.sort, m.id`,
      [orderId],
    )
  ).rows;
}

/** Tsexdagi furnitura: skladdan shu tsexga shu partiya uchun berilgan − tikishda sarflangan */
async function tsexMaterials(db: Db | typeof pool, orderId: number, producerId: number) {
  return (
    await db.query(
      `SELECT t.material_id, t.material_color_id, t.color_code, t.material_size, round(sum(t.recv), 3) AS received, round(sum(t.used), 3) AS used,
              round(sum(t.recv) - sum(t.used), 3) AS left_qty
         FROM (
           SELECT x.material_id, x.material_color_id, x.color_code, x.material_size, -x.dir * x.qty AS recv, 0 AS used
             FROM stock_moves x JOIN stock_docs d ON d.id = x.doc_id
            WHERE x.order_id = $1 AND x.destination = 'producer' AND x.producer_id = $2 AND d.kind IN ('rasxod_zayavka', 'rasxod')
           UNION ALL
           SELECT m.material_id, m.material_color_id, m.color_code, m.material_size, 0, m.qty
             FROM tsex_materials m JOIN tsex_docs d ON d.id = m.doc_id WHERE d.order_id = $1 AND d.producer_id = $2
         ) t GROUP BY t.material_id, t.material_color_id, t.color_code, t.material_size`,
      [orderId, producerId],
    )
  ).rows;
}

tsexRouter.get('/plan', async (req, res) => {
  const q = z.object({ producer_id: idParam, order_id: idParam }).parse(req.query);
  const order = (
    await pool.query(
      `SELECT o.id, o.partiya_no, o.artikul, o.model, pt.name AS product_type_name FROM orders o JOIN product_types pt ON pt.id = o.product_type_id WHERE o.id = $1`,
      [q.order_id],
    )
  ).rows[0];
  if (!order) throw notFound('Zakaz');
  const cells = await balance(pool, { producer_id: q.producer_id, order_id: q.order_id, all: true });
  const issueNos = (
    await pool.query(
      `SELECT issue_no, array_agg(color_id || ':' || size_id) AS cells FROM kroy_issues
        WHERE order_id = $1 AND producer_id = $2 AND status = 'accepted' GROUP BY issue_no ORDER BY min(id)`,
      [q.order_id, q.producer_id],
    )
  ).rows;
  res.json({ order, cells, norms: await norms(pool, q.order_id), materials: await tsexMaterials(pool, q.order_id, q.producer_id), issue_nos: issueNos });
});

tsexRouter.post('/outputs', requireAction('tsex.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      producer_id: idParam,
      order_id: idParam,
      out_date: date,
      issue_no: optText(100),
      note: optText(500),
      rows: z.array(z.object({ color_id: idParam, size_id: idParam, fact_qty: int.positive().max(1e7) })).min(1, 'Fakt miqdorini kiriting!').max(200),
    })
    .parse(req.body);
  const data = await tx(async (db) => {
    await db.query(LOCK);
    const cells = await balance(db, { producer_id: b.producer_id, order_id: b.order_id, all: true });
    const key = (c: { color_id: number; size_id: number }) => `${c.color_id}:${c.size_id}`;
    const byKey = new Map(cells.map((c) => [key(c), c]));
    const seen = new Set<string>();
    for (const r of b.rows) {
      const c = byKey.get(key(r));
      if (!c) throw badRequest('Bu rang va razmer tsexga kelmagan');
      if (seen.has(key(r))) throw badRequest(`${c.color_name} ${c.size_name}: takrorlangan`);
      seen.add(key(r));
      if (r.fact_qty > c.left_qty) throw badRequest(`${c.color_name} ${c.size_name}: tikilmagan ${c.left_qty} ta, fakt ${r.fact_qty} — qoldiq manfiy`);
    }
    const doc = (
      await db.query('INSERT INTO tsex_docs (order_id, producer_id, out_date, issue_no, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [
        b.order_id, b.producer_id, b.out_date, b.issue_no, b.note, ctx.userId,
      ])
    ).rows[0].id as number;
    const nm = await norms(db, b.order_id);
    const avg = new Map<string, number>();
    let lines = 0;
    for (const r of b.rows) {
      const out = (
        await db.query('INSERT INTO tsex_outputs (doc_id, color_id, size_id, need_qty, fact_qty) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
          doc, r.color_id, r.size_id, byKey.get(key(r))!.left_qty, r.fact_qty,
        ])
      ).rows[0].id as number;
      for (const n of nm.filter((x) => x.color_id === r.color_id && (x.size_id == null || x.size_id === r.size_id))) {
        const mk = [n.material_id, n.material_color_id, n.color_code, n.material_size].join('|');
        if (!avg.has(mk)) avg.set(mk, (await itemState(db, n)).avg);
        const qty = Math.round(Number(n.per_unit) * r.fact_qty * 1000) / 1000;
        await db.query(
          `INSERT INTO tsex_materials (doc_id, output_id, material_id, material_color_id, color_code, material_size, per_unit, qty, cost_uzs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [doc, out, n.material_id, n.material_color_id, n.color_code, n.material_size, n.per_unit, qty, r2(qty * avg.get(mk)!)],
        );
        lines++;
      }
    }
    await audit(db, ctx, 'tsex_doc', doc, 'create', undefined, { ...b, materials: lines });
    return { id: doc, materials: lines };
  });
  res.status(201).json(data);
});

/** Ish/Chiq GP */
tsexRouter.get('/outputs', async (req, res) => {
  const q = z.object({ producer_id: idParam.optional(), order_id: idParam.optional(), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).parse(req.query);
  const rows = (
    await pool.query(
      `SELECT o.id, d.id AS doc_id, d.out_date, d.created_at, d.issue_no, d.order_id, od.partiya_no, pt.name AS product_type_name,
              d.producer_id, pr.name AS producer_name, c.name AS color_name, s.name AS size_name, o.need_qty, o.fact_qty,
              (SELECT round(sum(m.cost_uzs), 2) FROM tsex_materials m WHERE m.output_id = o.id) AS materials_cost, u.full_name AS created_by_name
         FROM tsex_outputs o JOIN tsex_docs d ON d.id = o.doc_id JOIN orders od ON od.id = d.order_id JOIN product_types pt ON pt.id = od.product_type_id
         JOIN producers pr ON pr.id = d.producer_id JOIN colors c ON c.id = o.color_id JOIN sizes s ON s.id = o.size_id
         LEFT JOIN users u ON u.id = d.created_by
        WHERE ($1::int IS NULL OR d.producer_id = $1) AND ($2::int IS NULL OR d.order_id = $2)
        ORDER BY d.out_date DESC, d.id DESC, lower(c.name), s.sort LIMIT $3`,
      [q.producer_id ?? null, q.order_id ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

/** Ish/Chiq Xa */
tsexRouter.get('/materials', async (req, res) => {
  const q = z.object({ producer_id: idParam.optional(), order_id: idParam.optional(), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).parse(req.query);
  const rows = (
    await pool.query(
      `SELECT m.id, d.id AS doc_id, d.out_date, d.created_at, od.partiya_no, pr.name AS producer_name,
              mt.name AS material_name, mt.code AS material_code, mt.unit, mc.name AS material_color_name, m.color_code, m.material_size,
              m.per_unit, c.name AS color_name, s.name AS size_name, o.fact_qty, m.qty, m.cost_uzs
         FROM tsex_materials m JOIN tsex_docs d ON d.id = m.doc_id JOIN tsex_outputs o ON o.id = m.output_id
         JOIN orders od ON od.id = d.order_id JOIN producers pr ON pr.id = d.producer_id JOIN materials mt ON mt.id = m.material_id
         LEFT JOIN colors mc ON mc.id = m.material_color_id JOIN colors c ON c.id = o.color_id JOIN sizes s ON s.id = o.size_id
        WHERE ($1::int IS NULL OR d.producer_id = $1) AND ($2::int IS NULL OR d.order_id = $2)
        ORDER BY d.out_date DESC, d.id DESC, m.id LIMIT $3`,
      [q.producer_id ?? null, q.order_id ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

tsexRouter.delete('/docs/:id', requireAction('tsex.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const d = (await db.query('SELECT * FROM tsex_docs WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!d) throw notFound('Ishlab chiqarish');
    await db.query('DELETE FROM tsex_docs WHERE id = $1', [id]);
    await audit(db, ctx, 'tsex_doc', id, 'delete', d, undefined);
  });
  res.status(204).end();
});
