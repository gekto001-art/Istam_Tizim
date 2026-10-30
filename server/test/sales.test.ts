import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { admin, api, auth, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

type Named = { id: number; name: string };
let A: string;
const t: Record<string, string> = {};
const ids: Record<string, Record<string, number>> = {};
const byName = async (path: string) =>
  Object.fromEntries(((await api().get(`/api/${path}`).set(auth(A))).body as Named[]).map((x) => [x.name, x.id]));

beforeAll(async () => {
  A = (await admin()).token;
  for (const r of ['innovatsiya', 'sklad', 'bichuv', 'otk', 'tsex', 'sotuv', 'buxgalter', 'hr']) t[r] = (await newUser(A, r)).token;
  ids.color = await byName('colors');
  ids.size = await byName('sizes');
  ids.type = await byName('product-types');
  ids.supplier = await byName('suppliers');
  ids.producer = await byName('producers');
  ids.mat = {
    mato: (await api().post('/api/materials').set(auth(A)).send({ name: 'mato', code: uniq('S'), unit: 'Metr', supplier_id: ids.supplier.ISTAM })).body.id,
  };
});

/** Zakaz → kroy → tsex → OTK: 1 sort 90, 2 sort 7 dona, tannarx 20 000 so'm (16 000 mato + 4 000 ish) */
async function readyGoods() {
  const cell = { color_id: ids.color.Qora, size_id: ids.size['7--10'] };
  const [p1] = Object.values(ids.producer);
  const o = (await api().post('/api/orders').set(auth(t.innovatsiya)).send({ partiya_no: uniq('S-'), order_date: '2027-03-01', product_type_id: ids.type.Rubashka })).body.order;
  await api().put(`/api/orders/${o.id}/items`).set(auth(t.innovatsiya)).send({ items: [{ ...cell, qty: 100 }] });
  await api().post(`/api/orders/${o.id}/materials`).set(auth(t.innovatsiya)).send({ color_ids: [cell.color_id], material_id: ids.mat.mato, material_color_id: cell.color_id, per_unit: 0.8, price: 20000, is_main: true });
  await api().put(`/api/orders/${o.id}/works`).set(auth(t.innovatsiya)).send({ works: [{ producer_id: p1, price: 4000 }] });
  await api().post(`/api/orders/${o.id}/confirm`).set(auth(t.innovatsiya));
  const mato = { material_id: ids.mat.mato, material_color_id: cell.color_id };
  await api().post('/api/stock/prixod').set(auth(t.sklad)).send({ doc_date: '2027-03-01', op: 'prixod', supplier_id: ids.supplier.ISTAM, currency: 'UZS', rows: [{ ...mato, qty: 1000, price: 20000 }] });
  await api().post('/api/kroy/cuts').set(auth(t.bichuv)).send({ order_id: o.id, cut_date: '2027-03-02', cells: [{ ...cell, fact_qty: 100 }], materials: [{ ...mato, uses: [{ ...cell, qty: 80 }] }] });
  const item = (await api().get(`/api/kroy/items?order_id=${o.id}`).set(auth(t.otk))).body[0];
  await api().post('/api/kroy/otk').set(auth(t.otk)).send({ otk_date: '2027-03-03', rows: [{ item_id: item.id, first: 100, brak: 0 }] });
  await api().post('/api/kroy/issues').set(auth(t.bichuv)).send({ issue_date: '2027-03-04', order_id: o.id, producer_id: p1, rows: [{ ...cell, qty: 100 }] });
  const iss = (await api().get(`/api/tsex/issues?status=pending&producer_id=${p1}`).set(auth(t.tsex))).body.filter((x: { order_id: number }) => x.order_id === o.id);
  await api().post('/api/tsex/accept').set(auth(t.tsex)).send({ decided_date: '2027-03-05', rows: iss.map((x: { id: number }) => ({ issue_id: x.id, decision: 'accepted' })) });
  await api().post('/api/tsex/outputs').set(auth(t.tsex)).send({ producer_id: p1, order_id: o.id, out_date: '2027-03-06', rows: [{ ...cell, fact_qty: 100 }] });
  const out = (await api().get(`/api/otk/outputs?status=pending&order_id=${o.id}`).set(auth(t.otk))).body[0];
  const r = await api().post('/api/otk/outputs').set(auth(t.otk)).send({ otk_date: '2027-03-07', rows: [{ output_id: out.id, sort1: 90, sort2: 7, scrap: 3 }] });
  expect(r.status).toBe(200);
  return { order: o as { id: number; partiya_no: string }, cell };
}

describe('Sotuv bo\'limi: ishlab chiqarishdan prixod va hisob-kitob', () => {
  it('ichki narx → o\'tkazma → qabul / rad → qarz va to\'lov', async () => {
    const { order, cell } = await readyGoods();
    const stock = async () => (await api().get(`/api/otk/stock?order_id=${order.id}`).set(auth(t.sklad))).body[0];
    expect(await stock()).toMatchObject({ sort1: 90, sort2: 7, avg_cost: '20000.00', sale_price1: null });
    const send = (rows: object[], token = t.sklad, doc_date = '2027-03-10') =>
      api().post('/api/sales/transfers').set(auth(token)).send({ doc_date, rows: rows.map((r) => ({ order_id: order.id, ...cell, ...r })) });

    // narx belgilanmaguncha yuborib bo'lmaydi
    expect((await send([{ sort: 1, qty: 10 }])).body.message).toContain('narxi belgilanmagan');
    // ichki narx: tasdiqlangan zakazda ham; sotuv o'zgartira olmaydi
    const price = (token: string, body: object) => api().put(`/api/orders/${order.id}/sale-price`).set(auth(token)).send(body);
    expect((await price(t.sotuv, { sale_price1: 1, sale_price2: 1 })).status).toBe(403);
    const pr = await price(t.innovatsiya, { sale_price1: 30000, sale_price2: 15000 });
    expect(pr.status).toBe(200);
    expect(pr.body.order).toMatchObject({ sale_price1: '30000.00', sale_price2: '15000.00' });

    // o'tkazma: faqat sklad; skladdagidan ko'p emas; bir xil qator ikki marta emas
    expect((await send([{ sort: 1, qty: 10 }], t.sotuv)).status).toBe(403);
    expect((await send([{ sort: 2, qty: 8 }])).body.message).toContain('skladda 7 dona');
    expect((await send([{ sort: 1, qty: 1 }, { sort: 1, qty: 2 }])).status).toBe(400);
    const t1 = await send([{ sort: 1, qty: 50 }, { sort: 2, qty: 5 }]);
    expect(t1.status).toBe(201);
    expect(t1.body).toMatchObject({ status: 'sent', qty: 55, amount_uzs: '1575000.00', cost_uzs: '1100000.00' });
    expect(await stock()).toMatchObject({ sort1: 40, sort2: 2, avg_cost: '20000.00' });

    // keyin narx o'zgarsa ham yuborilgan o'tkazma narxi o'zgarmaydi
    await price(t.innovatsiya, { sale_price1: 32000, sale_price2: 15000 });

    // Sotuv qabul qiladi
    const decide = (id: number, body: object, token = t.sotuv) => api().post(`/api/sales/transfers/${id}/decide`).set(auth(token)).send({ decided_date: '2027-03-11', ...body });
    expect((await decide(t1.body.id, { decision: 'accepted' }, t.sklad)).status).toBe(403);
    expect((await decide(t1.body.id, { decision: 'accepted', decided_date: '2027-03-09' })).status).toBe(400);
    expect((await decide(t1.body.id, { decision: 'accepted' })).body.status).toBe('accepted');
    expect((await decide(t1.body.id, { decision: 'rejected', reason: 'x' })).status).toBe(409);
    expect((await api().delete(`/api/sales/transfers/${t1.body.id}`).set(auth(t.sklad))).status).toBe(409);

    // rad etilgani skladga qaytadi; sababsiz rad etib bo'lmaydi
    const t2 = await send([{ sort: 1, qty: 10 }], t.sklad, '2027-03-12');
    expect(t2.body.amount_uzs).toBe('320000.00');
    expect((await stock()).sort1).toBe(30);
    expect((await decide(t2.body.id, { decision: 'rejected', decided_date: '2027-03-12' })).status).toBe(400);
    expect((await decide(t2.body.id, { decision: 'rejected', decided_date: '2027-03-12', reason: 'Etiketka yo\'q' })).body).toMatchObject({ status: 'rejected', reject_reason: 'Etiketka yo\'q' });
    expect((await stock()).sort1).toBe(40);

    // javob kutayotganini sklad o'chira oladi — skladga qaytadi
    const t3 = await send([{ sort: 2, qty: 2 }], t.sklad, '2027-03-13');
    expect((await stock()).sort2).toBe(0);
    const sent = (await api().get('/api/sales/transfers?status=sent').set(auth(t.sotuv))).body;
    expect(sent.map((x: { id: number }) => x.id)).toContain(t3.body.id);
    expect((await api().delete(`/api/sales/transfers/${t3.body.id}`).set(auth(t.sklad))).status).toBe(204);
    expect((await stock()).sort2).toBe(2);

    // to'lovlar: buxgalter; sotuv emas
    const pay = (token: string, body: object) => api().post('/api/sales/payments').set(auth(token)).send({ method: 'naqd', ...body });
    expect((await pay(t.sotuv, { pay_date: '2027-03-15', amount_uzs: 100 })).status).toBe(403);
    expect((await pay(t.buxgalter, { pay_date: '2027-03-15', amount_uzs: 0 })).status).toBe(400);
    const p1 = await pay(t.buxgalter, { pay_date: '2027-03-15', amount_uzs: 1000000 });
    expect(p1.status).toBe(201);
    const p2 = await pay(t.buxgalter, { pay_date: '2027-04-02', amount_uzs: 75000, method: 'bank' });

    // hisob-kitob: qarz = qabul qilingan − to'lov; foyda = ichki narx − tannarx
    const ledger = async (qs: string) => (await api().get(`/api/sales/ledger?${qs}`).set(auth(t.sotuv))).body;
    const march = await ledger('from=2027-03-01&to=2027-03-31');
    expect(march.opening).toBe('0.00');
    expect(march.rows.map((r: { kind: string; balance: string }) => [r.kind, r.balance])).toEqual([
      ['transfer', '1575000.00'],
      ['payment', '575000.00'],
    ]);
    expect(march.totals).toMatchObject({ debit: '1575000.00', credit: '1000000.00', closing: '575000.00', cost: '1100000.00', margin: '475000.00' });
    const april = await ledger('from=2027-04-01');
    expect(april.opening).toBe('575000.00');
    expect(april.totals.closing).toBe('500000.00');
    expect((await api().delete(`/api/sales/payments/${p2.body.id}`).set(auth(t.buxgalter))).status).toBe(204);
    expect((await ledger('from=2027-04-01')).totals.closing).toBe('575000.00');

    expect((await api().get('/api/sales/ledger').set(auth(t.hr))).status).toBe(403);
  });
});
