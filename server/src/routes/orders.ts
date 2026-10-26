import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction, type RequestCtx } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { can } from '../lib/permissions.js';
import { decimal, idParam, optText } from '../lib/util.js';

/**
 * Innovatsion bo'lim: zakaz (partiya).
 * Sheets'dagi "Zakazlar" varag'i: sarlavha + razmer × rang matritsasi + har rang uchun xomashyo normasi + ish narxlari.
 * Tasdiqlangan zakazning xomashyo ehtiyoji ta'minotga (xomashyo zakazi) ketadi.
 */
export const ordersRouter = Router();
ordersRouter.use(requireAction('orders.read'));

const CURRENCY = z.enum(['UZS', 'USD', 'CNY', 'EUR', 'RUB']);
const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));

async function orderOf(db: Db, id: number, lock = false) {
  const o = (await db.query(`SELECT * FROM orders WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!o) throw notFound('Zakaz');
  return o;
}

/** Faqat qoralama tahrirlanadi; tasdiqlanganini avval qoralamaga qaytarish kerak. */
function assertDraft(ctx: RequestCtx, o: { status: string }) {
  if (!can(ctx.role, 'orders.write')) throw new AppError(403, 'FORBIDDEN', 'Bu amal uchun ruxsat yo\'q');
  if (o.status !== 'draft') {
    throw new AppError(409, 'ORDER_LOCKED', o.status === 'confirmed' ? 'Zakaz tasdiqlangan — o\'zgartirish uchun avval qoralamaga qaytaring' : 'Zakaz bekor qilingan');
  }
}

/** Zakaz to'liq: sarlavha, matritsa, xomashyo normasi, ish narxlari va hisob-kitob. */
export async function orderDetail(db: Db | typeof pool, id: number) {
  const order = (
    await db.query(
      `SELECT o.*, pt.name AS product_type_name, p.name AS producer_name, p.kind AS producer_kind,
              uc.full_name AS created_by_name, uf.full_name AS confirmed_by_name
         FROM orders o JOIN product_types pt ON pt.id = o.product_type_id
         LEFT JOIN producers p ON p.id = o.producer_id
         LEFT JOIN users uc ON uc.id = o.created_by
         LEFT JOIN users uf ON uf.id = o.confirmed_by
        WHERE o.id = $1`,
      [id],
    )
  ).rows[0];
  if (!order) throw notFound('Zakaz');
  const items = (
    await db.query(
      `SELECT i.size_id, s.name AS size_name, i.color_id, c.name AS color_name, i.qty, i.actual_qty
         FROM order_items i JOIN sizes s ON s.id = i.size_id JOIN colors c ON c.id = i.color_id
        WHERE i.order_id = $1 ORDER BY s.sort, lower(s.name), lower(c.name)`,
      [id],
    )
  ).rows;
  // Har qator: shu rangdagi jami dona × sarf = kerakli miqdor; × narx × kurs = so'mda
  const materials = (
    await db.query(
      `WITH cq AS (SELECT color_id, sum(qty) AS qty FROM order_items WHERE order_id = $1 GROUP BY color_id)
       SELECT m.*, c.name AS color_name, mt.name AS material_name, mt.code AS material_code, mt.unit,
              s.name AS supplier_name, mc.name AS material_color_name,
              coalesce(cq.qty, 0) AS product_qty,
              round(coalesce(cq.qty, 0) * m.per_unit, 3) AS total_qty,
              round(coalesce(cq.qty, 0) * m.per_unit * m.price, 2) AS total_amount,
              round(coalesce(cq.qty, 0) * m.per_unit * m.price * m.rate, 2) AS total_uzs,
              round(m.per_unit * m.price * m.rate, 2) AS unit_cost_uzs
         FROM order_materials m
         JOIN colors c ON c.id = m.color_id
         JOIN materials mt ON mt.id = m.material_id
         LEFT JOIN suppliers s ON s.id = m.supplier_id
         LEFT JOIN colors mc ON mc.id = m.material_color_id
         LEFT JOIN cq ON cq.color_id = m.color_id
        WHERE m.order_id = $1
        ORDER BY lower(c.name), m.sort, m.id`,
      [id],
    )
  ).rows;
  const works = (
    await db.query(
      `SELECT w.*, p.name AS producer_name, p.kind AS producer_kind FROM order_works w JOIN producers p ON p.id = w.producer_id
        WHERE w.order_id = $1 ORDER BY p.kind, lower(p.name)`,
      [id],
    )
  ).rows;
  // Rang bo'yicha 1 dona tannarx (reja): xomashyo + ish
  const byColor = (
    await db.query(
      `WITH cq AS (SELECT color_id, sum(qty) AS qty, sum(actual_qty) AS actual_qty, bool_and(actual_qty IS NOT NULL) AS has_actual
                   FROM order_items WHERE order_id = $1 GROUP BY color_id),
            mat AS (SELECT color_id, sum(round(per_unit * price * rate, 2)) AS unit_cost FROM order_materials WHERE order_id = $1 GROUP BY color_id),
            wk AS (SELECT coalesce(sum(price), 0) AS unit_cost FROM order_works WHERE order_id = $1)
       SELECT cq.color_id, c.name AS color_name, cq.qty, CASE WHEN cq.has_actual THEN cq.actual_qty END AS actual_qty,
              coalesce(mat.unit_cost, 0) AS material_cost, wk.unit_cost AS work_cost,
              coalesce(mat.unit_cost, 0) + wk.unit_cost AS unit_cost,
              round(cq.qty * (coalesce(mat.unit_cost, 0) + wk.unit_cost), 2) AS total_cost
         FROM cq JOIN colors c ON c.id = cq.color_id LEFT JOIN mat ON mat.color_id = cq.color_id CROSS JOIN wk
        ORDER BY lower(c.name)`,
      [id],
    )
  ).rows;
  // Kerakli xomashyo jami (barcha ranglar bo'yicha yig'ilgan) — ta'minotga ketadigan ro'yxat
  const needs = (
    await db.query(
      `WITH cq AS (SELECT color_id, sum(qty) AS qty FROM order_items WHERE order_id = $1 GROUP BY color_id)
       SELECT m.material_id, mt.name AS material_name, mt.code AS material_code, mt.unit,
              m.supplier_id, s.name AS supplier_name, m.material_color_id, mc.name AS material_color_name,
              m.color_code, m.material_size, m.price, m.currency, m.rate, m.from_us, m.is_main,
              round(sum(coalesce(cq.qty, 0) * m.per_unit), 3) AS total_qty,
              round(sum(coalesce(cq.qty, 0) * m.per_unit * m.price), 2) AS total_amount,
              round(sum(coalesce(cq.qty, 0) * m.per_unit * m.price * m.rate), 2) AS total_uzs,
              string_agg(DISTINCT c.name, ', ') AS for_colors
         FROM order_materials m
         JOIN materials mt ON mt.id = m.material_id
         JOIN colors c ON c.id = m.color_id
         LEFT JOIN suppliers s ON s.id = m.supplier_id
         LEFT JOIN colors mc ON mc.id = m.material_color_id
         LEFT JOIN cq ON cq.color_id = m.color_id
        WHERE m.order_id = $1
        GROUP BY m.material_id, mt.name, mt.code, mt.unit, m.supplier_id, s.name, m.material_color_id, mc.name,
                 m.color_code, m.material_size, m.price, m.currency, m.rate, m.from_us, m.is_main
        ORDER BY m.is_main DESC, s.name NULLS LAST, mt.name, mc.name NULLS FIRST, m.material_size NULLS FIRST`,
      [id],
    )
  ).rows;
  const totals = (
    await db.query(
      `SELECT (SELECT coalesce(sum(qty), 0) FROM order_items WHERE order_id = $1) AS qty,
              (SELECT sum(actual_qty) FROM order_items WHERE order_id = $1 HAVING bool_and(actual_qty IS NOT NULL)) AS actual_qty,
              (SELECT coalesce(sum(round(i.qty * m.per_unit * m.price * m.rate, 2)), 0)
                 FROM order_materials m JOIN order_items i ON i.order_id = m.order_id AND i.color_id = m.color_id
                WHERE m.order_id = $1) AS material_uzs,
              (SELECT coalesce(sum(qty), 0) FROM order_items WHERE order_id = $1)
                * (SELECT coalesce(sum(price), 0) FROM order_works WHERE order_id = $1) AS work_uzs`,
      [id],
    )
  ).rows[0];
  const colorsInMatrix = new Set(items.map((i) => i.color_id));
  const colorsWithMaterials = new Set(materials.map((m) => m.color_id));
  const missing = byColor.filter((c) => !colorsWithMaterials.has(c.color_id)).map((c) => c.color_name as string);
  const warnings: string[] = [];
  if (!items.length) warnings.push('Razmer × rang jadvaliga miqdor kiritilmagan');
  if (missing.length) warnings.push(`Xomashyo normasi kiritilmagan ranglar: ${missing.join(', ')}`);
  const orphan = [...colorsWithMaterials].filter((c) => !colorsInMatrix.has(c));
  if (orphan.length) warnings.push('Jadvalda yo\'q rang uchun xomashyo qatorlari bor');
  if (!works.length) warnings.push('Ish narxlari (kroy, tikuv) kiritilmagan');
  const noMain = byColor.filter((c) => colorsWithMaterials.has(c.color_id) && !materials.some((m) => m.color_id === c.color_id && m.is_main));
  if (noMain.length) {
    warnings.push(`Asosiy mato belgilanmagan ranglar: ${noMain.map((c) => c.color_name).join(', ')} — ularning soni fakt matoga qarab o'zgarmaydi`);
  }
  return { order, items, materials, works, by_color: byColor, needs, totals, warnings };
}

// ---------- Ro'yxat ----------
ordersRouter.get('/', async (req, res) => {
  const q = z
    .object({
      status: z.enum(['draft', 'confirmed', 'cancelled']).optional(),
      q: z.string().trim().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    })
    .parse(req.query);
  const like = q.q ? `%${q.q.toLowerCase()}%` : null;
  const rows = (
    await pool.query(
      `SELECT o.id, o.partiya_no, o.order_date, o.artikul, o.model, o.season, o.status, o.start_date, o.end_date, o.ordered_by,
              pt.name AS product_type_name, p.name AS producer_name,
              (SELECT coalesce(sum(qty), 0) FROM order_items i WHERE i.order_id = o.id) AS qty,
              (SELECT count(DISTINCT color_id) FROM order_items i WHERE i.order_id = o.id) AS colors
         FROM orders o JOIN product_types pt ON pt.id = o.product_type_id LEFT JOIN producers p ON p.id = o.producer_id
        WHERE ($1::text IS NULL OR o.status = $1)
          AND ($2::text IS NULL OR lower(o.partiya_no) LIKE $2 OR lower(coalesce(o.artikul, '')) LIKE $2
               OR lower(coalesce(o.model, '')) LIKE $2 OR lower(pt.name) LIKE $2)
        ORDER BY o.order_date DESC, o.id DESC LIMIT $3`,
      [q.status ?? null, like, q.limit],
    )
  ).rows;
  res.json(rows);
});

ordersRouter.get('/:id', async (req, res) => {
  res.json(await orderDetail(pool, idParam.parse(req.params.id)));
});

// ---------- Sarlavha ----------
const headerBody = z.object({
  partiya_no: z.string().trim().min(1).max(30),
  order_date: date,
  product_type_id: idParam,
  artikul: optText(100),
  model: optText(100),
  season: z.enum(['Bahor', 'Yoz', 'Kuz', 'Qish']).nullish(),
  unit: z.string().trim().min(1).max(20).optional(),
  producer_id: idParam.nullish(),
  ordered_by: optText(100),
  start_date: date.nullish(),
  end_date: date.nullish(),
  note: optText(1000),
});
const HEADER_COLS = Object.keys(headerBody.shape);

function checkDates(b: { start_date?: string | null; end_date?: string | null }) {
  if (b.start_date && b.end_date && b.end_date < b.start_date) throw badRequest('Muddat oxiri boshidan oldin bo\'lishi mumkin emas');
}

ordersRouter.post('/', requireAction('orders.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = headerBody.parse(req.body);
  checkDates(b);
  const data = await tx(async (db) => {
    const keys = HEADER_COLS.filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    const id = (
      await db.query(
        `INSERT INTO orders (${keys.join(', ')}, created_by) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, $${keys.length + 1}) RETURNING id`,
        [...keys.map((k) => (b as Record<string, unknown>)[k] ?? null), ctx.userId],
      )
    ).rows[0].id;
    const d = await orderDetail(db, id);
    await audit(db, ctx, 'order', id, 'create', undefined, d.order);
    return d;
  });
  res.status(201).json(data);
});

ordersRouter.patch('/:id', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = headerBody.partial().parse(req.body) as Record<string, unknown>;
  const data = await tx(async (db) => {
    const old = await orderOf(db, id, true);
    assertDraft(ctx, old);
    checkDates({ start_date: (b.start_date as string) ?? old.start_date, end_date: (b.end_date as string) ?? old.end_date });
    const keys = HEADER_COLS.filter((k) => b[k] !== undefined);
    if (keys.length) {
      await db.query(`UPDATE orders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => b[k] ?? null)]);
    }
    const d = await orderDetail(db, id);
    await audit(db, ctx, 'order', id, 'update', old, d.order);
    return d;
  });
  res.json(data);
});

ordersRouter.delete('/:id', requireAction('orders.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const old = await orderOf(db, id, true);
    assertDraft(ctx, old);
    await db.query('DELETE FROM orders WHERE id = $1', [id]);
    await audit(db, ctx, 'order', id, 'delete', old);
  });
  res.status(204).end();
});

// ---------- Razmer × rang matritsasi (to'liq almashtiriladi) ----------
ordersRouter.put('/:id/items', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const { items } = z
    .object({
      items: z.array(z.object({ size_id: idParam, color_id: idParam, qty: z.coerce.number().int().min(0).max(10_000_000) })).max(2000),
    })
    .parse(req.body);
  const rows = items.filter((i) => i.qty > 0);
  const seen = new Set<string>();
  for (const i of rows) {
    const k = `${i.size_id}:${i.color_id}`;
    if (seen.has(k)) throw badRequest('Bir xil razmer va rang ikki marta berilgan');
    seen.add(k);
  }
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    assertDraft(ctx, o);
    const old = (await db.query('SELECT size_id, color_id, qty FROM order_items WHERE order_id = $1 ORDER BY size_id, color_id', [id])).rows;
    // Jadvaldan olib tashlangan rang uchun xomashyo qatorlari bo'lsa — avval ularni o'chirish kerak
    const colors = new Set(rows.map((r) => r.color_id));
    const orphan = (
      await db.query(
        `SELECT DISTINCT c.name FROM order_materials m JOIN colors c ON c.id = m.color_id WHERE m.order_id = $1 AND NOT (m.color_id = ANY($2::int[]))`,
        [id, [...colors]],
      )
    ).rows.map((r) => r.name);
    if (orphan.length) {
      throw conflict(`Bu ranglar uchun xomashyo normasi bor: ${orphan.join(', ')}. Rangni jadvaldan olib tashlashdan oldin uning xomashyo qatorlarini o'chiring`);
    }
    await db.query('DELETE FROM order_items WHERE order_id = $1', [id]);
    for (const i of rows) {
      await db.query('INSERT INTO order_items (order_id, size_id, color_id, qty) VALUES ($1, $2, $3, $4)', [id, i.size_id, i.color_id, i.qty]);
    }
    const d = await orderDetail(db, id);
    await audit(db, ctx, 'order', id, 'items', old, rows);
    return d;
  });
  res.json(data);
});

// ---------- Xomashyo normasi ----------
const materialBody = z.object({
  material_id: idParam,
  supplier_id: idParam.nullish(),
  material_color_id: idParam.nullish(),
  color_code: optText(30),
  material_size: optText(30),
  per_unit: decimal.positive().max(1e6),
  price: decimal.min(0).max(1e12).default(0),
  currency: CURRENCY.default('UZS'),
  rate: decimal.positive().max(1e9).nullish(),
  from_us: z.boolean().default(true),
  is_main: z.boolean().default(false),
  note: optText(300),
});

/** Har rangda bitta asosiy mato. */
async function assertNoOtherMain(db: Db, orderId: number, colorIds: number[], exceptId?: number) {
  const r = (
    await db.query(
      `SELECT c.name FROM order_materials m JOIN colors c ON c.id = m.color_id
        WHERE m.order_id = $1 AND m.is_main AND m.color_id = ANY($2::int[]) AND ($3::int IS NULL OR m.id <> $3)`,
      [orderId, colorIds, exceptId ?? null],
    )
  ).rows.map((x) => x.name);
  if (r.length) throw badRequest(`Bu ranglarda asosiy mato allaqachon bor: ${r.join(', ')}`);
}

/** Kurs berilmasa — zakaz sanasidagi kurs; so'm uchun 1. */
async function resolveRate(db: Db, currency: string, rate: number | null | undefined, orderDate: string) {
  if (currency === 'UZS') return 1;
  if (rate) return rate;
  const r = (await db.query('SELECT rate_at($1, $2::date) AS r', [currency, orderDate])).rows[0].r;
  if (r == null) throw badRequest(`${currency} uchun ${orderDate} sanasiga kurs kiritilmagan — kursni yozing yoki Valyuta kurslariga qo'shing`);
  return Number(r);
}

/** Bir xomashyo bir nechta rangdagi mahsulot uchun birdan qo'shiladi (har rangga alohida qator). */
ordersRouter.post('/:id/materials', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = materialBody.extend({ color_ids: z.array(idParam).min(1).max(100) }).parse(req.body);
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    assertDraft(ctx, o);
    const inMatrix = new Set(
      (await db.query('SELECT DISTINCT color_id FROM order_items WHERE order_id = $1', [id])).rows.map((r) => r.color_id as number),
    );
    const colorIds = [...new Set(b.color_ids)];
    if (colorIds.some((c) => !inMatrix.has(c))) throw badRequest('Xomashyo faqat jadvaldagi (razmer × rang) ranglar uchun qo\'shiladi');
    const mat = (await db.query('SELECT id, supplier_id FROM materials WHERE id = $1', [b.material_id])).rows[0];
    if (!mat) throw notFound('Xomashyo');
    const rate = await resolveRate(db, b.currency, b.rate, o.order_date);
    if (b.is_main) await assertNoOtherMain(db, id, colorIds);
    const created = [];
    for (const colorId of colorIds) {
      const sort = (await db.query('SELECT coalesce(max(sort), 0) + 1 AS s FROM order_materials WHERE order_id = $1 AND color_id = $2', [id, colorId]))
        .rows[0].s;
      const r = (
        await db.query(
          `INSERT INTO order_materials (order_id, color_id, material_id, supplier_id, material_color_id, color_code, material_size,
                                        per_unit, price, currency, rate, from_us, note, sort, is_main)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [
            id,
            colorId,
            b.material_id,
            b.supplier_id ?? mat.supplier_id ?? null,
            b.material_color_id ?? null,
            b.color_code,
            b.material_size,
            b.per_unit,
            b.price,
            b.currency,
            rate,
            b.from_us,
            b.note,
            sort,
            b.is_main,
          ],
        )
      ).rows[0];
      created.push(r);
    }
    await audit(db, ctx, 'order', id, 'materials_add', undefined, created);
    return orderDetail(db, id);
  });
  res.status(201).json(data);
});

ordersRouter.patch('/:id/materials/:mid', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const mid = idParam.parse(req.params.mid);
  const b = materialBody.partial().parse(req.body);
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    assertDraft(ctx, o);
    const old = (await db.query('SELECT * FROM order_materials WHERE id = $1 AND order_id = $2', [mid, id])).rows[0];
    if (!old) throw notFound('Xomashyo qatori');
    const currency = b.currency ?? old.currency;
    // valyuta o'zgarsa va kurs berilmasa — yangi valyuta kursi olinadi
    const rate = b.rate != null || b.currency !== undefined ? await resolveRate(db, currency, b.rate, o.order_date) : Number(old.rate);
    const v = { ...old, ...Object.fromEntries(Object.entries(b).filter(([, x]) => x !== undefined)), currency, rate };
    if (v.is_main) await assertNoOtherMain(db, id, [old.color_id], mid);
    await db.query(
      `UPDATE order_materials SET material_id = $2, supplier_id = $3, material_color_id = $4, color_code = $5, material_size = $6,
              per_unit = $7, price = $8, currency = $9, rate = $10, from_us = $11, note = $12, is_main = $13 WHERE id = $1`,
      [mid, v.material_id, v.supplier_id, v.material_color_id, v.color_code, v.material_size, v.per_unit, v.price, v.currency, v.rate, v.from_us, v.note, v.is_main],
    );
    const now = (await db.query('SELECT * FROM order_materials WHERE id = $1', [mid])).rows[0];
    await audit(db, ctx, 'order', id, 'material_update', old, now);
    return orderDetail(db, id);
  });
  res.json(data);
});

ordersRouter.delete('/:id/materials/:mid', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const mid = idParam.parse(req.params.mid);
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    assertDraft(ctx, o);
    const old = (await db.query('DELETE FROM order_materials WHERE id = $1 AND order_id = $2 RETURNING *', [mid, id])).rows[0];
    if (!old) throw notFound('Xomashyo qatori');
    await audit(db, ctx, 'order', id, 'material_delete', old);
    return orderDetail(db, id);
  });
  res.json(data);
});

/** Bir rangdagi barcha xomashyo qatorlarini boshqa rang(lar)ga nusxalash (keyin farqlari tahrirlanadi). */
ordersRouter.post('/:id/materials/copy', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = z.object({ from_color_id: idParam, to_color_ids: z.array(idParam).min(1).max(100) }).parse(req.body);
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    assertDraft(ctx, o);
    const inMatrix = new Set(
      (await db.query('SELECT DISTINCT color_id FROM order_items WHERE order_id = $1', [id])).rows.map((r) => r.color_id as number),
    );
    const targets = [...new Set(b.to_color_ids)].filter((c) => c !== b.from_color_id);
    if (!targets.length || targets.some((c) => !inMatrix.has(c))) throw badRequest('Nusxa faqat jadvaldagi boshqa ranglarga olinadi');
    const src = (await db.query('SELECT * FROM order_materials WHERE order_id = $1 AND color_id = $2 ORDER BY sort, id', [id, b.from_color_id])).rows;
    if (!src.length) throw badRequest('Tanlangan rangda xomashyo qatorlari yo\'q');
    let n = 0;
    for (const to of targets) {
      const base = (await db.query('SELECT coalesce(max(sort), 0) AS s FROM order_materials WHERE order_id = $1 AND color_id = $2', [id, to])).rows[0].s;
      const hasMain = !!(await db.query('SELECT 1 FROM order_materials WHERE order_id = $1 AND color_id = $2 AND is_main', [id, to])).rowCount;
      for (const [i, m] of src.entries()) {
        await db.query(
          `INSERT INTO order_materials (order_id, color_id, material_id, supplier_id, material_color_id, color_code, material_size,
                                        per_unit, price, currency, rate, from_us, note, sort, is_main)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [id, to, m.material_id, m.supplier_id, m.material_color_id, m.color_code, m.material_size, m.per_unit, m.price, m.currency, m.rate, m.from_us, m.note, base + i + 1, m.is_main && !hasMain],
        );
        n++;
      }
    }
    await audit(db, ctx, 'order', id, 'materials_copy', undefined, { ...b, rows: n });
    return orderDetail(db, id);
  });
  res.status(201).json(data);
});

// ---------- Ish narxlari (to'liq almashtiriladi) ----------
ordersRouter.put('/:id/works', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const { works } = z
    .object({ works: z.array(z.object({ producer_id: idParam, price: decimal.min(0).max(1e9), note: optText(300) })).max(50) })
    .parse(req.body);
  if (new Set(works.map((w) => w.producer_id)).size !== works.length) throw badRequest('Bir korxona ikki marta berilgan');
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    assertDraft(ctx, o);
    const old = (await db.query('SELECT producer_id, price, note FROM order_works WHERE order_id = $1 ORDER BY producer_id', [id])).rows;
    await db.query('DELETE FROM order_works WHERE order_id = $1', [id]);
    for (const w of works) {
      await db.query('INSERT INTO order_works (order_id, producer_id, price, note) VALUES ($1, $2, $3, $4)', [id, w.producer_id, w.price, w.note]);
    }
    await audit(db, ctx, 'order', id, 'works', old, works);
    return orderDetail(db, id);
  });
  res.json(data);
});

/** Ta'minot buyurtmasi berilgan zakazni o'zgartirib bo'lmaydi (avval buyurtmalarni bekor qilish kerak). */
async function assertNoPurchases(db: Db, orderId: number) {
  const n = (await db.query("SELECT count(*) AS n FROM purchase_orders WHERE order_id = $1 AND status <> 'cancelled'", [orderId])).rows[0].n;
  if (n > 0) throw conflict(`Bu zakaz bo'yicha ${n} ta ta'minot buyurtmasi bor — avval ularni bekor qiling`);
}

// ---------- Holat ----------
ordersRouter.post('/:id/confirm', requireAction('orders.confirm'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    if (o.status !== 'draft') throw conflict('Faqat qoralama tasdiqlanadi');
    const d = await orderDetail(db, id);
    if (!d.items.length) throw badRequest('Razmer × rang jadvaliga miqdor kiriting');
    const missing = d.by_color.filter((c) => !d.materials.some((m) => m.color_id === c.color_id)).map((c) => c.color_name);
    if (missing.length) throw badRequest(`Xomashyo normasi kiritilmagan ranglar: ${missing.join(', ')}`);
    await db.query(`UPDATE orders SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1`, [id, ctx.userId]);
    await audit(db, ctx, 'order', id, 'confirm', { status: 'draft' }, { status: 'confirmed', totals: d.totals });
    return orderDetail(db, id);
  });
  res.json(data);
});

ordersRouter.post('/:id/reopen', requireAction('orders.reopen'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    if (o.status === 'draft') throw conflict('Zakaz allaqachon qoralama');
    await assertNoPurchases(db, id);
    await db.query(`UPDATE orders SET status = 'draft', confirmed_by = NULL, confirmed_at = NULL WHERE id = $1`, [id]);
    await audit(db, ctx, 'order', id, 'reopen', { status: o.status }, { status: 'draft' });
    return orderDetail(db, id);
  });
  res.json(data);
});

ordersRouter.post('/:id/cancel', requireAction('orders.reopen'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    if (o.status === 'cancelled') throw conflict('Zakaz allaqachon bekor qilingan');
    await assertNoPurchases(db, id);
    await db.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [id]);
    await audit(db, ctx, 'order', id, 'cancel', { status: o.status }, { status: 'cancelled' });
    return orderDetail(db, id);
  });
  res.json(data);
});
