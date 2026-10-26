import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtDate, fmtNum, useToast } from '../components/ui';
import { can, type SupplyNeed, type SupplyOrderRow, type SupplyPlan } from '../types';
import { PURCHASE_STATUS } from './Purchases';

const qtyFmt = (v: string | number | null | undefined) => fmtNum(v, 0);
const plain = (v: string | number | null | undefined) => (v == null ? '' : String(Number(v)));

/** Bosqich holati: necha buyurtma, nechtasi kelishilgan */
function StagePill({ pos, agreed }: { pos: number; agreed: number }) {
  if (!pos) return <span className="pill muted">zakaz qilinmagan</span>;
  if (agreed < pos) return <span className="pill warn">kelishuvda ({agreed}/{pos})</span>;
  return <span className="pill good">kelishilgan</span>;
}

export function SupplyPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['supply', 'list'], queryFn: () => api<SupplyOrderRow[]>('/purchases/orders') });
  return (
    <>
      <PageHead title="Xomashyo zakazi" sub="Tasdiqlangan zakazlar: avval asosiy mato, nakladnoydan keyin furnitura" />
      <ErrorText error={q.error} />
      <div className="card">
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Partiya</th>
                <th>Sana</th>
                <th>Tovar</th>
                <th>Korxona</th>
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
                    <StagePill pos={o.mato_pos} agreed={o.mato_agreed} />
                  </td>
                  <td>
                    <StagePill pos={o.furnitura_pos} agreed={o.furnitura_agreed} />
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

function NeedsTable({ rows, waiting }: { rows: SupplyNeed[]; waiting?: boolean }) {
  const nav = useNavigate();
  return (
    <div className="tw">
      <table>
        <thead>
          <tr>
            <th>Rang (mahsulot)</th>
            <th>Postavshik</th>
            <th>Xomashyo</th>
            <th>Rangi / kodi</th>
            <th>Razmer</th>
            <th className="n">Sarf</th>
            <th className="n">Soni</th>
            <th className="n">Kerak</th>
            <th className="n">Narx</th>
            <th>Buyurtma</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.order_material_id}>
              <td>{r.color_name}</td>
              <td>{r.supplier_name ?? <span className="pill bad">tanlanmagan</span>}</td>
              <td>
                <b>{r.material_name}</b>
                {r.material_code && <div className="note mono">{r.material_code}</div>}
              </td>
              <td>
                {r.material_color_name ?? '—'}
                {r.color_code && <div className="note mono">{r.color_code}</div>}
              </td>
              <td className="mono">{r.material_size ?? '—'}</td>
              <td className="n">
                {plain(r.per_unit)} <span className="note">{r.unit}</span>
              </td>
              <td className="n">
                {waiting ? (r.actual_count == null ? <span className="note">fakt kutilmoqda</span> : qtyFmt(r.actual_count)) : qtyFmt(r.plan_count)}
              </td>
              <td className="n">
                {r.qty == null ? '—' : fmtNum(r.qty, 3)} <span className="note">{r.unit}</span>
              </td>
              <td className="n">
                {plain(r.price)} <span className="note">{r.currency}</span>
              </td>
              <td>
                {r.ordered_po_id ? (
                  <button className="btn ghost sm" onClick={() => nav(`/purchases/${r.ordered_po_id}`)}>
                    №{r.ordered_po_id}
                  </button>
                ) : (
                  <span className="pill muted">yo'q</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SupplyOrderPage() {
  const { orderId } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const key = ['supply', 'plan', Number(orderId)];
  const q = useQuery({ queryKey: key, queryFn: () => api<SupplyPlan>(`/purchases/orders/${orderId}`) });
  const create = useMutation({
    mutationFn: (stage: 'mato' | 'furnitura') => api<{ created: number[]; plan: SupplyPlan }>(`/purchases/orders/${orderId}/${stage}`, { method: 'POST' }),
    onSuccess: (r, stage) => {
      qc.setQueryData(key, r.plan);
      qc.invalidateQueries({ queryKey: ['supply', 'list'] });
      qc.invalidateQueries({ queryKey: ['purchases'] });
      toast(`${stage === 'mato' ? 'Mato' : 'Furnitura'}: ${r.created.length} ta postavshikka buyurtma tuzildi`);
    },
  });
  if (q.error) return <ErrorText error={q.error} />;
  const p = q.data;
  if (!p || !me) return null;
  const writable = can.purchaseWrite(me.role);
  return (
    <>
      <PageHead title={`Xomashyo zakazi · partiya ${p.order.partiya_no}`} sub={[p.order.product_type_name, p.order.artikul, p.order.model, p.order.producer_name].filter(Boolean).join(' · ')}>
        <button className="btn ghost" onClick={() => nav(`/orders/${p.order.id}`)}>
          Zakazni ochish
        </button>
        <button className="btn ghost" onClick={() => nav('/supply')}>
          Ro'yxat
        </button>
      </PageHead>
      <ErrorText error={create.error} />

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
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h2>1. Mato zakazi (reja soni bo'yicha)</h2>
          {writable && (
            <button className="btn sm" disabled={!p.can.mato || create.isPending} onClick={() => confirm('Mato zakazi postavshiklarga yuborilsinmi?') && create.mutate('mato')}>
              Mato zakazini yuborish
            </button>
          )}
        </div>
        {p.reasons.mato && <p className="note">{p.reasons.mato}</p>}
        {p.mato.length ? <NeedsTable rows={p.mato} /> : <p className="note">Zakazda asosiy mato belgilanmagan.</p>}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>2. Postavshik buyurtmalari</h2>
        {!p.purchases.length ? (
          <p className="note">Hali buyurtma yo'q.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>№</th>
                  <th>Bosqich</th>
                  <th>Postavshik</th>
                  <th>Sana</th>
                  <th className="n">Qatorlar</th>
                  <th>Holat</th>
                </tr>
              </thead>
              <tbody>
                {p.purchases.map((x) => (
                  <tr key={x.id} className="click" tabIndex={0} onClick={() => nav(`/purchases/${x.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/purchases/${x.id}`)}>
                    <td className="mono">{x.id}</td>
                    <td>{x.stage === 'mato' ? 'Mato' : 'Furnitura'}</td>
                    <td>{x.supplier_name}</td>
                    <td className="mono">{fmtDate(x.po_date)}</td>
                    <td className="n">{x.lines}</td>
                    <td>
                      <span className={`pill ${PURCHASE_STATUS[x.status][1]}`}>{PURCHASE_STATUS[x.status][0]}</span>
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
          <h2>3. Furnitura zakazi (fakt soni bo'yicha)</h2>
          {writable && (
            <button
              className="btn sm"
              disabled={!p.can.furnitura || create.isPending}
              onClick={() => confirm('Furnitura zakazi postavshiklarga yuborilsinmi?') && create.mutate('furnitura')}
            >
              Furnitura zakazini yuborish
            </button>
          )}
        </div>
        {p.reasons.furnitura && <p className="note">{p.reasons.furnitura}</p>}
        {p.furnitura.length ? <NeedsTable rows={p.furnitura} waiting /> : <p className="note">Furnitura yo'q.</p>}
      </div>
    </>
  );
}
