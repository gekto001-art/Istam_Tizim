import type { RequestCtx } from '../auth/context.js';
import type { Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

/**
 * Ta'minot mantig'i (Sheets "Zakaz&Tracking"):
 *  1) Xomashyo Zakaz: avval asosiy mato (reja soni × sarf) postavshikka yuboriladi;
 *  2) Postavshik Kelishuv: har qator fakt miqdor/narx bilan tasdiqlanadi yoki rad etiladi;
 *     mato tasdiqlangach har katak soni = fakt ÷ sarf (yuqoriga), razmerlarga reja ulushida;
 *  3) furnitura shu yangi son × sarf bo'yicha yuboriladi;
 *  4) Status o'zgartirish: qatorlar bo'yicha yo'lga chiqish, status, to'lov, tracking.
 * Holat qatorlarda (purchase_order_lines.status); purchase_orders — partiya × postavshik × bosqich guruhi.
 */

/** Dona bilan o'lchanadigan xomashyo butun songa yuqoriga yaxlitlanadi */
export const COUNT_UNITS = ['Dona', 'Juft', 'Pachka', 'Rulon'];
/** Shu holatlardagi qator "kelishilgan" — fakt miqdori hisobga olinadi */
export const AGREED = ['preparing', 'in_transit', 'arrived', 'closed'];

/**
 * Jami sonni razmerlarga reja ulushi bo'yicha bo'ladi (eng katta qoldiq usuli) — yig'indi aynan jamiga teng.
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

/**
 * Asosiy mato qatorining kelishilgan fakt miqdoridan mahsulot soni (yuqoriga). Kelishilmagan bo'lsa null.
 * Bir buyurtma qatori bir nechta zakaz qatoridan yig'ilgan bo'lsa, fakt ularga yuborilgan miqdor ulushida bo'linadi.
 */
async function productsFromFact(db: Db, mainId: number, perUnit: string): Promise<number | null> {
  const r = (
    await db.query(
      `SELECT ceil(round(sum(l.fact_qty * s.plan_qty / t.total), 3) / $2) AS total, count(*) AS n
         FROM purchase_line_sources s
         JOIN purchase_order_lines l ON l.id = s.line_id
         JOIN LATERAL (SELECT sum(x.plan_qty) AS total FROM purchase_line_sources x WHERE x.line_id = l.id) t ON true
        WHERE s.order_material_id = $1 AND l.status = ANY($3::text[])`,
      [mainId, perUnit, AGREED],
    )
  ).rows[0];
  return Number(r.n) ? Number(r.total) : null;
}

/**
 * Fakt mato bo'yicha har katakning (razmer × rang) yangi sonini hisoblab, order_items.actual_qty ga yozadi:
 *  - rang bo'yicha umumiy asosiy mato → rang jami = fakt ÷ sarf, razmerlarga reja ulushida bo'linadi;
 *  - razmer bo'yicha asosiy mato → shu katak soni = fakt ÷ sarf;
 *  - asosiy mato yo'q yoki uni korxona beradi → son o'zgarmaydi.
 */
export async function recomputeActuals(db: Db, orderId: number): Promise<void> {
  const items = (
    await db.query(
      `SELECT i.id, i.color_id, i.size_id, i.qty FROM order_items i JOIN sizes s ON s.id = i.size_id
        WHERE i.order_id = $1 ORDER BY i.color_id, s.sort, i.id`,
      [orderId],
    )
  ).rows as { id: number; color_id: number; size_id: number; qty: number }[];
  const mains = (
    await db.query('SELECT id, color_id, size_id, per_unit, from_us FROM order_materials WHERE order_id = $1 AND is_main', [orderId])
  ).rows as { id: number; color_id: number; size_id: number | null; per_unit: string; from_us: boolean }[];
  const set = (id: number, v: number | null) => db.query('UPDATE order_items SET actual_qty = $2 WHERE id = $1', [id, v]);

  for (const colorId of [...new Set(items.map((i) => i.color_id))]) {
    const ci = items.filter((i) => i.color_id === colorId);
    const wide = mains.find((m) => m.color_id === colorId && m.size_id == null);
    if (wide) {
      const total = wide.from_us ? await productsFromFact(db, wide.id, wide.per_unit) : ci.reduce((a, i) => a + i.qty, 0);
      const parts = total == null ? ci.map(() => null) : distribute(ci.map((i) => i.qty), total);
      for (const [k, it] of ci.entries()) await set(it.id, parts[k]);
      continue;
    }
    for (const it of ci) {
      const m = mains.find((x) => x.color_id === colorId && x.size_id === it.size_id);
      await set(it.id, !m || !m.from_us ? it.qty : await productsFromFact(db, m.id, m.per_unit));
    }
  }
}

export interface NeedRow {
  order_material_id: number;
  color_id: number;
  color_name: string;
  size_id: number | null;
  size_name: string | null;
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
  qty: string | null; // shu bosqich uchun kerakli miqdor (mato — reja, furnitura — fakt son bo'yicha)
  ordered_line_id: number | null; // yuborilgan bo'lsa — buyurtma qatori
  ordered_status: string | null;
}

/** Zakaz bo'yicha ta'minot holati: mato va furnitura ehtiyoji, yuborilganlari, keyingi qadam mumkinmi. */
export async function supplyPlan(db: Db, orderId: number) {
  const order = (
    await db.query(
      `SELECT o.id, o.partiya_no, o.order_date, o.status, o.artikul, o.model, o.start_date, o.end_date,
              pt.name AS product_type_name, p.name AS producer_name
         FROM orders o JOIN product_types pt ON pt.id = o.product_type_id LEFT JOIN producers p ON p.id = o.producer_id
        WHERE o.id = $1`,
      [orderId],
    )
  ).rows[0];
  if (!order) throw notFound('Zakaz');
  const rows: NeedRow[] = (
    await db.query(
      `WITH lq AS (SELECT m.id, order_material_qty(m.order_id, m.color_id, m.size_id, false) AS plan,
                          order_material_qty(m.order_id, m.color_id, m.size_id, true) AS actual
                     FROM order_materials m WHERE m.order_id = $1)
       SELECT m.id AS order_material_id, m.color_id, c.name AS color_name, m.size_id, sz.name AS size_name, m.material_id,
              mt.name AS material_name, mt.code AS material_code, mt.unit, m.supplier_id, s.name AS supplier_name,
              m.material_color_id, mc.name AS material_color_name, m.color_code, m.material_size, m.per_unit, m.price, m.currency, m.rate,
              m.is_main, lq.plan AS plan_count, lq.actual AS actual_count,
              CASE WHEN m.is_main THEN round(lq.plan * m.per_unit, 3) ELSE round(lq.actual * m.per_unit, 3) END AS qty,
              ord.line_id AS ordered_line_id, ord.status AS ordered_status
         FROM order_materials m
         JOIN lq ON lq.id = m.id
         JOIN colors c ON c.id = m.color_id
         LEFT JOIN sizes sz ON sz.id = m.size_id
         JOIN materials mt ON mt.id = m.material_id
         LEFT JOIN suppliers s ON s.id = m.supplier_id
         LEFT JOIN colors mc ON mc.id = m.material_color_id
         LEFT JOIN LATERAL (SELECT l.id AS line_id, l.status FROM purchase_line_sources ps JOIN purchase_order_lines l ON l.id = ps.line_id
                             WHERE ps.order_material_id = m.id AND l.status <> 'cancelled' ORDER BY l.id DESC LIMIT 1) ord ON true
        WHERE m.order_id = $1 AND m.from_us AND lq.plan > 0
        ORDER BY m.is_main DESC, mt.name, mc.name NULLS FIRST, lower(c.name), sz.sort NULLS FIRST`,
      [orderId],
    )
  ).rows;
  const colors = (
    await db.query(
      `SELECT i.color_id, c.name AS color_name, sum(i.qty) AS plan_count,
              CASE WHEN bool_and(i.actual_qty IS NOT NULL) THEN sum(i.actual_qty) END AS actual_count,
              (SELECT string_agg(DISTINCT mt.name, ', ') FROM order_materials m JOIN materials mt ON mt.id = m.material_id
                WHERE m.order_id = i.order_id AND m.color_id = i.color_id AND m.is_main AND m.from_us) AS main_material
         FROM order_items i JOIN colors c ON c.id = i.color_id
        WHERE i.order_id = $1 GROUP BY i.order_id, i.color_id, c.name ORDER BY lower(c.name)`,
      [orderId],
    )
  ).rows;
  const mato = rows.filter((r) => r.is_main);
  const furnitura = rows.filter((r) => !r.is_main);
  const waitingColors = colors.filter((c) => c.actual_count == null).map((c) => c.color_name as string);
  const reasons: { mato: string | null; furnitura: string | null } = { mato: null, furnitura: null };
  if (order.status !== 'confirmed') reasons.mato = reasons.furnitura = 'Zakaz tasdiqlanmagan';
  else {
    if (!mato.some((r) => !r.ordered_line_id)) reasons.mato = mato.length ? 'Mato yuborilgan' : 'Asosiy mato belgilanmagan';
    if (!furnitura.some((r) => !r.ordered_line_id)) reasons.furnitura = furnitura.length ? 'Furnitura yuborilgan' : 'Furnitura yo\'q';
    else if (waitingColors.length) reasons.furnitura = `Mato kelishuvi tasdiqlanishi kutilmoqda: ${waitingColors.join(', ')}`;
  }
  return { order, colors, mato, furnitura, can: { mato: !reasons.mato, furnitura: !reasons.furnitura }, reasons };
}

/** Xomashyo Zakaz'dan yuboriladigan qator (zakazdagi norma qatori uchun) */
export interface SendRow {
  order_material_id: number;
  supplier_id: number;
  qty: number;
  price: number;
  currency: string;
  rate?: number | null;
  payment_status?: string;
  eta?: string | null;
  manager?: string | null;
  note?: string | null;
}

/**
 * "YUBORISH": tanlangan ehtiyoj qatorlarini postavshikka yuboradi. Bir postavshikdagi bir xil xomashyo
 * (nomi, rangi, rang kodi, razmeri, narxi, valyutasi) bitta buyurtma qatoriga yig'iladi; qaysi rangdan kelgani saqlanadi.
 */
export async function sendPurchases(db: Db, ctx: RequestCtx, orderId: number, stage: 'mato' | 'furnitura', send: SendRow[]) {
  await db.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (stage === 'mato') await recomputeActuals(db, orderId); // asosiy matosiz ranglar uchun son darhol aniq
  const plan = await supplyPlan(db, orderId);
  if (!plan.can[stage]) throw conflict(plan.reasons[stage] ?? 'Mumkin emas');
  const allowed = new Map((stage === 'mato' ? plan.mato : plan.furnitura).filter((r) => !r.ordered_line_id).map((r) => [r.order_material_id, r]));
  if (!send.length) throw badRequest('Yuboriladigan qator tanlanmagan');
  for (const s of send) {
    const r = allowed.get(s.order_material_id);
    if (!r) throw badRequest('Qator bu bosqichga tegishli emas yoki allaqachon yuborilgan');
    if (!(s.qty > 0)) throw badRequest(`${r.material_name} (${r.color_name}): miqdor kiritilmagan`);
  }
  const suppliers = new Set((await db.query('SELECT id FROM suppliers WHERE id = ANY($1::int[])', [[...new Set(send.map((s) => s.supplier_id))]])).rows.map((x) => x.id));
  for (const s of send) if (!suppliers.has(s.supplier_id)) throw notFound('Postavshik');

  const rateOf = async (s: SendRow) => {
    if (s.currency === 'UZS') return 1;
    if (s.rate) return s.rate;
    const r = (await db.query('SELECT rate_at($1, current_date) AS r', [s.currency])).rows[0].r;
    if (r == null) throw badRequest(`${s.currency} uchun kurs kiritilmagan`);
    return Number(r);
  };
  // postavshik → bir xil xomashyo qatorlari
  const bySupplier = new Map<number, Map<string, { need: NeedRow; row: SendRow; rate: number }[]>>();
  for (const s of send) {
    const need = allowed.get(s.order_material_id)!;
    const rate = await rateOf(s);
    const key = [need.material_id, need.material_color_id, need.color_code, need.material_size, s.price, s.currency, rate].join('|');
    const g = bySupplier.get(s.supplier_id) ?? new Map();
    g.set(key, [...(g.get(key) ?? []), { need, row: s, rate }]);
    bySupplier.set(s.supplier_id, g);
  }
  const created: number[] = [];
  for (const [supplierId, groups] of bySupplier) {
    const po = (
      await db.query('INSERT INTO purchase_orders (order_id, supplier_id, stage, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [
        orderId,
        supplierId,
        stage,
        ctx.userId,
      ])
    ).rows[0].id as number;
    for (const g of groups.values()) {
      const { need, row, rate } = g[0];
      const sum = g.reduce((a, x) => a + x.row.qty, 0);
      const qty = COUNT_UNITS.includes(need.unit) ? Math.ceil(sum - 1e-9) : Math.round(sum * 1000) / 1000;
      const first = <K extends keyof SendRow>(k: K) => g.map((x) => x.row[k]).find((v) => v != null && v !== '') ?? null;
      const line = (
        await db.query(
          `INSERT INTO purchase_order_lines (po_id, material_id, material_color_id, color_code, material_size, plan_qty, price, currency, rate,
                                             payment_status, eta, manager, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [
            po, need.material_id, need.material_color_id, need.color_code, need.material_size, qty, row.price, row.currency, rate,
            first('payment_status') ?? 'unpaid', first('eta'), first('manager'), first('note'),
          ],
        )
      ).rows[0].id;
      for (const x of g) {
        await db.query('INSERT INTO purchase_line_sources (line_id, order_material_id, plan_qty) VALUES ($1, $2, $3)', [line, x.need.order_material_id, x.row.qty]);
      }
      created.push(line);
    }
    await audit(db, ctx, 'purchase', po, 'send', undefined, { order_id: orderId, stage, supplier_id: supplierId, rows: send.length });
  }
  return created;
}
