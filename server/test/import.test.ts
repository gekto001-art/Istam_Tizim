import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { mapHeaders, parseDate, parseMonth, parseNumber, parseTsv } from '../src/lib/sheet.js';
import { admin, api, auth, newUser, uniq } from './helpers.js';

afterAll(() => pool.end());

let A: string;
const tsv = (rows: string[][]) => rows.map((r) => r.map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join('\t')).join('\n');
const imp = (kind: string, body: object, token = A) => api().post(`/api/import/${kind}`).set(auth(token)).send(body);

beforeAll(async () => {
  A = (await admin()).token;
});

describe('Sheets matnini o\'qish', () => {
  it('sonlar: US va RU formatlari, minglik va kasr', () => {
    expect(parseNumber('79,862,000')).toBe(79862000);
    expect(parseNumber('-5,500,000.00')).toBe(-5500000);
    expect(parseNumber('1,340.00')).toBe(1340);
    expect(parseNumber('6 000,00')).toBe(6000);
    expect(parseNumber('1 295,8')).toBe(1295.8);
    expect(parseNumber('20,00')).toBe(20);
    expect(parseNumber('12,000')).toBe(12000);
    expect(parseNumber('7 200 000,00')).toBe(7200000);
    expect(parseNumber('34 615,38')).toBe(34615.38);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNaN();
  });
  it('sanalar va oylar', () => {
    expect(parseDate('01.11.2025')).toBe('2025-11-01');
    expect(parseDate('26,10,2026')).toBe('2026-10-26');
    expect(parseDate('8/24/2026 16:06:50')).toBe('2026-08-24');
    expect(parseDate('11.11.2025 22:37:40')).toBe('2025-11-11');
    expect(parseDate('09/01')).toBeNull();
    expect(parseDate('31.02.2026')).toBeNull();
    expect(parseMonth('Noyabr')).toBe(11);
    expect(parseMonth('Sentabr')).toBe(9);
  });
  it('TSV: qo\'shtirnoqli katakda yangi qator; sarlavha qatori pastda bo\'lishi mumkin', () => {
    const rows = parseTsv('Moliya bo\'limi\t\n"\nФИО"\tDolzh\nA\tB\n');
    expect(rows[1][0]).toBe('\nФИО');
    const m = mapHeaders([['x'], ['', 'Sana', 'Hamyon', 'Kirim']], { date: ['sana'], wallet: ['hamyon'], in: ['kirim'] }, ['date', 'in']);
    expect(m).toEqual({ headerRow: 1, map: { date: 1, wallet: 2, in: 3 } });
  });
});

describe('Import', () => {
  it('xodimlar → oyliklar → ish turlari → kassa (tekshirish, saqlash, bekor qilish)', async () => {
    expect((await imp('employees', { text: 'x' }, (await newUser(A, 'hr')).token)).status).toBe(403);
    const n1 = uniq('KENJAYEVA ').toUpperCase();
    const n2 = uniq('VOHIDOVA ').toUpperCase();
    // "Qabul/Bo'shatish baza" varag'i sarlavhalari (ФИО oldida yangi qator bor)
    const emp = tsv([
      ['Отметка времени', 'Адрес электронной почты', 'Тип', 'Отдел', '\nФИО', 'Должность', 'График работы', 'Дата приёма', 'ФИО сотрудник увол', 'Дата уволнения', 'Пол', 'Подразделения', 'Субподраделения'],
      ['24.08.2026', 'Script', 'Приём', "Fabrika va Ta'minot Bo'limi", n1, 'Tikuvchi', "To'liq ish kuni", '01.08.2026', '', '', 'Ayol', "Ko'ylak Fabrika", '1-Brigada'],
      ['24.08.2026', 'Script', 'Приём', "Fabrika va Ta'minot Bo'limi", n2, 'Dazmollovchi', "To'liqsiz ish kuni", '01.08.2026', '', '', 'Ayol', "Ko'ylak Fabrika", '2-Brigada'],
      ['24.08.2026', 'Script', 'Приём', '', 'XATO', 'Tikuvchi', '', '09/01', '', '', '', "Ko'ylak Fabrika", ''],
      ['30.09.2026', 'Script', 'Увольнение', '', '', '', '', '', n2.toLowerCase(), '15.09.2026', '', '', ''],
    ]);
    const dry = (await imp('employees', { text: emp })).body;
    expect(dry).toMatchObject({ saved: false, created: 2, updated: 1, error_count: 1, rows: 4 });
    expect(dry.errors[0]).toMatchObject({ row: 4, message: expect.stringContaining('qabul sanasi') });
    expect((await api().get('/api/hr/employees?status=all').set(auth(A))).body.some((e: { full_name: string }) => e.full_name === n1)).toBe(false);
    const real = (await imp('employees', { text: emp, dry_run: false })).body;
    expect(real).toMatchObject({ saved: true, created: 2, updated: 1 });
    const all = (await api().get('/api/hr/employees?status=all').set(auth(A))).body as { full_name: string; fired_on: string | null; work_mode: string; brigade: string; department_name: string }[];
    expect(all.find((e) => e.full_name === n1)).toMatchObject({ department_name: "Ko'ylak Fabrika", brigade: '1-Brigada', work_mode: 'full' });
    expect(all.find((e) => e.full_name === n2)).toMatchObject({ fired_on: '2026-09-15', work_mode: 'part' });
    // qayta import — dublikat yo'q
    expect((await imp('employees', { text: emp, dry_run: false })).body).toMatchObject({ created: 0, skipped: 3 });

    // "Oyliklar" varag'i: noma'lum xodim — bo'lim tanlanmasa xato, tanlansa yaratiladi
    const deps = (await api().get('/api/hr/departments').set(auth(A))).body as { id: number; name: string }[];
    const shim = deps.find((d) => d.name === 'Shim Fabrika')!.id;
    const n3 = uniq('SHIRINOVA ').toUpperCase();
    const sal = tsv([
      ['Kiritilgan sana', 'Sana', 'FIO', 'Ish rejimi', 'Bir oylik ish Soati', 'Oylik', 'Bir Soatlik ish haqi'],
      ['8/24/2026 16:06:50', '01.08.2026', `${n1} `, "To'liq ish kuni", '208', '2 080 000,00', '10 000,00'],
      ['8/24/2026 16:12:39', '01.08.2026', n3, "To'liq ish kuni", '208', '7 200 000,00', '34 615,38'],
    ]);
    expect((await imp('salaries', { text: sal, dry_run: false })).body).toMatchObject({ created: 1, error_count: 1 });
    expect((await imp('salaries', { text: sal, dry_run: false, department_id: shim })).body).toMatchObject({ created: 1, updated: 1, error_count: 0 });

    // "Ish Turi" varag'i: narxsiz qator — ish turi yaratiladi; narx — sanadan
    const w1 = uniq('karman chizish ');
    const wt = tsv([
      ['Timestamp', 'Operatsiya turi', 'Sana', 'Kategoriyalar', 'Ishlar nomi', 'Ish narxi', 'Sana', 'Ish turi', 'Narxi'],
      ['29.08.2026 10:48:19', "Ro'yhatga qo'shish", '27.08.2026', 'Zagatovka', w1, '45'],
      ['29.08.2026 10:54:34', "Ro'yhatga qo'shish", '27.08.2026', 'Zagatovka', `${w1}2`, ''],
      ['29.09.2026 10:54:34', "Narx o'zgartirish", '01.09.2026', '', w1, '50'],
    ]);
    expect((await imp('work_types', { text: wt, dry_run: false })).body.errors[0].message).toContain('bo\'limni');
    const kdep = deps.find((d) => d.name === "Ko'ylak Fabrika")!.id;
    expect((await imp('work_types', { text: wt, dry_run: false, department_id: kdep })).body).toMatchObject({ created: 2, updated: 1, error_count: 0 });
    const types = (await api().get(`/api/hr/work-types?department_id=${kdep}&on=2026-09-05`).set(auth(A))).body as { name: string; price: string; category: string }[];
    expect(types.find((t) => t.name === w1)).toMatchObject({ price: '50.00', category: 'Zagatovka' });

    // "Kassa Baza" varag'i: yuqorida jamlanma qatorlar, keyin sarlavha; gzip bilan
    const wName = uniq('MB Test Kassa ');
    const cashRows = [
      ['', '', '', '', "Moliya bo'limi "],
      ['', '', '', '', 'Koshelok', 'USD', 'UZS', 'CNY'],
      ['Kiritilgan sana', 'Sana', 'Hamyon', 'DOC', 'Tranzaksiya', 'Markaz', 'Xarajat elementlari', 'Kontragent', "Bo'lim", "Ma'sul shaxs", 'Detal', 'Valyuta turi', 'Valyuta kurs', 'Kirim', 'Chiqim', 'Farq', 'Tartib raqam', 'Kategoriya Kodi', 'Kategoriya Gruppasi', 'Kodlar', "So'm", 'Dollor', 'Yuan', 'Izoh', 'Oylar', '', 'Partiya №'],
      ['11.11.2025 22:37:40', '01.11.2025', wName, '', 'Kun boshiga qoldiq', '', '', '', '', 'Lazizjon', 'Kun boshiga qoldiq', "So'm", '', '79,862,000', '', '79,862,000.00', '1'],
      ['11.11.2025 22:37:40', '01.11.2025', wName, '', 'Kun boshiga qoldiq', '', '', '', '', 'Lazizjon', 'Kun boshiga qoldiq', 'Dollor', '12,000', '', '', '0.00', '2'],
      ['11.11.2025 22:37:40', '01.11.2025', wName, '', 'Ichki transfer', '', '', '', 'TB', 'Lazizjon', 'Tijorat kassasidan', 'Dollor', '12,000', '500', '', '500.00', '3'],
      ['11.11.2025 22:37:40', '01.11.2025', wName, '', 'Xarajatlar', 'Administratsiya', 'Ish haqi va maoshlar - doimiy', 'Laziz Sodiqov', '', 'Lazizjon', 'Maosh, oktyabr', "So'm", '', '', '5,500,000', '-5,500,000.00', '5', '3001', '3000', 'IGSL-CCADM01', '', '', '', '', 'Oktabr'],
      ['11.11.2025 22:37:40', '01.11.2025', wName, '', 'Xarajatlar', 'Ishlab chiqarish', 'Yangi element test', '', '', '', 'Click', "So'm", '', '', '2,000', '-2,000.00', '6', ''],
    ];
    const gz = gzipSync(Buffer.from(tsv(cashRows))).toString('base64');
    const cd = (await imp('cash', { gz })).body;
    expect(cd).toMatchObject({ saved: false, created: 4, skipped: 1, error_count: 0, header_row: 3 });
    expect(cd.warnings).toEqual(expect.arrayContaining([`Yangi hamyon yaratildi: «${wName}»`, expect.stringContaining('Yangi xarajat elementi yaratildi: 9900')]));
    // xato qator bo'lsa — kassa umuman saqlanmaydi
    const bad = tsv([...cashRows, ['', 'xato-sana', wName, '', 'Xarajatlar', '', '', '', '', '', '', "So'm", '', '', '1']]);
    expect((await imp('cash', { text: bad, dry_run: false })).body).toMatchObject({ saved: false, error_count: 1 });
    const ok = (await imp('cash', { gz, dry_run: false, business: 'moliya', label: 'Kassa Baza' })).body;
    expect(ok).toMatchObject({ saved: true, created: 4 });
    const meta = (await api().get('/api/cash/meta').set(auth(A))).body as { wallets: { id: number; name: string }[] };
    const wid = meta.wallets.find((w) => w.name === wName)!.id;
    const bal = (await api().get('/api/cash/balances').set(auth(A))).body as { wallet_id: number; currency: string; balance: string }[];
    expect(bal.filter((b) => b.wallet_id === wid).map((b) => [b.currency, b.balance])).toEqual([
      ['USD', '500.00'],
      ['UZS', '74360000.00'],
    ]);
    const entries = (await api().get(`/api/cash/entries?wallet_id=${wid}`).set(auth(A))).body as { item_code: number; center_name: string; period: string; note: string }[];
    expect(entries.find((e) => e.item_code === 3001)).toMatchObject({ center_name: 'Administratsiya', period: '2025-10' });
    expect(entries.find((e) => e.item_code === 9900)).toMatchObject({ center_name: 'Tovarlar tannarxi (ishlab chiqarish)' });
    // partiyani bekor qilish
    const batches = (await api().get('/api/import/batches').set(auth(A))).body as { id: number; kind: string; cash_rows: number }[];
    expect(batches[0]).toMatchObject({ id: ok.batch_id, kind: 'cash', cash_rows: 4 });
    expect((await api().delete(`/api/import/batches/${ok.batch_id}`).set(auth(A))).body).toEqual({ deleted: 4 });
    expect((await api().get('/api/cash/balances').set(auth(A))).body.filter((b: { wallet_id: number }) => b.wallet_id === wid)).toHaveLength(0);
  });
});
