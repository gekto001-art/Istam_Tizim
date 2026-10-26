import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { can } from '../lib/permissions.js';
import { decimal, idParam, optText } from '../lib/util.js';
import { AGREED, recomputeActuals, sendPurchases, supplyPlan } from '../services/supply.js';

/**
 * Ta'minot — Sheets "Zakaz&Tracking" varaqlari bo'yicha:
 *  Xomashyo Zakaz (yuborish), Postavshik Kelishuv (qator bo'yicha fakt, tasdiqlash / rad etish),
 *  Tasdiqlangan buyurtmalar, Status o'zgartirish (status, to'lov, tracking, yo'lga chiqish).
 * "Buyurtma ID" — partiya raqami.
 */
export const purchasesRouter = Router();
purchasesRouter.use(requireAction('purchase.read'));

const CURRENCY = z.enum(['UZS', 'USD', 'CNY', 'EUR', 'RUB']);
const PAYMENT = z.enum(['unpaid', 'advance', 'partial', 'paid']);
const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));

// ---------- Xomashyo Zakaz ----------
purchasesRouter.get('/orders', async (_req, res) => {
  const rows = (
    await pool.query(
      `WITH ln AS (
         SELECT p.order_id, p.stage, l.status FROM purchase_orders p JOIN purchase_order_lines l ON l.po_id = p.id WHERE l.status <> 'cancelled')
       SELECT o.id, o.partiya_no, o.order_date, o.artikul, o.model, pt.name AS product_type_name, p.name AS producer_name,
              (SELECT coalesce(sum(qty), 0) FROM order_items i WHERE i.order_id = o.id) AS plan_qty,
              (SELECT sum(actual_qty) FROM order_items i WHERE i.order_id = o.id HAVING bool_and(actual_qty IS NOT NULL)) AS actual_qty,
              (SELECT count(*) FROM ln WHERE ln.order_id = o.id AND ln.stage = 'mato') AS mato_lines,
              (SELECT count(*) FROM ln WHERE ln.order_id = o.id AND ln.stage = 'mato' AND ln.status = ANY($1::text[])) AS mato_agreed,
              (SELECT count(*) FROM ln WHERE ln.order_id = o.id AND ln.stage = 'furnitura') AS furnitura_lines,
              (SELECT count(*) FROM ln WHERE ln.order_id = o.id AND ln.stage = 'furnitura' AND ln.status = ANY($1::text[])) AS furnitura_agreed
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

/** "YUBORISH": tanlangan ehtiyoj qatorlari postavshik(lar)ga — Postavshik Kelishuv'ga tushadi. */
purchasesRouter.post('/orders/:orderId/send', requireAction('purchase.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const orderId = idParam.parse(req.params.orderId);
  const b = z
    .object({
      stage: z.enum(['mato', 'furnitura']),
      rows: z
        .array(
          z.object({
            order_material_id: idParam,
            supplier_id: idParam,
            qty: decimal.positive().max(1e9),
            price: decimal.min(0).max(1e12),
            currency: CURRENCY,
            rate: decimal.positive().max(1e9).nullish(),
            payment_status: PAYMENT.optional(),
            eta: date.nullish(),
            manager: optText(100),
            note: optText(500),
          }),
        )
        .min(1)
        .max(1000),
    })
    .parse(req.body);
  const data = await tx(async (db) => {
    const created = await sendPurchases(db, ctx, orderId, b.stage, b.rows);
    return { created, plan: await supplyPlan(db, orderId) };
  });
  res.status(201).json(data);
});

// ---------- Buyurtma qatorlari (Postavshik Kelishuv / Tasdiqlangan buyurtmalar) ----------
const LINE_SELECT = `
  SELECT l.id, l.po_id, l.created_at, p.order_id, o.partiya_no, p.po_date, p.stage, p.supplier_id, s.name AS supplier_name,
         pt.name AS product_type_name, l.material_id, mt.name AS material_name, mt.code AS material_code, mt.unit,
         l.material_color_id, mc.name AS material_color_name, l.color_code, l.material_size,
         l.plan_qty, l.price, round(l.plan_qty * l.price, 2) AS plan_amount, l.currency, l.rate,
         l.status, l.payment_status, l.eta, l.tracking, l.arrived_date, l.manager, l.note, l.reject_reason,
         l.fact_qty, l.fact_price,
         round(coalesce(l.fact_qty, l.plan_qty) * coalesce(l.fact_price, l.price), 2) AS fact_amount,
         l.agreed_at, ua.full_name AS agreed_by_name,
         coalesce(sh.qty, 0) AS shipped_qty,
         round(coalesce(l.fact_qty, l.plan_qty) - coalesce(sh.qty, 0), 3) AS remaining_qty,
         (SELECT string_agg(DISTINCT c.name, ', ') FROM purchase_line_sources ps JOIN order_materials m ON m.id = ps.order_material_id
            JOIN colors c ON c.id = m.color_id WHERE ps.line_id = l.id) AS for_colors
    FROM purchase_order_lines l
    JOIN purchase_orders p ON p.id = l.po_id
    JOIN orders o ON o.id = p.order_id
    JOIN product_types pt ON pt.id = o.product_type_id
    JOIN suppliers s ON s.id = p.supplier_id
    JOIN materials mt ON mt.id = l.material_id
    LEFT JOIN colors mc ON mc.id = l.material_color_id
    LEFT JOIN users ua ON ua.id = l.agreed_by
    LEFT JOIN LATERAL (SELECT sum(x.qty) AS qty FROM purchase_shipments x WHERE x.line_id = l.id) sh ON true`;

purchasesRouter.get('/lines', async (req, res) => {
  const q = z
    .object({
      status: z.string().max(200).optional(), // vergul bilan: negotiation,rejected
      order_id: idParam.optional(),
      stage: z.enum(['mato', 'furnitura']).optional(),
      limit: z.coerce.number().int().min(1).max(2000).default(1000),
    })
    .parse(req.query);
  const statuses = q.status ? q.status.split(',').map((x) => x.trim()).filter(Boolean) : null;
  const rows = (
    await pool.query(
      `${LINE_SELECT}
        WHERE ($1::text[] IS NULL OR l.status = ANY($1)) AND ($2::int IS NULL OR p.order_id = $2) AND ($3::text IS NULL OR p.stage = $3)
        ORDER BY l.id DESC LIMIT $4`,
      [statuses, q.order_id ?? null, q.stage ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

/**
 * Postavshik Kelishuv: fakt miqdor/narx saqlanadi; "tasdiqlash" — qator kelishiladi (Tayyorlanmoqda),
 * "rad etish" — rad etiladi (sababi izohda). Mato tasdiqlansa zakazdagi son qayta hisoblanadi.
 */
purchasesRouter.put('/lines/kelishuv', async (req, res) => {
  const ctx = ctxOf(req);
  const { lines } = z
    .object({
      lines: z
        .array(
          z.object({
            id: idParam,
            fact_qty: decimal.min(0).max(1e9).nullish(),
            fact_price: decimal.min(0).max(1e12).nullish(),
            decision: z.enum(['agree', 'reject']).nullish(),
            note: optText(500),
          }),
        )
        .min(1)
        .max(1000),
    })
    .parse(req.body);
  // fakt va izoh kiritish — ta'minot; tasdiqlash / rad etish — tasdiqlash huquqi (rahbar ham)
  const edits = lines.some((l) => l.fact_qty !== undefined || l.fact_price !== undefined || (l.note && l.decision !== 'reject'));
  if (edits && !can(ctx.role, 'purchase.write')) throw new AppError(403, 'FORBIDDEN', 'Nakladnoy kiritish uchun ruxsat yo\'q');
  if (lines.some((l) => l.decision) && !can(ctx.role, 'purchase.approve')) throw new AppError(403, 'FORBIDDEN', 'Kelishuvni tasdiqlash uchun ruxsat yo\'q');
  const data = await tx(async (db) => {
    const touched = new Set<number>();
    const result = { saved: 0, agreed: 0, rejected: 0 };
    for (const l of lines) {
      const old = (
        await db.query('SELECT l.*, p.order_id, p.stage FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE l.id = $1 FOR UPDATE OF l', [l.id])
      ).rows[0];
      if (!old) throw notFound('Buyurtma qatori');
      if (old.status !== 'negotiation' && old.status !== 'rejected') {
        throw new AppError(409, 'PURCHASE_LOCKED', 'Kelishilgan yoki bekor qilingan qator o\'zgarmaydi');
      }
      let status = old.status;
      let factQty = l.fact_qty === undefined ? old.fact_qty : l.fact_qty;
      let factPrice = l.fact_price === undefined ? old.fact_price : l.fact_price;
      let reason = old.reject_reason;
      if (l.decision === 'agree') {
        status = 'preparing';
        factQty ??= old.plan_qty; // fakt kiritilmasa — zakaz qilingan miqdor
        factPrice ??= old.price;
        reason = null;
        result.agreed++;
        if (old.stage === 'mato') touched.add(old.order_id);
      } else if (l.decision === 'reject') {
        status = 'rejected';
        reason = l.note || old.note || 'Rad etildi';
        result.rejected++;
      } else result.saved++;
      await db.query(
        `UPDATE purchase_order_lines SET fact_qty = $2, fact_price = $3, status = $4, reject_reason = $5, note = coalesce($6, note),
                agreed_by = CASE WHEN $4 = 'preparing' THEN $7 ELSE agreed_by END,
                agreed_at = CASE WHEN $4 = 'preparing' THEN now() ELSE agreed_at END
          WHERE id = $1`,
        [l.id, factQty, factPrice, status, reason, l.decision === 'reject' ? null : l.note, ctx.userId],
      );
      await audit(db, ctx, 'purchase_line', l.id, l.decision ?? 'nakladnoy', { status: old.status, fact_qty: old.fact_qty, fact_price: old.fact_price }, { status, fact_qty: factQty, fact_price: factPrice, reason });
    }
    for (const orderId of touched) await recomputeActuals(db, orderId);
    return result;
  });
  res.json(data);
});

/** Bekor qilish (yo'lga chiqmagan qator). Kelishilgan mato bekor qilinsa, furnitura yuborilmagan bo'lishi kerak. */
purchasesRouter.post('/lines/:id/cancel', requireAction('purchase.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const l = (
      await db.query('SELECT l.*, p.order_id, p.stage FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE l.id = $1 FOR UPDATE OF l', [id])
    ).rows[0];
    if (!l) throw notFound('Buyurtma qatori');
    if (!['negotiation', 'rejected', 'preparing'].includes(l.status)) throw conflict('Yo\'lga chiqqan yoki yopilgan qatorni bekor qilib bo\'lmaydi');
    if ((await db.query('SELECT 1 FROM purchase_shipments WHERE line_id = $1 LIMIT 1', [id])).rowCount) throw conflict('Bu qator bo\'yicha yo\'lga chiqish bor');
    if (l.stage === 'mato' && l.status === 'preparing') {
      const f = (
        await db.query(
          `SELECT count(*) AS n FROM purchase_order_lines x JOIN purchase_orders p ON p.id = x.po_id
            WHERE p.order_id = $1 AND p.stage = 'furnitura' AND x.status <> 'cancelled'`,
          [l.order_id],
        )
      ).rows[0].n;
      if (f > 0) throw conflict('Bu zakaz bo\'yicha furnitura yuborilgan — avval uni bekor qiling');
    }
    await db.query(`UPDATE purchase_order_lines SET status = 'cancelled' WHERE id = $1`, [id]);
    if (l.stage === 'mato') await recomputeActuals(db, l.order_id);
    await audit(db, ctx, 'purchase_line', id, 'cancel', { status: l.status }, { status: 'cancelled' });
  });
  res.status(204).end();
});

// ---------- Status o'zgartirish ----------
const TRACK_STATUSES = ['preparing', 'in_transit', 'arrived', 'closed'] as const;

/** Buyurtma ID ro'yxati: kelishilgan, yopilmagan qatorlari bor partiyalar */
purchasesRouter.get('/tracking', async (_req, res) => {
  const rows = (
    await pool.query(
      `SELECT o.id AS order_id, o.partiya_no, pt.name AS product_type_name, count(*) AS lines,
              sum(round(coalesce(l.fact_qty, l.plan_qty) - coalesce((SELECT sum(x.qty) FROM purchase_shipments x WHERE x.line_id = l.id), 0), 3)) AS remaining_qty
         FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id JOIN orders o ON o.id = p.order_id
         JOIN product_types pt ON pt.id = o.product_type_id
        WHERE l.status = ANY($1::text[]) AND l.status <> 'closed'
        GROUP BY o.id, o.partiya_no, pt.name ORDER BY o.id DESC`,
      [AGREED],
    )
  ).rows;
  res.json(rows);
});

async function trackingDetail(db: Db | typeof pool, orderId: number) {
  const lines = (
    await db.query(`${LINE_SELECT} WHERE p.order_id = $1 AND l.status = ANY($2::text[]) ORDER BY p.stage DESC, s.name, mt.name, l.id`, [orderId, AGREED])
  ).rows;
  const shipments = (
    await db.query(
      `SELECT x.id, x.created_at, x.ship_date, x.qty, x.note, o.partiya_no, p.po_date, s.name AS supplier_name, mt.name AS material_name,
              mt.code AS material_code, mc.name AS material_color_name, l.color_code, l.material_size,
              coalesce(l.fact_price, l.price) AS price, round(x.qty * coalesce(l.fact_price, l.price), 2) AS amount, l.currency, l.rate,
              round(x.qty * coalesce(l.fact_price, l.price) * l.rate, 2) AS amount_uzs, u.full_name AS created_by_name
         FROM purchase_shipments x JOIN purchase_order_lines l ON l.id = x.line_id JOIN purchase_orders p ON p.id = l.po_id
         JOIN orders o ON o.id = p.order_id JOIN suppliers s ON s.id = p.supplier_id JOIN materials mt ON mt.id = l.material_id
         LEFT JOIN colors mc ON mc.id = l.material_color_id LEFT JOIN users u ON u.id = x.created_by
        WHERE p.order_id = $1 ORDER BY x.ship_date DESC, x.id DESC`,
      [orderId],
    )
  ).rows;
  return { lines, shipments };
}

purchasesRouter.get('/tracking/:orderId', async (req, res) => {
  res.json(await trackingDetail(pool, idParam.parse(req.params.orderId)));
});

/**
 * Sheets "Status o'zgartirish": Buyurtma ID tanlanadi; buyurtma statusi, to'lov statusi va tracking majburiy;
 * yo'lga chiqqan miqdor kiritilsa — yo'lga chiqish sanasi majburiy va miqdor qoldiqdan oshmaydi.
 * To'lov va tracking partiyaning barcha kelishilgan qatorlariga, status — yo'lga chiqqan qatorlarga (miqdor kiritilmasa hammasiga).
 */
purchasesRouter.post('/tracking/:orderId', requireAction('purchase.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const orderId = idParam.parse(req.params.orderId);
  const b = z
    .object({
      status: z.enum(TRACK_STATUSES, { message: 'Buyurtma statusini tanlang' }),
      payment_status: PAYMENT,
      tracking: z.string().trim().min(1, 'Trackingni tanlang').max(200),
      ship_date: date.nullish(),
      eta: date.nullish(),
      arrived_date: date.nullish(),
      shipments: z.array(z.object({ line_id: idParam, qty: decimal.positive().max(1e9) })).max(1000).default([]),
    })
    .parse(req.body);
  if (b.shipments.length && !b.ship_date) throw badRequest('Yo\'lga chiqish sanasini tanlang');
  const data = await tx(async (db) => {
    const lines = (
      await db.query(
        `SELECT l.*, round(coalesce(l.fact_qty, l.plan_qty) - coalesce((SELECT sum(x.qty) FROM purchase_shipments x WHERE x.line_id = l.id), 0), 3) AS remaining
           FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id
          WHERE p.order_id = $1 AND l.status = ANY($2::text[]) FOR UPDATE OF l`,
        [orderId, AGREED],
      )
    ).rows;
    if (!lines.length) throw notFound('Kelishilgan buyurtma');
    const byId = new Map(lines.map((l) => [l.id as number, l]));
    for (const s of b.shipments) {
      const l = byId.get(s.line_id);
      if (!l) throw badRequest('Qator bu buyurtmaga tegishli emas');
      if (s.qty > Number(l.remaining) + 1e-9) throw badRequest('Yo\'lga chiqqan miqdor qoldiqdan ko\'p');
    }
    const shipped = new Set(b.shipments.map((s) => s.line_id));
    const statusTargets = shipped.size ? lines.filter((l) => shipped.has(l.id)) : lines;
    const old = lines.map((l) => ({ id: l.id, status: l.status, payment_status: l.payment_status, tracking: l.tracking }));
    await db.query(
      `UPDATE purchase_order_lines SET payment_status = $2, tracking = $3, eta = coalesce($4, eta) WHERE id = ANY($1::int[])`,
      [lines.map((l) => l.id), b.payment_status, b.tracking, b.eta ?? null],
    );
    await db.query(
      `UPDATE purchase_order_lines SET status = $2,
              arrived_date = CASE WHEN $2 IN ('arrived', 'closed') THEN coalesce(arrived_date, $3::date, current_date) ELSE arrived_date END
        WHERE id = ANY($1::int[])`,
      [statusTargets.map((l) => l.id), b.status, b.arrived_date ?? null],
    );
    for (const s of b.shipments) {
      await db.query('INSERT INTO purchase_shipments (line_id, ship_date, qty, created_by) VALUES ($1, $2, $3, $4)', [s.line_id, b.ship_date, s.qty, ctx.userId]);
    }
    await audit(db, ctx, 'purchase_tracking', orderId, 'update', old, { ...b });
    return trackingDetail(db, orderId);
  });
  res.json(data);
});
