import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ErrorText, PageHead, fmtDateTime, fmtNum } from '../components/ui';
import type { BillzSettings } from '../types';
import { money } from './purchaseUi';
import { today } from './stockUi';

type Cls = 'A' | 'B' | 'C';
type Metric = 'margin' | 'qty' | 'sales';
interface AbcItem {
  product_id: string;
  product_name: string;
  sku: string | null;
  barcode: string | null;
  qty: number;
  sales: number;
  margin: number;
  supply: number;
  margin_pct: number | null;
  margin_cls: Cls;
  margin_share: number;
  qty_cls: Cls;
  qty_share: number;
  sales_cls: Cls;
  sales_share: number;
  abc: string;
}
interface AbcSummaryRow {
  cls: Cls;
  items: number;
  items_pct: number;
  sum: number;
  sum_pct: number;
}
interface Abc {
  items: AbcItem[];
  summary: Record<Metric, AbcSummaryRow[]>;
  combos: { abc: string; items: number }[];
  totals: { qty: number; sales: number; margin: number };
  thresholds: { a: number; b: number };
  synced_at: string | null;
}

const METRIC: [Metric, string][] = [
  ['margin', 'Marja (sof foyda)'],
  ['qty', 'Sotuv soni'],
  ['sales', 'Sotuv summasi'],
];
const TONE: Record<Cls, string> = { A: 'good', B: 'warn', C: 'bad' };
const pct = (v: number | null) => (v == null ? '—' : `${(Math.round(v * 10) / 10).toFixed(1).replace('.', ',')}%`);
const fmtMetric = (m: Metric, v: number) => (m === 'qty' ? fmtNum(v) : money(v));
const Pill = ({ c }: { c: Cls }) => <span className={`pill ${TONE[c]}`}>{c}</span>;
const monthStart = () => `${today().slice(0, 8)}01`;

/** CSV (Excel ochadi): ; ajratgich, UTF-8 BOM */
function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v == null ? '' : typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : v;
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function AbcPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [shop, setShop] = useState('');
  const [a, setA] = useState('80');
  const [b, setB] = useState('95');
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<Metric>('sales');
  const [q, setQ] = useState('');
  const [th, setTh] = useState({ a: '80', b: '95' });
  useEffect(() => {
    const t = setTimeout(() => setTh({ a, b }), 400);
    return () => clearTimeout(t);
  }, [a, b]);
  const shops = useQuery({ queryKey: ['billz', 'settings'], queryFn: () => api<BillzSettings>('/billz/settings') });
  const qs = new URLSearchParams({ from, to, a: th.a, b: th.b, ...(shop && { shop_id: shop }) }).toString();
  const r = useQuery({ queryKey: ['reports', 'abc', qs], queryFn: () => api<Abc>(`/reports/abc?${qs}`), enabled: !!from && !!to });
  const d = r.data;
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (d?.items ?? [])
      .filter((i) => !filter || (filter.length === 3 ? i.abc === filter : i[`${filter.slice(2) as Metric}_cls`] === filter[0]))
      .filter((i) => !s || i.product_name.toLowerCase().includes(s) || (i.sku ?? '').toLowerCase().includes(s) || (i.barcode ?? '').includes(s))
      .sort((x, y) => y[sortBy] - x[sortBy]);
  }, [d, filter, q, sortBy]);

  const exportCsv = () =>
    downloadCsv(`ABC_${from}_${to}.csv`, [
      ['Tovar', 'SKU', 'Barcode', 'Sotuv soni', 'Soni ulushi %', 'Soni sinfi', 'Sotuv summasi', 'Summa ulushi %', 'Summa sinfi', 'Marja', 'Marja %', 'Marja ulushi %', 'Marja sinfi', 'ABC (marja·soni·summa)'],
      ...rows.map((i) => [
        i.product_name, i.sku, i.barcode, i.qty, i.qty_share, i.qty_cls, i.sales, i.sales_share, i.sales_cls, i.margin, i.margin_pct, i.margin_share, i.margin_cls, i.abc,
      ]),
    ]);

  return (
    <>
      <PageHead title="ABC tahlil" sub="Tovarlar marja, sotuv soni va sotuv summasi bo'yicha (Billz sotuvlari)">
        {!!rows.length && (
          <button className="btn ghost" onClick={exportCsv}>
            Excel'ga yuklab olish
          </button>
        )}
      </PageHead>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form">
          <label className="f">
            Sanadan
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="f">
            Sanagacha
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="f">
            Do'kon
            <select value={shop} onChange={(e) => setShop(e.target.value)}>
              <option value="">Hammasi</option>
              {shops.data?.shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            A chegarasi, %
            <input inputMode="numeric" value={a} onChange={(e) => setA(e.target.value)} />
          </label>
          <label className="f">
            B chegarasi, %
            <input inputMode="numeric" value={b} onChange={(e) => setB(e.target.value)} />
          </label>
        </div>
        <p className="note" style={{ marginTop: 8 }}>
          Tovarlar ko'rsatkich bo'yicha kamayish tartibida saralanadi: yig'ma ulushi {th.a}% gacha — <b>A</b>, {th.b}% gacha — <b>B</b>, qolgani — <b>C</b>. Zarar bilan sotilgan
          yoki nol — C. Ma'lumot Billz'dan{d?.synced_at ? ` (oxirgi yangilanish ${fmtDateTime(d.synced_at)})` : ''}.
        </p>
        <ErrorText error={r.error} />
      </div>

      {d && (
        <>
          <div className="cards" style={{ marginBottom: 14 }}>
            {METRIC.map(([m, label]) => (
              <div key={m} className="card">
                <h2>{label}</h2>
                <p className="note" style={{ marginBottom: 6 }}>
                  Jami: <b>{fmtMetric(m, d.totals[m])}</b>
                  {m === 'margin' && d.totals.sales ? ` · ${pct((d.totals.margin / d.totals.sales) * 100)}` : ''}
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Sinf</th>
                      <th className="n">Tovar</th>
                      <th className="n">Ulushi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.summary[m].map((s) => (
                      <tr key={s.cls} className="click" tabIndex={0} onClick={() => setFilter(`${s.cls}:${m}`)} onKeyDown={(e) => e.key === 'Enter' && setFilter(`${s.cls}:${m}`)}>
                        <td>
                          <Pill c={s.cls} />
                        </td>
                        <td className="n">
                          {s.items} <span className="note">({pct(s.items_pct)})</span>
                        </td>
                        <td className="n">
                          <b>{pct(s.sum_pct)}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="form" style={{ marginBottom: 12 }}>
              <label className="f">
                Sinf bo'yicha
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="">Hammasi ({d.items.length})</option>
                  {METRIC.map(([m, label]) =>
                    (['A', 'B', 'C'] as const).map((c) => (
                      <option key={`${c}:${m}`} value={`${c}:${m}`}>
                        {label}: {c}
                      </option>
                    )),
                  )}
                  {d.combos.map((c) => (
                    <option key={c.abc} value={c.abc}>
                      Kombinatsiya {c.abc} ({c.items})
                    </option>
                  ))}
                </select>
              </label>
              <label className="f">
                Saralash
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as Metric)}>
                  {METRIC.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="f">
                Qidirish
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="nomi, SKU, barcode" />
              </label>
            </div>
            {!rows.length ? (
              <p className="note">{d.items.length ? 'Filtr bo\'yicha tovar yo\'q.' : 'Bu oraliqda Billz sotuvlari yo\'q. Billz ulanganini va yangilanganini tekshiring.'}</p>
            ) : (
              <div className="sheet-wrap">
                <table className="sheet" style={{ minWidth: 1450 }}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Tovar</th>
                      <th>SKU · barcode</th>
                      <th className="n">Sotuv soni</th>
                      <th className="n">Ulushi</th>
                      <th>Sinf</th>
                      <th className="n">Sotuv summasi</th>
                      <th className="n">Ulushi</th>
                      <th>Sinf</th>
                      <th className="n">Marja</th>
                      <th className="n">Marja %</th>
                      <th className="n">Ulushi</th>
                      <th>Sinf</th>
                      <th>ABC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((i, k) => (
                      <tr key={i.product_id}>
                        <td className="mono">{k + 1}</td>
                        <td>
                          <b>{i.product_name}</b>
                        </td>
                        <td className="mono note">{[i.sku, i.barcode].filter(Boolean).join(' · ')}</td>
                        <td className="n">{fmtNum(i.qty)}</td>
                        <td className="n">{pct(i.qty_share)}</td>
                        <td>
                          <Pill c={i.qty_cls} />
                        </td>
                        <td className="n">{money(i.sales)}</td>
                        <td className="n">{pct(i.sales_share)}</td>
                        <td>
                          <Pill c={i.sales_cls} />
                        </td>
                        <td className={`n ${i.margin < 0 ? 'err' : ''}`}>{money(i.margin)}</td>
                        <td className="n">{pct(i.margin_pct)}</td>
                        <td className="n">{pct(i.margin_share)}</td>
                        <td>
                          <Pill c={i.margin_cls} />
                        </td>
                        <td className="mono">
                          <b>{i.abc}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!!rows.length && (
              <p className="note" style={{ marginTop: 8 }}>
                ABC ustuni: marja · sotuv soni · sotuv summasi. Masalan, <b>AAA</b> — asosiy tovar, <b>CCC</b> — assortimentdan chiqarishni ko'rib chiqish kerak, <b>CAA</b> — ko'p
                va katta summaga sotiladi, lekin marjasi past (narxni ko'rib chiqing).
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}
