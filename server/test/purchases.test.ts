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

/** Sheets'dagi 247-partiya: Rubashka, Qora 1200 (7--10: 600, 11--14: 600) va T-siniy 480 (7--10). */
async function order247() {
  const o = (
    await api().post('/api/orders').set(auth(innov)).send({ partiya_no: uniq('247-'), order_date: '2026-08-25', product_type_id: ids.type.Rubashka })
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
    await add({ color_ids: [ids.color[c]], material_id: ids.mat.mato, material_color_id: ids.color[c], per_unit: 0.75, price: 14, currency: 'CNY', rate: 1790, is_main: true });
  }
  const both = [ids.color.Qora, ids.color['T-siniy']];
  await add({ color_ids: both, material_id: ids.mat.tugma, material_color_id: ids.color.Qora, material_size: '16', per_unit: 6, price: 100 });
  await add({ color_ids: both, material_id: ids.mat.zamok, material_color_id: ids.color.Qora, per_unit: 0.125, price: 1000 });
  return o.id as number;
}

type Need = { order_material_id: number; supplier_id: number; qty: string | null; price: string; currency: string; rate: string; ordered_line_id: number | null };
/** Xomashyo Zakaz: bosqichdagi yuborilmagan qatorlarni zakazdagi qiymatlar bilan YUBORISH */
async function send(token: string, orderId: number, stage: 'mato' | 'furnitura', patch: object = {}) {
  const plan = (await api().get(`/api/purchases/orders/${orderId}`).set(auth(token))).body;
  const rows = (plan[stage] as Need[])
    .filter((r) => !r.ordered_line_id)
    .map((r) => ({ order_material_id: r.order_material_id, supplier_id: r.supplier_id, qty: Number(r.qty), price: Number(r.price), currency: r.currency, rate: Number(r.rate), ...patch }));
  return api().post(`/api/purchases/orders/${orderId}/send`).set(auth(token)).send({ stage, rows });
}
const linesOf = async (orderId: number, stage?: string) =>
  (await api().get(`/api/purchases/lines?order_id=${orderId}${stage ? `&stage=${stage}` : ''}`).set(auth(taminot))).body as Record<string, any>[];
const kelishuv = (token: string, lines: object[]) => api().put('/api/purchases/lines/kelishuv').set(auth(token)).send({ lines });

describe('Razmerlarga proporsional bo\'lish', () => {
  it('yig\'indi aynan jamiga teng, ulush saqlanadi', () => {
    expect(distribute([600, 600], 1395)).toEqual([698, 697]);
    expect(distribute([540, 608, 540], 1700)).toEqual([544, 612, 544]);
    expect(distribute([10, 0, 5], 3)).toEqual([2, 0, 1]);
    expect(distribute([0, 0], 5)).toEqual([0, 0]);
  });
});

describe('Zakaz&Tracking: Xomashyo Zakaz → Postavshik Kelishuv → Status o\'zgartirish (247-partiya)', () => {
  it('to\'liq jarayon', async () => {
    const id = await order247();
    expect((await send(taminot, id, 'mato')).status).toBe(409); // tasdiqlanmagan zakaz
    expect((await api().post(`/api/orders/${id}/confirm`).set(auth(innov))).status).toBe(200);

    const plan = (await api().get(`/api/purchases/orders/${id}`).set(auth(taminot))).body;
    expect(plan.can).toEqual({ mato: true, furnitura: false });
    expect(plan.mato.map((r: { qty: string }) => r.qty)).toEqual(['900.000', '360.000']);

    // 1) Xomashyo Zakaz: mato YUBORISH (ETA, menejer bilan); qayta yuborib bo'lmaydi; furnitura kutadi
    const s = await send(taminot, id, 'mato', { eta: '2026-09-20', manager: 'Abu Saxiy' });
    expect(s.status).toBe(201);
    expect(s.body.created).toHaveLength(2);
    // yuborilgan qatorni qayta yuborib bo'lmaydi
    const m0 = plan.mato[0];
    const again = await api()
      .post(`/api/purchases/orders/${id}/send`)
      .set(auth(taminot))
      .send({ stage: 'mato', rows: [{ order_material_id: m0.order_material_id, supplier_id: m0.supplier_id, qty: 1, price: 1, currency: 'CNY', rate: 1790 }] });
    expect(again.status).toBe(409);
    // furnitura — mato kelishuvi tasdiqlanmaguncha yuborilmaydi
    expect((await send(taminot, id, 'furnitura', { qty: 1 })).body.message).toContain('kutilmoqda');
    let mato = await linesOf(id, 'mato');
    expect(mato.map((l) => [l.material_color_name, l.plan_qty, l.status, l.manager, l.eta])).toEqual([
      ['T-siniy', '360.000', 'negotiation', 'Abu Saxiy', '2026-09-20'],
      ['Qora', '900.000', 'negotiation', 'Abu Saxiy', '2026-09-20'],
    ]);

    // 2) Postavshik Kelishuv: Qora fakt 1046 → tasdiqlash; T-siniy 490 — rad etish, keyin tuzatib tasdiqlash
    const qora = mato.find((l) => l.material_color_name === 'Qora')!;
    const ts = mato.find((l) => l.material_color_name === 'T-siniy')!;
    const r1 = await kelishuv(taminot, [
      { id: qora.id, fact_qty: 1046, fact_price: 14, decision: 'agree' },
      { id: ts.id, fact_qty: 490, decision: 'reject', note: 'Rang mos emas' },
    ]);
    expect(r1.body).toEqual({ saved: 0, agreed: 1, rejected: 1 });
    mato = await linesOf(id, 'mato');
    expect(mato.find((l) => l.id === ts.id)).toMatchObject({ status: 'rejected', reject_reason: 'Rang mos emas' });
    // Qora tasdiqlandi — faqat Qora soni o'zgaradi, T-siniy hali kutilmoqda
    let od = (await api().get(`/api/orders/${id}`).set(auth(innov))).body;
    expect(od.by_color.find((c: { color_name: string }) => c.color_name === 'Qora').actual_qty).toBe(1395);
    expect(od.by_color.find((c: { color_name: string }) => c.color_name === 'T-siniy').actual_qty).toBeNull();
    expect((await kelishuv(taminot, [{ id: qora.id, fact_qty: 1 }])).status).toBe(409); // kelishilgan qator o'zgarmaydi
    expect((await kelishuv(taminot, [{ id: ts.id, fact_qty: 490, decision: 'agree' }])).body.agreed).toBe(1);

    // 3) qayta hisob: Qora 1395 (698/697), T-siniy 654
    od = (await api().get(`/api/orders/${id}`).set(auth(innov))).body;
    const act = Object.fromEntries(od.items.map((i: { size_name: string; color_name: string; actual_qty: number }) => [`${i.size_name} ${i.color_name}`, i.actual_qty]));
    expect(act).toEqual({ '7--10 Qora': 698, '11--14 Qora': 697, '7--10 T-siniy': 654 });
    expect((await api().post(`/api/orders/${id}/reopen`).set(auth(A))).status).toBe(409);

    // 4) furnitura yangi son bo'yicha: tugma 2049 × 6 = 12 294; zamok 256,125 → 257
    const f = await send(taminot, id, 'furnitura');
    expect(f.status).toBe(201);
    const furn = await linesOf(id, 'furnitura');
    expect(Object.fromEntries(furn.map((l) => [l.material_name, l.plan_qty]))).toEqual({ Tugma: '12294.000', 'Замочки': '257.000' });
    expect(furn.find((l) => l.material_name === 'Tugma')!.for_colors).toBe('Qora, T-siniy');
    // kelishilgan matoni furnitura bor ekan bekor qilib bo'lmaydi
    expect((await api().post(`/api/purchases/lines/${qora.id}/cancel`).set(auth(taminot))).status).toBe(409);
    await kelishuv(taminot, furn.map((l) => ({ id: l.id, decision: 'agree' })));

    // 5) Status o'zgartirish
    const tl = (await api().get('/api/purchases/tracking').set(auth(taminot))).body.find((x: { order_id: number }) => x.order_id === id);
    expect(tl).toMatchObject({ lines: 4 });
    const track = (body: object) => api().post(`/api/purchases/tracking/${id}`).set(auth(taminot)).send(body);
    const base = { status: 'in_transit', payment_status: 'advance', tracking: 'Bojxona' };
    expect((await track({ ...base, tracking: '' })).status).toBe(400);
    expect((await track({ ...base, shipments: [{ line_id: qora.id, qty: 500 }] })).body.message).toBe('Yo\'lga chiqish sanasini tanlang');
    expect((await track({ ...base, ship_date: '2026-09-10', shipments: [{ line_id: qora.id, qty: 2000 }] })).body.message).toBe('Yo\'lga chiqqan miqdor qoldiqdan ko\'p');
    const t1 = await track({ ...base, ship_date: '2026-09-10', shipments: [{ line_id: qora.id, qty: 600 }] });
    expect(t1.status).toBe(200);
    const q1 = t1.body.lines.find((l: { id: number }) => l.id === qora.id);
    expect(q1).toMatchObject({ status: 'in_transit', payment_status: 'advance', tracking: 'Bojxona', shipped_qty: '600.000', remaining_qty: '446.000' });
    // yo'lga chiqmagan qatorlar statusi o'zgarmaydi, to'lov va tracking esa hammasiga
    expect(t1.body.lines.find((l: { id: number }) => l.id === ts.id)).toMatchObject({ status: 'preparing', payment_status: 'advance', tracking: 'Bojxona' });
    expect(t1.body.shipments[0]).toMatchObject({ qty: '600.000', ship_date: '2026-09-10', amount: '8400.00', amount_uzs: '15036000.00' });
    // qolgani yetib keldi va yopildi (miqdorsiz — hamma qatorga)
    const t2 = await track({ status: 'closed', payment_status: 'paid', tracking: 'Abu Saxiy', arrived_date: '2026-09-25' });
    expect(t2.body.lines.every((l: { status: string; arrived_date: string }) => l.status === 'closed' && l.arrived_date === '2026-09-25')).toBe(true);
    expect((await api().get('/api/purchases/tracking').set(auth(taminot))).body.some((x: { order_id: number }) => x.order_id === id)).toBe(false);

    const orders = (await api().get('/api/purchases/orders').set(auth(taminot))).body;
    expect(orders.find((o: { id: number }) => o.id === id)).toMatchObject({ plan_qty: 1680, actual_qty: 2049, mato_agreed: 2, furnitura_agreed: 2 });
    const audits = (await api().get('/api/audit').set(auth(A))).body.map((a: { entity: string; action: string }) => `${a.entity}:${a.action}`);
    expect(audits).toEqual(expect.arrayContaining(['purchase:send', 'purchase_line:agree', 'purchase_line:reject', 'purchase_tracking:update']));
  });

  it('yuborishda tahrirlangan miqdor; fakt ulush bo\'yicha bo\'linadi; bekor qilinsa son qaytadi', async () => {
    const o = (await api().post('/api/orders').set(auth(innov)).send({ partiya_no: uniq('X'), order_date: '2026-09-01', product_type_id: ids.type.Shim })).body.order;
    await api()
      .put(`/api/orders/${o.id}/items`)
      .set(auth(innov))
      .send({ items: [{ size_id: ids.size['3--6'], color_id: ids.color.Qora, qty: 100 }, { size_id: ids.size['3--6'], color_id: ids.color.Oq, qty: 50 }] });
    await api().post(`/api/orders/${o.id}/materials`).set(auth(innov)).send({ color_ids: [ids.color.Qora], material_id: ids.mat.mato, per_unit: 1.2, is_main: true });
    await api().post(`/api/orders/${o.id}/materials`).set(auth(innov)).send({ color_ids: [ids.color.Qora, ids.color.Oq], material_id: ids.mat.tugma, per_unit: 2 });
    await api().post(`/api/orders/${o.id}/confirm`).set(auth(innov));
    // zakaz 120 m o'rniga 130 m yuborildi; nakladnoy 130 m → 130 ÷ 1,2 = 108,3 → 109
    expect((await send(taminot, o.id, 'mato', { qty: 130 })).status).toBe(201);
    const [l] = await linesOf(o.id, 'mato');
    expect(l.plan_qty).toBe('130.000');
    let items = (await api().get(`/api/orders/${o.id}`).set(auth(taminot))).body.items;
    expect(items.find((i: { color_name: string }) => i.color_name === 'Oq').actual_qty).toBe(50); // asosiy mato yo'q
    expect(items.find((i: { color_name: string }) => i.color_name === 'Qora').actual_qty).toBeNull();
    await kelishuv(taminot, [{ id: l.id, decision: 'agree' }]); // fakt kiritilmasa — yuborilgan miqdor
    items = (await api().get(`/api/orders/${o.id}`).set(auth(taminot))).body.items;
    expect(items.find((i: { color_name: string }) => i.color_name === 'Qora').actual_qty).toBe(109);
    expect((await api().post(`/api/purchases/lines/${l.id}/cancel`).set(auth(taminot))).status).toBe(204);
    items = (await api().get(`/api/orders/${o.id}`).set(auth(taminot))).body.items;
    expect(items.find((i: { color_name: string }) => i.color_name === 'Qora').actual_qty).toBeNull();
    expect((await api().get(`/api/purchases/orders/${o.id}`).set(auth(taminot))).body.can.mato).toBe(true);
  });
});

describe('Ta\'minot: ruxsatlar', () => {
  it('innovatsiya va sklad ko\'radi, yozmaydi; rahbar tasdiqlaydi; HR ko\'rmaydi', async () => {
    const id = await order247();
    await api().post(`/api/orders/${id}/confirm`).set(auth(innov));
    const sklad = (await newUser(A, 'sklad')).token;
    const rahbar = (await newUser(A, 'rahbar')).token;
    const hr = (await newUser(A, 'hr')).token;
    expect((await send(innov, id, 'mato')).status).toBe(403);
    expect((await api().get(`/api/purchases/orders/${id}`).set(auth(sklad))).status).toBe(200);
    expect((await api().get('/api/purchases/lines').set(auth(hr))).status).toBe(403);
    await send(taminot, id, 'mato');
    const [l] = await linesOf(id, 'mato');
    expect((await kelishuv(sklad, [{ id: l.id, fact_qty: 1 }])).status).toBe(403);
    expect((await kelishuv(rahbar, [{ id: l.id, fact_qty: 5, decision: 'agree' }])).status).toBe(403); // rahbar nakladnoy kiritmaydi
    expect((await kelishuv(rahbar, [{ id: l.id, decision: 'agree' }])).status).toBe(200); // lekin tasdiqlaydi
    expect((await linesOf(id, 'mato')).find((x) => x.id === l.id)!.agreed_by_name).toBe('rahbar xodim');
    expect((await api().post(`/api/purchases/tracking/${id}`).set(auth(sklad)).send({ status: 'arrived', payment_status: 'paid', tracking: 'x' })).status).toBe(403);
  });
});
