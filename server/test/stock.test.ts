import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { admin, api, auth, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

type Named = { id: number; name: string };
let A: string;
let innov: string;
let taminot: string;
let sklad: string;
const ids: Record<string, Record<string, number>> = {};
const byName = async (path: string) =>
  Object.fromEntries(((await api().get(`/api/${path}`).set(auth(A))).body as Named[]).map((x) => [x.name, x.id]));

beforeAll(async () => {
  A = (await admin()).token;
  innov = (await newUser(A, 'innovatsiya')).token;
  taminot = (await newUser(A, 'taminot')).token;
  sklad = (await newUser(A, 'sklad')).token;
  ids.color = await byName('colors');
  ids.size = await byName('sizes');
  ids.type = await byName('product-types');
  ids.supplier = await byName('suppliers');
  ids.producer = await byName('producers');
  const mk = async (name: string, unit: string, supplier: string) =>
    (await api().post('/api/materials').set(auth(A)).send({ name, code: uniq('K'), unit, supplier_id: ids.supplier[supplier] })).body.id as number;
  ids.mat = { mato: await mk('mato', 'Metr', 'XIUDONG'), ip: await mk('Ip', 'Dona', 'ISTAM') };
});

/**
 * 247-partiya: mato kelishilgan (Qora 1046 m, T-siniy 490 m, 14 yuan, kurs 1790), to'liq yo'lga chiqqan.
 */
async function shippedOrder() {
  const o = (await api().post('/api/orders').set(auth(innov)).send({ partiya_no: uniq('247-'), order_date: '2026-08-25', product_type_id: ids.type.Rubashka })).body.order;
  await api()
    .put(`/api/orders/${o.id}/items`)
    .set(auth(innov))
    .send({ items: [{ size_id: ids.size['7--10'], color_id: ids.color.Qora, qty: 1200 }, { size_id: ids.size['7--10'], color_id: ids.color['T-siniy'], qty: 480 }] });
  for (const c of ['Qora', 'T-siniy']) {
    await api()
      .post(`/api/orders/${o.id}/materials`)
      .set(auth(innov))
      .send({ color_ids: [ids.color[c]], material_id: ids.mat.mato, material_color_id: ids.color[c], color_code: '5', per_unit: 0.75, price: 14, currency: 'CNY', rate: 1790, is_main: true });
  }
  expect((await api().post(`/api/orders/${o.id}/confirm`).set(auth(innov))).status).toBe(200);
  const plan = (await api().get(`/api/purchases/orders/${o.id}`).set(auth(taminot))).body;
  const rows = plan.mato.map((r: Record<string, string | number>) => ({
    order_material_id: r.order_material_id, supplier_id: r.supplier_id, qty: Number(r.qty), price: 14, currency: 'CNY', rate: 1790,
  }));
  expect((await api().post(`/api/purchases/orders/${o.id}/send`).set(auth(taminot)).send({ stage: 'mato', rows })).status).toBe(201);
  const lines = (await api().get(`/api/purchases/lines?order_id=${o.id}`).set(auth(taminot))).body as { id: number; material_color_name: string }[];
  const fact = (l: { material_color_name: string }) => (l.material_color_name === 'Qora' ? 1046 : 490);
  await api().put('/api/purchases/lines/kelishuv').set(auth(taminot)).send({ lines: lines.map((l) => ({ id: l.id, fact_qty: fact(l), decision: 'agree' })) });
  const t = await api()
    .post(`/api/purchases/tracking/${o.id}`)
    .set(auth(taminot))
    .send({ status: 'in_transit', payment_status: 'paid', tracking: 'Abu Saxiy', ship_date: '2026-08-26', shipments: lines.map((l) => ({ line_id: l.id, qty: fact(l) })) });
  expect(t.status).toBe(200);
  return { id: o.id as number, lines: Object.fromEntries(lines.map((l) => [l.material_color_name, l.id])) };
}

const item = (color: string) => ({ material_id: ids.mat.mato, material_color_id: ids.color[color], color_code: '5', material_size: null });
const balanceOf = async (materialId: number) =>
  (await api().get(`/api/stock/balance?material_id=${materialId}`).set(auth(sklad))).body as Record<string, string>[];

describe('Xomashyo skladi (Sheets "Xomashyo Sklad")', () => {
  it('Prixod (Ta\'minot orqali) → Rasxod (Zayavka) → Nakladnoy', async () => {
    const o = await shippedOrder();
    // yo'ldagi tovar
    expect((await api().get('/api/stock/transit').set(auth(sklad))).body.some((x: { order_id: number }) => x.order_id === o.id)).toBe(true);
    const tr = (await api().get(`/api/stock/transit/${o.id}`).set(auth(sklad))).body;
    expect(tr.map((l: { transit_qty: string }) => l.transit_qty).sort()).toEqual(['1046.000', '490.000']);

    const body = {
      order_id: o.id,
      doc_date: '2026-09-02',
      rows: [{ purchase_line_id: o.lines.Qora, fact_qty: 1040 }, { purchase_line_id: o.lines['T-siniy'] }], // T-siniy: fakt = yuborilgan
      expenses: [
        { category: 'Kargo', supplier_id: ids.supplier.XIUDONG, amount: 10120000, currency: 'UZS' },
        { category: 'Bojxona', supplier_id: ids.supplier.XIUDONG, amount: 390000, currency: 'UZS' },
        { category: 'Boshqa xarajatlar', supplier_id: ids.supplier.XIUDONG, amount: 800000, currency: 'UZS' },
      ],
    };
    expect((await api().post('/api/stock/prixod-taminot').set(auth(taminot)).send(body)).status).toBe(403);
    expect((await api().post('/api/stock/prixod-taminot').set(auth(sklad)).send({ ...body, rows: [{ purchase_line_id: 999999 }] })).status).toBe(400);
    expect((await api().post('/api/stock/prixod-taminot').set(auth(sklad)).send(body)).status).toBe(201);

    // qo'shimcha 11 310 000 so'm Miqdor real ulushida: 1040 / 1530 va 490 / 1530
    const pm = (await api().get(`/api/stock/moves?kind=prixod_taminot&order_id=${o.id}`).set(auth(sklad))).body as Record<string, string>[];
    const qora = pm.find((m) => m.material_color_name === 'Qora')!;
    expect(qora).toMatchObject({ qty: '1040.000', sent_qty: '1046.000', amount_uzs: '26062400.00', extra_uzs: '7687843.14', cost_uzs: '33750243.14' });
    expect(pm.find((m) => m.material_color_name === 'T-siniy')).toMatchObject({ qty: '490.000', amount_uzs: '12279400.00', extra_uzs: '3622156.86' });
    const bal = await balanceOf(ids.mat.mato);
    expect(bal.find((b) => b.material_color_name === 'Qora')).toMatchObject({ qty: '1040.000', avg_cost: '32452.1569' });
    // Qora: 6 m hali "yo'lda" (Sheets'dagidek yuborilgan − fakt)
    expect((await api().get(`/api/stock/transit/${o.id}`).set(auth(sklad))).body.map((l: { transit_qty: string }) => l.transit_qty)).toEqual(['6.000']);

    // Rasxod (Zayavka): partiya qoldig'i
    expect((await api().get('/api/stock/zayavka').set(auth(sklad))).body.some((x: { order_id: number }) => x.order_id === o.id)).toBe(true);
    const z = (await api().get(`/api/stock/zayavka/${o.id}`).set(auth(sklad))).body;
    expect(z.items.map((i: { left_qty: string }) => i.left_qty)).toEqual(['1040.000', '490.000']);
    const tsex = Object.values(ids.producer)[0];
    const rasxod = (rows: object[], op = 'peremesheniya') =>
      api().post('/api/stock/rasxod').set(auth(sklad)).send({ kind: 'rasxod_zayavka', doc_date: '2026-09-03', op, order_id: o.id, rows });
    expect((await rasxod([{ ...item('Qora'), qty: 10 }])).body.message).toContain('qayergaligini');
    const r1 = await rasxod([
      { ...item('Qora'), qty: 1000, destination: 'kroy' },
      { ...item('T-siniy'), qty: 490, destination: 'producer', producer_id: tsex },
    ]);
    expect(r1.status).toBe(201);
    // Farq manfiy: omborda 40 m qoldi
    const over = await rasxod([{ ...item('Qora'), qty: 41, destination: 'kroy' }]);
    expect(over.status).toBe(400);
    expect(over.body.message).toContain('Farq');
    expect((await rasxod([{ ...item('Qora'), qty: 10, destination: 'kroy' }], 'vozvrat')).status).toBe(201);
    expect((await balanceOf(ids.mat.mato)).find((b) => b.material_color_name === 'Qora')!.qty).toBe('50.000');
    const z2 = (await api().get(`/api/stock/zayavka/${o.id}`).set(auth(sklad))).body;
    expect(z2.items.map((i: { left_qty: string }) => i.left_qty)).toEqual(['50.000', '0.000']);
    // rasxod narxi — o'rtacha tannarx
    const rm = (await api().get(`/api/stock/moves?kind=rasxod_zayavka&order_id=${o.id}`).set(auth(sklad))).body as Record<string, string>[];
    expect(rm.find((m) => m.qty === '1000.000')).toMatchObject({ dir: -1, cost_uzs: '32452156.87', destination: 'kroy' });

    const n = (await api().get(`/api/stock/nakladnoy/${o.id}`).set(auth(sklad))).body;
    expect(n.order.id).toBe(o.id);
    expect(n.rows).toHaveLength(3);
  });

  it('Prixod (oddiy), Sotuv, vozvrat, o\'rtacha tannarx va hujjatni o\'chirish', async () => {
    const ip = { material_id: ids.mat.ip, material_color_id: ids.color.Qora };
    const prixod = (rows: object[], op = 'prixod') =>
      api().post('/api/stock/prixod').set(auth(sklad)).send({ doc_date: '2026-09-05', op, supplier_id: ids.supplier.ISTAM, currency: 'UZS', rows });
    const p1 = await prixod([{ ...ip, qty: 1000, price: 50 }]);
    expect(p1.status).toBe(201);
    const p2 = await prixod([{ ...ip, qty: 1000, price: 70 }]);
    expect((await balanceOf(ids.mat.ip))[0]).toMatchObject({ qty: '2000.000', avg_cost: '60.0000', value_uzs: '120000.00' });

    const sotuv = (rows: object[], op = 'sotuv') =>
      api().post('/api/stock/sotuv').set(auth(sklad)).send({ doc_date: '2026-09-06', op, counterparty: '1-ISTAM KO\'YLAK', rows });
    expect((await sotuv([{ ...ip, qty: 500, price: 100 }])).status).toBe(201);
    expect((await sotuv([{ ...ip, qty: 2000, price: 100 }])).status).toBe(400);
    expect((await prixod([{ ...ip, qty: 200, price: 60 }], 'vozvrat')).status).toBe(201); // postavshikka qaytarish
    const s = (await api().get(`/api/stock/moves?kind=sotuv&material_id=${ids.mat.ip}`).set(auth(sklad))).body[0];
    expect(s).toMatchObject({ amount_uzs: '50000.00', cost_uzs: '30000.00', counterparty: '1-ISTAM KO\'YLAK' });
    expect((await balanceOf(ids.mat.ip))[0].qty).toBe('1300.000');

    // o'chirish: 1-prixod o'chsa 300 qoladi — mumkin; keyin 2-prixod o'chsa manfiy — mumkin emas
    expect((await api().delete(`/api/stock/docs/${p1.body.id}`).set(auth(sklad))).status).toBe(204);
    expect((await api().delete(`/api/stock/docs/${p2.body.id}`).set(auth(sklad))).status).toBe(400);
    expect((await api().delete(`/api/stock/docs/${p2.body.id}`).set(auth(taminot))).status).toBe(403);
    expect((await balanceOf(ids.mat.ip))[0].qty).toBe('300.000');
    // ruxsat: HR ko'ra olmaydi
    const hr = (await newUser(A, 'hr')).token;
    expect((await api().get('/api/stock/balance').set(auth(hr))).status).toBe(403);
  });
});
