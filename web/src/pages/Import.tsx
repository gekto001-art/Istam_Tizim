import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { ErrorText, Field, PageHead, fmtDateTime, fmtNum, useToast } from '../components/ui';
import { DeptSelect } from './Hr';

/** Google Sheets'dan import: jadvaldan sarlavhasi bilan nusxalab (Ctrl+C) shu yerga joylashtiriladi */
type Kind = 'employees' | 'salaries' | 'work_types' | 'cash';
type Result = {
  saved: boolean;
  rows: number;
  header_row: number;
  created: number;
  updated: number;
  skipped: number;
  error_count: number;
  errors: { row: number; message: string }[];
  warnings: string[];
  batch_id: number | null;
};
type Batch = { id: number; kind: Kind; kind_label: string; label: string | null; rows_total: number; created: number; cash_rows: number; created_by_name: string | null; created_at: string };

const KINDS: Record<Kind, { label: string; how: string; dept?: 'required' | 'fallback' }> = {
  employees: {
    label: 'Xodimlar',
    how: "HR jadvali → «Qabul/Bo'shatish baza» (yoki «Ishchilar») varag'i. Kerakli ustunlar: ФИО, Дата приёма; qo'shimcha: Должность, График работы, Пол, Подразделения (bo'lim), Субподраделения (brigada), Тип / Дата уволнения (bo'shatish). Mavjud xodim (ism + bo'lim) qayta yaratilmaydi.",
    dept: 'fallback',
  },
  salaries: {
    label: 'Oyliklar',
    how: "HR jadvali → «Oyliklar» varag'i: Sana, FIO, Bir oylik ish soati, Oylik. Xodim ismi bo'yicha topiladi; topilmasa va bo'lim tanlangan bo'lsa — shu bo'limda yaratiladi.",
    dept: 'fallback',
  },
  work_types: {
    label: 'Ish turlari va narxlar',
    how: "HR jadvali → «Ish Turi» (yoki «Narxlar») varag'i: Sana, Kategoriyalar, Ishlar nomi, Ish narxi. Narx shu sanadan amal qiladi. Bo'limni tanlang (Ko'ylak yoki Shim).",
    dept: 'required',
  },
  cash: {
    label: 'Kassa yozuvlari',
    how: "Kassa jadvali → «Kassa Baza» (yoki HR jadvalidagi «Kassa Ish/Ch», «Kassa Tijorat»...) varag'i: Sana, Hamyon, Tranzaksiya, Markaz, Xarajat elementlari, Kontragent, Bo'lim, Ma'sul shaxs, Detal/Izoh, Valyuta turi, Valyuta kurs, Kirim, Chiqim, Oylar, Partiya №. Yangi hamyonlar tanlangan bo'limga yaratiladi. Bitta xato qator bo'lsa ham hech narsa saqlanmaydi; import partiyasi bilan bekor qilinadi.",
  },
};

/** Katta matn — brauzerda gzip bilan siqiladi (tashqi nginx 1 MB chegarasi) */
async function pack(text: string): Promise<{ text?: string; gz?: string }> {
  if (typeof CompressionStream === 'undefined' || text.length < 200_000) return { text };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { gz: btoa(bin) };
}

export function ImportPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>('employees');
  const [dept, setDept] = useState('');
  const [business, setBusiness] = useState<'moliya' | 'tijorat' | 'ishlab'>('moliya');
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [checked, setChecked] = useState<{ key: string; r: Result } | null>(null);
  const batches = useQuery({ queryKey: ['import', 'batches'], queryFn: () => api<Batch[]>('/import/batches') });
  const key = JSON.stringify([kind, dept, business, text.length, text.slice(0, 200), text.slice(-200)]);
  const run = useMutation({
    mutationFn: async (dry: boolean) =>
      api<Result>(`/import/${kind}`, {
        method: 'POST',
        body: { ...(await pack(text)), dry_run: dry, department_id: dept ? Number(dept) : null, business, label: label || undefined },
      }),
    onSuccess: (r) => {
      if (r.saved) {
        qc.invalidateQueries();
        toast(`Import qilindi: ${r.created} ta yaratildi, ${r.updated} ta yangilandi`);
        setChecked(null);
        setText('');
      } else setChecked({ key, r });
    },
  });
  const spec = KINDS[kind];
  const lines = text ? text.split('\n').filter((l) => l.trim()).length : 0;
  const res = checked?.key === key ? checked.r : null;
  const shown = run.data && run.data.saved ? run.data : res;
  const canSave = !!res && !res.saved && (kind !== 'cash' || res.error_count === 0) && res.created + res.updated > 0;
  const undo = useMutation({
    mutationFn: (id: number) => api<{ deleted: number }>(`/import/batches/${id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast(`Import bekor qilindi: ${r.deleted} ta kassa yozuvi o'chirildi`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  return (
    <>
      <PageHead title="Sheets'dan import" sub="Jadvaldan sarlavhasi bilan nusxalab joylashtiring → Tekshirish → Import" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <Field label="Nima import qilinadi">
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {Object.entries(KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
          {spec.dept && <DeptSelect value={dept} onChange={setDept} all={spec.dept === 'fallback'} label={spec.dept === 'required' ? "Bo'lim" : "Bo'lim (ustunda bo'lmasa)"} />}
          {kind === 'cash' && (
            <>
              <Field label="Yangi hamyonlar qaysi bo'limga">
                <select value={business} onChange={(e) => setBusiness(e.target.value as typeof business)}>
                  <option value="moliya">Moliya bo'limi</option>
                  <option value="tijorat">Tijorat (Sotuv) bo'limi</option>
                  <option value="ishlab">Ishlab chiqarish</option>
                </select>
              </Field>
              <Field label="Nom (masalan: Kassa Baza, noyabr)">
                <input value={label} onChange={(e) => setLabel(e.target.value)} />
              </Field>
            </>
          )}
        </div>
        <p className="note" style={{ marginBottom: 8 }}>
          {spec.how}
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Google Sheets'da kerakli ustunlarni (sarlavha qatori bilan) belgilab Ctrl+C, shu yerga Ctrl+V"
          aria-label="Jadvaldan nusxalangan matn"
          spellCheck={false}
          style={{ width: '100%', minHeight: 220, fontFamily: 'var(--f-mono)', fontSize: 12, whiteSpace: 'pre', boxSizing: 'border-box' }}
        />
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <span className="note">{lines ? `${fmtNum(lines)} qator (sarlavha bilan)` : ''}</span>
          <div className="row">
            <ErrorText error={run.error} />
            <button className="btn ghost" disabled={!text.trim() || run.isPending || (spec.dept === 'required' && !dept)} onClick={() => run.mutate(true)}>
              {run.isPending && !canSave ? 'Tekshirilmoqda…' : 'Tekshirish'}
            </button>
            <button className="btn" disabled={!canSave || run.isPending} onClick={() => confirm('Import qilinsinmi?') && run.mutate(false)}>
              Import qilish
            </button>
          </div>
        </div>
        {shown && (
          <div style={{ marginTop: 14 }}>
            <div className="cards" style={{ marginBottom: 10 }}>
              <div className="card stat">
                <span className="note">{shown.saved ? 'Saqlandi' : 'Tekshiruv natijasi (saqlanmadi)'}</span>
                <b>{fmtNum(shown.rows)} qator</b>
                <span className="note">sarlavha: {shown.header_row}-qator</span>
              </div>
              <div className="card stat">
                <span className="note">Yaratiladi / yangilanadi</span>
                <b>
                  {fmtNum(shown.created)} / {fmtNum(shown.updated)}
                </b>
                <span className="note">o'tkazib yuborildi (bor yoki bo'sh): {fmtNum(shown.skipped)}</span>
              </div>
              <div className="card stat">
                <span className="note">Xatolar</span>
                <b className={shown.error_count ? 'err' : ''}>{fmtNum(shown.error_count)}</b>
                {kind === 'cash' && shown.error_count > 0 && <span className="note">kassa — xatolar tuzatilmaguncha saqlanmaydi</span>}
              </div>
            </div>
            {shown.warnings.length > 0 && (
              <div className="card warn-box" role="status" style={{ marginBottom: 10 }}>
                {shown.warnings.slice(0, 30).map((w) => (
                  <div key={w}>⚠ {w}</div>
                ))}
                {shown.warnings.length > 30 && <div>… yana {shown.warnings.length - 30} ta</div>}
              </div>
            )}
            {shown.errors.length > 0 && (
              <div className="tw">
                <table>
                  <thead>
                    <tr>
                      <th>Jadval qatori</th>
                      <th>Xato</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.errors.map((e) => (
                      <tr key={`${e.row}:${e.message}`}>
                        <td className="mono">{e.row}</td>
                        <td>{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {shown.error_count > shown.errors.length && <p className="note">… jami {shown.error_count} ta xato</p>}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="card">
        <h2>Importlar tarixi</h2>
        <ErrorText error={batches.error} />
        {!batches.data?.length ? (
          <p className="note">Hali yo'q.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>№</th>
                  <th>Vaqt</th>
                  <th>Turi</th>
                  <th>Nom</th>
                  <th className="n">Qatorlar</th>
                  <th className="n">Yaratildi</th>
                  <th>Kim</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {batches.data.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.id}</td>
                    <td className="mono">{fmtDateTime(b.created_at)}</td>
                    <td>{b.kind_label}</td>
                    <td>{b.label ?? ''}</td>
                    <td className="n">{fmtNum(b.rows_total)}</td>
                    <td className="n">{fmtNum(b.kind === 'cash' ? b.cash_rows : b.created)}</td>
                    <td>{b.created_by_name ?? ''}</td>
                    <td>
                      {b.kind === 'cash' && (
                        <button className="btn ghost sm" disabled={undo.isPending} onClick={() => confirm(`Import №${b.id} bekor qilinsinmi? ${b.cash_rows} ta kassa yozuvi o'chadi.`) && undo.mutate(b.id)}>
                          Bekor qilish
                        </button>
                      )}
                    </td>
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
