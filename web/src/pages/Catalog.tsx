import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Modal, PageHead, fmtDate, fmtNum, useToast } from '../components/ui';
import { can, CURRENCIES, type CurrencyRate, type Supplier } from '../types';

type Row = Record<string, unknown> & { id: number; is_active: boolean };

interface FieldSpec {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'select';
  required?: boolean;
  /** select uchun: statik yoki boshqa ma'lumotnomadan */
  options?: [string, string][];
  optionsFrom?: string;
}
interface Spec {
  path: string;
  title: string;
  hint?: string;
  fields: FieldSpec[];
  /** Jadvalda ko'rsatiladigan ustunlar (field key yoki qo'shimcha) */
  columns: [string, string][];
}

const UNITS: [string, string][] = ['Dona', 'Metr', 'Kg', 'Pachka', 'Rulon', 'Juft'].map((u) => [u, u]);

export const CATALOGS: Spec[] = [
  {
    path: 'colors',
    title: 'Ranglar',
    hint: 'Tayyor mahsulot va xomashyo ranglari.',
    fields: [
      { key: 'name', label: 'Nomi', required: true },
      { key: 'code', label: 'Rang kodi' },
    ],
    columns: [['name', 'Nomi'], ['code', 'Rang kodi']],
  },
  {
    path: 'sizes',
    title: 'Razmerlar',
    hint: 'Tartib raqami jadvaldagi joylashuvni belgilaydi (kichigi oldinda).',
    fields: [
      { key: 'name', label: 'Razmer (masalan 3--6)', required: true },
      { key: 'sort', label: 'Tartib', type: 'number' },
    ],
    columns: [['name', 'Razmer'], ['sort', 'Tartib']],
  },
  {
    path: 'product-types',
    title: 'Tovar turlari',
    fields: [
      { key: 'name', label: 'Nomi', required: true },
      { key: 'unit', label: 'O\'lchov birligi', type: 'select', options: UNITS },
    ],
    columns: [['name', 'Nomi'], ['unit', 'O\'lchov birligi']],
  },
  {
    path: 'materials',
    title: 'Xomashyolar',
    hint: 'Postavshik — odatiy yetkazib beruvchi; zakazda boshqasini tanlash mumkin.',
    fields: [
      { key: 'name', label: 'Nomi', required: true },
      { key: 'code', label: 'Kodi' },
      { key: 'unit', label: 'O\'lchov birligi', type: 'select', options: UNITS },
      { key: 'supplier_id', label: 'Postavshik', type: 'select', optionsFrom: 'suppliers' },
    ],
    columns: [['name', 'Nomi'], ['code', 'Kodi'], ['unit', 'Birlik'], ['supplier_name', 'Postavshik']],
  },
  {
    path: 'suppliers',
    title: 'Postavshiklar',
    fields: [
      { key: 'name', label: 'Nomi', required: true },
      { key: 'country', label: 'Davlat' },
      { key: 'phone', label: 'Telefon' },
      { key: 'note', label: 'Izoh' },
    ],
    columns: [['name', 'Nomi'], ['country', 'Davlat'], ['phone', 'Telefon'], ['note', 'Izoh']],
  },
  {
    path: 'producers',
    title: 'Korxonalar',
    hint: 'Kroy, o\'z tsexlari va tashqi tikuvchilar (podryadchik). Zakazda "qaysi korxonaga" va ish narxlari uchun.',
    fields: [
      { key: 'name', label: 'Nomi', required: true },
      { key: 'kind', label: 'Turi', type: 'select', options: [['own', 'O\'z tsexi'], ['contractor', 'Podryadchik']], required: true },
      { key: 'note', label: 'Izoh' },
    ],
    columns: [['name', 'Nomi'], ['kind', 'Turi'], ['note', 'Izoh']],
  },
];

const KIND: Record<string, string> = { own: 'O\'z tsexi', contractor: 'Podryadchik' };
const show = (key: string, v: unknown) => (key === 'kind' ? KIND[String(v)] : v == null || v === '' ? '—' : String(v));

function EditModal({ spec, row, onClose }: { spec: Spec; row: Row | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const suppliers = useQuery({
    queryKey: ['catalog', 'suppliers'],
    queryFn: () => api<Supplier[]>('/suppliers'),
    enabled: spec.fields.some((f) => f.optionsFrom === 'suppliers'),
  });
  const [f, setF] = useState<Record<string, string>>(() =>
    Object.fromEntries(spec.fields.map((x) => [x.key, row?.[x.key] == null ? (x.options && x.required ? x.options[0][0] : '') : String(row[x.key])])),
  );
  const [active, setActive] = useState(row?.is_active ?? true);
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      for (const x of spec.fields) {
        const v = f[x.key].trim();
        body[x.key] = v === '' ? null : x.type === 'number' || x.optionsFrom ? Number(v) : v;
      }
      if (row) body.is_active = active;
      return api(row ? `/${spec.path}/${row.id}` : `/${spec.path}`, { method: row ? 'PATCH' : 'POST', body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['catalog', spec.path] });
      toast('Saqlandi');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Modal title={`${spec.title}: ${row ? 'tahrirlash' : 'yangi'}`} onClose={onClose}>
      <form className="form one" onSubmit={submit}>
        <div className="form">
          {spec.fields.map((x) => (
            <Field key={x.key} label={x.label}>
              {x.type === 'select' ? (
                <select value={f[x.key]} required={x.required} onChange={(e) => setF({ ...f, [x.key]: e.target.value })}>
                  {!x.required && <option value="">—</option>}
                  {(x.options ?? (suppliers.data ?? []).filter((s) => s.is_active || String(s.id) === f[x.key]).map((s) => [String(s.id), s.name])).map(
                    ([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ),
                  )}
                </select>
              ) : (
                <input
                  value={f[x.key]}
                  required={x.required}
                  inputMode={x.type === 'number' ? 'numeric' : undefined}
                  autoFocus={x === spec.fields[0]}
                  onChange={(e) => setF({ ...f, [x.key]: e.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
        {row && (
          <label className="chk">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Faol (ro'yxatlarda chiqadi)
          </label>
        )}
        <ErrorText error={m.error} />
        <div className="actions">
          <button className="btn" disabled={m.isPending}>
            Saqlash
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CatalogTable({ spec }: { spec: Spec }) {
  const { me } = useAuth();
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const [q, setQ] = useState('');
  const rows = useQuery({ queryKey: ['catalog', spec.path], queryFn: () => api<Row[]>(`/${spec.path}`) });
  const writable = !!me && can.catalogWrite(me.role);
  const ql = q.trim().toLowerCase();
  const list = (rows.data ?? []).filter((r) => !ql || spec.columns.some(([k]) => String(r[k] ?? '').toLowerCase().includes(ql)));
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <input placeholder="Qidirish" aria-label="Qidirish" value={q} onChange={(e) => setQ(e.target.value)} />
        {writable && (
          <button className="btn" onClick={() => setEdit('new')}>
            Qo'shish
          </button>
        )}
      </div>
      {spec.hint && <p className="note">{spec.hint}</p>}
      <ErrorText error={rows.error} />
      <div className="tw">
        <table>
          <thead>
            <tr>
              {spec.columns.map(([, l]) => (
                <th key={l}>{l}</th>
              ))}
              <th>Holat</th>
              {writable && <th />}
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} style={{ opacity: r.is_active ? 1 : 0.55 }}>
                {spec.columns.map(([k]) => (
                  <td key={k}>{show(k, r[k])}</td>
                ))}
                <td>{r.is_active ? <span className="pill good">Faol</span> : <span className="pill muted">O'chirilgan</span>}</td>
                {writable && (
                  <td>
                    <button className="btn ghost sm" onClick={() => setEdit(r)}>
                      Tahrirlash
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.data && !list.length && <p className="note">Ro'yxat bo'sh.</p>}
      {edit && <EditModal spec={spec} row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function RatesTab() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const rates = useQuery({ queryKey: ['catalog', 'currency-rates'], queryFn: () => api<CurrencyRate[]>('/currency-rates') });
  const [f, setF] = useState({ currency: 'USD', rate: '', valid_from: new Date().toISOString().slice(0, 10) });
  const m = useMutation({
    mutationFn: () => api('/currency-rates', { method: 'POST', body: { ...f, rate: f.rate.replace(/\s/g, '').replace(',', '.') } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['catalog', 'currency-rates'] });
      toast('Kurs saqlandi');
      setF({ ...f, rate: '' });
    },
  });
  return (
    <div className="card">
      {me && can.ratesWrite(me.role) && (
        <form
          className="form"
          style={{ marginBottom: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <Field label="Valyuta">
            <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
              {Object.entries(CURRENCIES)
                .filter(([k]) => k !== 'UZS')
                .map(([k, l]) => (
                  <option key={k} value={k}>
                    {l} ({k})
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Kurs (1 birlik = so'm)">
            <input value={f.rate} inputMode="decimal" required onChange={(e) => setF({ ...f, rate: e.target.value })} />
          </Field>
          <Field label="Qachondan">
            <input type="date" value={f.valid_from} required onChange={(e) => setF({ ...f, valid_from: e.target.value })} />
          </Field>
          <button className="btn" disabled={m.isPending}>
            Saqlash
          </button>
        </form>
      )}
      <ErrorText error={m.error ?? rates.error} />
      <p className="note">Zakazdagi xomashyo narxi zakaz sanasidagi kurs bo'yicha so'mga o'giriladi (qatorda kursni qo'lda ham o'zgartirish mumkin).</p>
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>Valyuta</th>
              <th className="n">Kurs</th>
              <th>Qachondan</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rates.data?.map((r) => (
              <tr key={r.id}>
                <td>
                  {CURRENCIES[r.currency]} ({r.currency})
                </td>
                <td className="n">{fmtNum(r.rate, 2)}</td>
                <td className="mono">{fmtDate(r.valid_from)}</td>
                <td>{r.is_current && <span className="pill good">Amalda</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CatalogPage() {
  const [tab, setTab] = useState(CATALOGS[0].path);
  const spec = CATALOGS.find((c) => c.path === tab);
  return (
    <>
      <PageHead title="Ma'lumotnomalar" sub="Ro'yxatdan tanlanadi — bir xil nom har xil yozilmaydi" />
      <div className="tabs" role="tablist">
        {CATALOGS.map((c) => (
          <button key={c.path} role="tab" aria-selected={tab === c.path} className={tab === c.path ? 'on' : ''} onClick={() => setTab(c.path)}>
            {c.title}
          </button>
        ))}
        <button role="tab" aria-selected={tab === 'rates'} className={tab === 'rates' ? 'on' : ''} onClick={() => setTab('rates')}>
          Valyuta kurslari
        </button>
      </div>
      {spec ? <CatalogTable key={spec.path} spec={spec} /> : <RatesTab />}
    </>
  );
}
