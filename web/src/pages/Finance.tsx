import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { ErrorText, PageHead } from '../components/ui';
import type { Pnl, PnlLine } from '../types';
import { money } from './purchaseUi';
import { downloadCsv } from './Reports';
import { today } from './stockUi';

const MONTHS = ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyun', 'Iyul', 'Avg', 'Sen', 'Okt', 'Noy', 'Dek'];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

function PnlTable({ lines, months, byMonth }: { lines: PnlLine[]; months: string[]; byMonth: boolean }) {
  const cell = (v: string, key: string) => (
    <td key={key} className={`n${Number(v) < 0 ? ' neg' : ''}`}>
      {Number(v) === 0 ? '—' : money(v)}
    </td>
  );
  return (
    <div className="tw">
      <table className="pnl">
        <thead>
          <tr>
            <th>Ko'rsatkich</th>
            {byMonth && months.map((m) => <th key={m} className="n">{monthLabel(m)}</th>)}
            <th className="n">Jami</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key} className={l.kind === 'line' ? undefined : l.kind}>
              <td className={l.kind === 'line' ? 'indent' : undefined}>{l.label}</td>
              {byMonth && months.map((m) => cell(l.values[m], m))}
              {cell(l.total, 'total')}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** P&L (foyda va zarar) — har biznes alohida: ishlab chiqarish, Sotuv bo'limi, umumiy; kompaniya jami */
export function PnlPage() {
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const [byMonth, setByMonth] = useState(true);
  const qs = new URLSearchParams({ from, to }).toString();
  const r = useQuery({ queryKey: ['finance', 'pnl', qs], queryFn: () => api<Pnl>(`/finance/pnl?${qs}`), enabled: !!from && !!to && from <= to });
  const d = r.data;

  const exportCsv = () => {
    if (!d) return;
    const head = ['Ko\'rsatkich', ...d.months.map(monthLabel), 'Jami'];
    const rows = (title: string, lines: PnlLine[]) => [[title], ...lines.map((l) => [l.label, ...d.months.map((m) => Number(l.values[m])), Number(l.total)])];
    downloadCsv(`PnL_${from}_${to}.csv`, [head, ...rows('Kompaniya', d.company), ...d.sections.flatMap((s) => [[], ...rows(s.title, s.lines)])]);
  };

  return (
    <>
      <PageHead title="P&L (foyda va zarar)" sub="Har biznes alohida: ishlab chiqarish, Sotuv bo'limi va umumiy xarajatlar">
        {d && (
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
          <label className="row" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={byMonth} onChange={(e) => setByMonth(e.target.checked)} /> Oylar bo'yicha
          </label>
        </div>
        <details style={{ marginTop: 8 }}>
          <summary className="note">Qanday hisoblanadi</summary>
          <ul className="note" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>
              <b>Ishlab chiqarish</b>: daromad — Sotuv bo'limi qabul qilgan o'tkazmalar (ichki narxda, qabul sanasi bo'yicha); material tannarxi — tayyor mahsulot tannarxidan
              zakazdagi ish narxlari ayrilgan qismi (ish haqi HR nachisleniyasidan alohida olinadi); spisaniya — yaroqsizning material qismi.
            </li>
            <li>
              <b>Sotuv bo'limi</b>: ulgurji — nakladnoylar (sotuv − vozvrat), do'konlar — Billz sotuvi va Billz'dagi tannarx; inventarizatsiya farqi; agent komissiyasi —
              agent foizi bo'yicha hisoblangan.
            </li>
            <li>
              <b>Ish haqi</b> — HR nachisleniyasi (oylik + ishbay + bonus − ushlab qolish); qaysi biznesga tushishi HR → Bo'limlar sahifasida belgilanadi.
            </li>
            <li>
              <b>Davr xarajatlari</b> — kassadan, «P&L ga kiradi» belgili tranzaksiya turlari (Kassa → Hamyonlar va xarajat elementlari); biznes — hamyon bo'limi bo'yicha
              (ishlab chiqarish / tijorat / moliya). Ikki marta hisoblanmasligi uchun kassadan olinmaydi: elementlar {d?.excluded_items.length ? '3001, 3010 (ish haqi, bonus — HR\'dan), 3009 (komissiya), 4001–4015 (xomashyo — tannarxda)' : ''}.
            </li>
          </ul>
        </details>
        {from > to && <p className="err">Sanagacha sanadan oldin bo'lishi mumkin emas</p>}
        <ErrorText error={r.error} />
      </div>
      {r.isLoading && <p className="note">Yuklanmoqda…</p>}
      {d && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <h2>Kompaniya</h2>
            <PnlTable lines={d.company} months={d.months} byMonth={byMonth} />
          </div>
          {d.sections.map((s) => (
            <div key={s.biz} className="card" style={{ marginBottom: 14 }}>
              <h2>{s.title}</h2>
              <PnlTable lines={s.lines} months={d.months} byMonth={byMonth} />
            </div>
          ))}
        </>
      )}
    </>
  );
}
