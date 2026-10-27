import { Router } from 'express';
import { z } from 'zod';
import { requireAction } from '../auth/context.js';
import { pool } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

/** Hisobotlar */
export const reportsRouter = Router();
reportsRouter.use(requireAction('reports.read'));

const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));
type Cls = 'A' | 'B' | 'C';
const METRICS = ['margin', 'qty', 'sales'] as const;
type Metric = (typeof METRICS)[number];

/**
 * ABC: ko'rsatkich bo'yicha kamayish tartibida, yig'ma ulush ≤ a% — A, ≤ b% — B, qolgani — C.
 * Ulush musbat qiymatlar yig'indisiga nisbatan; 0 yoki manfiy (masalan, zarar bilan sotilgan) — C.
 * Chegara kesib o'tgan tovar o'zidan oldingi ulush bo'yicha baholanadi (birinchi tovar har doim A).
 */
export function classify(values: number[], a: number, b: number): { cls: Cls; share: number; cum: number }[] {
  const total = values.reduce((s, v) => s + (v > 0 ? v : 0), 0);
  const order = values.map((v, i) => [v, i] as const).sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  const out: { cls: Cls; share: number; cum: number }[] = values.map(() => ({ cls: 'C', share: 0, cum: 100 }));
  let cum = 0;
  for (const [v, i] of order) {
    if (v <= 0 || !total) {
      out[i] = { cls: 'C', share: v > 0 && total ? (v / total) * 100 : 0, cum: 100 };
      continue;
    }
    const before = cum;
    const share = (v / total) * 100;
    cum += share;
    out[i] = { cls: before < a ? 'A' : before < b ? 'B' : 'C', share, cum };
  }
  return out;
}

reportsRouter.get('/abc', async (req, res) => {
  const q = z
    .object({
      from: date,
      to: date,
      shop_id: z.string().max(100).optional(),
      a: z.coerce.number().min(1).max(99).default(80),
      b: z.coerce.number().min(2).max(100).default(95),
    })
    .parse(req.query);
  if (q.b <= q.a) throw badRequest('B chegarasi A dan katta bo\'lishi kerak');
  const rows = (
    await pool.query(
      `SELECT x.product_id, max(x.product_name) AS product_name, max(x.sku) AS sku, max(x.barcode) AS barcode,
              sum(x.net_sold)::float8 AS qty, sum(x.net_sales)::float8 AS sales, sum(x.net_profit)::float8 AS margin,
              sum(x.supply_sum)::float8 AS supply
         FROM billz_sales x
        WHERE x.date BETWEEN $1 AND $2 AND ($3::text IS NULL OR x.shop_id = $3)
        GROUP BY x.product_id
       HAVING sum(x.net_sold) <> 0 OR sum(x.net_sales) <> 0 OR sum(x.net_profit) <> 0`,
      [q.from, q.to, q.shop_id || null],
    )
  ).rows as { product_id: string; product_name: string; sku: string | null; barcode: string | null; qty: number; sales: number; margin: number; supply: number }[];

  const res3 = Object.fromEntries(METRICS.map((m) => [m, classify(rows.map((r) => r[m]), q.a, q.b)])) as Record<Metric, ReturnType<typeof classify>>;
  const items = rows
    .map((r, i) => ({
      ...r,
      margin_pct: r.sales ? (r.margin / r.sales) * 100 : null,
      margin_cls: res3.margin[i].cls,
      margin_share: res3.margin[i].share,
      margin_cum: res3.margin[i].cum,
      qty_cls: res3.qty[i].cls,
      qty_share: res3.qty[i].share,
      qty_cum: res3.qty[i].cum,
      sales_cls: res3.sales[i].cls,
      sales_share: res3.sales[i].share,
      sales_cum: res3.sales[i].cum,
      abc: `${res3.margin[i].cls}${res3.qty[i].cls}${res3.sales[i].cls}`,
    }))
    .sort((x, y) => y.sales - x.sales);

  // xulosa: har mezon bo'yicha sinf → tovarlar soni va ko'rsatkich ulushi
  const summary = Object.fromEntries(
    METRICS.map((m) => {
      const total = rows.reduce((s, r) => s + r[m], 0);
      return [
        m,
        (['A', 'B', 'C'] as const).map((c) => {
          const inC = items.filter((it) => it[`${m}_cls`] === c);
          const sum = inC.reduce((s, it) => s + it[m], 0);
          return { cls: c, items: inC.length, items_pct: items.length ? (inC.length / items.length) * 100 : 0, sum, sum_pct: total ? (sum / total) * 100 : 0 };
        }),
      ];
    }),
  );
  const combos = Object.entries(items.reduce<Record<string, number>>((acc, it) => ({ ...acc, [it.abc]: (acc[it.abc] ?? 0) + 1 }), {}))
    .map(([abc, n]) => ({ abc, items: n }))
    .sort((x, y) => x.abc.localeCompare(y.abc));
  const totals = { qty: rows.reduce((s, r) => s + r.qty, 0), sales: rows.reduce((s, r) => s + r.sales, 0), margin: rows.reduce((s, r) => s + r.margin, 0) };
  const synced = (await pool.query('SELECT max(finished_at) AS at FROM billz_sync_runs WHERE ok')).rows[0].at;
  res.json({ items, summary, combos, totals, thresholds: { a: q.a, b: q.b }, synced_at: synced });
});
