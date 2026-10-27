import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { encrypt, syncBillz, testSecret } from '../services/billz.js';

/** Billz integratsiyasi: sozlamalar (admin), qo'lda yangilash, qoldiq va sotuv (Billz'dan olingan) */
export const billzRouter = Router();
billzRouter.use(requireAction('billz.read'));

const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));

async function settings() {
  const s = (await pool.query('SELECT secret_enc IS NOT NULL AS configured, token_hint, enabled, shop_ids, sales_start, updated_at FROM billz_settings WHERE id = 1')).rows[0];
  const shops = (await pool.query('SELECT id, name, synced_at FROM billz_shops ORDER BY name')).rows;
  const runs = (await pool.query('SELECT * FROM billz_sync_runs ORDER BY started_at DESC LIMIT 20')).rows;
  return { ...s, shops, runs };
}

billzRouter.get('/settings', async (_req, res) => {
  res.json(await settings());
});

/** Kalit kiritilsa — avval Billz'ga kirib tekshiriladi, do'konlar ro'yxati saqlanadi */
billzRouter.put('/settings', requireAction('billz.manage'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      secret_token: z.string().trim().min(10, 'Kalit juda qisqa').max(2000).optional(),
      enabled: z.boolean().optional(),
      shop_ids: z.array(z.string().uuid()).max(200).optional(),
      sales_start: date.nullish(),
    })
    .parse(req.body);
  if (b.secret_token) {
    const shops = await testSecret(b.secret_token);
    for (const sh of shops) {
      await pool.query('INSERT INTO billz_shops (id, name, synced_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET name = $2, synced_at = now()', [sh.id, sh.name]);
    }
    await pool.query('UPDATE billz_settings SET secret_enc = $1, token_hint = $2, access_token = NULL, access_expires = NULL WHERE id = 1', [
      encrypt(b.secret_token),
      `…${b.secret_token.slice(-4)}`,
    ]);
  }
  const cur = (await pool.query('SELECT secret_enc IS NOT NULL AS configured FROM billz_settings WHERE id = 1')).rows[0];
  if (b.enabled && !cur.configured) throw badRequest('Avval Billz kalitini kiriting');
  await pool.query(
    `UPDATE billz_settings SET enabled = coalesce($1, enabled), shop_ids = coalesce($2, shop_ids),
            sales_start = CASE WHEN $4 THEN $3::date ELSE sales_start END, updated_by = $5, updated_at = now() WHERE id = 1`,
    [b.enabled ?? null, b.shop_ids ?? null, b.sales_start ?? null, b.sales_start !== undefined, ctx.userId],
  );
  // kalit audit'ga yozilmaydi
  await tx((db) => audit(db, ctx, 'billz', 1, 'settings', undefined, { secret_changed: !!b.secret_token, enabled: b.enabled, shop_ids: b.shop_ids, sales_start: b.sales_start }));
  res.json(await settings());
});

/** Hozir yangilash */
billzRouter.post('/sync', async (_req, res) => {
  const r = await syncBillz('manual');
  if (r.skipped) {
    res.status(409).json({ code: 'BUSY', message: 'Yangilash allaqachon ketmoqda — birozdan keyin qarang' });
    return;
  }
  res.json(r);
});

billzRouter.get('/stock', async (req, res) => {
  const q = z.object({ shop_id: z.string().max(100).optional(), q: z.string().trim().max(100).optional() }).parse(req.query);
  const like = q.q ? `%${q.q.toLowerCase()}%` : null;
  const rows = (
    await pool.query(
      `SELECT s.*, sh.name AS shop_name FROM billz_stock s LEFT JOIN billz_shops sh ON sh.id = s.shop_id
        WHERE ($1::text IS NULL OR s.shop_id = $1)
          AND ($2::text IS NULL OR lower(s.product_name) LIKE $2 OR lower(coalesce(s.sku, '')) LIKE $2 OR coalesce(s.barcode, '') LIKE $2)
        ORDER BY lower(s.product_name), sh.name LIMIT 5000`,
      [q.shop_id || null, like],
    )
  ).rows;
  res.json(rows);
});

billzRouter.get('/sales', async (req, res) => {
  const q = z
    .object({ from: date, to: date, shop_id: z.string().max(100).optional(), q: z.string().trim().max(100).optional(), by: z.enum(['product', 'day']).default('product') })
    .parse(req.query);
  const like = q.q ? `%${q.q.toLowerCase()}%` : null;
  const where = `WHERE x.date BETWEEN $1 AND $2 AND ($3::text IS NULL OR x.shop_id = $3)
                   AND ($4::text IS NULL OR lower(x.product_name) LIKE $4 OR lower(coalesce(x.sku, '')) LIKE $4 OR coalesce(x.barcode, '') LIKE $4)`;
  const sums = `sum(x.sold) AS sold, sum(x.returned) AS returned, sum(x.net_sold) AS net_sold, sum(x.gross_sales) AS gross_sales,
                sum(x.returned_sum) AS returned_sum, sum(x.net_sales) AS net_sales, sum(x.net_profit) AS net_profit,
                sum(x.supply_sum) AS supply_sum, sum(x.discount) AS discount`;
  const args = [q.from, q.to, q.shop_id || null, like];
  const rows =
    q.by === 'day'
      ? (await pool.query(`SELECT x.date, ${sums} FROM billz_sales x ${where} GROUP BY x.date ORDER BY x.date DESC`, args)).rows
      : (
          await pool.query(
            `SELECT x.product_id, max(x.product_name) AS product_name, max(x.sku) AS sku, max(x.barcode) AS barcode, ${sums}
               FROM billz_sales x ${where} GROUP BY x.product_id ORDER BY sum(x.net_sales) DESC LIMIT 5000`,
            args,
          )
        ).rows;
  const total = (await pool.query(`SELECT ${sums} FROM billz_sales x ${where}`, args)).rows[0];
  res.json({ rows, total });
});
