import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import { CURRENCIES, can, type Destination, type Producer, type StockExpense, type StockItem, type StockKind, type StockMove, type Supplier } from '../types';
import { cur, money, num, plain } from './purchaseUi';

/** Xomashyo skladi sahifalari uchun umumiy qismlar (Sheets "Xomashyo Sklad") */
export const today = () => new Date().toISOString().slice(0, 10);

export const itemKey = (i: Pick<StockItem, 'material_id' | 'material_color_id' | 'color_code' | 'material_size'>) =>
  [i.material_id, i.material_color_id ?? '', i.color_code ?? '', i.material_size ?? ''].join('|');
export const itemLabel = (i: StockItem) =>
  [i.material_name, i.material_code, i.material_color_name, i.color_code && `kod ${i.color_code}`, i.material_size].filter(Boolean).join(' · ');
/** Serverga yuboriladigan kalit maydonlari */
export const itemRef = (i: StockItem) => ({
  material_id: i.material_id,
  material_color_id: i.material_color_id,
  color_code: i.color_code,
  material_size: i.material_size,
});

/** Xomashyo nomi, kodi, rangi, rang kodi, razmeri — Sheets'dagi 5 ustun */
export function ItemCells({ i }: { i: StockItem }) {
  return (
    <>
      <td>
        <b>{i.material_name}</b>
      </td>
      <td className="mono">{i.material_code ?? ''}</td>
      <td>{i.material_color_name ?? ''}</td>
      <td className="mono">{i.color_code ?? ''}</td>
      <td className="mono">{i.material_size ?? ''}</td>
    </>
  );
}
export const ITEM_HEADS = ['Xomashyo nomi', 'Xomashyo kodi', 'Xomashyo rangi', 'Rang kodi', 'Razmeri'];

export const KIND_LABEL: Record<StockKind, string> = {
  prixod_taminot: "Prixod (Ta'minot orqali)",
  prixod: 'Prixod',
  rasxod_zayavka: 'Rasxod (Zayavka)',
  rasxod: 'Rasxod',
  sotuv: 'Sotuv',
};
export const OP_LABEL: Record<string, string> = { prixod: 'Prixod', vozvrat: 'Vozvrat', peremesheniya: 'Peremesheniya', sotuv: 'Sotuv' };

// ---------- Qayergaligi: Kroy / korxona (tsex) / Boshqa ----------
export const destValue = (d: Destination | null | undefined, producerId?: number | null) =>
  d === 'producer' ? `p:${producerId}` : d ?? '';
export const destParse = (v: string): { destination: Destination | null; producer_id: number | null } =>
  v.startsWith('p:') ? { destination: 'producer', producer_id: Number(v.slice(2)) } : { destination: (v || null) as Destination | null, producer_id: null };
export const destLabel = (m: { destination: Destination | null; producer_name: string | null }) =>
  m.destination === 'kroy' ? 'Kroy' : m.destination === 'other' ? 'Boshqa' : m.producer_name ?? '';

export function DestSelect({ value, onChange, producers, disabled, label = 'Qayergaligi' }: { value: string; onChange: (v: string) => void; producers: Producer[] | undefined; disabled?: boolean; label?: string }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">— tanlang —</option>
      <option value="kroy">Kroy (bichuv)</option>
      {producers
        ?.filter((p) => p.is_active || value === `p:${p.id}`)
        .map((p) => (
          <option key={p.id} value={`p:${p.id}`}>
            {p.name}
          </option>
        ))}
      <option value="other">Boshqa</option>
    </select>
  );
}

// ---------- Qo'shimcha xarajatlar (Kargo, Bojxona, Boshqa) ----------
export interface ExpRow {
  category: string;
  supplier_id: string;
  amount: string;
  currency: string;
  rate: string;
}
export const expRows = (cats: string[]): ExpRow[] => cats.map((category) => ({ category, supplier_id: '', amount: '', currency: 'UZS', rate: '' }));
const expUzs = (e: ExpRow) => (e.currency === 'UZS' ? num(e.amount) : num(e.amount) * num(e.rate));
/** Sheets "Natija": kontragent, summa, valyuta (so'm bo'lmasa kurs) to'liq bo'lishi kerak */
const expBad = (e: ExpRow) => (e.supplier_id || e.amount ? !e.supplier_id || !(num(e.amount) > 0) || (e.currency !== 'UZS' && !(num(e.rate) > 0)) : false);
export const expTotal = (rows: ExpRow[]) => rows.filter((e) => !expBad(e) && e.supplier_id).reduce((a, e) => a + expUzs(e), 0);
export const expError = (rows: ExpRow[]) => {
  const b = rows.find(expBad);
  return b ? `${b.category}: kontragent, summa${b.currency !== 'UZS' ? ' va kurs' : ''} kiritilishi kerak` : null;
};
export const expBody = (rows: ExpRow[]) =>
  rows
    .filter((e) => e.supplier_id && num(e.amount) > 0)
    .map((e) => ({ category: e.category, supplier_id: Number(e.supplier_id), amount: num(e.amount), currency: e.currency, rate: e.currency === 'UZS' ? null : num(e.rate) }));

export function ExpensesEditor({ rows, onChange, categories, suppliers, disabled }: { rows: ExpRow[]; onChange: (r: ExpRow[]) => void; categories: string[]; suppliers: Supplier[] | undefined; disabled?: boolean }) {
  const set = (i: number, patch: Partial<ExpRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="tw">
      <table className="sheet" style={{ minWidth: 760 }}>
        <thead>
          <tr>
            <th>Xarajat kategoriyasi</th>
            <th>Kontragent nomi</th>
            <th className="n">Summa</th>
            <th>Valyuta</th>
            <th className="n">Kurs</th>
            <th className="n">Summa so'm</th>
            <th>Natija</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => (
            <tr key={i} className={expBad(e) ? 'bad-row' : ''}>
              <td>
                <select value={e.category} disabled={disabled} onChange={(x) => set(i, { category: x.target.value })} aria-label="Xarajat kategoriyasi">
                  {[...new Set([...categories, e.category])].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </td>
              <td>
                <select value={e.supplier_id} disabled={disabled} onChange={(x) => set(i, { supplier_id: x.target.value })} aria-label="Kontragent">
                  <option value="">—</option>
                  {suppliers
                    ?.filter((s) => s.is_active || String(s.id) === e.supplier_id)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </td>
              <td className="n">
                <input className="cell num" inputMode="decimal" value={e.amount} disabled={disabled} onChange={(x) => set(i, { amount: x.target.value })} aria-label="Summa" />
              </td>
              <td>
                <select value={e.currency} disabled={disabled} onChange={(x) => set(i, { currency: x.target.value })} aria-label="Valyuta">
                  {Object.entries(CURRENCIES).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </td>
              <td className="n">
                {e.currency === 'UZS' ? '' : <input className="cell num" inputMode="decimal" value={e.rate} disabled={disabled} onChange={(x) => set(i, { rate: x.target.value })} aria-label="Kurs" />}
              </td>
              <td className="n">{e.amount && Number.isFinite(expUzs(e)) ? money(expUzs(e)) : ''}</td>
              <td>{expBad(e) ? <span className="pill bad">X</span> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Baza (jurnal) ----------
export function useStockInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['stock'] });
}

export function DeleteDoc({ id }: { id: number }) {
  const toast = useToast();
  const inv = useStockInvalidate();
  const m = useMutation({
    mutationFn: () => api(`/stock/docs/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      inv();
      toast(`Hujjat №${id} o'chirildi`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  return (
    <button className="x" title="Hujjatni o'chirish" aria-label={`Hujjat ${id} ni o'chirish`} disabled={m.isPending} onClick={() => confirm(`Hujjat №${id} (barcha qatorlari) o'chirilsinmi?`) && m.mutate()}>
      ✕
    </button>
  );
}

/** Sheets'dagi o'ng tomondagi "baza" jadvali: kiritilgan qatorlar */
export function MovesJournal({ kind, title = 'Kiritilganlar (baza)' }: { kind: StockKind; title?: string }) {
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['stock', 'moves', kind], queryFn: () => api<StockMove[]>(`/stock/moves?kind=${kind}&limit=300`) });
  const prixod = kind === 'prixod_taminot' || kind === 'prixod';
  const write = !!me && can.stockWrite(me.role);
  let lastDoc = 0;
  return (
    <div className="card">
      <h2>{title}</h2>
      <ErrorText error={q.error} />
      {!q.data?.length ? (
        <p className="note">Hali yozuv yo'q.</p>
      ) : (
        <div className="sheet-wrap">
          <table className="sheet" style={{ minWidth: prixod ? 1900 : 1500 }}>
            <thead>
              <tr>
                <th>Kiritilgan sana</th>
                <th>Sana</th>
                <th>Tartib raqam</th>
                {ITEM_HEADS.map((h) => (
                  <th key={h}>{h}</th>
                ))}
                {kind === 'prixod_taminot' && <th className="n">Yuborilgan</th>}
                <th className="n">Miqdor</th>
                <th className="n">Narxi</th>
                {prixod && <th>Valyuta</th>}
                {prixod && <th className="n">Kurs</th>}
                <th className="n">Summa so'm</th>
                {prixod && <th className="n">Qo'shimcha</th>}
                {prixod && <th className="n">Jami</th>}
                {kind === 'sotuv' && <th className="n">Tannarx</th>}
                <th>{prixod ? 'Kontragent' : kind === 'sotuv' ? 'Qayergaligi (mijoz)' : 'Qayergaligi'}</th>
                <th>Operatsiya</th>
                <th>Zakaz raqami</th>
                <th>Kiritdi</th>
                {write && <th />}
              </tr>
            </thead>
            <tbody>
              {q.data.map((m) => {
                const first = m.doc_id !== lastDoc;
                lastDoc = m.doc_id;
                return (
                  <tr key={m.id}>
                    <td className="mono">{fmtDateTime(m.created_at)}</td>
                    <td className="mono">{fmtDate(m.doc_date)}</td>
                    <td className="mono">{m.doc_id}</td>
                    <ItemCells i={m} />
                    {kind === 'prixod_taminot' && <td className="n">{m.sent_qty == null ? '' : fmtNum(m.sent_qty)}</td>}
                    <td className="n">
                      {m.dir < 0 && kind !== 'rasxod_zayavka' && kind !== 'rasxod' && kind !== 'sotuv' ? '−' : ''}
                      {fmtNum(m.qty)} <span className="note">{m.unit}</span>
                    </td>
                    <td className="n">{plain(m.price)}</td>
                    {prixod && <td>{cur(m.currency)}</td>}
                    {prixod && <td className="n">{m.currency === 'UZS' ? '' : plain(m.rate)}</td>}
                    <td className="n">{money(m.amount_uzs)}</td>
                    {prixod && <td className="n">{Number(m.extra_uzs) ? money(m.extra_uzs) : ''}</td>}
                    {prixod && <td className="n">{money(m.cost_uzs)}</td>}
                    {kind === 'sotuv' && <td className="n">{money(m.cost_uzs)}</td>}
                    <td>{prixod || kind === 'sotuv' ? m.counterparty ?? '' : destLabel(m)}</td>
                    <td>{OP_LABEL[m.op]}</td>
                    <td className="mono">{m.partiya_no ?? ''}</td>
                    <td>{m.created_by_name ?? ''}</td>
                    {write && <td>{first && <DeleteDoc id={m.doc_id} />}</td>}
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

export function ExpensesJournal({ kind }: { kind: StockKind }) {
  const q = useQuery({ queryKey: ['stock', 'expenses', kind], queryFn: () => api<StockExpense[]>(`/stock/expenses?kind=${kind}&limit=300`) });
  if (!q.data?.length) return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>Qo'shimcha xarajatlar (baza)</h2>
      <div className="tw">
        <table className="sheet" style={{ minWidth: 900 }}>
          <thead>
            <tr>
              <th>Kiritilgan sana</th>
              <th>Sana</th>
              <th>Tartib raqam</th>
              <th>Xarajat kategoriyasi</th>
              <th>Kontragent nomi</th>
              <th className="n">Summa</th>
              <th>Valyuta</th>
              <th className="n">Kurs</th>
              <th className="n">Summa so'm</th>
              <th>Zakaz raqami</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((e) => (
              <tr key={e.id}>
                <td className="mono">{fmtDateTime(e.created_at)}</td>
                <td className="mono">{fmtDate(e.doc_date)}</td>
                <td className="mono">{e.doc_id}</td>
                <td>{e.category}</td>
                <td>{e.supplier_name}</td>
                <td className="n">{money(e.amount)}</td>
                <td>{cur(e.currency)}</td>
                <td className="n">{e.currency === 'UZS' ? '' : plain(e.rate)}</td>
                <td className="n">{money(e.amount_uzs)}</td>
                <td className="mono">{e.partiya_no ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Sahifa ostidagi xato / tasdiq qatori */
export function SubmitBar({ msg, error, pending, onSubmit, label = 'SAQLASH', children }: { msg: string | null; error: unknown; pending: boolean; onSubmit: () => void; label?: string; children?: React.ReactNode }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
      <span className="note">{children}</span>
      <div className="row">
        {msg && (
          <span className="err" role="alert">
            {msg}
          </span>
        )}
        <ErrorText error={error} />
        <button className="btn" disabled={pending} onClick={onSubmit}>
          {label}
        </button>
      </div>
    </div>
  );
}
