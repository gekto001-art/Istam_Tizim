import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import { can, type KroyClosed, type KroyIssue, type KroyItem, type KroyOrderHead, type Producer, type SemiRow } from '../types';
import { useKroyInvalidate } from './Kroy';
import { useCatalog } from './Orders';
import { money, num } from './purchaseUi';
import { SubmitBar, today } from './stockUi';

const intOf = (s: string | undefined) => (s == null || s.trim() === '' ? NaN : num(s));
const okInt = (v: number) => Number.isInteger(v) && v >= 0;

/** Partiya bo'yicha filtr */
function PartiyaFilter({ list, value, onChange, label = 'Partiya' }: { list: string[]; value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <label className="f">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Hammasi</option>
        {[...new Set(list)].map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
    </label>
  );
}

// ---------- Sifat nazorati (OTK Bichuv) ----------
export function OtkPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useKroyInvalidate();
  const [partiya, setPartiya] = useState('');
  const [otkDate, setOtkDate] = useState(today());
  const [vals, setVals] = useState<Record<number, { first: string; brak: string }>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['stock', 'kroy', 'otk', 'pending'], queryFn: () => api<KroyItem[]>('/kroy/items?otk=pending') });
  const done = useQuery({ queryKey: ['stock', 'kroy', 'otk', 'done'], queryFn: () => api<KroyItem[]>('/kroy/items?otk=done&limit=200') });
  useEffect(() => setVals({}), [q.data]);
  const save = useMutation({
    mutationFn: (body: object) => api<{ saved: number }>('/kroy/otk', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      toast(`${r.saved} ta yozuv tekshirildi`);
    },
  });
  if (!me) return null;
  const write = can.otkWrite(me.role);
  const rows = (q.data ?? []).filter((i) => !partiya || i.partiya_no === partiya);
  const v = (i: KroyItem) => vals[i.id] ?? { first: '', brak: '' };
  const set = (i: KroyItem, patch: Partial<{ first: string; brak: string }>) => setVals((x) => ({ ...x, [i.id]: { ...v(i), ...patch } }));
  const touched = (i: KroyItem) => v(i).first !== '' || v(i).brak !== '';
  const first = (i: KroyItem) => (v(i).first === '' ? 0 : intOf(v(i).first));
  const brak = (i: KroyItem) => (v(i).brak === '' ? 0 : intOf(v(i).brak));
  const left = (i: KroyItem) => i.fact_qty - first(i) - brak(i);
  const bad = (i: KroyItem) => touched(i) && (!okInt(first(i)) || !okInt(brak(i)) || left(i) !== 0);

  const submit = () => {
    setMsg(null);
    if (!otkDate) return setMsg('Sanani kiriting');
    const t = rows.filter(touched);
    if (!t.length) return setMsg('1 sort va brak sonini kiriting');
    const b = t.find(bad);
    if (b) return setMsg(`ID ${b.id}: 1 sort + brak kroy qilingan miqdorga (${b.fact_qty}) teng bo'lishi kerak`);
    save.mutate({ otk_date: otkDate, rows: t.map((i) => ({ item_id: i.id, first: first(i), brak: brak(i) })) });
  };

  return (
    <>
      <PageHead title="Sifat nazorati (bichuv)" sub="Kesilgan yarim tayyorni tekshirish: 1 sort va brak (Sheets «OTK Bichuv»). Brak kroyga qaytadi." />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <PartiyaFilter list={(q.data ?? []).map((i) => i.partiya_no)} value={partiya} onChange={setPartiya} label="Partiya" />
          <label className="f">
            OTK sana
            <input type="date" value={otkDate} disabled={!write} onChange={(e) => setOtkDate(e.target.value)} />
          </label>
          {write && rows.length > 0 && (
            <div className="f">
              &nbsp;
              <button className="btn ghost sm" onClick={() => setVals(Object.fromEntries(rows.map((i) => [i.id, { first: String(i.fact_qty), brak: '0' }])))}>
                Hammasi 1 sort
              </button>
            </div>
          )}
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">Tekshiriladigan kroy yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1100 }}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Sana</th>
                  <th>Partiya raqam</th>
                  <th>Tovar nomi</th>
                  <th>Artikul</th>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">Kroy qilingan miqdor</th>
                  <th className="n">1 sort</th>
                  <th className="n">Brak</th>
                  <th className="n">Ostatka</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id} className={bad(i) ? 'bad-row' : touched(i) ? 'sel-row' : ''}>
                    <td className="mono">{i.id}</td>
                    <td className="mono">{fmtDate(i.cut_date)}</td>
                    <td className="mono">{i.partiya_no}</td>
                    <td>{i.product_type_name}</td>
                    <td>{i.artikul ?? ''}</td>
                    <td className="mono">{i.size_name}</td>
                    <td>{i.color_name}</td>
                    <td className="n">
                      <b>{fmtNum(i.fact_qty)}</b>
                    </td>
                    <td className="n">
                      <input className="cell num" inputMode="numeric" value={v(i).first} disabled={!write} onChange={(e) => set(i, { first: e.target.value })} aria-label={`1 sort ID ${i.id}`} />
                    </td>
                    <td className="n">
                      <input className="cell num" inputMode="numeric" value={v(i).brak} disabled={!write} onChange={(e) => set(i, { brak: e.target.value })} aria-label={`Brak ID ${i.id}`} />
                    </td>
                    <td className="n">{touched(i) ? <b className={left(i) ? 'err' : ''}>{Number.isFinite(left(i)) ? left(i) : '—'}</b> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {write && rows.length > 0 && <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>Ostatka 0 bo'lgan qatorlar saqlanadi.</SubmitBar>}
      </div>

      <div className="card">
        <h2>Tekshirilganlar</h2>
        {!done.data?.length ? (
          <p className="note">Hali yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1000 }}>
              <thead>
                <tr>
                  <th>OTK sana</th>
                  <th>ID</th>
                  <th>Partiya</th>
                  <th>Tovar</th>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">Kroy</th>
                  <th className="n">1 sort</th>
                  <th className="n">Brak</th>
                  <th>Tekshirdi</th>
                </tr>
              </thead>
              <tbody>
                {done.data.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{fmtDate(i.otk_date)}</td>
                    <td className="mono">{i.id}</td>
                    <td className="mono">{i.partiya_no}</td>
                    <td>{i.product_type_name}</td>
                    <td className="mono">{i.size_name}</td>
                    <td>{i.color_name}</td>
                    <td className="n">{fmtNum(i.fact_qty)}</td>
                    <td className="n">{fmtNum(i.otk_first)}</td>
                    <td className="n">{i.otk_brak ? <span className="pill bad">{i.otk_brak}</span> : 0}</td>
                    <td>{i.otk_by_name ?? ''}</td>
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

// ---------- OTK Brak → kroyda saralash ----------
type Sort = { sort1: string; sort2: string; scrap: string };

export function BrakPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useKroyInvalidate();
  const [sortDate, setSortDate] = useState(today());
  const [vals, setVals] = useState<Record<number, Sort>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['stock', 'kroy', 'brak'], queryFn: () => api<KroyItem[]>('/kroy/items?otk=brak') });
  const done = useQuery({ queryKey: ['stock', 'kroy', 'brak_done'], queryFn: () => api<KroyItem[]>('/kroy/items?otk=brak_done&limit=500') });
  useEffect(() => setVals({}), [q.data]);
  const save = useMutation({
    mutationFn: (body: object) => api<{ saved: number }>('/kroy/brak', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      toast(`${r.saved} ta brak saralandi`);
    },
  });
  if (!me) return null;
  const write = can.kroyWrite(me.role);
  const rows = q.data ?? [];
  const v = (i: KroyItem) => vals[i.id] ?? { sort1: '', sort2: '', scrap: '' };
  const set = (i: KroyItem, patch: Partial<Sort>) => setVals((x) => ({ ...x, [i.id]: { ...v(i), ...patch } }));
  const n = (s: string) => (s === '' ? 0 : intOf(s));
  const touched = (i: KroyItem) => v(i).sort1 !== '' || v(i).sort2 !== '' || v(i).scrap !== '';
  const left = (i: KroyItem) => (i.otk_brak ?? 0) - n(v(i).sort1) - n(v(i).sort2) - n(v(i).scrap);
  const bad = (i: KroyItem) => touched(i) && (![v(i).sort1, v(i).sort2, v(i).scrap].every((s) => okInt(n(s))) || left(i) !== 0);
  const scrapSum = (done.data ?? []).reduce((a, i) => a + Number(i.scrap_cost_uzs ?? 0), 0);

  const submit = () => {
    setMsg(null);
    if (!sortDate) return setMsg('Sanani kiriting');
    const t = rows.filter(touched);
    if (!t.length) return setMsg('1 sort, 2 sort va yaroqsiz sonini kiriting');
    const b = t.find(bad);
    if (b) return setMsg(`ID ${b.id}: 1 sort + 2 sort + yaroqsiz brak soniga (${b.otk_brak}) teng bo'lishi kerak`);
    save.mutate({ sort_date: sortDate, rows: t.map((i) => ({ item_id: i.id, sort1: n(v(i).sort1), sort2: n(v(i).sort2), scrap: n(v(i).scrap) })) });
  };

  return (
    <>
      <PageHead title="OTK Brak" sub="OTKdan kroyga qaytgan brak: 1 sort, 2 sort va yaroqsiz. 1 va 2 sort yarim tayyorga qo'shiladi, yaroqsiz — P&L xarajat." />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <label className="f">
            Sana
            <input type="date" value={sortDate} disabled={!write} onChange={(e) => setSortDate(e.target.value)} />
          </label>
          <div className="f">
            Jami brak
            <b>{fmtNum(rows.reduce((a, i) => a + (i.otk_brak ?? 0), 0))}</b>
          </div>
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">Brak yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1250 }}>
              <thead>
                <tr>
                  <th>OTK sana</th>
                  <th>Partiya raqam</th>
                  <th>Tovar nomi</th>
                  <th>Artikul</th>
                  <th>Model</th>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th>ID</th>
                  <th className="n">Brak soni</th>
                  <th className="n">1 sort</th>
                  <th className="n">2 sort</th>
                  <th className="n">Yaroqsiz</th>
                  <th className="n">Ostatka</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id} className={bad(i) ? 'bad-row' : touched(i) ? 'sel-row' : ''}>
                    <td className="mono">{fmtDate(i.otk_date)}</td>
                    <td className="mono">{i.partiya_no}</td>
                    <td>{i.product_type_name}</td>
                    <td>{i.artikul ?? ''}</td>
                    <td>{i.model ?? ''}</td>
                    <td className="mono">{i.size_name}</td>
                    <td>{i.color_name}</td>
                    <td className="mono">{i.id}</td>
                    <td className="n">
                      <b>{i.otk_brak}</b>
                    </td>
                    {(['sort1', 'sort2', 'scrap'] as const).map((k) => (
                      <td key={k} className="n">
                        <input className="cell num" inputMode="numeric" value={v(i)[k]} disabled={!write} onChange={(e) => set(i, { [k]: e.target.value })} aria-label={`${k} ID ${i.id}`} />
                      </td>
                    ))}
                    <td className="n">{touched(i) ? <b className={left(i) ? 'err' : ''}>{Number.isFinite(left(i)) ? left(i) : '—'}</b> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {write && rows.length > 0 && <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>Ostatka 0 bo'lgan qatorlar saqlanadi.</SubmitBar>}
      </div>

      <div className="card">
        <h2>Saralangan brak · yaroqsiz (P&L xarajat): {money(scrapSum)} so'm</h2>
        {!done.data?.length ? (
          <p className="note">Hali yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1100 }}>
              <thead>
                <tr>
                  <th>Sana</th>
                  <th>ID</th>
                  <th>Partiya</th>
                  <th>Tovar</th>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">Brak</th>
                  <th className="n">1 sort</th>
                  <th className="n">2 sort</th>
                  <th className="n">Yaroqsiz</th>
                  <th className="n">1 dona tannarxi</th>
                  <th className="n">Yaroqsiz summa (P&L)</th>
                </tr>
              </thead>
              <tbody>
                {done.data.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{fmtDate(i.sort_date)}</td>
                    <td className="mono">{i.id}</td>
                    <td className="mono">{i.partiya_no}</td>
                    <td>{i.product_type_name}</td>
                    <td className="mono">{i.size_name}</td>
                    <td>{i.color_name}</td>
                    <td className="n">{i.otk_brak}</td>
                    <td className="n">{i.sort1}</td>
                    <td className="n">{i.sort2}</td>
                    <td className="n">{i.scrap ? <span className="pill bad">{i.scrap}</span> : 0}</td>
                    <td className="n">{i.unit_cost == null ? '—' : money(i.unit_cost)}</td>
                    <td className="n">{money(i.scrap_cost_uzs)}</td>
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

// ---------- Kroyda turgan yarim tayyor ----------
export function SemiPage() {
  const [partiya, setPartiya] = useState('');
  const q = useQuery({ queryKey: ['stock', 'kroy', 'semi'], queryFn: () => api<SemiRow[]>('/kroy/semi') });
  const rows = (q.data ?? []).filter((r) => !partiya || r.partiya_no === partiya);
  return (
    <>
      <PageHead title="Kroyda turgan yarim tayyor" sub="OTK 1 sort + brakdan 1 va 2 sort − ishlab chiqarishga berilgan" />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <PartiyaFilter list={(q.data ?? []).map((r) => r.partiya_no)} value={partiya} onChange={setPartiya} />
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">Kroyda yarim tayyor yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1000 }}>
              <thead>
                <tr>
                  <th>Tartib raqam</th>
                  <th>Partiya</th>
                  <th>Tovar</th>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">OTK 1 sort</th>
                  <th className="n">Brakdan 1 sort</th>
                  <th className="n">2 sort</th>
                  <th className="n">Jami miqdor</th>
                  <th className="n">Ishlab chiqarishga berilgan</th>
                  <th className="n">shundan tasdiqlangan</th>
                  <th className="n">Kroyda turgan</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.order_id}:${r.color_id}:${r.size_id}`} className={r.left_qty < 0 ? 'bad-row' : ''}>
                    <td className="mono">{i + 1}</td>
                    <td className="mono">{r.partiya_no}</td>
                    <td>{r.product_type_name}</td>
                    <td className="mono">{r.size_name}</td>
                    <td>{r.color_name}</td>
                    <td className="n">{fmtNum(r.otk_first)}</td>
                    <td className="n">{r.sort1 ? fmtNum(r.sort1) : ''}</td>
                    <td className="n">{r.sort2 ? fmtNum(r.sort2) : ''}</td>
                    <td className="n">{fmtNum(r.total)}</td>
                    <td className="n">{fmtNum(r.issued)}</td>
                    <td className="n">{fmtNum(r.accepted)}</td>
                    <td className="n">
                      <b>{fmtNum(r.left_qty)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!!rows.length && (
          <p className="note" style={{ marginTop: 8 }}>
            Jami kroyda: <b>{fmtNum(rows.reduce((a, r) => a + r.left_qty, 0))}</b> dona
          </p>
        )}
      </div>
    </>
  );
}

// ---------- Kroydan rasxod ----------
const ISSUE_STATUS: Record<KroyIssue['status'], [string, string]> = {
  pending: ['Kutilmoqda', 'warn'],
  accepted: ['Tasdiqlangan', 'good'],
  rejected: ['Rad etilgan', 'bad'],
};

export function KroyRasxodPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useKroyInvalidate();
  const [issueDate, setIssueDate] = useState(today());
  const [producer, setProducer] = useState('');
  const [partiya, setPartiya] = useState('');
  const [color, setColor] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const semi = useQuery({ queryKey: ['stock', 'kroy', 'semi'], queryFn: () => api<SemiRow[]>('/kroy/semi') });
  const issues = useQuery({ queryKey: ['stock', 'kroy', 'issues'], queryFn: () => api<KroyIssue[]>('/kroy/issues?limit=300') });
  const producers = useCatalog<Producer>('producers');
  useEffect(() => setQty({}), [semi.data, partiya]);
  const save = useMutation({
    mutationFn: (body: object) => api<{ issue_no: string }>('/kroy/issues', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      toast(`Rasxod ${r.issue_no} saqlandi`);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/kroy/issues/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      inv();
      toast("Rasxod o'chirildi");
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  if (!me) return null;
  const write = can.kroyWrite(me.role);
  const avail = (semi.data ?? []).filter((r) => r.left_qty > 0);
  const partiyas = [...new Map(avail.map((r) => [String(r.order_id), r.partiya_no])).entries()];
  const rows = avail.filter((r) => String(r.order_id) === partiya && (!color || r.color_name === color));
  const k = (r: SemiRow) => `${r.color_id}:${r.size_id}`;
  const q = (r: SemiRow) => intOf(qty[k(r)]);
  const bad = (r: SemiRow) => !!qty[k(r)] && (!(Number.isInteger(q(r)) && q(r) > 0) || q(r) > r.left_qty);

  const submit = () => {
    setMsg(null);
    if (!issueDate) return setMsg('Sana kiritilmagan!');
    if (!producer) return setMsg('Qayergaligi tanlanmagan!');
    if (!partiya) return setMsg('Partiya raqam tanlanmagan!');
    const t = rows.filter((r) => qty[k(r)]);
    if (!t.length) return setMsg('Rasxod miqdorini kiriting');
    if (t.some(bad)) return setMsg('Qoldiq miqdori kam');
    save.mutate({ issue_date: issueDate, order_id: Number(partiya), producer_id: Number(producer), rows: t.map((r) => ({ color_id: r.color_id, size_id: r.size_id, qty: q(r) })) });
  };

  return (
    <>
      <PageHead title="Kroydan rasxod" sub="Yarim tayyorni ishlab chiqarishga (korxonaga) jo'natish; Ish/Chiq raqam = partiya_N" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <label className="f">
            Sana
            <input type="date" value={issueDate} disabled={!write} onChange={(e) => setIssueDate(e.target.value)} />
          </label>
          <label className="f">
            Qayerga
            <select value={producer} disabled={!write} onChange={(e) => setProducer(e.target.value)}>
              <option value="">— tanlang —</option>
              {producers.data
                ?.filter((p) => p.is_active)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="f">
            Partiya raqam
            <select value={partiya} onChange={(e) => setPartiya(e.target.value)}>
              <option value="">— tanlang —</option>
              {partiyas.map(([id, no]) => (
                <option key={id} value={id}>
                  {no}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            Rangi
            <select value={color} onChange={(e) => setColor(e.target.value)}>
              <option value="">Hammasi</option>
              {[...new Set(avail.filter((r) => String(r.order_id) === partiya).map((r) => r.color_name))].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <ErrorText error={semi.error} />
        {!partiya ? (
          <p className="note">{avail.length ? 'Partiya raqamini tanlang.' : "Kroyda yarim tayyor yo'q."}</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 600 }}>
              <thead>
                <tr>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">Jami miqdor</th>
                  <th className="n">Rasxod miqdor</th>
                  <th className="n">Qoldiq</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={k(r)} className={bad(r) ? 'bad-row' : qty[k(r)] ? 'sel-row' : ''}>
                    <td className="mono">{r.size_name}</td>
                    <td>{r.color_name}</td>
                    <td className="n">{fmtNum(r.left_qty)}</td>
                    <td className="n">
                      <input className="cell num" inputMode="numeric" value={qty[k(r)] ?? ''} disabled={!write} onChange={(e) => setQty((x) => ({ ...x, [k(r)]: e.target.value }))} aria-label={`Rasxod ${r.color_name} ${r.size_name}`} />
                    </td>
                    <td className="n">{qty[k(r)] ? <b className={bad(r) ? 'err' : ''}>{Number.isFinite(q(r)) ? r.left_qty - q(r) : '—'}</b> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {write && partiya && (
          <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
            <button className="btn ghost sm" onClick={() => setQty(Object.fromEntries(rows.map((r) => [k(r), String(r.left_qty)])))}>
              Hammasini berish
            </button>
          </SubmitBar>
        )}
      </div>

      <div className="card">
        <h2>Kroydan rasxod (baza)</h2>
        {!issues.data?.length ? (
          <p className="note">Hali yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1100 }}>
              <thead>
                <tr>
                  <th>Kiritilgan sana</th>
                  <th>Sana</th>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">Miqdor</th>
                  <th>Partiya raqam</th>
                  <th>Ish/Chiq raqam</th>
                  <th>Qaysi korxonaga berilgani</th>
                  <th>Munosabat</th>
                  <th>Kiritdi</th>
                  {write && <th />}
                </tr>
              </thead>
              <tbody>
                {issues.data.map((x) => (
                  <tr key={x.id}>
                    <td className="mono">{fmtDateTime(x.created_at)}</td>
                    <td className="mono">{fmtDate(x.issue_date)}</td>
                    <td className="mono">{x.size_name}</td>
                    <td>{x.color_name}</td>
                    <td className="n">{fmtNum(x.qty)}</td>
                    <td className="mono">{x.partiya_no}</td>
                    <td className="mono">{x.issue_no}</td>
                    <td>{x.producer_name}</td>
                    <td>
                      <span className={`pill ${ISSUE_STATUS[x.status][1]}`}>{ISSUE_STATUS[x.status][0]}</span>
                    </td>
                    <td>{x.created_by_name ?? ''}</td>
                    {write && (
                      <td>
                        {x.status === 'pending' && (
                          <button className="x" aria-label="Rasxodni o'chirish" disabled={del.isPending} onClick={() => confirm(`${x.issue_no}: ${x.color_name} ${x.size_name} ${x.qty} ta o'chirilsinmi?`) && del.mutate(x.id)}>
                            ✕
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note" style={{ marginTop: 8 }}>Munosabatni (tasdiqlash / rad etish) tsex «Prixod (kroydan)» sahifasida beradi; rad etilgani kroyga qaytadi.</p>
      </div>
    </>
  );
}

// ---------- Yopilgan zakazlar ----------
export function KroyClosedPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useKroyInvalidate();
  const [orderId, setOrderId] = useState('');
  const [closedAt, setClosedAt] = useState(today());
  const [note, setNote] = useState('');
  const open = useQuery({ queryKey: ['stock', 'kroy', 'orders'], queryFn: () => api<KroyOrderHead[]>('/kroy/orders') });
  const q = useQuery({ queryKey: ['stock', 'kroy', 'closed'], queryFn: () => api<KroyClosed>('/kroy/closed') });
  const close = useMutation({
    mutationFn: () => api(`/kroy/orders/${orderId}/close`, { method: 'POST', body: { closed_at: closedAt, note: note || null } }),
    onSuccess: () => {
      inv();
      setOrderId('');
      setNote('');
      toast('Zakaz kroyda yopildi');
    },
  });
  const reopen = useMutation({
    mutationFn: (id: number) => api(`/kroy/orders/${id}/reopen`, { method: 'POST' }),
    onSuccess: () => {
      inv();
      toast('Zakaz qayta ochildi');
    },
  });
  if (!me) return null;
  const write = can.kroyWrite(me.role);
  return (
    <>
      <PageHead title="Yopilgan zakazlar" sub="Yopilgan zakaz Kroy ro'yxatidan chiqadi. Minusga kirgan xomashyo qoldiqlari avtomatik ko'rinadi." />
      {write && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="form">
            <label className="f">
              Zakaz raqami (ochiq)
              <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
                <option value="">— tanlang —</option>
                {open.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.partiya_no} · {o.product_type_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="f">
              Yopilgan sana
              <input type="date" value={closedAt} onChange={(e) => setClosedAt(e.target.value)} />
            </label>
            <label className="f">
              Izoh
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <div className="f">
              &nbsp;
              <button className="btn" disabled={!orderId || close.isPending} onClick={() => confirm('Zakaz kroyda yopilsinmi?') && close.mutate()}>
                Yopish
              </button>
            </div>
          </div>
          <ErrorText error={close.error ?? reopen.error} />
        </div>
      )}
      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Minusga kirgan qoldiqlar</h2>
        <ErrorText error={q.error} />
        {!q.data?.minus.length ? (
          <p className="note">Minus qoldiq yo'q.</p>
        ) : (
          <div className="tw">
            <table className="sheet" style={{ minWidth: 800 }}>
              <thead>
                <tr>
                  <th>Zakaz raqami</th>
                  <th>Xomashyo nomi</th>
                  <th>Xomashyo kodi</th>
                  <th>Xomashyo rangi</th>
                  <th>Rang kodi</th>
                  <th className="n">Qoldiq</th>
                  <th>Holat</th>
                </tr>
              </thead>
              <tbody>
                {q.data.minus.map((m, i) => (
                  <tr key={i} className="bad-row">
                    <td className="mono">{m.partiya_no}</td>
                    <td>{m.material_name}</td>
                    <td className="mono">{m.material_code ?? ''}</td>
                    <td>{m.material_color_name ?? ''}</td>
                    <td className="mono">{m.color_code ?? ''}</td>
                    <td className="n">
                      {fmtNum(m.left_qty)} <span className="note">{m.unit}</span>
                    </td>
                    <td>{m.kroy_closed_at ? 'Yopilgan' : 'Ochiq'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Yopilgan zakazlar</h2>
        {!q.data?.closed.length ? (
          <p className="note">Yopilgan zakaz yo'q.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Zakaz raqami</th>
                  <th>Tovar</th>
                  <th>Yopilgan sana</th>
                  <th>Izoh</th>
                  {write && <th />}
                </tr>
              </thead>
              <tbody>
                {q.data.closed.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.partiya_no}</td>
                    <td>{[o.product_type_name, o.artikul, o.model].filter(Boolean).join(' · ')}</td>
                    <td className="mono">{fmtDate(o.kroy_closed_at)}</td>
                    <td>{o.kroy_close_note ?? ''}</td>
                    {write && (
                      <td>
                        <button className="btn ghost sm" disabled={reopen.isPending} onClick={() => confirm('Zakaz kroyda qayta ochilsinmi?') && reopen.mutate(o.id)}>
                          Qayta ochish
                        </button>
                      </td>
                    )}
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
