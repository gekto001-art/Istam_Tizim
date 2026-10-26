import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { distribute } from '../src/services/supply.js';
import { pool } from '../src/db/pool.js';
import { admin, api, auth, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

type Named = { id: number; name: string };
let A: string;
let innov: string;
let taminot: string;
const ids: Record<string, Record<string, number>> = {};
const byName = async (path: string) =>
  Object.fromEntries(((await api().get(`/api/${path}`).set(auth(A))).body as Named[]).map((x) => [x.name, x.id]));

beforeAll(async () => {
  A = (await admin()).token;
  innov = (await newUser(A, 'innovatsiya')).token;
  taminot = (await newUser(A, 'taminot')).token;
  ids.color = await byName('colors');
  ids.size = await byName('sizes');
  ids.type = await byName('product-types');
  ids.supplier = await byName('suppliers');
  const mk = async (name: string, code: string, unit: string, supplier: string) =>
    (await api().post('/api/materials').set(auth(A)).send({ name, code, unit, supplier_id: ids.supplier[supplier] })).body.id as number;
  ids.mat = {
    mato: await mk('mato', uniq('M'), 'Metr', 'XIUDONG'),
    tugma: await mk('Tugma', uniq('T'), 'Dona', 'ISTAM'),
    zamok: await mk('Замочки', uniq('Z'), 'Dona', 'ISTAM'),
  };
});

/**
 * Sheets'dagi 247-partiya: Rubashka, Qora 1200 (7--10: 600, 11--14: 600) va T-siniy 480 (7--10).
 * Mato 0,75 m (asosiy), tugma 6 dona, zamok 0,125 dona.
 */
async function order247() {
  const o = (
    await api()
      .post('/api/orders')
      .set(auth(innov))
      .send({ partiya_no: uniq('247-'), order_date: '2026-08-25', product_type_id: ids.type.Rubashka })
  ).body.order;
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
  const add = (body: object) => api().post(`/api/orders/${o.id}/materials`).set(auth(innov)).send(body);
  for (const c of ['Qora', 'T-siniy']) {
    const r = await add({ color_ids: [ids.color[c]], material_id: ids.mat.mato, material_color_id: ids.color[c], per_unit: 0.75, price: 14, currency: 'CNY', is_main: true });
    expect(r.status).toBe(201);
  }
  const both = [ids.color.Qora, ids.color['T-siniy']];
  await add({ color_ids: both, material_id: ids.mat.tugma, material_color_id: ids.color.Qora, material_size: '16', per_unit: 6, price: 100 });
  await add({ color_ids: both, material_id: ids.mat.zamok, material_color_id: ids.color.Qora, per_unit: 0.125, price: 1000 });
  return o.id as number;
}

describe('Razmerlarga proporsional bo\'lish', () => {
  it('yig\'indi aynan jamiga teng, ulush saqlanadi', () => {
    expect(distribute([600, 600], 1395)).toEqual([698, 697]);
    expect(distribute([540, 608, 540], 1700)).toEqual([544, 612, 544]);
    expect(distribute([10, 0, 5], 3)).toEqual([2, 0, 1]);
    expect(distribute([0, 0], 5)).toEqual([0, 0]);
  });
});

describe('Ta\'minot: mato → nakladnoy → qayta hisob → furnitura (247-partiya)', () => {
  it('to\'liq jarayon', async () => {
    const id = await order247();
    // har rangda bitta asosiy mato
    const dup = await api()
      .post(`/api/orders/${id}/materials`)
      .set(auth(innov))
      .send({ color_ids: [ids.color.Qora], material_id: ids.mat.tugma, per_unit: 1, is_main: true });
    expect(dup.status).toBe(400);

    // tasdiqlanmagan zakazga ta'minot yo'q
    expect((await api().post(`/api/purchases/orders/${id}/mato`).set(auth(taminot))).status).toBe(409);
    expect((await api().post(`/api/orders/${id}/confirm`).set(auth(innov))).status).toBe(200);

    let plan = (await api().get(`/api/purchases/orders/${id}`).set(auth(taminot))).body;
    expect(plan.can).toEqual({ mato: true, furnitura: false });
    expect(plan.mato.map((r: { qty: string }) => r.qty)).toEqual(['900.000', '360.000']);

    // 1) mato zakazi: bitta postavshik (XIUDONG), 2 qator (rang bo'yicha)
    const m = await api().post(`/api/purchases/orders/${id}/mato`).set(auth(taminot));
    expect(m.status).toBe(201);
    expect(m.body.created).toHaveLength(1);
    expect((await api().post(`/api/purchases/orders/${id}/mato`).set(auth(taminot))).status).toBe(409);
    expect((await api().post(`/api/purchases/orders/${id}/furnitura`).set(auth(taminot))).body.message).toContain('kutilmoqda');
    const poId = m.body.created[0];
    let po = (await api().get(`/api/purchases/${poId}`).set(auth(taminot))).body;
    expect(po.po).toMatchObject({ stage: 'mato', status: 'negotiation', supplier_name: 'XIUDONG' });
    expect(po.lines.map((l: { plan_qty: string }) => l.plan_qty)).toEqual(['900.000', '360.000']);

    // 2) nakladnoy: fakt 1046 m va 490 m; tasdiqlamay turib zakaz qayta ochilmaydi
    const agreeEarly = await api().post(`/api/purchases/${poId}/agree`).set(auth(taminot));
    expect(agreeEarly.status).toBe(400);
    const [lQora, lTs] = po.lines;
    po = (
      await api()
        .put(`/api/purchases/${poId}/lines`)
        .set(auth(taminot))
        .send({ lines: [{ id: lQora.id, fact_qty: 1046, fact_price: 14 }, { id: lTs.id, fact_qty: 490 }] })
    ).body;
    expect(po.lines[0].sources[0]).toMatchObject({ color_name: 'Qora', products: 1395 });
    expect(po.lines[1].sources[0]).toMatchObject({ color_name: 'T-siniy', products: 654 });
    const ag = await api().post(`/api/purchases/${poId}/agree`).set(auth(taminot));
    expect(ag.status).toBe(200);
    expect(ag.body.po.status).toBe('preparing');
    expect(ag.body.lines[1].fact_price).toBe('14.0000'); // narx berilmasa reja narxi

    // 3) qayta hisob: Qora 1395 (razmerlarga 698/697), T-siniy 654
    const od = (await api().get(`/api/orders/${id}`).set(auth(innov))).body;
    const act = Object.fromEntries(od.items.map((i: { size_name: string; color_name: string; actual_qty: number }) => [`${i.size_name} ${i.color_name}`, i.actual_qty]));
    expect(act).toEqual({ '7--10 Qora': 698, '11--14 Qora': 697, '7--10 T-siniy': 654 });
    expect(od.totals.actual_qty).toBe(2049);
    // ta'minot buyurtmasi bor zakaz qoralamaga qaytmaydi
    expect((await api().post(`/api/orders/${id}/reopen`).set(auth(A))).status).toBe(409);

    // 4) furnitura yangi son bo'yicha: tugma 2049 × 6 = 12 294; zamok 2049 × 0,125 = 256,125 → 257
    plan = (await api().get(`/api/purchases/orders/${id}`).set(auth(taminot))).body;
    expect(plan.can.furnitura).toBe(true);
    const f = await api().post(`/api/purchases/orders/${id}/furnitura`).set(auth(taminot));
    expect(f.status).toBe(201);
    expect(f.body.created).toHaveLength(1);
    const fpo = (await api().get(`/api/purchases/${f.body.created[0]}`).set(auth(taminot))).body;
    expect(fpo.po).toMatchObject({ stage: 'furnitura', supplier_name: 'ISTAM' });
    const qty = Object.fromEntries(fpo.lines.map((l: { material_name: string; plan_qty: string }) => [l.material_name, l.plan_qty]));
    expect(qty).toEqual({ Tugma: '12294.000', 'Замочки': '257.000' });
    expect(fpo.lines.find((l: { material_name: string }) => l.material_name === 'Tugma').sources).toHaveLength(2);

    // 5) rad etish → tuzatish → yana kelishuv → tasdiqlash
    expect((await api().post(`/api/purchases/${fpo.po.id}/reject`).set(auth(taminot)).send({ reason: '' })).status).toBe(400);
    const rj = await api().post(`/api/purchases/${fpo.po.id}/reject`).set(auth(taminot)).send({ reason: 'Narx kelishilmadi' });
    expect(rj.body.po).toMatchObject({ status: 'rejected', reject_reason: 'Narx kelishilmadi' });
    expect((await api().post(`/api/purchases/${fpo.po.id}/agree`).set(auth(taminot))).status).toBe(409);
    const fix = await api()
      .put(`/api/purchases/${fpo.po.id}/lines`)
      .set(auth(taminot))
      .send({ lines: fpo.lines.map((l: { id: number; plan_qty: string }) => ({ id: l.id, fact_qty: Number(l.plan_qty), fact_price: 95 })) });
    expect(fix.body.po.status).toBe('negotiation');
    expect((await api().post(`/api/purchases/${fpo.po.id}/agree`).set(auth(taminot))).status).toBe(200);
    // kelishilganidan keyin nakladnoy o'zgarmaydi
    expect((await api().put(`/api/purchases/${fpo.po.id}/lines`).set(auth(taminot)).send({ lines: [{ id: fpo.lines[0].id, fact_qty: 1 }] })).status).toBe(409);

    // furnitura bor ekan, kelishilgan matoni bekor qilib bo'lmaydi
    expect((await api().post(`/api/purchases/${poId}/cancel`).set(auth(taminot))).status).toBe(409);

    const list = (await api().get(`/api/purchases?order_id=${id}`).set(auth(taminot))).body;
    expect(list).toHaveLength(2);
    const orders = (await api().get('/api/purchases/orders').set(auth(taminot))).body;
    expect(orders.find((o: { id: number }) => o.id === id)).toMatchObject({ plan_qty: 1680, actual_qty: 2049, mato_agreed: 1, furnitura_agreed: 1 });
  });

  it('asosiy matosiz rang soni o\'zgarmaydi; mato bekor qilinsa son qaytadi', async () => {
    const o = (await api().post('/api/orders').set(auth(innov)).send({ partiya_no: uniq('X'), order_date: '2026-09-01', product_type_id: ids.type.Shim })).body.order;
    await api()
      .put(`/api/orders/${o.id}/items`)
      .set(auth(innov))
      .send({ items: [{ size_id: ids.size['3--6'], color_id: ids.color.Qora, qty: 100 }, { size_id: ids.size['3--6'], color_id: ids.color.Oq, qty: 50 }] });
    await api().post(`/api/orders/${o.id}/materials`).set(auth(innov)).send({ color_ids: [ids.color.Qora], material_id: ids.mat.mato, per_unit: 1.2, is_main: true });
    await api().post(`/api/orders/${o.id}/materials`).set(auth(innov)).send({ color_ids: [ids.color.Qora, ids.color.Oq], material_id: ids.mat.tugma, per_unit: 2 });
    await api().post(`/api/orders/${o.id}/confirm`).set(auth(innov));
    const m = await api().post(`/api/purchases/orders/${o.id}/mato`).set(auth(taminot));
    const items = (await api().get(`/api/orders/${o.id}`).set(auth(taminot))).body.items;
    expect(items.find((i: { color_name: string }) => i.color_name === 'Oq').actual_qty).toBe(50); // asosiy mato yo'q
    expect(items.find((i: { color_name: string }) => i.color_name === 'Qora').actual_qty).toBeNull(); // nakladnoy kutilmoqda
    // bekor qilinsa — mato qaytadan zakaz qilinadi
    expect((await api().post(`/api/purchases/${m.body.created[0]}/cancel`).set(auth(taminot))).status).toBe(200);
    expect((await api().get(`/api/purchases/orders/${o.id}`).set(auth(taminot))).body.can.mato).toBe(true);
  });
});

describe('Ta\'minot: ruxsatlar', () => {
  it('innovatsiya va sklad ko\'radi, yozmaydi; rahbar tasdiqlaydi, nakladnoy kiritmaydi; HR ko\'rmaydi', async () => {
    const id = await order247();
    await api().post(`/api/orders/${id}/confirm`).set(auth(innov));
    const sklad = (await newUser(A, 'sklad')).token;
    const rahbar = (await newUser(A, 'rahbar')).token;
    const hr = (await newUser(A, 'hr')).token;
    expect((await api().post(`/api/purchases/orders/${id}/mato`).set(auth(innov))).status).toBe(403);
    expect((await api().get(`/api/purchases/orders/${id}`).set(auth(sklad))).status).toBe(200);
    expect((await api().get('/api/purchases').set(auth(hr))).status).toBe(403);
    const po = (await api().post(`/api/purchases/orders/${id}/mato`).set(auth(taminot))).body.created[0];
    const lines = (await api().get(`/api/purchases/${po}`).set(auth(rahbar))).body.lines;
    expect((await api().put(`/api/purchases/${po}/lines`).set(auth(rahbar)).send({ lines: [{ id: lines[0].id, fact_qty: 1 }] })).status).toBe(403);
    await api()
      .put(`/api/purchases/${po}/lines`)
      .set(auth(taminot))
      .send({ lines: lines.map((l: { id: number }) => ({ id: l.id, fact_qty: 500 })) });
    expect((await api().post(`/api/purchases/${po}/agree`).set(auth(sklad))).status).toBe(403);
    const ag = await api().post(`/api/purchases/${po}/agree`).set(auth(rahbar));
    expect(ag.status).toBe(200);
    expect(ag.body.po.agreed_by_name).toBe('rahbar xodim');
    const audits = (await api().get('/api/audit?entity=purchase').set(auth(A))).body
      .filter((a: { entity_id: string }) => a.entity_id === String(po))
      .map((a: { action: string }) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['create', 'nakladnoy', 'agree']));
  });
});
