import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtNum, useToast } from '../components/ui';
import { can, type OrderRow, type Producer, type StockBalance, type ZayavkaDetail, type ZayavkaItem, type ZayavkaOrder } from '../types';
import { useCatalog } from './Orders';
import { money, num, plain } from './purchaseUi';
import { DestSelect, ITEM_HEADS, ItemCells, MovesJournal, SubmitBar, destParse, itemKey, itemLabel, itemRef, today, useStockInvalidate } from './stockUi';

/** Sheets "Farq": ombordagi qoldiq − shu hujjatdagi shu xomashyo chiqimi (vozvratda qo'shiladi) */
function farqOf(stock: number, sameItemQty: number, out: boolean) {
  return Math.round((out ? stock - sameItemQty : stock + sameItemQty) * 1000) / 1000;
}
const useBalance = () => useQuery({ queryKey: ['stock', 'balance', 'all'], queryFn: () => api<StockBalance[]>('/stock/balance?all=true') });

// ---------- Rasxod (Zayavka) ----------
export function ZayavkaPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useStockInvalidate();
  const [orderId, setOrderId] = useState('');
  const [docDate, setDocDate] = useState(today());
  const [op, setOp] = useState<'peremesheniya' | 'vozvrat'>('peremesheniya');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [dest, setDest] = useState<Record<string, string>>({});
  const [allDest, setAllDest] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const orders = useQuery({ queryKey: ['stock', 'zayavka'], queryFn: () => api<ZayavkaOrder[]>('/stock/zayavka') });
  const d = useQuery({ queryKey: ['stock', 'zayavka', orderId], queryFn: () => api<ZayavkaDetail>(`/stock/zayavka/${orderId}`), enabled: !!orderId });
  const producers = useCatalog<Producer>('producers');
  useEffect(() => {
    // Sheets'dagidek: Miqdor = partiya bo'yicha berilishi kerak bo'lgan qoldiq
    setQty(Object.fromEntries((d.data?.items ?? []).map((i) => [itemKey(i), Number(i.left_qty) > 0 ? plain(i.left_qty) : ''])));
    setDest({});
    setMsg(null);
  }, [d.data]);
  const save = useMutation({
    mutationFn: (body: object) => api<{ id: number }>('/stock/rasxod', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      toast(`Rasxod №${r.id} saqlandi`);
    },
  });
  if (!me) return null;
  const write = can.stockWrite(me.role);
  const out = op === 'peremesheniya';
  const items = d.data?.items ?? [];
  const q = (i: ZayavkaItem) => num(qty[itemKey(i)] ?? '');
  const destOf = (i: ZayavkaItem) => dest[itemKey(i)] ?? allDest;
  const farq = (i: ZayavkaItem) => farqOf(Number(i.stock), q(i) || 0, out);
  const bad = (i: ZayavkaItem) => (qty[itemKey(i)] ? !(q(i) > 0) || !destOf(i) || farq(i) < 0 : false);
  const chosen = items.filter((i) => q(i) > 0);

  const submit = () => {
    setMsg(null);
    if (!docDate) return setMsg('Sanani kiriting');
    if (!orderId) return setMsg('Qaysi zakaz uchunligini tanlang');
    if (!chosen.length) return setMsg('Miqdor kiriting');
    const b = items.find(bad);
    if (b) return setMsg(`${itemLabel(b)}: ${!destOf(b) ? 'qayergaligini tanlang' : farq(b) < 0 ? 'omborda yetarli emas (Farq manfiy)' : 'miqdor noto\'g\'ri'}`);
    save.mutate({
      kind: 'rasxod_zayavka',
      doc_date: docDate,
      op,
      order_id: Number(orderId),
      rows: chosen.map((i) => ({ ...itemRef(i), qty: q(i), ...destParse(destOf(i)) })),
    });
  };

  return (
    <>
      <PageHead title="Rasxod (Zayavka)" sub="Partiya uchun kroy yoki tsexga peremesheniya; vozvrat — ishlab chiqarishdan omborga qaytarish" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form">
          <label className="f">
            Sana
            <input type="date" value={docDate} disabled={!write} onChange={(e) => setDocDate(e.target.value)} />
          </label>
          <label className="f">
            Qaysi zakaz uchun
            <select
              value={orderId}
              onChange={(e) => {
                setOrderId(e.target.value);
                const o = orders.data?.find((x) => String(x.order_id) === e.target.value);
                setAllDest(o ? 'kroy' : '');
              }}
            >
              <option value="">— tanlang —</option>
              {orders.data?.map((o) => (
                <option key={o.order_id} value={o.order_id}>
                  {o.partiya_no} · {o.product_type_name}
                  {o.producer_name ? ` · ${o.producer_name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            Operatsiya turi
            <select value={op} disabled={!write} onChange={(e) => setOp(e.target.value as 'peremesheniya' | 'vozvrat')}>
              <option value="peremesheniya">Peremesheniya</option>
              <option value="vozvrat">Vozvrat (omborga qaytarish)</option>
            </select>
          </label>
          <label className="f">
            Qayergaligi (hammasiga)
            <DestSelect value={allDest} onChange={(v) => { setAllDest(v); setDest({}); }} producers={producers.data} disabled={!write} />
          </label>
        </div>
        {orders.data && !orders.data.length && <p className="note" style={{ marginTop: 8 }}>Omborda partiyaga tegishli qoldiq yo'q. Avval «Prixod (Ta'minot orqali)» kiritiladi.</p>}
      </div>

      {orderId && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Partiya {d.data?.order.partiya_no ?? ''} xomashyosi</h2>
          <ErrorText error={d.error} />
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1600 }}>
              <thead>
                <tr>
                  {ITEM_HEADS.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                  <th>O'lchov birligi</th>
                  <th className="n">Partiyaga kelgan</th>
                  <th className="n">Berilgan</th>
                  <th className="n">Berishi kerak</th>
                  <th className="n">Miqdor</th>
                  <th className="n">Narxi (o'rtacha)</th>
                  <th className="n">Summasi</th>
                  <th>Qayergaligi</th>
                  <th className="n">Ostatka</th>
                  <th className="n">Farq</th>
                  <th>Natija</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const k = itemKey(i);
                  return (
                    <tr key={k} className={bad(i) ? 'bad-row' : q(i) > 0 ? 'sel-row' : ''}>
                      <ItemCells i={i} />
                      <td>{i.unit}</td>
                      <td className="n">{fmtNum(i.received)}</td>
                      <td className="n">{fmtNum(i.issued)}</td>
                      <td className="n">
                        <b>{fmtNum(i.left_qty)}</b>
                      </td>
                      <td className="n">
                        <input className="cell num" inputMode="decimal" value={qty[k] ?? ''} disabled={!write} onChange={(e) => setQty((x) => ({ ...x, [k]: e.target.value }))} aria-label="Miqdor" />
                      </td>
                      <td className="n">{i.avg_cost == null ? '—' : money(i.avg_cost)}</td>
                      <td className="n">{q(i) > 0 && i.avg_cost != null ? money(q(i) * Number(i.avg_cost)) : ''}</td>
                      <td>
                        <DestSelect value={destOf(i)} onChange={(v) => setDest((x) => ({ ...x, [k]: v }))} producers={producers.data} disabled={!write} />
                      </td>
                      <td className="n">{fmtNum(i.stock)}</td>
                      <td className="n">{q(i) > 0 ? fmtNum(farq(i)) : ''}</td>
                      <td>{bad(i) ? <span className="pill bad">X</span> : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {write && (
            <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
              {chosen.length} qator · summa {money(chosen.reduce((a, i) => a + q(i) * Number(i.avg_cost ?? 0), 0))} so'm (o'rtacha tannarxda). Miqdori bo'sh qatorlar o'tkazilmaydi.
            </SubmitBar>
          )}
        </div>
      )}

      <MovesJournal kind="rasxod_zayavka" />
    </>
  );
}

// ---------- Rasxod va Sotuv: ombordagi xomashyodan tanlab ----------
interface Line {
  key: string;
  qty: string;
  price: string;
}
const emptyLine = (): Line => ({ key: '', qty: '', price: '' });

function ItemLines({ lines, onChange, balance, out, withPrice, disabled }: { lines: Line[]; onChange: (l: Line[]) => void; balance: StockBalance[]; out: boolean; withPrice: boolean; disabled: boolean }) {
  const byKey = new Map(balance.map((b) => [itemKey(b), b]));
  const set = (i: number, patch: Partial<Line>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const sameQty = (key: string) => lines.filter((l) => l.key === key).reduce((a, l) => a + (num(l.qty) || 0), 0);
  return (
    <>
      <div className="sheet-wrap">
        <table className="sheet" style={{ minWidth: 1100 }}>
          <thead>
            <tr>
              <th>Xomashyo (nomi · kodi · rangi · rang kodi · razmeri)</th>
              <th>O'lchov</th>
              <th className="n">Miqdori</th>
              <th className="n">{withPrice ? 'Narxi' : "Narxi (o'rtacha)"}</th>
              <th className="n">Summasi</th>
              <th className="n">Ostatka</th>
              <th className="n">Farq</th>
              <th>Natija</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const b = byKey.get(l.key);
              const q = num(l.qty);
              const price = withPrice ? num(l.price) : Number(b?.avg_cost ?? 0);
              const farq = b ? farqOf(Number(b.qty), sameQty(l.key), out) : NaN;
              const bad = l.key || l.qty ? !b || !(q > 0) || (withPrice && !(price >= 0)) || farq < 0 : false;
              return (
                <tr key={i} className={bad ? 'bad-row' : ''}>
                  <td>
                    <select value={l.key} disabled={disabled} onChange={(e) => set(i, { key: e.target.value })} aria-label="Xomashyo" style={{ maxWidth: 420 }}>
                      <option value="">—</option>
                      {balance
                        .filter((x) => !out || Number(x.qty) > 0 || itemKey(x) === l.key)
                        .map((x) => (
                          <option key={itemKey(x)} value={itemKey(x)}>
                            {itemLabel(x)} — {fmtNum(x.qty)} {x.unit}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td>{b?.unit ?? ''}</td>
                  <td className="n">
                    <input className="cell num" inputMode="decimal" value={l.qty} disabled={disabled} onChange={(e) => set(i, { qty: e.target.value })} aria-label="Miqdori" />
                  </td>
                  <td className="n">
                    {withPrice ? (
                      <input className="cell num" inputMode="decimal" value={l.price} disabled={disabled} onChange={(e) => set(i, { price: e.target.value })} aria-label="Narxi" />
                    ) : b?.avg_cost == null ? (
                      ''
                    ) : (
                      money(b.avg_cost)
                    )}
                  </td>
                  <td className="n">{q > 0 && Number.isFinite(price) ? money(q * price) : ''}</td>
                  <td className="n">{b ? fmtNum(b.qty) : ''}</td>
                  <td className="n">{b && q > 0 ? fmtNum(farq) : ''}</td>
                  <td>{bad ? <span className="pill bad">X</span> : ''}</td>
                  <td>
                    {!disabled && lines.length > 1 && (
                      <button className="x" aria-label="Qatorni o'chirish" onClick={() => onChange(lines.filter((_, k) => k !== i))}>
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
      {!disabled && (
        <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => onChange([...lines, emptyLine()])}>
          + qator
        </button>
      )}
    </>
  );
}

/** Qatorlarni tekshirish va serverga tayyorlash */
function linesBody(lines: Line[], balance: StockBalance[], out: boolean, withPrice: boolean): { error: string } | { rows: object[] } {
  const byKey = new Map(balance.map((b) => [itemKey(b), b]));
  const filled = lines.filter((l) => l.key || l.qty);
  if (!filled.length) return { error: 'Xomashyo tanlang' };
  const sum = new Map<string, number>();
  for (const l of filled) {
    const b = byKey.get(l.key);
    if (!b) return { error: 'Qatorda xomashyo tanlanmagan' };
    if (!(num(l.qty) > 0)) return { error: `${itemLabel(b)}: miqdorni kiriting` };
    if (withPrice && !(num(l.price) >= 0)) return { error: `${itemLabel(b)}: narxni kiriting` };
    sum.set(l.key, (sum.get(l.key) ?? 0) + num(l.qty));
  }
  if (out) for (const [k, q] of sum) if (farqOf(Number(byKey.get(k)!.qty), q, true) < 0) return { error: `${itemLabel(byKey.get(k)!)}: omborda yetarli emas (Farq manfiy)` };
  return { rows: filled.map((l) => ({ ...itemRef(byKey.get(l.key)!), qty: num(l.qty), ...(withPrice && { price: num(l.price) }) })) };
}

export function RasxodPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useStockInvalidate();
  const [docDate, setDocDate] = useState(today());
  const [orderId, setOrderId] = useState('');
  const [destV, setDestV] = useState('');
  const [op, setOp] = useState<'peremesheniya' | 'vozvrat'>('peremesheniya');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine(), emptyLine()]);
  const [msg, setMsg] = useState<string | null>(null);
  const balance = useBalance();
  const producers = useCatalog<Producer>('producers');
  const orders = useQuery({ queryKey: ['orders', 'list', 'confirmed'], queryFn: () => api<OrderRow[]>('/orders?status=confirmed'), enabled: !!me && can.ordersRead(me.role) });
  const save = useMutation({
    mutationFn: (body: object) => api<{ id: number }>('/stock/rasxod', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      setLines([emptyLine(), emptyLine(), emptyLine()]);
      toast(`Rasxod №${r.id} saqlandi`);
    },
  });
  if (!me) return null;
  const write = can.stockWrite(me.role);
  const out = op === 'peremesheniya';
  const submit = () => {
    setMsg(null);
    if (!docDate) return setMsg('Sanani kiriting');
    if (!destV) return setMsg('Qayergaligini tanlang');
    const r = linesBody(lines, balance.data ?? [], out, false);
    if ('error' in r) return setMsg(r.error);
    save.mutate({ kind: 'rasxod', doc_date: docDate, op, order_id: orderId ? Number(orderId) : null, rows: r.rows.map((x) => ({ ...x, ...destParse(destV) })) });
  };
  return (
    <>
      <PageHead title="Rasxod" sub="Ombordan chiqim (peremesheniya) yoki qaytarish — o'rtacha tannarxda" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form">
          <label className="f">
            Sana
            <input type="date" value={docDate} disabled={!write} onChange={(e) => setDocDate(e.target.value)} />
          </label>
          <label className="f">
            Qaysi zakaz uchun (ixtiyoriy)
            <select value={orderId} disabled={!write} onChange={(e) => setOrderId(e.target.value)}>
              <option value="">—</option>
              {orders.data?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.partiya_no} · {o.product_type_name}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            Qayergaligi
            <DestSelect value={destV} onChange={setDestV} producers={producers.data} disabled={!write} />
          </label>
          <label className="f">
            Operatsiya turi
            <select value={op} disabled={!write} onChange={(e) => setOp(e.target.value as 'peremesheniya' | 'vozvrat')}>
              <option value="peremesheniya">Peremesheniya</option>
              <option value="vozvrat">Vozvrat (omborga qaytarish)</option>
            </select>
          </label>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Xomashyo</h2>
        <ErrorText error={balance.error} />
        <ItemLines lines={lines} onChange={setLines} balance={balance.data ?? []} out={out} withPrice={false} disabled={!write} />
        {write && <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit} />}
      </div>
      <MovesJournal kind="rasxod" />
    </>
  );
}

export function SotuvPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useStockInvalidate();
  const [docDate, setDocDate] = useState(today());
  const [client, setClient] = useState('');
  const [op, setOp] = useState<'sotuv' | 'vozvrat'>('sotuv');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine(), emptyLine()]);
  const [msg, setMsg] = useState<string | null>(null);
  const balance = useBalance();
  const producers = useCatalog<Producer>('producers');
  const save = useMutation({
    mutationFn: (body: object) => api<{ id: number }>('/stock/sotuv', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      setLines([emptyLine(), emptyLine(), emptyLine()]);
      toast(`Sotuv №${r.id} saqlandi`);
    },
  });
  if (!me) return null;
  const write = can.stockWrite(me.role);
  const out = op === 'sotuv';
  const submit = () => {
    setMsg(null);
    if (!docDate) return setMsg('Sanani kiriting');
    if (!client.trim()) return setMsg('Qayergaligini (mijozni) kiriting');
    const r = linesBody(lines, balance.data ?? [], out, true);
    if ('error' in r) return setMsg(r.error);
    save.mutate({ doc_date: docDate, op, counterparty: client.trim(), rows: r.rows });
  };
  return (
    <>
      <PageHead title="Sotuv" sub="Xomashyoni sotish yoki sotuvdan qaytarish" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form">
          <label className="f">
            Sana
            <input type="date" value={docDate} disabled={!write} onChange={(e) => setDocDate(e.target.value)} />
          </label>
          <label className="f">
            Qayergaligi (mijoz)
            <input list="sotuv-clients" value={client} disabled={!write} onChange={(e) => setClient(e.target.value)} />
            <datalist id="sotuv-clients">
              {producers.data?.map((p) => (
                <option key={p.id} value={p.name} />
              ))}
            </datalist>
          </label>
          <label className="f">
            Operatsiya turi
            <select value={op} disabled={!write} onChange={(e) => setOp(e.target.value as 'sotuv' | 'vozvrat')}>
              <option value="sotuv">Sotuv</option>
              <option value="vozvrat">Vozvrat</option>
            </select>
          </label>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Xomashyo</h2>
        <ErrorText error={balance.error} />
        <ItemLines lines={lines} onChange={setLines} balance={balance.data ?? []} out={out} withPrice disabled={!write} />
        {write && <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit} />}
      </div>
      <MovesJournal kind="sotuv" />
    </>
  );
}
