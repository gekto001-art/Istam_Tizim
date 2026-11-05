/**
 * Google Sheets'dan nusxalangan (Ctrl+C) matnni o'qish: TSV (qo'shtirnoqli katakda yangi qator bo'lishi mumkin),
 * sanalar (01.11.2025, 26,10,2026, 8/24/2026, 2026-08-24, vaqt bilan), sonlar (79,862,000.00 · 6 000,00 · 1 295,8),
 * sarlavhalar — har xil yozilishi (Bo'lim / Bolim, ФИО, Дата приёма ...) bitta kalitga keltiriladi.
 */

export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === '\t') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/** Sarlavhani solishtirish uchun: kichik harf, ё→е, faqat harf va raqam */
export const normHeader = (h: string) =>
  h
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]/g, '');

/** Sarlavha qatorini topadi (required maydonlarning hammasi bor birinchi qator) va maydon → ustun indeksini qaytaradi */
export function mapHeaders(rows: string[][], fields: Record<string, string[]>, required: string[]) {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const norm = rows[r].map(normHeader);
    const map: Record<string, number> = {};
    for (const [field, syns] of Object.entries(fields)) {
      for (const syn of syns) {
        const i = norm.indexOf(syn);
        if (i >= 0) {
          map[field] = i;
          break;
        }
      }
    }
    if (required.every((f) => f in map)) return { headerRow: r, map };
  }
  return null;
}

/** Son: probel, bo'sh joylar olib tashlanadi; oxirgi ajratkich — kasr; "12,000" kabi uchlik guruhlar — minglik */
export function parseNumber(v: string | undefined | null): number | null {
  if (v == null) return null;
  let s = String(v).replace(/[\s  ]/g, '');
  if (s === '' || s === '-') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  }
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
  } else if (hasComma) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (hasDot && (s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, '');
  }
  if (!/^\d*\.?\d+$/.test(s) && !/^\d+\.?$/.test(s)) return NaN;
  const n = Number(s);
  return neg ? -n : n;
}

/** Sana → YYYY-MM-DD yoki null (noto'g'ri / yilsiz) */
export function parseDate(v: string | undefined | null): string | null {
  if (!v) return null;
  const s = String(v).trim().split(/[\sT]/)[0];
  let y: number;
  let m: number;
  let d: number;
  let r = s.match(/^(\d{1,2})[.,](\d{1,2})[.,](\d{4})$/);
  if (r) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [m, d, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
/** "Noyabr" / "sentyabr" / "11" → oy raqami (1–12) */
export function parseMonth(v: string | undefined | null): number | null {
  if (!v) return null;
  const s = normHeader(v).replace('sentyabr', 'sentabr').replace('oktyabr', 'oktabr');
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
  const i = MONTHS.findIndex((x) => s.startsWith(x.slice(0, 3)));
  return i >= 0 ? i + 1 : null;
}

/** Valyuta: So'm / Dollor / Dollar / Yuan / Euro / Rubl / USD ... */
export function parseCurrency(v: string | undefined | null): 'UZS' | 'USD' | 'CNY' | 'EUR' | 'RUB' | null {
  const s = normHeader(v ?? '');
  if (!s || s.startsWith('som') || s === 'uzs' || s.startsWith('сум') || s.startsWith('сўм')) return 'UZS';
  if (s.startsWith('dol') || s === 'usd' || s.startsWith('долл')) return 'USD';
  if (s.startsWith('yuan') || s === 'cny' || s.startsWith('юан')) return 'CNY';
  if (s.startsWith('eur') || s.startsWith('евро')) return 'EUR';
  if (s.startsWith('rub') || s.startsWith('руб')) return 'RUB';
  return null;
}

/** Ism-familiyani solishtirish: katta harf, ortiqcha probellarsiz, ’ ʻ ` → ' */
export const normName = (s: string) =>
  s
    .replace(/[’ʻʼ`‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
