import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { admin, api, auth, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

let A: string;
const t: Record<string, string> = {};
type Meta = {
  wallets: { id: number; name: string; kind: string }[];
  op_types: { id: number; name: string }[];
  centers: { id: number; name: string }[];
  items: { id: number; code: number; group_name: string }[];
};
let m: Meta;
const op = (n: string) => m.op_types.find((o) => o.name === n)!.id;

beforeAll(async () => {
  A = (await admin()).token;
  for (const r of ['kassir', 'buxgalter', 'hr']) t[r] = (await newUser(A, r)).token;
  m = (await api().get('/api/cash/meta').set(auth(t.kassir))).body;
});

describe('Kassa', () => {
  it('kirim, xarajat, transfer, ayriboshlash, avans-hisobot → qoldiq va hisobot', async () => {
    expect(m.items.find((i) => i.code === 3001)!.group_name).toBe('Ishchilar');
    expect((await api().get('/api/cash/meta').set(auth(t.hr))).status).toBe(403);
    // test uchun alohida hamyonlar
    const mk = async (body: object) => (await api().post('/api/cash/wallets').set(auth(t.buxgalter)).send(body)).body as { id: number };
    expect((await api().post('/api/cash/wallets').set(auth(t.kassir)).send({ name: 'x' })).status).toBe(403);
    const kassa = await mk({ name: uniq('Kassa ') });
    const karta = await mk({ name: uniq('Karta '), kind: 'karta' });
    const avans = m.wallets.find((w) => w.kind === 'avans')!;
    const adm = m.centers.find((c) => c.name === 'Administratsiya')!.id;
    const taksi = m.items.find((i) => i.code === 5003)!.id;
    const post = (rows: object[], entry_date = '2027-07-01', token = t.kassir) => api().post('/api/cash/entries').set(auth(token)).send({ entry_date, rows });

    expect((await post([{ wallet_id: kassa.id, op_type_id: op('Kun boshiga qoldiq'), amount_in: 1 }], '2027-07-01', t.hr)).status).toBe(403);
    expect((await post([{ wallet_id: kassa.id, op_type_id: op('Kun boshiga qoldiq'), amount_out: 5 }])).body.message).toContain('faqat kirim');
    expect((await post([{ wallet_id: kassa.id, op_type_id: op('Xarajatlar'), amount_out: 5 }])).body.message).toContain('xarajat elementini');
    expect((await post([{ wallet_id: kassa.id, op_type_id: op('Boshqa tushumlar'), currency: 'USD', amount_in: 5 }], '2024-01-01')).body.message).toContain('USD kursi');
    const r1 = await post([
      { wallet_id: kassa.id, op_type_id: op('Kun boshiga qoldiq'), amount_in: 10000000, note: 'Kun boshiga qoldiq' },
      { wallet_id: kassa.id, op_type_id: op('Kun boshiga qoldiq'), currency: 'USD', rate: 12000, amount_in: 1000 },
      { wallet_id: kassa.id, op_type_id: op('Sotuvdan tushum'), amount_in: 5000000, counterparty: 'Safo', department: 'TB' },
      { wallet_id: kassa.id, op_type_id: op('Xarajatlar'), center_id: adm, item_id: taksi, amount_out: 40000, note: 'Taksi', period: '2027-07' },
    ]);
    expect(r1.body).toEqual({ saved: 4 });

    // ichki transfer: kassa → karta (2 yozuv)
    expect((await post([{ wallet_id: kassa.id, op_type_id: op('Ichki transfer'), amount_out: 1000000 }], '2027-07-02')).body.message).toContain('qaysi hamyonga');
    expect((await post([{ wallet_id: kassa.id, op_type_id: op('Ichki transfer'), to_wallet_id: karta.id, amount_out: 3000000 }], '2027-07-02')).body).toEqual({ saved: 2 });
    // ayriboshlash: 500 USD → 6 250 000 so'm (bitta hamyonda)
    expect(
      (await post([{ wallet_id: kassa.id, op_type_id: op('Valyuta ayriboshlash'), currency: 'USD', rate: 12500, amount_out: 500, to_currency: 'UZS', to_amount: 6250000 }], '2027-07-02')).body,
    ).toEqual({ saved: 2 });
    // avans-hisobot: Lazizjon nomiga 1 000 000, u 300 000 xarajat qildi
    expect((await post([{ wallet_id: kassa.id, op_type_id: op('Avans-hisobot tizimi'), to_wallet_id: avans.id, amount_out: 1000000 }], '2027-07-03')).body.message).toContain('ma\'sul shaxs');
    await post([{ wallet_id: kassa.id, op_type_id: op('Avans-hisobot tizimi'), to_wallet_id: avans.id, amount_out: 1000000, responsible: 'Lazizjon' }], '2027-07-03');
    expect((await post([{ wallet_id: avans.id, op_type_id: op('Xarajatlar'), center_id: adm, item_id: taksi, amount_out: 300000 }], '2027-07-04')).body.message).toContain('ma\'sul shaxs');
    await post([{ wallet_id: avans.id, op_type_id: op('Xarajatlar'), center_id: adm, item_id: taksi, amount_out: 300000, responsible: 'lazizjon ' }], '2027-07-04');

    // qoldiq: so'm 10 000 000 + 5 000 000 − 40 000 − 3 000 000 + 6 250 000 − 1 000 000 = 17 210 000; USD 500
    const bal = (await api().get('/api/cash/balances?on=2027-07-31').set(auth(t.kassir))).body;
    const b = (w: number, c: string) => bal.find((x: { wallet_id: number; currency: string }) => x.wallet_id === w && x.currency === c)?.balance;
    expect(b(kassa.id, 'UZS')).toBe('17210000.00');
    expect(b(kassa.id, 'USD')).toBe('500.00');
    expect(b(karta.id, 'UZS')).toBe('3000000.00');

    // hisobot (2-iyuldan): boshi 14 960 000, boshqa kirim 6 250 000, chiqim 4 000 000
    const rep = (await api().get('/api/cash/report?from=2027-07-02&to=2027-07-31').set(auth(t.buxgalter))).body;
    expect(rep.wallets.find((x: { wallet_id: number; currency: string }) => x.wallet_id === kassa.id && x.currency === 'UZS')).toMatchObject({
      opening: '14960000.00',
      sales_in: '0',
      other_in: '6250000.00',
      out: '4000000.00',
      closing: '17210000.00',
    });
    const july = (await api().get('/api/cash/report?from=2027-07-01&to=2027-07-31').set(auth(t.buxgalter))).body;
    expect(july.by_item.find((x: { code: number }) => x.code === 5003)).toMatchObject({ amount_uzs: '340000.00', group_name: 'Logistika' });

    // avans-hisobot: Lazizjon — topshirilgan 1 000 000, hisobot 300 000, qoldiq 700 000 (katta-kichik harf farqi yo'q)
    const av = (await api().get('/api/cash/avans?from=2027-07-01&to=2027-07-31').set(auth(t.kassir))).body;
    expect(av.find((x: { responsible: string }) => x.responsible.trim().toLowerCase() === 'lazizjon')).toMatchObject({ given: '1000000.00', reported: '300000.00', closing: '700000.00' });

    // jurnal va o'chirish: transferni o'chirsa — juftligi ham o'chadi
    const j = (await api().get(`/api/cash/entries?wallet_id=${karta.id}`).set(auth(t.kassir))).body;
    expect(j[0]).toMatchObject({ op_name: 'Ichki transfer', amount_in: '3000000.00' });
    expect(j[0].pair_wallet).toContain('Kassa');
    expect((await api().delete(`/api/cash/entries/${j[0].id}`).set(auth(t.kassir))).body).toEqual({ deleted: 2 });
    const bal2 = (await api().get('/api/cash/balances').set(auth(t.kassir))).body;
    expect(bal2.find((x: { wallet_id: number; currency: string }) => x.wallet_id === kassa.id && x.currency === 'UZS').balance).toBe('20210000.00');
    expect(bal2.find((x: { wallet_id: number }) => x.wallet_id === karta.id)).toBeUndefined();
    // qidirish
    expect((await api().get('/api/cash/entries?q=safo').set(auth(t.kassir))).body.map((x: { amount_in: string }) => x.amount_in)).toContain('5000000.00');
  });
});
