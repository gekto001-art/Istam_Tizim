import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { admin, api, auth, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

type Named = { id: number; name: string };
let A: string;
let innov: string;
let sklad: string;
let bichuv: string;
let otk: string;
let tsex: string;
const ids: Record<string, Record<string, number>> = {};
const byName = async (path: string) =>
  Object.fromEntries(((await api().get(`/api/${path}`).set(auth(A))).body as Named[]).map((x) => [x.name, x.id]));

beforeAll(async () => {
  A = (await admin()).token;
  innov = (await newUser(A, 'innovatsiya')).token;
  sklad = (await newUser(A, 'sklad')).token;
  bichuv = (await newUser(A, 'bichuv')).token;
  otk = (await newUser(A, 'otk')).token;
  tsex = (await newUser(A, 'tsex')).token;
  ids.color = await byName('colors');
  ids.size = await byName('sizes');
  ids.type = await byName('product-types');
  ids.supplier = await byName('suppliers');
  ids.producer = await byName('producers');
  const mk = async (name: string, unit: string) =>
    (await api().post('/api/materials').set(auth(A)).send({ name, code: uniq('T'), unit, supplier_id: ids.supplier.ISTAM })).body.id as number;
  ids.mat = { mato: await mk('mato', 'Metr'), tugma: await mk('Tugma', 'Dona'), ip: await mk('Ip', 'Dona') };
});

const cell = (c: string, s: string) => ({ color_id: ids.color[c], size_id: ids.size[s] });

/** Zakaz → kroy → OTK → kroydan rasxod (tsexga) */
async function issuedToTsex(tsexId: number) {
  const o = (await api().post('/api/orders').set(auth(innov)).send({ partiya_no: uniq('T-'), order_date: '2026-10-01', product_type_id: ids.type.Rubashka })).body.order;
  await api()
    .put(`/api/orders/${o.id}/items`)
    .set(auth(innov))
    .send({ items: [{ ...cell('Qora', '7--10'), qty: 100 }, { ...cell('Qora', '11--14'), qty: 100 }, { ...cell('T-siniy', '7--10'), qty: 50 }] });
  const add = (body: object) => api().post(`/api/orders/${o.id}/materials`).set(auth(innov)).send(body);
  for (const c of ['Qora', 'T-siniy']) await add({ color_ids: [ids.color[c]], material_id: ids.mat.mato, material_color_id: ids.color[c], per_unit: 0.75, price: 1000, is_main: true });
  await add({ color_ids: [ids.color.Qora, ids.color['T-siniy']], material_id: ids.mat.tugma, material_color_id: ids.color.Qora, material_size: '16', per_unit: 6, price: 100 });
  await add({ color_ids: [ids.color.Qora], size_id: ids.size['7--10'], material_id: ids.mat.ip, per_unit: 0.5, price: 10 });
  expect((await api().post(`/api/orders/${o.id}/confirm`).set(auth(innov))).status).toBe(200);
  const mato = (c: string) => ({ material_id: ids.mat.mato, material_color_id: ids.color[c] });
  const cut = await api()
    .post('/api/kroy/cuts')
    .set(auth(bichuv))
    .send({
      order_id: o.id,
      cut_date: '2026-10-02',
      cells: [{ ...cell('Qora', '7--10'), fact_qty: 100 }, { ...cell('Qora', '11--14'), fact_qty: 100 }, { ...cell('T-siniy', '7--10'), fact_qty: 50 }],
      materials: [
        { ...mato('Qora'), uses: [{ ...cell('Qora', '7--10'), qty: 75 }, { ...cell('Qora', '11--14'), qty: 75 }] },
        { ...mato('T-siniy'), uses: [{ ...cell('T-siniy', '7--10'), qty: 38 }] },
      ],
    });
  expect(cut.status).toBe(201);
  const items = (await api().get(`/api/kroy/items?order_id=${o.id}`).set(auth(otk))).body as { id: number; fact_qty: number }[];
  await api().post('/api/kroy/otk').set(auth(otk)).send({ otk_date: '2026-10-03', rows: items.map((i) => ({ item_id: i.id, first: i.fact_qty, brak: 0 })) });
  const issue = (rows: object[]) => api().post('/api/kroy/issues').set(auth(bichuv)).send({ issue_date: '2026-10-04', order_id: o.id, producer_id: tsexId, rows });
  expect((await issue([{ ...cell('Qora', '7--10'), qty: 100 }, { ...cell('Qora', '11--14'), qty: 100 }])).status).toBe(201);
  expect((await issue([{ ...cell('T-siniy', '7--10'), qty: 50 }])).status).toBe(201);
  return { id: o.id as number, partiya: o.partiya_no as string };
}

describe('Tsex: Prixod_Kroy → Ishlab chiqarish → Ostatka (Sheets "Ishlab Chiqarish ko\'ylak / Shim")', () => {
  it('to\'liq jarayon', async () => {
    const tsexId = ids.producer["1-ISTAM KO'YLAK"] ?? Object.values(ids.producer)[0];
    const o = await issuedToTsex(tsexId);

    // 1) Prixod_Kroy: Tasdiqlash / Rad etish
    const pending = (await api().get(`/api/tsex/issues?status=pending&producer_id=${tsexId}`).set(auth(tsex))).body.filter(
      (x: { order_id: number }) => x.order_id === o.id,
    ) as { id: number; color_name: string; issue_no: string }[];
    expect(pending.map((x) => x.issue_no)).toEqual([`${o.partiya}_1`, `${o.partiya}_1`, `${o.partiya}_2`]);
    const decide = (rows: object[], token = tsex) => api().post('/api/tsex/accept').set(auth(token)).send({ decided_date: '2026-10-05', rows });
    const rows = pending.map((x) => ({ issue_id: x.id, decision: x.color_name === 'Qora' ? 'accepted' : 'rejected' }));
    expect((await decide(rows, bichuv)).status).toBe(403);
    expect((await decide(rows)).body).toEqual({ accepted: 2, rejected: 1 });
    expect((await decide(rows.slice(0, 1))).status).toBe(409);
    // rad etilgani kroyga qaytadi; qabul qilingani kroydan o'chirilmaydi
    const semi = (await api().get(`/api/kroy/semi?order_id=${o.id}`).set(auth(bichuv))).body;
    expect(semi.map((r: { color_name: string; left_qty: number }) => `${r.color_name}:${r.left_qty}`)).toEqual(['T-siniy:50']);
    const kroyIssues = (await api().get(`/api/kroy/issues?order_id=${o.id}`).set(auth(bichuv))).body as { id: number; status: string }[];
    expect((await api().delete(`/api/kroy/issues/${kroyIssues.find((x) => x.status === 'accepted')!.id}`).set(auth(bichuv))).status).toBe(409);

    // 2) Tsexga furnitura: sklad prixod → shu tsexga rasxod
    const tugma = { material_id: ids.mat.tugma, material_color_id: ids.color.Qora, material_size: '16' };
    await api().post('/api/stock/prixod').set(auth(sklad)).send({ doc_date: '2026-10-01', op: 'prixod', supplier_id: ids.supplier.ISTAM, currency: 'UZS', rows: [{ ...tugma, qty: 2000, price: 100 }] });
    expect(
      (
        await api()
          .post('/api/stock/rasxod')
          .set(auth(sklad))
          .send({ kind: 'rasxod', doc_date: '2026-10-04', op: 'peremesheniya', order_id: o.id, rows: [{ ...tugma, qty: 1500, destination: 'producer', producer_id: tsexId }] })
      ).status,
    ).toBe(201);

    // 3) Ishlab chiqarish
    const plan = (await api().get(`/api/tsex/plan?producer_id=${tsexId}&order_id=${o.id}`).set(auth(tsex))).body;
    expect(plan.cells.map((c: { color_name: string; size_name: string; left_qty: number }) => `${c.color_name} ${c.size_name}:${c.left_qty}`)).toEqual([
      'Qora 7--10:100',
      'Qora 11--14:100',
    ]);
    expect(plan.norms).toHaveLength(3);
    expect(plan.materials[0]).toMatchObject({ left_qty: '1500.000' });
    expect(plan.issue_nos.map((x: { issue_no: string }) => x.issue_no)).toEqual([`${o.partiya}_1`]);
    const out = (r: object[]) => api().post('/api/tsex/outputs').set(auth(tsex)).send({ producer_id: tsexId, order_id: o.id, out_date: '2026-10-06', rows: r });
    const over = await out([{ ...cell('Qora', '7--10'), fact_qty: 101 }]);
    expect(over.status).toBe(400);
    expect(over.body.message).toContain('tikilmagan 100');
    expect((await out([{ ...cell('T-siniy', '7--10'), fact_qty: 1 }])).status).toBe(400); // rad etilgan — tsexda yo'q
    const ok = await out([{ ...cell('Qora', '7--10'), fact_qty: 80 }, { ...cell('Qora', '11--14'), fact_qty: 100 }]);
    expect(ok.status).toBe(201);
    // furnitura: tugma 80×6 + 100×6, ip faqat 7--10 razmerga 80×0,5
    expect(ok.body.materials).toBe(3);
    const xa = (await api().get(`/api/tsex/materials?order_id=${o.id}`).set(auth(tsex))).body as { material_name: string; size_name: string; qty: string; cost_uzs: string }[];
    expect(xa.map((m) => `${m.material_name} ${m.size_name} ${m.qty}`).sort()).toEqual(['Ip 7--10 40.000', 'Tugma 11--14 600.000', 'Tugma 7--10 480.000']);
    expect(xa.find((m) => m.qty === '480.000')!.cost_uzs).toBe('48000.00');
    const gp = (await api().get(`/api/tsex/outputs?order_id=${o.id}`).set(auth(tsex))).body;
    expect(gp.map((g: { need_qty: number; fact_qty: number }) => `${g.need_qty}/${g.fact_qty}`)).toEqual(['100/80', '100/100']);

    // 4) Ostatka
    const bal = (await api().get(`/api/tsex/balance?order_id=${o.id}`).set(auth(tsex))).body;
    expect(bal.map((b: { color_name: string; size_name: string; received: number; produced: number; left_qty: number }) => `${b.size_name} ${b.received}-${b.produced}=${b.left_qty}`)).toEqual(['7--10 100-80=20']);
    const plan2 = (await api().get(`/api/tsex/plan?producer_id=${tsexId}&order_id=${o.id}`).set(auth(tsex))).body;
    expect(plan2.materials.map((m: { left_qty: string }) => m.left_qty).sort()).toEqual(['-40.000', '420.000']);

    // o'chirish → qoldiq qaytadi
    expect((await api().delete(`/api/tsex/docs/${ok.body.id}`).set(auth(tsex))).status).toBe(204);
    expect((await api().get(`/api/tsex/balance?order_id=${o.id}`).set(auth(tsex))).body.map((b: { left_qty: number }) => b.left_qty)).toEqual([100, 100]);
    const hr = (await newUser(A, 'hr')).token;
    expect((await api().get('/api/tsex/balance').set(auth(hr))).status).toBe(403);
  });
});
