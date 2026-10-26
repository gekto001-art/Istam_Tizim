import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Modal, PageHead, fmtDate, fmtNum, useToast } from '../components/ui';
import { can, SEASONS, type Order, type OrderDetail, type OrderRow, type OrderStatus, type Producer, type ProductType } from '../types';

export const ORDER_STATUS: Record<OrderStatus, [string, string]> = {
  draft: ['Qoralama', 'warn'],
  confirmed: ['Tasdiqlangan', 'good'],
  cancelled: ['Bekor qilingan', 'muted'],
};

/** Ma'lumotnoma (faqat faol yozuvlar + tanlangan eski qiymat ko'rinishi uchun hammasi). */
export function useCatalog<T>(path: string) {
  return useQuery({ queryKey: ['catalog', path], queryFn: () => api<T[]>(`/${path}`) });
}

const today = () => new Date().toISOString().slice(0, 10);

/** Zakaz sarlavhasi: yangi zakaz yoki qoralamani tahrirlash. */
export function OrderHeaderForm({ order, onDone }: { order?: Order; onDone: (d: OrderDetail) => void }) {
  const types = useCatalog<ProductType>('product-types');
  const producers = useCatalog<Producer>('producers');
  const [f, setF] = useState({
    partiya_no: order?.partiya_no ?? '',
    order_date: order?.order_date ?? today(),
    product_type_id: order ? String(order.product_type_id) : '',
    artikul: order?.artikul ?? '',
    model: order?.model ?? '',
    season: order?.season ?? '',
    producer_id: order?.producer_id ? String(order.producer_id) : '',
    ordered_by: order?.ordered_by ?? '',
    start_date: order?.start_date ?? '',
    end_date: order?.end_date ?? '',
    note: order?.note ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => {
      const body = {
        ...f,
        product_type_id: Number(f.product_type_id),
        producer_id: f.producer_id ? Number(f.producer_id) : null,
        season: f.season || null,
        start_date: f.start_date || null,
        end_date: f.end_date || null,
      };
      return api<OrderDetail>(order ? `/orders/${order.id}` : '/orders', { method: order ? 'PATCH' : 'POST', body });
    },
    onSuccess: onDone,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  const activeOr = <T extends { id: number; is_active: boolean }>(list: T[] | undefined, cur: string) =>
    (list ?? []).filter((x) => x.is_active || String(x.id) === cur);
  return (
    <form className="form one" onSubmit={submit}>
      <div className="form">
        <Field label="Partiya raqami">
          <input value={f.partiya_no} onChange={set('partiya_no')} required maxLength={30} autoFocus />
        </Field>
        <Field label="Sana">
          <input type="date" value={f.order_date} onChange={set('order_date')} required />
        </Field>
        <Field label="Tovar nomi">
          <select value={f.product_type_id} onChange={set('product_type_id')} required>
            <option value="">—</option>
            {activeOr(types.data, f.product_type_id).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Mavsum">
          <select value={f.season} onChange={set('season')}>
            <option value="">—</option>
            {SEASONS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Artikul">
          <input value={f.artikul} onChange={set('artikul')} maxLength={100} />
        </Field>
        <Field label="Model">
          <input value={f.model} onChange={set('model')} maxLength={100} />
        </Field>
        <Field label="Qaysi korxonaga">
          <select value={f.producer_id} onChange={set('producer_id')}>
            <option value="">—</option>
            {activeOr(producers.data, f.producer_id).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kim zakaz bergani">
          <input value={f.ordered_by} onChange={set('ordered_by')} maxLength={100} />
        </Field>
        <Field label="Muddat boshi">
          <input type="date" value={f.start_date} onChange={set('start_date')} />
        </Field>
        <Field label="Muddat oxiri">
          <input type="date" value={f.end_date} min={f.start_date || undefined} onChange={set('end_date')} />
        </Field>
      </div>
      <Field label="Izoh">
        <input value={f.note} onChange={set('note')} maxLength={1000} />
      </Field>
      <ErrorText error={m.error} />
      <div className="actions">
        <button className="btn" disabled={m.isPending}>
          Saqlash
        </button>
      </div>
    </form>
  );
}

export function OrdersPage() {
  const { me } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (q.trim()) params.set('q', q.trim());
  const list = useQuery({ queryKey: ['orders', 'list', status, q.trim()], queryFn: () => api<OrderRow[]>(`/orders?${params}`) });
  return (
    <>
      <PageHead title="Zakazlar" sub="Innovatsion bo'lim: partiya, razmer × rang, xomashyo normasi">
        <input placeholder="Partiya, artikul, model" aria-label="Qidirish" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Holat" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Barcha holatlar</option>
          {Object.entries(ORDER_STATUS).map(([k, [l]]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        {me && can.ordersWrite(me.role) && (
          <button className="btn" onClick={() => setCreating(true)}>
            Yangi zakaz
          </button>
        )}
      </PageHead>
      <ErrorText error={list.error} />
      <div className="card">
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Partiya</th>
                <th>Sana</th>
                <th>Tovar</th>
                <th>Artikul / model</th>
                <th>Korxona</th>
                <th className="n">Soni</th>
                <th>Muddat</th>
                <th>Holat</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.map((o) => (
                <tr key={o.id} className="click" tabIndex={0} onClick={() => nav(`/orders/${o.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/orders/${o.id}`)}>
                  <td className="mono">
                    <b>{o.partiya_no}</b>
                  </td>
                  <td className="mono">{fmtDate(o.order_date)}</td>
                  <td>
                    {o.product_type_name}
                    {o.season && <div className="note">{o.season}</div>}
                  </td>
                  <td>
                    {o.artikul ?? '—'}
                    <div className="note">{o.model ?? ''}</div>
                  </td>
                  <td>{o.producer_name ?? '—'}</td>
                  <td className="n">
                    {fmtNum(o.qty)}
                    <div className="note">{o.colors} rang</div>
                  </td>
                  <td className="mono">{o.start_date ? `${fmtDate(o.start_date)} – ${fmtDate(o.end_date)}` : '—'}</td>
                  <td>
                    <span className={`pill ${ORDER_STATUS[o.status][1]}`}>{ORDER_STATUS[o.status][0]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.data && !list.data.length && <p className="note">Zakaz yo'q. "Yangi zakaz" bilan partiya oching.</p>}
      </div>
      {creating && (
        <Modal title="Yangi zakaz (partiya)" onClose={() => setCreating(false)}>
          <OrderHeaderForm
            onDone={(d) => {
              qc.invalidateQueries({ queryKey: ['orders'] });
              toast('Zakaz ochildi — endi razmer × rang jadvalini to\'ldiring');
              nav(`/orders/${d.order.id}`);
            }}
          />
        </Modal>
      )}
    </>
  );
}
