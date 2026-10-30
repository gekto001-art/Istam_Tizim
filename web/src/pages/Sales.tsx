import { useMutation, useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtDate, fmtNum, useToast } from '../components/ui';
import { can, type FgStock, type PayMethod, type SalesLedger, type SalesPayment, type SalesTransfer, type TransferStatus } from '../types';
import { money, num } from './purchaseUi';
import { SubmitBar, today, useStockInvalidate } from './stockUi';

/** Sotuv bo'limi — alohida biznes: ishlab chiqarishdan ichki narxda oladi, qarzini to'laydi. */
const STATUS: Record<TransferStatus, [string, string]> = {
  sent: ['Javob kutilmoqda', 'warn'],
  accepted: ['Qabul qilindi', 'good'],
  rejected: ['Rad etildi', 'bad'],
};
const METHOD: Record<PayMethod, string> = { naqd: 'Naqd', plastik: 'Plastik', bank: 'Bank (o\'tkazma)' };
const okInt = (v: number) => Number.isInteger(v) && v >= 0;
const n = (s: string) => (s.trim() === '' ? 0 : num(s));
const fgKey = (r: { order_id: number; color_id: number; size_id: number }) => `${r.order_id}:${r.color_id}:${r.size_id}`;

/** O'tkazma qatorlari (har o'tkazma ostida) */
function TransferItems({ t }: { t: SalesTransfer }) {
  return (
    <div className="sheet-wrap">
      <table className="sheet" style={{ minWidth: 900 }}>
        <thead>
          <tr>
            <th>Partiya</th>
            <th>Tovar</th>
            <th>Artikul · model</th>
            <th>Razmer</th>
            <th>Rang</th>
            <th>Sort</th>
            <th className="n">Soni</th>
            <th className="n">Narx</th>
            <th className="n">Summa, so'm</th>
          </tr>
        </thead>
        <tbody>
          {t.items.map((i) => (
            <tr key={`${fgKey(i)}:${i.sort}`}>
              <td className="mono">{i.partiya_no}</td>
              <td>{i.product_type_name}</td>
              <td>{[i.artikul, i.model].filter(Boolean).join(' · ')}</td>
              <td className="mono">{i.size_name}</td>
              <td>{i.color_name}</td>
              <td>{i.sort} sort</td>
              <td className="n">{fmtNum(i.qty)}</td>
              <td className="n">{money(i.price)}</td>
              <td className="n">{money(i.qty * Number(i.price))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TransferHead({ t, showCost }: { t: SalesTransfer; showCost?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
      <div className="row">
        <b>O'tkazma №{t.id}</b>
        <span className="mono">{fmtDate(t.doc_date)}</span>
        <span className={`pill ${STATUS[t.status][1]}`}>{STATUS[t.status][0]}</span>
        <span className="note">
          yubordi: {t.created_by_name ?? '—'}
          {t.decided_at && ` · ${t.status === 'accepted' ? 'qabul qildi' : 'rad etdi'}: ${t.decided_by_name ?? '—'}, ${fmtDate(t.decided_date)}`}
        </span>
      </div>
      <span>
        {fmtNum(t.qty)} dona · <b>{money(t.amount_uzs)} so'm</b>
        {showCost && <span className="note"> · tannarx {money(t.cost_uzs)} · foyda {money(Number(t.amount_uzs) - Number(t.cost_uzs))}</span>}
      </span>
    </div>
  );
}

function History({ title = 'Tarix', showCost }: { title?: string; showCost?: boolean }) {
  const q = useQuery({ queryKey: ['stock', 'sales', 'transfers', 'decided'], queryFn: () => api<SalesTransfer[]>('/sales/transfers?status=decided&limit=100') });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="card">
      <h2>{title}</h2>
      <ErrorText error={q.error} />
      {!q.data?.length ? (
        <p className="note">Hali yo'q.</p>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>№</th>
                <th>Sana</th>
                <th>Holat</th>
                <th>Javob</th>
                <th className="n">Soni</th>
                <th className="n">Summa, so'm</th>
                {showCost && <th className="n">Foyda (ishlab chiqarish)</th>}
                <th>Izoh</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((t) => (
                <Fragment key={t.id}>
                  <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === t.id ? null : t.id)}>
                    <td className="mono">{t.id}</td>
                    <td className="mono">{fmtDate(t.doc_date)}</td>
                    <td>
                      <span className={`pill ${STATUS[t.status][1]}`}>{STATUS[t.status][0]}</span>
                    </td>
                    <td>
                      {t.decided_by_name ?? '—'}, {fmtDate(t.decided_date)}
                    </td>
                    <td className="n">{fmtNum(t.qty)}</td>
                    <td className="n">{money(t.amount_uzs)}</td>
                    {showCost && <td className="n">{t.status === 'accepted' ? money(Number(t.amount_uzs) - Number(t.cost_uzs)) : ''}</td>}
                    <td>{[t.note, t.reject_reason && `Sabab: ${t.reject_reason}`].filter(Boolean).join(' · ')}</td>
                  </tr>
                  {open === t.id && (
                    <tr>
                      <td colSpan={showCost ? 8 : 7}>
                        <TransferItems t={t} />
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
  );
}

// ---------- Tayyor mahsulot skladi → Sotuv bo'limiga o'tkazma ----------
type Qty = { s1: string; s2: string };

export function TransferPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useStockInvalidate();
  const [partiya, setPartiya] = useState('');
  const [docDate, setDocDate] = useState(today());
  const [note, setNote] = useState('');
  const [vals, setVals] = useState<Record<string, Qty>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const stock = useQuery({ queryKey: ['stock', 'fg'], queryFn: () => api<FgStock[]>('/otk/stock') });
  const sent = useQuery({ queryKey: ['stock', 'sales', 'transfers', 'sent'], queryFn: () => api<SalesTransfer[]>('/sales/transfers?status=sent') });
  useEffect(() => setVals({}), [stock.data]);
  const save = useMutation({
    mutationFn: (body: object) => api<SalesTransfer>('/sales/transfers', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      setNote('');
      toast(`O'tkazma №${r.id} yuborildi: ${fmtNum(r.qty)} dona, ${money(r.amount_uzs)} so'm`);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/sales/transfers/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => {
      inv();
      toast(`O'tkazma №${id} o'chirildi — mahsulot skladga qaytdi`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  if (!me) return null;
  const write = can.salesTransfer(me.role);
  const rows = (stock.data ?? []).filter((r) => !partiya || r.partiya_no === partiya);
  const v = (r: FgStock) => vals[fgKey(r)] ?? { s1: '', s2: '' };
  const set = (r: FgStock, p: Partial<Qty>) => setVals((x) => ({ ...x, [fgKey(r)]: { ...v(r), ...p } }));
  const touched = (r: FgStock) => n(v(r).s1) !== 0 || n(v(r).s2) !== 0;
  const badCell = (r: FgStock, s: 1 | 2) => {
    const q = n(s === 1 ? v(r).s1 : v(r).s2);
    if (!okInt(q) || q > (s === 1 ? r.sort1 : r.sort2)) return true;
    return q > 0 && (s === 1 ? r.sale_price1 : r.sale_price2) == null;
  };
  const bad = (r: FgStock) => badCell(r, 1) || badCell(r, 2);
  const sum = (r: FgStock) => n(v(r).s1) * Number(r.sale_price1 ?? 0) + n(v(r).s2) * Number(r.sale_price2 ?? 0);
  const total = rows.filter((r) => touched(r) && !bad(r)).reduce((a, r) => a + sum(r), 0);

  const submit = () => {
    setMsg(null);
    if (!docDate) return setMsg('Sanani kiriting');
    const t = rows.filter(touched);
    if (!t.length) return setMsg('Yuboriladigan sonni kiriting');
    const b = t.find(bad);
    if (b) return setMsg(`Partiya ${b.partiya_no}, ${b.color_name} ${b.size_name}: son skladdagidan ko'p yoki Sotuv bo'limiga narx belgilanmagan`);
    const out = t.flatMap((r) =>
      ([1, 2] as const).filter((s) => n(s === 1 ? v(r).s1 : v(r).s2) > 0).map((s) => ({ order_id: r.order_id, color_id: r.color_id, size_id: r.size_id, sort: s, qty: n(s === 1 ? v(r).s1 : v(r).s2) })),
    );
    save.mutate({ doc_date: docDate, note, rows: out });
  };

  return (
    <>
      <PageHead title="Sotuv bo'limiga o'tkazma" sub="Tayyor mahsulot Sotuv bo'limiga ichki narxda (zakazdagi «Sotuv bo'limiga narx») o'tkaziladi; Sotuv bo'limi qabul qilgach qarz bo'ladi" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <label className="f">
            Partiya
            <select value={partiya} onChange={(e) => setPartiya(e.target.value)}>
              <option value="">Hammasi</option>
              {[...new Set((stock.data ?? []).map((r) => r.partiya_no))].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="f">
            O'tkazma sana
            <input type="date" value={docDate} disabled={!write} onChange={(e) => setDocDate(e.target.value)} />
          </label>
          <label className="f">
            Izoh
            <input value={note} disabled={!write} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
          {write && rows.length > 0 && (
            <div className="f">
              &nbsp;
              <button
                className="btn ghost sm"
                onClick={() =>
                  setVals(Object.fromEntries(rows.map((r) => [fgKey(r), { s1: r.sale_price1 == null ? '' : String(r.sort1), s2: r.sale_price2 == null ? '' : String(r.sort2) }])))
                }
              >
                Hammasini yuborish
              </button>
            </div>
          )}
        </div>
        <ErrorText error={stock.error} />
        {!rows.length ? (
          <p className="note">Tayyor mahsulot skladida mahsulot yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1200 }}>
              <thead>
                <tr>
                  <th>Partiya</th>
                  <th>Tovar</th>
                  <th>Artikul · model</th>
                  <th>Razmer</th>
                  <th>Rang</th>
                  <th className="n">Skladda 1 sort</th>
                  <th className="n">Narx 1 sort</th>
                  <th className="n">Yuborish 1 sort</th>
                  <th className="n">Skladda 2 sort</th>
                  <th className="n">Narx 2 sort</th>
                  <th className="n">Yuborish 2 sort</th>
                  <th className="n">Summa, so'm</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={fgKey(r)} className={touched(r) && bad(r) ? 'bad-row' : touched(r) ? 'sel-row' : ''}>
                    <td className="mono">{r.partiya_no}</td>
                    <td>{r.product_type_name}</td>
                    <td>{[r.artikul, r.model].filter(Boolean).join(' · ')}</td>
                    <td className="mono">{r.size_name}</td>
                    <td>{r.color_name}</td>
                    {([1, 2] as const).map((s) => {
                      const left = s === 1 ? r.sort1 : r.sort2;
                      const price = s === 1 ? r.sale_price1 : r.sale_price2;
                      const k = s === 1 ? 's1' : 's2';
                      return [
                        <td key={`l${s}`} className="n">
                          {left ? fmtNum(left) : ''}
                        </td>,
                        <td key={`p${s}`} className="n">
                          {left ? price == null ? <span className="pill bad" title="Innovatsion bo'lim zakazda belgilaydi">narx yo'q</span> : money(price) : ''}
                        </td>,
                        <td key={`q${s}`} className="n">
                          {left > 0 && price != null && (
                            <input className="cell num" inputMode="numeric" value={v(r)[k]} disabled={!write} onChange={(e) => set(r, { [k]: e.target.value })} aria-label={`${s} sort, partiya ${r.partiya_no} ${r.color_name} ${r.size_name}`} />
                          )}
                        </td>,
                      ];
                    })}
                    <td className="n">{touched(r) && !bad(r) ? money(sum(r)) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {write && rows.length > 0 && (
          <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit} label="YUBORISH">
            Jami: <b>{money(total)} so'm</b>. Yuborilgan mahsulot skladdan chiqadi; Sotuv bo'limi rad etsa yoki o'tkazma o'chirilsa — qaytadi.
          </SubmitBar>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Javob kutilayotgan o'tkazmalar</h2>
        <ErrorText error={sent.error} />
        {!sent.data?.length ? (
          <p className="note">Yo'q.</p>
        ) : (
          sent.data.map((t) => (
            <div key={t.id} style={{ marginBottom: 14 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <TransferHead t={t} />
                {write && (
                  <button className="btn ghost sm" disabled={del.isPending} onClick={() => confirm(`O'tkazma №${t.id} o'chirilsinmi? Mahsulot skladga qaytadi.`) && del.mutate(t.id)}>
                    O'chirish
                  </button>
                )}
              </div>
              <TransferItems t={t} />
            </div>
          ))
        )}
      </div>
      <History title="Javob berilgan o'tkazmalar" showCost />
    </>
  );
}

// ---------- Sotuv bo'limi: ishlab chiqarishdan prixod (qabul / rad) ----------
export function SalesPrixodPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useStockInvalidate();
  const [date, setDate] = useState(today());
  const q = useQuery({ queryKey: ['stock', 'sales', 'transfers', 'sent'], queryFn: () => api<SalesTransfer[]>('/sales/transfers?status=sent') });
  const m = useMutation({
    mutationFn: (b: { id: number; decision: 'accepted' | 'rejected'; reason?: string }) =>
      api<SalesTransfer>(`/sales/transfers/${b.id}/decide`, { method: 'POST', body: { decision: b.decision, reason: b.reason, decided_date: date } }),
    onSuccess: (r) => {
      inv();
      toast(r.status === 'accepted' ? `O'tkazma №${r.id} qabul qilindi — ${money(r.amount_uzs)} so'm qarzga yozildi` : `O'tkazma №${r.id} rad etildi — mahsulot ishlab chiqarish skladiga qaytdi`);
    },
  });
  if (!me) return null;
  const write = can.salesAccept(me.role);
  const reject = (id: number) => {
    const reason = prompt(`O'tkazma №${id} — rad etish sababi:`)?.trim();
    if (reason) m.mutate({ id, decision: 'rejected', reason });
  };
  return (
    <>
      <PageHead title="Prixod (ishlab chiqarishdan)" sub="Ishlab chiqarish yuborgan tayyor mahsulot: qabul qilinsa — ichki narxda ishlab chiqarishga qarz bo'ladi" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <label className="f">
            Qabul sana
            <input type="date" value={date} disabled={!write} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <ErrorText error={q.error ?? m.error} />
        {!q.data?.length ? (
          <p className="note">Javob kutayotgan o'tkazma yo'q.</p>
        ) : (
          q.data.map((t) => (
            <div key={t.id} style={{ marginBottom: 16 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <TransferHead t={t} />
                {write && (
                  <div className="row">
                    <button className="btn sm" disabled={m.isPending} onClick={() => confirm(`O'tkazma №${t.id} qabul qilinsinmi? ${money(t.amount_uzs)} so'm qarz bo'ladi.`) && m.mutate({ id: t.id, decision: 'accepted' })}>
                      Qabul qilish
                    </button>
                    <button className="btn ghost sm" disabled={m.isPending} onClick={() => reject(t.id)}>
                      Rad etish
                    </button>
                  </div>
                )}
              </div>
              {t.note && <p className="note">{t.note}</p>}
              <TransferItems t={t} />
            </div>
          ))
        )}
      </div>
      <History />
    </>
  );
}

// ---------- Ishlab chiqarish bilan hisob-kitob (akt sverka) ----------
export function SalesLedgerPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useStockInvalidate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pay, setPay] = useState({ pay_date: today(), amount: '', method: 'naqd' as PayMethod, note: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
  const q = useQuery({ queryKey: ['stock', 'sales', 'ledger', qs], queryFn: () => api<SalesLedger>(`/sales/ledger${qs ? `?${qs}` : ''}`) });
  const add = useMutation({
    mutationFn: () => api<SalesPayment>('/sales/payments', { method: 'POST', body: { pay_date: pay.pay_date, amount_uzs: num(pay.amount), method: pay.method, note: pay.note } }),
    onSuccess: (r) => {
      inv();
      setPay({ ...pay, amount: '', note: '' });
      toast(`To'lov ${money(r.amount_uzs)} so'm kiritildi`);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/sales/payments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      inv();
      toast('To\'lov o\'chirildi');
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  if (!me) return null;
  const write = can.salesPay(me.role);
  const d = q.data;
  const submit = () => {
    setMsg(null);
    if (!pay.pay_date) return setMsg('Sanani kiriting');
    if (!(num(pay.amount) > 0)) return setMsg('Summani kiriting');
    add.mutate();
  };
  return (
    <>
      <PageHead title="Ishlab chiqarish bilan hisob" sub="Sotuv bo'limining ishlab chiqarishdan qarzi: qabul qilingan o'tkazmalar (ichki narxda) − to'lovlar" />
      {d && (
        <div className="cards" style={{ marginBottom: 14 }}>
          <div className="card stat">
            <span className="note">Qarz (davr oxiriga)</span>
            <b>{money(d.totals.closing)}</b>
            {from && <span className="note">boshida: {money(d.opening)}</span>}
          </div>
          <div className="card stat">
            <span className="note">Qabul qilingan</span>
            <b>{money(d.totals.debit)}</b>
          </div>
          <div className="card stat">
            <span className="note">To'langan</span>
            <b>{money(d.totals.credit)}</b>
          </div>
          <div className="card stat">
            <span className="note">Ishlab chiqarish foydasi</span>
            <b>{money(d.totals.margin)}</b>
            <span className="note">tannarx: {money(d.totals.cost)}</span>
          </div>
          {d.pending.count > 0 && (
            <div className="card stat">
              <span className="note">Javob kutilmoqda</span>
              <b>{money(d.pending.amount_uzs)}</b>
              <span className="note">{d.pending.count} ta o'tkazma — qarzga kirmagan</span>
            </div>
          )}
        </div>
      )}

      {write && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>To'lov (Sotuv → ishlab chiqarish)</h2>
          <div className="form">
            <label className="f">
              Sana
              <input type="date" value={pay.pay_date} onChange={(e) => setPay({ ...pay, pay_date: e.target.value })} />
            </label>
            <label className="f">
              Summa, so'm
              <input className="num" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
            </label>
            <label className="f">
              Usul
              <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value as PayMethod })}>
                {Object.entries(METHOD).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="f">
              Izoh
              <input value={pay.note} maxLength={500} onChange={(e) => setPay({ ...pay, note: e.target.value })} />
            </label>
          </div>
          <SubmitBar msg={msg} error={add.error} pending={add.isPending} onSubmit={submit} />
        </div>
      )}

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
        </div>
        <ErrorText error={q.error ?? del.error} />
        {!d?.rows.length ? (
          <p className="note">Bu davrda yozuv yo'q.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Sana</th>
                  <th>Hujjat</th>
                  <th>Izoh</th>
                  <th className="n">Qarz (+)</th>
                  <th className="n">To'lov (−)</th>
                  <th className="n">Qoldiq</th>
                  {write && <th />}
                </tr>
              </thead>
              <tbody>
                {from && (
                  <tr>
                    <td className="mono">{fmtDate(from)}</td>
                    <td colSpan={4}>Davr boshiga qoldiq</td>
                    <td className="n">
                      <b>{money(d.opening)}</b>
                    </td>
                    {write && <td />}
                  </tr>
                )}
                {d.rows.map((r) => (
                  <tr key={`${r.kind}:${r.ref_id}`}>
                    <td className="mono">{fmtDate(r.date)}</td>
                    <td>{r.kind === 'transfer' ? `O'tkazma №${r.ref_id} (${fmtNum(r.qty)} dona)` : `To'lov №${r.ref_id}`}</td>
                    <td>{r.kind === 'payment' && r.note ? r.note.replace(/^(naqd|plastik|bank)/, (m) => METHOD[m as PayMethod]) : r.note ?? ''}</td>
                    <td className="n">{Number(r.debit) ? money(r.debit) : ''}</td>
                    <td className="n">{Number(r.credit) ? money(r.credit) : ''}</td>
                    <td className="n">
                      <b>{money(r.balance)}</b>
                    </td>
                    {write && (
                      <td>
                        {r.kind === 'payment' && (
                          <button className="x" title="To'lovni o'chirish" aria-label={`To'lov ${r.ref_id} ni o'chirish`} disabled={del.isPending} onClick={() => confirm(`To'lov №${r.ref_id} o'chirilsinmi?`) && del.mutate(r.ref_id)}>
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
        <p className="note" style={{ marginTop: 8 }}>
          Qarz o'tkazma qabul qilingan sanada yoziladi; javob kutayotgan o'tkazma qarzga kirmaydi.
        </p>
      </div>
    </>
  );
}
