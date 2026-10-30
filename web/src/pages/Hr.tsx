import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Modal, PageHead, fmtDate, fmtNum, useToast } from '../components/ui';
import { can, type Employee, type EmployeeDetail, type EmployeeStatement, type HrDepartment, type Producer } from '../types';
import { useCatalog } from './Orders';
import { money, num } from './purchaseUi';
import { today } from './stockUi';

/** HR — Sheets "HR Istam Ishlab chiqarish Ko'ylak / Shim" o'rniga: xodimlar, kartochka, bo'limlar */
export const useHrInvalidate = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['hr'] });
};
export const useDepartments = () => useQuery({ queryKey: ['hr', 'departments'], queryFn: () => api<HrDepartment[]>('/hr/departments') });
export const useEmployees = (deptId: string, on?: string) =>
  useQuery({
    queryKey: ['hr', 'employees', deptId, on ?? ''],
    queryFn: () => api<Employee[]>(`/hr/employees?status=active${deptId ? `&department_id=${deptId}` : ''}${on ? `&on=${on}` : ''}`),
  });
export const monthStart = () => `${today().slice(0, 8)}01`;

export function DeptSelect({ value, onChange, all = false, label = 'Bo\'lim' }: { value: string; onChange: (v: string) => void; all?: boolean; label?: string }) {
  const d = useDepartments();
  // bitta bo'lim tanlanishi shart bo'lsa — birinchisi avtomatik
  useEffect(() => {
    if (!all && !value && d.data?.length) onChange(String(d.data.find((x) => x.is_active)?.id ?? d.data[0].id));
  }, [all, value, d.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="f">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {all && <option value="">Hammasi</option>}
        {(d.data ?? [])
          .filter((x) => x.is_active || String(x.id) === value)
          .map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
      </select>
    </label>
  );
}

const MODE = { full: "To'liq ish kuni", part: "To'liqsiz ish kuni" };
const POSITIONS = ['Tikuvchi', 'Dazmollovchi', 'Sifat tekshiruvchi (OTK)', 'Belgilovchi', 'Mahsulot tozalovchi', 'Qõl mehnati', 'Averlokchi', 'Presslovchi', 'Qadoqlovchi', 'Tsex boshligʻi', 'Brigadir (yordamchi)', 'Oddiy ishchi'];

// ---------- Xodim qo'shish / tahrirlash ----------
function EmployeeForm({ e, onDone }: { e?: Employee; onDone: () => void }) {
  const toast = useToast();
  const inv = useHrInvalidate();
  const [f, setF] = useState({
    full_name: e?.full_name ?? '',
    department_id: e ? String(e.department_id) : '',
    brigade: e?.brigade ?? '',
    position: e?.position ?? '',
    schedule: e?.schedule ?? '',
    work_mode: e?.work_mode ?? 'full',
    gender: e?.gender ?? '',
    phone: e?.phone ?? '',
    hired_on: e?.hired_on ?? today(),
    note: e?.note ?? '',
    salary: '',
    norm_hours: '208',
  });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { ...f, department_id: Number(f.department_id), gender: f.gender || null };
      delete body.salary;
      delete body.norm_hours;
      if (!e && f.salary.trim()) body.salary = { amount: num(f.salary), norm_hours: num(f.norm_hours) };
      return api<Employee>(e ? `/hr/employees/${e.id}` : '/hr/employees', { method: e ? 'PATCH' : 'POST', body });
    },
    onSuccess: (r) => {
      inv();
      toast(e ? 'Saqlandi' : `${r.full_name} ishga qabul qilindi`);
      onDone();
    },
  });
  return (
    <>
      <div className="form" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        <Field label="FISH">
          <input value={f.full_name} onChange={(x) => set({ full_name: x.target.value.toUpperCase() })} autoFocus />
        </Field>
        <DeptSelect value={f.department_id} onChange={(v) => set({ department_id: v })} />
        <Field label="Brigada">
          <input value={f.brigade} list="hr-brigades" onChange={(x) => set({ brigade: x.target.value })} />
        </Field>
        <Field label="Lavozim">
          <input value={f.position} list="hr-positions" onChange={(x) => set({ position: x.target.value })} />
        </Field>
        <Field label="Ish rejimi">
          <select value={f.work_mode} onChange={(x) => set({ work_mode: x.target.value as 'full' | 'part' })}>
            <option value="full">{MODE.full}</option>
            <option value="part">{MODE.part}</option>
          </select>
        </Field>
        <Field label="Ish grafigi">
          <input value={f.schedule} placeholder="Du–Sha 8:00 - 17:00" onChange={(x) => set({ schedule: x.target.value })} />
        </Field>
        <Field label="Jinsi">
          <select value={f.gender} onChange={(x) => set({ gender: x.target.value as '' })}>
            <option value="">—</option>
            <option value="ayol">Ayol</option>
            <option value="erkak">Erkak</option>
          </select>
        </Field>
        <Field label="Telefon">
          <input value={f.phone} inputMode="tel" onChange={(x) => set({ phone: x.target.value })} />
        </Field>
        <Field label="Ishga qabul sanasi">
          <input type="date" value={f.hired_on} onChange={(x) => set({ hired_on: x.target.value })} />
        </Field>
        {!e && (
          <>
            <Field label="Oylik, so'm (ishbay bo'lsa — bo'sh)">
              <input className="num" inputMode="decimal" value={f.salary} onChange={(x) => set({ salary: x.target.value })} />
            </Field>
            {f.salary.trim() !== '' && (
              <Field label="Bir oylik ish soati">
                <input className="num" inputMode="decimal" value={f.norm_hours} onChange={(x) => set({ norm_hours: x.target.value })} />
              </Field>
            )}
          </>
        )}
        <Field label="Izoh">
          <input value={f.note} onChange={(x) => set({ note: x.target.value })} />
        </Field>
      </div>
      <datalist id="hr-positions">
        {POSITIONS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <datalist id="hr-brigades">
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={`${n}-Brigada`} />
        ))}
      </datalist>
      {!e && f.salary.trim() !== '' && num(f.salary) > 0 && num(f.norm_hours) > 0 && (
        <p className="note">Soatlik stavka: {money(num(f.salary) / num(f.norm_hours))} so'm — tabeldagi har soat shu stavkada hisoblanadi.</p>
      )}
      <ErrorText error={m.error} />
      <div className="actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn" disabled={m.isPending || f.full_name.trim().length < 2 || !f.department_id || !f.hired_on} onClick={() => m.mutate()}>
          {e ? 'Saqlash' : 'Ishga qabul qilish'}
        </button>
      </div>
    </>
  );
}

function FireModal({ e, onClose }: { e: Employee; onClose: () => void }) {
  const toast = useToast();
  const inv = useHrInvalidate();
  const [d, setD] = useState(today());
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/hr/employees/${e.id}/fire`, { method: 'POST', body: { fired_on: d, reason } }),
    onSuccess: () => {
      inv();
      toast(`${e.full_name} ishdan bo'shatildi`);
      onClose();
    },
  });
  return (
    <Modal title={`Ishdan bo'shatish — ${e.full_name}`} onClose={onClose}>
      <div className="form one">
        <Field label="Ishdan bo'shash sanasi">
          <input type="date" value={d} min={e.hired_on} onChange={(x) => setD(x.target.value)} />
        </Field>
        <Field label="Sababi">
          <input value={reason} onChange={(x) => setReason(x.target.value)} />
        </Field>
      </div>
      <ErrorText error={m.error} />
      <div className="actions">
        <button className="btn" disabled={m.isPending || !d} onClick={() => m.mutate()}>
          Bo'shatish
        </button>
      </div>
    </Modal>
  );
}

// ---------- Xodimlar ----------
export function HrEmployeesPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useHrInvalidate();
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState<'active' | 'fired' | 'all'>('active');
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Employee | 'new' | null>(null);
  const [fire, setFire] = useState<Employee | null>(null);
  const q = useQuery({
    queryKey: ['hr', 'employees', 'list', dept, status],
    queryFn: () => api<Employee[]>(`/hr/employees?status=${status}${dept ? `&department_id=${dept}` : ''}`),
  });
  const restore = useMutation({
    mutationFn: (e: Employee) => api(`/hr/employees/${e.id}/restore`, { method: 'POST' }),
    onSuccess: () => {
      inv();
      toast('Xodim qayta tiklandi');
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  if (!me) return null;
  const write = can.hrWrite(me.role);
  const read = can.hrRead(me.role);
  const rows = (q.data ?? []).filter((e) => !search || e.full_name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <PageHead title="Xodimlar" sub="Ishga qabul qilish va bo'shatish, lavozim, brigada, ish rejimi">
        {write && (
          <button className="btn" onClick={() => setEdit('new')}>
            + Ishga qabul qilish
          </button>
        )}
      </PageHead>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <DeptSelect value={dept} onChange={setDept} all />
          <Field label="Holat">
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="active">Ishlayotganlar</option>
              <option value="fired">Bo'shatilganlar</option>
              <option value="all">Hammasi</option>
            </select>
          </Field>
          <Field label="Qidirish">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="FISH" />
          </Field>
          <div className="f">
            Soni
            <b>{rows.length}</b>
          </div>
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">Xodim yo'q.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>№</th>
                  <th>FISH</th>
                  <th>Lavozim</th>
                  <th>Bo'lim</th>
                  <th>Brigada</th>
                  <th>Ish rejimi</th>
                  <th>Qabul</th>
                  <th>Bo'shatilgan</th>
                  {write && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((e, i) => (
                  <tr key={e.id}>
                    <td className="mono">{i + 1}</td>
                    <td>{read ? <Link to={`/hr/xodim/${e.id}`}>{e.full_name}</Link> : e.full_name}</td>
                    <td>{e.position ?? ''}</td>
                    <td>{e.department_name}</td>
                    <td>{e.brigade ?? ''}</td>
                    <td>{MODE[e.work_mode]}</td>
                    <td className="mono">{fmtDate(e.hired_on)}</td>
                    <td>{e.fired_on ? `${fmtDate(e.fired_on)}${e.fire_reason ? ` · ${e.fire_reason}` : ''}` : ''}</td>
                    {write && (
                      <td>
                        <div className="row" style={{ flexWrap: 'nowrap' }}>
                          <button className="btn ghost sm" onClick={() => setEdit(e)}>
                            Tahrirlash
                          </button>
                          {e.fired_on ? (
                            <button className="btn ghost sm" disabled={restore.isPending} onClick={() => confirm(`${e.full_name} qayta tiklansinmi?`) && restore.mutate(e)}>
                              Tiklash
                            </button>
                          ) : (
                            <button className="btn ghost sm" onClick={() => setFire(e)}>
                              Bo'shatish
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <DepartmentsCard write={write} />
      {edit && (
        <Modal title={edit === 'new' ? 'Ishga qabul qilish' : edit.full_name} onClose={() => setEdit(null)}>
          <EmployeeForm e={edit === 'new' ? undefined : edit} onDone={() => setEdit(null)} />
        </Modal>
      )}
      {fire && <FireModal e={fire} onClose={() => setFire(null)} />}
    </>
  );
}

function DepartmentsCard({ write }: { write: boolean }) {
  const toast = useToast();
  const inv = useHrInvalidate();
  const d = useDepartments();
  const producers = useCatalog<Producer>('producers');
  const [name, setName] = useState('');
  const [producer, setProducer] = useState('');
  const add = useMutation({
    mutationFn: () => api('/hr/departments', { method: 'POST', body: { name, producer_id: producer ? Number(producer) : null } }),
    onSuccess: () => {
      inv();
      setName('');
      setProducer('');
      toast('Bo\'lim qo\'shildi');
    },
  });
  const patch = useMutation({
    mutationFn: (b: { id: number; body: object }) => api(`/hr/departments/${b.id}`, { method: 'PATCH', body: b.body }),
    onSuccess: () => inv(),
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  return (
    <div className="card">
      <h2>Bo'limlar (fabrikalar)</h2>
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>Bo'lim</th>
              <th>Ishlab chiqarishdagi tsex</th>
              <th className="n">Xodimlar</th>
              <th>Holat</th>
            </tr>
          </thead>
          <tbody>
            {(d.data ?? []).map((x) => (
              <tr key={x.id}>
                <td>
                  <b>{x.name}</b>
                </td>
                <td>
                  {write ? (
                    <select value={x.producer_id ?? ''} aria-label={`${x.name} tsexi`} onChange={(e) => patch.mutate({ id: x.id, body: { producer_id: e.target.value ? Number(e.target.value) : null } })}>
                      <option value="">—</option>
                      {(producers.data ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    x.producer_name ?? '—'
                  )}
                </td>
                <td className="n">{fmtNum(x.employees)}</td>
                <td>
                  {write ? (
                    <label className="row">
                      <input type="checkbox" checked={x.is_active} onChange={(e) => patch.mutate({ id: x.id, body: { is_active: e.target.checked } })} /> faol
                    </label>
                  ) : x.is_active ? (
                    'faol'
                  ) : (
                    'nofaol'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {write && (
        <div className="row" style={{ marginTop: 10 }}>
          <input placeholder="Yangi bo'lim nomi" value={name} onChange={(e) => setName(e.target.value)} aria-label="Yangi bo'lim nomi" />
          <select value={producer} onChange={(e) => setProducer(e.target.value)} aria-label="Tsex">
            <option value="">Tsex — ixtiyoriy</option>
            {(producers.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={!name.trim() || add.isPending} onClick={() => add.mutate()}>
            Qo'shish
          </button>
          <ErrorText error={add.error} />
        </div>
      )}
    </div>
  );
}

// ---------- Xodim kartochkasi ----------
export function HrEmployeePage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useHrInvalidate();
  const id = Number(useParams().id);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [sal, setSal] = useState({ valid_from: today(), amount: '', norm_hours: '208' });
  const e = useQuery({ queryKey: ['hr', 'employee', id], queryFn: () => api<EmployeeDetail>(`/hr/employees/${id}`) });
  const st = useQuery({
    queryKey: ['hr', 'statement', id, from, to],
    queryFn: () => api<EmployeeStatement>(`/hr/employees/${id}/statement?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
  const addSal = useMutation({
    mutationFn: () => api(`/hr/employees/${id}/salaries`, { method: 'POST', body: { valid_from: sal.valid_from, amount: num(sal.amount), norm_hours: num(sal.norm_hours) } }),
    onSuccess: () => {
      inv();
      setSal({ ...sal, amount: '' });
      toast('Oylik saqlandi');
    },
  });
  const delSal = useMutation({
    mutationFn: (sid: number) => api(`/hr/employees/${id}/salaries/${sid}`, { method: 'DELETE' }),
    onSuccess: () => inv(),
    onError: (x) => toast(x instanceof Error ? x.message : String(x)),
  });
  if (!me) return null;
  if (e.error) return <ErrorText error={e.error} />;
  const x = e.data;
  if (!x) return null;
  const write = can.hrWrite(me.role);
  const s = st.data;
  return (
    <>
      <PageHead title={x.full_name} sub={[x.position, x.department_name, x.brigade, x.fired_on && `bo'shatilgan ${fmtDate(x.fired_on)}`].filter(Boolean).join(' · ')}>
        <Link className="btn ghost" to="/hr/xodimlar">
          Xodimlar
        </Link>
      </PageHead>
      <div className="card" style={{ marginBottom: 14 }}>
        <dl className="kv">
          <dt>Ishga qabul</dt>
          <dd>{fmtDate(x.hired_on)}</dd>
          <dt>Ish rejimi</dt>
          <dd>
            {MODE[x.work_mode]}
            {x.schedule ? ` · ${x.schedule}` : ''}
          </dd>
          <dt>Telefon</dt>
          <dd>{x.phone ?? '—'}</dd>
          {x.note && (
            <>
              <dt>Izoh</dt>
              <dd>{x.note}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Oylik maosh (sanadan amal qiladi)</h2>
        {!x.salaries.length ? (
          <p className="note">Oylik yo'q — faqat ishbay (ish nazorati) bo'yicha hisoblanadi.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Sanadan</th>
                  <th className="n">Oylik</th>
                  <th className="n">Oylik ish soati</th>
                  <th className="n">Soatlik stavka</th>
                  <th>Kiritgan</th>
                  {write && <th />}
                </tr>
              </thead>
              <tbody>
                {x.salaries.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{fmtDate(r.valid_from)}</td>
                    <td className="n">{money(r.amount)}</td>
                    <td className="n">{fmtNum(r.norm_hours, 2)}</td>
                    <td className="n">{money(r.hourly)}</td>
                    <td>{r.created_by_name ?? ''}</td>
                    {write && (
                      <td>
                        <button className="x" aria-label="O'chirish" disabled={delSal.isPending} onClick={() => confirm('Oylik yozuvi o\'chirilsinmi?') && delSal.mutate(r.id)}>
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
        {write && (
          <div className="row" style={{ marginTop: 10 }}>
            <input type="date" value={sal.valid_from} onChange={(v) => setSal({ ...sal, valid_from: v.target.value })} aria-label="Sanadan" />
            <input className="num" inputMode="decimal" placeholder="Oylik, so'm" value={sal.amount} onChange={(v) => setSal({ ...sal, amount: v.target.value })} aria-label="Oylik" />
            <input className="num" inputMode="decimal" value={sal.norm_hours} onChange={(v) => setSal({ ...sal, norm_hours: v.target.value })} aria-label="Oylik ish soati" title="Bir oylik ish soati" />
            <button className="btn sm" disabled={addSal.isPending || !(num(sal.amount) >= 0) || !sal.amount.trim() || !(num(sal.norm_hours) > 0)} onClick={() => addSal.mutate()}>
              Oylik o'zgartirish
            </button>
            <ErrorText error={addSal.error} />
          </div>
        )}
      </div>

      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <Field label="Sanadan">
            <input type="date" value={from} onChange={(v) => setFrom(v.target.value)} />
          </Field>
          <Field label="Sanagacha">
            <input type="date" value={to} onChange={(v) => setTo(v.target.value)} />
          </Field>
        </div>
        <ErrorText error={st.error} />
        {s && (
          <>
            <div className="cards" style={{ marginBottom: 14 }}>
              <div className="card stat">
                <span className="note">Kelgan / kelmagan kuni</span>
                <b>
                  {s.attendance.days} / {s.attendance.absent_days}
                </b>
                <span className="note">ishlagan soati: {fmtNum(s.attendance.hours, 1)}</span>
              </div>
              <div className="card stat">
                <span className="note">Davr boshi</span>
                <b>{money(s.opening)}</b>
              </div>
              <div className="card stat">
                <span className="note">Nachisleniya</span>
                <b>{money(s.totals.accrued)}</b>
                <span className="note">
                  oylik {money(s.totals.salary)} · ishbay {money(s.totals.piece)} · bonus {money(s.totals.bonus)}
                  {Number(s.totals.penalty) ? ` · ushlab qolish −${money(s.totals.penalty)}` : ''}
                </span>
              </div>
              <div className="card stat">
                <span className="note">To'langan</span>
                <b>{money(Number(s.totals.cash) + Number(s.totals.bank))}</b>
                <span className="note">
                  avans {money(s.totals.cash)} · bank {money(s.totals.bank)}
                </span>
              </div>
              <div className="card stat">
                <span className="note">Qoldiq (haqdorlik)</span>
                <b>{money(s.totals.closing)}</b>
              </div>
            </div>
            {s.works.length > 0 && (
              <>
                <h2>Ish turlari</h2>
                <div className="tw" style={{ marginBottom: 14 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>№</th>
                        <th>Kategoriya</th>
                        <th>Ish turi</th>
                        <th className="n">Soni</th>
                        <th className="n">Narxi</th>
                        <th className="n">Summasi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.works.map((w, i) => (
                        <tr key={`${w.work_name}:${w.price}`}>
                          <td className="mono">{i + 1}</td>
                          <td>{w.category}</td>
                          <td>{w.work_name}</td>
                          <td className="n">{fmtNum(w.qty)}</td>
                          <td className="n">{Number(w.price) ? money(w.price) : <span className="pill warn">narx yo'q</span>}</td>
                          <td className="n">{money(w.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <h2>Akt sverka</h2>
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>Sana</th>
                    <th className="n">Oylik</th>
                    <th className="n">Ishbay</th>
                    <th className="n">Bonus</th>
                    <th className="n">Ushlab qolish</th>
                    <th className="n">Hisoblangan</th>
                    <th className="n">Avans</th>
                    <th className="n">Bank</th>
                    <th className="n">Qoldiq</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="mono">{fmtDate(from)}</td>
                    <td colSpan={7}>Davr boshiga qoldiq</td>
                    <td className="n">
                      <b>{money(s.opening)}</b>
                    </td>
                  </tr>
                  {s.rows.map((r) => (
                    <tr key={r.date}>
                      <td className="mono">{fmtDate(r.date)}</td>
                      {(['salary', 'piece', 'bonus', 'penalty', 'accrued', 'cash', 'bank'] as const).map((k) => (
                        <td key={k} className="n">
                          {Number(r[k]) ? money(r[k]) : ''}
                        </td>
                      ))}
                      <td className="n">
                        <b>{money(r.balance)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
