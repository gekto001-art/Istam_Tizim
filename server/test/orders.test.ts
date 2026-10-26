import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { admin, api, auth, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

type Named = { id: number; name: string };
let A: string; // admin tokeni
let innov: string;
const ids: Record<string, Record<string, number>> = {};

async function byName(path: string) {
  const r = await api().get(`/api/${path}`).set(auth(A));
  return Object.fromEntries((r.body as Named[]).map((x) => [x.name, x.id]));
}

beforeAll(async () => {
  A = (await admin()).token;
  innov = (await newUser(A, 'innovatsiya')).token;
  ids.color = await byName('colors');
  ids.size = await byName('sizes');
  ids.type = await byName('product-types');
  ids.producer = await byName('producers');
  ids.supplier = await byName('suppliers');
  // xomashyolar tizimda qo'shiladi
  const mk = async (name: string, code: string | null, unit: string, supplier: string) =>
    (await api().post('/api/materials').set(auth(A)).send({ name, code, unit, supplier_id: ids.supplier[supplier] })).body.id as number;
  ids.mat = {
    mato: await mk('mato', '541-902-4', 'Metr', 'XIUDONG'),
    matoIstam: await mk('mato', null, 'Metr', 'ISTAM'),
    tugma56: await mk('Tugma', 'Kod-0056', 'Dona', 'BUTTON'),
    tugma57: await mk('Tugma', 'Kod-0057', 'Dona', 'BUTTON'),
    shevron: await mk('ko\'krak shevron', 'Kod-0011', 'Dona', 'SHEVRON'),
    etiketka: await mk('Etketka Istam', null, 'Dona', 'ETIKETKA'),
    rubSal: await mk('Rubashka Salafan', null, 'Dona', 'ISTAM'),
    upSal: await mk('Upakofka Salafan', null, 'Dona', 'ISTAM'),
  };
});

/** Sheets'dagi 29-partiya: Dvoyka, 3 razmer × 3 rang = 4174 dona */
const MATRIX: [string, string, number][] = [
  ['3--6', 'Sini-oq', 540], ['3--6', 'Qora-siniy', 380], ['3--6', 'Seriy', 380],
  ['7--10', 'Sini-oq', 608], ['7--10', 'Qora-siniy', 488], ['7--10', 'Seriy', 478],
  ['11--14', 'Sini-oq', 540], ['11--14', 'Qora-siniy', 380], ['11--14', 'Seriy', 380],
];

async function newOrder(token = innov, partiya = uniq('P')) {
  const r = await api()
    .post('/api/orders')
    .set(auth(token))
    .send({
      partiya_no: partiya,
      order_date: '2026-10-23',
      product_type_id: ids.type.Dvoyka,
      artikul: '541-902-2/6766',
      model: '422-2/620',
      season: 'Bahor',
      producer_id: ids.producer['ADIN HABIBULLOX'],
      ordered_by: 'AKMAL',
      start_date: '2026-10-24',
      end_date: '2026-10-28',
    });
  return r;
}
const items = () => MATRIX.map(([s, c, qty]) => ({ size_id: ids.size[s], color_id: ids.color[c], qty }));
const colors = (...names: string[]) => names.map((n) => ids.color[n]);
const addMat = (token: string, id: number, body: object) => api().post(`/api/orders/${id}/materials`).set(auth(token)).send(body);

describe('Zakaz (partiya): Sheets\'dagi 29-partiya bilan bir xil hisob', () => {
  it('matritsa, rang bo\'yicha xomashyo, ish narxi, ehtiyoj va tannarx', async () => {
    const o = await newOrder();
    expect(o.status).toBe(201);
    const id = o.body.order.id;
    expect(o.body.order).toMatchObject({ status: 'draft', product_type_name: 'Dvoyka', producer_name: 'ADIN HABIBULLOX' });

    const it1 = await api().put(`/api/orders/${id}/items`).set(auth(innov)).send({ items: items() });
    expect(it1.status).toBe(200);
    expect(it1.body.totals.qty).toBe(4174);

    // mato: har rang o'z rangidagi mato bilan (Xitoy, yuan)
    for (const c of ['Sini-oq', 'Qora-siniy', 'Seriy']) {
      const r = await addMat(innov, id, {
        color_ids: colors(c), material_id: ids.mat.mato, material_color_id: ids.color[c], color_code: '6', per_unit: 0.58, price: 14.5, currency: 'CNY', is_main: true,
      });
      expect(r.status).toBe(201);
    }
    // bir xil xomashyo — barcha ranglar uchun birdan
    const all = colors('Sini-oq', 'Qora-siniy', 'Seriy');
    await addMat(innov, id, { color_ids: all, material_id: ids.mat.matoIstam, material_color_id: ids.color['T-siniy'], per_unit: 0.063, price: 2, currency: 'USD' });
    await addMat(innov, id, { color_ids: all, material_id: ids.mat.tugma56, material_color_id: ids.color.Oq, material_size: '16', per_unit: 8, price: 100 });
    await addMat(innov, id, { color_ids: all, material_id: ids.mat.shevron, material_color_id: ids.color.Seriy, per_unit: 1, price: 1000 });
    await addMat(innov, id, { color_ids: all, material_id: ids.mat.etiketka, material_color_id: ids.color.Yashil, per_unit: 1, price: 1500 });
    await addMat(innov, id, { color_ids: all, material_id: ids.mat.tugma57, material_color_id: ids.color.Oq, material_size: '14', per_unit: 3, price: 100 });
    await addMat(innov, id, { color_ids: all, material_id: ids.mat.rubSal, material_color_id: ids.color.Shaffof, material_size: '20/31', per_unit: 1, price: 100 });
    const last = await addMat(innov, id, { color_ids: all, material_id: ids.mat.upSal, material_color_id: ids.color.Shaffof, material_size: '20/43', per_unit: 1, price: 100 });
    expect(last.body.materials).toHaveLength(3 + 7 * 3);
    expect(last.body.materials[0].supplier_name).toBeTruthy(); // xomashyoning odatiy postavshigi

    const w = await api()
      .put(`/api/orders/${id}/works`)
      .set(auth(innov))
      .send({ works: [{ producer_id: ids.producer.Kroy, price: 1000 }, { producer_id: ids.producer['1-ISTAM KO\'YLAK'], price: 15000 }] });
    const d = w.body;

    // Ehtiyoj (Sheets "Xomashyo Zakaz"): tugma Kod-0056 = 4174 × 8 = 33 392
    const need = (matId: number, color?: string) =>
      d.needs.find((n: { material_id: number; material_color_name: string }) => n.material_id === matId && (!color || n.material_color_name === color));
    expect(need(ids.mat.tugma56).total_qty).toBe('33392.000');
    expect(need(ids.mat.tugma56).total_uzs).toBe('3339200.00');
    expect(need(ids.mat.shevron).total_qty).toBe('4174.000');
    // Sini-oq mato: (540+608+540) × 0,58 = 979,04 m; yuanda 979,04 × 14,5
    expect(need(ids.mat.mato, 'Sini-oq').total_qty).toBe('979.040');
    expect(need(ids.mat.mato, 'Sini-oq').total_amount).toBe('14196.08');
    expect(need(ids.mat.mato, 'Sini-oq').for_colors).toBe('Sini-oq');

    // 1 dona tannarx (Sini-oq): mato 8,41 yuan × 1790 = 15 053,90 + 1 512 + 800 + 1 000 + 1 500 + 300 + 200 = 20 365,90; + ish 16 000
    const sini = d.by_color.find((c: { color_name: string }) => c.color_name === 'Sini-oq');
    expect(sini).toMatchObject({ qty: 1688, material_cost: '20365.90', work_cost: '16000.00', unit_cost: '36365.90' });
    expect(d.totals.work_uzs).toBe('66784000.00');
    expect(d.warnings).toEqual([]);

    const c = await api().post(`/api/orders/${id}/confirm`).set(auth(innov));
    expect(c.status).toBe(200);
    expect(c.body.order.status).toBe('confirmed');
    expect(c.body.order.confirmed_by_name).toBe('innovatsiya xodim');
  });

  it('tasdiqlash shartlari: matritsa va har rangda xomashyo bo\'lishi kerak', async () => {
    const id = (await newOrder()).body.order.id;
    expect((await api().post(`/api/orders/${id}/confirm`).set(auth(innov))).status).toBe(400);
    await api().put(`/api/orders/${id}/items`).set(auth(innov)).send({ items: items() });
    await addMat(innov, id, { color_ids: colors('Sini-oq'), material_id: ids.mat.tugma56, per_unit: 8, price: 100 });
    const r = await api().post(`/api/orders/${id}/confirm`).set(auth(innov));
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('Qora-siniy');
    expect(r.body.message).toContain('Seriy');
    // bir rangdagi hamma qatorlarni boshqa ranglarga nusxalash
    const cp = await api().post(`/api/orders/${id}/materials/copy`).set(auth(innov)).send({ from_color_id: ids.color['Sini-oq'], to_color_ids: colors('Qora-siniy', 'Seriy') });
    expect(cp.status).toBe(201);
    expect(cp.body.materials).toHaveLength(3);
    expect((await api().post(`/api/orders/${id}/confirm`).set(auth(innov))).status).toBe(200);
  });

  it('jadvaldan rangni olib tashlash: avval uning xomashyosini o\'chirish kerak', async () => {
    const id = (await newOrder()).body.order.id;
    await api().put(`/api/orders/${id}/items`).set(auth(innov)).send({ items: items() });
    const m = (await addMat(innov, id, { color_ids: colors('Seriy'), material_id: ids.mat.tugma56, per_unit: 8 })).body.materials[0];
    const noSeriy = items().filter((i) => i.color_id !== ids.color.Seriy);
    expect((await api().put(`/api/orders/${id}/items`).set(auth(innov)).send({ items: noSeriy })).status).toBe(409);
    await api().delete(`/api/orders/${id}/materials/${m.id}`).set(auth(innov));
    const r = await api().put(`/api/orders/${id}/items`).set(auth(innov)).send({ items: noSeriy });
    expect(r.status).toBe(200);
    expect(r.body.totals.qty).toBe(4174 - 380 - 478 - 380);
    // jadvalda yo'q rang uchun xomashyo qo'shib bo'lmaydi
    expect((await addMat(innov, id, { color_ids: colors('Seriy'), material_id: ids.mat.tugma56, per_unit: 1 })).status).toBe(400);
  });

  it('valyuta kursi: zakaz sanasidagi kurs olinadi, qo\'lda ham berish mumkin', async () => {
    await api().post('/api/currency-rates').set(auth(A)).send({ currency: 'USD', rate: 12800, valid_from: '2026-10-20' });
    const id = (await newOrder()).body.order.id; // 23.10.2026
    await api().put(`/api/orders/${id}/items`).set(auth(innov)).send({ items: items() });
    const r1 = await addMat(innov, id, { color_ids: colors('Sini-oq'), material_id: ids.mat.matoIstam, per_unit: 1, price: 2, currency: 'USD' });
    expect(r1.body.materials[0].rate).toBe('12800.0000');
    const r2 = await addMat(innov, id, { color_ids: colors('Seriy'), material_id: ids.mat.matoIstam, per_unit: 1, price: 2, currency: 'USD', rate: 12500 });
    const m = r2.body.materials.find((x: { color_name: string }) => x.color_name === 'Seriy');
    expect(m.rate).toBe('12500.0000');
    expect(m.unit_cost_uzs).toBe('25000.00');
    // narxni so'mga o'tkazsa kurs 1 bo'ladi
    const p = await api().patch(`/api/orders/${id}/materials/${m.id}`).set(auth(innov)).send({ currency: 'UZS', price: 30000 });
    expect(p.body.materials.find((x: { id: number }) => x.id === m.id)).toMatchObject({ rate: '1.0000', unit_cost_uzs: '30000.00' });
  });

  it('takroriy partiya raqami va noto\'g\'ri muddat rad etiladi', async () => {
    const p = uniq('P');
    expect((await newOrder(innov, p)).status).toBe(201);
    expect((await newOrder(innov, p.toLowerCase())).status).toBe(409);
    const id = (await newOrder()).body.order.id;
    expect((await api().patch(`/api/orders/${id}`).set(auth(innov)).send({ end_date: '2026-10-01' })).status).toBe(400);
  });
});

describe('Zakaz: ruxsatlar va holatlar', () => {
  it('tasdiqlangan zakaz qulflanadi; rahbar qoralamaga qaytaradi; ta\'minot faqat ko\'radi', async () => {
    const taminot = (await newUser(A, 'taminot')).token;
    const rahbar = (await newUser(A, 'rahbar')).token;
    const hr = (await newUser(A, 'hr')).token;

    expect((await newOrder(taminot)).status).toBe(403);
    const id = (await newOrder()).body.order.id;
    await api().put(`/api/orders/${id}/items`).set(auth(innov)).send({ items: items() });
    await addMat(innov, id, { color_ids: colors('Sini-oq', 'Qora-siniy', 'Seriy'), material_id: ids.mat.tugma56, per_unit: 8, price: 100 });
    expect((await api().get(`/api/orders/${id}`).set(auth(taminot))).status).toBe(200);
    expect((await api().get('/api/orders').set(auth(hr))).status).toBe(403);
    expect((await api().put(`/api/orders/${id}/items`).set(auth(taminot)).send({ items: items() })).status).toBe(403);

    await api().post(`/api/orders/${id}/confirm`).set(auth(innov));
    const locked = await api().patch(`/api/orders/${id}`).set(auth(innov)).send({ model: 'x' });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('ORDER_LOCKED');
    expect((await api().delete(`/api/orders/${id}`).set(auth(innov))).status).toBe(409);

    expect((await api().post(`/api/orders/${id}/reopen`).set(auth(innov))).status).toBe(403);
    expect((await api().post(`/api/orders/${id}/reopen`).set(auth(rahbar))).body.order.status).toBe('draft');
    expect((await api().patch(`/api/orders/${id}`).set(auth(innov)).send({ model: 'yangi' })).body.order.model).toBe('yangi');

    const list = await api().get('/api/orders?q=541-902').set(auth(rahbar));
    expect(list.body.some((o: { id: number; qty: number }) => o.id === id && o.qty === 4174)).toBe(true);

    const audits = (await api().get('/api/audit?entity=order').set(auth(A))).body
      .filter((a: { entity_id: string }) => a.entity_id === String(id))
      .map((a: { action: string }) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['create', 'items', 'materials_add', 'confirm', 'reopen', 'update']));
  });

  it('ma\'lumotnomalar: ta\'minot qo\'shadi, skladchi yo\'q; nom takrorlanmaydi', async () => {
    const taminot = (await newUser(A, 'taminot')).token;
    const sklad = (await newUser(A, 'sklad')).token;
    expect((await api().post('/api/colors').set(auth(taminot)).send({ name: uniq('Rang') })).status).toBe(201);
    expect((await api().post('/api/colors').set(auth(sklad)).send({ name: uniq('Rang') })).status).toBe(403);
    expect((await api().get('/api/colors').set(auth(sklad))).status).toBe(200);
    expect((await api().post('/api/colors').set(auth(A)).send({ name: 'sini-OQ' })).status).toBe(409);
    expect((await api().post('/api/currency-rates').set(auth(sklad)).send({ currency: 'USD', rate: 1, valid_from: '2026-01-01' })).status).toBe(403);
  });
});
