import { useMutation, useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Modal, PageHead, fmtDate, fmtNum, useToast } from '../components/ui';
import { can, type AdjKind, type Employee, type HrAdjustment, type HrPayment, type Payroll, type TimesheetMonth, type TimesheetRow, type WorkLog, type WorkPrice, type WorkType } from '../types';
import { DeptSelect, monthStart, useEmployees, useHrInvalidate } from './Hr';
import { money, num } from './purchaseUi';
import { SubmitBar, today } from './stockUi';

/** HR: tabel ("HR Istam yangi"), ish nazorati, ish turlari, vedomost, bonus va to'lovlar */

/** Serverdagi hisob bilan bir xil: ketgan − kelgan, 6 soatdan uzun smenada 1 soat tushlik, ± qo'shimcha */
function calcHours(came: string, left: string, extra: number) {
  const ok = (t: string) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t);
  if (!ok(came) || !ok(left)) return null;
  const m = (t: string) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
  let span = (m(left) - m(came)) / 60;
  if (span < 0) span += 24;
  return Math.round(Math.min(24, Math.max(0, span - (span > 6 ? 1 : 0) + extra)) * 100) / 100;
}

// ---------- Tabel kiritish ----------
type TRow = { absent: boolean; reason: string; came: string; left: string; extra: string; hours: string; note: string };
const blank: TRow = { absent: false, reason: '', came: '', left: '', extra: '', hours: '', note: '' };
const filled = (r: TRow) => r.absent || r.came !== '' || r.left !== '' || r.hours !== '';
const rowHours = (r: TRow) => (r.absent ? 0 : r.came || r.left ? calcHours(r.came, r.left, r.extra.trim() ? num(r.extra) || 0 : 0) : r.hours.trim() ? num(r.hours) : null);

export function HrTabelInputPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useHrInvalidate();
  const [dept, setDept] = useState('');
  const [date, setDate] = useState(today());
  const [vals, setVals] = useState<Record<number, TRow>>({});
  const [extra, setExtra] = useState<TimesheetRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['hr', 'timesheet', 'day', dept, date],
    queryFn: () => api<TimesheetRow[]>(`/hr/timesheet/day?date=${date}&department_id=${dept}`),
    enabled: !!dept && !!date,
  });
  const all = useEmployees('', date);
  useEffect(() => {
    setExtra([]);
    setVals(
      Object.fromEntries(
        (q.data ?? [])
          .filter((r) => r.id)
          .map((r) => [
            r.employee_id,
            { absent: !!r.absent, reason: r.reason ?? '', came: r.came_at ?? '', left: r.left_at ?? '', extra: r.extra_hours && Number(r.extra_hours) ? String(Number(r.extra_hours)) : '', hours: r.came_at ? '' : r.hours ? String(Number(r.hours)) : '', note: r.note ?? '' },
          ]),
      ),
    );
  }, [q.data]);
  const save = useMutation({
    mutationFn: (body: object) => api<{ saved: number; removed: number }>('/hr/timesheet/day', { method: 'PUT', body }),
    onSuccess: (r) => {
      inv();
      toast(`Tabel saqlandi: ${r.saved} ta xodim${r.removed ? `, ${r.removed} ta olib tashlandi` : ''}`);
    },
  });
  if (!me) return null;
  const write = can.hrWrite(me.role);
  const rows = [...(q.data ?? []), ...extra];
  const v = (id: number) => vals[id] ?? blank;
  const set = (id: number, p: Partial<TRow>) => setVals((x) => ({ ...x, [id]: { ...(x[id] ?? blank), ...p } }));
  const bad = (id: number) => {
    const r = v(id);
    if (!filled(r)) return false;
    if (r.absent) return !r.reason.trim();
    const h = rowHours(r);
    return h == null || !Number.isFinite(h) || (r.extra.trim() !== '' && !Number.isFinite(num(r.extra)));
  };
  const present = rows.filter((r) => filled(v(r.employee_id)) && !v(r.employee_id).absent);
  const total = present.reduce((a, r) => a + (rowHours(v(r.employee_id)) ?? 0), 0);
  const candidates = (all.data ?? []).filter((e) => !rows.some((r) => r.employee_id === e.id));

  const submit = () => {
    setMsg(null);
    const t = rows.filter((r) => filled(v(r.employee_id)));
    const b = t.find((r) => bad(r.employee_id));
    if (b) return setMsg(`${b.full_name}: ${v(b.employee_id).absent ? 'kelmagan sababini yozing' : 'kelgan / ketgan vaqt (SS:DD) yoki soat noto\'g\'ri'}`);
    save.mutate({
      work_date: date,
      department_id: Number(dept),
      rows: t.map((r) => {
        const x = v(r.employee_id);
        return {
          employee_id: r.employee_id,
          absent: x.absent,
          reason: x.reason,
          came_at: x.absent || !x.came ? null : x.came,
          left_at: x.absent || !x.left ? null : x.left,
          extra_hours: x.extra.trim() ? num(x.extra) : 0,
          hours: x.came || x.left ? null : x.hours.trim() ? num(x.hours) : null,
          note: x.note,
        };
      }),
    });
  };

  return (
    <>
      <PageHead title="Tabel kiritish" sub="Kunlik davomat: kelgan va ketgan vaqt, javob so'ragan (−) va qo'shimcha (+) soat, kelmaganlar va sababi" />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <DeptSelect value={dept} onChange={setDept} />
          <Field label="Sana">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          {write && rows.length > 0 && (
            <div className="f">
              &nbsp;
              <button
                className="btn ghost sm"
                onClick={() => setVals((x) => ({ ...x, ...Object.fromEntries(rows.filter((r) => !filled(v(r.employee_id))).map((r) => [r.employee_id, { ...blank, came: '08:00', left: '17:00' }])) }))}
              >
                Bo'shlarga 8:00 – 17:00
              </button>
            </div>
          )}
          <div className="f">
            Kelgan / jami soat
            <b>
              {present.length} / {fmtNum(total, 1)}
            </b>
          </div>
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">Bu bo'limda shu sanada ishlaydigan xodim yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1150 }}>
              <thead>
                <tr>
                  <th>T/R</th>
                  <th>FISH</th>
                  <th>Lavozim</th>
                  <th>Kelmadi</th>
                  <th>Sababi</th>
                  <th>Kelgan vaqt</th>
                  <th>Ketgan vaqt</th>
                  <th className="n">Javob so'ragan / qo'shimcha soat</th>
                  <th className="n">Hisoblangan soat</th>
                  <th>Izoh</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const x = v(r.employee_id);
                  const h = rowHours(x);
                  const timed = x.came !== '' || x.left !== '';
                  return (
                    <tr key={r.employee_id} className={bad(r.employee_id) ? 'bad-row' : filled(x) ? 'sel-row' : ''}>
                      <td className="mono">{i + 1}</td>
                      <td>
                        {r.full_name}
                        {r.extra_worker && <span className="note"> · qo'shimcha ({r.home_department_name})</span>}
                      </td>
                      <td>{r.position ?? ''}</td>
                      <td>
                        <input type="checkbox" checked={x.absent} disabled={!write} aria-label={`${r.full_name} kelmadi`} onChange={(e) => set(r.employee_id, { absent: e.target.checked })} />
                      </td>
                      <td>{x.absent && <input className="cell" value={x.reason} disabled={!write} placeholder="Kasal, ta'til..." onChange={(e) => set(r.employee_id, { reason: e.target.value })} aria-label="Sababi" />}</td>
                      <td>{!x.absent && <input className="cell mono" value={x.came} disabled={!write} placeholder="08:00" onChange={(e) => set(r.employee_id, { came: e.target.value })} aria-label="Kelgan vaqt" />}</td>
                      <td>{!x.absent && <input className="cell mono" value={x.left} disabled={!write} placeholder="17:00" onChange={(e) => set(r.employee_id, { left: e.target.value })} aria-label="Ketgan vaqt" />}</td>
                      <td className="n">
                        {!x.absent && timed && <input className="cell num" inputMode="decimal" value={x.extra} disabled={!write} placeholder="−2 / +3" onChange={(e) => set(r.employee_id, { extra: e.target.value })} aria-label="Qo'shimcha soat" />}
                      </td>
                      <td className="n">
                        {x.absent ? (
                          <span className="pill bad">0</span>
                        ) : timed ? (
                          <b>{h == null ? '—' : fmtNum(h, 2)}</b>
                        ) : (
                          <input className="cell num" inputMode="decimal" value={x.hours} disabled={!write} placeholder="soat" onChange={(e) => set(r.employee_id, { hours: e.target.value })} aria-label="Soat" />
                        )}
                      </td>
                      <td>{filled(x) && <input className="cell" value={x.note} disabled={!write} onChange={(e) => set(r.employee_id, { note: e.target.value })} aria-label="Izoh" />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {write && dept && (
          <div className="row" style={{ marginTop: 10 }}>
            <select
              value=""
              aria-label="Qo'shimcha ishchi"
              onChange={(e) => {
                const emp = candidates.find((c) => c.id === Number(e.target.value));
                if (emp)
                  setExtra([...extra, { employee_id: emp.id, full_name: emp.full_name, position: emp.position, brigade: emp.brigade, home_department_name: emp.department_name, extra_worker: true, id: null, absent: null, reason: null, came_at: null, left_at: null, extra_hours: null, hours: null, note: null }]);
              }}
            >
              <option value="">+ Qo'shimcha ishchi (boshqa bo'limdan)</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name} — {c.department_name}
                </option>
              ))}
            </select>
          </div>
        )}
        {write && rows.length > 0 && (
          <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
            Bo'sh qatorlar saqlanmaydi (avval kiritilgan bo'lsa — o'chadi). 6 soatdan uzun smenada 1 soat tushlik ayriladi: 8:00–17:00 = 8 soat.
          </SubmitBar>
        )}
      </div>
    </>
  );
}

// ---------- Tabel (oylik jadval) ----------
export function HrTabelPage() {
  const [dept, setDept] = useState('');
  const [month, setMonth] = useState(today().slice(0, 7));
  const q = useQuery({
    queryKey: ['hr', 'timesheet', 'month', dept, month],
    queryFn: () => api<TimesheetMonth>(`/hr/timesheet/month?month=${month}&department_id=${dept}`),
    enabled: !!dept && /^\d{4}-\d{2}$/.test(month),
  });
  const d = q.data;
  return (
    <>
      <PageHead title="Tabel" sub="Oylik davomat: har kuni ishlagan soat, kelmagan kunlar (K)" />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <DeptSelect value={dept} onChange={setDept} />
          <Field label="Oy">
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </Field>
          {d && (
            <div className="f">
              Jami soat
              <b>{fmtNum(d.hours, 1)}</b>
            </div>
          )}
        </div>
        <ErrorText error={q.error} />
        {!d?.rows.length ? (
          <p className="note">Bu oyda tabel kiritilmagan.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 400 + d.days.length * 38 }}>
              <thead>
                <tr>
                  <th>№</th>
                  <th>FIO</th>
                  <th className="n">Kun</th>
                  <th className="n">Jami</th>
                  {d.days.map((x) => (
                    <th key={x} className="n" style={{ color: new Date(x).getUTCDay() === 0 ? 'var(--bad)' : undefined }}>
                      {Number(x.slice(8))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td />
                  <td>
                    <b>Jami</b>
                  </td>
                  <td />
                  <td className="n">
                    <b>{fmtNum(d.hours, 1)}</b>
                  </td>
                  {d.days.map((x) => (
                    <td key={x} className="n note">
                      {d.totals[x] ? fmtNum(d.totals[x], 1) : ''}
                    </td>
                  ))}
                </tr>
                {d.rows.map((r, i) => (
                  <tr key={r.employee_id}>
                    <td className="mono">{i + 1}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.full_name}</td>
                    <td className="n">
                      {r.days}
                      {r.absent ? <span className="note"> / {r.absent}K</span> : ''}
                    </td>
                    <td className="n">
                      <b>{fmtNum(r.hours, 1)}</b>
                    </td>
                    {d.days.map((x) => {
                      const c = r.cells[x];
                      return (
                        <td key={x} className="n mono" title={c?.absent ? `Kelmagan: ${c.reason ?? ''}` : undefined}>
                          {!c ? '' : c.absent ? <span className="pill bad">K</span> : fmtNum(c.hours, c.hours % 1 ? 1 : 0)}
                        </td>
                      );
                    })}
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

// ---------- Ish nazorati (ishbay) ----------
type WRow = { employee_id: string; work_type_id: string; qty: string; note: string };
const wblank = (): WRow => ({ employee_id: '', work_type_id: '', qty: '', note: '' });

function WorkTypeSelect({ types, value, onChange, disabled }: { types: WorkType[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const cats = [...new Set(types.map((t) => t.category))];
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label="Ish turi">
      <option value="">— ish turi —</option>
      {cats.map((c) => (
        <optgroup key={c} label={c}>
          {types
            .filter((t) => t.category === c)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {Number(t.price) ? money(t.price) : 'narx yo\'q'}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

export function HrWorkPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useHrInvalidate();
  const [dept, setDept] = useState('');
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<WRow[]>(() => Array.from({ length: 5 }, wblank));
  const [msg, setMsg] = useState<string | null>(null);
  const emps = useEmployees(dept, date);
  const types = useQuery({ queryKey: ['hr', 'work-types', dept, date], queryFn: () => api<WorkType[]>(`/hr/work-types?department_id=${dept}&on=${date}`), enabled: !!dept });
  const logs = useQuery({
    queryKey: ['hr', 'work-logs', dept, date],
    queryFn: () => api<WorkLog[]>(`/hr/work-logs?from=${date}&to=${date}&department_id=${dept}`),
    enabled: !!dept && !!date,
  });
  const save = useMutation({
    mutationFn: (body: object) => api<{ saved: number; amount: string; zero_price: number }>('/hr/work-logs', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      setRows(Array.from({ length: 5 }, wblank));
      toast(`${r.saved} ta yozuv saqlandi: ${money(r.amount)} so'm${r.zero_price ? ` · ${r.zero_price} tasida narx yo'q` : ''}`);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/hr/work-logs/${id}`, { method: 'DELETE' }),
    onSuccess: () => inv(),
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  if (!me) return null;
  const write = can.hrWork(me.role);
  const tmap = new Map((types.data ?? []).map((t) => [String(t.id), t]));
  const touched = (r: WRow) => !!(r.employee_id || r.work_type_id || r.qty.trim());
  const bad = (r: WRow) => touched(r) && (!r.employee_id || !r.work_type_id || !(Number.isInteger(num(r.qty)) && num(r.qty) > 0));
  const amount = (r: WRow) => (bad(r) || !touched(r) ? 0 : num(r.qty) * Number(tmap.get(r.work_type_id)?.price ?? 0));
  const set = (i: number, p: Partial<WRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const submit = () => {
    setMsg(null);
    const t = rows.filter(touched);
    if (!t.length) return setMsg('Xodim, ish turi va sonini kiriting');
    if (t.some(bad)) return setMsg('Har qatorda xodim, ish turi va son (butun, 0 dan katta) bo\'lishi kerak');
    save.mutate({ work_date: date, rows: t.map((r) => ({ employee_id: Number(r.employee_id), work_type_id: Number(r.work_type_id), qty: num(r.qty), note: r.note })) });
  };
  const dayTotal = (logs.data ?? []).reduce((a, l) => a + Number(l.amount), 0);
  return (
    <>
      <PageHead title="Ish nazorati" sub="Ishbay: xodim qaysi ishni nechta bajardi; summa — shu sanadagi narx bo'yicha" />
      {write && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="form" style={{ marginBottom: 12 }}>
            <DeptSelect value={dept} onChange={setDept} />
            <Field label="Sana">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <ErrorText error={emps.error ?? types.error} />
          {types.data && !types.data.length && (
            <p className="note">
              Bu bo'limda ish turi yo'q — <Link to="/hr/ish-turlari">Ish turlari va narxlar</Link> sahifasida qo'shing.
            </p>
          )}
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 950 }}>
              <thead>
                <tr>
                  <th>№</th>
                  <th>Xodim</th>
                  <th>Ish turi</th>
                  <th className="n">Soni</th>
                  <th className="n">Narxi</th>
                  <th className="n">Summasi</th>
                  <th>Izoh</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const wt = tmap.get(r.work_type_id);
                  return (
                    <tr key={i} className={bad(r) ? 'bad-row' : touched(r) ? 'sel-row' : ''}>
                      <td className="mono">{i + 1}</td>
                      <td>
                        <select value={r.employee_id} onChange={(e) => set(i, { employee_id: e.target.value })} aria-label="Xodim">
                          <option value="">— xodim —</option>
                          {(emps.data ?? []).map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.full_name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <WorkTypeSelect types={types.data ?? []} value={r.work_type_id} onChange={(x) => set(i, { work_type_id: x })} />
                      </td>
                      <td className="n">
                        <input className="cell num" inputMode="numeric" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} aria-label="Soni" />
                      </td>
                      <td className="n">{wt ? (Number(wt.price) ? money(wt.price) : <span className="pill warn">narx yo'q</span>) : ''}</td>
                      <td className="n">{amount(r) ? money(amount(r)) : ''}</td>
                      <td>
                        <input className="cell" value={r.note} onChange={(e) => set(i, { note: e.target.value })} aria-label="Izoh" />
                      </td>
                      <td>
                        <button className="x" aria-label="Qatorni o'chirish" onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [wblank()])}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn ghost sm" onClick={() => setRows([...rows, ...Array.from({ length: 5 }, wblank)])}>
              + 5 qator
            </button>
          </div>
          <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
            Jami: <b>{money(rows.reduce((a, r) => a + amount(r), 0))} so'm</b>. Narx keyin (orqa sanadan) belgilansa, summa o'zi qayta hisoblanadi.
          </SubmitBar>
        </div>
      )}
      <div className="card">
        {!write && (
          <div className="form" style={{ marginBottom: 12 }}>
            <DeptSelect value={dept} onChange={setDept} />
            <Field label="Sana">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
        )}
        <h2>
          {fmtDate(date)} kiritilganlar · {money(dayTotal)} so'm
        </h2>
        <ErrorText error={logs.error} />
        {!logs.data?.length ? (
          <p className="note">Yo'q.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Xodim</th>
                  <th>Kategoriya</th>
                  <th>Ish turi</th>
                  <th className="n">Soni</th>
                  <th className="n">Narxi</th>
                  <th className="n">Summasi</th>
                  <th>Izoh</th>
                  <th>Kiritgan</th>
                  {write && <th />}
                </tr>
              </thead>
              <tbody>
                {logs.data.map((l) => (
                  <tr key={l.id}>
                    <td>{l.full_name}</td>
                    <td>{l.category}</td>
                    <td>{l.work_name}</td>
                    <td className="n">{fmtNum(l.qty)}</td>
                    <td className="n">{Number(l.price) ? money(l.price) : <span className="pill warn">narx yo'q</span>}</td>
                    <td className="n">{money(l.amount)}</td>
                    <td>{l.note ?? ''}</td>
                    <td>{l.created_by_name ?? ''}</td>
                    {write && (
                      <td>
                        <button className="x" aria-label="O'chirish" disabled={del.isPending} onClick={() => confirm(`${l.full_name}: «${l.work_name}» ${l.qty} ta — o'chirilsinmi?`) && del.mutate(l.id)}>
                          ✕
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

// ---------- Ish turlari va narxlar ----------
function PriceModal({ t, onClose }: { t: WorkType; onClose: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useHrInvalidate();
  const [f, setF] = useState({ valid_from: today(), price: '' });
  const h = useQuery({ queryKey: ['hr', 'work-prices', t.id], queryFn: () => api<WorkPrice[]>(`/hr/work-types/${t.id}/prices`) });
  const m = useMutation({
    mutationFn: () => api(`/hr/work-types/${t.id}/prices`, { method: 'POST', body: { valid_from: f.valid_from, price: num(f.price) } }),
    onSuccess: () => {
      inv();
      toast('Narx saqlandi');
      onClose();
    },
  });
  return (
    <Modal title={`${t.category} · ${t.name}`} onClose={onClose}>
      {me && can.hrRates(me.role) && (
        <>
          <div className="form">
            <Field label="Qaysi sanadan amal qiladi">
              <input type="date" value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} />
            </Field>
            <Field label="Narx, so'm (1 dona)">
              <input className="num" inputMode="decimal" value={f.price} autoFocus onChange={(e) => setF({ ...f, price: e.target.value })} />
            </Field>
          </div>
          <p className="note">Shu sanadan keyingi barcha ish nazorati yozuvlari yangi narxda qayta hisoblanadi.</p>
          <ErrorText error={m.error} />
          <div className="actions" style={{ marginBottom: 12 }}>
            <button className="btn" disabled={m.isPending || !f.valid_from || !f.price.trim() || !(num(f.price) >= 0)} onClick={() => m.mutate()}>
              Narxni saqlash
            </button>
          </div>
        </>
      )}
      <h2>Narx tarixi</h2>
      {!h.data?.length ? (
        <p className="note">Narx belgilanmagan.</p>
      ) : (
        <table>
          <tbody>
            {h.data.map((p) => (
              <tr key={p.id}>
                <td className="mono">{fmtDate(p.valid_from)} dan</td>
                <td className="n">
                  <b>{money(p.price)}</b>
                </td>
                <td className="note">{p.created_by_name ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

export function HrWorkTypesPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useHrInvalidate();
  const [dept, setDept] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');
  const [f, setF] = useState({ category: '', name: '', price: '', valid_from: today() });
  const [open, setOpen] = useState<WorkType | null>(null);
  const q = useQuery({ queryKey: ['hr', 'work-types', dept, 'all', showAll], queryFn: () => api<WorkType[]>(`/hr/work-types?department_id=${dept}&all=${showAll}`), enabled: !!dept });
  const add = useMutation({
    mutationFn: () =>
      api('/hr/work-types', {
        method: 'POST',
        body: { department_id: Number(dept), category: f.category, name: f.name, price: f.price.trim() ? num(f.price) : null, valid_from: f.price.trim() ? f.valid_from : undefined },
      }),
    onSuccess: () => {
      inv();
      setF({ ...f, name: '', price: '' });
      toast('Ish turi qo\'shildi');
    },
  });
  const patch = useMutation({
    mutationFn: (b: { id: number; is_active: boolean }) => api(`/hr/work-types/${b.id}`, { method: 'PATCH', body: { is_active: b.is_active } }),
    onSuccess: () => inv(),
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  const cats = useMemo(() => [...new Set((q.data ?? []).map((t) => t.category))], [q.data]);
  if (!me) return null;
  const write = can.hrRates(me.role);
  const rows = (q.data ?? []).filter((t) => !search || `${t.category} ${t.name}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <PageHead title="Ish turlari va narxlar" sub="Har bo'lim (Ko'ylak, Shim) uchun alohida; narx qaysi sanadan amal qilishi bilan" />
      {write && dept && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Yangi ish qo'shish</h2>
          <div className="form">
            <Field label="Kategoriya">
              <input value={f.category} list="hr-cats" placeholder="Zagatovka, Yarim tayyor..." onChange={(e) => setF({ ...f, category: e.target.value })} />
            </Field>
            <Field label="Ish nomi">
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label="Narx (ixtiyoriy)">
              <input className="num" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
            </Field>
            {f.price.trim() !== '' && (
              <Field label="Sanadan">
                <input type="date" value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} />
              </Field>
            )}
            <div className="f">
              &nbsp;
              <button className="btn" disabled={add.isPending || !f.category.trim() || !f.name.trim() || (f.price.trim() !== '' && !(num(f.price) >= 0))} onClick={() => add.mutate()}>
                Qo'shish
              </button>
            </div>
          </div>
          <datalist id="hr-cats">
            {[...new Set([...cats, 'Zagatovka', 'Yarim tayyor', 'Tayyor mahsulot'])].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <ErrorText error={add.error} />
        </div>
      )}
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <DeptSelect value={dept} onChange={setDept} />
          <Field label="Qidirish">
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <label className="f">
            &nbsp;
            <span className="row">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> o'chirilganlar ham
            </span>
          </label>
          <div className="f">
            Soni
            <b>{rows.length}</b>
          </div>
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">Ish turi yo'q.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Kategoriya</th>
                  <th>Ish nomi</th>
                  <th className="n">Amaldagi narx</th>
                  <th>Sanadan</th>
                  <th />
                  {write && <th>Faol</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} style={t.is_active ? undefined : { opacity: 0.55 }}>
                    <td>{t.category}</td>
                    <td>{t.name}</td>
                    <td className="n">{Number(t.price) ? <b>{money(t.price)}</b> : <span className="pill warn">narx yo'q</span>}</td>
                    <td className="mono">{t.price_from ? fmtDate(t.price_from) : ''}</td>
                    <td>
                      <button className="btn ghost sm" onClick={() => setOpen(t)}>
                        {write ? 'Narx o\'zgartirish' : 'Narx tarixi'}
                      </button>
                    </td>
                    {write && (
                      <td>
                        <input type="checkbox" checked={t.is_active} aria-label={`${t.name} faol`} onChange={(e) => patch.mutate({ id: t.id, is_active: e.target.checked })} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {open && <PriceModal t={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ---------- Vedomost ----------
export function HrPayrollPage() {
  const [dept, setDept] = useState('');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useQuery({
    queryKey: ['hr', 'payroll', dept, from, to],
    queryFn: () => api<Payroll>(`/hr/payroll?from=${from}&to=${to}${dept ? `&department_id=${dept}` : ''}`),
    enabled: !!from && !!to,
  });
  const d = q.data;
  const cols = [
    ['opening', 'Davr boshi'],
    ['salary', 'Oylik (tabel)'],
    ['piece', 'Ishbay'],
    ['bonus', 'Bonus'],
    ['other', 'Boshqa'],
    ['penalty', 'Ushlab qolish'],
    ['accrued', 'Nachisleniya'],
    ['cash', 'Avans'],
    ['bank', 'Bank'],
    ['closing', 'Qoldiq'],
  ] as const;
  const depts = [...new Set((d?.rows ?? []).map((r) => r.department_name))];
  return (
    <>
      <PageHead title="Vedomost" sub="Nachisleniya va to'lovlar: davr boshi + oylik + ishbay + bonus − ushlab qolish − avans − bank = qoldiq" />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <DeptSelect value={dept} onChange={setDept} all />
          <Field label="Sanadan">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Sanagacha">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <ErrorText error={q.error} />
        {!d?.rows.length ? (
          <p className="note">Yozuv yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1500 }}>
              <thead>
                <tr>
                  <th>№</th>
                  <th>Xodim</th>
                  <th>Lavozim</th>
                  <th className="n">Kuni</th>
                  <th className="n">Soati</th>
                  {cols.map(([k, l]) => (
                    <th key={k} className="n">
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {depts.map((dn) => (
                  <Fragment key={dn}>
                    {depts.length > 1 && (
                      <tr>
                        <th colSpan={5 + cols.length} scope="rowgroup">
                          {dn}
                        </th>
                      </tr>
                    )}
                    {d.rows
                      .filter((r) => r.department_name === dn)
                      .map((r, i) => (
                        <tr key={r.employee_id}>
                          <td className="mono">{i + 1}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <Link to={`/hr/xodim/${r.employee_id}`}>{r.full_name}</Link>
                            {r.fired_on && <span className="note"> · bo'shatilgan</span>}
                          </td>
                          <td>{r.position ?? ''}</td>
                          <td className="n">
                            {r.days}
                            {r.absent_days ? <span className="note"> / {r.absent_days}K</span> : ''}
                          </td>
                          <td className="n">{Number(r.hours) ? fmtNum(r.hours, 1) : ''}</td>
                          {cols.map(([k]) => (
                            <td key={k} className="n">
                              {k === 'closing' || k === 'accrued' ? <b>{money(r[k])}</b> : Number(r[k]) ? money(r[k]) : ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                  </Fragment>
                ))}
                <tr>
                  <td />
                  <td colSpan={4}>
                    <b>Jami</b>
                  </td>
                  {cols.map(([k]) => (
                    <td key={k} className="n">
                      <b>{money(d.totals[k])}</b>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------- Bonus va to'lovlar ----------
const KIND: Record<AdjKind, string> = { bonus: 'Bonus', penalty: 'Ushlab qolish (jarima)', other: 'Boshqa hisoblash' };
const METHOD = { naqd: 'Avans (naqd)', bank: 'Bank orqali' };

function EmployeeSelect({ value, onChange, employees }: { value: string; onChange: (v: string) => void; employees: Employee[] | undefined }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— xodim —</option>
      {(employees ?? []).map((e) => (
        <option key={e.id} value={e.id}>
          {e.full_name} — {e.department_name}
        </option>
      ))}
    </select>
  );
}

export function HrMoneyPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useHrInvalidate();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [a, setA] = useState({ adj_date: today(), employee_id: '', kind: 'bonus' as AdjKind, amount: '', note: '' });
  const [p, setP] = useState({ pay_date: today(), employee_id: '', method: 'naqd' as 'naqd' | 'bank', amount: '', note: '' });
  const emps = useQuery({ queryKey: ['hr', 'employees', 'all'], queryFn: () => api<Employee[]>('/hr/employees?status=all') });
  const qs = `from=${from}&to=${to}`;
  const adj = useQuery({ queryKey: ['hr', 'adjustments', qs], queryFn: () => api<HrAdjustment[]>(`/hr/adjustments?${qs}`) });
  const pays = useQuery({ queryKey: ['hr', 'payments', qs], queryFn: () => api<HrPayment[]>(`/hr/payments?${qs}`) });
  const addA = useMutation({
    mutationFn: () => api('/hr/adjustments', { method: 'POST', body: { ...a, employee_id: Number(a.employee_id), amount: num(a.amount) } }),
    onSuccess: () => {
      inv();
      setA({ ...a, amount: '', note: '' });
      toast('Saqlandi');
    },
  });
  const addP = useMutation({
    mutationFn: () => api('/hr/payments', { method: 'POST', body: { ...p, employee_id: Number(p.employee_id), amount: num(p.amount) } }),
    onSuccess: () => {
      inv();
      setP({ ...p, amount: '', note: '' });
      toast('To\'lov saqlandi');
    },
  });
  const del = useMutation({
    mutationFn: (path: string) => api(path, { method: 'DELETE' }),
    onSuccess: () => inv(),
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  if (!me) return null;
  const write = can.hrWrite(me.role);
  const pay = can.hrPay(me.role);
  const sum = (rows: { amount: string }[] | undefined) => (rows ?? []).reduce((s, r) => s + Number(r.amount), 0);
  return (
    <>
      <PageHead title="Bonus va to'lovlar" sub="Bonus, ushlab qolish (nachisleniyaga qo'shiladi / ayriladi) va xodimga to'lovlar (avans, bank)" />
      {(write || pay) && (
        <div className="cards" style={{ marginBottom: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          {write && (
            <div className="card">
              <h2>Bonus / ushlab qolish</h2>
              <div className="form">
                <Field label="Sana">
                  <input type="date" value={a.adj_date} onChange={(e) => setA({ ...a, adj_date: e.target.value })} />
                </Field>
                <Field label="Xodim">
                  <EmployeeSelect value={a.employee_id} onChange={(v) => setA({ ...a, employee_id: v })} employees={emps.data?.filter((e) => !e.fired_on)} />
                </Field>
                <Field label="Turi">
                  <select value={a.kind} onChange={(e) => setA({ ...a, kind: e.target.value as AdjKind })}>
                    {Object.entries(KIND).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Summa, so'm">
                  <input className="num" inputMode="decimal" value={a.amount} onChange={(e) => setA({ ...a, amount: e.target.value })} />
                </Field>
                <Field label={a.kind === 'bonus' ? 'Izoh' : 'Izoh (sababi)'}>
                  <input value={a.note} onChange={(e) => setA({ ...a, note: e.target.value })} />
                </Field>
              </div>
              <SubmitBar msg={null} error={addA.error} pending={addA.isPending} onSubmit={() => a.employee_id && num(a.amount) > 0 && addA.mutate()} />
            </div>
          )}
          {pay && (
            <div className="card">
              <h2>To'lov xodimga</h2>
              <div className="form">
                <Field label="Sana">
                  <input type="date" value={p.pay_date} onChange={(e) => setP({ ...p, pay_date: e.target.value })} />
                </Field>
                <Field label="Xodim">
                  <EmployeeSelect value={p.employee_id} onChange={(v) => setP({ ...p, employee_id: v })} employees={emps.data} />
                </Field>
                <Field label="Usul">
                  <select value={p.method} onChange={(e) => setP({ ...p, method: e.target.value as 'naqd' | 'bank' })}>
                    <option value="naqd">{METHOD.naqd}</option>
                    <option value="bank">{METHOD.bank}</option>
                  </select>
                </Field>
                <Field label="Summa, so'm">
                  <input className="num" inputMode="decimal" value={p.amount} onChange={(e) => setP({ ...p, amount: e.target.value })} />
                </Field>
                <Field label="Izoh">
                  <input value={p.note} onChange={(e) => setP({ ...p, note: e.target.value })} />
                </Field>
              </div>
              <SubmitBar msg={null} error={addP.error} pending={addP.isPending} onSubmit={() => p.employee_id && num(p.amount) > 0 && addP.mutate()} />
            </div>
          )}
        </div>
      )}
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <Field label="Sanadan">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Sanagacha">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <ErrorText error={adj.error ?? pays.error ?? del.error} />
        <h2>Bonus va ushlab qolish · {money(sum(adj.data?.filter((x) => x.kind !== 'penalty')))} / −{money(sum(adj.data?.filter((x) => x.kind === 'penalty')))}</h2>
        {!adj.data?.length ? (
          <p className="note" style={{ marginBottom: 14 }}>
            Yo'q.
          </p>
        ) : (
          <div className="tw" style={{ marginBottom: 14 }}>
            <table>
              <thead>
                <tr>
                  <th>Sana</th>
                  <th>Xodim</th>
                  <th>Bo'lim</th>
                  <th>Turi</th>
                  <th className="n">Summa</th>
                  <th>Izoh</th>
                  <th>Kiritgan</th>
                  {write && <th />}
                </tr>
              </thead>
              <tbody>
                {adj.data.map((x) => (
                  <tr key={x.id}>
                    <td className="mono">{fmtDate(x.adj_date)}</td>
                    <td>{x.full_name}</td>
                    <td>{x.department_name}</td>
                    <td>{x.kind === 'penalty' ? <span className="pill bad">{KIND[x.kind]}</span> : KIND[x.kind]}</td>
                    <td className="n">{money(x.amount)}</td>
                    <td>{x.note ?? ''}</td>
                    <td>{x.created_by_name ?? ''}</td>
                    {write && (
                      <td>
                        <button className="x" aria-label="O'chirish" disabled={del.isPending} onClick={() => confirm('O\'chirilsinmi?') && del.mutate(`/hr/adjustments/${x.id}`)}>
                          ✕
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h2>To'lovlar · {money(sum(pays.data))}</h2>
        {!pays.data?.length ? (
          <p className="note">Yo'q.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Sana</th>
                  <th>Xodim</th>
                  <th>Bo'lim</th>
                  <th>Usul</th>
                  <th className="n">Summa</th>
                  <th>Izoh</th>
                  <th>Kiritgan</th>
                  {pay && <th />}
                </tr>
              </thead>
              <tbody>
                {pays.data.map((x) => (
                  <tr key={x.id}>
                    <td className="mono">{fmtDate(x.pay_date)}</td>
                    <td>{x.full_name}</td>
                    <td>{x.department_name}</td>
                    <td>{METHOD[x.method]}</td>
                    <td className="n">{money(x.amount)}</td>
                    <td>{x.note ?? ''}</td>
                    <td>{x.created_by_name ?? ''}</td>
                    {pay && (
                      <td>
                        <button className="x" aria-label="O'chirish" disabled={del.isPending} onClick={() => confirm('To\'lov o\'chirilsinmi?') && del.mutate(`/hr/payments/${x.id}`)}>
                          ✕
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
