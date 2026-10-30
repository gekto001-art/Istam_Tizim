import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { calcHours } from '../src/routes/hr.js';
import { admin, api, auth, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

let A: string;
const t: Record<string, string> = {};
let dept = 0;
let shim = 0;

beforeAll(async () => {
  A = (await admin()).token;
  for (const r of ['hr', 'tsex', 'buxgalter', 'sklad']) t[r] = (await newUser(A, r)).token;
  const deps = (await api().get('/api/hr/departments').set(auth(t.hr))).body as { id: number; name: string; producer_name: string | null }[];
  dept = deps.find((d) => d.name === 'Ko\'ylak Fabrika')!.id;
  shim = deps.find((d) => d.name === 'Shim Fabrika')!.id;
  expect(deps.find((d) => d.id === dept)!.producer_name).toBe('1-ISTAM KO\'YLAK');
});

describe('HR', () => {
  it('hisoblangan soat: tushlik, qo\'shimcha / javob so\'ragan, tungi smena', () => {
    expect(calcHours('08:00', '17:00', 0)).toBe(8);
    expect(calcHours('08:00', '17:00', -2)).toBe(6);
    expect(calcHours('08:00', '17:00', 3)).toBe(11);
    expect(calcHours('08:00', '12:00', 0)).toBe(4);
    expect(calcHours('19:00', '07:00', 0)).toBe(11);
    expect(calcHours(null, '17:00', 0)).toBeNull();
  });

  it('xodim, tabel, ishbay, oylik, bonus, to\'lov → vedomost va akt sverka', async () => {
    const hire = (body: object, token = t.hr) => api().post('/api/hr/employees').set(auth(token)).send({ department_id: dept, hired_on: '2027-05-01', ...body });
    expect((await hire({ full_name: 'Test X' }, t.tsex)).status).toBe(403);
    const tikuvchi = (await hire({ full_name: uniq('TIKUVCHI '), position: 'Tikuvchi', brigade: '1-Brigada', gender: 'ayol' })).body;
    // oylik 2 080 000 / 208 soat = 10 000 so'm / soat
    const usta = (await hire({ full_name: uniq('USTA '), position: 'Tsex boshligʻi', salary: { amount: 2080000, norm_hours: 208 } })).body;
    const shimchi = (await hire({ full_name: uniq('SHIMCHI '), department_id: shim, position: 'Tikuvchi' })).body;
    expect(tikuvchi.department_name).toBe('Ko\'ylak Fabrika');

    // tabel: 8–17 → 8 soat; javob so'radi −2; kelmagan — sabab majburiy
    const day = (body: object, token = t.hr) => api().put('/api/hr/timesheet/day').set(auth(token)).send({ work_date: '2027-05-03', department_id: dept, ...body });
    expect((await day({ rows: [] }, t.tsex)).status).toBe(403);
    expect((await day({ rows: [{ employee_id: tikuvchi.id, absent: true }] })).body.message).toContain('sababini');
    expect((await day({ rows: [{ employee_id: tikuvchi.id }] })).body.message).toContain('vaqtni');
    const r1 = await day({
      rows: [
        { employee_id: tikuvchi.id, came_at: '08:00', left_at: '17:00' },
        { employee_id: usta.id, came_at: '08:00', left_at: '17:00', extra_hours: -2, note: 'javob so\'radi' },
        { employee_id: shimchi.id, came_at: '8:00', left_at: '17:00' }, // qo'shimcha ishchi (Shim Fabrika'dan)
      ],
    });
    expect(r1.body).toEqual({ saved: 3, removed: 0 });
    // shu kuni Shim Fabrika tabeliga ham kiritib bo'lmaydi
    expect((await day({ department_id: shim, rows: [{ employee_id: shimchi.id, came_at: '08:00', left_at: '17:00' }] })).status).toBe(409);
    const list = (await api().get(`/api/hr/timesheet/day?date=2027-05-03&department_id=${dept}`).set(auth(t.hr))).body;
    expect(list.find((r: { employee_id: number }) => r.employee_id === usta.id)).toMatchObject({ hours: '6.00', came_at: '08:00' });
    expect(list.find((r: { employee_id: number }) => r.employee_id === shimchi.id)).toMatchObject({ extra_worker: true, hours: '8.00' });
    // qayta saqlash: shimchi olib tashlandi, usta kelmagan
    expect(
      (await day({ rows: [{ employee_id: tikuvchi.id, came_at: '08:00', left_at: '17:00' }, { employee_id: usta.id, absent: true, reason: 'Kasal' }] })).body,
    ).toEqual({ saved: 2, removed: 1 });
    await day({ work_date: '2027-05-04', rows: [{ employee_id: usta.id, hours: 8 }, { employee_id: tikuvchi.id, came_at: '08:00', left_at: '17:00' }] });
    const month = (await api().get(`/api/hr/timesheet/month?month=2027-05&department_id=${dept}`).set(auth(t.hr))).body;
    expect(month.days).toHaveLength(31);
    const um = month.rows.find((r: { employee_id: number }) => r.employee_id === usta.id);
    expect(um).toMatchObject({ hours: 8, days: 1, absent: 1 });
    expect(um.cells['2027-05-03']).toMatchObject({ absent: true, reason: 'Kasal' });

    // ish turi va narx (sanadan): tsex kirita olmaydi, HR kiritadi
    const wt = (body: object, token = t.hr) => api().post('/api/hr/work-types').set(auth(token)).send({ department_id: dept, ...body });
    expect((await wt({ category: 'Manjet', name: 'x' }, t.tsex)).status).toBe(403);
    const manjet = (await wt({ category: 'Manjet', name: uniq('Manjet tikish '), price: 100, valid_from: '2027-05-01' })).body;
    const yoqa = (await wt({ category: 'Yoqa', name: uniq('Yoqa ulash ') })).body; // narxsiz
    // ish nazorati — tsex kiritadi
    const log = (body: object, token = t.tsex) => api().post('/api/hr/work-logs').set(auth(token)).send(body);
    expect((await log({ work_date: '2027-05-03', rows: [{ employee_id: tikuvchi.id, work_type_id: manjet.id, qty: 1 }] }, t.sklad)).status).toBe(403);
    const l1 = await log({ work_date: '2027-05-03', rows: [{ employee_id: tikuvchi.id, work_type_id: manjet.id, qty: 300 }, { employee_id: tikuvchi.id, work_type_id: yoqa.id, qty: 50 }] });
    expect(l1.body).toEqual({ saved: 2, amount: '30000.00', zero_price: 1 });
    expect((await log({ work_date: '2027-04-30', rows: [{ employee_id: tikuvchi.id, work_type_id: manjet.id, qty: 1 }] })).body.message).toContain('ishda emas');
    // yoqa narxi 3-maydan 200 → avvalgi yozuv ham qayta hisoblanadi; 5-maydan manjet 120
    const price = (id: number, body: object) => api().post(`/api/hr/work-types/${id}/prices`).set(auth(t.hr)).send(body);
    await price(yoqa.id, { valid_from: '2027-05-03', price: 200 });
    await price(manjet.id, { valid_from: '2027-05-05', price: 120 });
    await log({ work_date: '2027-05-05', rows: [{ employee_id: tikuvchi.id, work_type_id: manjet.id, qty: 100 }] });
    const logs = (await api().get(`/api/hr/work-logs?employee_id=${tikuvchi.id}`).set(auth(t.tsex))).body;
    expect(logs.map((l: { amount: string }) => l.amount)).toEqual(['12000.00', '10000.00', '30000.00']);
    // tsex maosh / vedomostni ko'rmaydi
    expect((await api().get(`/api/hr/employees/${usta.id}`).set(auth(t.tsex))).status).toBe(403);
    expect((await api().get('/api/hr/payroll?from=2027-05-01&to=2027-05-31').set(auth(t.tsex))).status).toBe(403);

    // bonus, ushlab qolish, to'lovlar
    const adj = (body: object) => api().post('/api/hr/adjustments').set(auth(t.hr)).send({ adj_date: '2027-05-31', ...body });
    expect((await adj({ employee_id: tikuvchi.id, kind: 'penalty', amount: 5000 })).body.message).toContain('Izoh');
    await adj({ employee_id: tikuvchi.id, kind: 'bonus', amount: 20000 });
    await adj({ employee_id: tikuvchi.id, kind: 'penalty', amount: 5000, note: 'Brak' });
    const pay = (body: object, token = t.buxgalter) => api().post('/api/hr/payments').set(auth(token)).send(body);
    expect((await pay({ pay_date: '2027-05-15', employee_id: tikuvchi.id, method: 'naqd', amount: 1000 }, t.hr)).status).toBe(403);
    await pay({ pay_date: '2027-05-15', employee_id: tikuvchi.id, method: 'naqd', amount: 40000, note: 'Avans' });
    await pay({ pay_date: '2027-06-02', employee_id: tikuvchi.id, method: 'bank', amount: 27000 });

    // vedomost (may): tikuvchi — ishbay 12 000 + 10 000 + 30 000 = 52 000, bonus 20 000, ushlab qolish 5 000 → 67 000; avans 40 000 → qoldiq 27 000
    const pr = (await api().get(`/api/hr/payroll?from=2027-05-01&to=2027-05-31&department_id=${dept}`).set(auth(t.buxgalter))).body;
    const tk = pr.rows.find((r: { employee_id: number }) => r.employee_id === tikuvchi.id);
    expect(tk).toMatchObject({ days: 2, hours: '16.00', piece: '52000.00', salary: '0.00', bonus: '20000.00', penalty: '5000.00', accrued: '67000.00', cash: '40000.00', closing: '27000.00' });
    // usta: 8 soat × 10 000 = 80 000 (kelmagan kun hisoblanmaydi)
    expect(pr.rows.find((r: { employee_id: number }) => r.employee_id === usta.id)).toMatchObject({ salary: '80000.00', days: 1, absent_days: 1, closing: '80000.00' });
    expect(pr.rows.find((r: { employee_id: number }) => r.employee_id === shimchi.id)).toBeUndefined();

    // oylik o'zgardi (5-maydan 4 160 000 → 20 000 / soat) → 4-maydagi 8 soat avvalgi stavkada
    await api().post(`/api/hr/employees/${usta.id}/salaries`).set(auth(t.hr)).send({ valid_from: '2027-05-05', amount: 4160000 });
    await day({ work_date: '2027-05-05', rows: [{ employee_id: usta.id, hours: 8 }] });
    const us = (await api().get(`/api/hr/employees/${usta.id}/statement?from=2027-05-01&to=2027-05-31`).set(auth(t.hr))).body;
    expect(us.totals).toMatchObject({ salary: '240000.00', closing: '240000.00' });
    expect(us.attendance).toMatchObject({ days: 2, absent_days: 1 });

    // akt sverka (iyun): davr boshi 27 000, bank 27 000 → 0
    const st = (await api().get(`/api/hr/employees/${tikuvchi.id}/statement?from=2027-06-01&to=2027-06-30`).set(auth(t.hr))).body;
    expect(st.opening).toBe('27000.00');
    expect(st.totals.closing).toBe('0.00');
    const may = (await api().get(`/api/hr/employees/${tikuvchi.id}/statement?from=2027-05-01&to=2027-05-31`).set(auth(t.hr))).body;
    expect(may.works.map((w: { qty: number; price: string; amount: string }) => [w.qty, w.price, w.amount])).toEqual([
      [300, '100.00', '30000.00'],
      [100, '120.00', '12000.00'],
      [50, '200.00', '10000.00'],
    ]);
    expect(may.rows.at(-1).balance).toBe('27000.00');

    // bo'shatish: tabeldagi oxirgi ish kunidan oldin bo'lmaydi
    expect((await api().post(`/api/hr/employees/${usta.id}/fire`).set(auth(t.hr)).send({ fired_on: '2027-05-04' })).status).toBe(409);
    const f = await api().post(`/api/hr/employees/${usta.id}/fire`).set(auth(t.hr)).send({ fired_on: '2027-05-31', reason: 'O\'z xohishi' });
    expect(f.body.fired_on).toBe('2027-05-31');
    expect((await api().get(`/api/hr/employees?department_id=${dept}`).set(auth(t.hr))).body.map((e: { id: number }) => e.id)).not.toContain(usta.id);
    expect((await api().get(`/api/hr/timesheet/day?date=2027-06-01&department_id=${dept}`).set(auth(t.hr))).body.map((e: { employee_id: number }) => e.employee_id)).not.toContain(usta.id);
  });
});
