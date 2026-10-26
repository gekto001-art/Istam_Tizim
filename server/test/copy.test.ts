import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { admin, api, auth, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

type Named = { id: number; name: string };
let A: string;
let innov: string;
const ids: Record<string, Record<string, number>> = {};
const byName = async (path: string) =>
  Object.fromEntries(((await api().get(`/api/${path}`).set(auth(A))).body as Named[]).map((x) => [x.name, x.id]));

beforeAll(async () => {
  A = (await admin()).token;
  innov = (await newUser(A, 'innovatsiya')).token;
  ids.color = await byName('colors');
  ids.size = await byName('sizes');
  ids.type = await byName('product-types');
  ids.supplier = await byName('suppliers');
  ids.producer = await byName('producers');
  const mk = async (name: string, unit: string, supplier: string) =>
    (await api().post('/api/materials').set(auth(A)).send({ name, code: uniq('C'), unit, supplier_id: ids.supplier[supplier] })).body.id as number;
  ids.mat = { mato: await mk('mato', 'Metr', 'XIUDONG'), tugma: await mk('Tugma', 'Dona', 'BUTTON') };
});

const cell = (s: string, c: string, qty: number) => ({ size_id: ids.size[s], color_id: ids.color[c], qty });

/** Manba: 422-2 model, Qora (3--6, 7--10) va Oq (3--6); mato rangi = mahsulot rangi, 7--10 ga alohida sarf. */
async function sourceOrder() {
  const o = (
    await api()
      .post('/api/orders')
      .set(auth(innov))
      .send({ partiya_no: uniq('SRC'), order_date: '2026-08-01', product_type_id: ids.type.Rubashka, model: '422-2', artikul: 'A-1', season: 'Kuz', producer_id: ids.producer['ADIN HABIBULLOX'] })
  ).body.order;
  await api().put(`/api/orders/${o.id}/items`).set(auth(innov)).send({ items: [cell('3--6', 'Qora', 100), cell('7--10', 'Qora', 120), cell('3--6', 'Oq', 50)] });
  const line = (color: string, size: string | null, material: number, per_unit: number, extra: object = {}) => ({
    color_id: ids.color[color], size_id: size ? ids.size[size] : null, material_id: material, per_unit, ...extra,
  });
  const mato = (c: string) => ({ material_color_id: ids.color[c], price: 2, currency: 'USD', rate: 11000, is_main: true });
  const r = await api()
    .put(`/api/orders/${o.id}/materials`)
    .set(auth(innov))
    .send({
      lines: [
        line('Qora', '3--6', ids.mat.mato, 0.7, mato('Qora')),
        line('Qora', '7--10', ids.mat.mato, 0.8, mato('Qora')),
        line('Qora', null, ids.mat.tugma, 6, { price: 100, material_color_id: ids.color.Oq }),
        line('Oq', null, ids.mat.mato, 0.7, mato('Oq')),
        line('Oq', null, ids.mat.tugma, 6, { price: 100, material_color_id: ids.color.Oq }),
      ],
    });
  expect(r.status).toBe(200);
  await api().put(`/api/orders/${o.id}/works`).set(auth(innov)).send({ works: [{ producer_id: ids.producer.Kroy, price: 1200 }] });
  await api().post(`/api/orders/${o.id}/confirm`).set(auth(innov));
  return o.id as number;
}

async function newDraft(items?: object[]) {
  const o = (await api().post('/api/orders').set(auth(innov)).send({ partiya_no: uniq('NEW'), order_date: '2026-10-25', product_type_id: ids.type.Dvoyka })).body.order;
  if (items) await api().put(`/api/orders/${o.id}/items`).set(auth(innov)).send({ items });
  return o.id as number;
}

describe('Oldingi zakazdan olish', () => {
  it('xomashyo: ranglar mosligi, mato rangi moslashadi, razmer qatori o\'tkazib yuboriladi; kurs yangi sanadan; ish narxlari', async () => {
    // 24-oktabrdan — boshqa testlardagi 23-oktabr zakazlariga ta'sir qilmaydi
    await api().post('/api/currency-rates').set(auth(A)).send({ currency: 'USD', rate: 12700, valid_from: '2026-10-24' });
    const src = await sourceOrder();
    // yangi zakaz: Qora (faqat 3--6) va Seriy (3--6, 7--10); Seriy normasi manbadagi Qoradan
    const id = await newDraft([cell('3--6', 'Qora', 200), cell('3--6', 'Seriy', 150), cell('7--10', 'Seriy', 90)]);
    const r = await api()
      .post(`/api/orders/${id}/copy-from`)
      .set(auth(innov))
      .send({ source_id: src, color_map: [{ target_color_id: ids.color.Seriy, source_color_id: ids.color.Qora }] });
    expect(r.status).toBe(200);
    // Qora: 3--6 mato + tugma (7--10 qatori o'tkazildi); Seriy: 3--6, 7--10 mato + tugma
    expect(r.body.copy).toEqual({ lines: 5, skipped: 1, works: 1, items: 0 });
    const lines = r.body.materials.map((m: { color_name: string; size_name: string | null; material_name: string; material_color_name: string; rate: string; is_main: boolean }) =>
      `${m.color_name}/${m.size_name ?? '*'} ${m.material_name} ${m.material_color_name} ${m.rate} ${m.is_main}`,
    );
    expect(lines).toEqual([
      'Qora/3--6 mato Qora 12700.0000 true',
      'Qora/* Tugma Oq 1.0000 false',
      'Seriy/3--6 mato Seriy 12700.0000 true', // mato rangi yangi rangga moslashdi
      'Seriy/7--10 mato Seriy 12700.0000 true',
      'Seriy/* Tugma Oq 1.0000 false', // tugma rangi o'zgarmaydi
    ]);
    expect(r.body.works).toMatchObject([{ producer_name: 'Kroy', price: '1200.00' }]);
    expect(r.body.warnings.some((w: string) => w.startsWith('Xomashyo kiritilmagan'))).toBe(false);
    const audit = (await api().get('/api/audit?entity=order').set(auth(A))).body.find((a: { entity_id: string; action: string }) => a.entity_id === String(id) && a.action === 'copy_from');
    expect(audit.new_data).toMatchObject({ source_id: src, lines: 5 });
  });

  it('jadval va sarlavhani ham olish; mavjud qatorlarga qo\'shish (asosiy mato to\'qnashmaydi)', async () => {
    const src = await sourceOrder();
    const id = await newDraft();
    const r = await api().post(`/api/orders/${id}/copy-from`).set(auth(innov)).send({ source_id: src, header: true, items: true });
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ model: '422-2', artikul: 'A-1', season: 'Kuz', product_type_name: 'Rubashka', producer_name: 'ADIN HABIBULLOX' });
    expect(r.body.totals.qty).toBe(270);
    expect(r.body.copy).toMatchObject({ items: 3, lines: 5, skipped: 0 });
    // qo'shish rejimi: qatorlar ikki barobar, lekin asosiy belgisi takrorlanmaydi
    const again = await api().post(`/api/orders/${id}/copy-from`).set(auth(innov)).send({ source_id: src, replace_materials: false, works: false });
    expect(again.body.materials).toHaveLength(10);
    expect(again.body.materials.filter((m: { is_main: boolean }) => m.is_main)).toHaveLength(3);
    // xomashyo qolgan holda jadvalni almashtirib bo'lmaydi
    expect((await api().post(`/api/orders/${id}/copy-from`).set(auth(innov)).send({ source_id: src, items: true, materials: false, works: false })).status).toBe(409);
  });

  it('faqat qoralamaga, o\'zidan emas, ruxsat bilan', async () => {
    const src = await sourceOrder();
    const id = await newDraft([cell('3--6', 'Qora', 10)]);
    expect((await api().post(`/api/orders/${id}/copy-from`).set(auth(innov)).send({ source_id: id })).status).toBe(400);
    expect((await api().post(`/api/orders/${src}/copy-from`).set(auth(innov)).send({ source_id: id })).status).toBe(409); // tasdiqlangan
    const taminot = (await newUser(A, 'taminot')).token;
    expect((await api().post(`/api/orders/${id}/copy-from`).set(auth(taminot)).send({ source_id: src })).status).toBe(403);
    expect((await api().post(`/api/orders/${id}/copy-from`).set(auth(innov)).send({ source_id: src, materials: false, works: false })).status).toBe(400);
  });
});
