import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtNum, useToast } from '../components/ui';
import { CURRENCIES, can, type Color, type Material, type Supplier, type TransitLine, type TransitOrder } from '../types';
import { useCatalog } from './Orders';
import { cur, money, num, plain } from './purchaseUi';
import { ExpensesEditor, ExpensesJournal, ITEM_HEADS, ItemCells, MovesJournal, SubmitBar, expBody, expError, expRows, expTotal, today, useStockInvalidate, type ExpRow } from './stockUi';

/** Qo'shimcha xarajatni qatorlarga Miqdor real ulushida bo'lish (Sheets formulasi) */
function share(total: number, qty: number[]) {
  const sum = qty.reduce((a, b) => a + b, 0);
  return qty.map((q) => (sum ? (total * q) / sum : 0));
}

// ---------- Prixod (Ta'minot orqali) ----------
const TAMINOT_CATS = ['Kargo', 'Bojxona', 'Ichki logistika', 'Boshqa xarajatlar'];

export function PrixodTaminotPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useStockInvalidate();
  const [orderId, setOrderId] = useState('');
  const [docDate, setDocDate] = useState(today());
  const [fact, setFact] = useState<Record<number, string>>({});
  const [off, setOff] = useState<Record<number, boolean>>({});
  const [exp, setExp] = useState<ExpRow[]>(() => expRows(['Kargo', 'Bojxona', 'Boshqa xarajatlar']));
  const [msg, setMsg] = useState<string | null>(null);
  const orders = useQuery({ queryKey: ['stock', 'transit'], queryFn: () => api<TransitOrder[]>('/stock/transit') });
  const lines = useQuery({ queryKey: ['stock', 'transit', orderId], queryFn: () => api<TransitLine[]>(`/stock/transit/${orderId}`), enabled: !!orderId });
  const suppliers = useCatalog<Supplier>('suppliers');
  useEffect(() => {
    setFact({});
    setOff({});
    setMsg(null);
  }, [lines.data]);
  const save = useMutation({
    mutationFn: (body: object) => api<{ id: number }>('/stock/prixod-taminot', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      setExp(expRows(['Kargo', 'Bojxona', 'Boshqa xarajatlar']));
      toast(`Prixod №${r.id} saqlandi`);
    },
  });
  if (!me) return null;
  const write = can.stockWrite(me.role);
  const rows = (lines.data ?? []).filter((l) => !off[l.purchase_line_id]);
  const real = (l: TransitLine) => {
    const v = num(fact[l.purchase_line_id] ?? '');
    return Number.isFinite(v) ? v : Number(l.transit_qty);
  };
  const extra = share(expTotal(exp), rows.map(real));
  const extraOf = new Map(rows.map((l, i) => [l.purchase_line_id, extra[i]]));
  const goods = (l: TransitLine) => real(l) * Number(l.price) * Number(l.rate);

  const submit = () => {
    setMsg(null);
    if (!orderId) return setMsg('Partiya raqamini tanlang');
    if (!docDate) return setMsg('Sanani kiriting');
    if (!rows.length) return setMsg('Qabul qilinadigan qator yo\'q');
    for (const l of rows) {
      const s = fact[l.purchase_line_id];
      if (s && !(num(s) > 0)) return setMsg(`${l.material_name}: fakt miqdor noto'g'ri`);
    }
    const e = expError(exp);
    if (e) return setMsg(e);
    save.mutate({
      order_id: Number(orderId),
      doc_date: docDate,
      rows: rows.map((l) => ({ purchase_line_id: l.purchase_line_id, fact_qty: fact[l.purchase_line_id] ? num(fact[l.purchase_line_id]) : null })),
      expenses: expBody(exp),
    });
  };

  return (
    <>
      <PageHead title="Prixod (Ta'minot orqali)" sub="Yo'lga chiqqan buyurtmani omborga qabul qilish: fakt miqdor va qo'shimcha xarajatlar (kargo, bojxona…)" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form">
          <label className="f">
            Partiya raqam
            <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
              <option value="">— tanlang —</option>
              {orders.data?.map((o) => (
                <option key={o.order_id} value={o.order_id}>
                  {o.partiya_no} · {o.product_type_name} · {o.lines} qator yo'lda
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            Sana
            <input type="date" value={docDate} disabled={!write} onChange={(e) => setDocDate(e.target.value)} />
          </label>
        </div>
        {orders.data && !orders.data.length && <p className="note" style={{ marginTop: 8 }}>Yo'ldagi tovar yo'q. «Status o'zgartirish»da yo'lga chiqqan miqdor kiritilgach shu yerda chiqadi.</p>}
      </div>

      {orderId && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Qo'shimcha xarajatlar</h2>
          <ExpensesEditor rows={exp} onChange={setExp} categories={TAMINOT_CATS} suppliers={suppliers.data} disabled={!write} />
          <p className="note" style={{ marginTop: 6 }}>
            Jami: <b>{money(expTotal(exp))} so'm</b> — qatorlarga Miqdor real ulushida taqsimlanadi (Sheets'dagidek).
          </p>
        </div>
      )}

      {orderId && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Yo'ldagi tovar</h2>
          <ErrorText error={lines.error} />
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1900 }}>
              <thead>
                <tr>
                  <th>Qabul</th>
                  {ITEM_HEADS.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                  <th className="n">Yuborilgan miqdor</th>
                  <th className="n">Fakt miqdor</th>
                  <th className="n">Miqdor real</th>
                  <th>Kontragent nomi</th>
                  <th className="n">Narxi</th>
                  <th className="n">Summasi</th>
                  <th>Valyuta</th>
                  <th className="n">Valyuta kursi</th>
                  <th className="n">Summa so'm xomashyo</th>
                  <th className="n">Summa so'm qo'shimcha</th>
                  <th className="n">Summa jami</th>
                  <th className="n">Tannarx (1 birlik)</th>
                </tr>
              </thead>
              <tbody>
                {lines.data?.map((l) => {
                  const on = !off[l.purchase_line_id];
                  const ex = extraOf.get(l.purchase_line_id) ?? 0;
                  const total = goods(l) + ex;
                  return (
                    <tr key={l.purchase_line_id} className={on ? '' : 'note'}>
                      <td>
                        <input type="checkbox" aria-label="Qabul qilish" checked={on} disabled={!write} onChange={(e) => setOff((x) => ({ ...x, [l.purchase_line_id]: !e.target.checked }))} />
                      </td>
                      <ItemCells i={l} />
                      <td className="n">
                        {fmtNum(l.transit_qty)} <span className="note">{l.unit}</span>
                      </td>
                      <td className="n">
                        <input
                          className="cell num"
                          inputMode="decimal"
                          placeholder={plain(l.transit_qty)}
                          value={fact[l.purchase_line_id] ?? ''}
                          disabled={!write || !on}
                          onChange={(e) => setFact((x) => ({ ...x, [l.purchase_line_id]: e.target.value }))}
                          aria-label="Fakt miqdor"
                        />
                      </td>
                      <td className="n">
                        <b>{fmtNum(real(l))}</b>
                      </td>
                      <td>{l.supplier_name}</td>
                      <td className="n">{plain(l.price)}</td>
                      <td className="n">{money(real(l) * Number(l.price))}</td>
                      <td>{cur(l.currency)}</td>
                      <td className="n">{l.currency === 'UZS' ? '' : plain(l.rate)}</td>
                      <td className="n">{on ? money(goods(l)) : ''}</td>
                      <td className="n">{on ? money(ex) : ''}</td>
                      <td className="n">{on ? <b>{money(total)}</b> : ''}</td>
                      <td className="n">{on && real(l) ? money(total / real(l)) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {write && (
            <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
              {rows.length} qator · xomashyo {money(rows.reduce((a, l) => a + goods(l), 0))} so'm + qo'shimcha {money(expTotal(exp))} so'm. Fakt kiritilmasa —
              yuborilgan miqdor olinadi; farq «yo'lda» qoladi.
            </SubmitBar>
          )}
        </div>
      )}

      <MovesJournal kind="prixod_taminot" />
      <ExpensesJournal kind="prixod_taminot" />
    </>
  );
}

// ---------- Prixod (oddiy) ----------
interface Row {
  material_id: string;
  material_color_id: string;
  color_code: string;
  material_size: string;
  qty: string;
  price: string;
}
const emptyRow = (): Row => ({ material_id: '', material_color_id: '', color_code: '', material_size: '', qty: '', price: '' });
const MANUAL_CATS = ['Logistika', 'Bojxona', 'Boshqa xarajatlar', 'Kargo'];

export function PrixodPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useStockInvalidate();
  const [docDate, setDocDate] = useState(today());
  const [op, setOp] = useState<'prixod' | 'vozvrat'>('prixod');
  const [supplier, setSupplier] = useState('');
  const [currency, setCurrency] = useState('UZS');
  const [rate, setRate] = useState('');
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow(), emptyRow()]);
  const [exp, setExp] = useState<ExpRow[]>(() => expRows(['Logistika', 'Bojxona', 'Boshqa xarajatlar']));
  const [msg, setMsg] = useState<string | null>(null);
  const materials = useCatalog<Material>('materials');
  const colors = useCatalog<Color>('colors');
  const suppliers = useCatalog<Supplier>('suppliers');
  const save = useMutation({
    mutationFn: (body: object) => api<{ id: number }>('/stock/prixod', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      setRows([emptyRow(), emptyRow(), emptyRow()]);
      setExp(expRows(['Logistika', 'Bojxona', 'Boshqa xarajatlar']));
      toast(`${op === 'prixod' ? 'Prixod' : 'Vozvrat'} №${r.id} saqlandi`);
    },
  });
  if (!me) return null;
  const write = can.stockWrite(me.role);
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const filled = rows.filter((r) => r.material_id || r.qty || r.price);
  const bad = (r: Row) => (r.material_id || r.qty || r.price ? !r.material_id || !(num(r.qty) > 0) || !(num(r.price) >= 0) : false);
  const rateN = currency === 'UZS' ? 1 : num(rate);
  const extra = op === 'prixod' ? share(expTotal(exp), rows.map((r) => (bad(r) || !r.material_id ? 0 : num(r.qty)))) : rows.map(() => 0);
  const unit = (id: string) => materials.data?.find((m) => String(m.id) === id)?.unit ?? '';

  const submit = () => {
    setMsg(null);
    if (!docDate) return setMsg('Sanani kiriting');
    if (!supplier) return setMsg('Kontragent nomini tanlang');
    if (currency !== 'UZS' && !(num(rate) > 0)) return setMsg('Valyuta kursini kiriting');
    if (!filled.length) return setMsg('Xomashyo qo\'shing');
    const b = filled.find(bad);
    if (b) return setMsg('Qatorda xomashyo nomi, miqdori va narxi to\'liq bo\'lishi kerak');
    const e = op === 'prixod' ? expError(exp) : null;
    if (e) return setMsg(e);
    save.mutate({
      doc_date: docDate,
      op,
      supplier_id: Number(supplier),
      currency,
      rate: currency === 'UZS' ? null : num(rate),
      rows: filled.map((r) => ({
        material_id: Number(r.material_id),
        material_color_id: r.material_color_id ? Number(r.material_color_id) : null,
        color_code: r.color_code.trim() || null,
        material_size: r.material_size.trim() || null,
        qty: num(r.qty),
        price: num(r.price),
      })),
      expenses: op === 'prixod' ? expBody(exp) : [],
    });
  };

  return (
    <>
      <PageHead title="Prixod" sub="Ta'minotsiz kirim yoki postavshikka vozvrat; qo'shimcha xarajatlar miqdor ulushida taqsimlanadi" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form">
          <label className="f">
            Sana
            <input type="date" value={docDate} disabled={!write} onChange={(e) => setDocDate(e.target.value)} />
          </label>
          <label className="f">
            Kontragent nomi
            <select value={supplier} disabled={!write} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">— tanlang —</option>
              {suppliers.data
                ?.filter((s) => s.is_active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="f">
            Operatsiya turi
            <select value={op} disabled={!write} onChange={(e) => setOp(e.target.value as 'prixod' | 'vozvrat')}>
              <option value="prixod">Prixod</option>
              <option value="vozvrat">Vozvrat (postavshikka)</option>
            </select>
          </label>
          <label className="f">
            Valyuta
            <select value={currency} disabled={!write} onChange={(e) => setCurrency(e.target.value)}>
              {Object.entries(CURRENCIES).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {currency !== 'UZS' && (
            <label className="f">
              Valyuta kursi
              <input inputMode="decimal" value={rate} disabled={!write} onChange={(e) => setRate(e.target.value)} />
            </label>
          )}
        </div>
      </div>

      {op === 'prixod' && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Qo'shimcha xarajatlar</h2>
          <ExpensesEditor rows={exp} onChange={setExp} categories={MANUAL_CATS} suppliers={suppliers.data} disabled={!write} />
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h2>Xomashyo</h2>
          {write && (
            <button className="btn ghost sm" onClick={() => setRows((r) => [...r, emptyRow()])}>
              + qator
            </button>
          )}
        </div>
        <div className="sheet-wrap">
          <table className="sheet" style={{ minWidth: 1400 }}>
            <thead>
              <tr>
                <th>Xomashyo nomi</th>
                <th>Xomashyo rangi</th>
                <th>Rang kodi</th>
                <th>Razmeri</th>
                <th className="n">Miqdori</th>
                <th className="n">Narxi</th>
                <th className="n">Summasi</th>
                <th className="n">Summa so'm</th>
                {op === 'prixod' && <th className="n">Qo'shimcha</th>}
                <th>Natija</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const sum = (num(r.qty) || 0) * (num(r.price) || 0);
                return (
                  <tr key={i} className={bad(r) ? 'bad-row' : ''}>
                    <td>
                      <select value={r.material_id} disabled={!write} onChange={(e) => set(i, { material_id: e.target.value })} aria-label="Xomashyo nomi" style={{ maxWidth: 260 }}>
                        <option value="">—</option>
                        {materials.data
                          ?.filter((m) => m.is_active || String(m.id) === r.material_id)
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                              {m.code ? ` · ${m.code}` : ''}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td>
                      <select value={r.material_color_id} disabled={!write} onChange={(e) => set(i, { material_color_id: e.target.value })} aria-label="Xomashyo rangi">
                        <option value="">—</option>
                        {colors.data
                          ?.filter((c) => c.is_active || String(c.id) === r.material_color_id)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td>
                      <input className="cell sm" value={r.color_code} disabled={!write} onChange={(e) => set(i, { color_code: e.target.value })} aria-label="Rang kodi" />
                    </td>
                    <td>
                      <input className="cell sm" value={r.material_size} disabled={!write} onChange={(e) => set(i, { material_size: e.target.value })} aria-label="Razmeri" />
                    </td>
                    <td className="n">
                      <input className="cell num" inputMode="decimal" value={r.qty} disabled={!write} onChange={(e) => set(i, { qty: e.target.value })} aria-label="Miqdori" />{' '}
                      <span className="note">{unit(r.material_id)}</span>
                    </td>
                    <td className="n">
                      <input className="cell num" inputMode="decimal" value={r.price} disabled={!write} onChange={(e) => set(i, { price: e.target.value })} aria-label="Narxi" />
                    </td>
                    <td className="n">{sum ? money(sum) : ''}</td>
                    <td className="n">{sum && Number.isFinite(rateN) ? money(sum * rateN) : ''}</td>
                    {op === 'prixod' && <td className="n">{extra[i] ? money(extra[i]) : ''}</td>}
                    <td>{bad(r) ? <span className="pill bad">X</span> : ''}</td>
                    <td>
                      {write && rows.length > 1 && (
                        <button className="x" aria-label="Qatorni o'chirish" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {write && (
          <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
            {filled.length} qator{op === 'vozvrat' ? ' · vozvratda ombordagi qoldiq tekshiriladi' : ''}
          </SubmitBar>
        )}
      </div>

      <MovesJournal kind="prixod" />
      <ExpensesJournal kind="prixod" />
    </>
  );
}
