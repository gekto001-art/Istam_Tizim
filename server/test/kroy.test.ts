import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { admin, api, auth, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

type Named = { id: number; name: string };
let A: string;
let innov: string;
let taminot: string;
let sklad: string;
let bichuv: string;
let otk: string;
const ids: Record<string, Record<string, number>> = {};
const byName = async (path: string) =>
  Object.fromEntries(((await api().get(`/api/${path}`).set(auth(A))).body as Named[]).map((x) => [x.name, x.id]));

beforeAll(async () => {
  A = (await admin()).token;
  innov = (await newUser(A, 'innovatsiya')).token;
  taminot = (await newUser(A, 'taminot')).token;
  sklad = (await newUser(A, 'sklad')).token;
  bichuv = (await newUser(A, 'bichuv')).token;
  otk = (await newUser(A, 'otk')).token;
  ids.color = await byName('colors');
  ids.size = await byName('sizes');
  ids.type = await byName('product-types');
  ids.supplier = await byName('suppliers');
  ids.producer = await byName('producers');
  ids.mat = { mato: (await api().post('/api/materials').set(auth(A)).send({ name: 'mato', code: uniq('K'), unit: 'Metr', supplier_id: ids.supplier.XIUDONG })).body.id };
});

/** Zakaz → mato kelishuvi → yo'lga chiqish → sklad prixod → kroyga rasxod (zayavka) */
async function orderInKroy() {
  const o = (await api().post('/api/orders').set(auth(innov)).send({ partiya_no: uniq('K-'), order_date: '2026-09-01', product_type_id: ids.type.Rubashka })).body.order;
  await api()
    .put(`/api/orders/${o.id}/items`)
    .set(auth(innov))
    .send({
      items: [
        { size_id: ids.size['7--10'], color_id: ids.color.Qora, qty: 600 },
        { size_id: ids.size['11--14'], color_id: ids.color.Qora, qty: 600 },
        { size_id: ids.size['7--10'], color_id: ids.color['T-siniy'], qty: 480 },
      ],
    });
  for (const c of ['Qora', 'T-siniy']) {
    await api()
      .post(`/api/orders/${o.id}/materials`)
      .set(auth(innov))
      .send({ color_ids: [ids.color[c]], material_id: ids.mat.mato, material_color_id: ids.color[c], per_unit: 0.75, price: 14, currency: 'CNY', rate: 1790, is_main: true });
  }
  await api().post(`/api/orders/${o.id}/confirm`).set(auth(innov));
  const plan = (await api().get(`/api/purchases/orders/${o.id}`).set(auth(taminot))).body;
  const rows = plan.mato.map((r: Record<string, number>) => ({ order_material_id: r.order_material_id, supplier_id: r.supplier_id, qty: Number(r.qty), price: 14, currency: 'CNY', rate: 1790 }));
  await api().post(`/api/purchases/orders/${o.id}/send`).set(auth(taminot)).send({ stage: 'mato', rows });
  const lines = (await api().get(`/api/purchases/lines?order_id=${o.id}`).set(auth(taminot))).body as { id: number; material_color_name: string }[];
  const fact = (l: { material_color_name: string }) => (l.material_color_name === 'Qora' ? 1046 : 490);
  await api().put('/api/purchases/lines/kelishuv').set(auth(taminot)).send({ lines: lines.map((l) => ({ id: l.id, fact_qty: fact(l), decision: 'agree' })) });
  await api()
    .post(`/api/purchases/tracking/${o.id}`)
    .set(auth(taminot))
    .send({ status: 'arrived', payment_status: 'paid', tracking: 'Abu Saxiy', ship_date: '2026-09-02', shipments: lines.map((l) => ({ line_id: l.id, qty: fact(l) })) });
  expect((await api().post('/api/stock/prixod-taminot').set(auth(sklad)).send({ order_id: o.id, doc_date: '2026-09-05', rows: lines.map((l) => ({ purchase_line_id: l.id })) })).status).toBe(201);
  const mato = (c: string) => ({ material_id: ids.mat.mato, material_color_id: ids.color[c], color_code: null, material_size: null });
  const z = await api()
    .post('/api/stock/rasxod')
    .set(auth(sklad))
    .send({ kind: 'rasxod_zayavka', doc_date: '2026-09-06', op: 'peremesheniya', order_id: o.id, rows: [{ ...mato('Qora'), qty: 1046, destination: 'kroy' }, { ...mato('T-siniy'), qty: 490, destination: 'kroy' }] });
  expect(z.status).toBe(201);
  return { id: o.id as number, partiya: o.partiya_no as string, mato };
}

const cell = (c: string, s: string) => ({ color_id: ids.color[c], size_id: ids.size[s] });

describe('Bichuv (kroy) → Sifat nazorati → OTK Brak → Kroydan rasxod', () => {
  it('to\'liq jarayon (Sheets "Kroy" va "Sifat Nazorati_Bichuv")', async () => {
    const o = await orderInKroy();
    expect((await api().get('/api/kroy/orders').set(auth(bichuv))).body.some((x: { id: number }) => x.id === o.id)).toBe(true);
    const k0 = (await api().get(`/api/kroy/orders/${o.id}`).set(auth(bichuv))).body;
    expect(k0.cells.map((c: { plan_qty: number }) => c.plan_qty)).toEqual([698, 697, 654]); // reja — nakladnoydan keyingi fakt soni
    expect(k0.materials.map((m: { left_qty: string }) => m.left_qty)).toEqual(['1046.000', '490.000']);

    // 1) Kroy: fakt va sarf birga (Sheets X tekshiruvi)
    const cut = (cells: object[], materials: object[]) =>
      api().post('/api/kroy/cuts').set(auth(bichuv)).send({ order_id: o.id, cut_date: '2026-09-07', cells, materials });
    const noUse = await cut([{ ...cell('Qora', '7--10'), fact_qty: 700 }, { ...cell('Qora', '11--14'), fact_qty: 690 }], [{ ...o.mato('Qora'), uses: [{ ...cell('Qora', '7--10'), qty: 520 }] }]);
    expect(noUse.status).toBe(400);
    expect(noUse.body.message).toContain('xomashyo sarfi yo\'q');
    const noFact = await cut([{ ...cell('Qora', '7--10'), fact_qty: 700 }], [{ ...o.mato('Qora'), uses: [{ ...cell('Qora', '7--10'), qty: 520 }, { ...cell('Qora', '11--14'), qty: 1 }] }]);
    expect(noFact.body.message).toContain('fakt kiritilmagan');
    expect((await api().post('/api/kroy/cuts').set(auth(otk)).send({})).status).toBe(403);

    const ok = await cut(
      [{ ...cell('Qora', '7--10'), fact_qty: 700 }, { ...cell('Qora', '11--14'), fact_qty: 690 }, { ...cell('T-siniy', '7--10'), fact_qty: 650 }],
      [
        { ...o.mato('Qora'), uses: [{ ...cell('Qora', '7--10'), qty: 520 }, { ...cell('Qora', '11--14'), qty: 520 }] },
        { ...o.mato('T-siniy'), uses: [{ ...cell('T-siniy', '7--10'), qty: 495 }] },
      ],
    );
    expect(ok.status).toBe(201);
    // Sheets'dagidek minusga kirish to'xtatilmaydi — ogohlantirish
    expect(ok.body.warnings).toHaveLength(1);
    expect(ok.body.materials.map((m: { left_qty: string }) => m.left_qty)).toEqual(['6.000', '-5.000']);
    expect(ok.body.cells.map((c: { cut_qty: number }) => c.cut_qty)).toEqual([700, 690, 650]);

    // 2) Sifat nazorati
    const items = (await api().get(`/api/kroy/items?order_id=${o.id}&otk=pending`).set(auth(otk))).body as { id: number; color_name: string; size_name: string; unit_cost: string }[];
    expect(items).toHaveLength(3);
    const id = (c: string, s: string) => items.find((i) => i.color_name === c && i.size_name === s)!.id;
    const check = (rows: object[], token = otk) => api().post('/api/kroy/otk').set(auth(token)).send({ otk_date: '2026-09-08', rows });
    expect((await check([{ item_id: id('Qora', '7--10'), first: 690, brak: 10 }], bichuv)).status).toBe(403);
    expect((await check([{ item_id: id('Qora', '7--10'), first: 690, brak: 5 }])).body.message).toContain('Ostatka 0');
    expect(
      (
        await check([
          { item_id: id('Qora', '7--10'), first: 690, brak: 10 },
          { item_id: id('Qora', '11--14'), first: 690, brak: 0 },
          { item_id: id('T-siniy', '7--10'), first: 640, brak: 10 },
        ])
      ).status,
    ).toBe(200);
    expect((await check([{ item_id: id('Qora', '11--14'), first: 690, brak: 0 }])).status).toBe(409);
    expect((await api().delete(`/api/kroy/cuts/${ok.body.id}`).set(auth(bichuv))).status).toBe(409);

    // 3) OTK Brak → kroyda saralash
    const brak = (await api().get(`/api/kroy/items?order_id=${o.id}&otk=brak`).set(auth(bichuv))).body;
    expect(brak.map((b: { otk_brak: number }) => b.otk_brak)).toEqual([10, 10]);
    const sort = (rows: object[]) => api().post('/api/kroy/brak').set(auth(bichuv)).send({ sort_date: '2026-09-09', rows });
    expect((await sort([{ item_id: id('Qora', '7--10'), sort1: 4, sort2: 3, scrap: 2 }])).body.message).toContain('Ostatka 0');
    expect((await sort([{ item_id: id('Qora', '7--10'), sort1: 4, sort2: 3, scrap: 3 }])).status).toBe(200);
    const done = (await api().get(`/api/kroy/items?order_id=${o.id}&otk=brak_done`).set(auth(bichuv))).body[0];
    // yaroqsiz — P&L xarajat: 3 × (sarf tannarxi ÷ kesilgan son)
    expect(Math.abs(Number(done.scrap_cost_uzs) - 3 * Number(done.unit_cost))).toBeLessThan(0.05);
    expect(Number(done.scrap_cost_uzs)).toBeGreaterThan(0);

    // 4) Kroyda turgan yarim tayyor: OTK 1 sort + brakdan 1 va 2 sort
    const semi = async () =>
      Object.fromEntries(((await api().get(`/api/kroy/semi?order_id=${o.id}`).set(auth(bichuv))).body as Record<string, string | number>[]).map((r) => [`${r.color_name} ${r.size_name}`, r.left_qty]));
    expect(await semi()).toEqual({ 'Qora 7--10': 697, 'Qora 11--14': 690, 'T-siniy 7--10': 640 });

    // 5) Kroydan rasxod
    const tsex = Object.values(ids.producer)[0];
    const issue = (rows: object[]) => api().post('/api/kroy/issues').set(auth(bichuv)).send({ issue_date: '2026-09-10', order_id: o.id, producer_id: tsex, rows });
    const over = await issue([{ ...cell('Qora', '7--10'), qty: 698 }]);
    expect(over.status).toBe(400);
    expect(over.body.message).toContain('qoldiq miqdori kam');
    const i1 = await issue([{ ...cell('Qora', '7--10'), qty: 600 }, { ...cell('Qora', '11--14'), qty: 690 }]);
    expect(i1.body.issue_no).toBe(`${o.partiya}_1`);
    const i2 = await issue([{ ...cell('T-siniy', '7--10'), qty: 100 }]);
    expect(i2.body.issue_no).toBe(`${o.partiya}_2`);
    expect(await semi()).toEqual({ 'Qora 7--10': 97, 'T-siniy 7--10': 540 });
    const iss = (await api().get(`/api/kroy/issues?order_id=${o.id}`).set(auth(bichuv))).body;
    expect(iss[0]).toMatchObject({ status: 'pending', issue_no: `${o.partiya}_2` });
    expect((await api().delete(`/api/kroy/issues/${iss[0].id}`).set(auth(bichuv))).status).toBe(204);
    expect((await semi())['T-siniy 7--10']).toBe(640);

    // 6) Yopilgan zakazlar
    expect((await api().post(`/api/kroy/orders/${o.id}/close`).set(auth(bichuv)).send({ closed_at: '2026-09-11', note: 'tugadi' })).status).toBe(204);
    expect((await api().get('/api/kroy/orders').set(auth(bichuv))).body.some((x: { id: number }) => x.id === o.id)).toBe(false);
    expect((await cut([{ ...cell('Qora', '7--10'), fact_qty: 1 }], [{ ...o.mato('Qora'), uses: [{ ...cell('Qora', '7--10'), qty: 1 }] }])).status).toBe(409);
    const closed = (await api().get('/api/kroy/closed').set(auth(bichuv))).body;
    expect(closed.closed.some((x: { id: number }) => x.id === o.id)).toBe(true);
    expect(closed.minus.find((m: { order_id: number }) => m.order_id === o.id)).toMatchObject({ material_color_name: 'T-siniy', left_qty: '-5.000' });
    expect((await api().post(`/api/kroy/orders/${o.id}/reopen`).set(auth(bichuv))).status).toBe(204);
    const hr = (await newUser(A, 'hr')).token;
    expect((await api().get('/api/kroy/semi').set(auth(hr))).status).toBe(403);
  });
});
