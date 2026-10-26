import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import { can, type Producer, type TsexBalance, type TsexIssue, type TsexMaterial, type TsexOutput, type TsexPlan } from '../types';
import { useCatalog } from './Orders';
import { money, num, plain } from './purchaseUi';
import { SubmitBar, itemKey, today, useStockInvalidate } from './stockUi';

/** Tsex so'rovlari ['stock', 'tsex', ...] kalitida — kroy va sklad bilan birga yangilanadi */
const useTsexInvalidate = useStockInvalidate;
const cellKey = (c: { color_id: number; size_id: number }) => `${c.color_id}:${c.size_id}`;

/** Tanlangan tsex brauzerda eslab qolinadi (har kirishda qayta tanlamaslik uchun) */
function useTsex(): [string, (v: string) => void] {
  const read = () => {
    try {
      return localStorage.getItem('istam.tsex') ?? '';
    } catch {
      return '';
    }
  };
  const [v, setV] = useState(read);
  return [
    v,
    (x: string) => {
      setV(x);
      try {
        localStorage.setItem('istam.tsex', x);
      } catch {
        /* saqlanmasa ham ishlaydi */
      }
    },
  ];
}

function TsexSelect({ value, onChange, all }: { value: string; onChange: (v: string) => void; all?: boolean }) {
  const producers = useCatalog<Producer>('producers');
  return (
    <label className="f">
      Tsex (ishlab chiqaruvchi)
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all ? 'Hammasi' : '— tanlang —'}</option>
        {producers.data
          ?.filter((p) => p.is_active || String(p.id) === value)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </select>
    </label>
  );
}

const STATUS: Record<TsexIssue['status'], [string, string]> = {
  pending: ['Kutilmoqda', 'warn'],
  accepted: ['Tasdiqlash', 'good'],
  rejected: ['Rad etish', 'bad'],
};

// ---------- Prixod_Kroy ----------
export function TsexPrixodPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useTsexInvalidate();
  const [tsex, setTsex] = useTsex();
  const [date, setDate] = useState(today());
  const [partiya, setPartiya] = useState('');
  const [dec, setDec] = useState<Record<number, 'accepted' | 'rejected'>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const pending = useQuery({
    queryKey: ['stock', 'tsex', 'issues', 'pending', tsex],
    queryFn: () => api<TsexIssue[]>(`/tsex/issues?status=pending${tsex ? `&producer_id=${tsex}` : ''}`),
  });
  const decided = useQuery({
    queryKey: ['stock', 'tsex', 'issues', 'decided', tsex],
    queryFn: () => api<TsexIssue[]>(`/tsex/issues?status=decided&limit=300${tsex ? `&producer_id=${tsex}` : ''}`),
  });
  useEffect(() => setDec({}), [pending.data, partiya]);
  const save = useMutation({
    mutationFn: (body: object) => api<{ accepted: number; rejected: number }>('/tsex/accept', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      toast(`Qabul qilindi: ${r.accepted}, rad etildi: ${r.rejected}`);
    },
  });
  if (!me) return null;
  const write = can.tsexWrite(me.role);
  const partiyas = [...new Map((pending.data ?? []).map((x) => [String(x.order_id), x.partiya_no])).entries()];
  const rows = (pending.data ?? []).filter((x) => String(x.order_id) === partiya);
  const d = (x: TsexIssue) => dec[x.id] ?? 'accepted';

  const submit = () => {
    setMsg(null);
    if (!date) return setMsg('Iltimos, sanani tanlang!');
    if (!partiya) return setMsg('Iltimos, partiya raqamini tanlang!');
    if (!rows.length) return setMsg("Bu partiyada ma'lumot topilmadi!");
    save.mutate({ decided_date: date, rows: rows.map((x) => ({ issue_id: x.id, decision: d(x) })) });
  };

  return (
    <>
      <PageHead title="Prixod (kroydan)" sub="Kroydan kelgan yarim tayyorni qabul qilish: Tasdiqlash — tsexga kiradi, Rad etish — kroyga qaytadi" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <TsexSelect value={tsex} onChange={setTsex} all />
          <label className="f">
            Sana
            <input type="date" value={date} disabled={!write} onChange={(e) => setDate(e.target.value)} />
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
        </div>
        <ErrorText error={pending.error} />
        {!partiya ? (
          <p className="note">{partiyas.length ? 'Partiya raqamini tanlang.' : 'Kroydan kelgan, qabul qilinmagan yarim tayyor yo\'q.'}</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">Qabul qilingan miqdor</th>
                  <th>Id</th>
                  {!tsex && <th>Tsex</th>}
                  <th>Sana</th>
                  <th>Munosabat</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.id} className={d(x) === 'rejected' ? 'bad-row' : ''}>
                    <td className="mono">{x.size_name}</td>
                    <td>{x.color_name}</td>
                    <td className="n">
                      <b>{fmtNum(x.qty)}</b>
                    </td>
                    <td className="mono">{x.issue_no}</td>
                    {!tsex && <td>{x.producer_name}</td>}
                    <td className="mono">{fmtDate(x.issue_date)}</td>
                    <td>
                      <select value={d(x)} disabled={!write} onChange={(e) => setDec((v) => ({ ...v, [x.id]: e.target.value as 'accepted' | 'rejected' }))} aria-label="Munosabat">
                        <option value="accepted">Tasdiqlash</option>
                        <option value="rejected">Rad etish</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {write && partiya && (
          <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
            Jami {fmtNum(rows.reduce((a, x) => a + x.qty, 0))} dona · rad etiladigan: {rows.filter((x) => d(x) === 'rejected').length} qator
          </SubmitBar>
        )}
      </div>

      <div className="card">
        <h2>Prixod_Kroy (baza)</h2>
        {!decided.data?.length ? (
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
                  <th>Tsex</th>
                  <th>Munosabat</th>
                  <th>Kim</th>
                </tr>
              </thead>
              <tbody>
                {decided.data.map((x) => (
                  <tr key={x.id}>
                    <td className="mono">{fmtDateTime(x.created_at)}</td>
                    <td className="mono">{fmtDate(x.decided_date)}</td>
                    <td className="mono">{x.size_name}</td>
                    <td>{x.color_name}</td>
                    <td className="n">{fmtNum(x.qty)}</td>
                    <td className="mono">{x.partiya_no}</td>
                    <td className="mono">{x.issue_no}</td>
                    <td>{x.producer_name}</td>
                    <td>
                      <span className={`pill ${STATUS[x.status][1]}`}>{STATUS[x.status][0]}</span>
                    </td>
                    <td>{x.decided_by_name ?? ''}</td>
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

// ---------- Ishlab chiqarish ----------
export function TsexProductionPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useTsexInvalidate();
  const [tsex, setTsex] = useTsex();
  const [date, setDate] = useState(today());
  const [partiya, setPartiya] = useState('');
  const [issueNo, setIssueNo] = useState('');
  const [fact, setFact] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const bal = useQuery({
    queryKey: ['stock', 'tsex', 'balance', tsex],
    queryFn: () => api<TsexBalance[]>(`/tsex/balance?producer_id=${tsex}`),
    enabled: !!tsex,
  });
  const plan = useQuery({
    queryKey: ['stock', 'tsex', 'plan', tsex, partiya],
    queryFn: () => api<TsexPlan>(`/tsex/plan?producer_id=${tsex}&order_id=${partiya}`),
    enabled: !!tsex && !!partiya,
  });
  useEffect(() => {
    setFact({});
    setMsg(null);
  }, [plan.data, issueNo]);
  const save = useMutation({
    mutationFn: (body: object) => api<{ id: number; materials: number }>('/tsex/outputs', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      toast(`Ishlab chiqarish №${r.id} saqlandi (${r.materials} ta furnitura qatori)`);
    },
  });
  if (!me) return null;
  const write = can.tsexWrite(me.role);
  const partiyas = [...new Map((bal.data ?? []).filter((b) => b.left_qty > 0).map((b) => [String(b.order_id), b.partiya_no])).entries()];
  const inIssue = plan.data?.issue_nos.find((x) => x.issue_no === issueNo);
  const cells = (plan.data?.cells ?? []).filter((c) => c.left_qty > 0 && (!inIssue || inIssue.cells.includes(cellKey(c))));
  const f = (c: TsexBalance) => num(fact[cellKey(c)] ?? '');
  const bad = (c: TsexBalance) => !!fact[cellKey(c)] && (!(Number.isInteger(f(c)) && f(c) > 0) || f(c) > c.left_qty);
  const left = cells.reduce((a, c) => a + c.left_qty - (f(c) > 0 ? f(c) : 0), 0);
  // furnitura: zakaz normasi × fakt
  const stockOf = new Map((plan.data?.materials ?? []).map((m) => [itemKey(m), Number(m.left_qty)]));
  const furn = cells.flatMap((c) =>
    f(c) > 0
      ? (plan.data?.norms ?? [])
          .filter((n) => n.color_id === c.color_id && (n.size_id == null || n.size_id === c.size_id))
          .map((n) => ({ n, c, qty: Math.round(Number(n.per_unit) * f(c) * 1000) / 1000 }))
      : [],
  );

  const submit = () => {
    setMsg(null);
    if (!date) return setMsg('Iltimos, sanani tanlang!');
    if (!tsex) return setMsg('Iltimos, tsexni tanlang!');
    if (!partiya) return setMsg('Iltimos, partiya raqamini tanlang!');
    const t = cells.filter((c) => fact[cellKey(c)]);
    if (!t.length) return setMsg('Fakt miqdorini kiriting!');
    const b = t.find(bad);
    if (b) return setMsg(`${b.color_name} ${b.size_name}: fakt butun son va tikilmagan sonidan (${b.left_qty}) ko'p emas bo'lishi kerak`);
    save.mutate({ producer_id: Number(tsex), order_id: Number(partiya), out_date: date, issue_no: issueNo || null, rows: t.map((c) => ({ color_id: c.color_id, size_id: c.size_id, fact_qty: f(c) })) });
  };

  return (
    <>
      <PageHead title="Ishlab chiqarish" sub="Tikilgan tayyor mahsulot (Ish/Chiq GP) va zakaz normasi bo'yicha furnitura sarfi (Ish/Chiq Xa)" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form">
          <TsexSelect
            value={tsex}
            onChange={(v) => {
              setTsex(v);
              setPartiya('');
            }}
          />
          <label className="f">
            Sana
            <input type="date" value={date} disabled={!write} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="f">
            Partiya raqam
            <select
              value={partiya}
              onChange={(e) => {
                setPartiya(e.target.value);
                setIssueNo('');
              }}
            >
              <option value="">— tanlang —</option>
              {partiyas.map(([id, no]) => (
                <option key={id} value={id}>
                  {no}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            Ish/Chiq raqami (ixtiyoriy)
            <select value={issueNo} onChange={(e) => setIssueNo(e.target.value)}>
              <option value="">Hammasi</option>
              {plan.data?.issue_nos.map((x) => (
                <option key={x.issue_no}>{x.issue_no}</option>
              ))}
            </select>
          </label>
          {plan.data && (
            <div className="f">
              Tovar
              <b>{[plan.data.order.product_type_name, plan.data.order.artikul, plan.data.order.model].filter(Boolean).join(' · ')}</b>
            </div>
          )}
        </div>
        {tsex && bal.data && !partiyas.length && <p className="note" style={{ marginTop: 8 }}>Bu tsexda tikilmagan yarim tayyor yo'q. Avval «Prixod (kroydan)»da qabul qilinadi.</p>}
      </div>

      {plan.data && (
        <div className="card" style={{ marginBottom: 14 }}>
          <ErrorText error={plan.error} />
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 220 + cells.length * 96 }}>
              <thead>
                <tr>
                  <th>Rang</th>
                  {cells.map((c) => (
                    <th key={cellKey(c)} className="n">
                      {c.color_name}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th style={{ top: 30 }}>Razmer</th>
                  {cells.map((c) => (
                    <th key={cellKey(c)} className="n" style={{ top: 30 }}>
                      {c.size_name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="note">Tikilmagan soni</td>
                  {cells.map((c) => (
                    <td key={cellKey(c)} className="n">
                      {fmtNum(c.left_qty)}
                    </td>
                  ))}
                </tr>
                <tr className="sel-row">
                  <td>
                    <b>Fakt</b>
                  </td>
                  {cells.map((c) => (
                    <td key={cellKey(c)} className={`n ${bad(c) ? 'bad-row' : ''}`}>
                      <input
                        className="cell num"
                        inputMode="numeric"
                        value={fact[cellKey(c)] ?? ''}
                        disabled={!write}
                        onChange={(e) => setFact((x) => ({ ...x, [cellKey(c)]: e.target.value }))}
                        aria-label={`Fakt ${c.color_name} ${c.size_name}`}
                      />
                    </td>
                  ))}
                </tr>
                <tr>
                  <td>
                    <b>Qoldiq: {fmtNum(left)} dona</b>
                  </td>
                  {cells.map((c) => (
                    <td key={cellKey(c)} className="n">
                      <b className={bad(c) ? 'err' : ''}>{fmtNum(c.left_qty - (f(c) > 0 ? f(c) : 0))}</b>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          {!cells.length && <p className="note">Bu partiya / Ish/Chiq raqami bo'yicha tikilmagan yarim tayyor yo'q.</p>}

          <h2 style={{ marginTop: 16 }}>Furnitura sarfi (zakaz normasi × fakt)</h2>
          {!furn.length ? (
            <p className="note">Fakt kiritilgach shu yerda hisoblanadi.</p>
          ) : (
            <div className="sheet-wrap">
              <table className="sheet" style={{ minWidth: 1100 }}>
                <thead>
                  <tr>
                    <th>Xomashyo nomi</th>
                    <th>Xomashyo kodi</th>
                    <th>Xomashyo rangi</th>
                    <th>Rang kodi</th>
                    <th>Razmer</th>
                    <th className="n">Miqdor (1 dona)</th>
                    <th>Tayyor mahsulot rangi</th>
                    <th>Tayyor mahsulot razmeri</th>
                    <th className="n">Miqdor</th>
                    <th className="n">Jami miqdor</th>
                    <th className="n">Tsexdagi qoldiq</th>
                  </tr>
                </thead>
                <tbody>
                  {furn.map(({ n, c, qty }, i) => {
                    const st = stockOf.get(itemKey(n));
                    return (
                      <tr key={i}>
                        <td>
                          <b>{n.material_name}</b>
                        </td>
                        <td className="mono">{n.material_code ?? ''}</td>
                        <td>{n.material_color_name ?? ''}</td>
                        <td className="mono">{n.color_code ?? ''}</td>
                        <td className="mono">{n.material_size ?? ''}</td>
                        <td className="n">{plain(n.per_unit)}</td>
                        <td>{c.color_name}</td>
                        <td className="mono">{c.size_name}</td>
                        <td className="n">{fmtNum(f(c))}</td>
                        <td className="n">
                          <b>{fmtNum(qty)}</b> <span className="note">{n.unit}</span>
                        </td>
                        <td className="n">{st == null ? <span className="note">berilmagan</span> : <span className={st < qty ? 'err' : ''}>{fmtNum(st)}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {write && (
            <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
              Furnitura tsexdagi qoldiqdan yechiladi. Skladdan tsexga berilmagan bo'lsa ham saqlanadi (qoldiq minusga kiradi).
            </SubmitBar>
          )}
        </div>
      )}

      <TsexGpBaza tsex={tsex} />
    </>
  );
}

/** Ish/Chiq GP baza */
function TsexGpBaza({ tsex }: { tsex: string }) {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useTsexInvalidate();
  const q = useQuery({
    queryKey: ['stock', 'tsex', 'outputs', tsex],
    queryFn: () => api<TsexOutput[]>(`/tsex/outputs?limit=500${tsex ? `&producer_id=${tsex}` : ''}`),
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/tsex/docs/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      inv();
      toast("Ishlab chiqarish o'chirildi");
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  const write = !!me && can.tsexWrite(me.role);
  let last = 0;
  return (
    <div className="card">
      <h2>Ish/Chiq GP (baza)</h2>
      <ErrorText error={q.error} />
      {!q.data?.length ? (
        <p className="note">Hali yo'q.</p>
      ) : (
        <div className="sheet-wrap">
          <table className="sheet" style={{ minWidth: 1100 }}>
            <thead>
              <tr>
                <th>Kiritilgan sana</th>
                <th>Sana</th>
                <th>Tartib raqam</th>
                <th>Tovar rangi</th>
                <th>Tovar razmeri</th>
                <th className="n">Tikishi kerak</th>
                <th className="n">Fakt</th>
                <th>Partiya raqam</th>
                <th>Ish/Chiq raqami</th>
                <th>Ishlab chiqaruvchi</th>
                <th className="n">Furnitura, so'm</th>
                <th>Kiritdi</th>
                {write && <th />}
              </tr>
            </thead>
            <tbody>
              {q.data.map((o) => {
                const first = o.doc_id !== last;
                last = o.doc_id;
                return (
                  <tr key={o.id}>
                    <td className="mono">{fmtDateTime(o.created_at)}</td>
                    <td className="mono">{fmtDate(o.out_date)}</td>
                    <td className="mono">{o.doc_id}</td>
                    <td>{o.color_name}</td>
                    <td className="mono">{o.size_name}</td>
                    <td className="n">{fmtNum(o.need_qty)}</td>
                    <td className="n">
                      <b>{fmtNum(o.fact_qty)}</b>
                    </td>
                    <td className="mono">{o.partiya_no}</td>
                    <td className="mono">{o.issue_no ?? ''}</td>
                    <td>{o.producer_name}</td>
                    <td className="n">{o.materials_cost ? money(o.materials_cost) : ''}</td>
                    <td>{o.created_by_name ?? ''}</td>
                    {write && (
                      <td>
                        {first && (
                          <button className="x" aria-label={`Ishlab chiqarish ${o.doc_id} ni o'chirish`} disabled={del.isPending} onClick={() => confirm(`Ishlab chiqarish №${o.doc_id} o'chirilsinmi?`) && del.mutate(o.doc_id)}>
                            ✕
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Ostatka ----------
export function TsexOstatkaPage() {
  const [tsex, setTsex] = useTsex();
  const [partiya, setPartiya] = useState('');
  const q = useQuery({
    queryKey: ['stock', 'tsex', 'balance', tsex],
    queryFn: () => api<TsexBalance[]>(`/tsex/balance${tsex ? `?producer_id=${tsex}` : ''}`),
  });
  const rows = (q.data ?? []).filter((r) => !partiya || r.partiya_no === partiya);
  return (
    <>
      <PageHead title="Tsex ostatka" sub="Tsexdagi tikilmagan yarim tayyor: tasdiqlangan prixod − ishlab chiqarilgani" />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <TsexSelect value={tsex} onChange={setTsex} all />
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
          <p className="note">Tsexda qoldiq yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>Partiya raqam</th>
                  <th>Tovar</th>
                  {!tsex && <th>Tsex</th>}
                  <th>Razmer</th>
                  <th>Rangi</th>
                  <th className="n">Prixod bo'lgani</th>
                  <th className="n">Qabul kutilmoqda</th>
                  <th className="n">Ishlab chiqarish qilingani</th>
                  <th className="n">Qoldiq</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.order_id}:${r.producer_id}:${r.color_id}:${r.size_id}`}>
                    <td className="mono">{r.partiya_no}</td>
                    <td>{r.product_type_name}</td>
                    {!tsex && <td>{r.producer_name}</td>}
                    <td className="mono">{r.size_name}</td>
                    <td>{r.color_name}</td>
                    <td className="n">{fmtNum(r.received)}</td>
                    <td className="n">{r.pending ? <span className="pill warn">{fmtNum(r.pending)}</span> : ''}</td>
                    <td className="n">{fmtNum(r.produced)}</td>
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
            Jami qoldiq: <b>{fmtNum(rows.reduce((a, r) => a + r.left_qty, 0))}</b> dona
          </p>
        )}
      </div>
    </>
  );
}

// ---------- Ish/Chiq Xa ----------
export function TsexXaPage() {
  const [tsex, setTsex] = useTsex();
  const q = useQuery({
    queryKey: ['stock', 'tsex', 'materials', tsex],
    queryFn: () => api<TsexMaterial[]>(`/tsex/materials?limit=1000${tsex ? `&producer_id=${tsex}` : ''}`),
  });
  return (
    <>
      <PageHead title="Ish/Chiq Xa" sub="Ishlab chiqarishda sarflangan furnitura (zakaz normasi × tikilgan fakt)" />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <TsexSelect value={tsex} onChange={setTsex} all />
        </div>
        <ErrorText error={q.error} />
        {!q.data?.length ? (
          <p className="note">Hali yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1400 }}>
              <thead>
                <tr>
                  <th>Kiritilgan sana</th>
                  <th>Sana</th>
                  <th>Tartib raqam</th>
                  <th>Xomashyo nomi</th>
                  <th>Xomashyo kodi</th>
                  <th>Xomashyo rangi</th>
                  <th>Rang kodi</th>
                  <th>Razmer</th>
                  <th className="n">Miqdor</th>
                  <th>Tayyor mahsulot rangi</th>
                  <th>Tayyor mahsulot razmeri</th>
                  <th className="n">Miqdor</th>
                  <th className="n">Jami miqdor</th>
                  <th>Partiya raqam</th>
                  {!tsex && <th>Tsex</th>}
                  <th className="n">Summa, so'm</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{fmtDateTime(m.created_at)}</td>
                    <td className="mono">{fmtDate(m.out_date)}</td>
                    <td className="mono">{m.doc_id}</td>
                    <td>
                      <b>{m.material_name}</b>
                    </td>
                    <td className="mono">{m.material_code ?? ''}</td>
                    <td>{m.material_color_name ?? ''}</td>
                    <td className="mono">{m.color_code ?? ''}</td>
                    <td className="mono">{m.material_size ?? ''}</td>
                    <td className="n">{plain(m.per_unit)}</td>
                    <td>{m.color_name}</td>
                    <td className="mono">{m.size_name}</td>
                    <td className="n">{fmtNum(m.fact_qty)}</td>
                    <td className="n">
                      {fmtNum(m.qty)} <span className="note">{m.unit}</span>
                    </td>
                    <td className="mono">{m.partiya_no}</td>
                    {!tsex && <td>{m.producer_name}</td>}
                    <td className="n">{money(m.cost_uzs)}</td>
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
