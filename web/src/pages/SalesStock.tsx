import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Modal, PageHead, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import {
  can,
  type BillzShop,
  type PayMethod,
  type SalesBillzCompare,
  type SalesDoc,
  type SalesDocKind,
  type SalesMove,
  type SalesMoveKind,
  type SalesProduct,
  type SalesStock,
  type SalesSupplier,
  type SalesSupplierLedger,
} from '../types';
import { WalletSelect, useMeta } from './Cash';
import { money, num } from './purchaseUi';
import { SubmitBar, today } from './stockUi';

/** Sotuv bo'limi skladi: ishlab chiqarishdan va boshqa postavshiklardan kelgan tovar, do'konlarga jo'natish, Billz bilan solishtirish */
const KIND: Record<SalesMoveKind, string> = {
  transfer: 'Ishlab chiqarishdan',
  purchase: 'Postavshikdan prixod',
  shop: 'Do\'konga jo\'natish',
  shop_return: 'Do\'kondan qaytish',
  adjust: 'Inventarizatsiya',
};
const METHOD: Record<PayMethod, string> = { naqd: 'Naqd', plastik: 'Plastik', bank: 'Bank (o\'tkazma)' };
const label = (p: Pick<SalesProduct, 'partiya_no' | 'name' | 'artikul' | 'color_name' | 'size_name' | 'sort'>) =>
  [p.partiya_no && `P-${p.partiya_no}`, p.name, p.artikul, p.color_name, p.size_name, p.sort && `${p.sort} sort`].filter(Boolean).join(' · ');

function useSalesInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['sales'] });
    qc.invalidateQueries({ queryKey: ['stock', 'sales'] });
  };
}
const useStock = (qs = 'only=all') => useQuery({ queryKey: ['sales', 'stock', qs], queryFn: () => api<SalesStock>(`/sales/sklad/stock?${qs}`) });
const useSuppliers = () => useQuery({ queryKey: ['sales', 'suppliers'], queryFn: () => api<SalesSupplier[]>('/sales/sklad/suppliers') });

function SourcePill({ source }: { source: 'own' | 'other' }) {
  return source === 'own' ? <span className="pill good">o'zimiz</span> : <span className="pill muted">postavshik</span>;
}

// ---------- Qoldiq ----------
function Moves({ id }: { id: number }) {
  const q = useQuery({ queryKey: ['sales', 'moves', id], queryFn: () => api<{ moves: SalesMove[] }>(`/sales/sklad/products/${id}/moves`) });
  if (q.error) return <ErrorText error={q.error} />;
  if (!q.data) return <p className="note">Yuklanmoqda…</p>;
  return (
    <div className="tw">
      <table>
        <thead>
          <tr>
            <th>Sana</th>
            <th>Harakat</th>
            <th>Qayerdan / qayerga</th>
            <th className="n">Kirim</th>
            <th className="n">Chiqim</th>
            <th className="n">Qoldiq</th>
            <th className="n">Narx</th>
            <th>Izoh</th>
            <th>Kim</th>
          </tr>
        </thead>
        <tbody>
          {q.data.moves.map((m) => (
            <tr key={m.id}>
              <td className="mono">{fmtDate(m.move_date)}</td>
              <td>{KIND[m.kind]}</td>
              <td>{m.transfer_id ? `O'tkazma №${m.transfer_id}` : m.supplier_name ?? m.shop_name ?? (m.doc_id ? `Hujjat №${m.doc_id}` : '')}</td>
              <td className="n">{m.dir === 1 ? fmtNum(m.qty) : ''}</td>
              <td className="n">{m.dir === -1 ? fmtNum(m.qty) : ''}</td>
              <td className="n">{fmtNum(m.balance)}</td>
              <td className="n">{money(m.unit_cost)}</td>
              <td>{m.note ?? ''}</td>
              <td>{m.created_by_name ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductModal({ p, onClose }: { p: SalesProduct | null; onClose: () => void }) {
  const toast = useToast();
  const inv = useSalesInvalidate();
  const suppliers = useSuppliers();
  const own = p?.source === 'own';
  const [f, setF] = useState({
    name: p?.name ?? '',
    artikul: p?.artikul ?? '',
    color_name: p?.color_name ?? '',
    size_name: p?.size_name ?? '',
    barcode: p?.barcode ?? '',
    supplier_id: p?.supplier_id ? String(p.supplier_id) : '',
    is_active: p?.is_active ?? true,
  });
  const save = useMutation({
    mutationFn: () => {
      const base = { barcode: f.barcode, is_active: f.is_active };
      const full = { ...base, name: f.name, artikul: f.artikul, color_name: f.color_name, size_name: f.size_name, supplier_id: f.supplier_id ? Number(f.supplier_id) : null };
      return p ? api(`/sales/sklad/products/${p.id}`, { method: 'PUT', body: own ? base : full }) : api('/sales/sklad/products', { method: 'POST', body: full });
    },
    onSuccess: () => {
      inv();
      toast(p ? 'Tovar saqlandi' : 'Tovar qo\'shildi');
      onClose();
    },
  });
  return (
    <Modal title={p ? label(p) : 'Yangi tovar (postavshikdan)'} onClose={onClose}>
      <div className="form one">
        {!own && (
          <>
            <Field label="Nomi">
              <input value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label="Artikul">
              <input value={f.artikul} maxLength={100} onChange={(e) => setF({ ...f, artikul: e.target.value })} />
            </Field>
            <Field label="Rang">
              <input value={f.color_name} maxLength={100} onChange={(e) => setF({ ...f, color_name: e.target.value })} />
            </Field>
            <Field label="Razmer">
              <input value={f.size_name} maxLength={50} onChange={(e) => setF({ ...f, size_name: e.target.value })} />
            </Field>
            <Field label="Postavshik">
              <select value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}>
                <option value="">—</option>
                {suppliers.data?.filter((s) => s.is_active || String(s.id) === f.supplier_id).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        <Field label="Barcode (Billz bilan solishtirish uchun)">
          <input className="mono" value={f.barcode} maxLength={64} onChange={(e) => setF({ ...f, barcode: e.target.value })} />
        </Field>
        {p && (
          <label className="row">
            <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Faol (yangi hujjatlarda tanlanadi)
          </label>
        )}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <ErrorText error={save.error} />
        <button className="btn ghost" onClick={onClose}>
          Bekor
        </button>
        <button className="btn" disabled={save.isPending || (!own && !f.name.trim())} onClick={() => save.mutate()}>
          Saqlash
        </button>
      </div>
    </Modal>
  );
}

export function SalesStockPage() {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [source, setSource] = useState<'all' | 'own' | 'other'>('all');
  const [only, setOnly] = useState<'positive' | 'all'>('positive');
  const [open, setOpen] = useState<number | null>(null);
  const [edit, setEdit] = useState<SalesProduct | 'new' | null>(null);
  const qs = new URLSearchParams({ source, only, ...(q.trim() ? { q: q.trim() } : {}) }).toString();
  const s = useStock(qs);
  if (!me) return null;
  const write = can.salesStock(me.role);
  return (
    <>
      <PageHead title="Sotuv bo'limi skladi" sub="Qoldiq: ishlab chiqarishdan (ichki narxda) va postavshiklardan (xarid narxida) kelgan tovar">
        {write && (
          <button className="btn" onClick={() => setEdit('new')}>
            + Tovar (postavshikdan)
          </button>
        )}
      </PageHead>
      {s.data && (
        <div className="cards" style={{ marginBottom: 14 }}>
          <div className="card stat">
            <span className="note">Skladda</span>
            <b>{fmtNum(s.data.totals.qty)} dona</b>
          </div>
          <div className="card stat">
            <span className="note">Summa (Sotuv tannarxida)</span>
            <b>{money(s.data.totals.value)}</b>
          </div>
        </div>
      )}
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <Field label="Qidirish (partiya, nomi, artikul, rang, barcode)">
            <input value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field label="Manba">
            <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
              <option value="all">Hammasi</option>
              <option value="own">O'zimiz ishlab chiqargan</option>
              <option value="other">Postavshiklardan</option>
            </select>
          </Field>
          <Field label="Ko'rsatish">
            <select value={only} onChange={(e) => setOnly(e.target.value as typeof only)}>
              <option value="positive">Faqat qoldig'i borlar</option>
              <option value="all">Hammasi (qoldiq 0 ham)</option>
            </select>
          </Field>
        </div>
        <ErrorText error={s.error} />
        {!s.data?.rows.length ? (
          <p className="note">{s.isLoading ? 'Yuklanmoqda…' : 'Tovar yo\'q.'}</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Manba</th>
                  <th>Partiya</th>
                  <th>Tovar</th>
                  <th>Artikul</th>
                  <th>Rang</th>
                  <th>Razmer</th>
                  <th>Sort</th>
                  <th>Barcode</th>
                  <th className="n">Qoldiq</th>
                  <th className="n">Do'konlarga</th>
                  <th className="n">O'rtacha narx</th>
                  <th className="n">Summa</th>
                  {write && <th />}
                </tr>
              </thead>
              <tbody>
                {s.data.rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr style={{ cursor: 'pointer', opacity: r.is_active ? 1 : 0.55 }} onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <td>
                        <SourcePill source={r.source} />
                      </td>
                      <td className="mono">{r.partiya_no ?? ''}</td>
                      <td>
                        {r.name}
                        {r.supplier_name && <span className="note"> · {r.supplier_name}</span>}
                      </td>
                      <td>{r.artikul ?? ''}</td>
                      <td>{r.color_name ?? ''}</td>
                      <td className="mono">{r.size_name ?? ''}</td>
                      <td>{r.sort ? `${r.sort} sort` : ''}</td>
                      <td className="mono">{r.barcode ?? ''}</td>
                      <td className="n">
                        <b>{fmtNum(r.qty)}</b>
                      </td>
                      <td className="n">{r.to_shops ? fmtNum(r.to_shops) : ''}</td>
                      <td className="n">{money(r.avg_cost)}</td>
                      <td className="n">{money(r.value)}</td>
                      {write && (
                        <td>
                          <button
                            className="btn ghost sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEdit(r);
                            }}
                          >
                            Tahrirlash
                          </button>
                        </td>
                      )}
                    </tr>
                    {open === r.id && (
                      <tr>
                        <td colSpan={write ? 13 : 12}>
                          <Moves id={r.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {edit && <ProductModal p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

// ---------- Hujjatlar: prixod, do'konga jo'natish, qaytish, inventarizatsiya ----------
type Line = { product_id: number; qty: string; price: string };

function DocItems({ d }: { d: SalesDoc }) {
  return (
    <div className="tw">
      <table>
        <thead>
          <tr>
            <th>Tovar</th>
            <th>Barcode</th>
            <th className="n">Soni</th>
            <th className="n">Narx</th>
            <th className="n">Summa</th>
          </tr>
        </thead>
        <tbody>
          {d.items.map((i) => (
            <tr key={i.product_id}>
              <td>{label(i)}</td>
              <td className="mono">{i.barcode ?? ''}</td>
              <td className="n">{fmtNum(i.dir * i.qty)}</td>
              <td className="n">{money(i.unit_cost)}</td>
              <td className="n">{money(i.qty * Number(i.unit_cost))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SalesDocsPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useSalesInvalidate();
  const [kind, setKind] = useState<SalesDocKind>('purchase');
  const [docDate, setDocDate] = useState(today());
  const [supplier, setSupplier] = useState('');
  const [shop, setShop] = useState('');
  const [shopName, setShopName] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [find, setFind] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<SalesDocKind | 'all'>('all');
  const [open, setOpen] = useState<number | null>(null);
  const [newProduct, setNewProduct] = useState(false);
  const stock = useStock();
  const suppliers = useSuppliers();
  const shops = useQuery({ queryKey: ['sales', 'shops'], queryFn: () => api<BillzShop[]>('/sales/sklad/shops') });
  const docs = useQuery({ queryKey: ['sales', 'docs', filter], queryFn: () => api<SalesDoc[]>(`/sales/sklad/docs?kind=${filter}`) });
  const save = useMutation({
    mutationFn: (body: object) => api<SalesDoc>('/sales/sklad/docs', { method: 'POST', body }),
    onSuccess: (d) => {
      inv();
      setLines([]);
      setNote('');
      toast(`${KIND[d.kind]} №${d.id} saqlandi: ${fmtNum(d.qty)} dona`);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/sales/sklad/docs/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => {
      inv();
      toast(`Hujjat №${id} o'chirildi`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  if (!me) return null;
  const write = can.salesStock(me.role);
  const products = new Map((stock.data?.rows ?? []).map((p) => [p.id, p]));
  const usable = (p: SalesProduct) =>
    p.is_active && (kind === 'purchase' ? p.source === 'other' : kind === 'shop' ? p.qty > 0 : true) && !lines.some((l) => l.product_id === p.id);
  const needle = find.trim().toLowerCase();
  const found = needle
    ? (stock.data?.rows ?? []).filter((p) => usable(p) && `${label(p)} ${p.barcode ?? ''} ${p.supplier_name ?? ''}`.toLowerCase().includes(needle)).slice(0, 30)
    : [];
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const lineBad = (l: Line) => {
    const q = num(l.qty);
    const p = products.get(l.product_id);
    if (!Number.isInteger(q) || q === 0 || (kind !== 'adjust' && q < 0)) return true;
    if ((kind === 'shop' || (kind === 'adjust' && q < 0)) && p && Math.abs(q) > p.qty) return true;
    return kind === 'purchase' && !(num(l.price) >= 0);
  };
  const total = lines.reduce((a, l) => a + (lineBad(l) ? 0 : Math.abs(num(l.qty)) * (kind === 'purchase' ? num(l.price) : Number(products.get(l.product_id)?.avg_cost ?? 0))), 0);

  const submit = () => {
    setMsg(null);
    if (!docDate) return setMsg('Sanani kiriting');
    if (kind === 'purchase' && !supplier) return setMsg('Postavshikni tanlang');
    if ((kind === 'shop' || kind === 'shop_return') && !shop && !shopName.trim()) return setMsg('Do\'konni tanlang yoki yozing');
    if (kind === 'adjust' && !note.trim()) return setMsg('Inventarizatsiya sababini izohga yozing');
    if (!lines.length) return setMsg('Tovar qo\'shing');
    const bad = lines.find(lineBad);
    if (bad) return setMsg(`${label(products.get(bad.product_id)!)}: son yoki narx noto'g'ri (skladdagidan ko'p bo'lmasin)`);
    save.mutate({
      kind,
      doc_date: docDate,
      supplier_id: kind === 'purchase' ? Number(supplier) : null,
      shop_id: shop || null,
      shop_name: shop ? null : shopName,
      note,
      rows: lines.map((l) => ({ product_id: l.product_id, qty: num(l.qty), price: kind === 'purchase' ? num(l.price) : null })),
    });
  };

  return (
    <>
      <PageHead title="Sotuv skladi hujjatlari" sub="Postavshikdan prixod, do'konga jo'natish, do'kondan qaytish, inventarizatsiya. Ishlab chiqarishdan kirim — «Prixod (qabul qilish)» sahifasida" />
      {write && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="form" style={{ marginBottom: 12 }}>
            <Field label="Hujjat turi">
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as SalesDocKind);
                  setLines([]);
                }}
              >
                {(['purchase', 'shop', 'shop_return', 'adjust'] as const).map((k) => (
                  <option key={k} value={k}>
                    {KIND[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sana">
              <input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
            </Field>
            {kind === 'purchase' && (
              <Field label="Postavshik">
                <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
                  <option value="">— tanlang —</option>
                  {suppliers.data?.filter((s) => s.is_active).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {(kind === 'shop' || kind === 'shop_return') && (
              <>
                <Field label="Do'kon (Billz)">
                  <select value={shop} onChange={(e) => setShop(e.target.value)}>
                    <option value="">— boshqa (yozing) —</option>
                    {shops.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {!shop && (
                  <Field label="Do'kon nomi">
                    <input value={shopName} maxLength={200} onChange={(e) => setShopName(e.target.value)} />
                  </Field>
                )}
              </>
            )}
            <Field label={kind === 'adjust' ? 'Sabab (izoh)' : 'Izoh'}>
              <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>

          <div className="form" style={{ marginBottom: 8 }}>
            <Field label="Tovar qo'shish (qidirish: partiya, nomi, rang, barcode)">
              <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={kind === 'purchase' ? 'Postavshik tovarlari' : 'Skladdagi tovarlar'} />
            </Field>
            {kind === 'purchase' && (
              <div className="f">
                &nbsp;
                <button className="btn ghost sm" onClick={() => setNewProduct(true)}>
                  + Yangi tovar
                </button>
              </div>
            )}
          </div>
          {found.length > 0 && (
            <div className="row" style={{ marginBottom: 10 }}>
              {found.map((p) => (
                <button
                  key={p.id}
                  className="btn ghost sm"
                  onClick={() => {
                    setLines((ls) => [...ls, { product_id: p.id, qty: '', price: p.avg_cost ? String(Number(p.avg_cost)) : '' }]);
                    setFind('');
                  }}
                >
                  {label(p)} {kind !== 'purchase' && <span className="note">({fmtNum(p.qty)})</span>}
                </button>
              ))}
            </div>
          )}
          {needle && !found.length && <p className="note">Topilmadi{kind === 'purchase' ? ' — «+ Yangi tovar» bilan qo\'shing' : ''}.</p>}

          {lines.length > 0 && (
            <div className="sheet-wrap">
              <table className="sheet" style={{ minWidth: 800 }}>
                <thead>
                  <tr>
                    <th>Tovar</th>
                    <th className="n">Skladda</th>
                    <th className="n">{kind === 'adjust' ? 'Son (+ ortiqcha / − kamomad)' : 'Soni'}</th>
                    {kind === 'purchase' && <th className="n">Narx, so'm</th>}
                    <th className="n">Summa</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const p = products.get(l.product_id);
                    const price = kind === 'purchase' ? num(l.price) : Number(p?.avg_cost ?? 0);
                    return (
                      <tr key={l.product_id} className={l.qty && lineBad(l) ? 'bad-row' : ''}>
                        <td>{p ? label(p) : l.product_id}</td>
                        <td className="n">{fmtNum(p?.qty ?? 0)}</td>
                        <td className="n">
                          <input className="cell num" inputMode="numeric" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} aria-label="Soni" />
                        </td>
                        {kind === 'purchase' && (
                          <td className="n">
                            <input className="cell num" inputMode="decimal" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} aria-label="Narx" />
                          </td>
                        )}
                        <td className="n">{lineBad(l) ? '' : money(Math.abs(num(l.qty)) * price)}</td>
                        <td>
                          <button className="btn ghost sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Qatorni olib tashlash">
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
            Jami: <b>{money(total)} so'm</b>
            {kind === 'purchase' ? ' — postavshik oldidagi qarzga yoziladi.' : kind === 'shop' ? ' — skladdan chiqadi (do\'konda Billz\'ga prixod qilinadi).' : ''}
          </SubmitBar>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2>Hujjatlar</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Hujjat turi">
            <option value="all">Hammasi</option>
            {(['purchase', 'shop', 'shop_return', 'adjust'] as const).map((k) => (
              <option key={k} value={k}>
                {KIND[k]}
              </option>
            ))}
          </select>
        </div>
        <ErrorText error={docs.error} />
        {!docs.data?.length ? (
          <p className="note">Hali yo'q.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>№</th>
                  <th>Sana</th>
                  <th>Turi</th>
                  <th>Postavshik / do'kon</th>
                  <th className="n">Soni</th>
                  <th className="n">Summa</th>
                  <th>Izoh</th>
                  <th>Kim</th>
                  {write && <th />}
                </tr>
              </thead>
              <tbody>
                {docs.data.map((d) => (
                  <Fragment key={d.id}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === d.id ? null : d.id)}>
                      <td className="mono">{d.id}</td>
                      <td className="mono">{fmtDate(d.doc_date)}</td>
                      <td>{KIND[d.kind]}</td>
                      <td>{d.supplier_name ?? d.shop_name ?? ''}</td>
                      <td className="n">{fmtNum(d.kind === 'adjust' ? d.net_qty : d.qty)}</td>
                      <td className="n">{money(d.amount_uzs)}</td>
                      <td>{d.note ?? ''}</td>
                      <td>
                        {d.created_by_name ?? ''} <span className="note">{fmtDateTime(d.created_at)}</span>
                      </td>
                      {write && (
                        <td>
                          <button
                            className="btn ghost sm"
                            disabled={del.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(`${KIND[d.kind]} №${d.id} o'chirilsinmi?`)) del.mutate(d.id);
                            }}
                          >
                            O'chirish
                          </button>
                        </td>
                      )}
                    </tr>
                    {open === d.id && (
                      <tr>
                        <td colSpan={write ? 9 : 8}>
                          <DocItems d={d} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {newProduct && <ProductModal p={null} onClose={() => setNewProduct(false)} />}
    </>
  );
}

// ---------- Postavshiklar: qarz, to'lov, akt sverka ----------
function SupplierModal({ s, onClose }: { s: SalesSupplier | null; onClose: () => void }) {
  const toast = useToast();
  const inv = useSalesInvalidate();
  const [f, setF] = useState({ name: s?.name ?? '', phone: s?.phone ?? '', note: s?.note ?? '', is_active: s?.is_active ?? true });
  const save = useMutation({
    mutationFn: () => (s ? api(`/sales/sklad/suppliers/${s.id}`, { method: 'PUT', body: f }) : api('/sales/sklad/suppliers', { method: 'POST', body: f })),
    onSuccess: () => {
      inv();
      toast('Postavshik saqlandi');
      onClose();
    },
  });
  return (
    <Modal title={s ? s.name : 'Yangi postavshik'} onClose={onClose}>
      <div className="form one">
        <Field label="Nomi">
          <input value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Telefon">
          <input value={f.phone} maxLength={50} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label="Izoh">
          <input value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        {s && (
          <label className="row">
            <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Faol
          </label>
        )}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <ErrorText error={save.error} />
        <button className="btn ghost" onClick={onClose}>
          Bekor
        </button>
        <button className="btn" disabled={save.isPending || !f.name.trim()} onClick={() => save.mutate()}>
          Saqlash
        </button>
      </div>
    </Modal>
  );
}

function SupplierLedger({ s }: { s: SalesSupplier }) {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useSalesInvalidate();
  const qc = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pay, setPay] = useState({ pay_date: today(), amount: '', method: 'naqd' as PayMethod, wallet_id: '', note: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const write = !!me && can.salesPay(me.role);
  const cashMeta = useMeta(write && !!me && can.cashRead(me.role));
  const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
  const q = useQuery({ queryKey: ['sales', 'supplier-ledger', s.id, qs], queryFn: () => api<SalesSupplierLedger>(`/sales/sklad/suppliers/${s.id}/ledger${qs ? `?${qs}` : ''}`) });
  const add = useMutation({
    mutationFn: () =>
      api('/sales/sklad/supplier-payments', {
        method: 'POST',
        body: { supplier_id: s.id, pay_date: pay.pay_date, amount_uzs: num(pay.amount), method: pay.method, wallet_id: pay.wallet_id ? Number(pay.wallet_id) : null, note: pay.note },
      }),
    onSuccess: () => {
      inv();
      qc.invalidateQueries({ queryKey: ['cash'] });
      setPay({ ...pay, amount: '', note: '' });
      toast(`To'lov kiritildi${pay.wallet_id ? ' — kassada chiqim yozildi' : ''}`);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/sales/sklad/supplier-payments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      inv();
      qc.invalidateQueries({ queryKey: ['cash'] });
      toast('To\'lov o\'chirildi');
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  const submit = () => {
    setMsg(null);
    if (!pay.pay_date) return setMsg('Sanani kiriting');
    if (!(num(pay.amount) > 0)) return setMsg('Summani kiriting');
    add.mutate();
  };
  const d = q.data;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>{s.name} — hisob-kitob</h2>
      {write && (
        <>
          <div className="form">
            <Field label="Sana">
              <input type="date" value={pay.pay_date} onChange={(e) => setPay({ ...pay, pay_date: e.target.value })} />
            </Field>
            <Field label="To'lov summasi, so'm">
              <input className="num" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
            </Field>
            <Field label="Usul">
              <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value as PayMethod })}>
                {Object.entries(METHOD).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            {cashMeta.data && (
              <Field label="Qaysi hamyondan (kassaga chiqim)">
                <WalletSelect meta={cashMeta.data} value={pay.wallet_id} onChange={(v) => setPay({ ...pay, wallet_id: v })} label="Hamyon" all="— kassaga yozilmasin —" noAvans />
              </Field>
            )}
            <Field label="Izoh">
              <input value={pay.note} maxLength={500} onChange={(e) => setPay({ ...pay, note: e.target.value })} />
            </Field>
          </div>
          <SubmitBar msg={msg} error={add.error} pending={add.isPending} onSubmit={submit}>
            Hamyon tanlansa — kassada «Tovar xaridi» chiqimi avtomatik yoziladi.
          </SubmitBar>
        </>
      )}
      <div className="form" style={{ margin: '12px 0' }}>
        <Field label="Sanadan">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Sanagacha">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <ErrorText error={q.error} />
      {d && (
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Sana</th>
                <th>Hujjat</th>
                <th>Izoh</th>
                <th className="n">Prixod (qarz)</th>
                <th className="n">To'lov</th>
                <th className="n">Qoldiq qarz</th>
                {write && <th />}
              </tr>
            </thead>
            <tbody>
              {from && (
                <tr>
                  <td colSpan={5}>Davr boshiga</td>
                  <td className="n">{money(d.opening)}</td>
                  {write && <td />}
                </tr>
              )}
              {d.rows.map((r) => (
                <tr key={`${r.kind}:${r.ref_id}`}>
                  <td className="mono">{fmtDate(r.date)}</td>
                  <td>{r.kind === 'purchase' ? `Prixod №${r.ref_id} (${fmtNum(r.qty)} dona)` : `To'lov №${r.ref_id}`}</td>
                  <td>{r.note ?? ''}</td>
                  <td className="n">{Number(r.debit) ? money(r.debit) : ''}</td>
                  <td className="n">{Number(r.credit) ? money(r.credit) : ''}</td>
                  <td className="n">{money(r.balance)}</td>
                  {write && (
                    <td>
                      {r.kind === 'payment' && (
                        <button className="btn ghost sm" disabled={del.isPending} onClick={() => confirm(`To'lov №${r.ref_id} o'chirilsinmi? Kassadagi chiqim ham o'chadi.`) && del.mutate(r.ref_id)}>
                          O'chirish
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              <tr>
                <td colSpan={3}>
                  <b>Jami</b>
                </td>
                <td className="n">
                  <b>{money(d.totals.debit)}</b>
                </td>
                <td className="n">
                  <b>{money(d.totals.credit)}</b>
                </td>
                <td className="n">
                  <b>{money(d.totals.closing)}</b>
                </td>
                {write && <td />}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SalesSuppliersPage() {
  const { me } = useAuth();
  const q = useSuppliers();
  const [edit, setEdit] = useState<SalesSupplier | 'new' | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  if (!me) return null;
  const write = can.salesStock(me.role);
  const debt = (q.data ?? []).reduce((a, s) => a + Number(s.debt), 0);
  const cur = q.data?.find((s) => s.id === sel) ?? null;
  return (
    <>
      <PageHead title="Postavshiklar (Sotuv bo'limi)" sub="Boshqa ishlab chiqaruvchilardan olingan tovar: qarz = prixod − to'lov">
        {write && (
          <button className="btn" onClick={() => setEdit('new')}>
            + Postavshik
          </button>
        )}
      </PageHead>
      <div className="cards" style={{ marginBottom: 14 }}>
        <div className="card stat">
          <span className="note">Postavshiklarga jami qarz</span>
          <b>{money(debt)}</b>
        </div>
      </div>
      <div className="card">
        <ErrorText error={q.error} />
        {!q.data?.length ? (
          <p className="note">Hali yo'q.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Postavshik</th>
                  <th>Telefon</th>
                  <th className="n">Prixod</th>
                  <th className="n">To'langan</th>
                  <th className="n">Qarz</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {q.data.map((s) => (
                  <tr key={s.id} className={sel === s.id ? 'sel-row' : ''} style={{ cursor: 'pointer', opacity: s.is_active ? 1 : 0.55 }} onClick={() => setSel(sel === s.id ? null : s.id)}>
                    <td>
                      <b>{s.name}</b>
                      {s.note && <span className="note"> · {s.note}</span>}
                    </td>
                    <td className="mono">{s.phone ?? ''}</td>
                    <td className="n">{money(s.purchased)}</td>
                    <td className="n">{money(s.paid)}</td>
                    <td className="n">
                      <b>{money(s.debt)}</b>
                    </td>
                    <td>
                      {write && (
                        <button
                          className="btn ghost sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEdit(s);
                          }}
                        >
                          Tahrirlash
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note" style={{ marginTop: 8 }}>
          Qatorni bosing — akt sverka va to'lov.
        </p>
      </div>
      {cur && <SupplierLedger key={cur.id} s={cur} />}
      {edit && <SupplierModal s={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

// ---------- Billz bilan solishtirish ----------
export function SalesBillzPage() {
  const [shop, setShop] = useState('');
  const [onlyDiff, setOnlyDiff] = useState(true);
  const q = useQuery({ queryKey: ['sales', 'billz', shop], queryFn: () => api<SalesBillzCompare>(`/sales/sklad/billz${shop ? `?shop_id=${encodeURIComponent(shop)}` : ''}`) });
  const d = q.data;
  const rows = (d?.rows ?? []).filter((r) => !onlyDiff || r.diff !== 0);
  return (
    <>
      <PageHead title="Billz bilan solishtirish" sub="Barcode bo'yicha: do'konlarga jo'natilgan − Billz'da sotilgan = kutilgan qoldiq; Billz'dagi qoldiq bilan farq" />
      {d && (
        <div className="warn-box card">
          <div>
            Billz sotuvi {d.sales_start ? `${fmtDate(d.sales_start)} dan` : 'sozlamadagi sanadan'} olinadi — undan oldin do'konga jo'natilib sotilgan tovar farq ko'rsatadi. Billz oxirgi yangilanish:{' '}
            {fmtDateTime(d.synced_at)}.
          </div>
          {d.no_barcode > 0 && <div>Barcodesiz tovarlar: {d.no_barcode} ta — «Sotuv bo'limi skladi» sahifasida «Tahrirlash» orqali barcode kiriting.</div>}
        </div>
      )}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <Field label="Do'kon">
            <select value={shop} onChange={(e) => setShop(e.target.value)}>
              <option value="">Hamma do'konlar</option>
              {d?.shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <label className="row">
            <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Faqat farqi borlar
          </label>
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">{q.isLoading ? 'Yuklanmoqda…' : onlyDiff ? 'Farq yo\'q.' : 'Barcode bilan bog\'langan tovar yo\'q.'}</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Tovar</th>
                  <th>Barcode</th>
                  <th className="n">Markaziy skladda</th>
                  <th className="n">Do'konlarga jo'natilgan</th>
                  <th className="n">Billz sotilgan</th>
                  <th className="n">Kutilgan qoldiq</th>
                  <th className="n">Billz qoldiq</th>
                  <th className="n">Farq</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <SourcePill source={r.source} /> {label(r)}
                    </td>
                    <td className="mono">{r.barcode}</td>
                    <td className="n">{fmtNum(r.qty)}</td>
                    <td className="n">{fmtNum(r.to_shops)}</td>
                    <td className="n">{fmtNum(r.billz_sold, 3)}</td>
                    <td className="n">{fmtNum(r.expected, 3)}</td>
                    <td className="n">{fmtNum(r.billz_qty, 3)}</td>
                    <td className="n">{r.diff === 0 ? <span className="pill good">0</span> : <span className="pill bad">{r.diff > 0 ? '+' : ''}{fmtNum(r.diff, 3)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {d && d.unmatched.length > 0 && (
        <div className="card">
          <h2>Billz'da bor, bizda barcode bog'lanmagan</h2>
          <p className="note">Bu tovarlarni Sotuv skladidagi tovarga barcode orqali bog'lang yoki postavshik tovari sifatida qo'shing.</p>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Billz nomi</th>
                  <th>SKU</th>
                  <th>Barcode</th>
                  <th className="n">Billz qoldiq</th>
                </tr>
              </thead>
              <tbody>
                {d.unmatched.map((u) => (
                  <tr key={u.barcode}>
                    <td>{u.product_name}</td>
                    <td className="mono">{u.sku ?? ''}</td>
                    <td className="mono">{u.barcode}</td>
                    <td className="n">{fmtNum(u.billz_qty, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
