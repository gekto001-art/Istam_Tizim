import crypto from 'node:crypto';
import { config } from '../config.js';
import { pool, tx, type Db } from '../db/pool.js';
import { AppError, badRequest } from '../lib/errors.js';

/**
 * Billz integratsiyasi (faqat Billz'dan bizga) — https://docs.billz.io:
 *  POST /v1/auth/login {secret_token} → access_token (Bearer);
 *  GET /v1/shop — do'konlar; GET /v1/stock-report-table — qoldiq (do'kon × tovar);
 *  GET /v1/product-general-table (detalization=day) — sotuv kun × do'kon × tovar.
 * Qoldiq har safar to'liq almashtiriladi; sotuv oxirgi 3 kun (birinchi marta — sales_start dan) qayta yoziladi.
 */
const PLATFORM_ID = '7d4a4c38-dd84-4902-b744-0488b80a4c01';
const PAGE = 500;
const baseUrl = () => process.env.BILLZ_API_URL ?? 'https://api-admin.billz.ai';

// ---------- Kalitni shifrlash ----------
const key = () => crypto.createHash('sha256').update(`${config.jwtSecret}:billz`).digest();
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(s: string): string {
  const [iv, tag, enc] = s.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/** Billz xatosi bizning mijozga 502 bo'lib qaytadi (401 bo'lsa ilova foydalanuvchini chiqarib yubormasin) */
export class BillzError extends AppError {
  constructor(
    message: string,
    public billzStatus = 0,
  ) {
    super(502, 'BILLZ', message);
  }
}

async function call<T>(path: string, opts: { token?: string; method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
  const url = new URL(path, baseUrl());
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  let r: Response;
  try {
    r = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'platform-id': PLATFORM_ID,
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new BillzError(`Billz'ga ulanib bo'lmadi: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (r.status === 401) throw new BillzError('Billz: avtorizatsiya xatosi (401)', 401);
  if (r.status === 403) throw new BillzError("Billz: ruxsat yo'q (403) — kalitni tekshiring", 403);
  if (r.status === 429) throw new BillzError("Billz: so'rovlar limiti (429) — keyinroq qayta urinadi", 429);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new BillzError(`Billz: ${r.status} ${text.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

async function login(secret: string) {
  const r = await call<{ data?: { access_token?: string; expires_in?: number } }>('/v1/auth/login', { method: 'POST', body: { secret_token: secret } });
  const token = r.data?.access_token;
  if (!token) throw new BillzError('Billz: kirish tokeni qaytmadi');
  return { token, expiresIn: r.data?.expires_in ?? 15 * 24 * 3600 };
}

/** Kalitni tekshirish (saqlashdan oldin): kirish va do'konlar ro'yxati */
export async function testSecret(secret: string) {
  const { token } = await login(secret);
  return listShops(token);
}

async function listShops(token: string) {
  const r = await call<{ shops?: { id: string; name: string; deleted_at?: number | null }[] }>('/v1/shop', { token, query: { limit: 100, only_allowed: 'true' } });
  return (r.shops ?? []).filter((s) => !s.deleted_at).map((s) => ({ id: s.id, name: s.name }));
}

/** Saqlangan token muddati o'tmagan bo'lsa — o'sha, aks holda qayta kirish */
async function accessToken(db: Db | typeof pool, force = false): Promise<string> {
  const s = (await db.query('SELECT secret_enc, access_token, access_expires FROM billz_settings WHERE id = 1')).rows[0];
  if (!s?.secret_enc) throw badRequest('Billz kaliti kiritilmagan');
  if (!force && s.access_token && s.access_expires && new Date(s.access_expires).getTime() > Date.now() + 3600_000) return decrypt(s.access_token);
  const { token, expiresIn } = await login(decrypt(s.secret_enc));
  await db.query("UPDATE billz_settings SET access_token = $1, access_expires = now() + make_interval(secs => $2) WHERE id = 1", [encrypt(token), expiresIn]);
  return token;
}

/** Token eskirgan bo'lsa (401) bir marta qayta kirib urinadi */
async function authed<T>(fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await accessToken(pool));
  } catch (e) {
    if (e instanceof BillzError && e.billzStatus === 401) return fn(await accessToken(pool, true));
    throw e;
  }
}

/** Sahifalab o'qish: qator kelmaguncha yoki count'ga yetguncha */
async function pages<R>(token: string, path: string, query: Record<string, string | number | undefined>, rowsKey: string): Promise<R[]> {
  const out: R[] = [];
  for (let page = 1; page <= 400; page++) {
    const r = await call<Record<string, unknown>>(path, { token, query: { ...query, page, limit: PAGE } });
    const rows = (r[rowsKey] as R[] | undefined) ?? [];
    out.push(...rows);
    const count = typeof r.count === 'number' ? r.count : undefined;
    if (!rows.length || (count !== undefined && out.length >= count) || rows.length < PAGE) break;
  }
  return out;
}

/** Toshkent vaqti bo'yicha sana (UTC+5) */
const tashkentDate = (d = new Date(), addDays = 0) => new Date(d.getTime() + 5 * 3600_000 + addDays * 86400_000).toISOString().slice(0, 10);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

interface StockRow {
  shop_id: string;
  product_id: string;
  product_name?: string;
  product_base_name?: string;
  product_barcode?: string;
  product_sku?: string;
  product_brand_name?: string;
  supplier_name?: string;
  supply_price?: number;
  retail_price?: number;
  measurement_value?: number;
  product_measurement_unit_short_name?: string;
  product_attributes?: unknown[];
  categories_path?: string[];
}
interface SaleRow {
  date?: string;
  shop_id: string;
  product_id: string;
  product_name?: string;
  product_sku?: string;
  product_barcode?: string;
  sold_measurement_value?: number;
  returned_measurement_value?: number;
  net_sold_measurement_value?: number;
  gross_sales?: number;
  returned_sales_sum?: number;
  net_sales?: number;
  net_profit?: number;
  sold_supply_sum?: number;
  discount?: number;
}

/**
 * Yangilash: do'konlar, qoldiq (to'liq almashtirish), sotuv (oxirgi kunlar qayta yoziladi).
 * Bir vaqtda bitta yangilanish (advisory lock); band bo'lsa — o'tkazib yuboriladi.
 */
export async function syncBillz(trigger: 'auto' | 'manual') {
  const lockClient = await pool.connect();
  try {
    const got = (await lockClient.query('SELECT pg_try_advisory_lock(740110) AS ok')).rows[0].ok;
    if (!got) return { skipped: true as const };
    const run = (await pool.query('INSERT INTO billz_sync_runs (trigger) VALUES ($1) RETURNING id', [trigger])).rows[0].id as number;
    try {
      const s = (await pool.query('SELECT shop_ids, sales_start FROM billz_settings WHERE id = 1')).rows[0];
      const result = await authed(async (token) => {
        const shops = await listShops(token);
        const selected = (s.shop_ids as string[]).filter((id) => shops.some((x) => x.id === id));
        const shopIds = (selected.length ? selected : shops.map((x) => x.id)).join(',');
        const today = tashkentDate();
        const stock = shopIds ? await pages<StockRow>(token, '/v1/stock-report-table', { report_date: today, shop_ids: shopIds, currency: 'UZS' }, 'rows') : [];
        // sotuv: birinchi marta — sales_start dan (standart 30 kun), keyin — oxirgi 3 kun
        const hasSales = (await pool.query('SELECT 1 FROM billz_sales LIMIT 1')).rowCount;
        const from = hasSales ? tashkentDate(new Date(), -2) : s.sales_start ? new Date(s.sales_start).toISOString().slice(0, 10) : tashkentDate(new Date(), -30);
        const sales = shopIds
          ? await pages<SaleRow>(token, '/v1/product-general-table', { start_date: from, end_date: today, shop_ids: shopIds, detalization: 'day', currency: 'UZS' }, 'products_stats_by_date')
          : [];
        return { shops, stock, sales, from, today, shopIds: shopIds ? shopIds.split(',') : [] };
      });
      await tx(async (db) => {
        for (const sh of result.shops) {
          await db.query('INSERT INTO billz_shops (id, name, synced_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET name = $2, synced_at = now()', [sh.id, sh.name]);
        }
        await db.query('DELETE FROM billz_stock');
        const stock = new Map<string, StockRow & { qty: number }>();
        for (const r of result.stock) {
          if (!r.shop_id || !r.product_id) continue;
          const k = `${r.shop_id}|${r.product_id}`;
          const e = stock.get(k);
          if (e) e.qty += num(r.measurement_value);
          else stock.set(k, { ...r, qty: num(r.measurement_value) });
        }
        for (const r of stock.values()) {
          await db.query(
            `INSERT INTO billz_stock (shop_id, product_id, product_name, base_name, sku, barcode, brand_name, supplier_name, unit, qty, supply_price, retail_price, attributes, categories)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              r.shop_id, r.product_id, r.product_name ?? r.product_base_name ?? '—', r.product_base_name ?? null, r.product_sku ?? null, r.product_barcode ?? null,
              r.product_brand_name ?? null, r.supplier_name ?? null, r.product_measurement_unit_short_name ?? null, r.qty,
              r.supply_price ?? null, r.retail_price ?? null, JSON.stringify(r.product_attributes ?? []), (r.categories_path ?? []).join(' / ') || null,
            ],
          );
        }
        // sotuv: shu oraliqdagi kunlar qayta yoziladi; kun × do'kon × tovar bo'yicha yig'iladi
        await db.query('DELETE FROM billz_sales WHERE date BETWEEN $1 AND $2 AND shop_id = ANY($3::text[])', [result.from, result.today, result.shopIds]);
        const sales = new Map<string, Required<Pick<SaleRow, 'shop_id' | 'product_id'>> & { date: string; name: string; sku: string | null; barcode: string | null; v: number[] }>();
        for (const r of result.sales) {
          if (!r.shop_id || !r.product_id) continue;
          const d = /^\d{4}-\d{2}-\d{2}/.test(r.date ?? '') ? r.date!.slice(0, 10) : result.today;
          const k = `${d}|${r.shop_id}|${r.product_id}`;
          const v = [r.sold_measurement_value, r.returned_measurement_value, r.net_sold_measurement_value, r.gross_sales, r.returned_sales_sum, r.net_sales, r.net_profit, r.sold_supply_sum, r.discount].map(num);
          const e = sales.get(k);
          if (e) e.v = e.v.map((x, i) => x + v[i]);
          else sales.set(k, { date: d, shop_id: r.shop_id, product_id: r.product_id, name: r.product_name ?? '—', sku: r.product_sku ?? null, barcode: r.product_barcode ?? null, v });
        }
        for (const r of sales.values()) {
          await db.query(
            `INSERT INTO billz_sales (date, shop_id, product_id, product_name, sku, barcode, sold, returned, net_sold, gross_sales, returned_sum, net_sales, net_profit, supply_sum, discount)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [r.date, r.shop_id, r.product_id, r.name, r.sku, r.barcode, ...r.v],
          );
        }
        await db.query("UPDATE billz_sync_runs SET finished_at = now(), ok = true, message = 'OK', stock_rows = $2, sales_rows = $3 WHERE id = $1", [run, stock.size, sales.size]);
      });
      return { skipped: false as const, ok: true, stock_rows: result.stock.length, sales_rows: result.sales.length };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await pool.query('UPDATE billz_sync_runs SET finished_at = now(), ok = false, message = $2 WHERE id = $1', [run, message.slice(0, 500)]);
      throw e;
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(740110)');
    }
  } finally {
    lockClient.release();
  }
}

/** Har 5 daqiqada (yoqilgan bo'lsa); eski yozuvlar jurnaldan tozalanadi */
export function startBillzScheduler(intervalMs = 5 * 60_000) {
  const tick = async () => {
    try {
      const s = (await pool.query('SELECT enabled, secret_enc FROM billz_settings WHERE id = 1')).rows[0];
      if (!s?.enabled || !s.secret_enc) return;
      await syncBillz('auto');
      await pool.query("DELETE FROM billz_sync_runs WHERE started_at < now() - interval '14 days'");
    } catch (e) {
      console.warn('Billz yangilash xatosi:', e instanceof Error ? e.message : e);
    }
  };
  setTimeout(tick, 20_000);
  return setInterval(tick, intervalMs);
}
