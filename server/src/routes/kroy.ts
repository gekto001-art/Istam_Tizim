import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, optText } from '../lib/util.js';
import { itemState } from './stock.js';

/**
 * Bichuv (kroy) va sifat nazorati — Sheets "Kroy" va "Sifat Nazorati_Bichuv" bo'yicha:
 *  1) Kroy: partiya kataklari (rang × razmer) bo'yicha fakt kesilgan son va har katakka xomashyo sarfi
 *     (fakt bor katakda sarf ham bo'lishi shart va aksincha — Sheets'dagi X tekshiruvi);
 *  2) OTK Bichuv: har kesilgan yozuv (ID) — 1 sort + brak = kesilgan son;
 *  3) OTK Brak: brak kroyda 1 sort, 2 sort va yaroqsizga ajratiladi; yaroqsiz — P&L xarajat (tannarxda);
 *  4) Kroyda turgan yarim tayyor = OTK 1 sort + brakdan 1 va 2 sort − ishlab chiqarishga berilgan (rad etilmagan);
 *  5) Kroydan rasxod: yarim tayyor korxonaga, Ish/Chiq raqam = partiya_N;
 *  6) Yopilgan zakazlar: kroy ro'yxatidan chiqadi; minusga kirgan xomashyo qoldiqlari.
 */
export const kroyRouter = Router();
kroyRouter.use(requireAction('kroy.read'));

const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));
const int = z.coerce.number().int();
const r2 = (v: number) => Math.round(v * 100) / 100;
const LOCK = 'SELECT pg_advisory_xact_lock(740107)';

const itemSchema = {
  material_id: idParam,
  material_color_id: idParam.nullish().transform((v) => v ?? null),
  color_code: optText(50),
  material_size: optText(50),
};

/** Kroydagi xomashyo: skladdan kroyga berilgan (peremesheniya − vozvrat) − kesishda sarflangan */
const KROY_MATERIALS = `
  SELECT t.material_id, mt.name AS material_name, mt.code AS material_code, mt.unit, t.material_color_id, c.name AS material_color_name,
         t.color_code, t.material_size, round(sum(t.recv), 3) AS received, round(sum(t.used), 3) AS used,
         round(sum(t.recv) - sum(t.used), 3) AS left_qty
    FROM (
      SELECT x.material_id, x.material_color_id, x.color_code, x.material_size, -x.dir * x.qty AS recv, 0 AS used
        FROM stock_moves x JOIN stock_docs d ON d.id = x.doc_id
       WHERE x.order_id = $1 AND x.destination = 'kroy' AND d.kind IN ('rasxod_zayavka', 'rasxod')
      UNION ALL
      SELECT m.material_id, m.material_color_id, m.color_code, m.material_size, 0, m.qty
        FROM kroy_cut_materials m JOIN kroy_cut_items i ON i.id = m.item_id JOIN kroy_cuts k ON k.id = i.cut_id
       WHERE k.order_id = $1
    ) t JOIN materials mt ON mt.id = t.material_id LEFT JOIN colors c ON c.id = t.material_color_id
   GROUP BY t.material_id, mt.name, mt.code, mt.unit, t.material_color_id, c.name, t.color_code, t.material_size`;

const ORDER_HEAD = `
  SELECT o.id, o.partiya_no, o.status, o.artikul, o.model, o.kroy_closed_at, o.kroy_close_note, pt.name AS product_type_name,
         o.producer_id, pr.name AS producer_name
    FROM orders o JOIN product_types pt ON pt.id = o.product_type_id LEFT JOIN producers pr ON pr.id = o.producer_id`;

async function orderHead(db: Db | typeof pool, id: number) {
  const o = (await db.query(`${ORDER_HEAD} WHERE o.id = $1`, [id])).rows[0];
  if (!o) throw notFound('Zakaz');
  return o;
}

// ---------- Kroy ----------
/** Kroy uchun ochiq partiyalar: kroyga xomashyo kelgan yoki kesilgan, yopilmagan */
kroyRouter.get('/orders', async (_req, res) => {
  const rows = (
    await pool.query(
      `${ORDER_HEAD}
        WHERE o.status = 'confirmed' AND o.kroy_closed_at IS NULL
          AND (EXISTS (SELECT 1 FROM stock_moves x WHERE x.order_id = o.id AND x.destination = 'kroy')
               OR EXISTS (SELECT 1 FROM kroy_cuts k WHERE k.order_id = o.id))
        ORDER BY o.id DESC`,
    )
  ).rows;
  res.json(rows);
});

async function kroyOrder(db: Db | typeof pool, id: number) {
  const order = await orderHead(db, id);
  const cells = (
    await db.query(
      `SELECT i.color_id, c.name AS color_name, i.size_id, s.name AS size_name, coalesce(i.actual_qty, i.qty) AS plan_qty,
              coalesce((SELECT sum(ki.fact_qty) FROM kroy_cut_items ki JOIN kroy_cuts k ON k.id = ki.cut_id
                         WHERE k.order_id = i.order_id AND ki.color_id = i.color_id AND ki.size_id = i.size_id), 0)::int AS cut_qty
         FROM order_items i JOIN colors c ON c.id = i.color_id JOIN sizes s ON s.id = i.size_id
        WHERE i.order_id = $1 ORDER BY lower(c.name), s.sort, s.id`,
      [id],
    )
  ).rows;
  const materials = (await db.query(`${KROY_MATERIALS} ORDER BY lower(mt.name), mt.code, c.name NULLS FIRST, t.color_code, t.material_size`, [id])).rows;
  return { order, cells, materials };
}

kroyRouter.get('/orders/:id', async (req, res) => {
  res.json(await kroyOrder(pool, idParam.parse(req.params.id)));
});

kroyRouter.post('/cuts', requireAction('kroy.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const cell = { color_id: idParam, size_id: idParam };
  const b = z
    .object({
      order_id: idParam,
      cut_date: date,
      is_recut: z.boolean().default(false),
      note: optText(500),
      cells: z.array(z.object({ ...cell, fact_qty: int.positive().max(1e7) })).min(1).max(200),
      materials: z
        .array(z.object({ ...itemSchema, uses: z.array(z.object({ ...cell, qty: z.coerce.number().positive().max(1e9) })).min(1).max(200) }))
        .min(1, 'Xomashyo sarfini kiriting')
        .max(200),
    })
    .parse(req.body);
  const data = await tx(async (db) => {
    await db.query(LOCK);
    const order = await orderHead(db, b.order_id);
    if (order.status !== 'confirmed') throw conflict('Zakaz tasdiqlanmagan');
    if (order.kroy_closed_at) throw conflict('Bu zakaz kroyda yopilgan');
    const { cells } = await kroyOrder(db, b.order_id);
    const k = (c: { color_id: number; size_id: number }) => `${c.color_id}:${c.size_id}`;
    const byCell = new Map(cells.map((c) => [k(c), c]));
    const name = (c: { color_id: number; size_id: number }) => {
      const x = byCell.get(k(c));
      return x ? `${x.color_name} ${x.size_name}` : 'katak';
    };
    const facts = new Map<string, number>();
    for (const c of b.cells) {
      if (!byCell.has(k(c))) throw badRequest('Bu rang va razmer zakazda yo\'q');
      if (facts.has(k(c))) throw badRequest(`${name(c)}: takrorlangan`);
      facts.set(k(c), c.fact_qty);
    }
    // Sheets "Natija": fakt va sarf birga bo'lishi kerak
    const used = new Set<string>();
    for (const m of b.materials) {
      for (const u of m.uses) {
        if (!facts.has(k(u))) throw badRequest(`${name(u)}: xomashyo sarfi bor, fakt kiritilmagan`);
        used.add(k(u));
      }
    }
    for (const c of b.cells) if (!used.has(k(c))) throw badRequest(`${name(c)}: fakt kiritilgan, xomashyo sarfi yo'q`);

    const cut = (
      await db.query('INSERT INTO kroy_cuts (order_id, cut_date, is_recut, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
        b.order_id, b.cut_date, b.is_recut, b.note, ctx.userId,
      ])
    ).rows[0].id as number;
    const itemIds = new Map<string, number>();
    for (const c of b.cells) {
      const id = (
        await db.query('INSERT INTO kroy_cut_items (cut_id, color_id, size_id, plan_qty, fact_qty) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
          cut, c.color_id, c.size_id, byCell.get(k(c))!.plan_qty, c.fact_qty,
        ])
      ).rows[0].id as number;
      itemIds.set(k(c), id);
    }
    for (const m of b.materials) {
      if (!(await db.query('SELECT 1 FROM materials WHERE id = $1', [m.material_id])).rowCount) throw notFound('Xomashyo');
      const { avg } = await itemState(db, m);
      for (const u of m.uses) {
        await db.query(
          `INSERT INTO kroy_cut_materials (item_id, material_id, material_color_id, color_code, material_size, qty, cost_uzs)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [itemIds.get(k(u)), m.material_id, m.material_color_id, m.color_code, m.material_size, u.qty, r2(u.qty * avg)],
        );
      }
    }
    await audit(db, ctx, 'kroy_cut', cut, 'create', undefined, { ...b });
    const after = await kroyOrder(db, b.order_id);
    // Sheets'dagidek minusga kirish to'xtatilmaydi — ogohlantiriladi ("Yopilgan zakazlar"da ko'rinadi)
    const warnings = after.materials
      .filter((x) => Number(x.left_qty) < 0)
      .map((x) => `${[x.material_name, x.material_color_name, x.color_code].filter(Boolean).join(' ')}: kroyda qoldiq ${x.left_qty} ${x.unit}`);
    return { id: cut, warnings, ...after };
  });
  res.status(201).json(data);
});

/** Kroy TM baza: kesilgan yozuvlar (ID), OTK va brak saralash natijasi bilan */
const ITEMS = `
  SELECT i.id, i.cut_id, k.cut_date, k.created_at, k.is_recut, k.order_id, o.partiya_no, pt.name AS product_type_name, o.artikul, o.model,
         i.color_id, c.name AS color_name, i.size_id, s.name AS size_name, i.plan_qty, i.fact_qty,
         i.otk_date, i.otk_first, i.otk_brak, uo.full_name AS otk_by_name, uc.full_name AS created_by_name,
         b.sort_date, b.sort1, b.sort2, b.scrap, b.scrap_cost_uzs,
         (SELECT round(sum(m.cost_uzs) / i.fact_qty, 2) FROM kroy_cut_materials m WHERE m.item_id = i.id) AS unit_cost
    FROM kroy_cut_items i JOIN kroy_cuts k ON k.id = i.cut_id JOIN orders o ON o.id = k.order_id
    JOIN product_types pt ON pt.id = o.product_type_id JOIN colors c ON c.id = i.color_id JOIN sizes s ON s.id = i.size_id
    LEFT JOIN users uo ON uo.id = i.otk_by LEFT JOIN users uc ON uc.id = k.created_by
    LEFT JOIN kroy_brak_sorts b ON b.item_id = i.id`;

kroyRouter.get('/items', async (req, res) => {
  const q = z
    .object({
      order_id: idParam.optional(),
      otk: z.enum(['pending', 'done', 'brak', 'brak_done', 'all']).default('all'),
      limit: z.coerce.number().int().min(1).max(5000).default(1000),
    })
    .parse(req.query);
  const cond = {
    pending: 'i.otk_at IS NULL',
    done: 'i.otk_at IS NOT NULL',
    brak: 'i.otk_brak > 0 AND b.id IS NULL',
    brak_done: 'b.id IS NOT NULL',
    all: 'true',
  }[q.otk];
  const rows = (
    await pool.query(`${ITEMS} WHERE ${cond} AND ($1::int IS NULL OR k.order_id = $1) ORDER BY k.cut_date DESC, i.id DESC LIMIT $2`, [q.order_id ?? null, q.limit])
  ).rows;
  res.json(rows);
});

/** Kroy Xa baza: xomashyo sarfi */
kroyRouter.get('/consumption', async (req, res) => {
  const q = z.object({ order_id: idParam.optional(), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).parse(req.query);
  const rows = (
    await pool.query(
      `SELECT m.id, i.id AS item_id, k.id AS cut_id, k.cut_date, k.created_at, o.partiya_no, mt.name AS material_name, mt.code AS material_code, mt.unit,
              mc.name AS material_color_name, m.color_code, m.material_size, m.qty, m.cost_uzs, c.name AS color_name, s.name AS size_name
         FROM kroy_cut_materials m JOIN kroy_cut_items i ON i.id = m.item_id JOIN kroy_cuts k ON k.id = i.cut_id JOIN orders o ON o.id = k.order_id
         JOIN materials mt ON mt.id = m.material_id LEFT JOIN colors mc ON mc.id = m.material_color_id
         JOIN colors c ON c.id = i.color_id JOIN sizes s ON s.id = i.size_id
        WHERE ($1::int IS NULL OR k.order_id = $1) ORDER BY k.cut_date DESC, k.id DESC, m.id LIMIT $2`,
      [q.order_id ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

/** Kesishni o'chirish — OTK tekshirmagan bo'lsa */
kroyRouter.delete('/cuts/:id', requireAction('kroy.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    await db.query(LOCK);
    const cut = (await db.query('SELECT * FROM kroy_cuts WHERE id = $1', [id])).rows[0];
    if (!cut) throw notFound('Kroy');
    if ((await db.query('SELECT 1 FROM kroy_cut_items WHERE cut_id = $1 AND otk_at IS NOT NULL LIMIT 1', [id])).rowCount) {
      throw conflict('OTK tekshirgan kroyni o\'chirib bo\'lmaydi');
    }
    await db.query('DELETE FROM kroy_cuts WHERE id = $1', [id]);
    await audit(db, ctx, 'kroy_cut', id, 'delete', cut, undefined);
  });
  res.status(204).end();
});

// ---------- Sifat nazorati (OTK Bichuv) ----------
kroyRouter.post('/otk', requireAction('otk.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      otk_date: date,
      rows: z.array(z.object({ item_id: idParam, first: int.min(0).max(1e7), brak: int.min(0).max(1e7) })).min(1).max(1000),
    })
    .parse(req.body);
  await tx(async (db) => {
    for (const r of b.rows) {
      const i = (await db.query('SELECT * FROM kroy_cut_items WHERE id = $1 FOR UPDATE', [r.item_id])).rows[0];
      if (!i) throw notFound('Kroy yozuvi');
      if (i.otk_at) throw conflict(`ID ${r.item_id}: OTK allaqachon tekshirgan`);
      if (r.first + r.brak !== i.fact_qty) throw badRequest(`ID ${r.item_id}: 1 sort + brak kroy qilingan miqdorga (${i.fact_qty}) teng bo'lishi kerak — Ostatka 0`);
      await db.query('UPDATE kroy_cut_items SET otk_date = $2, otk_first = $3, otk_brak = $4, otk_by = $5, otk_at = now() WHERE id = $1', [
        r.item_id, b.otk_date, r.first, r.brak, ctx.userId,
      ]);
    }
    await audit(db, ctx, 'kroy_otk', b.rows[0].item_id, 'otk', undefined, b);
  });
  res.json({ saved: b.rows.length });
});

// ---------- OTK Brak → kroyda saralash ----------
kroyRouter.post('/brak', requireAction('kroy.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      sort_date: date,
      rows: z.array(z.object({ item_id: idParam, sort1: int.min(0).max(1e7), sort2: int.min(0).max(1e7), scrap: int.min(0).max(1e7) })).min(1).max(1000),
    })
    .parse(req.body);
  await tx(async (db) => {
    for (const r of b.rows) {
      const i = (
        await db.query(
          `SELECT i.*, (SELECT sum(m.cost_uzs) FROM kroy_cut_materials m WHERE m.item_id = i.id) AS cost,
                  EXISTS (SELECT 1 FROM kroy_brak_sorts s WHERE s.item_id = i.id) AS sorted
             FROM kroy_cut_items i WHERE i.id = $1 FOR UPDATE`,
          [r.item_id],
        )
      ).rows[0];
      if (!i) throw notFound('Kroy yozuvi');
      if (!i.otk_brak) throw badRequest(`ID ${r.item_id}: brak yo'q`);
      if (i.sorted) throw conflict(`ID ${r.item_id}: brak allaqachon saralangan`);
      if (r.sort1 + r.sort2 + r.scrap !== i.otk_brak) throw badRequest(`ID ${r.item_id}: 1 sort + 2 sort + yaroqsiz brak soniga (${i.otk_brak}) teng bo'lishi kerak — Ostatka 0`);
      const unit = i.cost ? Number(i.cost) / i.fact_qty : 0;
      await db.query(
        'INSERT INTO kroy_brak_sorts (item_id, sort_date, sort1, sort2, scrap, scrap_cost_uzs, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [r.item_id, b.sort_date, r.sort1, r.sort2, r.scrap, r2(r.scrap * unit), ctx.userId],
      );
    }
    await audit(db, ctx, 'kroy_brak', b.rows[0].item_id, 'sort', undefined, b);
  });
  res.json({ saved: b.rows.length });
});

// ---------- Kroyda turgan yarim tayyor ----------
const SEMI = `
  WITH t AS (
    SELECT k.order_id, i.color_id, i.size_id, coalesce(i.otk_first, 0) AS otk1, coalesce(b.sort1, 0) AS s1, coalesce(b.sort2, 0) AS s2, 0 AS issued, 0 AS accepted
      FROM kroy_cut_items i JOIN kroy_cuts k ON k.id = i.cut_id LEFT JOIN kroy_brak_sorts b ON b.item_id = i.id
    UNION ALL
    SELECT x.order_id, x.color_id, x.size_id, 0, 0, 0, x.qty, CASE WHEN x.status = 'accepted' THEN x.qty ELSE 0 END
      FROM kroy_issues x WHERE x.status <> 'rejected')
  SELECT t.order_id, o.partiya_no, pt.name AS product_type_name, t.color_id, c.name AS color_name, t.size_id, s.name AS size_name,
         sum(t.otk1)::int AS otk_first, sum(t.s1)::int AS sort1, sum(t.s2)::int AS sort2, (sum(t.otk1) + sum(t.s1) + sum(t.s2))::int AS total,
         sum(t.issued)::int AS issued, sum(t.accepted)::int AS accepted, (sum(t.otk1) + sum(t.s1) + sum(t.s2) - sum(t.issued))::int AS left_qty
    FROM t JOIN orders o ON o.id = t.order_id JOIN product_types pt ON pt.id = o.product_type_id
    JOIN colors c ON c.id = t.color_id JOIN sizes s ON s.id = t.size_id`;
const SEMI_GROUP = 'GROUP BY t.order_id, o.partiya_no, pt.name, t.color_id, c.name, t.size_id, s.name, s.sort';

kroyRouter.get('/semi', async (req, res) => {
  const q = z.object({ order_id: idParam.optional(), all: z.coerce.boolean().optional() }).parse(req.query);
  const rows = (
    await pool.query(
      `${SEMI} WHERE ($1::int IS NULL OR t.order_id = $1) ${SEMI_GROUP}
       HAVING $2 OR (sum(t.otk1) + sum(t.s1) + sum(t.s2) - sum(t.issued)) <> 0
        ORDER BY t.order_id DESC, lower(c.name), s.sort`,
      [q.order_id ?? null, q.all ?? false],
    )
  ).rows;
  res.json(rows);
});

// ---------- Kroydan rasxod ----------
kroyRouter.get('/issues', async (req, res) => {
  const q = z.object({ order_id: idParam.optional(), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).parse(req.query);
  const rows = (
    await pool.query(
      `SELECT x.id, x.issue_no, x.issue_date, x.created_at, x.order_id, o.partiya_no, x.producer_id, pr.name AS producer_name,
              c.name AS color_name, s.name AS size_name, x.qty, x.status, u.full_name AS created_by_name
         FROM kroy_issues x JOIN orders o ON o.id = x.order_id JOIN producers pr ON pr.id = x.producer_id
         JOIN colors c ON c.id = x.color_id JOIN sizes s ON s.id = x.size_id LEFT JOIN users u ON u.id = x.created_by
        WHERE ($1::int IS NULL OR x.order_id = $1) ORDER BY x.issue_date DESC, x.id DESC LIMIT $2`,
      [q.order_id ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

kroyRouter.post('/issues', requireAction('kroy.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      issue_date: date,
      order_id: idParam,
      producer_id: idParam,
      rows: z.array(z.object({ color_id: idParam, size_id: idParam, qty: int.positive().max(1e7) })).min(1).max(200),
    })
    .parse(req.body);
  const data = await tx(async (db) => {
    await db.query(LOCK);
    const order = await orderHead(db, b.order_id);
    if (!(await db.query('SELECT 1 FROM producers WHERE id = $1', [b.producer_id])).rowCount) throw notFound('Korxona');
    const semi = (await db.query(`${SEMI} WHERE t.order_id = $1 ${SEMI_GROUP}`, [b.order_id])).rows;
    const need = new Map<string, number>();
    for (const r of b.rows) need.set(`${r.color_id}:${r.size_id}`, (need.get(`${r.color_id}:${r.size_id}`) ?? 0) + r.qty);
    for (const [key, q] of need) {
      const s = semi.find((x) => `${x.color_id}:${x.size_id}` === key);
      if (!s) throw badRequest('Bu rang va razmerda kroyda yarim tayyor yo\'q');
      if (q > s.left_qty) throw badRequest(`${s.color_name} ${s.size_name}: kroyda ${s.left_qty} ta, rasxod ${q} — qoldiq miqdori kam`);
    }
    const n = Number((await db.query('SELECT count(DISTINCT issue_no) AS n FROM kroy_issues WHERE order_id = $1', [b.order_id])).rows[0].n) + 1;
    const issueNo = `${order.partiya_no}_${n}`;
    for (const r of b.rows) {
      await db.query('INSERT INTO kroy_issues (order_id, issue_date, issue_no, producer_id, color_id, size_id, qty, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
        b.order_id, b.issue_date, issueNo, b.producer_id, r.color_id, r.size_id, r.qty, ctx.userId,
      ]);
    }
    await audit(db, ctx, 'kroy_issue', b.order_id, 'create', undefined, { ...b, issue_no: issueNo });
    return { issue_no: issueNo };
  });
  res.status(201).json(data);
});

/** Ishlab chiqarish qabul qilmagan (kutilmoqda) rasxodni o'chirish */
kroyRouter.delete('/issues/:id', requireAction('kroy.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const x = (await db.query('SELECT * FROM kroy_issues WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!x) throw notFound('Rasxod');
    if (x.status !== 'pending') throw conflict('Ishlab chiqarish javob bergan rasxodni o\'chirib bo\'lmaydi');
    await db.query('DELETE FROM kroy_issues WHERE id = $1', [id]);
    await audit(db, ctx, 'kroy_issue', id, 'delete', x, undefined);
  });
  res.status(204).end();
});

// ---------- Yopilgan zakazlar ----------
kroyRouter.get('/closed', async (_req, res) => {
  const closed = (await pool.query(`${ORDER_HEAD} WHERE o.kroy_closed_at IS NOT NULL ORDER BY o.kroy_closed_at DESC, o.id DESC`)).rows;
  const minus = (
    await pool.query(
      `SELECT o.id AS order_id, o.partiya_no, o.kroy_closed_at, m.*
         FROM orders o CROSS JOIN LATERAL (${KROY_MATERIALS.replaceAll('$1', 'o.id')}) m
        WHERE m.left_qty < 0 ORDER BY o.id DESC`,
    )
  ).rows;
  res.json({ closed, minus });
});

kroyRouter.post('/orders/:id/close', requireAction('kroy.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = z.object({ closed_at: date, note: optText(500) }).parse(req.body);
  await tx(async (db) => {
    const o = await orderHead(db, id);
    if (o.kroy_closed_at) throw conflict('Zakaz allaqachon yopilgan');
    await db.query('UPDATE orders SET kroy_closed_at = $2, kroy_close_note = $3 WHERE id = $1', [id, b.closed_at, b.note]);
    await audit(db, ctx, 'order', id, 'kroy_close', undefined, b);
  });
  res.status(204).end();
});

kroyRouter.post('/orders/:id/reopen', requireAction('kroy.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const o = await orderHead(db, id);
    await db.query('UPDATE orders SET kroy_closed_at = NULL, kroy_close_note = NULL WHERE id = $1', [id]);
    await audit(db, ctx, 'order', id, 'kroy_reopen', { kroy_closed_at: o.kroy_closed_at }, undefined);
  });
  res.status(204).end();
});
