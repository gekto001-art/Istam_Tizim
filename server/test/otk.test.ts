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
  for (const r of ['innovatsiya', 'sklad', 'bichuv', 'otk', 'tsex']) t[r] = (await newUser(A, r)).token;
  ids.color = await byName('colors');
  ids.size = await byName('sizes');
  ids.type = await byName('product-types');
  ids.supplier = await byName('suppliers');
  ids.producer = await byName('producers');
  const mk = async (name: string, unit: string) =>
    (await api().post('/api/materials').set(auth(A)).send({ name, code: uniq('O'), unit, supplier_id: ids.supplier.ISTAM })).body.id as number;
  ids.mat = { mato: await mk('mato', 'Metr'), tugma: await mk('Tugma', 'Dona') };
});

const qora = { color_id: 0, size_id: 0 };

describe('OTK (tayyor mahsulot) → tayyor mahsulot skladi va spisaniya', () => {
  it('1 sort / 2 sort skladga, yaroqsiz — tannarxda P&L xarajat', async () => {
    Object.assign(qora, { color_id: ids.color.Qora, size_id: ids.size['7--10'] });
    const [p1, p2] = Object.values(ids.producer);
    const o = (await api().post('/api/orders').set(auth(t.innovatsiya)).send({ partiya_no: uniq('O-'), order_date: '2026-10-01', product_type_id: ids.type.Rubashka })).body.order;
    await api().put(`/api/orders/${o.id}/items`).set(auth(t.innovatsiya)).send({ items: [{ ...qora, qty: 100 }] });
    const add = (body: object) => api().post(`/api/orders/${o.id}/materials`).set(auth(t.innovatsiya)).send(body);
    await add({ color_ids: [qora.color_id], material_id: ids.mat.mato, material_color_id: qora.color_id, per_unit: 0.8, price: 20000, is_main: true });
    await add({ color_ids: [qora.color_id], material_id: ids.mat.tugma, material_color_id: qora.color_id, material_size: '16', per_unit: 6, price: 100 });
    // ish narxlari: 3000 + 500 = 3500 so'm / dona
    await api().put(`/api/orders/${o.id}/works`).set(auth(t.innovatsiya)).send({ works: [{ producer_id: p1, price: 3000 }, { producer_id: p2, price: 500 }] });
    expect((await api().post(`/api/orders/${o.id}/confirm`).set(auth(t.innovatsiya))).status).toBe(200);

    // sklad: mato 20 000, tugma 100 so'm
    const mato = { material_id: ids.mat.mato, material_color_id: qora.color_id };
    const tugma = { material_id: ids.mat.tugma, material_color_id: qora.color_id, material_size: '16' };
    await api().post('/api/stock/prixod').set(auth(t.sklad)).send({ doc_date: '2026-10-01', op: 'prixod', supplier_id: ids.supplier.ISTAM, currency: 'UZS', rows: [{ ...mato, qty: 1000, price: 20000 }, { ...tugma, qty: 2000, price: 100 }] });

    // kroy: 100 dona, 80 m mato → 16 000 so'm / dona
    const cut = await api().post('/api/kroy/cuts').set(auth(t.bichuv)).send({ order_id: o.id, cut_date: '2026-10-02', cells: [{ ...qora, fact_qty: 100 }], materials: [{ ...mato, uses: [{ ...qora, qty: 80 }] }] });
    expect(cut.status).toBe(201);
    const item = (await api().get(`/api/kroy/items?order_id=${o.id}`).set(auth(t.otk))).body[0];
    await api().post('/api/kroy/otk').set(auth(t.otk)).send({ otk_date: '2026-10-03', rows: [{ item_id: item.id, first: 100, brak: 0 }] });
    await api().post('/api/kroy/issues').set(auth(t.bichuv)).send({ issue_date: '2026-10-04', order_id: o.id, producer_id: p1, rows: [{ ...qora, qty: 100 }] });
    const iss = (await api().get(`/api/tsex/issues?status=pending&producer_id=${p1}`).set(auth(t.tsex))).body.filter((x: { order_id: number }) => x.order_id === o.id);
    await api().post('/api/tsex/accept').set(auth(t.tsex)).send({ decided_date: '2026-10-05', rows: iss.map((x: { id: number }) => ({ issue_id: x.id, decision: 'accepted' })) });
    // tsex: 100 dona, tugma 6 × 100 = 600 × 100 so'm → 600 so'm / dona
    const out = await api().post('/api/tsex/outputs').set(auth(t.tsex)).send({ producer_id: p1, order_id: o.id, out_date: '2026-10-06', rows: [{ ...qora, fact_qty: 100 }] });
    expect(out.status).toBe(201);

    // OTK
    const pending = (await api().get(`/api/otk/outputs?status=pending&order_id=${o.id}`).set(auth(t.otk))).body;
    expect(pending).toHaveLength(1);
    const id = pending[0].id as number;
    const check = (rows: object[], token = t.otk) => api().post('/api/otk/outputs').set(auth(token)).send({ otk_date: '2026-10-07', rows });
    expect((await check([{ output_id: id, sort1: 90, sort2: 7, scrap: 3 }], t.tsex)).status).toBe(403);
    expect((await check([{ output_id: id, sort1: 90, sort2: 7, scrap: 2 }])).body.message).toContain('Ostatka 0');
    const ok = await check([{ output_id: id, sort1: 90, sort2: 7, scrap: 3 }]);
    expect(ok.status).toBe(200);
    // tannarx 16 000 + 600 + 3 500 = 20 100; yaroqsiz 3 × 20 100
    expect(ok.body.scrap_cost_uzs).toBe('60300.00');
    expect((await check([{ output_id: id, sort1: 100, sort2: 0, scrap: 0 }])).status).toBe(409);
    expect((await api().delete(`/api/tsex/docs/${out.body.id}`).set(auth(t.tsex))).status).toBe(409);
    expect((await api().get(`/api/otk/outputs?status=pending&order_id=${o.id}`).set(auth(t.otk))).body).toHaveLength(0);
    expect((await api().get(`/api/otk/outputs?status=done&order_id=${o.id}`).set(auth(t.otk))).body[0]).toMatchObject({ unit_cost_uzs: '20100.00', otk_scrap: 3 });

    // tayyor mahsulot skladi
    const st = (await api().get(`/api/otk/stock?order_id=${o.id}`).set(auth(t.sklad))).body;
    expect(st).toEqual([expect.objectContaining({ sort1: 90, sort2: 7, total: 97, avg_cost: '20100.00' })]);
    // spisaniya (P&L)
    const w = (await api().get('/api/otk/writeoffs').set(auth(A))).body.filter((x: { order_id: number }) => x.order_id === o.id);
    expect(w).toEqual([expect.objectContaining({ source: 'otk', qty: 3, amount_uzs: '60300.00' })]);
    const hr = (await newUser(A, 'hr')).token;
    expect((await api().get('/api/otk/stock').set(auth(hr))).status).toBe(403);
  });
});
