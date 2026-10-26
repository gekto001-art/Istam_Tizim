import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import { AGREED, can, type PurchaseLine, type Stage } from '../types';
import { PAYMENT_STATUS, StatusPill, cur, money, num, plain } from './purchaseUi';

/** Partiya va xomashyo bo'yicha filtr (Sheets'dagi yuqori ikki tanlov) */
function useFilters(lines: PurchaseLine[] | undefined) {
  const [partiya, setPartiya] = useState('');
  const [stage, setStage] = useState<'' | Stage>('');
  const partiyas = useMemo(() => [...new Set((lines ?? []).map((l) => l.partiya_no))], [lines]);
  const rows = (lines ?? []).filter((l) => (!partiya || l.partiya_no === partiya) && (!stage || l.stage === stage));
  const bar = (
    <div className="form" style={{ marginBottom: 12 }}>
      <label className="f">
        Partiya
        <select value={partiya} onChange={(e) => setPartiya(e.target.value)}>
          <option value="">Hammasi</option>
          {partiyas.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="f">
        Xomashyo
        <select value={stage} onChange={(e) => setStage(e.target.value as '' | Stage)}>
          <option value="">Hammasi</option>
          <option value="mato">Mato</option>
          <option value="furnitura">Furnitura</option>
        </select>
      </label>
    </div>
  );
  return { rows, bar };
}

const sumBy = (rows: PurchaseLine[], f: (l: PurchaseLine) => number) => {
  const by = new Map<string, number>();
  for (const l of rows) by.set(l.currency, (by.get(l.currency) ?? 0) + f(l));
  return [...by].map(([c, v]) => `${money(v)} ${cur(c)}`).join(' + ') || '—';
};

const variantCells = (l: PurchaseLine) => (
  <>
    <td className="mono">{l.material_code ?? ''}</td>
    <td>{l.material_color_name ?? ''}</td>
    <td className="mono">{l.color_code ?? ''}</td>
    <td className="mono">{l.material_size ?? ''}</td>
  </>
);

const TABS = [
  ['kelishuv', 'Postavshik kelishuv'],
  ['agreed', 'Tasdiqlangan buyurtmalar'],
] as const;

export function PurchasesPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('kelishuv');
  return (
    <>
      <PageHead title="Postavshik kelishuv" sub="Sheets «Postavshik Kelishuv»: nakladnoy bo'yicha fakt miqdor va narx → tasdiqlash yoki rad etish" />
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'kelishuv' ? <Kelishuv /> : <Agreed />}
    </>
  );
}

interface Edit {
  fact_qty: string;
  fact_price: string;
  agree: boolean;
  reject: boolean;
  note: string;
}

function Kelishuv() {
  const { me } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['purchases', 'lines', 'kelishuv'], queryFn: () => api<PurchaseLine[]>('/purchases/lines?status=negotiation,rejected') });
  const [edits, setEdits] = useState<Record<number, Edit>>({});
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => setEdits({}), [q.data]);
  const { rows, bar } = useFilters(q.data);
  const save = useMutation({
    mutationFn: (lines: object[]) => api<{ saved: number; agreed: number; rejected: number }>('/purchases/lines/kelishuv', { method: 'PUT', body: { lines } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['supply'] });
      toast([r.agreed && `${r.agreed} ta tasdiqlandi`, r.rejected && `${r.rejected} ta rad etildi`, r.saved && `${r.saved} ta saqlandi`].filter(Boolean).join(', '));
    },
  });
  if (!me) return null;
  const write = can.purchaseWrite(me.role);
  const approve = can.purchaseApprove(me.role);
  const base = (l: PurchaseLine): Edit => ({ fact_qty: plain(l.fact_qty), fact_price: plain(l.fact_price), agree: false, reject: false, note: l.note ?? '' });
  const ed = (l: PurchaseLine) => edits[l.id] ?? base(l);
  const set = (l: PurchaseLine, patch: Partial<Edit>) => setEdits((e) => ({ ...e, [l.id]: { ...ed(l), ...patch } }));
  const factQty = (l: PurchaseLine) => {
    const v = num(ed(l).fact_qty);
    return Number.isFinite(v) ? v : Number(l.plan_qty);
  };
  const factPrice = (l: PurchaseLine) => {
    const v = num(ed(l).fact_price);
    return Number.isFinite(v) ? v : Number(l.price);
  };

  const submit = () => {
    setMsg(null);
    const out: object[] = [];
    for (const l of rows) {
      const e = edits[l.id];
      if (!e) continue;
      const b = base(l);
      const fq = e.fact_qty === b.fact_qty ? undefined : e.fact_qty.trim() === '' ? null : num(e.fact_qty);
      const fp = e.fact_price === b.fact_price ? undefined : e.fact_price.trim() === '' ? null : num(e.fact_price);
      const decision = e.agree ? 'agree' : e.reject ? 'reject' : null;
      const note = e.note !== b.note || decision === 'reject' ? e.note.trim() || null : undefined;
      if ((fq != null && !(fq >= 0)) || (fp != null && !(fp >= 0))) return setMsg(`${l.material_name}: fakt miqdor yoki narx noto'g'ri`);
      if (fq === undefined && fp === undefined && note === undefined && !decision) continue;
      out.push({ id: l.id, ...(fq !== undefined && { fact_qty: fq }), ...(fp !== undefined && { fact_price: fp }), ...(decision && { decision }), ...(note !== undefined && { note }) });
    }
    if (!out.length) return setMsg('Munosabatlardan birini tanlang');
    save.mutate(out);
  };

  const marked = rows.filter((l) => ed(l).agree || ed(l).reject).length;
  return (
    <div className="card">
      {bar}
      <ErrorText error={q.error} />
      {!rows.length ? (
        <p className="note">Kelishuvdagi buyurtma yo'q. Xomashyo zakazdan YUBORISH qilingach shu yerga tushadi.</p>
      ) : (
        <div className="sheet-wrap">
          <table className="sheet" style={{ minWidth: 2300 }}>
            <thead>
              <tr>
                <th>Kiritilgan sana</th>
                <th>Buyurtma ID</th>
                <th>Sana</th>
                <th>Yetkazib beruvchi</th>
                <th>Mahsulot</th>
                <th>Xomashyo kodi</th>
                <th>Xomashyo rangi</th>
                <th>Rang kodi</th>
                <th>Razmeri</th>
                <th className="n">Miqdor</th>
                <th className="n">Narx</th>
                <th className="n">Summa</th>
                <th>Valyuta</th>
                <th className="n">Kurs</th>
                <th>Buyurtma statusi</th>
                <th>To'lov statusi</th>
                <th>ETA</th>
                <th>Menejer</th>
                <th className="n">Fakt miqdor</th>
                <th className="n">Fakt narx</th>
                <th className="n">Fakt summa</th>
                <th>Tasdiqlash</th>
                <th>Rad etish</th>
                <th>Munosabat (izoh)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const e = ed(l);
                return (
                  <tr key={l.id} className={e.agree ? 'sel-row' : e.reject ? 'bad-row' : ''}>
                    <td className="mono">{fmtDateTime(l.created_at)}</td>
                    <td className="mono">
                      <button className="btn ghost sm" onClick={() => nav(`/supply/${l.order_id}`)}>
                        {l.partiya_no}
                      </button>
                    </td>
                    <td className="mono">{fmtDate(l.po_date)}</td>
                    <td>{l.supplier_name}</td>
                    <td title={l.for_colors ? `Tovar ranglari: ${l.for_colors}` : undefined}>
                      <b>{l.material_name}</b> <span className="note">{l.stage === 'mato' ? 'mato' : ''}</span>
                    </td>
                    {variantCells(l)}
                    <td className="n">
                      {fmtNum(l.plan_qty)} <span className="note">{l.unit}</span>
                    </td>
                    <td className="n">{plain(l.price)}</td>
                    <td className="n">{money(l.plan_amount)}</td>
                    <td>{cur(l.currency)}</td>
                    <td className="n">{l.currency === 'UZS' ? '' : plain(l.rate)}</td>
                    <td>
                      <StatusPill status={l.status} />
                      {l.reject_reason && <div className="note">{l.reject_reason}</div>}
                    </td>
                    <td>{PAYMENT_STATUS[l.payment_status]}</td>
                    <td className="mono">{l.eta ? fmtDate(l.eta) : ''}</td>
                    <td>{l.manager ?? ''}</td>
                    <td className="n">
                      <input
                        className="cell num"
                        inputMode="decimal"
                        placeholder={plain(l.plan_qty)}
                        value={e.fact_qty}
                        disabled={!write}
                        onChange={(x) => set(l, { fact_qty: x.target.value })}
                        aria-label="Fakt miqdor"
                      />
                    </td>
                    <td className="n">
                      <input
                        className="cell num"
                        inputMode="decimal"
                        placeholder={plain(l.price)}
                        value={e.fact_price}
                        disabled={!write}
                        onChange={(x) => set(l, { fact_price: x.target.value })}
                        aria-label="Fakt narx"
                      />
                    </td>
                    <td className="n">{money(factQty(l) * factPrice(l))}</td>
                    <td>
                      <input type="checkbox" aria-label="Tasdiqlash" checked={e.agree} disabled={!approve} onChange={(x) => set(l, { agree: x.target.checked, reject: false })} />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label="Rad etish"
                        checked={e.reject}
                        disabled={!approve || l.status === 'rejected'}
                        onChange={(x) => set(l, { reject: x.target.checked, agree: false })}
                      />
                    </td>
                    <td>
                      <input
                        className="cell"
                        value={e.note}
                        placeholder={e.reject ? 'rad etish sababi' : ''}
                        disabled={!write && !e.reject}
                        onChange={(x) => set(l, { note: x.target.value })}
                        aria-label="Munosabat"
                      />
                    </td>
                    <td>
                      {write && (
                        <CancelButton id={l.id} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!!rows.length && (
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <span className="note">
            {rows.length} qator · reja summa: {sumBy(rows, (l) => Number(l.plan_amount))} · fakt summa: {sumBy(rows, (l) => factQty(l) * factPrice(l))}
            {marked ? ` · belgilangan: ${marked}` : ''}. Fakt kiritilmasa zakaz qilingan miqdor va narx olinadi.
          </span>
          <div className="row">
            {msg && (
              <span className="err" role="alert">
                {msg}
              </span>
            )}
            <ErrorText error={save.error} />
            {(write || approve) && (
              <button className="btn" disabled={save.isPending} onClick={submit}>
                TASDIQLASH
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CancelButton({ id }: { id: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => api(`/purchases/lines/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['supply'] });
      toast('Qator bekor qilindi');
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  return (
    <button className="btn ghost sm" disabled={m.isPending} onClick={() => confirm('Buyurtma qatori bekor qilinsinmi? Ehtiyoj Xomashyo zakazda qayta ochiladi.') && m.mutate()}>
      Bekor
    </button>
  );
}

/** Sheets «Tasdiqlangan buyurtmalar» */
function Agreed() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['purchases', 'lines', 'agreed'], queryFn: () => api<PurchaseLine[]>(`/purchases/lines?status=${AGREED.join(',')}`) });
  const { rows, bar } = useFilters(q.data);
  return (
    <div className="card">
      {bar}
      <ErrorText error={q.error} />
      {!rows.length ? (
        <p className="note">Tasdiqlangan buyurtma yo'q.</p>
      ) : (
        <div className="sheet-wrap">
          <table className="sheet" style={{ minWidth: 2200 }}>
            <thead>
              <tr>
                <th>Kiritilgan sana</th>
                <th>Buyurtma ID</th>
                <th>Sana</th>
                <th>Yetkazib beruvchi</th>
                <th>Mahsulot</th>
                <th>Xomashyo kodi</th>
                <th>Xomashyo rangi</th>
                <th>Rang kodi</th>
                <th>Razmeri</th>
                <th className="n">Miqdor</th>
                <th className="n">Narx</th>
                <th className="n">Summa</th>
                <th>Valyuta</th>
                <th className="n">Kurs</th>
                <th>Buyurtma statusi</th>
                <th>To'lov statusi</th>
                <th>ETA</th>
                <th>Tracking</th>
                <th>Yetib kelish kuni</th>
                <th>Menejer</th>
                <th>Izoh</th>
                <th className="n">Yo'lga chiqqan</th>
                <th className="n">Qoldiq</th>
                <th>Tasdiqladi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{fmtDateTime(l.created_at)}</td>
                  <td className="mono">
                    <button className="btn ghost sm" onClick={() => nav(`/tracking/${l.order_id}`)}>
                      {l.partiya_no}
                    </button>
                  </td>
                  <td className="mono">{fmtDate(l.po_date)}</td>
                  <td>{l.supplier_name}</td>
                  <td title={l.for_colors ? `Tovar ranglari: ${l.for_colors}` : undefined}>
                    <b>{l.material_name}</b>
                  </td>
                  {variantCells(l)}
                  <td className="n">
                    {fmtNum(l.fact_qty ?? l.plan_qty)} <span className="note">{l.unit}</span>
                  </td>
                  <td className="n">{plain(l.fact_price ?? l.price)}</td>
                  <td className="n">{money(l.fact_amount)}</td>
                  <td>{cur(l.currency)}</td>
                  <td className="n">{l.currency === 'UZS' ? '' : plain(l.rate)}</td>
                  <td>
                    <StatusPill status={l.status} />
                  </td>
                  <td>{PAYMENT_STATUS[l.payment_status]}</td>
                  <td className="mono">{l.eta ? fmtDate(l.eta) : ''}</td>
                  <td>{l.tracking ?? ''}</td>
                  <td className="mono">{l.arrived_date ? fmtDate(l.arrived_date) : ''}</td>
                  <td>{l.manager ?? ''}</td>
                  <td>{l.note ?? ''}</td>
                  <td className="n">{fmtNum(l.shipped_qty)}</td>
                  <td className="n">{Number(l.remaining_qty) ? fmtNum(l.remaining_qty) : <span className="pill good">0</span>}</td>
                  <td>
                    {l.agreed_by_name ?? ''}
                    {l.agreed_at && <div className="note">{fmtDateTime(l.agreed_at)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!!rows.length && (
        <p className="note" style={{ marginTop: 8 }}>
          {rows.length} qator · summa: {sumBy(rows, (l) => Number(l.fact_amount))}
        </p>
      )}
    </div>
  );
}
