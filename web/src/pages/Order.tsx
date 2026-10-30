import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Modal, PageHead, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import { can, type Color, type OrderDetail, type Producer, type Size } from '../types';
import { CopyFromOrderModal } from './CopyFromOrder';
import { MaterialsSheet } from './MaterialsSheet';
import { ORDER_STATUS, OrderHeaderForm, useCatalog } from './Orders';

const num = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));
/** Pul — 2 kasr xonagacha yaxlitlab */
const money = (v: string | number | null | undefined) => (v == null || v === '' ? '—' : fmtNum(Math.round(Number(v) * 100) / 100, 2));
const qtyFmt = (v: string | number | null | undefined) => fmtNum(v, 0);
/** "0.5800" → "0.58" (ortiqcha nollarsiz) */
const plain = (v: string | number | null | undefined) => (v == null ? '' : String(Number(v)));

type Save = (d: OrderDetail, msg: string) => void;

// ---------- Razmer × rang jadvali ----------
function MatrixCard({ d, editable, onSaved }: { d: OrderDetail; editable: boolean; onSaved: Save }) {
  const sizes = useCatalog<Size>('sizes');
  const colors = useCatalog<Color>('colors');
  const init = () => ({
    sizes: [...new Set(d.items.map((i) => i.size_id))],
    colors: [...new Set(d.items.map((i) => i.color_id))],
    qty: Object.fromEntries(d.items.map((i) => [`${i.size_id}:${i.color_id}`, String(i.qty)])) as Record<string, string>,
  });
  const [st, setSt] = useState(init);
  useEffect(() => setSt(init()), [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const sizeName = (id: number) => sizes.data?.find((s) => s.id === id)?.name ?? `#${id}`;
  const colorName = (id: number) => colors.data?.find((c) => c.id === id)?.name ?? `#${id}`;
  const sortedSizes = [...st.sizes].sort((a, b) => {
    const sa = sizes.data?.find((s) => s.id === a);
    const sb = sizes.data?.find((s) => s.id === b);
    return (sa?.sort ?? 0) - (sb?.sort ?? 0) || (sa?.name ?? '').localeCompare(sb?.name ?? '');
  });
  const q = (s: number, c: number) => num(st.qty[`${s}:${c}`] ?? '') || 0;
  // fakt mato kelgandan keyingi son (razmerlarga bo'lingan)
  const actual = new Map(d.items.map((i) => [`${i.size_id}:${i.color_id}`, i.actual_qty]));
  const hasActual = d.items.some((i) => i.actual_qty != null);
  const fakt = (s: number, c: number) => actual.get(`${s}:${c}`);
  const rowSum = (s: number) => st.colors.reduce((a, c) => a + q(s, c), 0);
  const colSum = (c: number) => st.sizes.reduce((a, s) => a + q(s, c), 0);
  const total = st.sizes.reduce((a, s) => a + rowSum(s), 0);
  const dirty = JSON.stringify(init()) !== JSON.stringify(st);

  const m = useMutation({
    mutationFn: () => {
      const items = st.sizes.flatMap((s) => st.colors.map((c) => ({ size_id: s, color_id: c, qty: q(s, c) }))).filter((i) => i.qty > 0);
      return api<OrderDetail>(`/orders/${d.order.id}/items`, { method: 'PUT', body: { items } });
    },
    onSuccess: (r) => onSaved(r, 'Jadval saqlandi'),
  });

  const freeSizes = (sizes.data ?? []).filter((s) => s.is_active && !st.sizes.includes(s.id));
  const freeColors = (colors.data ?? []).filter((c) => c.is_active && !st.colors.includes(c.id));
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h2>Razmer × rang (dona)</h2>
        {editable && (
          <div className="row">
            <select aria-label="Razmer qo'shish" value="" onChange={(e) => e.target.value && setSt({ ...st, sizes: [...st.sizes, Number(e.target.value)] })}>
              <option value="">+ razmer</option>
              {freeSizes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select aria-label="Rang qo'shish" value="" onChange={(e) => e.target.value && setSt({ ...st, colors: [...st.colors, Number(e.target.value)] })}>
              <option value="">+ rang</option>
              {freeColors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="btn sm" disabled={!dirty || m.isPending} onClick={() => m.mutate()}>
              Saqlash
            </button>
          </div>
        )}
      </div>
      <ErrorText error={m.error} />
      {!st.sizes.length || !st.colors.length ? (
        <p className="note">{editable ? 'Yuqoridan razmer va ranglarni qo\'shing, so\'ng kataklarga miqdorni yozing.' : 'Jadval bo\'sh.'}</p>
      ) : (
        <div className="tw">
          <table className="matrix">
            <thead>
              <tr>
                <th>Razmer</th>
                {st.colors.map((c) => (
                  <th key={c} className="n">
                    {colorName(c)}
                    {editable && (
                      <button
                        className="x"
                        aria-label={`${colorName(c)} rangini olib tashlash`}
                        onClick={() => setSt({ ...st, colors: st.colors.filter((x) => x !== c) })}
                      >
                        ×
                      </button>
                    )}
                  </th>
                ))}
                <th className="n">Jami</th>
              </tr>
            </thead>
            <tbody>
              {sortedSizes.map((s) => (
                <tr key={s}>
                  <td>
                    <b>{sizeName(s)}</b>
                    {editable && (
                      <button className="x" aria-label={`${sizeName(s)} razmerini olib tashlash`} onClick={() => setSt({ ...st, sizes: st.sizes.filter((x) => x !== s) })}>
                        ×
                      </button>
                    )}
                  </td>
                  {st.colors.map((c) => (
                    <td key={c} className="n">
                      {editable ? (
                        <input
                          className="num sm"
                          inputMode="numeric"
                          aria-label={`${sizeName(s)}, ${colorName(c)}`}
                          value={st.qty[`${s}:${c}`] ?? ''}
                          onChange={(e) => setSt({ ...st, qty: { ...st.qty, [`${s}:${c}`]: e.target.value.replace(/[^\d]/g, '') } })}
                        />
                      ) : (
                        <>
                          {qtyFmt(q(s, c) || null)}
                          {fakt(s, c) != null && fakt(s, c) !== q(s, c) && <div className="fakt">fakt {qtyFmt(fakt(s, c))}</div>}
                        </>
                      )}
                    </td>
                  ))}
                  <td className="n">
                    <b>{qtyFmt(rowSum(s))}</b>
                  </td>
                </tr>
              ))}
              <tr className="total">
                <td>Jami</td>
                {st.colors.map((c) => (
                  <td key={c} className="n">
                    {qtyFmt(colSum(c))}
                  </td>
                ))}
                <td className="n">
                  <b>{qtyFmt(total)}</b>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {dirty && editable && <p className="note">O'zgarishlar saqlanmagan.</p>}
      {hasActual && (
        <p className="note">
          "fakt" — postavshik nakladnoyidagi mato bo'yicha qayta hisoblangan son (fakt ÷ sarf, yuqoriga; razmerlarga reja ulushida). Jami fakt:{' '}
          <b>{qtyFmt(d.totals.actual_qty)}</b>
        </p>
      )}
    </div>
  );
}

// ---------- Ish narxlari ----------
function WorksCard({ d, editable, onSaved }: { d: OrderDetail; editable: boolean; onSaved: Save }) {
  const producers = useCatalog<Producer>('producers');
  const init = () => d.works.map((w) => ({ producer_id: String(w.producer_id), price: plain(w.price) }));
  const [rows, setRows] = useState(init);
  useEffect(() => setRows(init()), [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(rows) !== JSON.stringify(init());
  const m = useMutation({
    mutationFn: () =>
      api<OrderDetail>(`/orders/${d.order.id}/works`, {
        method: 'PUT',
        body: { works: rows.filter((r) => r.producer_id).map((r) => ({ producer_id: Number(r.producer_id), price: r.price ? num(r.price) : 0 })) },
      }),
    onSuccess: (r) => onSaved(r, 'Ish narxlari saqlandi'),
  });
  const sum = rows.reduce((a, r) => a + (r.price ? num(r.price) || 0 : 0), 0);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h2>Ish narxlari (1 dona uchun)</h2>
        {editable && (
          <div className="row">
            <button className="btn ghost sm" onClick={() => setRows([...rows, { producer_id: '', price: '' }])}>
              + qator
            </button>
            <button className="btn sm" disabled={!dirty || m.isPending} onClick={() => m.mutate()}>
              Saqlash
            </button>
          </div>
        )}
      </div>
      <ErrorText error={m.error} />
      {!rows.length && <p className="note">Kroy, tikuv va boshqa ishlar narxi. {editable && '"+ qator" bilan qo\'shing.'}</p>}
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ marginBottom: 6 }}>
          {editable ? (
            <>
              <select
                aria-label="Korxona / ish"
                value={r.producer_id}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, producer_id: e.target.value } : x)))}
              >
                <option value="">—</option>
                {(producers.data ?? [])
                  .filter((p) => p.is_active || String(p.id) === r.producer_id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <input
                className="num"
                inputMode="decimal"
                aria-label="Narx"
                value={r.price}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))}
              />
              <span className="note">so'm</span>
              <button className="btn ghost sm" aria-label="Qatorni o'chirish" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                ×
              </button>
            </>
          ) : (
            <span>
              {d.works[i]?.producer_name}: <b className="mono">{money(r.price)}</b> so'm
            </span>
          )}
        </div>
      ))}
      {rows.length > 0 && <p className="note">Jami 1 donaga: {money(sum)} so'm</p>}
    </div>
  );
}

// ---------- Sotuv bo'limiga narx (ichki narx) ----------
function SalePriceCard({ d, editable, onSaved }: { d: OrderDetail; editable: boolean; onSaved: Save }) {
  const init = () => ({ p1: plain(d.order.sale_price1), p2: plain(d.order.sale_price2) });
  const [v, setV] = useState(init);
  useEffect(() => setV(init()), [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = v.p1 !== init().p1 || v.p2 !== init().p2;
  const parse = (s: string) => (s.trim() === '' ? null : num(s));
  const bad = [v.p1, v.p2].some((s) => s.trim() !== '' && !(num(s) >= 0));
  const m = useMutation({
    mutationFn: () => api<OrderDetail>(`/orders/${d.order.id}/sale-price`, { method: 'PUT', body: { sale_price1: parse(v.p1), sale_price2: parse(v.p2) } }),
    onSuccess: (r) => onSaved(r, 'Sotuv bo\'limiga narx saqlandi'),
  });
  const unit = d.totals.qty > 0 ? (Number(d.totals.material_uzs) + Number(d.totals.work_uzs)) / d.totals.qty : null;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h2>Sotuv bo'limiga narx (1 dona)</h2>
        {editable && (
          <button className="btn sm" disabled={!dirty || bad || m.isPending} onClick={() => m.mutate()}>
            Saqlash
          </button>
        )}
      </div>
      <ErrorText error={m.error} />
      <div className="row" style={{ gap: 18 }}>
        {(
          [
            ['p1', '1 sort'],
            ['p2', '2 sort'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="row">
            <span>{label}</span>
            {editable ? <input className="num" inputMode="decimal" aria-label={`${label} narxi`} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /> : <b className="mono">{money(v[k] || null)}</b>}
            <span className="note">so'm</span>
          </label>
        ))}
      </div>
      <p className="note" style={{ marginTop: 8 }}>
        Ishlab chiqarish tayyor mahsulotni Sotuv bo'limiga shu narxda o'tkazadi. Narx belgilanmaguncha o'tkazma yuborilmaydi; o'zgartirilsa avval yuborilganlarga ta'sir qilmaydi.
        {unit != null && v.p1 && num(v.p1) >= 0 && ` Rejadagi tannarx ${money(unit)} → 1 sort ustamasi ${money(num(v.p1) - unit)} so'm.`}
      </p>
    </div>
  );
}

// ---------- Hisob: rang bo'yicha tannarx va kerakli xomashyo ----------
function SummaryCard({ d }: { d: OrderDetail }) {
  const material = Number(d.totals.material_uzs);
  const work = Number(d.totals.work_uzs);
  return (
    <>
      <div className="cards" style={{ marginBottom: 14 }}>
        <div className="card stat">
          <span className="note">Jami mahsulot</span>
          <b>{qtyFmt(d.totals.qty)} dona</b>
          {d.totals.actual_qty != null && <span className="note">fakt (matoga qarab): {qtyFmt(d.totals.actual_qty)}</span>}
        </div>
        <div className="card stat">
          <span className="note">Xomashyo (reja)</span>
          <b>{money(material)}</b>
        </div>
        <div className="card stat">
          <span className="note">Ish haqi (reja)</span>
          <b>{money(work)}</b>
        </div>
        <div className="card stat">
          <span className="note">Jami tannarx (reja)</span>
          <b>{money(material + work)}</b>
          {d.totals.qty > 0 && <span className="note">1 donaga o'rtacha {money((material + work) / d.totals.qty)}</span>}
        </div>
      </div>
      {d.by_color.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Rang bo'yicha tannarx (1 dona, so'm)</h2>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Rang</th>
                  <th className="n">Soni</th>
                  <th className="n">Fakt soni</th>
                  <th className="n">Xomashyo</th>
                  <th className="n">Ish</th>
                  <th className="n">Tannarx</th>
                  <th className="n">Jami</th>
                </tr>
              </thead>
              <tbody>
                {d.by_color.map((c) => (
                  <tr key={c.color_id}>
                    <td>{c.color_name}</td>
                    <td className="n">{qtyFmt(c.qty)}</td>
                    <td className="n">{c.actual_qty == null ? '—' : qtyFmt(c.actual_qty)}</td>
                    <td className="n">{money(c.material_cost)}</td>
                    <td className="n">{money(c.work_cost)}</td>
                    <td className="n">
                      <b>{money(c.unit_cost)}</b>
                    </td>
                    <td className="n">{money(c.total_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {d.needs.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Kerakli xomashyo (ta'minot uchun)</h2>
          <p className="note">Barcha ranglar bo'yicha yig'ilgan: sarf × mahsulot soni. Zakaz tasdiqlangach shu ro'yxat xomashyo zakaziga o'tadi.</p>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Postavshik</th>
                  <th>Xomashyo</th>
                  <th>Rangi / kodi</th>
                  <th>Razmer</th>
                  <th className="n">Miqdor</th>
                  <th className="n">Narx</th>
                  <th className="n">Summa</th>
                  <th className="n">So'mda</th>
                  <th>Qaysi ranglar uchun</th>
                </tr>
              </thead>
              <tbody>
                {d.needs.map((n, i) => (
                  <tr key={i}>
                    <td>{n.supplier_name ?? '—'}</td>
                    <td>
                      <b>{n.material_name}</b>
                      {n.material_code && <div className="note mono">{n.material_code}</div>}
                      {!n.from_us && <span className="pill muted">korxonadan</span>}
                    </td>
                    <td>
                      {n.material_color_name ?? '—'}
                      {n.color_code && <div className="note mono">{n.color_code}</div>}
                    </td>
                    <td className="mono">{n.material_size ?? '—'}</td>
                    <td className="n">
                      {fmtNum(n.total_qty, 3)} <span className="note">{n.unit}</span>
                    </td>
                    <td className="n">
                      {plain(n.price)} <span className="note">{n.currency}</span>
                    </td>
                    <td className="n">
                      {money(n.total_amount)} <span className="note">{n.currency}</span>
                    </td>
                    <td className="n">{money(n.total_uzs)}</td>
                    <td className="note">{n.for_colors}</td>
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

export function OrderPage() {
  const { id } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const key = useMemo(() => ['orders', 'detail', Number(id)], [id]);
  const q = useQuery({ queryKey: key, queryFn: () => api<OrderDetail>(`/orders/${id}`) });
  const [editHeader, setEditHeader] = useState(false);
  const [copyFrom, setCopyFrom] = useState(false);
  const onSaved: Save = (data, msg) => {
    qc.setQueryData(key, data);
    qc.invalidateQueries({ queryKey: ['orders', 'list'] });
    toast(msg);
  };
  const act = useMutation({
    mutationFn: (a: 'confirm' | 'reopen' | 'cancel') => api<OrderDetail>(`/orders/${id}/${a}`, { method: 'POST' }),
    onSuccess: (r, a) => onSaved(r, a === 'confirm' ? 'Zakaz tasdiqlandi' : a === 'reopen' ? 'Zakaz qoralamaga qaytdi' : 'Zakaz bekor qilindi'),
  });
  const del = useMutation({
    mutationFn: () => api(`/orders/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders', 'list'] });
      toast('Zakaz o\'chirildi');
      nav('/orders');
    },
  });

  if (q.error) return <ErrorText error={q.error} />;
  const d = q.data;
  if (!d || !me) return null;
  const o = d.order;
  const editable = o.status === 'draft' && can.ordersWrite(me.role);
  return (
    <>
      <PageHead title={`Partiya ${o.partiya_no} · ${o.product_type_name}`} sub={[o.artikul, o.model, o.season].filter(Boolean).join(' · ')}>
        <span className={`pill ${ORDER_STATUS[o.status][1]}`}>{ORDER_STATUS[o.status][0]}</span>
        <button className="btn ghost" onClick={() => nav('/orders')}>
          Zakazlar
        </button>
        {o.status === 'draft' && can.ordersConfirm(me.role) && (
          <button className="btn" disabled={act.isPending} onClick={() => confirm('Zakaz tasdiqlansinmi? Kerakli xomashyo ta\'minotga o\'tadi.') && act.mutate('confirm')}>
            Tasdiqlash
          </button>
        )}
        {o.status !== 'draft' && can.ordersReopen(me.role) && (
          <button className="btn ghost" disabled={act.isPending} onClick={() => act.mutate('reopen')}>
            Qoralamaga qaytarish
          </button>
        )}
        {o.status !== 'cancelled' && can.ordersReopen(me.role) && (
          <button className="btn ghost" disabled={act.isPending} onClick={() => confirm('Zakaz bekor qilinsinmi?') && act.mutate('cancel')}>
            Bekor qilish
          </button>
        )}
      </PageHead>
      <ErrorText error={act.error ?? del.error} />

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>Zakaz ma'lumotlari</h2>
          {editable && (
            <div className="row">
              <button className="btn sm" onClick={() => setCopyFrom(true)}>
                Oldingi zakazdan olish…
              </button>
              <button className="btn ghost sm" onClick={() => setEditHeader(true)}>
                Tahrirlash
              </button>
              <button className="btn ghost sm" disabled={del.isPending} onClick={() => confirm('Qoralama zakaz butunlay o\'chirilsinmi?') && del.mutate()}>
                O'chirish
              </button>
            </div>
          )}
        </div>
        <dl className="kv">
          <dt>Sana</dt>
          <dd>{fmtDate(o.order_date)}</dd>
          <dt>Qaysi korxonaga</dt>
          <dd>{o.producer_name ?? '—'}</dd>
          <dt>Kim zakaz bergani</dt>
          <dd>{o.ordered_by ?? '—'}</dd>
          <dt>Muddat</dt>
          <dd>{o.start_date ? `${fmtDate(o.start_date)} – ${fmtDate(o.end_date)}` : '—'}</dd>
          <dt>O'lchov birligi</dt>
          <dd>{o.unit}</dd>
          <dt>Kiritgan</dt>
          <dd>{o.created_by_name ?? '—'}</dd>
          {o.confirmed_at && (
            <>
              <dt>Tasdiqlagan</dt>
              <dd>
                {o.confirmed_by_name ?? '—'}, {fmtDateTime(o.confirmed_at)}
              </dd>
            </>
          )}
          {o.note && (
            <>
              <dt>Izoh</dt>
              <dd>{o.note}</dd>
            </>
          )}
        </dl>
      </div>

      {d.warnings.length > 0 && o.status === 'draft' && (
        <div className="card warn-box" role="status">
          {d.warnings.map((w) => (
            <div key={w}>⚠ {w}</div>
          ))}
        </div>
      )}

      <MatrixCard d={d} editable={editable} onSaved={onSaved} />
      <MaterialsSheet d={d} editable={editable} onSaved={onSaved} />
      <WorksCard d={d} editable={editable} onSaved={onSaved} />
      <SummaryCard d={d} />
      <SalePriceCard d={d} editable={o.status !== 'cancelled' && can.ordersPrice(me.role)} onSaved={onSaved} />

      {copyFrom && (
        <CopyFromOrderModal
          d={d}
          onClose={() => setCopyFrom(false)}
          onDone={(r) => {
            const { copy, ...detail } = r;
            onSaved(
              detail,
              `Olindi: ${copy.lines} ta xomashyo qatori, ${copy.works} ta ish narxi${copy.items ? `, ${copy.items} ta katak` : ''}${
                copy.skipped ? ` (${copy.skipped} ta razmer qatori mos kelmadi)` : ''
              }`,
            );
            setCopyFrom(false);
          }}
        />
      )}
      {editHeader && (
        <Modal title="Zakaz ma'lumotlari" onClose={() => setEditHeader(false)}>
          <OrderHeaderForm
            order={o}
            onDone={(r) => {
              onSaved(r, 'Saqlandi');
              setEditHeader(false);
            }}
          />
        </Modal>
      )}
    </>
  );
}
