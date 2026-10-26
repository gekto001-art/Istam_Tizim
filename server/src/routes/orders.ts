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
  // Har qator: tayyor mahsulot soni (razmer × rang yoki rangning barcha razmerlari) × sarf = umumiy miqdor
  const materials = (
    await db.query(
      `WITH lq AS (SELECT m.id, order_material_qty(m.order_id, m.color_id, m.size_id, false) AS pq FROM order_materials m WHERE m.order_id = $1)
       SELECT m.*, c.name AS color_name, sz.name AS size_name, mt.name AS material_name, mt.code AS material_code, mt.unit,
              s.name AS supplier_name, mc.name AS material_color_name,
              lq.pq AS product_qty,
              round(m.per_unit * m.price, 4) AS unit_amount,
              round(lq.pq * m.per_unit, 3) AS total_qty,
              round(lq.pq * m.per_unit * m.price, 2) AS total_amount,
              round(lq.pq * m.per_unit * m.price * m.rate, 2) AS total_uzs,
              round(m.per_unit * m.price * m.rate, 2) AS unit_cost_uzs
         FROM order_materials m
         JOIN lq ON lq.id = m.id
         JOIN colors c ON c.id = m.color_id
         LEFT JOIN sizes sz ON sz.id = m.size_id
         JOIN materials mt ON mt.id = m.material_id
         LEFT JOIN suppliers s ON s.id = m.supplier_id
         LEFT JOIN colors mc ON mc.id = m.material_color_id
        WHERE m.order_id = $1
        ORDER BY m.sort, m.id`,
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
  // Rang bo'yicha tannarx (reja): xomashyo jami ÷ soni (razmerlar farq qilsa — o'rtacha) + ish
  const byColor = (
    await db.query(
      `WITH cq AS (SELECT color_id, sum(qty) AS qty, sum(actual_qty) AS actual_qty, bool_and(actual_qty IS NOT NULL) AS has_actual
                   FROM order_items WHERE order_id = $1 GROUP BY color_id),
            mat AS (SELECT color_id, sum(round(order_material_qty(order_id, color_id, size_id, false) * per_unit * price * rate, 2)) AS total
                      FROM order_materials WHERE order_id = $1 GROUP BY color_id),
            wk AS (SELECT coalesce(sum(price), 0) AS unit_cost FROM order_works WHERE order_id = $1)
       SELECT cq.color_id, c.name AS color_name, cq.qty, CASE WHEN cq.has_actual THEN cq.actual_qty END AS actual_qty,
              round(coalesce(mat.total, 0) / nullif(cq.qty, 0), 2) AS material_cost, wk.unit_cost AS work_cost,
              round(coalesce(mat.total, 0) / nullif(cq.qty, 0), 2) + wk.unit_cost AS unit_cost,
              round(coalesce(mat.total, 0) + cq.qty * wk.unit_cost, 2) AS total_cost
         FROM cq JOIN colors c ON c.id = cq.color_id LEFT JOIN mat ON mat.color_id = cq.color_id CROSS JOIN wk
        ORDER BY lower(c.name)`,
      [id],
    )
  ).rows;
  // Kerakli xomashyo jami (barcha razmer va ranglar bo'yicha yig'ilgan) — ta'minotga ketadigan ro'yxat
  const needs = (
    await db.query(
      `SELECT m.material_id, mt.name AS material_name, mt.code AS material_code, mt.unit,
              m.supplier_id, s.name AS supplier_name, m.material_color_id, mc.name AS material_color_name,
              m.color_code, m.material_size, m.price, m.currency, m.rate, m.from_us, m.is_main,
              round(sum(order_material_qty(m.order_id, m.color_id, m.size_id, false) * m.per_unit), 3) AS total_qty,
              round(sum(order_material_qty(m.order_id, m.color_id, m.size_id, false) * m.per_unit * m.price), 2) AS total_amount,
              round(sum(order_material_qty(m.order_id, m.color_id, m.size_id, false) * m.per_unit * m.price * m.rate), 2) AS total_uzs,
              string_agg(DISTINCT c.name, ', ') AS for_colors
         FROM order_materials m
         JOIN materials mt ON mt.id = m.material_id
         JOIN colors c ON c.id = m.color_id
         LEFT JOIN suppliers s ON s.id = m.supplier_id
         LEFT JOIN colors mc ON mc.id = m.material_color_id
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
              (SELECT coalesce(sum(round(order_material_qty(order_id, color_id, size_id, false) * per_unit * price * rate, 2)), 0)
                 FROM order_materials WHERE order_id = $1) AS material_uzs,
              (SELECT coalesce(sum(qty), 0) FROM order_items WHERE order_id = $1)
                * (SELECT coalesce(sum(price), 0) FROM order_works WHERE order_id = $1) AS work_uzs`,
      [id],
    )
  ).rows[0];
  const warnings = materialWarnings(items, materials);
  if (!works.length) warnings.push('Ish narxlari (kroy, tikuv) kiritilmagan');
  return { order, items, materials, works, by_color: byColor, needs, totals, warnings };
}

type VariantItem = { size_id: number; color_id: number; size_name: string; color_name: string };
type LineRef = { color_id: number; size_id: number | null; is_main: boolean };

/** Razmer × rang bo'yicha tekshiruv: har katak xomashyo bilan qoplanganmi, jadvalda yo'q katak uchun qator yo'qmi. */
function materialWarnings(items: VariantItem[], materials: LineRef[]) {
  const warnings: string[] = [];
  if (!items.length) {
    warnings.push('Razmer × rang jadvaliga miqdor kiritilmagan');
    return warnings;
  }
  const covers = (m: LineRef, i: VariantItem) => m.color_id === i.color_id && (m.size_id == null || m.size_id === i.size_id);
  const bare = items.filter((i) => !materials.some((m) => covers(m, i)));
  if (bare.length) warnings.push(`Xomashyo kiritilmagan: ${bare.map((i) => `${i.size_name} ${i.color_name}`).join(', ')}`);
  if (materials.some((m) => !items.some((i) => covers(m, i)))) warnings.push('Jadvalda yo\'q razmer/rang uchun xomashyo qatorlari bor');
  const noMain = items.filter((i) => materials.some((m) => covers(m, i)) && !materials.some((m) => m.is_main && covers(m, i)));
  if (noMain.length) {
    warnings.push(
      `Asosiy mato belgilanmagan: ${noMain.map((i) => `${i.size_name} ${i.color_name}`).join(', ')} — ularning soni fakt matoga qarab o'zgarmaydi`,
    );
  }
  return warnings;
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
    // Jadvaldan olib tashlangan razmer/rang uchun xomashyo qatorlari bo'lsa — avval ularni o'chirish kerak
    const lines = (
      await db.query(
        `SELECT DISTINCT m.color_id, m.size_id, c.name AS color_name, s.name AS size_name
           FROM order_materials m JOIN colors c ON c.id = m.color_id LEFT JOIN sizes s ON s.id = m.size_id WHERE m.order_id = $1`,
        [id],
      )
    ).rows;
    const orphan = lines.filter((m) => !rows.some((r) => r.color_id === m.color_id && (m.size_id == null || r.size_id === m.size_id)));
    if (orphan.length) {
      const names = orphan.map((m) => (m.size_name ? `${m.size_name} ${m.color_name}` : m.color_name)).join(', ');
      throw conflict(`Bular uchun xomashyo qatorlari bor: ${names}. Jadvaldan olib tashlashdan oldin ularning xomashyo qatorlarini o'chiring`);
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

// ---------- Xomashyo normasi (Sheets "Zakazlar" jadvali: har qator — tayyor mahsulot razmeri × rangi uchun) ----------
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

type Variant = { color_id: number; size_id: number | null };
type Matrix = { color_id: number; size_id: number; color_name: string; size_name: string }[];

async function matrixOf(db: Db, orderId: number): Promise<Matrix> {
  return (
    await db.query(
      `SELECT i.color_id, i.size_id, c.name AS color_name, s.name AS size_name
         FROM order_items i JOIN colors c ON c.id = i.color_id JOIN sizes s ON s.id = i.size_id WHERE i.order_id = $1
        ORDER BY lower(c.name), s.sort, s.id`,
      [orderId],
    )
  ).rows;
}

/** Qator jadvaldagi katakka (yoki rangga — razmer "hammasi") mos kelishi kerak. */
function assertInMatrix(matrix: Matrix, v: Variant) {
  const ok = matrix.some((i) => i.color_id === v.color_id && (v.size_id == null || i.size_id === v.size_id));
  if (!ok) throw badRequest('Xomashyo faqat razmer × rang jadvalidagi kataklar uchun kiritiladi');
}

/**
 * Asosiy mato: har katakda (razmer × rang) ko'pi bilan bitta. Rang bo'yicha umumiy ("hammasi") asosiy mato
 * shu rangning barcha razmerlarini qoplaydi.
 */
function assertMainUnique(matrix: Matrix, mains: Variant[]) {
  for (const cell of matrix) {
    const n = mains.filter((m) => m.color_id === cell.color_id && (m.size_id == null || m.size_id === cell.size_id)).length;
    if (n > 1) throw badRequest(`${cell.size_name} ${cell.color_name} uchun asosiy mato bittadan ortiq`);
  }
}

async function mainsOf(db: Db, orderId: number, exceptIds: number[] = []): Promise<Variant[]> {
  return (
    await db.query('SELECT color_id, size_id FROM order_materials WHERE order_id = $1 AND is_main AND NOT (id = ANY($2::int[]))', [orderId, exceptIds])
  ).rows;
}

/** Kurs berilmasa — zakaz sanasidagi kurs; so'm uchun 1. */
async function resolveRate(db: Db, currency: string, rate: number | null | undefined, orderDate: string) {
  if (currency === 'UZS') return 1;
  if (rate) return rate;
  const r = (await db.query('SELECT rate_at($1, $2::date) AS r', [currency, orderDate])).rows[0].r;
  if (r == null) throw badRequest(`${currency} uchun ${orderDate} sanasiga kurs kiritilmagan — kursni yozing yoki Valyuta kurslariga qo'shing`);
  return Number(r);
}

const INSERT_LINE = `INSERT INTO order_materials (order_id, color_id, size_id, material_id, supplier_id, material_color_id, color_code, material_size,
                                    per_unit, price, currency, rate, from_us, note, sort, is_main)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`;

/** Bir xomashyo bir nechta rang uchun birdan qo'shiladi (har rangga alohida qator); size_id berilsa — faqat shu razmer. */
ordersRouter.post('/:id/materials', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = materialBody.extend({ color_ids: z.array(idParam).min(1).max(100), size_id: idParam.nullish() }).parse(req.body);
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    assertDraft(ctx, o);
    const matrix = await matrixOf(db, id);
    const colorIds = [...new Set(b.color_ids)];
    for (const c of colorIds) assertInMatrix(matrix, { color_id: c, size_id: b.size_id ?? null });
    const mat = (await db.query('SELECT id, supplier_id FROM materials WHERE id = $1', [b.material_id])).rows[0];
    if (!mat) throw notFound('Xomashyo');
    const rate = await resolveRate(db, b.currency, b.rate, o.order_date);
    if (b.is_main) assertMainUnique(matrix, [...(await mainsOf(db, id)), ...colorIds.map((c) => ({ color_id: c, size_id: b.size_id ?? null }))]);
    const created = [];
    for (const colorId of colorIds) {
      const sort = (await db.query('SELECT coalesce(max(sort), 0) + 1 AS s FROM order_materials WHERE order_id = $1', [id])).rows[0].s;
      const r = (
        await db.query(INSERT_LINE, [
          id,
          colorId,
          b.size_id ?? null,
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
        ])
      ).rows[0];
      created.push(r);
    }
    await audit(db, ctx, 'order', id, 'materials_add', undefined, created);
    return orderDetail(db, id);
  });
  res.status(201).json(data);
});

/**
 * Butun jadvalni saqlash (Sheets'dagidek qatorlar bir joyda tahrirlanadi):
 * id bor qator yangilanadi, id siz — qo'shiladi, ro'yxatda yo'q eski qatorlar o'chiriladi. Tartib — ro'yxat tartibi.
 */
ordersRouter.put('/:id/materials', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const { lines } = z
    .object({ lines: z.array(materialBody.extend({ id: idParam.optional(), color_id: idParam, size_id: idParam.nullish() })).max(2000) })
    .parse(req.body);
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    assertDraft(ctx, o);
    const matrix = await matrixOf(db, id);
    for (const l of lines) assertInMatrix(matrix, { color_id: l.color_id, size_id: l.size_id ?? null });
    assertMainUnique(
      matrix,
      lines.filter((l) => l.is_main).map((l) => ({ color_id: l.color_id, size_id: l.size_id ?? null })),
    );
    const old = (await db.query('SELECT * FROM order_materials WHERE order_id = $1 ORDER BY sort, id', [id])).rows;
    const oldIds = new Set(old.map((x) => x.id as number));
    for (const l of lines) if (l.id != null && !oldIds.has(l.id)) throw notFound('Xomashyo qatori');
    const keep = new Set(lines.filter((l) => l.id != null).map((l) => l.id));
    await db.query('DELETE FROM order_materials WHERE order_id = $1 AND NOT (id = ANY($2::int[]))', [id, [...keep]]);
    // asosiy mato belgilari almashganda unikal indeks to'qnashmasligi uchun avval olib qo'yiladi
    await db.query('UPDATE order_materials SET is_main = false WHERE order_id = $1', [id]);
    const supplierOf = new Map(
      (await db.query('SELECT id, supplier_id FROM materials WHERE id = ANY($1::int[])', [[...new Set(lines.map((l) => l.material_id))]])).rows.map((r) => [
        r.id as number,
        r.supplier_id as number | null,
      ]),
    );
    for (const [i, l] of lines.entries()) {
      if (!supplierOf.has(l.material_id)) throw notFound('Xomashyo');
      const rate = await resolveRate(db, l.currency, l.rate, o.order_date);
      const v = [
        l.color_id,
        l.size_id ?? null,
        l.material_id,
        l.supplier_id ?? supplierOf.get(l.material_id) ?? null,
        l.material_color_id ?? null,
        l.color_code,
        l.material_size,
        l.per_unit,
        l.price,
        l.currency,
        rate,
        l.from_us,
        l.note,
        i + 1,
        l.is_main,
      ];
      if (l.id != null) {
        await db.query(
          `UPDATE order_materials SET color_id = $2, size_id = $3, material_id = $4, supplier_id = $5, material_color_id = $6, color_code = $7,
                  material_size = $8, per_unit = $9, price = $10, currency = $11, rate = $12, from_us = $13, note = $14, sort = $15, is_main = $16
            WHERE id = $1`,
          [l.id, ...v],
        );
      } else {
        await db.query(INSERT_LINE, [id, ...v]);
      }
    }
    const now = (await db.query('SELECT * FROM order_materials WHERE order_id = $1 ORDER BY sort, id', [id])).rows;
    await audit(db, ctx, 'order', id, 'materials', old, now);
    return orderDetail(db, id);
  });
  res.json(data);
});

ordersRouter.patch('/:id/materials/:mid', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const mid = idParam.parse(req.params.mid);
  const b = materialBody.extend({ size_id: idParam.nullish() }).partial().parse(req.body);
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    assertDraft(ctx, o);
    const old = (await db.query('SELECT * FROM order_materials WHERE id = $1 AND order_id = $2', [mid, id])).rows[0];
    if (!old) throw notFound('Xomashyo qatori');
    const currency = b.currency ?? old.currency;
    // valyuta o'zgarsa va kurs berilmasa — yangi valyuta kursi olinadi
    const rate = b.rate != null || b.currency !== undefined ? await resolveRate(db, currency, b.rate, o.order_date) : Number(old.rate);
    const v = { ...old, ...Object.fromEntries(Object.entries(b).filter(([, x]) => x !== undefined)), currency, rate };
    const matrix = await matrixOf(db, id);
    assertInMatrix(matrix, { color_id: v.color_id, size_id: v.size_id ?? null });
    if (v.is_main) assertMainUnique(matrix, [...(await mainsOf(db, id, [mid])), { color_id: v.color_id, size_id: v.size_id ?? null }]);
    await db.query(
      `UPDATE order_materials SET material_id = $2, supplier_id = $3, material_color_id = $4, color_code = $5, material_size = $6,
              per_unit = $7, price = $8, currency = $9, rate = $10, from_us = $11, note = $12, is_main = $13, size_id = $14 WHERE id = $1`,
      [mid, v.material_id, v.supplier_id, v.material_color_id, v.color_code, v.material_size, v.per_unit, v.price, v.currency, v.rate, v.from_us, v.note, v.is_main, v.size_id ?? null],
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

/** Bir rangdagi barcha xomashyo qatorlarini boshqa rang(lar)ga nusxalash (razmer saqlanadi; keyin farqlari tahrirlanadi). */
ordersRouter.post('/:id/materials/copy', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = z.object({ from_color_id: idParam, to_color_ids: z.array(idParam).min(1).max(100) }).parse(req.body);
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    assertDraft(ctx, o);
    const matrix = await matrixOf(db, id);
    const targets = [...new Set(b.to_color_ids)].filter((c) => c !== b.from_color_id);
    if (!targets.length || targets.some((c) => !matrix.some((i) => i.color_id === c))) throw badRequest('Nusxa faqat jadvaldagi boshqa ranglarga olinadi');
    const src = (await db.query('SELECT * FROM order_materials WHERE order_id = $1 AND color_id = $2 ORDER BY sort, id', [id, b.from_color_id])).rows;
    if (!src.length) throw badRequest('Tanlangan rangda xomashyo qatorlari yo\'q');
    let n = 0;
    let sort = (await db.query('SELECT coalesce(max(sort), 0) AS s FROM order_materials WHERE order_id = $1', [id])).rows[0].s;
    const mains = await mainsOf(db, id);
    for (const to of targets) {
      for (const m of src) {
        // nusxa faqat shu rangda mavjud razmerlarga; asosiy belgisi to'qnashsa — oddiy qator bo'ladi
        if (m.size_id != null && !matrix.some((i) => i.color_id === to && i.size_id === m.size_id)) continue;
        const v = { color_id: to, size_id: m.size_id as number | null };
        let main = !!m.is_main;
        if (main) {
          try {
            assertMainUnique(matrix, [...mains, v]);
            mains.push(v);
          } catch {
            main = false;
          }
        }
        await db.query(INSERT_LINE, [
          id, to, m.size_id, m.material_id, m.supplier_id, m.material_color_id, m.color_code, m.material_size,
          m.per_unit, m.price, m.currency, m.rate, m.from_us, m.note, ++sort, main,
        ]);
        n++;
      }
    }
    await audit(db, ctx, 'order', id, 'materials_copy', undefined, { ...b, rows: n });
    return orderDetail(db, id);
  });
  res.status(201).json(data);
});

// ---------- Oldingi zakazdan olish (bir xil model qayta tikilganda) ----------
/**
 * Manba zakazdan qoralamaga ko'chirish: sarlavha (tovar, artikul, model, mavsum, korxona), razmer × rang jadvali,
 * xomashyo normasi (ranglar mosligi bilan; mato rangi yangi rangga moslashadi; kurs yangi zakaz sanasidan) va ish narxlari.
 */
ordersRouter.post('/:id/copy-from', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = z
    .object({
      source_id: idParam,
      header: z.boolean().default(false),
      items: z.boolean().default(false),
      materials: z.boolean().default(true),
      works: z.boolean().default(true),
      replace_materials: z.boolean().default(true),
      adapt_color: z.boolean().default(true),
      // yangi zakazdagi rang ← manbadagi qaysi rangning normasi (berilmasa — o'sha rangning o'zi)
      color_map: z.array(z.object({ target_color_id: idParam, source_color_id: idParam.nullable() })).max(100).default([]),
    })
    .parse(req.body);
  if (b.source_id === id) throw badRequest('Zakazni o\'zidan nusxalab bo\'lmaydi');
  if (!b.header && !b.items && !b.materials && !b.works) throw badRequest('Nimani olishni belgilang');
  const data = await tx(async (db) => {
    const o = await orderOf(db, id, true);
    assertDraft(ctx, o);
    const src = await orderOf(db, b.source_id);
    const result = { lines: 0, skipped: 0, works: 0, items: 0 };

    if (b.header) {
      await db.query(
        `UPDATE orders SET product_type_id = $2, artikul = $3, model = $4, season = $5, producer_id = $6, ordered_by = $7, unit = $8 WHERE id = $1`,
        [id, src.product_type_id, src.artikul, src.model, src.season, src.producer_id, src.ordered_by, src.unit],
      );
    }
    if (b.materials && b.replace_materials) await db.query('DELETE FROM order_materials WHERE order_id = $1', [id]);
    if (b.items) {
      const left = (await db.query('SELECT count(*) AS n FROM order_materials WHERE order_id = $1', [id])).rows[0].n;
      if (left > 0) throw conflict('Jadvalni almashtirish uchun mavjud xomashyo qatorlari ham almashtirilishi kerak');
      await db.query('DELETE FROM order_items WHERE order_id = $1', [id]);
      const r = await db.query(
        'INSERT INTO order_items (order_id, size_id, color_id, qty) SELECT $1, size_id, color_id, qty FROM order_items WHERE order_id = $2',
        [id, b.source_id],
      );
      result.items = r.rowCount ?? 0;
    }
    if (b.materials) {
      const matrix = await matrixOf(db, id);
      if (!matrix.length) throw badRequest('Avval razmer × rang jadvalini to\'ldiring (yoki jadvalni ham ko\'chiring)');
      const srcLines = (await db.query('SELECT * FROM order_materials WHERE order_id = $1 ORDER BY sort, id', [b.source_id])).rows;
      const srcColors = new Set(srcLines.map((l) => l.color_id as number));
      const mapped = new Map(b.color_map.map((m) => [m.target_color_id, m.source_color_id]));
      const mains = await mainsOf(db, id);
      let sort = (await db.query('SELECT coalesce(max(sort), 0) AS s FROM order_materials WHERE order_id = $1', [id])).rows[0].s;
      const rateCache = new Map<string, number | null>();
      const rateOf = async (cur: string) => {
        if (cur === 'UZS') return 1;
        if (!rateCache.has(cur)) {
          const r = (await db.query('SELECT rate_at($1, $2::date) AS r', [cur, o.order_date])).rows[0].r;
          rateCache.set(cur, r == null ? null : Number(r));
        }
        return rateCache.get(cur);
      };
      for (const tc of [...new Set(matrix.map((m) => m.color_id))]) {
        const sc = mapped.has(tc) ? mapped.get(tc) : srcColors.has(tc) ? tc : null;
        if (sc == null) continue;
        for (const l of srcLines.filter((x) => x.color_id === sc)) {
          // razmerga bog'langan qator — faqat yangi zakazda shu rangda shu razmer bo'lsa
          if (l.size_id != null && !matrix.some((m) => m.color_id === tc && m.size_id === l.size_id)) {
            result.skipped++;
            continue;
          }
          const v = { color_id: tc, size_id: l.size_id as number | null };
          let main = !!l.is_main;
          if (main) {
            try {
              assertMainUnique(matrix, [...mains, v]);
              mains.push(v);
            } catch {
              main = false;
            }
          }
          const materialColor = b.adapt_color && l.material_color_id === sc ? tc : l.material_color_id;
          await db.query(INSERT_LINE, [
            id, tc, l.size_id, l.material_id, l.supplier_id, materialColor, l.color_code, l.material_size,
            l.per_unit, l.price, l.currency, (await rateOf(l.currency)) ?? l.rate, l.from_us, l.note, ++sort, main,
          ]);
          result.lines++;
        }
      }
    }
    if (b.works) {
      await db.query('DELETE FROM order_works WHERE order_id = $1', [id]);
      const r = await db.query(
        'INSERT INTO order_works (order_id, producer_id, price, note) SELECT $1, producer_id, price, note FROM order_works WHERE order_id = $2',
        [id, b.source_id],
      );
      result.works = r.rowCount ?? 0;
    }
    await audit(db, ctx, 'order', id, 'copy_from', undefined, { source_id: b.source_id, partiya_no: src.partiya_no, ...result });
    return { ...(await orderDetail(db, id)), copy: result };
  });
  res.json(data);
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
  const n = (
    await db.query(
      "SELECT count(*) AS n FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE p.order_id = $1 AND l.status <> 'cancelled'",
      [orderId],
    )
  ).rows[0].n;
  if (n > 0) throw conflict(`Bu zakaz bo'yicha ${n} ta ta'minot buyurtma qatori bor — avval ularni bekor qiling`);
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
    const bare = d.warnings.find((w) => w.startsWith('Xomashyo kiritilmagan'));
    if (bare) throw badRequest(bare);
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
