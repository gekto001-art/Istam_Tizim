import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { admin, api, auth, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

let A: string;
const t: Record<string, string> = {};

beforeAll(async () => {
  A = (await admin()).token;
  for (const r of ['hr', 'kassir', 'buxgalter']) t[r] = (await newUser(A, r)).token;
});

type Entry = { id: number; wallet_id: number; op_name: string; item_code: number | null; center_name: string | null; counterparty: string; amount_in: string; amount_out: string; source: string | null };

describe('HR va Sotuv to\'lovlari kassaga yoziladi', () => {
  it('HR to\'lovi → kassada chiqim (3001 Ish haqi); Sotuv to\'lovi → ichki transfer; o\'chirish manba orqali', async () => {
    const wallet = async (name: string, business = 'moliya', kind = 'naqd') =>
      (await api().post('/api/cash/wallets').set(auth(t.buxgalter)).send({ name: uniq(name), business, kind })).body.id as number;
    const fabrika = await wallet('Fabrika kassa ', 'ishlab');
    const sotuv = await wallet('Safo kassa ', 'tijorat');
    const avans = ((await api().get('/api/cash/meta').set(auth(t.kassir))).body.wallets as { id: number; kind: string }[]).find((w) => w.kind === 'avans')!.id;
    const entries = async (w: number) => (await api().get(`/api/cash/entries?wallet_id=${w}`).set(auth(t.kassir))).body as Entry[];

    // HR: Ko'ylak Fabrika (tsexga bog'langan) xodimiga avans
    const dept = ((await api().get('/api/hr/departments').set(auth(t.hr))).body as { id: number; name: string }[]).find((d) => d.name === 'Ko\'ylak Fabrika')!.id;
    const emp = (await api().post('/api/hr/employees').set(auth(t.hr)).send({ full_name: uniq('XODIM '), department_id: dept, hired_on: '2027-08-01' })).body;
    const pay = (body: object) => api().post('/api/hr/payments').set(auth(t.kassir)).send({ pay_date: '2027-08-10', employee_id: emp.id, method: 'naqd', amount: 300000, ...body });
    expect((await pay({ wallet_id: avans })).body.message).toContain('Avans-hisobot hamyonidan');
    const p1 = await pay({ wallet_id: fabrika, note: 'Avgust' });
    expect(p1.status).toBe(201);
    await pay({}); // hamyonsiz — kassaga yozilmaydi
    let fe = await entries(fabrika);
    expect(fe).toHaveLength(1);
    expect(fe[0]).toMatchObject({ op_name: 'Xarajatlar', item_code: 3001, center_name: 'Tovarlar tannarxi (ishlab chiqarish)', counterparty: emp.full_name, amount_out: '300000.00', source: 'hr_payment' });
    const hp = (await api().get(`/api/hr/payments?employee_id=${emp.id}`).set(auth(t.kassir))).body;
    expect(hp.map((x: { wallet_name: string | null }) => x.wallet_name)).toContain((await api().get('/api/cash/meta').set(auth(t.kassir))).body.wallets.find((w: { id: number }) => w.id === fabrika).name);
    // kassadan o'chirib bo'lmaydi — HR'dan o'chiriladi
    expect((await api().delete(`/api/cash/entries/${fe[0].id}`).set(auth(t.kassir))).status).toBe(409);
    expect((await api().delete(`/api/hr/payments/${p1.body.id}`).set(auth(t.kassir))).status).toBe(204);
    expect(await entries(fabrika)).toHaveLength(0);

    // Sotuv → ishlab chiqarish: ikki hamyon — ichki transfer
    const sp = (body: object) => api().post('/api/sales/payments').set(auth(t.buxgalter)).send({ pay_date: '2027-08-11', amount_uzs: 2000000, method: 'naqd', ...body });
    expect((await sp({ from_wallet_id: sotuv })).body.message).toContain('ikkala hamyonni');
    expect((await sp({ from_wallet_id: sotuv, to_wallet_id: sotuv })).status).toBe(400);
    const s1 = await sp({ from_wallet_id: sotuv, to_wallet_id: fabrika });
    expect(s1.status).toBe(201);
    expect((await entries(sotuv))[0]).toMatchObject({ op_name: 'Ichki transfer', amount_out: '2000000.00', source: 'sales_payment' });
    fe = await entries(fabrika);
    expect(fe[0]).toMatchObject({ op_name: 'Ichki transfer', amount_in: '2000000.00', source: 'sales_payment' });
    const bal = (await api().get('/api/cash/balances').set(auth(t.kassir))).body as { wallet_id: number; balance: string }[];
    expect(bal.find((b) => b.wallet_id === fabrika)!.balance).toBe('2000000.00');
    expect((await api().delete(`/api/cash/entries/${fe[0].id}`).set(auth(t.kassir))).body.message).toContain('Sotuv');
    expect((await api().delete(`/api/sales/payments/${s1.body.id}`).set(auth(t.buxgalter))).status).toBe(204);
    expect(await entries(sotuv)).toHaveLength(0);
    expect(await entries(fabrika)).toHaveLength(0);
  });
});
