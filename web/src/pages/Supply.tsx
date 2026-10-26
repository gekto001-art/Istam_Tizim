import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtDate, fmtNum, useToast } from '../components/ui';
import { CURRENCIES, can, type PaymentStatus, type PurchaseLine, type Stage, type Supplier, type SupplyNeed, type SupplyOrderRow, type SupplyPlan } from '../types';
import { PAYMENT_STATUS, StatusPill, cur, money, num, plain } from './purchaseUi';

const qtyFmt = (v: string | number | null | undefined) => fmtNum(v, 0);
const STAGES: [Stage, string][] = [
  ['mato', 'Mato (asosiy)'],
  ['furnitura', 'Furnitura'],
];

/** Bosqich holati: nechta qator yuborilgan, nechtasi kelishilgan */
function StagePill({ lines, agreed }: { lines: number; agreed: number }) {
  if (!Number(lines)) return <span className="pill muted">zakaz qilinmagan</span>;
  if (Number(agreed) < Number(lines)) return <span className="pill warn">kelishuvda ({agreed}/{lines})</span>;
  return <span className="pill good">kelishilgan</span>;
}

export function SupplyPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['supply', 'list'], queryFn: () => api<SupplyOrderRow[]>('/purchases/orders') });
  return (
    <>
      <PageHead title="Xomashyo zakaz" sub="Tasdiqlangan zakazlar: avval asosiy mato, postavshik nakladnoyidan keyin furnitura" />
      <ErrorText error={q.error} />
      <div className="card">
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Partiya</th>
                <th>Sana</th>
                <th>Mahsulot</th>
                <th>Ishlab chiqaruvchi</th>
                <th className="n">Reja soni</th>
                <th className="n">Fakt soni</th>
                <th>Mato</th>
                <th>Furnitura</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.map((o) => (
                <tr key={o.id} className="click" tabIndex={0} onClick={() => nav(`/supply/${o.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/supply/${o.id}`)}>
                  <td className="mono">
                    <b>{o.partiya_no}</b>
                  </td>
                  <td className="mono">{fmtDate(o.order_date)}</td>
                  <td>
                    {o.product_type_name}
                    <div className="note">{[o.artikul, o.model].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td>{o.producer_name ?? '—'}</td>
                  <td className="n">{qtyFmt(o.plan_qty)}</td>
                  <td className="n">{o.actual_qty == null ? '—' : qtyFmt(o.actual_qty)}</td>
                  <td>
                    <StagePill lines={o.mato_lines} agreed={o.mato_agreed} />
                  </td>
                  <td>
                    <StagePill lines={o.furnitura_lines} agreed={o.furnitura_agreed} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {q.data && !q.data.length && <p className="note">Tasdiqlangan zakaz yo'q. Innovatsion bo'lim zakazni tasdiqlagach shu yerda chiqadi.</p>}
      </div>
    </>
  );
}

/**
 * "Rang umumiy" qatori: bir postavshikdagi bir xil xomashyo (nomi, rangi, rang kodi, razmeri, narxi) —
 * qaysi mahsulot rang/razmerlaridan yig'ilgani needs'da. Yuborishda miqdor ularga ulush bo'yicha bo'linadi.
 */
interface Group {
  key: string;
  needs: SupplyNeed[];
  need: number; // zakaz bo'yicha kerakli jami (NaN — hali noma'lum)
  on: boolean;
  supplier_id: string;
  qty: string;
  price: string;
  currency: string;
  rate: string;
  payment_status: PaymentStatus;
  eta: string;
  manager: string;
  note: string;
}

function groupsOf(rows: SupplyNeed[]): Group[] {
  const map = new Map<string, Group>();
  for (const r of rows) {
    if (r.ordered_line_id) continue;
    const key = [r.material_id, r.material_color_id, r.color_code, r.material_size, r.supplier_id, Number(r.price), r.currency].join('|');
    const g = map.get(key);
    const q = r.qty == null ? NaN : Number(r.qty);
    if (g) {
      g.needs.push(r);
      g.need += q;
      continue;
    }
    map.set(key, {
      key,
      needs: [r],
      need: q,
      on: true,
      supplier_id: r.supplier_id ? String(r.supplier_id) : '',
      qty: '',
      price: plain(r.price),
      currency: r.currency,
      rate: r.currency === 'UZS' ? '' : plain(r.rate),
      payment_status: 'unpaid',
      eta: '',
      manager: '',
      note: '',
    });
  }
  const isCount = (u: string) => ['Dona', 'Juft', 'Pachka', 'Rulon'].includes(u);
  return [...map.values()].map((g) => {
    const n = isCount(g.needs[0].unit) ? Math.ceil(g.need - 1e-9) : Math.round(g.need * 1000) / 1000;
    return { ...g, need: n, qty: Number.isFinite(n) ? String(n) : '' };
  });
}

/** Miqdorni manbalarga reja ulushida bo'lish (oxirgisi — qoldiq, yig'indi aynan jamiga teng) */
function split(total: number, parts: number[]): number[] {
  const sum = parts.reduce((a, b) => a + b, 0);
  let acc = 0;
  return parts.map((p, i) => {
    if (i === parts.length - 1) return Math.round((total - acc) * 1000) / 1000;
    const v = Math.round(((total * (sum ? p / sum : 1 / parts.length)) * 1000)) / 1000;
    acc += v;
    return v;
  });
}

const variant = (r: { material_color_name: string | null; color_code: string | null; material_size: string | null }) =>
  [r.material_color_name, r.color_code && `kod ${r.color_code}`, r.material_size].filter(Boolean).join(' · ');

export function SupplyOrderPage() {
  const { orderId } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>('mato');
  const [groups, setGroups] = useState<Group[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const key = ['supply', 'plan', Number(orderId)];
  const list = useQuery({ queryKey: ['supply', 'list'], queryFn: () => api<SupplyOrderRow[]>('/purchases/orders') });
  const q = useQuery({ queryKey: key, queryFn: () => api<SupplyPlan>(`/purchases/orders/${orderId}`) });
  const sent = useQuery({
    queryKey: ['purchases', 'lines', 'order', Number(orderId)],
    queryFn: () => api<PurchaseLine[]>(`/purchases/lines?order_id=${orderId}`),
  });
  const suppliers = useQuery({ queryKey: ['catalog', 'suppliers'], queryFn: () => api<Supplier[]>('/suppliers') });
  const p = q.data;
  const rows = useMemo(() => (p ? p[stage] : []), [p, stage]);
  useEffect(() => {
    setGroups(groupsOf(rows));
    setMsg(null);
  }, [rows]);

  const send = useMutation({
    mutationFn: (body: object) => api<{ created: number[]; plan: SupplyPlan }>(`/purchases/orders/${orderId}/send`, { method: 'POST', body }),
    onSuccess: (r) => {
      qc.setQueryData(key, r.plan);
      qc.invalidateQueries({ queryKey: ['supply', 'list'] });
      qc.invalidateQueries({ queryKey: ['purchases'] });
      toast(`${r.created.length} ta qator Postavshik kelishuvga yuborildi`);
    },
  });
  const cancel = useMutation({
    mutationFn: (id: number) => api(`/purchases/lines/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ['supply', 'list'] });
      qc.invalidateQueries({ queryKey: ['purchases'] });
      toast('Qator bekor qilindi');
    },
  });

  if (q.error) return <ErrorText error={q.error} />;
  if (!p || !me) return null;
  const writable = can.purchaseWrite(me.role) && p.can[stage];
  const set = (k: string, patch: Partial<Group>) => setGroups((gs) => gs.map((g) => (g.key === k ? { ...g, ...patch } : g)));
  const chosen = groups.filter((g) => g.on);
  const total = (c: string) => chosen.filter((g) => g.currency === c).reduce((a, g) => a + (num(g.qty) || 0) * (num(g.price) || 0), 0);
  const currencies = [...new Set(chosen.map((g) => g.currency))];
  const stageLines = (sent.data ?? []).filter((l) => l.stage === stage && l.status !== 'cancelled');

  const submit = () => {
    setMsg(null);
    if (!chosen.length) return setMsg('Yuboriladigan qatorni belgilang');
    for (const g of chosen) {
      const name = `${g.needs[0].material_name}${variant(g.needs[0]) ? ` (${variant(g.needs[0])})` : ''}`;
      if (!g.supplier_id) return setMsg(`${name}: yetkazib beruvchini tanlang`);
      if (!(num(g.qty) > 0)) return setMsg(`${name}: miqdorni kiriting`);
      if (!(num(g.price) >= 0)) return setMsg(`${name}: narxni kiriting`);
      if (g.currency !== 'UZS' && g.rate && !(num(g.rate) > 0)) return setMsg(`${name}: kurs noto'g'ri`);
    }
    const out = chosen.flatMap((g) => {
      const parts = split(num(g.qty), g.needs.map((n) => (n.qty == null ? 0 : Number(n.qty))));
      return g.needs.map((n, i) => ({
        order_material_id: n.order_material_id,
        supplier_id: Number(g.supplier_id),
        qty: parts[i],
        price: num(g.price),
        currency: g.currency,
        rate: g.currency === 'UZS' || !g.rate ? null : num(g.rate),
        payment_status: g.payment_status,
        eta: g.eta || null,
        manager: g.manager.trim() || null,
        note: g.note.trim() || null,
      }));
    });
    if (out.some((r) => !(r.qty > 0))) return setMsg('Miqdor juda kichik — bo\'lib bo\'lmaydi');
    if (confirm(`${chosen.length} ta qator postavshikka yuborilsinmi?`)) send.mutate({ stage, rows: out });
  };

  return (
    <>
      <PageHead title="Xomashyo zakaz" sub="Sheets «Xomashyo Zakaz»: ehtiyoj → rang umumiy → YUBORISH (Postavshik kelishuvga tushadi)">
        <button className="btn ghost" onClick={() => nav(`/orders/${p.order.id}`)}>
          Zakazni ochish
        </button>
        <button className="btn ghost" onClick={() => nav('/supply')}>
          Ro'yxat
        </button>
      </PageHead>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form">
          <label className="f">
            Partiya raqam
            <select value={p.order.id} onChange={(e) => nav(`/supply/${e.target.value}`)}>
              {(list.data ?? [{ id: p.order.id, partiya_no: p.order.partiya_no }]).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.partiya_no}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            Xomashyo nomi
            <select value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
              {STAGES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <div className="f">
            Ishlab chiqaruvchi
            <b>{p.order.producer_name ?? '—'}</b>
          </div>
          <div className="f">
            Mahsulot nomi
            <b>{[p.order.product_type_name, p.order.artikul, p.order.model].filter(Boolean).join(' · ')}</b>
          </div>
          <div className="f">
            Boshlanish — tugash
            <span className="v mono">
              {fmtDate(p.order.start_date)} — {fmtDate(p.order.end_date)}
            </span>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Ranglar bo'yicha son</h2>
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Rang</th>
                <th>Asosiy mato</th>
                <th className="n">Reja</th>
                <th className="n">Fakt (nakladnoy bo'yicha)</th>
              </tr>
            </thead>
            <tbody>
              {p.colors.map((c) => (
                <tr key={c.color_id}>
                  <td>{c.color_name}</td>
                  <td>{c.main_material ?? <span className="note">yo'q — son o'zgarmaydi</span>}</td>
                  <td className="n">{qtyFmt(c.plan_count)}</td>
                  <td className="n">{c.actual_count == null ? <span className="pill warn">kutilmoqda</span> : <b>{qtyFmt(c.actual_count)}</b>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Zakaz bo'yicha ehtiyoj · {stage === 'mato' ? 'mato (reja soni × sarf)' : 'furnitura (fakt soni × sarf)'}</h2>
        {!rows.length ? (
          <p className="note">{stage === 'mato' ? 'Zakazda asosiy mato belgilanmagan.' : 'Furnitura yo\'q.'}</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1100 }}>
              <thead>
                <tr>
                  <th>Xomashyo nomi</th>
                  <th>Xomashyo kodi</th>
                  <th>Xomashyo rangi</th>
                  <th>Rang kodi</th>
                  <th>Razmeri</th>
                  <th>Mahsulot rangi</th>
                  <th>Mahsulot razmeri</th>
                  <th className="n">Soni</th>
                  <th className="n">Sarf</th>
                  <th className="n">Miqdor</th>
                  <th>Postavshik</th>
                  <th>Holat</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.order_material_id}>
                    <td>
                      <b>{r.material_name}</b>
                    </td>
                    <td className="mono">{r.material_code ?? ''}</td>
                    <td>{r.material_color_name ?? ''}</td>
                    <td className="mono">{r.color_code ?? ''}</td>
                    <td className="mono">{r.material_size ?? ''}</td>
                    <td>{r.color_name}</td>
                    <td className="mono">{r.size_name ?? 'Hammasi'}</td>
                    <td className="n">
                      {stage === 'mato' ? qtyFmt(r.plan_count) : r.actual_count == null ? <span className="note">kutilmoqda</span> : qtyFmt(r.actual_count)}
                    </td>
                    <td className="n">{plain(r.per_unit)}</td>
                    <td className="n">
                      {r.qty == null ? '—' : fmtNum(r.qty, 0)} <span className="note">{r.unit}</span>
                    </td>
                    <td>{r.supplier_name ?? ''}</td>
                    <td>
                      <StatusPill status={r.ordered_status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h2>Rang umumiy · yuborish</h2>
          {can.purchaseWrite(me.role) && (
            <button className="btn" disabled={!writable || !groups.length || send.isPending} onClick={submit}>
              YUBORISH
            </button>
          )}
        </div>
        {p.reasons[stage] && <div className="banner">{p.reasons[stage]}</div>}
        {msg && <div className="err" role="alert" style={{ marginBottom: 8 }}>{msg}</div>}
        <ErrorText error={send.error} />
        {!groups.length ? (
          <p className="note">Yuboriladigan qator yo'q.</p>
        ) : (
          <>
            <div className="sheet-wrap">
              <table className="sheet">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Hammasini belgilash"
                        checked={groups.every((g) => g.on)}
                        onChange={(e) => setGroups((gs) => gs.map((g) => ({ ...g, on: e.target.checked })))}
                      />
                    </th>
                    <th>Yetkazib beruvchi</th>
                    <th>Mahsulot (xomashyo)</th>
                    <th>Xomashyo kodi</th>
                    <th>Rang umumiy</th>
                    <th>Rang kodi</th>
                    <th>Razmeri</th>
                    <th>Qaysi tovarlarga</th>
                    <th className="n">Umumiy miqdor</th>
                    <th className="n">Miqdor</th>
                    <th className="n">Narx</th>
                    <th className="n">Summa</th>
                    <th>Valyuta</th>
                    <th className="n">Kurs</th>
                    <th>To'lov statusi</th>
                    <th>ETA</th>
                    <th>Menejer</th>
                    <th>Izoh</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const r = g.needs[0];
                    const sum = (num(g.qty) || 0) * (num(g.price) || 0);
                    const dis = !writable;
                    return (
                      <tr key={g.key} className={g.on ? 'sel-row' : ''}>
                        <td>
                          <input type="checkbox" aria-label="Yuborish" checked={g.on} disabled={dis} onChange={(e) => set(g.key, { on: e.target.checked })} />
                        </td>
                        <td>
                          <select value={g.supplier_id} disabled={dis} onChange={(e) => set(g.key, { supplier_id: e.target.value })} aria-label="Yetkazib beruvchi">
                            <option value="">— tanlang —</option>
                            {suppliers.data
                              ?.filter((s) => s.is_active || String(s.id) === g.supplier_id)
                              .map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                          </select>
                        </td>
                        <td>
                          <b>{r.material_name}</b>
                        </td>
                        <td className="mono">{r.material_code ?? ''}</td>
                        <td>{r.material_color_name ?? ''}</td>
                        <td className="mono">{r.color_code ?? ''}</td>
                        <td className="mono">{r.material_size ?? ''}</td>
                        <td title={g.needs.map((n) => `${n.color_name} ${n.size_name ?? ''}`).join(', ')}>
                          {[...new Set(g.needs.map((n) => n.color_name))].join(', ')}
                        </td>
                        <td className="n">
                          {Number.isFinite(g.need) ? fmtNum(g.need, 0) : '—'} <span className="note">{r.unit}</span>
                        </td>
                        <td className="n">
                          <input className="cell num" inputMode="decimal" value={g.qty} disabled={dis} onChange={(e) => set(g.key, { qty: e.target.value })} aria-label="Miqdor" />
                        </td>
                        <td className="n">
                          <input className="cell num" inputMode="decimal" value={g.price} disabled={dis} onChange={(e) => set(g.key, { price: e.target.value })} aria-label="Narx" />
                        </td>
                        <td className="n">{money(sum)}</td>
                        <td>
                          <select value={g.currency} disabled={dis} onChange={(e) => set(g.key, { currency: e.target.value })} aria-label="Valyuta">
                            {Object.entries(CURRENCIES).map(([k, l]) => (
                              <option key={k} value={k}>
                                {l}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="n">
                          {g.currency === 'UZS' ? (
                            '—'
                          ) : (
                            <input className="cell num" inputMode="decimal" placeholder="bugungi" value={g.rate} disabled={dis} onChange={(e) => set(g.key, { rate: e.target.value })} aria-label="Kurs" />
                          )}
                        </td>
                        <td>
                          <select value={g.payment_status} disabled={dis} onChange={(e) => set(g.key, { payment_status: e.target.value as PaymentStatus })} aria-label="To'lov statusi">
                            {Object.entries(PAYMENT_STATUS).map(([k, l]) => (
                              <option key={k} value={k}>
                                {l}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input className="cell" type="date" value={g.eta} disabled={dis} onChange={(e) => set(g.key, { eta: e.target.value })} aria-label="ETA" />
                        </td>
                        <td>
                          <input className="cell" value={g.manager} disabled={dis} onChange={(e) => set(g.key, { manager: e.target.value })} aria-label="Menejer" />
                        </td>
                        <td>
                          <input className="cell" value={g.note} disabled={dis} onChange={(e) => set(g.key, { note: e.target.value })} aria-label="Izoh" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ marginTop: 8 }}>
              Belgilangan: {chosen.length} qator ·{' '}
              {currencies.map((c) => `${money(total(c))} ${cur(c)}`).join(' + ') || '—'}. Bir postavshikdagi bir xil xomashyo bitta qatorga yig'iladi;
              miqdor mahsulot ranglariga ehtiyoj ulushida bo'linadi.
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h2>Yuborilgan buyurtmalar · {stage === 'mato' ? 'mato' : 'furnitura'}</h2>
        <ErrorText error={cancel.error} />
        {!stageLines.length ? (
          <p className="note">Hali yuborilmagan.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Sana</th>
                  <th>Yetkazib beruvchi</th>
                  <th>Xomashyo</th>
                  <th>Tovar ranglari</th>
                  <th className="n">Miqdor</th>
                  <th className="n">Fakt</th>
                  <th className="n">Narx</th>
                  <th>Holat</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {stageLines.map((l) => (
                  <tr key={l.id}>
                    <td className="mono">{fmtDate(l.po_date)}</td>
                    <td>{l.supplier_name}</td>
                    <td>
                      <b>{l.material_name}</b>
                      <div className="note">{variant(l)}</div>
                    </td>
                    <td>{l.for_colors}</td>
                    <td className="n">
                      {fmtNum(l.plan_qty)} <span className="note">{l.unit}</span>
                    </td>
                    <td className="n">{l.fact_qty == null ? '—' : fmtNum(l.fact_qty)}</td>
                    <td className="n">
                      {plain(l.fact_price ?? l.price)} <span className="note">{cur(l.currency)}</span>
                    </td>
                    <td>
                      <StatusPill status={l.status} />
                      {l.reject_reason && <div className="note">{l.reject_reason}</div>}
                    </td>
                    <td>
                      {can.purchaseWrite(me.role) && ['negotiation', 'rejected', 'preparing'].includes(l.status) && (
                        <button
                          className="btn ghost sm"
                          disabled={cancel.isPending}
                          onClick={() => confirm('Qator bekor qilinsinmi? Ehtiyoj qayta yuborish uchun ochiladi.') && cancel.mutate(l.id)}
                        >
                          Bekor
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
