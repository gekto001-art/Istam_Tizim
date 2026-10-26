import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { decimal, idParam, optText } from '../lib/util.js';
import { AGREED, createPurchases, recomputeActuals, supplyPlan } from '../services/supply.js';

/**
 * Ta'minot: xomashyo zakazi (mato → furnitura) va postavshik kelishuvi (nakladnoy).
 * Sheets "Zakaz&Tracking": Xomashyo Zakaz, Postavshik Kelishuv.
 */
export const purchasesRouter = Router();
purchasesRouter.use(requireAction('purchase.read'));

// ---------- Xomashyo zakazi: tasdiqlangan zakazlar va ta'minot holati ----------
purchasesRouter.get('/orders', async (_req, res) => {
  const rows = (
    await pool.query(
      `SELECT o.id, o.partiya_no, o.order_date, o.artikul, o.model, pt.name AS product_type_name, p.name AS producer_name,
              (SELECT coalesce(sum(qty), 0) FROM order_items i WHERE i.order_id = o.id) AS plan_qty,
              (SELECT sum(actual_qty) FROM order_items i WHERE i.order_id = o.id HAVING bool_and(actual_qty IS NOT NULL)) AS actual_qty,
              (SELECT count(*) FROM purchase_orders x WHERE x.order_id = o.id AND x.stage = 'mato' AND x.status <> 'cancelled') AS mato_pos,
              (SELECT count(*) FROM purchase_orders x WHERE x.order_id = o.id AND x.stage = 'mato' AND x.status = ANY($1::text[])) AS mato_agreed,
              (SELECT count(*) FROM purchase_orders x WHERE x.order_id = o.id AND x.stage = 'furnitura' AND x.status <> 'cancelled') AS furnitura_pos,
              (SELECT count(*) FROM purchase_orders x WHERE x.order_id = o.id AND x.stage = 'furnitura' AND x.status = ANY($1::text[])) AS furnitura_agreed
         FROM orders o JOIN product_types pt ON pt.id = o.product_type_id LEFT JOIN producers p ON p.id = o.producer_id
        WHERE o.status = 'confirmed'
        ORDER BY o.order_date DESC, o.id DESC LIMIT 500`,
      [AGREED],
    )
  ).rows;
  res.json(rows);
});

purchasesRouter.get('/orders/:orderId', async (req, res) => {
  const orderId = idParam.parse(req.params.orderId);
  res.json(await tx((db) => supplyPlan(db, orderId)));
});

/** Mato yoki furnitura buyurtmalarini yaratish (postavshik bo'yicha). */
purchasesRouter.post('/orders/:orderId/:stage', requireAction('purchase.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const orderId = idParam.parse(req.params.orderId);
  const stage = z.enum(['mato', 'furnitura']).parse(req.params.stage);
  const data = await tx(async (db) => {
    const created = await createPurchases(db, ctx, orderId, stage);
    return { created, plan: await supplyPlan(db, orderId) };
  });
  res.status(201).json(data);
});

// ---------- Buyurtmalar ----------
const STATUSES = ['negotiation', 'rejected', 'preparing', 'in_transit', 'arrived', 'closed', 'cancelled'] as const;

purchasesRouter.get('/', async (req, res) => {
  const q = z
    .object({
      status: z.enum(STATUSES).optional(),
      stage: z.enum(['mato', 'furnitura']).optional(),
      order_id: idParam.optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(300),
    })
    .parse(req.query);
  const rows = (
    await pool.query(
      `SELECT p.*, s.name AS supplier_name, o.partiya_no, pt.name AS product_type_name,
              (SELECT count(*) FROM purchase_order_lines l WHERE l.po_id = p.id) AS lines,
              (SELECT sum(round(coalesce(l.fact_qty, l.plan_qty) * coalesce(l.fact_price, l.price) * l.rate, 2))
                 FROM purchase_order_lines l WHERE l.po_id = p.id) AS amount_uzs
         FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id
         JOIN orders o ON o.id = p.order_id JOIN product_types pt ON pt.id = o.product_type_id
        WHERE ($1::text IS NULL OR p.status = $1) AND ($2::text IS NULL OR p.stage = $2) AND ($3::int IS NULL OR p.order_id = $3)
        ORDER BY p.id DESC LIMIT $4`,
      [q.status ?? null, q.stage ?? null, q.order_id ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

export async function purchaseDetail(db: Db | typeof pool, id: number) {
  const po = (
    await db.query(
      `SELECT p.*, s.name AS supplier_name, s.country AS supplier_country, o.partiya_no, o.artikul, o.model,
              pt.name AS product_type_name, ua.full_name AS agreed_by_name, uc.full_name AS created_by_name
         FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id
         JOIN orders o ON o.id = p.order_id JOIN product_types pt ON pt.id = o.product_type_id
         LEFT JOIN users ua ON ua.id = p.agreed_by LEFT JOIN users uc ON uc.id = p.created_by
        WHERE p.id = $1`,
      [id],
    )
  ).rows[0];
  if (!po) throw notFound('Buyurtma');
  const lines = (
    await db.query(
      `SELECT l.*, mt.name AS material_name, mt.code AS material_code, mt.unit, mc.name AS material_color_name,
              round(l.plan_qty * l.price, 2) AS plan_amount,
              round(l.fact_qty * coalesce(l.fact_price, l.price), 2) AS fact_amount,
              round(coalesce(l.fact_qty, l.plan_qty) * coalesce(l.fact_price, l.price) * l.rate, 2) AS amount_uzs,
              coalesce((SELECT jsonb_agg(jsonb_build_object('color_name', c.name, 'plan_qty', s.plan_qty, 'per_unit', m.per_unit,
                         'fact_qty', round(l.fact_qty * s.plan_qty / l.plan_qty, 3),
                         'products', CASE WHEN m.is_main AND l.fact_qty IS NOT NULL
                                          THEN ceil(round(l.fact_qty * s.plan_qty / l.plan_qty, 3) / m.per_unit) END)
                         ORDER BY c.name)
                          FROM purchase_line_sources s JOIN order_materials m ON m.id = s.order_material_id JOIN colors c ON c.id = m.color_id
                         WHERE s.line_id = l.id), '[]') AS sources
         FROM purchase_order_lines l JOIN materials mt ON mt.id = l.material_id LEFT JOIN colors mc ON mc.id = l.material_color_id
        WHERE l.po_id = $1 ORDER BY l.id`,
      [id],
    )
  ).rows;
  const totals = (
    await db.query(
      `SELECT sum(round(plan_qty * price * rate, 2)) AS plan_uzs,
              sum(round(fact_qty * coalesce(fact_price, price) * rate, 2)) AS fact_uzs,
              bool_and(fact_qty IS NOT NULL) AS all_fact
         FROM purchase_order_lines WHERE po_id = $1`,
      [id],
    )
  ).rows[0];
  return { po, lines, totals };
}

async function poOf(db: Db, id: number) {
  const p = (await db.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!p) throw notFound('Buyurtma');
  return p;
}

purchasesRouter.get('/:id', async (req, res) => {
  res.json(await purchaseDetail(pool, idParam.parse(req.params.id)));
});

/** Sarlavha: menejer, sana, ETA, tracking, izoh. */
purchasesRouter.patch('/:id', requireAction('purchase.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = z
    .object({
      po_date: z.coerce.date().transform((d) => d.toISOString().slice(0, 10)).optional(),
      manager: optText(100),
      eta: z.coerce.date().transform((d) => d.toISOString().slice(0, 10)).nullish(),
      tracking: optText(200),
      note: optText(1000),
    })
    .parse(req.body) as Record<string, unknown>;
  const data = await tx(async (db) => {
    const old = await poOf(db, id);
    if (old.status === 'closed' || old.status === 'cancelled') throw conflict('Yopilgan yoki bekor qilingan buyurtma o\'zgarmaydi');
    const keys = ['po_date', 'manager', 'eta', 'tracking', 'note'].filter((k) => b[k] !== undefined);
    if (keys.length) {
      await db.query(`UPDATE purchase_orders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => b[k] ?? null)]);
    }
    const d = await purchaseDetail(db, id);
    await audit(db, ctx, 'purchase', id, 'update', old, d.po);
    return d;
  });
  res.json(data);
});

// ---------- Postavshik kelishuvi: nakladnoy bo'yicha fakt miqdor va narx ----------
purchasesRouter.put('/:id/lines', requireAction('purchase.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const { lines } = z
    .object({
      lines: z
        .array(
          z.object({
            id: idParam,
            fact_qty: decimal.min(0).max(1e9).nullish(),
            fact_price: decimal.min(0).max(1e12).nullish(),
            note: optText(300),
          }),
        )
        .min(1)
        .max(500),
    })
    .parse(req.body);
  const data = await tx(async (db) => {
    const p = await poOf(db, id);
    if (p.status !== 'negotiation' && p.status !== 'rejected') {
      throw new AppError(409, 'PURCHASE_LOCKED', 'Kelishilgan buyurtmaning nakladnoyi o\'zgarmaydi');
    }
    const old = (await db.query('SELECT id, fact_qty, fact_price, note FROM purchase_order_lines WHERE po_id = $1 ORDER BY id', [id])).rows;
    for (const l of lines) {
      const r = await db.query(
        `UPDATE purchase_order_lines SET fact_qty = $3, fact_price = $4, note = coalesce($5, note) WHERE id = $1 AND po_id = $2`,
        [l.id, id, l.fact_qty ?? null, l.fact_price ?? null, l.note],
      );
      if (!r.rowCount) throw notFound('Buyurtma qatori');
    }
    // rad etilgan buyurtma tuzatilsa — yana kelishuvga qaytadi
    if (p.status === 'rejected') await db.query(`UPDATE purchase_orders SET status = 'negotiation', reject_reason = NULL WHERE id = $1`, [id]);
    const d = await purchaseDetail(db, id);
    await audit(db, ctx, 'purchase', id, 'nakladnoy', old, d.lines.map((l) => ({ id: l.id, fact_qty: l.fact_qty, fact_price: l.fact_price, note: l.note })));
    return d;
  });
  res.json(data);
});

/** Kelishuvni tasdiqlash: fakt miqdorlar majburiy; mato bo'lsa mahsulot soni qayta hisoblanadi. */
purchasesRouter.post('/:id/agree', requireAction('purchase.approve'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const data = await tx(async (db) => {
    const p = await poOf(db, id);
    if (p.status !== 'negotiation') throw conflict(p.status === 'rejected' ? 'Rad etilgan buyurtmani avval tuzating' : 'Buyurtma kelishuv bosqichida emas');
    const missing = (await db.query('SELECT count(*) AS n FROM purchase_order_lines WHERE po_id = $1 AND fact_qty IS NULL', [id])).rows[0].n;
    if (missing > 0) throw badRequest(`${missing} ta qatorda nakladnoy bo'yicha fakt miqdor kiritilmagan`);
    await db.query('UPDATE purchase_order_lines SET fact_price = price WHERE po_id = $1 AND fact_price IS NULL', [id]);
    await db.query(`UPDATE purchase_orders SET status = 'preparing', agreed_by = $2, agreed_at = now() WHERE id = $1`, [id, ctx.userId]);
    if (p.stage === 'mato') await recomputeActuals(db, p.order_id);
    const d = await purchaseDetail(db, id);
    await audit(db, ctx, 'purchase', id, 'agree', { status: p.status }, { status: 'preparing', fact_uzs: d.totals.fact_uzs });
    return d;
  });
  res.json(data);
});

purchasesRouter.post('/:id/reject', requireAction('purchase.approve'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(2, 'Sababini yozing').max(500) }).parse(req.body);
  const data = await tx(async (db) => {
    const p = await poOf(db, id);
    if (p.status !== 'negotiation') throw conflict('Faqat kelishuvdagi buyurtma rad etiladi');
    await db.query(`UPDATE purchase_orders SET status = 'rejected', reject_reason = $2 WHERE id = $1`, [id, reason]);
    const d = await purchaseDetail(db, id);
    await audit(db, ctx, 'purchase', id, 'reject', { status: p.status }, { status: 'rejected', reason });
    return d;
  });
  res.json(data);
});

/** Bekor qilish (yo'lga chiqmagan buyurtma). Kelishilgan mato bekor qilinsa, furnitura bo'lmasligi kerak. */
purchasesRouter.post('/:id/cancel', requireAction('purchase.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const data = await tx(async (db) => {
    const p = await poOf(db, id);
    if (!['negotiation', 'rejected', 'preparing'].includes(p.status)) throw conflict('Yo\'lga chiqqan yoki yopilgan buyurtmani bekor qilib bo\'lmaydi');
    if (p.stage === 'mato' && p.status === 'preparing') {
      const f = (await db.query(`SELECT count(*) AS n FROM purchase_orders WHERE order_id = $1 AND stage = 'furnitura' AND status <> 'cancelled'`, [p.order_id]))
        .rows[0].n;
      if (f > 0) throw conflict('Bu zakaz bo\'yicha furnitura buyurtmasi bor — avval uni bekor qiling');
    }
    await db.query(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1`, [id]);
    if (p.stage === 'mato') await recomputeActuals(db, p.order_id);
    const d = await purchaseDetail(db, id);
    await audit(db, ctx, 'purchase', id, 'cancel', { status: p.status }, { status: 'cancelled' });
    return d;
  });
  res.json(data);
});
