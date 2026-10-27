import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { classify } from '../src/routes/reports.js';
import { admin, api, auth, newUser } from './helpers.js';

afterAll(() => pool.end());

let A: string;
const SHOP = 'abc-test-shop';
beforeAll(async () => {
  A = (await admin()).token;
  // Billz sotuvlari (sinov uchun to'g'ridan-to'g'ri): sotuv summasi jami 10 000, marja 2 000 (+ zarar), soni 100
  const rows: [string, number, number, number][] = [
    // tovar, soni, sotuv summasi, marja
    ['p1', 10, 5000, -100],
    ['p2', 50, 3000, 1500],
    ['p3', 20, 1000, 300],
    ['p4', 15, 600, 200],
    ['p5', 5, 400, 0],
  ];
  for (const [id, qty, sales, margin] of rows) {
    // ikki kunga bo'lib yoziladi — yig'ilishi tekshiriladi
    for (const [d, k] of [['2025-03-01', 0.5], ['2025-03-02', 0.5]] as const) {
      await pool.query(
        `INSERT INTO billz_sales (date, shop_id, product_id, product_name, net_sold, sold, net_sales, gross_sales, net_profit)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $6, $7)`,
        [d, SHOP, id, `Tovar ${id}`, qty * k, sales * k, margin * k],
      );
    }
  }
  // boshqa do'kon va oraliqdan tashqari — hisobga kirmaydi
  await pool.query(`INSERT INTO billz_sales (date, shop_id, product_id, product_name, net_sold, net_sales, net_profit) VALUES ('2025-03-01', 'other', 'p1', 'x', 999, 999999, 999)`);
  await pool.query(`INSERT INTO billz_sales (date, shop_id, product_id, product_name, net_sold, net_sales, net_profit) VALUES ('2025-04-01', $1, 'p1', 'x', 999, 999999, 999)`, [SHOP]);
});

describe('ABC tahlil', () => {
  it('tasniflash: yig\'ma ulush 80% / 95%, manfiy va nol — C', () => {
    expect(classify([5000, 3000, 1000, 600, 400], 80, 95).map((x) => x.cls)).toEqual(['A', 'A', 'B', 'B', 'C']);
    expect(classify([-100, 1500, 300, 200, 0], 80, 95).map((x) => x.cls)).toEqual(['C', 'A', 'A', 'B', 'C']);
    expect(classify([1], 80, 95).map((x) => x.cls)).toEqual(['A']);
    expect(classify([0, 0], 80, 95).map((x) => x.cls)).toEqual(['C', 'C']);
  });

  it('marja, sotuv soni va summasi bo\'yicha (Billz sotuvlaridan)', async () => {
    const r = await api().get(`/api/reports/abc?from=2025-03-01&to=2025-03-31&shop_id=${SHOP}`).set(auth(A));
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.items.map((i: { product_id: string; abc: string }) => [i.product_id, i.abc]));
    // marja · soni · summa
    expect(by).toEqual({ p1: 'CBA', p2: 'AAA', p3: 'AAB', p4: 'BAB', p5: 'CCC' });
    expect(r.body.items[0]).toMatchObject({ product_id: 'p1', qty: 10, sales: 5000, margin: -100, margin_pct: -2 });
    expect(r.body.totals).toEqual({ qty: 100, sales: 10000, margin: 1900 });
    const sales = r.body.summary.sales;
    expect(sales.map((s: { items: number; sum_pct: number }) => [s.items, s.sum_pct])).toEqual([[2, 80], [2, 16], [1, 4]]);
    expect(r.body.combos.find((c: { abc: string }) => c.abc === 'AAA').items).toBe(1);

    // chegaralar o'zgaradi
    const r2 = await api().get(`/api/reports/abc?from=2025-03-01&to=2025-03-31&shop_id=${SHOP}&a=50&b=90`).set(auth(A));
    expect(r2.body.items.map((i: { sales_cls: string }) => i.sales_cls)).toEqual(['A', 'B', 'B', 'C', 'C']);
    expect((await api().get(`/api/reports/abc?from=2025-03-01&to=2025-03-31&a=90&b=80`).set(auth(A))).status).toBe(400);
    const sklad = (await newUser(A, 'sklad')).token;
    expect((await api().get('/api/reports/abc?from=2025-03-01&to=2025-03-31').set(auth(sklad))).status).toBe(403);
  });
});
