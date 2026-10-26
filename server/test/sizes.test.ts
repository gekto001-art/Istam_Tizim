import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  const mk = async (name: string, unit: string, supplier: string) =>
    (await api().post('/api/materials').set(auth(A)).send({ name, code: uniq('K'), unit, supplier_id: ids.supplier[supplier] })).body.id as number;
  ids.mat = { mato: await mk('mato', 'Metr', 'XIUDONG'), tugma: await mk('Tugma', 'Dona', 'BUTTON') };
});

/** Sini-oq: 3--6 540, 7--10 608, 11--14 540; Seriy: 3--6 380, 11--14 380 */
async function newOrder() {
  const o = (await api().post('/api/orders').set(auth(innov)).send({ partiya_no: uniq('S'), order_date: '2026-10-23', product_type_id: ids.type.Dvoyka })).body.order;
  const cell = (s: string, c: string, qty: number) => ({ size_id: ids.size[s], color_id: ids.color[c], qty });
  await api()
    .put(`/api/orders/${o.id}/items`)
    .set(auth(innov))
    .send({ items: [cell('3--6', 'Sini-oq', 540), cell('7--10', 'Sini-oq', 608), cell('11--14', 'Sini-oq', 540), cell('3--6', 'Seriy', 380), cell('11--14', 'Seriy', 380)] });
  return o.id as number;
}
const line = (color: string, size: string | null, material: number, per_unit: number, extra: object = {}) => ({
  color_id: ids.color[color],
  size_id: size ? ids.size[size] : null,
  material_id: material,
  per_unit,
  ...extra,
});
const save = (id: number, lines: object[]) => api().put(`/api/orders/${id}/materials`).set(auth(innov)).send({ lines });

describe('Xomashyo jadvali: razmer × rang (Sheets "Zakazlar"dagidek)', () => {
  it('bitta jadval sifatida saqlanadi; razmer bo\'yicha sarf; "hammasi" — rangning barcha razmerlari', async () => {
    const id = await newOrder();
    const mato = { material_color_id: ids.color['Sini-oq'], price: 14.5, currency: 'CNY', is_main: true };
    const r = await save(id, [
      line('Sini-oq', '3--6', ids.mat.mato, 0.55, mato),
      line('Sini-oq', '7--10', ids.mat.mato, 0.58, mato),
      line('Sini-oq', '11--14', ids.mat.mato, 0.65, mato),
      line('Seriy', null, ids.mat.mato, 0.6, { ...mato, material_color_id: ids.color.Seriy }),
      line('Sini-oq', null, ids.mat.tugma, 8, { price: 100 }),
      line('Seriy', null, ids.mat.tugma, 8, { price: 100 }),
    ]);
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.materials.map((m: { product_qty: string }) => Number(m.product_qty))).toEqual([540, 608, 540, 760, 1688, 760]);
    expect(d.materials[2]).toMatchObject({ size_name: '11--14', total_qty: '351.000' }); // 540 × 0,65
    expect(d.materials[0].unit_amount).toBe('7.9750'); // 0,55 × 14,5 (Sheets "Summa")
    // ehtiyoj: Sini-oq mato = 297 + 352,64 + 351 = 1000,64 m
    const need = d.needs.find((n: { material_id: number; material_color_name: string }) => n.material_id === ids.mat.mato && n.material_color_name === 'Sini-oq');
    expect(need.total_qty).toBe('1000.640');
    expect(d.needs.find((n: { material_id: number }) => n.material_id === ids.mat.tugma).total_qty).toBe('19584.000'); // 2448 × 8
    expect(d.warnings.filter((w: string) => w.startsWith('Xomashyo kiritilmagan') || w.startsWith('Asosiy'))).toEqual([]);

    // qatorni tahrirlash va o'chirish: ro'yxatda yo'q qator o'chadi, tartib saqlanadi
    const keep = d.materials.filter((m: { size_name: string | null; color_name: string }) => !(m.color_name === 'Sini-oq' && m.size_name === '3--6'));
    const r2 = await save(
      id,
      keep.map((m: Record<string, unknown>) => ({ ...m, per_unit: m.id === d.materials[1].id ? 0.6 : Number(m.per_unit), price: Number(m.price), rate: Number(m.rate) })),
    );
    expect(r2.status).toBe(200);
    expect(r2.body.materials).toHaveLength(5);
    expect(r2.body.materials[0].per_unit).toBe('0.6000');
    expect(r2.body.warnings.some((w: string) => w.includes('3--6 Sini-oq') && w.startsWith('Asosiy'))).toBe(true);
    const audits = (await api().get('/api/audit?entity=order').set(auth(A))).body.filter((a: { entity_id: string }) => a.entity_id === String(id));
    expect(audits.filter((a: { action: string }) => a.action === 'materials')).toHaveLength(2);
  });

  it('tekshiruvlar: asosiy mato katakda bittadan, jadvalda yo\'q razmer, jadvaldan olib tashlash', async () => {
    const id = await newOrder();
    // rang bo'yicha umumiy asosiy + razmer bo'yicha asosiy — bir katakda ikkita
    const dup = await save(id, [line('Seriy', null, ids.mat.mato, 0.6, { is_main: true }), line('Seriy', '3--6', ids.mat.mato, 0.5, { is_main: true })]);
    expect(dup.status).toBe(400);
    expect(dup.body.message).toContain('3--6 Seriy');
    // Seriy rangida 7--10 razmer yo'q
    expect((await save(id, [line('Seriy', '7--10', ids.mat.tugma, 1)])).status).toBe(400);
    // razmer bo'yicha qator bor — shu razmerni jadvaldan olib tashlab bo'lmaydi
    await save(id, [line('Sini-oq', '7--10', ids.mat.tugma, 1)]);
    const items = (await api().get(`/api/orders/${id}`).set(auth(innov))).body.items.filter((i: { size_name: string }) => i.size_name !== '7--10');
    const r = await api().put(`/api/orders/${id}/items`).set(auth(innov)).send({ items });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('7--10 Sini-oq');
    // tasdiqlash: Seriy kataklari qoplanmagan
    const c = await api().post(`/api/orders/${id}/confirm`).set(auth(innov));
    expect(c.status).toBe(400);
    expect(c.body.message).toContain('3--6 Seriy');
  });
});

describe('Ta\'minot: razmer bo\'yicha asosiy mato', () => {
  it('bitta mato qatoriga birlashadi; fakt har katakka reja ulushida taqsimlanib, katak soni = fakt ÷ sarf', async () => {
    const id = await newOrder();
    const mato = { material_color_id: ids.color['Sini-oq'], price: 14, currency: 'CNY', is_main: true };
    await save(id, [
      line('Sini-oq', '3--6', ids.mat.mato, 0.5, mato), // 270 m
      line('Sini-oq', '7--10', ids.mat.mato, 0.6, mato), // 364,8 m
      line('Sini-oq', '11--14', ids.mat.mato, 0.7, mato), // 378 m
      line('Sini-oq', null, ids.mat.tugma, 8, { price: 100 }),
      line('Seriy', null, ids.mat.tugma, 8, { price: 100 }), // Seriy: asosiy mato yo'q — son o'zgarmaydi
    ]);
    expect((await api().post(`/api/orders/${id}/confirm`).set(auth(innov))).status).toBe(200);
    // Xomashyo Zakaz: zakazdagi qiymatlar bilan YUBORISH
    const sendStage = async (stage: 'mato' | 'furnitura') => {
      const plan = (await api().get(`/api/purchases/orders/${id}`).set(auth(taminot))).body;
      const rows = plan[stage].map((r: { order_material_id: number; supplier_id: number; qty: string; price: string; currency: string; rate: string }) => ({
        order_material_id: r.order_material_id, supplier_id: r.supplier_id, qty: Number(r.qty), price: Number(r.price), currency: r.currency, rate: Number(r.rate),
      }));
      return api().post(`/api/purchases/orders/${id}/send`).set(auth(taminot)).send({ stage, rows });
    };
    expect((await sendStage('mato')).status).toBe(201);
    const lines = (stage: string) => api().get(`/api/purchases/lines?order_id=${id}&stage=${stage}`).set(auth(taminot));
    const d = (await lines('mato')).body;
    expect(d).toHaveLength(1);
    expect(d[0].plan_qty).toBe('1012.800');
    expect(d[0].for_colors).toBe('Sini-oq');
    // nakladnoy: 1100 m (reja 1012,8) → har katakka ulush bo'yicha
    expect((await api().put('/api/purchases/lines/kelishuv').set(auth(taminot)).send({ lines: [{ id: d[0].id, fact_qty: 1100, decision: 'agree' }] })).status).toBe(200);
    const items = (await api().get(`/api/orders/${id}`).set(auth(taminot))).body.items;
    const act = Object.fromEntries(items.map((i: { size_name: string; color_name: string; actual_qty: number }) => [`${i.size_name} ${i.color_name}`, i.actual_qty]));
    // 3--6: 1100 × 270/1012,8 = 293,247 m ÷ 0,5 = 586,5 → 587; 7--10: 396,209 ÷ 0,6 → 661; 11--14: 410,545 ÷ 0,7 → 587
    expect(act).toEqual({ '3--6 Sini-oq': 587, '7--10 Sini-oq': 661, '11--14 Sini-oq': 587, '3--6 Seriy': 380, '11--14 Seriy': 380 });
    // furnitura: tugma (587 + 661 + 587) × 8 = 14 680 va Seriy 760 × 8 = 6 080 → bitta qatorda 20 760
    expect((await sendStage('furnitura')).status).toBe(201);
    const fl = (await lines('furnitura')).body;
    expect(fl.map((l: { plan_qty: string }) => l.plan_qty)).toEqual(['20760.000']);
  });
});
