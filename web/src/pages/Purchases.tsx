import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Modal, PageHead, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import { can, type PaymentStatus, type PurchaseDetail, type PurchaseRow, type PurchaseStatus } from '../types';

export const PURCHASE_STATUS: Record<PurchaseStatus, [string, string]> = {
  negotiation: ['Kelishuv', 'warn'],
  rejected: ['Rad etildi', 'bad'],
  preparing: ['Tayyorlanmoqda', 'good'],
  in_transit: ["Yo'lda", 'good'],
  arrived: ['Yetib keldi', 'good'],
  closed: ['Yopildi', 'muted'],
  cancelled: ['Bekor qilindi', 'muted'],
};
export const PAYMENT_STATUS: Record<PaymentStatus, string> = {
  unpaid: "To'lanmagan",
  advance: "Avans to'langan",
  partial: "Qisman to'langan",
  paid: "To'liq to'langan",
};

const money = (v: string | number | null | undefined) => (v == null || v === '' ? '—' : fmtNum(Math.round(Number(v) * 100) / 100, 2));
const plain = (v: string | number | null | undefined) => (v == null ? '' : String(Number(v)));
const num = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));

const TABS: [string, string, PurchaseStatus[] | null][] = [
  ['kelishuv', 'Kelishuv', ['negotiation', 'rejected']],
  ['agreed', 'Kelishilgan', ['preparing', 'in_transit', 'arrived']],
  ['all', 'Hammasi', null],
];

export function PurchasesPage() {
  const nav = useNavigate();
  const [tab, setTab] = useState('kelishuv');
  const q = useQuery({ queryKey: ['purchases', 'list'], queryFn: () => api<PurchaseRow[]>('/purchases') });
  const statuses = TABS.find((t) => t[0] === tab)?.[2];
  const rows = (q.data ?? []).filter((r) => !statuses || statuses.includes(r.status));
  const count = (st: PurchaseStatus[] | null) => (q.data ?? []).filter((r) => !st || st.includes(r.status)).length;
  return (
    <>
      <PageHead title="Postavshik kelishuv" sub="Buyurtmalar: nakladnoy bo'yicha fakt miqdor va narx, tasdiqlash" />
      <div className="tabs" role="tablist">
        {TABS.map(([k, l, st]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l} <span className="pill muted">{count(st)}</span>
          </button>
        ))}
      </div>
      <ErrorText error={q.error} />
      <div className="card">
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>№</th>
                <th>Sana</th>
                <th>Partiya</th>
                <th>Bosqich</th>
                <th>Postavshik</th>
                <th className="n">Qatorlar</th>
                <th className="n">Summa, so'm</th>
                <th>To'lov</th>
                <th>Holat</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="click" tabIndex={0} onClick={() => nav(`/purchases/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/purchases/${r.id}`)}>
                  <td className="mono">
                    <b>{r.id}</b>
                  </td>
                  <td className="mono">{fmtDate(r.po_date)}</td>
                  <td>
                    <b className="mono">{r.partiya_no}</b>
                    <div className="note">{r.product_type_name}</div>
                  </td>
                  <td>{r.stage === 'mato' ? 'Mato' : 'Furnitura'}</td>
                  <td>{r.supplier_name}</td>
                  <td className="n">{r.lines}</td>
                  <td className="n">{money(r.amount_uzs)}</td>
                  <td>{PAYMENT_STATUS[r.payment_status]}</td>
                  <td>
                    <span className={`pill ${PURCHASE_STATUS[r.status][1]}`}>{PURCHASE_STATUS[r.status][0]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {q.data && !rows.length && <p className="note">Bu bo'limda buyurtma yo'q.</p>}
      </div>
    </>
  );
}

function HeaderModal({ d, onClose, onSaved }: { d: PurchaseDetail; onClose: () => void; onSaved: (r: PurchaseDetail, m: string) => void }) {
  const [f, setF] = useState({
    po_date: d.po.po_date,
    manager: d.po.manager ?? '',
    eta: d.po.eta ?? '',
    tracking: d.po.tracking ?? '',
    note: d.po.note ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => api<PurchaseDetail>(`/purchases/${d.po.id}`, { method: 'PATCH', body: { ...f, eta: f.eta || null } }),
    onSuccess: (r) => {
      onSaved(r, 'Saqlandi');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Modal title={`Buyurtma №${d.po.id}`} onClose={onClose}>
      <form className="form one" onSubmit={submit}>
        <div className="form">
          <Field label="Sana">
            <input type="date" value={f.po_date} onChange={set('po_date')} required />
          </Field>
          <Field label="Menejer">
            <input value={f.manager} onChange={set('manager')} maxLength={100} />
          </Field>
          <Field label="ETA (taxminiy yetib kelish)">
            <input type="date" value={f.eta} onChange={set('eta')} />
          </Field>
          <Field label="Tracking">
            <input value={f.tracking} onChange={set('tracking')} maxLength={200} />
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
    </Modal>
  );
}

export function PurchasePage() {
  const { id } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const key = ['purchases', 'detail', Number(id)];
  const q = useQuery({ queryKey: key, queryFn: () => api<PurchaseDetail>(`/purchases/${id}`) });
  const d = q.data;
  const [edit, setEdit] = useState(false);
  const [rows, setRows] = useState<Record<number, { fact_qty: string; fact_price: string }>>({});
  useEffect(() => {
    if (d) setRows(Object.fromEntries(d.lines.map((l) => [l.id, { fact_qty: plain(l.fact_qty), fact_price: plain(l.fact_price) }])));
  }, [d]);
  const onSaved = (r: PurchaseDetail, msg: string) => {
    qc.setQueryData(key, r);
    qc.invalidateQueries({ queryKey: ['purchases', 'list'] });
    qc.invalidateQueries({ queryKey: ['supply'] });
    qc.invalidateQueries({ queryKey: ['orders'] });
    toast(msg);
  };
  const save = useMutation({
    mutationFn: () =>
      api<PurchaseDetail>(`/purchases/${id}/lines`, {
        method: 'PUT',
        body: {
          lines: d!.lines.map((l) => ({
            id: l.id,
            fact_qty: rows[l.id]?.fact_qty ? num(rows[l.id].fact_qty) : null,
            fact_price: rows[l.id]?.fact_price ? num(rows[l.id].fact_price) : null,
          })),
        },
      }),
    onSuccess: (r) => onSaved(r, 'Nakladnoy saqlandi'),
  });
  const act = useMutation({
    mutationFn: (a: { kind: 'agree' | 'cancel' } | { kind: 'reject'; reason: string }) =>
      api<PurchaseDetail>(`/purchases/${id}/${a.kind}`, { method: 'POST', body: a.kind === 'reject' ? { reason: a.reason } : undefined }),
    onSuccess: (r, a) => onSaved(r, a.kind === 'agree' ? 'Kelishuv tasdiqlandi' : a.kind === 'reject' ? 'Rad etildi' : 'Bekor qilindi'),
  });

  if (q.error) return <ErrorText error={q.error} />;
  if (!d || !me) return null;
  const p = d.po;
  const editable = (p.status === 'negotiation' || p.status === 'rejected') && can.purchaseWrite(me.role);
  const dirty = d.lines.some((l) => (rows[l.id]?.fact_qty ?? '') !== plain(l.fact_qty) || (rows[l.id]?.fact_price ?? '') !== plain(l.fact_price));
  return (
    <>
      <PageHead title={`Buyurtma №${p.id} · ${p.supplier_name}`} sub={`${p.stage === 'mato' ? 'Mato' : 'Furnitura'} · partiya ${p.partiya_no} · ${p.product_type_name}`}>
        <span className={`pill ${PURCHASE_STATUS[p.status][1]}`}>{PURCHASE_STATUS[p.status][0]}</span>
        <button className="btn ghost" onClick={() => nav(`/supply/${p.order_id}`)}>
          Xomashyo zakazi
        </button>
        {p.status === 'negotiation' && can.purchaseApprove(me.role) && (
          <>
            <button
              className="btn ghost"
              disabled={act.isPending || dirty}
              onClick={() => {
                const reason = prompt('Rad etish sababi:');
                if (reason) act.mutate({ kind: 'reject', reason });
              }}
            >
              Rad etish
            </button>
            <button
              className="btn"
              disabled={act.isPending || dirty || !d.totals.all_fact}
              title={!d.totals.all_fact ? 'Avval barcha qatorlarga fakt miqdorni kiriting' : dirty ? 'Avval saqlang' : undefined}
              onClick={() => confirm('Nakladnoy bo\'yicha kelishuv tasdiqlansinmi?') && act.mutate({ kind: 'agree' })}
            >
              Tasdiqlash
            </button>
          </>
        )}
        {['negotiation', 'rejected', 'preparing'].includes(p.status) && can.purchaseWrite(me.role) && (
          <button className="btn ghost" disabled={act.isPending} onClick={() => confirm('Buyurtma bekor qilinsinmi?') && act.mutate({ kind: 'cancel' })}>
            Bekor qilish
          </button>
        )}
      </PageHead>
      <ErrorText error={act.error} />
      {p.status === 'rejected' && p.reject_reason && (
        <div className="card warn-box" role="status">
          <div>Rad etilgan: {p.reject_reason}. Nakladnoyni tuzatib saqlasangiz, buyurtma yana kelishuvga qaytadi.</div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>Buyurtma ma'lumotlari</h2>
          {can.purchaseWrite(me.role) && p.status !== 'closed' && p.status !== 'cancelled' && (
            <button className="btn ghost sm" onClick={() => setEdit(true)}>
              Tahrirlash
            </button>
          )}
        </div>
        <dl className="kv">
          <dt>Sana</dt>
          <dd>{fmtDate(p.po_date)}</dd>
          <dt>Postavshik</dt>
          <dd>
            {p.supplier_name}
            {p.supplier_country ? ` (${p.supplier_country})` : ''}
          </dd>
          <dt>Menejer</dt>
          <dd>{p.manager ?? '—'}</dd>
          <dt>ETA</dt>
          <dd>{fmtDate(p.eta)}</dd>
          <dt>Tracking</dt>
          <dd>{p.tracking ?? '—'}</dd>
          <dt>To'lov</dt>
          <dd>{PAYMENT_STATUS[p.payment_status]}</dd>
          <dt>Tuzgan</dt>
          <dd>{p.created_by_name ?? '—'}</dd>
          {p.agreed_at && (
            <>
              <dt>Tasdiqlagan</dt>
              <dd>
                {p.agreed_by_name ?? '—'}, {fmtDateTime(p.agreed_at)}
              </dd>
            </>
          )}
          {p.note && (
            <>
              <dt>Izoh</dt>
              <dd>{p.note}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h2>Qatorlar: reja va nakladnoy (fakt)</h2>
          {editable && (
            <button className="btn sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              Saqlash
            </button>
          )}
        </div>
        <ErrorText error={save.error} />
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Xomashyo</th>
                <th>Rangi / kodi</th>
                <th>Razmer</th>
                <th className="n">Reja miqdor</th>
                <th className="n">Reja narx</th>
                <th className="n">Fakt miqdor</th>
                <th className="n">Fakt narx</th>
                <th className="n">Summa</th>
                <th>Ranglar (mahsulot)</th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => {
                const r = rows[l.id] ?? { fact_qty: '', fact_price: '' };
                const set = (k: 'fact_qty' | 'fact_price') => (e: React.ChangeEvent<HTMLInputElement>) => setRows({ ...rows, [l.id]: { ...r, [k]: e.target.value } });
                return (
                  <tr key={l.id}>
                    <td>
                      <b>{l.material_name}</b>
                      {l.material_code && <div className="note mono">{l.material_code}</div>}
                    </td>
                    <td>
                      {l.material_color_name ?? '—'}
                      {l.color_code && <div className="note mono">{l.color_code}</div>}
                    </td>
                    <td className="mono">{l.material_size ?? '—'}</td>
                    <td className="n">
                      {fmtNum(l.plan_qty, 3)} <span className="note">{l.unit}</span>
                    </td>
                    <td className="n">
                      {plain(l.price)} <span className="note">{l.currency}</span>
                    </td>
                    <td className="n">
                      {editable ? (
                        <input className="num" inputMode="decimal" aria-label={`${l.material_name}: fakt miqdor`} value={r.fact_qty} onChange={set('fact_qty')} />
                      ) : l.fact_qty == null ? (
                        '—'
                      ) : (
                        <b>{fmtNum(l.fact_qty, 3)}</b>
                      )}
                    </td>
                    <td className="n">
                      {editable ? (
                        <input
                          className="num sm"
                          inputMode="decimal"
                          aria-label={`${l.material_name}: fakt narx`}
                          placeholder={plain(l.price)}
                          value={r.fact_price}
                          onChange={set('fact_price')}
                        />
                      ) : (
                        plain(l.fact_price ?? l.price)
                      )}
                    </td>
                    <td className="n">
                      {money(l.fact_amount ?? l.plan_amount)} <span className="note">{l.currency}</span>
                      {l.currency !== 'UZS' && <div className="note">{money(l.amount_uzs)} so'm</div>}
                    </td>
                    <td className="note">
                      {l.sources.map((s) => (
                        <div key={s.color_name}>
                          {s.color_name}: {fmtNum(s.plan_qty, 3)}
                          {s.fact_qty != null && ` → ${fmtNum(s.fact_qty, 3)}`}
                          {s.products != null && (
                            <>
                              {' '}
                              = <b>{fmtNum(s.products)} dona</b>
                            </>
                          )}
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="note">
          Reja jami: {money(d.totals.plan_uzs)} so'm · Fakt jami: {money(d.totals.fact_uzs)} so'm.
          {p.stage === 'mato' && ' Mato bo\'yicha: fakt ÷ sarf = rangdagi yangi mahsulot soni (yuqoriga yaxlitlanadi); tasdiqlangach zakazdagi son o\'zgaradi va furnitura shunga qarab hisoblanadi.'}
          {editable && ' Fakt narx bo\'sh qolsa — reja narxi olinadi.'}
        </p>
      </div>
      {edit && <HeaderModal d={d} onClose={() => setEdit(false)} onSaved={onSaved} />}
    </>
  );
}
