import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { admin, api, auth, newUser } from './helpers.js';

/** Billz API o'rnini bosuvchi soxta server (docs.billz.io bo'yicha javoblar) */
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const SECRET = 'test-secret-key-4567';
const mock = { token: 'AT1', logins: 0, limit: false, lastStockShops: '' };
let server: http.Server;

function handle(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
  const url = new URL(req.url!, 'http://x');
  const json = (status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.headers['platform-id'] !== '7d4a4c38-dd84-4902-b744-0488b80a4c01') return json(400, { message: 'platform-id' });
  if (url.pathname === '/v1/auth/login') {
    if (JSON.parse(body).secret_token !== SECRET) return json(403, { message: 'forbidden' });
    mock.logins++;
    return json(200, { code: 200, message: 'ok', data: { access_token: mock.token, token_type: 'Bearer', expires_in: 15 * 24 * 3600 } });
  }
  if (req.headers.authorization !== `Bearer ${mock.token}`) return json(401, { message: 'unauthorized' });
  if (mock.limit) return json(429, { message: 'too many' });
  const page = Number(url.searchParams.get('page') ?? 1);
  const limit = Number(url.searchParams.get('limit') ?? 10);
  if (url.pathname === '/v1/shop') return json(200, { count: 2, shops: [{ id: S1, name: "Do'kon 1" }, { id: S2, name: 'Ombor' }] });
  if (url.pathname === '/v1/stock-report-table') {
    mock.lastStockShops = url.searchParams.get('shop_ids') ?? '';
    const shops = mock.lastStockShops.split(',');
    const all = shops.flatMap((s) =>
      Array.from({ length: s === S1 ? 501 : 1 }, (_, i) => ({
        shop_id: s,
        product_id: `p${i}`,
        product_name: `Rubashka ${i}`,
        product_sku: `SKU-${i}`,
        product_barcode: `200000000${String(i).padStart(4, '0')}`,
        measurement_value: 2,
        supply_price: 20100,
        retail_price: 45000,
        product_measurement_unit_short_name: 'dona',
      })),
    );
    return json(200, { count: all.length, rows: all.slice((page - 1) * limit, page * limit) });
  }
  if (url.pathname === '/v1/product-general-table') {
    const rows = [
      { date: '2026-10-25T00:00:00Z', shop_id: S1, product_id: 'p1', product_name: 'Rubashka 1', product_barcode: '2000000000001', sold_measurement_value: 3, net_sold_measurement_value: 3, gross_sales: 135000, net_sales: 135000, net_profit: 74700, sold_supply_sum: 60300 },
      { date: '2026-10-25', shop_id: S1, product_id: 'p1', product_name: 'Rubashka 1', sold_measurement_value: 1, returned_measurement_value: 1, net_sold_measurement_value: 0, gross_sales: 45000, returned_sales_sum: 45000, net_sales: 0 },
      { date: '2026-10-26', shop_id: S1, product_id: 'p2', product_name: 'Rubashka 2', sold_measurement_value: 2, net_sold_measurement_value: 2, gross_sales: 90000, net_sales: 90000, net_profit: 49800 },
    ];
    return json(200, { count: rows.length, products_stats_by_date: rows.slice((page - 1) * limit, page * limit), products_stats_total: {} });
  }
  return json(404, { message: 'not found' });
}

let A: string;
let sklad: string;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handle(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.BILLZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  A = (await admin()).token;
  sklad = (await newUser(A, 'sklad')).token;
});
afterAll(async () => {
  server.close();
  await pool.end();
});

describe('Billz integratsiyasi (Billz → tizim)', () => {
  it('kalit, do\'konlar, qoldiq va sotuvni olish', async () => {
    expect((await api().get('/api/billz/settings').set(auth(sklad))).body).toMatchObject({ configured: false, enabled: false });
    expect((await api().put('/api/billz/settings').set(auth(sklad)).send({ secret_token: SECRET })).status).toBe(403);
    // noto'g'ri kalit — saqlanmaydi; Billz xatosi 502 (401 emas)
    const bad = await api().put('/api/billz/settings').set(auth(A)).send({ secret_token: 'wrong-secret-0000' });
    expect(bad.status).toBe(502);
    expect(bad.body.message).toContain('403');
    expect((await api().put('/api/billz/settings').set(auth(A)).send({ enabled: true })).body.message).toContain('kalitini kiriting');
    const ok = await api().put('/api/billz/settings').set(auth(A)).send({ secret_token: SECRET, shop_ids: [S1], sales_start: '2026-10-01', enabled: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ configured: true, enabled: true, token_hint: '…4567', shop_ids: [S1] });
    expect(ok.body.shops.map((s: { name: string }) => s.name)).toEqual(["Do'kon 1", 'Ombor']);
    expect(JSON.stringify(ok.body)).not.toContain(SECRET);
    // kalit bazada shifrlangan
    const raw = (await pool.query('SELECT secret_enc, access_token FROM billz_settings')).rows[0];
    expect(raw.secret_enc).not.toContain(SECRET);

    // yangilash (skladchi ham bosa oladi): faqat tanlangan do'kon, 501 qator — 2 sahifa
    const s1 = await api().post('/api/billz/sync').set(auth(sklad));
    expect(s1.status).toBe(200);
    expect(mock.lastStockShops).toBe(S1);
    const stock = (await api().get('/api/billz/stock').set(auth(sklad))).body;
    expect(stock).toHaveLength(501);
    expect(stock.find((r: { product_id: string }) => r.product_id === 'p7')).toMatchObject({ shop_name: "Do'kon 1", qty: '2.000', barcode: '2000000000007', retail_price: '45000.00' });
    expect((await api().get('/api/billz/stock?q=2000000000012').set(auth(sklad))).body).toHaveLength(1);
    // sotuv: bir kun bir tovar qatorlari yig'iladi
    const sales = (await api().get('/api/billz/sales?from=2026-10-01&to=2026-10-31').set(auth(sklad))).body;
    expect(sales.total).toMatchObject({ sold: '6.000', returned: '1.000', net_sales: '225000.00' });
    expect(sales.rows.find((r: { product_id: string }) => r.product_id === 'p1')).toMatchObject({ sold: '4.000', net_sold: '3.000', gross_sales: '180000.00' });
    const byDay = (await api().get('/api/billz/sales?from=2026-10-01&to=2026-10-31&by=day').set(auth(sklad))).body.rows;
    expect(byDay.map((r: { net_sales: string }) => r.net_sales)).toEqual(['90000.00', '135000.00']);

    // qayta yangilash — dublikat yo'q
    await api().post('/api/billz/sync').set(auth(sklad));
    expect((await api().get('/api/billz/stock').set(auth(sklad))).body).toHaveLength(501);
    expect((await api().get('/api/billz/sales?from=2026-10-01&to=2026-10-31').set(auth(sklad))).body.total.sold).toBe('6.000');

    // token eskirdi (401) — o'zi qayta kiradi
    const logins = mock.logins;
    mock.token = 'AT2';
    expect((await api().post('/api/billz/sync').set(auth(sklad))).status).toBe(200);
    expect(mock.logins).toBe(logins + 1);

    // limit (429) — xato jurnalga yoziladi, qoldiq saqlanib qoladi
    mock.limit = true;
    const lim = await api().post('/api/billz/sync').set(auth(sklad));
    expect(lim.status).toBe(502);
    expect(lim.body.message).toContain('limit');
    mock.limit = false;
    const st = (await api().get('/api/billz/settings').set(auth(sklad))).body;
    expect(st.runs[0]).toMatchObject({ ok: false, trigger: 'manual' });
    expect(st.runs[1]).toMatchObject({ ok: true, stock_rows: 501 });
    expect((await api().get('/api/billz/stock').set(auth(sklad))).body).toHaveLength(501);

    const hr = (await newUser(A, 'hr')).token;
    expect((await api().get('/api/billz/stock').set(auth(hr))).status).toBe(403);
  });
});
