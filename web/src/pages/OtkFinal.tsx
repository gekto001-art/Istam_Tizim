import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtDate, fmtNum, useToast } from '../components/ui';
import { can, type FgStock, type OtkOutput, type Writeoff } from '../types';
import { money, num } from './purchaseUi';
import { SubmitBar, today, useStockInvalidate } from './stockUi';

type Sort = { sort1: string; sort2: string; scrap: string };
const n = (s: string) => (s.trim() === '' ? 0 : num(s));
const okInt = (v: number) => Number.isInteger(v) && v >= 0;

// ---------- OTK (tayyor mahsulot) ----------
export function OtkFinalPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useStockInvalidate();
  const [partiya, setPartiya] = useState('');
  const [otkDate, setOtkDate] = useState(today());
  const [vals, setVals] = useState<Record<number, Sort>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['stock', 'otk', 'pending'], queryFn: () => api<OtkOutput[]>('/otk/outputs?status=pending') });
  const done = useQuery({ queryKey: ['stock', 'otk', 'done'], queryFn: () => api<OtkOutput[]>('/otk/outputs?status=done&limit=300') });
  useEffect(() => setVals({}), [q.data]);
  const save = useMutation({
    mutationFn: (body: object) => api<{ saved: number; scrap_cost_uzs: string }>('/otk/outputs', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      toast(`${r.saved} ta yozuv tekshirildi${Number(r.scrap_cost_uzs) ? ` · spisaniya ${money(r.scrap_cost_uzs)} so'm` : ''}`);
    },
  });
  if (!me) return null;
  const write = can.otkWrite(me.role);
  const rows = (q.data ?? []).filter((o) => !partiya || o.partiya_no === partiya);
  const v = (o: OtkOutput) => vals[o.id] ?? { sort1: '', sort2: '', scrap: '' };
  const set = (o: OtkOutput, patch: Partial<Sort>) => setVals((x) => ({ ...x, [o.id]: { ...v(o), ...patch } }));
  const touched = (o: OtkOutput) => v(o).sort1 !== '' || v(o).sort2 !== '' || v(o).scrap !== '';
  const left = (o: OtkOutput) => o.fact_qty - n(v(o).sort1) - n(v(o).sort2) - n(v(o).scrap);
  const bad = (o: OtkOutput) => touched(o) && (![v(o).sort1, v(o).sort2, v(o).scrap].every((s) => okInt(n(s))) || left(o) !== 0);

  const submit = () => {
    setMsg(null);
    if (!otkDate) return setMsg('Sanani kiriting');
    const t = rows.filter(touched);
    if (!t.length) return setMsg('1 sort, 2 sort va yaroqsiz sonini kiriting');
    const b = t.find(bad);
    if (b) return setMsg(`ID ${b.id}: 1 sort + 2 sort + yaroqsiz tikilgan miqdorga (${b.fact_qty}) teng bo'lishi kerak`);
    save.mutate({ otk_date: otkDate, rows: t.map((o) => ({ output_id: o.id, sort1: n(v(o).sort1), sort2: n(v(o).sort2), scrap: n(v(o).scrap) })) });
  };

  return (
    <>
      <PageHead title="OTK (tayyor mahsulot)" sub="Tsex tikkan mahsulot: 1 sort va 2 sort — tayyor mahsulot skladiga, yaroqsiz — spisaniya (P&L xarajat)" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <label className="f">
            Partiya
            <select value={partiya} onChange={(e) => setPartiya(e.target.value)}>
              <option value="">Hammasi</option>
              {[...new Set((q.data ?? []).map((o) => o.partiya_no))].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="f">
            OTK sana
            <input type="date" value={otkDate} disabled={!write} onChange={(e) => setOtkDate(e.target.value)} />
          </label>
          {write && rows.length > 0 && (
            <div className="f">
              &nbsp;
              <button className="btn ghost sm" onClick={() => setVals(Object.fromEntries(rows.map((o) => [o.id, { sort1: String(o.fact_qty), sort2: '0', scrap: '0' }])))}>
                Hammasi 1 sort
              </button>
            </div>
          )}
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">Tekshiriladigan mahsulot yo'q. Tsex «Ishlab chiqarish»da fakt kiritgach shu yerda chiqadi.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1250 }}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Sana</th>
                  <th>Tsex</th>
                  <th>Partiya raqam</th>
                  <th>Tovar nomi</th>
                  <th>Artikul</th>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">Tikilgan miqdor</th>
                  <th className="n">1 sort</th>
                  <th className="n">2 sort</th>
                  <th className="n">Yaroqsiz</th>
                  <th className="n">Ostatka</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className={bad(o) ? 'bad-row' : touched(o) ? 'sel-row' : ''}>
                    <td className="mono">{o.id}</td>
                    <td className="mono">{fmtDate(o.out_date)}</td>
                    <td>{o.producer_name}</td>
                    <td className="mono">{o.partiya_no}</td>
                    <td>{o.product_type_name}</td>
                    <td>{o.artikul ?? ''}</td>
                    <td className="mono">{o.size_name}</td>
                    <td>{o.color_name}</td>
                    <td className="n">
                      <b>{fmtNum(o.fact_qty)}</b>
                    </td>
                    {(['sort1', 'sort2', 'scrap'] as const).map((k) => (
                      <td key={k} className="n">
                        <input className="cell num" inputMode="numeric" value={v(o)[k]} disabled={!write} onChange={(e) => set(o, { [k]: e.target.value })} aria-label={`${k} ID ${o.id}`} />
                      </td>
                    ))}
                    <td className="n">{touched(o) ? <b className={left(o) ? 'err' : ''}>{Number.isFinite(left(o)) ? left(o) : '—'}</b> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {write && rows.length > 0 && (
          <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
            Ostatka 0 bo'lgan qatorlar saqlanadi. Yaroqsiz tannarxda spisat qilinadi: kroydagi mato + furnitura + ish narxi.
          </SubmitBar>
        )}
      </div>

      <div className="card">
        <h2>Tekshirilganlar</h2>
        {!done.data?.length ? (
          <p className="note">Hali yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1200 }}>
              <thead>
                <tr>
                  <th>OTK sana</th>
                  <th>ID</th>
                  <th>Tsex</th>
                  <th>Partiya</th>
                  <th>Tovar</th>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">Tikilgan</th>
                  <th className="n">1 sort</th>
                  <th className="n">2 sort</th>
                  <th className="n">Yaroqsiz</th>
                  <th className="n">Tannarx (1 dona)</th>
                  <th className="n">Spisaniya, so'm</th>
                  <th>Tekshirdi</th>
                </tr>
              </thead>
              <tbody>
                {done.data.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{fmtDate(o.otk_date)}</td>
                    <td className="mono">{o.id}</td>
                    <td>{o.producer_name}</td>
                    <td className="mono">{o.partiya_no}</td>
                    <td>{o.product_type_name}</td>
                    <td className="mono">{o.size_name}</td>
                    <td>{o.color_name}</td>
                    <td className="n">{fmtNum(o.fact_qty)}</td>
                    <td className="n">{fmtNum(o.otk_sort1)}</td>
                    <td className="n">{o.otk_sort2 ? fmtNum(o.otk_sort2) : 0}</td>
                    <td className="n">{o.otk_scrap ? <span className="pill bad">{o.otk_scrap}</span> : 0}</td>
                    <td className="n">{money(o.unit_cost_uzs)}</td>
                    <td className="n">{Number(o.scrap_cost_uzs) ? money(o.scrap_cost_uzs) : ''}</td>
                    <td>{o.otk_by_name ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------- Tayyor mahsulot skladi ----------
export function TayyorPage() {
  const [partiya, setPartiya] = useState('');
  const q = useQuery({ queryKey: ['stock', 'fg'], queryFn: () => api<FgStock[]>('/otk/stock') });
  const rows = (q.data ?? []).filter((r) => !partiya || r.partiya_no === partiya);
  const sum = (f: (r: FgStock) => number) => rows.reduce((a, r) => a + f(r), 0);
  return (
    <>
      <PageHead title="Tayyor mahsulot skladi" sub="OTKdan o'tgan mahsulot qoldig'i: 1 sort va 2 sort, o'rtacha tannarx" />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <label className="f">
            Partiya
            <select value={partiya} onChange={(e) => setPartiya(e.target.value)}>
              <option value="">Hammasi</option>
              {[...new Set((q.data ?? []).map((r) => r.partiya_no))].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">Skladda tayyor mahsulot yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1000 }}>
              <thead>
                <tr>
                  <th>Partiya</th>
                  <th>Tovar</th>
                  <th>Artikul · model</th>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">1 sort</th>
                  <th className="n">2 sort</th>
                  <th className="n">Jami</th>
                  <th className="n">Tannarx (1 dona)</th>
                  <th className="n">Summa, so'm</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.order_id}:${r.color_id}:${r.size_id}`}>
                    <td className="mono">{r.partiya_no}</td>
                    <td>{r.product_type_name}</td>
                    <td>{[r.artikul, r.model].filter(Boolean).join(' · ')}</td>
                    <td className="mono">{r.size_name}</td>
                    <td>{r.color_name}</td>
                    <td className="n">{fmtNum(r.sort1)}</td>
                    <td className="n">{r.sort2 ? fmtNum(r.sort2) : ''}</td>
                    <td className="n">
                      <b>{fmtNum(r.total)}</b>
                    </td>
                    <td className="n">{r.avg_cost == null ? '—' : money(r.avg_cost)}</td>
                    <td className="n">{r.avg_cost == null ? '—' : money(r.total * Number(r.avg_cost))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!!rows.length && (
          <p className="note" style={{ marginTop: 8 }}>
            Jami: 1 sort <b>{fmtNum(sum((r) => r.sort1))}</b> · 2 sort <b>{fmtNum(sum((r) => r.sort2))}</b> · summa{' '}
            <b>{money(sum((r) => r.total * Number(r.avg_cost ?? 0)))} so'm</b>
          </p>
        )}
      </div>
    </>
  );
}

// ---------- Spisaniya (P&L) ----------
const SOURCE: Record<Writeoff['source'], string> = { kroy: 'Bichuv (OTK Brak)', otk: 'OTK (tayyor mahsulot)' };

export function SpisaniyaPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
  const q = useQuery({ queryKey: ['stock', 'writeoffs', qs], queryFn: () => api<Writeoff[]>(`/otk/writeoffs${qs ? `?${qs}` : ''}`) });
  const rows = q.data ?? [];
  const total = (s?: Writeoff['source']) => rows.filter((r) => !s || r.source === s).reduce((a, r) => a + Number(r.amount_uzs), 0);
  return (
    <>
      <PageHead title="Spisaniya (yaroqsiz)" sub="Yaroqsiz mahsulot tannarxda hisobdan chiqariladi — P&L xarajat" />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <label className="f">
            Sanadan
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="f">
            Sanagacha
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <div className="f">
            Jami P&L xarajat
            <b>{money(total())} so'm</b>
          </div>
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">Yaroqsiz yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1000 }}>
              <thead>
                <tr>
                  <th>Sana</th>
                  <th>Qayerda</th>
                  <th>ID</th>
                  <th>Partiya</th>
                  <th>Tovar</th>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">Soni</th>
                  <th className="n">Tannarx (1 dona)</th>
                  <th className="n">Summa, so'm</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.source}:${r.ref_id}`}>
                    <td className="mono">{fmtDate(r.date)}</td>
                    <td>{SOURCE[r.source]}</td>
                    <td className="mono">{r.ref_id}</td>
                    <td className="mono">{r.partiya_no}</td>
                    <td>{r.product_type_name}</td>
                    <td className="mono">{r.size_name}</td>
                    <td>{r.color_name}</td>
                    <td className="n">{fmtNum(r.qty)}</td>
                    <td className="n">{r.unit_cost_uzs == null ? '—' : money(r.unit_cost_uzs)}</td>
                    <td className="n">
                      <b>{money(r.amount_uzs)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!!rows.length && (
          <p className="note" style={{ marginTop: 8 }}>
            Bichuvda: {money(total('kroy'))} so'm (faqat mato) · OTKda: {money(total('otk'))} so'm (mato + furnitura + ish narxi)
          </p>
        )}
      </div>
    </>
  );
}
