import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Modal, PageHead, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import {
  can,
  type InvoiceKind,
  type PayMethod,
  type SalesAgent,
  type SalesClient,
  type SalesClientLedger,
  type SalesInvoice,
  type SalesProduct,
  type WholesaleReport,
} from '../types';
import { WalletSelect, useMeta } from './Cash';
import { money, num } from './purchaseUi';
import { label, useSalesInvalidate, useStock } from './SalesStock';
import { SubmitBar, today } from './stockUi';

/** Agentlar va ulgurji savdo: nakladnoy (sotuv / vozvrat), mijozlar va nasiya, agent hisoboti */
const W = '/sales/ulgurji';
const KIND: Record<InvoiceKind, string> = { sale: 'Sotuv', return: 'Vozvrat' };
const METHOD: Record<PayMethod, string> = { naqd: 'Naqd', plastik: 'Plastik', bank: 'Bank (o\'tkazma)' };
const useAgents = () => useQuery({ queryKey: ['sales', 'agents'], queryFn: () => api<SalesAgent[]>(`${W}/agents`) });
const useClients = () => useQuery({ queryKey: ['sales', 'clients'], queryFn: () => api<SalesClient[]>(`${W}/clients`) });

function AgentSelect({ value, onChange, all = '—' }: { value: string; onChange: (v: string) => void; all?: string }) {
  const q = useAgents();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Agent">
      <option value="">{all}</option>
      {q.data?.filter((a) => a.is_active || String(a.id) === value).map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

// ---------- Nakladnoy ----------
type Line = { product_id: number; qty: string; price: string };

function InvoiceItems({ d }: { d: SalesInvoice }) {
  return (
    <div className="tw">
      <table>
        <thead>
          <tr>
            <th>Tovar</th>
            <th className="n">Soni</th>
            <th className="n">Narx</th>
            <th className="n">Summa</th>
            <th className="n">Tannarx</th>
          </tr>
        </thead>
        <tbody>
          {d.items.map((i) => (
            <tr key={i.product_id}>
              <td>{label(i)}</td>
              <td className="n">{fmtNum(i.qty)}</td>
              <td className="n">{money(i.price)}</td>
              <td className="n">{money(i.qty * Number(i.price))}</td>
              <td className="n">{money(i.qty * Number(i.unit_cost))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WholesaleInvoicePage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useSalesInvalidate();
  const [kind, setKind] = useState<InvoiceKind>('sale');
  const [docDate, setDocDate] = useState(today());
  const [client, setClient] = useState('');
  const [agent, setAgent] = useState('');
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [find, setFind] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<InvoiceKind | 'all'>('all');
  const [open, setOpen] = useState<number | null>(null);
  const stock = useStock();
  const clients = useClients();
  const list = useQuery({ queryKey: ['sales', 'invoices', filter], queryFn: () => api<SalesInvoice[]>(`${W}/invoices?kind=${filter}`) });
  const save = useMutation({
    mutationFn: (body: object) => api<SalesInvoice>(`${W}/invoices`, { method: 'POST', body }),
    onSuccess: (d) => {
      inv();
      setLines([]);
      setNote('');
      toast(`${KIND[d.kind]} nakladnoy №${d.id}: ${fmtNum(d.qty)} dona, ${money(d.amount_uzs)} so'm`);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`${W}/invoices/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => {
      inv();
      toast(`Nakladnoy №${id} o'chirildi`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  if (!me) return null;
  const write = can.salesWholesale(me.role);
  const products = new Map((stock.data?.rows ?? []).map((p) => [p.id, p]));
  const cl = clients.data?.find((c) => String(c.id) === client);
  const usable = (p: SalesProduct) => (kind === 'sale' ? p.is_active && p.qty > 0 : p.sold > 0) && !lines.some((l) => l.product_id === p.id);
  const needle = find.trim().toLowerCase();
  const found = needle ? (stock.data?.rows ?? []).filter((p) => usable(p) && `${label(p)} ${p.barcode ?? ''}`.toLowerCase().includes(needle)).slice(0, 30) : [];
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const lineBad = (l: Line) => {
    const q = num(l.qty);
    const p = products.get(l.product_id);
    if (!Number.isInteger(q) || q <= 0 || !(num(l.price) >= 0)) return true;
    return kind === 'sale' && !!p && q > p.qty;
  };
  const total = lines.reduce((a, l) => a + (lineBad(l) ? 0 : num(l.qty) * num(l.price)), 0);
  const cost = lines.reduce((a, l) => a + (lineBad(l) ? 0 : num(l.qty) * Number(products.get(l.product_id)?.avg_cost ?? 0)), 0);

  const submit = () => {
    setMsg(null);
    if (!docDate) return setMsg('Sanani kiriting');
    if (!client) return setMsg('Mijozni tanlang');
    if (!lines.length) return setMsg('Tovar qo\'shing');
    const bad = lines.find(lineBad);
    if (bad) return setMsg(`${label(products.get(bad.product_id)!)}: son yoki narx noto'g'ri (skladdagidan ko'p bo'lmasin)`);
    save.mutate({
      kind,
      doc_date: docDate,
      client_id: Number(client),
      agent_id: agent ? Number(agent) : null,
      due_date: kind === 'sale' && due ? due : null,
      note,
      rows: lines.map((l) => ({ product_id: l.product_id, qty: num(l.qty), price: num(l.price) })),
    });
  };

  return (
    <>
      <PageHead title="Ulgurji nakladnoy" sub="Mijozga sotuv (Sotuv skladidan chiqadi, nasiyaga yoziladi) yoki mijozdan vozvrat" />
      {write && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="form" style={{ marginBottom: 12 }}>
            <Field label="Turi">
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as InvoiceKind);
                  setLines([]);
                }}
              >
                <option value="sale">Sotuv</option>
                <option value="return">Vozvrat (mijozdan qaytdi)</option>
              </select>
            </Field>
            <Field label="Sana">
              <input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
            </Field>
            <Field label="Mijoz">
              <select
                value={client}
                onChange={(e) => {
                  setClient(e.target.value);
                  setAgent('');
                }}
              >
                <option value="">— tanlang —</option>
                {clients.data?.filter((c) => c.is_active || String(c.id) === client).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.agent_name ? ` (${c.agent_name})` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Agent">
              <AgentSelect value={agent} onChange={setAgent} all={cl?.agent_name ? `${cl.agent_name} (mijoz agenti)` : '—'} />
            </Field>
            {kind === 'sale' && (
              <Field label="To'lov muddati (nasiya)">
                <input type="date" value={due} min={docDate} onChange={(e) => setDue(e.target.value)} />
              </Field>
            )}
            <Field label="Izoh">
              <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          {cl && (
            <p className="note" style={{ marginBottom: 8 }}>
              {cl.name}: qarz <b>{money(cl.debt)}</b>
              {Number(cl.overdue) > 0 && <span className="err"> · muddati o'tgan {money(cl.overdue)}</span>}
              {cl.credit_limit != null && ` · nasiya chegarasi ${money(cl.credit_limit)}`}
            </p>
          )}
          <div className="form" style={{ marginBottom: 8 }}>
            <Field label="Tovar qo'shish (partiya, nomi, rang, barcode)">
              <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={kind === 'sale' ? 'Skladdagi tovarlar' : 'Ulgurji sotilgan tovarlar'} />
            </Field>
          </div>
          {found.length > 0 && (
            <div className="row" style={{ marginBottom: 10 }}>
              {found.map((p) => (
                <button
                  key={p.id}
                  className="btn ghost sm"
                  onClick={() => {
                    setLines((ls) => [...ls, { product_id: p.id, qty: '', price: p.wholesale_price ? String(Number(p.wholesale_price)) : '' }]);
                    setFind('');
                  }}
                >
                  {label(p)} <span className="note">({fmtNum(p.qty)})</span>
                </button>
              ))}
            </div>
          )}
          {needle && !found.length && <p className="note">Topilmadi.</p>}
          {lines.length > 0 && (
            <div className="sheet-wrap">
              <table className="sheet" style={{ minWidth: 800 }}>
                <thead>
                  <tr>
                    <th>Tovar</th>
                    <th className="n">Skladda</th>
                    <th className="n">Soni</th>
                    <th className="n">Narx, so'm</th>
                    <th className="n">Summa</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const p = products.get(l.product_id);
                    return (
                      <tr key={l.product_id} className={l.qty && lineBad(l) ? 'bad-row' : ''}>
                        <td>{p ? label(p) : l.product_id}</td>
                        <td className="n">{fmtNum(p?.qty ?? 0)}</td>
                        <td className="n">
                          <input className="cell num" inputMode="numeric" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} aria-label="Soni" />
                        </td>
                        <td className="n">
                          <input className="cell num" inputMode="decimal" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} aria-label="Narx" />
                        </td>
                        <td className="n">{lineBad(l) ? '' : money(num(l.qty) * num(l.price))}</td>
                        <td>
                          <button className="btn ghost sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Qatorni olib tashlash">
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
            Jami: <b>{money(total)} so'm</b>
            {kind === 'sale' && total > 0 && ` · tannarx ${money(cost)} · foyda ${money(total - cost)}`}
          </SubmitBar>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2>Nakladnoylar</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Turi">
            <option value="all">Hammasi</option>
            <option value="sale">Sotuv</option>
            <option value="return">Vozvrat</option>
          </select>
        </div>
        <ErrorText error={list.error} />
        {!list.data?.length ? (
          <p className="note">Hali yo'q.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>№</th>
                  <th>Sana</th>
                  <th>Turi</th>
                  <th>Mijoz</th>
                  <th>Agent</th>
                  <th>Muddat</th>
                  <th className="n">Soni</th>
                  <th className="n">Summa</th>
                  <th className="n">Foyda</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.map((d) => (
                  <Fragment key={d.id}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === d.id ? null : d.id)}>
                      <td className="mono">{d.id}</td>
                      <td className="mono">{fmtDate(d.doc_date)}</td>
                      <td>
                        <span className={`pill ${d.kind === 'sale' ? 'good' : 'warn'}`}>{KIND[d.kind]}</span>
                      </td>
                      <td>{d.client_name}</td>
                      <td>{d.agent_name ?? ''}</td>
                      <td className="mono">{d.due_date ? fmtDate(d.due_date) : ''}</td>
                      <td className="n">{fmtNum(d.qty)}</td>
                      <td className="n">{money(d.amount_uzs)}</td>
                      <td className="n">{d.kind === 'sale' ? money(Number(d.amount_uzs) - Number(d.cost_uzs)) : ''}</td>
                      <td>
                        <div className="row" onClick={(e) => e.stopPropagation()}>
                          <Link className="btn ghost sm" to={`/sotuv/nakladnoy/${d.id}`}>
                            Chop etish
                          </Link>
                          {write && (
                            <button className="btn ghost sm" disabled={del.isPending} onClick={() => confirm(`Nakladnoy №${d.id} o'chirilsinmi?`) && del.mutate(d.id)}>
                              O'chirish
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open === d.id && (
                      <tr>
                        <td colSpan={10}>
                          {d.note && <p className="note">{d.note}</p>}
                          <InvoiceItems d={d} />
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
    </>
  );
}

/** Chop etish uchun nakladnoy */
export function InvoicePrintPage() {
  const id = Number(useParams().id);
  const q = useQuery({ queryKey: ['sales', 'invoice', id], queryFn: () => api<SalesInvoice>(`${W}/invoices/${id}`) });
  const d = q.data;
  return (
    <>
      <PageHead title={`Nakladnoy №${id}`}>
        <Link className="btn ghost no-print" to="/sotuv/nakladnoy">
          ← Orqaga
        </Link>
        <button className="btn no-print" onClick={() => window.print()}>
          Chop etish
        </button>
      </PageHead>
      <ErrorText error={q.error} />
      {d && (
        <div className="card print-sheet">
          <h2>
            {d.kind === 'sale' ? 'Nakladnoy' : 'Vozvrat nakladnoy'} №{d.id} · {fmtDate(d.doc_date)}
          </h2>
          <p>
            Yetkazib beruvchi: <b>ISTAM — Sotuv bo'limi</b>
            <br />
            Mijoz: <b>{d.client_name}</b>
            {[d.client_phone, d.client_address].filter(Boolean).length > 0 && ` · ${[d.client_phone, d.client_address].filter(Boolean).join(' · ')}`}
            {d.agent_name && (
              <>
                <br />
                Agent: {d.agent_name}
              </>
            )}
            {d.due_date && (
              <>
                <br />
                To'lov muddati: <b>{fmtDate(d.due_date)}</b>
              </>
            )}
          </p>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>№</th>
                  <th>Tovar</th>
                  <th>Artikul</th>
                  <th>Rang</th>
                  <th>Razmer</th>
                  <th className="n">Soni</th>
                  <th className="n">Narx</th>
                  <th className="n">Summa</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((i, n) => (
                  <tr key={i.product_id}>
                    <td className="mono">{n + 1}</td>
                    <td>
                      {i.name}
                      {i.sort === 2 ? ' (2 sort)' : ''}
                    </td>
                    <td>{i.artikul ?? ''}</td>
                    <td>{i.color_name ?? ''}</td>
                    <td className="mono">{i.size_name ?? ''}</td>
                    <td className="n">{fmtNum(i.qty)}</td>
                    <td className="n">{money(i.price)}</td>
                    <td className="n">{money(i.qty * Number(i.price))}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={5}>
                    <b>Jami</b>
                  </td>
                  <td className="n">
                    <b>{fmtNum(d.qty)}</b>
                  </td>
                  <td />
                  <td className="n">
                    <b>{money(d.amount_uzs)}</b>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {d.note && <p>Izoh: {d.note}</p>}
          <p>Mijozning umumiy qarzi (hozir): <b>{money(d.client_debt)} so'm</b></p>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 40 }}>
            <span>Topshirdi: ____________________</span>
            <span>Qabul qildi: ____________________</span>
          </div>
        </div>
      )}
    </>
  );
}

// ---------- Mijozlar va nasiya ----------
function ClientModal({ c, onClose }: { c: SalesClient | null; onClose: () => void }) {
  const toast = useToast();
  const inv = useSalesInvalidate();
  const [f, setF] = useState({
    name: c?.name ?? '',
    phone: c?.phone ?? '',
    address: c?.address ?? '',
    agent_id: c?.agent_id ? String(c.agent_id) : '',
    credit_limit: c?.credit_limit != null ? String(Number(c.credit_limit)) : '',
    note: c?.note ?? '',
    is_active: c?.is_active ?? true,
  });
  const badLimit = f.credit_limit.trim() !== '' && !(num(f.credit_limit) >= 0);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, agent_id: f.agent_id ? Number(f.agent_id) : null, credit_limit: f.credit_limit.trim() ? num(f.credit_limit) : null };
      return c ? api(`${W}/clients/${c.id}`, { method: 'PUT', body }) : api(`${W}/clients`, { method: 'POST', body });
    },
    onSuccess: () => {
      inv();
      toast('Mijoz saqlandi');
      onClose();
    },
  });
  return (
    <Modal title={c ? c.name : 'Yangi mijoz'} onClose={onClose}>
      <div className="form one">
        <Field label="Nomi">
          <input value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Telefon">
          <input value={f.phone} maxLength={50} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label="Manzil">
          <input value={f.address} maxLength={300} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </Field>
        <Field label="Agent">
          <AgentSelect value={f.agent_id} onChange={(v) => setF({ ...f, agent_id: v })} />
        </Field>
        <Field label="Nasiya chegarasi, so'm (bo'sh — cheklanmagan)">
          <input className="num" inputMode="decimal" value={f.credit_limit} onChange={(e) => setF({ ...f, credit_limit: e.target.value })} />
        </Field>
        <Field label="Izoh">
          <input value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        {c && (
          <label className="row">
            <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Faol
          </label>
        )}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <ErrorText error={save.error} />
        <button className="btn ghost" onClick={onClose}>
          Bekor
        </button>
        <button className="btn" disabled={save.isPending || badLimit || !f.name.trim()} onClick={() => save.mutate()}>
          Saqlash
        </button>
      </div>
    </Modal>
  );
}

function ClientLedger({ c }: { c: SalesClient }) {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useSalesInvalidate();
  const qc = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pay, setPay] = useState({ pay_date: today(), amount: '', method: 'naqd' as PayMethod, agent_id: '', wallet_id: '', note: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const write = !!me && can.salesPay(me.role);
  const cashMeta = useMeta(write && !!me && can.cashRead(me.role));
  const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
  const q = useQuery({ queryKey: ['sales', 'client-ledger', c.id, qs], queryFn: () => api<SalesClientLedger>(`${W}/clients/${c.id}/ledger${qs ? `?${qs}` : ''}`) });
  const add = useMutation({
    mutationFn: () =>
      api(`${W}/client-payments`, {
        method: 'POST',
        body: {
          client_id: c.id,
          pay_date: pay.pay_date,
          amount_uzs: num(pay.amount),
          method: pay.method,
          agent_id: pay.agent_id ? Number(pay.agent_id) : null,
          wallet_id: pay.wallet_id ? Number(pay.wallet_id) : null,
          note: pay.note,
        },
      }),
    onSuccess: () => {
      inv();
      qc.invalidateQueries({ queryKey: ['cash'] });
      setPay({ ...pay, amount: '', note: '' });
      toast(`To'lov kiritildi${pay.wallet_id ? ' — kassada kirim yozildi' : ''}`);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`${W}/client-payments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      inv();
      qc.invalidateQueries({ queryKey: ['cash'] });
      toast('To\'lov o\'chirildi');
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  const submit = () => {
    setMsg(null);
    if (!pay.pay_date) return setMsg('Sanani kiriting');
    if (!(num(pay.amount) > 0)) return setMsg('Summani kiriting');
    add.mutate();
  };
  const d = q.data;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>{c.name} — akt sverka</h2>
      {write && (
        <>
          <div className="form">
            <Field label="Sana">
              <input type="date" value={pay.pay_date} onChange={(e) => setPay({ ...pay, pay_date: e.target.value })} />
            </Field>
            <Field label="To'lov summasi, so'm">
              <input className="num" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
            </Field>
            <Field label="Usul">
              <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value as PayMethod })}>
                {Object.entries(METHOD).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Kim yig'di (agent)">
              <AgentSelect value={pay.agent_id} onChange={(v) => setPay({ ...pay, agent_id: v })} all={c.agent_name ? `${c.agent_name} (mijoz agenti)` : '—'} />
            </Field>
            {cashMeta.data && (
              <Field label="Qaysi hamyonga (kassaga kirim)">
                <WalletSelect meta={cashMeta.data} value={pay.wallet_id} onChange={(v) => setPay({ ...pay, wallet_id: v })} label="Hamyon" all="— kassaga yozilmasin —" noAvans />
              </Field>
            )}
            <Field label="Izoh">
              <input value={pay.note} maxLength={500} onChange={(e) => setPay({ ...pay, note: e.target.value })} />
            </Field>
          </div>
          <SubmitBar msg={msg} error={add.error} pending={add.isPending} onSubmit={submit}>
            Hamyon tanlansa — kassada «Sotuvdan tushum» kirimi avtomatik yoziladi.
          </SubmitBar>
        </>
      )}
      <div className="form" style={{ margin: '12px 0' }}>
        <Field label="Sanadan">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Sanagacha">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <ErrorText error={q.error} />
      {d && (
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Sana</th>
                <th>Hujjat</th>
                <th>Izoh</th>
                <th className="n">Sotuv (qarz)</th>
                <th className="n">Vozvrat / to'lov</th>
                <th className="n">Qoldiq qarz</th>
                {write && <th />}
              </tr>
            </thead>
            <tbody>
              {from && (
                <tr>
                  <td colSpan={5}>Davr boshiga</td>
                  <td className="n">{money(d.opening)}</td>
                  {write && <td />}
                </tr>
              )}
              {d.rows.map((r) => (
                <tr key={`${r.kind}:${r.ref_id}`}>
                  <td className="mono">{fmtDate(r.date)}</td>
                  <td>
                    {r.kind === 'payment' ? (
                      `To'lov №${r.ref_id}`
                    ) : (
                      <Link to={`/sotuv/nakladnoy/${r.ref_id}`}>
                        {KIND[r.kind]} №{r.ref_id} ({fmtNum(r.qty)} dona)
                      </Link>
                    )}
                    {r.due_date && <span className="note"> · muddat {fmtDate(r.due_date)}</span>}
                  </td>
                  <td>{r.note ?? ''}</td>
                  <td className="n">{Number(r.debit) ? money(r.debit) : ''}</td>
                  <td className="n">{Number(r.credit) ? money(r.credit) : ''}</td>
                  <td className="n">{money(r.balance)}</td>
                  {write && (
                    <td>
                      {r.kind === 'payment' && (
                        <button className="btn ghost sm" disabled={del.isPending} onClick={() => confirm(`To'lov №${r.ref_id} o'chirilsinmi? Kassadagi kirim ham o'chadi.`) && del.mutate(r.ref_id)}>
                          O'chirish
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              <tr>
                <td colSpan={3}>
                  <b>Jami</b>
                </td>
                <td className="n">
                  <b>{money(d.totals.debit)}</b>
                </td>
                <td className="n">
                  <b>{money(d.totals.credit)}</b>
                </td>
                <td className="n">
                  <b>{money(d.totals.closing)}</b>
                </td>
                {write && <td />}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ClientsPage() {
  const { me } = useAuth();
  const q = useClients();
  const [edit, setEdit] = useState<SalesClient | 'new' | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [agent, setAgent] = useState('');
  const [search, setSearch] = useState('');
  const [onlyDebt, setOnlyDebt] = useState(false);
  if (!me) return null;
  const write = can.salesWholesale(me.role);
  const rows = (q.data ?? []).filter(
    (c) => (!agent || String(c.agent_id) === agent) && (!onlyDebt || Number(c.debt) > 0) && (!search.trim() || `${c.name} ${c.phone ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())),
  );
  const sum = (k: 'debt' | 'overdue') => rows.reduce((a, c) => a + Number(c[k]), 0);
  const cur = q.data?.find((c) => c.id === sel) ?? null;
  return (
    <>
      <PageHead title="Mijozlar (nasiya)" sub="Ulgurji mijozlar: qarz = sotuv − vozvrat − to'lov; muddati o'tgan qarz eski nakladnoylardan hisoblanadi">
        {write && (
          <button className="btn" onClick={() => setEdit('new')}>
            + Mijoz
          </button>
        )}
      </PageHead>
      <div className="cards" style={{ marginBottom: 14 }}>
        <div className="card stat">
          <span className="note">Mijozlar qarzi</span>
          <b>{money(sum('debt'))}</b>
        </div>
        <div className="card stat">
          <span className="note">Muddati o'tgan</span>
          <b className={sum('overdue') > 0 ? 'err' : ''}>{money(sum('overdue'))}</b>
        </div>
      </div>
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <Field label="Qidirish">
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <Field label="Agent">
            <AgentSelect value={agent} onChange={setAgent} all="Hammasi" />
          </Field>
          <label className="row">
            <input type="checkbox" checked={onlyDebt} onChange={(e) => setOnlyDebt(e.target.checked)} /> Faqat qarzdorlar
          </label>
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">{q.isLoading ? 'Yuklanmoqda…' : 'Mijoz yo\'q.'}</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Mijoz</th>
                  <th>Agent</th>
                  <th>Telefon</th>
                  <th className="n">Sotuv</th>
                  <th className="n">Vozvrat</th>
                  <th className="n">To'langan</th>
                  <th className="n">Qarz</th>
                  <th className="n">Muddati o'tgan</th>
                  <th className="n">Chegara</th>
                  <th>Oxirgi to'lov</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className={sel === c.id ? 'sel-row' : ''} style={{ cursor: 'pointer', opacity: c.is_active ? 1 : 0.55 }} onClick={() => setSel(sel === c.id ? null : c.id)}>
                    <td>
                      <b>{c.name}</b>
                      {c.address && <span className="note"> · {c.address}</span>}
                    </td>
                    <td>{c.agent_name ?? ''}</td>
                    <td className="mono">{c.phone ?? ''}</td>
                    <td className="n">{money(c.sold)}</td>
                    <td className="n">{Number(c.returned) ? money(c.returned) : ''}</td>
                    <td className="n">{money(c.paid)}</td>
                    <td className="n">
                      <b>{money(c.debt)}</b>
                    </td>
                    <td className="n">{Number(c.overdue) > 0 ? <span className="pill bad">{money(c.overdue)}</span> : ''}</td>
                    <td className="n">{c.credit_limit != null ? money(c.credit_limit) : ''}</td>
                    <td className="mono">{c.last_payment ? fmtDate(c.last_payment) : ''}</td>
                    <td>
                      {write && (
                        <button
                          className="btn ghost sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEdit(c);
                          }}
                        >
                          Tahrirlash
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note" style={{ marginTop: 8 }}>
          Qatorni bosing — akt sverka va to'lov.
        </p>
      </div>
      {cur && <ClientLedger key={cur.id} c={cur} />}
      {edit && <ClientModal c={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

// ---------- Agentlar va hisobot ----------
function AgentModal({ a, onClose }: { a: SalesAgent | null; onClose: () => void }) {
  const toast = useToast();
  const inv = useSalesInvalidate();
  const [f, setF] = useState({ name: a?.name ?? '', phone: a?.phone ?? '', commission_pct: a ? String(Number(a.commission_pct)) : '0', note: a?.note ?? '', is_active: a?.is_active ?? true });
  const pct = num(f.commission_pct);
  const bad = !(pct >= 0 && pct <= 100);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, commission_pct: pct };
      return a ? api(`${W}/agents/${a.id}`, { method: 'PUT', body }) : api(`${W}/agents`, { method: 'POST', body });
    },
    onSuccess: () => {
      inv();
      toast('Agent saqlandi');
      onClose();
    },
  });
  return (
    <Modal title={a ? a.name : 'Yangi agent'} onClose={onClose}>
      <div className="form one">
        <Field label="Ismi">
          <input value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Telefon">
          <input value={f.phone} maxLength={50} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label="Komissiya, % (sof sotuvdan)">
          <input className="num" inputMode="decimal" value={f.commission_pct} onChange={(e) => setF({ ...f, commission_pct: e.target.value })} />
        </Field>
        <Field label="Izoh">
          <input value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        {a && (
          <label className="row">
            <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Faol
          </label>
        )}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <ErrorText error={save.error} />
        <button className="btn ghost" onClick={onClose}>
          Bekor
        </button>
        <button className="btn" disabled={save.isPending || bad || !f.name.trim()} onClick={() => save.mutate()}>
          Saqlash
        </button>
      </div>
    </Modal>
  );
}

const monthStart = () => `${today().slice(0, 7)}-01`;

export function AgentsPage() {
  const { me } = useAuth();
  const agents = useAgents();
  const [edit, setEdit] = useState<SalesAgent | 'new' | null>(null);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState('');
  const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
  const rep = useQuery({ queryKey: ['sales', 'wholesale-report', qs], queryFn: () => api<WholesaleReport>(`${W}/report${qs ? `?${qs}` : ''}`) });
  if (!me) return null;
  const write = can.salesWholesale(me.role);
  const t = rep.data?.totals;
  return (
    <>
      <PageHead title="Agentlar" sub="Agentlar ro'yxati va davr bo'yicha ulgurji sotuv hisoboti: sotuv, vozvrat, foyda, yig'ilgan pul, komissiya">
        {write && (
          <button className="btn" onClick={() => setEdit('new')}>
            + Agent
          </button>
        )}
      </PageHead>
      <div className="card" style={{ marginBottom: 14 }}>
        <ErrorText error={agents.error} />
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Telefon</th>
                <th className="n">Komissiya, %</th>
                <th className="n">Mijozlar</th>
                <th>Izoh</th>
                {write && <th />}
              </tr>
            </thead>
            <tbody>
              {agents.data?.map((a) => (
                <tr key={a.id} style={{ opacity: a.is_active ? 1 : 0.55 }}>
                  <td>
                    <b>{a.name}</b>
                  </td>
                  <td className="mono">{a.phone ?? ''}</td>
                  <td className="n">{fmtNum(a.commission_pct, 2)}</td>
                  <td className="n">{fmtNum(a.clients)}</td>
                  <td>{a.note ?? ''}</td>
                  {write && (
                    <td>
                      <button className="btn ghost sm" onClick={() => setEdit(a)}>
                        Tahrirlash
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Hisobot</h2>
        <div className="form" style={{ marginBottom: 12 }}>
          <Field label="Sanadan">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Sanagacha">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <ErrorText error={rep.error} />
        {t && (
          <div className="cards" style={{ marginBottom: 12 }}>
            <div className="card stat">
              <span className="note">Sof sotuv</span>
              <b>{money(t.net_sales)}</b>
              <span className="note">vozvrat: {money(t.returns)}</span>
            </div>
            <div className="card stat">
              <span className="note">Foyda (Sotuv bo'limi)</span>
              <b>{money(t.margin)}</b>
              <span className="note">tannarx: {money(t.cost)}</span>
            </div>
            <div className="card stat">
              <span className="note">Yig'ilgan pul</span>
              <b>{money(t.paid)}</b>
            </div>
            <div className="card stat">
              <span className="note">Agentlar komissiyasi</span>
              <b>{money(t.commission)}</b>
            </div>
          </div>
        )}
        {rep.data && (
          <>
            <div className="tw" style={{ marginBottom: 14 }}>
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th className="n">Sotildi, dona</th>
                    <th className="n">Qaytdi, dona</th>
                    <th className="n">Sof sotuv</th>
                    <th className="n">Tannarx</th>
                    <th className="n">Foyda</th>
                    <th className="n">Yig'ilgan pul</th>
                    <th className="n">Komissiya</th>
                  </tr>
                </thead>
                <tbody>
                  {rep.data.agents.map((a) => (
                    <tr key={a.id ?? 0}>
                      <td>{a.name}</td>
                      <td className="n">{fmtNum(a.sold_qty)}</td>
                      <td className="n">{a.returned_qty ? fmtNum(a.returned_qty) : ''}</td>
                      <td className="n">{money(a.net_sales)}</td>
                      <td className="n">{money(a.cost)}</td>
                      <td className="n">{money(a.margin)}</td>
                      <td className="n">{money(a.paid)}</td>
                      <td className="n">{money(a.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h2>Mijozlar bo'yicha</h2>
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>Mijoz</th>
                    <th>Agent</th>
                    <th className="n">Sotildi, dona</th>
                    <th className="n">Sof sotuv</th>
                    <th className="n">Foyda</th>
                    <th className="n">To'ladi</th>
                  </tr>
                </thead>
                <tbody>
                  {rep.data.clients.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{c.agent_name ?? ''}</td>
                      <td className="n">{fmtNum(c.sold_qty - c.returned_qty)}</td>
                      <td className="n">{money(c.net_sales)}</td>
                      <td className="n">{money(c.margin)}</td>
                      <td className="n">{money(c.paid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ marginTop: 8 }}>
              Hisobot {from ? fmtDate(from) : 'boshidan'} — {to ? fmtDate(to) : 'bugungacha'}; yangilangan: {fmtDateTime(new Date().toISOString())}. Komissiya kassadan alohida to'lanadi (xarajat elementi 3009).
            </p>
          </>
        )}
      </div>
      {edit && <AgentModal a={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}
