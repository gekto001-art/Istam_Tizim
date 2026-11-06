import { Router } from 'express';
import { z } from 'zod';
import { requireAction } from '../auth/context.js';
import { pool } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { EVENTS } from './hr.js';

/**
 * Moliyaviy hisobotlar. P&L (foyda va zarar) — har biznes alohida, oylar kesimida:
 *  - Ishlab chiqarish: daromad — Sotuv bo'limi qabul qilgan o'tkazmalar (ichki narx);
 *    tannarx — materiallar (tayyor mahsulot tannarxi − zakazdagi ish narxlari; ish haqi alohida — HR nachisleniyasidan);
 *    spisaniya (yaroqsiz, material qismi), ish haqi (HR, bo'lim «ishlab»), kassa xarajatlari (ishlab hamyonlari).
 *  - Sotuv bo'limi: ulgurji (nakladnoy: sotuv − vozvrat) va do'konlar (Billz) sotuvi, tannarxi;
 *    inventarizatsiya farqi, agent komissiyasi (hisoblangan), ish haqi (HR, bo'lim «sotuv»), kassa xarajatlari (tijorat hamyonlari).
 *  - Umumiy: ish haqi (HR, bo'lim «umumiy»), kassa xarajatlari (moliya hamyonlari).
 * Kassadan faqat «P&L ga kiradi» belgili tranzaksiya turlari olinadi: chiqim — xarajat (element guruhi bo'yicha), kirim — boshqa daromad.
 * Ikki marta hisoblanmasligi uchun kassadan olinmaydi: ish haqi va bonus (3001, 3010 — HR'dan), agent komissiyasi (3009 — nakladnoydan),
 * xomashyo (4001–4015 — skladga kiradi, tannarxda).
 */
export const financeRouter = Router();
financeRouter.use(requireAction('reports.finance'));

const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));
export const EXCLUDED_ITEMS = [3001, 3009, 3010, ...Array.from({ length: 15 }, (_, i) => 4001 + i)];

type Biz = 'ishlab' | 'sotuv' | 'umumiy';
type Kind = 'line' | 'sub' | 'total';
type Line = { key: string; label: string; kind: Kind; values: Record<string, string>; total: string };

const TITLES: Record<Biz, string> = { ishlab: 'Ishlab chiqarish', sotuv: 'Sotuv bo\'limi', umumiy: 'Umumiy (moliya bo\'limi)' };
const LABELS: Record<string, string> = {
  revenue: 'Sotuv bo\'limiga sotilgan (ichki narx)',
  cogs: 'Material tannarxi',
  scrap: 'Spisaniya (yaroqsiz)',
  wholesale: 'Ulgurji sotuv (sotuv − vozvrat)',
  shop: 'Do\'konlar sotuvi (Billz)',
  cogs_wholesale: 'Ulgurji tannarxi',
  cogs_shop: 'Do\'konlar tannarxi (Billz)',
  adjust: 'Inventarizatsiya farqi',
  commission: 'Agent komissiyasi',
  wages: 'Ish haqi (HR nachisleniya)',
  other_income: 'Boshqa daromadlar (kassa)',
};

/** Har yozuv: biznes, satr kaliti, satr nomi (kassa guruhlari uchun), sana, summa (daromad +, xarajat −) */
const ROWS = `
  WITH wk AS (SELECT order_id, sum(price) AS work FROM order_works GROUP BY order_id),
  src AS (
    SELECT 'ishlab' AS biz, 'revenue' AS key, NULL AS label, t.decided_date AS d, i.qty * i.price AS amt
      FROM sales_transfers t JOIN sales_transfer_items i ON i.transfer_id = t.id WHERE t.status = 'accepted'
    UNION ALL
    SELECT 'ishlab', 'cogs', NULL, t.decided_date, -(i.qty * greatest(i.unit_cost_uzs - coalesce(wk.work, 0), 0))
      FROM sales_transfers t JOIN sales_transfer_items i ON i.transfer_id = t.id LEFT JOIN wk ON wk.order_id = i.order_id WHERE t.status = 'accepted'
    UNION ALL
    SELECT 'ishlab', 'scrap', NULL, b.sort_date, -b.scrap_cost_uzs FROM kroy_brak_sorts b WHERE b.scrap > 0
    UNION ALL
    SELECT 'ishlab', 'scrap', NULL, t.otk_date, -(t.otk_scrap * greatest(t.unit_cost_uzs - coalesce(wk.work, 0), 0))
      FROM tsex_outputs t JOIN tsex_docs d ON d.id = t.doc_id LEFT JOIN wk ON wk.order_id = d.order_id WHERE t.otk_scrap > 0
    UNION ALL
    SELECT dp.business, 'wages', NULL, ev.d, -(ev.salary + ev.piece + ev.bonus + ev.other - ev.penalty)
      FROM (${EVENTS}) ev JOIN employees e ON e.id = ev.employee_id JOIN hr_departments dp ON dp.id = e.department_id
     WHERE ev.salary + ev.piece + ev.bonus + ev.other - ev.penalty <> 0
    UNION ALL
    SELECT 'sotuv', 'wholesale', NULL, iv.doc_date, CASE iv.kind WHEN 'sale' THEN 1 ELSE -1 END * m.qty * m.price
      FROM sales_moves m JOIN sales_invoices iv ON iv.id = m.invoice_id
    UNION ALL
    SELECT 'sotuv', 'cogs_wholesale', NULL, iv.doc_date, CASE iv.kind WHEN 'sale' THEN -1 ELSE 1 END * m.qty * m.unit_cost
      FROM sales_moves m JOIN sales_invoices iv ON iv.id = m.invoice_id
    UNION ALL
    SELECT 'sotuv', 'commission', NULL, iv.doc_date, CASE iv.kind WHEN 'sale' THEN -1 ELSE 1 END * m.qty * m.price * a.commission_pct / 100
      FROM sales_moves m JOIN sales_invoices iv ON iv.id = m.invoice_id JOIN sales_agents a ON a.id = iv.agent_id WHERE a.commission_pct > 0
    UNION ALL
    SELECT 'sotuv', 'shop', NULL, s.date, s.net_sales FROM billz_sales s
    UNION ALL
    SELECT 'sotuv', 'cogs_shop', NULL, s.date, -s.supply_sum FROM billz_sales s
    UNION ALL
    SELECT 'sotuv', 'adjust', NULL, m.move_date, m.dir * m.qty * m.unit_cost FROM sales_moves m WHERE m.kind = 'adjust'
    UNION ALL
    SELECT CASE w.business WHEN 'ishlab' THEN 'ishlab' WHEN 'tijorat' THEN 'sotuv' ELSE 'umumiy' END,
           CASE WHEN e.amount_in > 0 THEN 'other_income' ELSE 'exp:' || coalesce((it.code / 1000) * 1000, 0) END,
           CASE WHEN e.amount_in > 0 THEN NULL ELSE coalesce(g.name, 'Xarajat elementi ko''rsatilmagan') END,
           e.entry_date, round((e.amount_in - e.amount_out) * e.rate, 2)
      FROM cash_entries e JOIN cash_wallets w ON w.id = e.wallet_id JOIN cash_op_types o ON o.id = e.op_type_id
      LEFT JOIN cash_items it ON it.id = e.item_id LEFT JOIN cash_item_groups g ON g.code = (it.code / 1000) * 1000
     WHERE o.in_pnl AND e.source IS DISTINCT FROM 'hr_payment' AND (it.code IS NULL OR NOT (it.code = ANY($3::int[])))
  )
  SELECT biz, key, max(label) AS label, to_char(d, 'YYYY-MM') AS m, round(sum(amt), 2) AS amt
    FROM src WHERE d BETWEEN $1 AND $2 GROUP BY biz, key, m`;

const cents = (s: string | number) => Math.round(Number(s) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);

/** Oylar ro'yxati: from oyidan to oyigacha (YYYY-MM) */
export function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m === 12 ? ((y += 1), (m = 1)) : (m += 1);
  }
  return out;
}

financeRouter.get('/pnl', async (req, res) => {
  const q = z.object({ from: date, to: date }).parse(req.query);
  if (q.to < q.from) throw badRequest('Sanagacha sanadan oldin bo\'lishi mumkin emas');
  const months = monthsBetween(q.from, q.to);
  if (months.length > 36) throw badRequest('Davr 36 oydan oshmasin');
  const raw = (await pool.query(ROWS, [q.from, q.to, EXCLUDED_ITEMS])).rows as { biz: Biz; key: string; label: string | null; m: string; amt: string }[];

  // biznes → satr → oy → tiyin
  const data = new Map<string, Map<string, number>>();
  const expLabels = new Map<string, string>();
  for (const r of raw) {
    const k = `${r.biz}|${r.key}`;
    if (!data.has(k)) data.set(k, new Map());
    data.get(k)!.set(r.m, (data.get(k)!.get(r.m) ?? 0) + cents(r.amt));
    if (r.label) expLabels.set(r.key, r.label);
  }
  const line = (biz: Biz, key: string, kind: Kind = 'line', label = LABELS[key] ?? expLabels.get(key) ?? key, always = true): Line | null => {
    const vals = data.get(`${biz}|${key}`);
    if (!vals && !always) return null;
    return mk(key, label, kind, months.map((m) => vals?.get(m) ?? 0));
  };
  const mk = (key: string, label: string, kind: Kind, per: number[]): Line => ({
    key,
    label,
    kind,
    values: Object.fromEntries(months.map((m, i) => [m, fromCents(per[i])])),
    total: fromCents(per.reduce((a, b) => a + b, 0)),
  });
  const add = (key: string, label: string, kind: Kind, parts: (Line | null)[]) =>
    mk(key, label, kind, months.map((m) => parts.reduce((s, p) => s + (p ? cents(p.values[m]) : 0), 0)));
  /** Kassa xarajat guruhlari (kod bo'yicha) */
  const expenses = (biz: Biz) =>
    [...data.keys()]
      .filter((k) => k.startsWith(`${biz}|exp:`))
      .map((k) => k.split('|')[1])
      .sort((a, b) => Number(a.slice(4) || 0) - Number(b.slice(4) || 0) || a.localeCompare(b))
      .map((key) => line(biz, key, 'line', `${key.slice(4) !== '0' ? `${key.slice(4)} ` : ''}${expLabels.get(key) ?? ''}`)!);

  const net = (biz: Biz, gross: Line | null, rest: (Line | null)[]) => {
    const exp = expenses(biz);
    const opex = add('opex', 'Davr xarajatlari (kassa)', 'sub', exp);
    const other = line(biz, 'other_income', 'line', undefined, false);
    const lines = [...rest, ...exp, opex, other].filter((x): x is Line => !!x);
    return { lines, result: add('net', 'Sof foyda', 'total', [gross, ...rest, opex, other]) };
  };

  // Ishlab chiqarish
  const pRev = line('ishlab', 'revenue')!;
  const pCogs = line('ishlab', 'cogs')!;
  const pGross = add('gross', 'Yalpi foyda', 'sub', [pRev, pCogs]);
  const pNet = net('ishlab', pGross, [line('ishlab', 'scrap'), line('ishlab', 'wages')]);

  // Sotuv bo'limi
  const sWh = line('sotuv', 'wholesale')!;
  const sShop = line('sotuv', 'shop')!;
  const sRev = add('revenue', 'Jami sotuv', 'sub', [sWh, sShop]);
  const sCw = line('sotuv', 'cogs_wholesale')!;
  const sCs = line('sotuv', 'cogs_shop')!;
  const sGross = add('gross', 'Yalpi foyda', 'sub', [sRev, sCw, sCs]);
  const sNet = net('sotuv', sGross, [line('sotuv', 'adjust'), line('sotuv', 'commission'), line('sotuv', 'wages', 'line', undefined, false)]);

  // Umumiy
  const uNet = net('umumiy', null, [line('umumiy', 'wages')]);

  const sections = [
    { biz: 'ishlab', title: TITLES.ishlab, lines: [pRev, pCogs, pGross, ...pNet.lines, pNet.result] },
    { biz: 'sotuv', title: TITLES.sotuv, lines: [sWh, sShop, sRev, sCw, sCs, sGross, ...sNet.lines, sNet.result] },
    { biz: 'umumiy', title: TITLES.umumiy, lines: [...uNet.lines, uNet.result] },
  ];
  const company = [
    { ...pNet.result, key: 'ishlab', label: `${TITLES.ishlab} foydasi`, kind: 'line' as Kind },
    { ...sNet.result, key: 'sotuv', label: `${TITLES.sotuv} foydasi`, kind: 'line' as Kind },
    { ...uNet.result, key: 'umumiy', label: 'Umumiy xarajatlar', kind: 'line' as Kind },
    add('net', 'Kompaniya sof foydasi', 'total', [pNet.result, sNet.result, uNet.result]),
  ];
  res.json({ from: q.from, to: q.to, months, sections, company, excluded_items: EXCLUDED_ITEMS });
});
