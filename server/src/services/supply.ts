import type { RequestCtx } from '../auth/context.js';
import type { Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

/**
 * Ta'minot mantig'i (Sheets "Zakaz&Tracking"):
 *  1) mato: asosiy mato qatorlari (reja soni × sarf) postavshikka zakaz qilinadi;
 *  2) postavshik nakladnoyi (fakt miqdor) tasdiqlangach har rang bo'yicha mahsulot soni = fakt ÷ sarf (yuqoriga),
 *     razmerlarga reja ulushi bo'yicha bo'linadi;
 *  3) furnitura: qolgan xomashyo (asosiy bo'lmagan qatorlar) yangi son × sarf bo'yicha zakaz qilinadi.
 */

/** Dona bilan o'lchanadigan xomashyo butun songa yuqoriga yaxlitlanadi */
const COUNT_UNITS = ['Dona', 'Juft', 'Pachka', 'Rulon'];
/** Shu holatlardagi buyurtma "kelishilgan" — fakt miqdori hisobga olinadi */
export const AGREED = ['preparing', 'in_transit', 'arrived', 'closed'];

/**
 * Jami sonni razmerlarga reja ulushi bo'yicha bo'ladi (eng katta qoldiq usuli) — yig'indi aynan jamiga teng.
 * Masalan reja 540/608/540, jami 1700 → ulushlar saqlanadi.
 */
export function distribute(plan: number[], total: number): number[] {
  const sum = plan.reduce((a, b) => a + b, 0);
  if (!sum) return plan.map(() => 0);
  const raw = plan.map((q) => (q * total) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

/** Fakt mato bo'yicha har rangning yangi sonini hisoblab, order_items.actual_qty ga yozadi. */
export async function recomputeActuals(db: Db, orderId: number): Promise<void> {
  const colors = (
    await db.query(
      `SELECT i.color_id, sum(i.qty) AS plan,
              m.id AS main_id, m.per_unit, m.from_us
         FROM order_items i
         LEFT JOIN order_materials m ON m.order_id = i.order_id AND m.color_id = i.color_id AND m.is_main
        WHERE i.order_id = $1
        GROUP BY i.color_id, m.id, m.per_unit, m.from_us`,
      [orderId],
    )
  ).rows;
  for (const c of colors) {
    let total: number | null;
    if (!c.main_id || !c.from_us) {
      // asosiy mato yo'q yoki uni korxona o'zi beradi — son o'zgarmaydi
      total = Number(c.plan);
    } else {
      const r = (
        await db.query(
          `SELECT ceil(round(sum(l.fact_qty * s.plan_qty / l.plan_qty), 3) / $2) AS total, count(*) AS n
             FROM purchase_line_sources s
             JOIN purchase_order_lines l ON l.id = s.line_id
             JOIN purchase_orders p ON p.id = l.po_id
            WHERE s.order_material_id = $1 AND p.status = ANY($3::text[])`,
          [c.main_id, c.per_unit, AGREED],
        )
      ).rows[0];
      total = Number(r.n) ? Number(r.total) : null;
    }
    const items = (
      await db.query(
        `SELECT i.id, i.qty FROM order_items i JOIN sizes s ON s.id = i.size_id
          WHERE i.order_id = $1 AND i.color_id = $2 ORDER BY s.sort, i.id`,
        [orderId, c.color_id],
      )
    ).rows;
    const parts = total == null ? items.map(() => null) : distribute(items.map((i) => i.qty), total);
    for (const [k, it] of items.entries()) {
      await db.query('UPDATE order_items SET actual_qty = $2 WHERE id = $1', [it.id, parts[k]]);
    }
  }
}

interface NeedRow {
  order_material_id: number;
  color_id: number;
  color_name: string;
  material_id: number;
  material_name: string;
  material_code: string | null;
  unit: string;
  supplier_id: number | null;
  supplier_name: string | null;
  material_color_id: number | null;
  material_color_name: string | null;
  color_code: string | null;
  material_size: string | null;
  per_unit: string;
  price: string;
  currency: string;
  rate: string;
  is_main: boolean;
  plan_count: number;
  actual_count: number | null;
  qty: string | null; // shu bosqich uchun kerakli miqdor (rang bo'yicha)
  ordered_po_id: number | null; // allaqachon buyurtma qilingan bo'lsa
}

/** Zakaz bo'yicha ta'minot holati: mato va furnitura ehtiyoji, buyurtmalar, keyingi qadam mumkinmi. */
export async function supplyPlan(db: Db, orderId: number) {
  const order = (
    await db.query(
      `SELECT o.id, o.partiya_no, o.order_date, o.status, o.artikul, o.model, pt.name AS product_type_name, p.name AS producer_name
         FROM orders o JOIN product_types pt ON pt.id = o.product_type_id LEFT JOIN producers p ON p.id = o.producer_id
        WHERE o.id = $1`,
      [orderId],
    )
  ).rows[0];
  if (!order) throw notFound('Zakaz');
  const rows: NeedRow[] = (
    await db.query(
      `WITH cq AS (SELECT color_id, sum(qty) AS plan, sum(actual_qty) AS actual, bool_and(actual_qty IS NOT NULL) AS has_actual
                     FROM order_items WHERE order_id = $1 GROUP BY color_id)
       SELECT m.id AS order_material_id, m.color_id, c.name AS color_name, m.material_id, mt.name AS material_name, mt.code AS material_code,
              mt.unit, m.supplier_id, s.name AS supplier_name, m.material_color_id, mc.name AS material_color_name, m.color_code,
              m.material_size, m.per_unit, m.price, m.currency, m.rate, m.is_main,
              cq.plan AS plan_count, CASE WHEN cq.has_actual THEN cq.actual END AS actual_count,
              CASE WHEN m.is_main THEN round(cq.plan * m.per_unit, 3)
                   WHEN cq.has_actual THEN round(cq.actual * m.per_unit, 3) END AS qty,
              (SELECT l.po_id FROM purchase_line_sources ps JOIN purchase_order_lines l ON l.id = ps.line_id
                 JOIN purchase_orders p ON p.id = l.po_id
                WHERE ps.order_material_id = m.id AND p.status <> 'cancelled' LIMIT 1) AS ordered_po_id
         FROM order_materials m
         JOIN cq ON cq.color_id = m.color_id
         JOIN colors c ON c.id = m.color_id
         JOIN materials mt ON mt.id = m.material_id
         LEFT JOIN suppliers s ON s.id = m.supplier_id
         LEFT JOIN colors mc ON mc.id = m.material_color_id
        WHERE m.order_id = $1 AND m.from_us
        ORDER BY m.is_main DESC, s.name NULLS LAST, mt.name, lower(c.name)`,
      [orderId],
    )
  ).rows;
  const colors = (
    await db.query(
      `SELECT i.color_id, c.name AS color_name, sum(i.qty) AS plan_count,
              CASE WHEN bool_and(i.actual_qty IS NOT NULL) THEN sum(i.actual_qty) END AS actual_count,
              (SELECT mt.name FROM order_materials m JOIN materials mt ON mt.id = m.material_id
                WHERE m.order_id = i.order_id AND m.color_id = i.color_id AND m.is_main AND m.from_us) AS main_material
         FROM order_items i JOIN colors c ON c.id = i.color_id
        WHERE i.order_id = $1 GROUP BY i.order_id, i.color_id, c.name ORDER BY lower(c.name)`,
      [orderId],
    )
  ).rows;
  const purchases = (
    await db.query(
      `SELECT p.id, p.stage, p.status, p.payment_status, p.po_date, p.eta, s.name AS supplier_name,
              (SELECT count(*) FROM purchase_order_lines l WHERE l.po_id = p.id) AS lines
         FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.order_id = $1 ORDER BY p.id`,
      [orderId],
    )
  ).rows;
  const mato = rows.filter((r) => r.is_main);
  const furnitura = rows.filter((r) => !r.is_main);
  const waitingColors = colors.filter((c) => c.actual_count == null).map((c) => c.color_name as string);
  const reasons: { mato: string | null; furnitura: string | null } = { mato: null, furnitura: null };
  if (order.status !== 'confirmed') reasons.mato = reasons.furnitura = 'Zakaz tasdiqlanmagan';
  else {
    if (!mato.some((r) => !r.ordered_po_id)) reasons.mato = mato.length ? 'Mato zakaz qilingan' : 'Asosiy mato belgilanmagan';
    if (!furnitura.some((r) => !r.ordered_po_id)) reasons.furnitura = furnitura.length ? 'Furnitura zakaz qilingan' : 'Furnitura yo\'q';
    else if (waitingColors.length) reasons.furnitura = `Mato nakladnoyi tasdiqlanishi kutilmoqda: ${waitingColors.join(', ')}`;
  }
  return { order, colors, mato, furnitura, purchases, can: { mato: !reasons.mato, furnitura: !reasons.furnitura }, reasons };
}

/** Bosqich bo'yicha buyurtma qilinmagan qatorlardan postavshik bo'yicha buyurtmalar tuzadi. */
export async function createPurchases(db: Db, ctx: RequestCtx, orderId: number, stage: 'mato' | 'furnitura') {
  await db.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (stage === 'mato') await recomputeActuals(db, orderId); // asosiy matosiz ranglar uchun son darhol aniq
  const plan = await supplyPlan(db, orderId);
  if (!plan.can[stage]) throw conflict(plan.reasons[stage] ?? 'Mumkin emas');
  const todo = (stage === 'mato' ? plan.mato : plan.furnitura).filter((r) => !r.ordered_po_id && r.qty != null && Number(r.qty) > 0);
  const noSupplier = [...new Set(todo.filter((r) => !r.supplier_id).map((r) => r.material_name))];
  if (noSupplier.length) throw badRequest(`Postavshik tanlanmagan xomashyo: ${noSupplier.join(', ')} — zakazda yoki ma'lumotnomada postavshikni belgilang`);

  // postavshik → bir xil xomashyo qatorlari birlashtiriladi (ranglar bo'yicha manba saqlanadi)
  const bySupplier = new Map<number, Map<string, NeedRow[]>>();
  for (const r of todo) {
    const key = [r.material_id, r.material_color_id, r.color_code, r.material_size, r.price, r.currency, r.rate].join('|');
    const sup = bySupplier.get(r.supplier_id!) ?? new Map<string, NeedRow[]>();
    sup.set(key, [...(sup.get(key) ?? []), r]);
    bySupplier.set(r.supplier_id!, sup);
  }
  const created: number[] = [];
  for (const [supplierId, groups] of bySupplier) {
    const po = (
      await db.query(
        `INSERT INTO purchase_orders (order_id, supplier_id, stage, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [orderId, supplierId, stage, ctx.userId],
      )
    ).rows[0].id as number;
    for (const g of groups.values()) {
      const f = g[0];
      const sum = g.reduce((a, r) => a + Number(r.qty), 0);
      const qty = COUNT_UNITS.includes(f.unit) ? Math.ceil(sum - 1e-9) : Math.round(sum * 1000) / 1000;
      const line = (
        await db.query(
          `INSERT INTO purchase_order_lines (po_id, material_id, material_color_id, color_code, material_size, plan_qty, price, currency, rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [po, f.material_id, f.material_color_id, f.color_code, f.material_size, qty, f.price, f.currency, f.rate],
        )
      ).rows[0].id;
      for (const r of g) {
        await db.query('INSERT INTO purchase_line_sources (line_id, order_material_id, plan_qty) VALUES ($1, $2, $3)', [line, r.order_material_id, r.qty]);
      }
    }
    await audit(db, ctx, 'purchase', po, 'create', undefined, { order_id: orderId, stage, supplier_id: supplierId });
    created.push(po);
  }
  return created;
}
