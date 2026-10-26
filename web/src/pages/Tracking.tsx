import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import { can, type PaymentStatus, type PurchaseStatus, type TrackingDetail, type TrackingOrder } from '../types';
import { PAYMENT_STATUS, PURCHASE_STATUS, StatusPill, TRACKING_SUGGEST, cur, money, num, plain } from './purchaseUi';

const TRACK_STATUSES: PurchaseStatus[] = ['preparing', 'in_transit', 'arrived', 'closed'];
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Sheets «Status o'zgartirish»: Buyurtma ID tanlanadi → buyurtma statusi, to'lov statusi, tracking;
 * yo'lga chiqqan miqdor kiritilsa — yo'lga chiqish sanasi majburiy, qoldiq kamayadi («Yo'lga chiqqan buyurtmalar»).
 */
export function TrackingPage() {
  const { orderId } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['purchases', 'tracking', 'list'], queryFn: () => api<TrackingOrder[]>('/purchases/tracking') });
  const id = orderId ? Number(orderId) : null;
  const key = ['purchases', 'tracking', id];
  const d = useQuery({ queryKey: key, queryFn: () => api<TrackingDetail>(`/purchases/tracking/${id}`), enabled: !!id });

  const [status, setStatus] = useState<PurchaseStatus | ''>('');
  const [payment, setPayment] = useState<PaymentStatus | ''>('');
  const [tracking, setTracking] = useState('');
  const [shipDate, setShipDate] = useState(today());
  const [eta, setEta] = useState('');
  const [arrived, setArrived] = useState('');
  const [qty, setQty] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const first = d.data?.lines.find((l) => l.status !== 'closed') ?? d.data?.lines[0];
    setStatus('');
    setPayment(first?.payment_status ?? '');
    setTracking(first?.tracking ?? '');
    setEta(first?.eta?.slice(0, 10) ?? '');
    setArrived('');
    setQty({});
    setMsg(null);
  }, [d.data]);

  const save = useMutation({
    mutationFn: (body: object) => api<TrackingDetail>(`/purchases/tracking/${id}`, { method: 'POST', body }),
    onSuccess: (r) => {
      qc.setQueryData(key, r);
      qc.invalidateQueries({ queryKey: ['purchases', 'tracking', 'list'] });
      qc.invalidateQueries({ queryKey: ['purchases', 'lines'] });
      toast('Status saqlandi');
    },
  });
  if (!me) return null;
  const write = can.purchaseWrite(me.role);
  const lines = d.data?.lines ?? [];
  const open = (l: (typeof lines)[number]) => l.status !== 'closed' && Number(l.remaining_qty) > 0;

  const submit = () => {
    setMsg(null);
    if (!id) return setMsg('Buyurtma ID ni tanlang');
    if (!status) return setMsg('Buyurtma statusini tanlang');
    if (!payment) return setMsg("To'lov statusini tanlang");
    if (!tracking.trim()) return setMsg('Trackingni tanlang');
    const shipments: { line_id: number; qty: number }[] = [];
    for (const l of lines) {
      const s = qty[l.id];
      if (s == null || s.trim() === '') continue;
      const v = num(s);
      if (!(v > 0)) return setMsg(`${l.material_name}: yo'lga chiqqan miqdor noto'g'ri`);
      if (v > Number(l.remaining_qty) + 1e-9) return setMsg(`${l.material_name}: yo'lga chiqqan miqdor qoldiqdan (${fmtNum(l.remaining_qty)}) ko'p`);
      shipments.push({ line_id: l.id, qty: v });
    }
    if (shipments.length && !shipDate) return setMsg("Yo'lga chiqish sanasini tanlang");
    save.mutate({
      status,
      payment_status: payment,
      tracking: tracking.trim(),
      ship_date: shipments.length ? shipDate : null,
      eta: eta || null,
      arrived_date: arrived || null,
      shipments,
    });
  };

  const fillAll = () => setQty(Object.fromEntries(lines.filter(open).map((l) => [l.id, plain(l.remaining_qty)])));
  const previous = [...new Set([...TRACKING_SUGGEST, ...lines.map((l) => l.tracking).filter((t): t is string => !!t)])];

  return (
    <>
      <PageHead title="Status o'zgartirish" sub="Sheets «Status o'zgartirish»: buyurtma va to'lov statusi, tracking, yo'lga chiqqan miqdor va qoldiq" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form">
          <label className="f">
            Buyurtma ID
            <select value={id ?? ''} onChange={(e) => nav(e.target.value ? `/tracking/${e.target.value}` : '/tracking')}>
              <option value="">Buyurtma ID ni tanlang</option>
              {list.data?.map((o) => (
                <option key={o.order_id} value={o.order_id}>
                  {o.partiya_no} · {o.product_type_name} · qoldiq {fmtNum(o.remaining_qty)}
                </option>
              ))}
              {id && !list.data?.some((o) => o.order_id === id) && lines[0] && <option value={id}>{lines[0].partiya_no} (yopilgan)</option>}
            </select>
          </label>
          <label className="f">
            Buyurtma statusi
            <select value={status} disabled={!write} onChange={(e) => setStatus(e.target.value as PurchaseStatus)}>
              <option value="">— tanlang —</option>
              {TRACK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PURCHASE_STATUS[s][0]}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            To'lov statusi
            <select value={payment} disabled={!write} onChange={(e) => setPayment(e.target.value as PaymentStatus)}>
              <option value="">— tanlang —</option>
              {Object.entries(PAYMENT_STATUS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            Tracking
            <input list="tracking-suggest" value={tracking} disabled={!write} onChange={(e) => setTracking(e.target.value)} placeholder="Bojxona, Abu Saxiy…" />
            <datalist id="tracking-suggest">
              {previous.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="f">
            Yo'lga chiqish sanasi
            <input type="date" value={shipDate} disabled={!write} onChange={(e) => setShipDate(e.target.value)} />
          </label>
          <label className="f">
            ETA (taxminiy yetib kelish)
            <input type="date" value={eta} disabled={!write} onChange={(e) => setEta(e.target.value)} />
          </label>
          {(status === 'arrived' || status === 'closed') && (
            <label className="f">
              Yetib kelish kuni
              <input type="date" value={arrived} disabled={!write} onChange={(e) => setArrived(e.target.value)} placeholder="bugun" />
            </label>
          )}
        </div>
        {write && id && (
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            {msg && (
              <span className="err" role="alert">
                {msg}
              </span>
            )}
            <ErrorText error={save.error} />
            <button className="btn" disabled={save.isPending || !lines.length} onClick={submit}>
              SAQLASH
            </button>
          </div>
        )}
        <p className="note" style={{ marginTop: 8 }}>
          To'lov statusi, tracking va ETA partiyaning barcha qatorlariga yoziladi. Buyurtma statusi — miqdor kiritilgan qatorlarga (miqdor kiritilmasa — hammasiga).
        </p>
      </div>

      {!id ? (
        <div className="card">
          <p className="note">
            {list.data && !list.data.length ? "Kelishilgan, yopilmagan buyurtma yo'q." : 'Yuqorida Buyurtma ID (partiya) ni tanlang.'}
          </p>
        </div>
      ) : (
        <>
          <ErrorText error={d.error} />
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <h2>Buyurtma qatorlari</h2>
              {write && lines.some(open) && (
                <button className="btn ghost sm" onClick={fillAll}>
                  Hammasi to'liq yo'lga chiqdi
                </button>
              )}
            </div>
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
                    <th className="n">Prixod bo'lishi kerak</th>
                    <th className="n">Yo'lga chiqqan miqdor</th>
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
                    <th className="n">Qoldiq miqdor</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className={qty[l.id] ? 'sel-row' : ''}>
                      <td className="mono">{fmtDateTime(l.created_at)}</td>
                      <td className="mono">{l.partiya_no}</td>
                      <td className="mono">{fmtDate(l.po_date)}</td>
                      <td>{l.supplier_name}</td>
                      <td title={l.for_colors ? `Tovar ranglari: ${l.for_colors}` : undefined}>
                        <b>{l.material_name}</b>
                      </td>
                      <td className="mono">{l.material_code ?? ''}</td>
                      <td>{l.material_color_name ?? ''}</td>
                      <td className="mono">{l.color_code ?? ''}</td>
                      <td className="mono">{l.material_size ?? ''}</td>
                      <td className="n">
                        {fmtNum(l.fact_qty ?? l.plan_qty)} <span className="note">{l.unit}</span>
                      </td>
                      <td className="n">
                        {open(l) ? (
                          <input
                            className="cell num"
                            inputMode="decimal"
                            value={qty[l.id] ?? ''}
                            disabled={!write}
                            placeholder={Number(l.shipped_qty) ? fmtNum(l.shipped_qty) : ''}
                            onChange={(e) => setQty((x) => ({ ...x, [l.id]: e.target.value }))}
                            aria-label="Yo'lga chiqqan miqdor"
                          />
                        ) : (
                          fmtNum(l.shipped_qty)
                        )}
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
                      <td className="n">
                        <b>{fmtNum(Math.max(0, Number(l.remaining_qty) - (num(qty[l.id] ?? '') || 0)))}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h2>Yo'lga chiqqan buyurtmalar</h2>
            {!d.data?.shipments.length ? (
              <p className="note">Hali yo'lga chiqmagan.</p>
            ) : (
              <div className="sheet-wrap">
                <table className="sheet" style={{ minWidth: 1300 }}>
                  <thead>
                    <tr>
                      <th>Kiritilgan sana</th>
                      <th>Yo'lga chiqqan sana</th>
                      <th>Buyurtma ID</th>
                      <th>Buyurtma sana</th>
                      <th>Yetkazib beruvchi</th>
                      <th>Mahsulot</th>
                      <th>Kodi · rangi · razmeri</th>
                      <th className="n">Soni</th>
                      <th className="n">Narx</th>
                      <th className="n">Summa</th>
                      <th>Valyuta</th>
                      <th className="n">So'mda</th>
                      <th>Kiritdi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.data.shipments.map((s) => (
                      <tr key={s.id}>
                        <td className="mono">{fmtDateTime(s.created_at)}</td>
                        <td className="mono">{fmtDate(s.ship_date)}</td>
                        <td className="mono">{s.partiya_no}</td>
                        <td className="mono">{fmtDate(s.po_date)}</td>
                        <td>{s.supplier_name}</td>
                        <td>
                          <b>{s.material_name}</b>
                        </td>
                        <td>{[s.material_code, s.material_color_name, s.color_code && `kod ${s.color_code}`, s.material_size].filter(Boolean).join(' · ')}</td>
                        <td className="n">{fmtNum(s.qty)}</td>
                        <td className="n">{plain(s.price)}</td>
                        <td className="n">{money(s.amount)}</td>
                        <td>{cur(s.currency)}</td>
                        <td className="n">{money(s.amount_uzs)}</td>
                        <td>{s.created_by_name ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
