import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, PageHead, fmtDate, useToast } from '../components/ui';
import { can, type CashAvans, type CashBalance, type CashCurrency, type CashEntry, type CashMeta, type CashReport, type CashWallet, type OrderRow } from '../types';
import { monthStart } from './Hr';
import { money, num } from './purchaseUi';
import { SubmitBar, today } from './stockUi';

/** Kassa — Sheets "Kassa ISTAM Moliya bo'limi": kiritish, jurnal (Kassa Baza), hisobot, avans-hisobot */
const CURS: CashCurrency[] = ['UZS', 'USD', 'CNY', 'EUR', 'RUB'];
const CUR_LABEL: Record<CashCurrency, string> = { UZS: "So'm", USD: 'Dollar', CNY: 'Yuan', EUR: 'Euro', RUB: 'Rubl' };
const BUSINESS: Record<CashWallet['business'], string> = { moliya: "Moliya bo'limi", tijorat: "Tijorat (Sotuv) bo'limi", ishlab: 'Ishlab chiqarish' };
const KIND: Record<CashWallet['kind'], string> = { naqd: 'Naqd kassa', karta: 'Karta', bank: 'Bank hisob', avans: 'Avans-hisobot', boshqa: 'Boshqa' };

const useMeta = () => useQuery({ queryKey: ['cash', 'meta'], queryFn: () => api<CashMeta>('/cash/meta') });
const useCashInvalidate = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['cash'] });
};
const amt = (v: string) => (Number(v) ? money(v) : '');

function WalletSelect({ meta, value, onChange, label, all, exclude }: { meta: CashMeta | undefined; value: string; onChange: (v: string) => void; label: string; all?: string; exclude?: string }) {
  const groups = (['moliya', 'tijorat', 'ishlab'] as const).map((b) => [b, (meta?.wallets ?? []).filter((w) => w.business === b && (w.is_active || String(w.id) === value) && String(w.id) !== exclude)] as const);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{all ?? '— hamyon —'}</option>
      {groups
        .filter(([, ws]) => ws.length)
        .map(([b, ws]) => (
          <optgroup key={b} label={BUSINESS[b]}>
            {ws.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </optgroup>
        ))}
    </select>
  );
}

// ---------- Kassa kiritish ----------
type R = {
  wallet_id: string;
  op_type_id: string;
  center_id: string;
  item_id: string;
  counterparty: string;
  department: string;
  responsible: string;
  note: string;
  currency: CashCurrency;
  rate: string;
  amount_in: string;
  amount_out: string;
  period: string;
  order_id: string;
  to_wallet_id: string;
  to_currency: string;
  to_amount: string;
};
const blank = (p?: Partial<R>): R => ({
  wallet_id: '',
  op_type_id: '',
  center_id: '',
  item_id: '',
  counterparty: '',
  department: '',
  responsible: '',
  note: '',
  currency: 'UZS',
  rate: '',
  amount_in: '',
  amount_out: '',
  period: '',
  order_id: '',
  to_wallet_id: '',
  to_currency: '',
  to_amount: '',
  ...p,
});

export function CashInputPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useCashInvalidate();
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<R[]>(() => Array.from({ length: 5 }, () => blank()));
  const [msg, setMsg] = useState<string | null>(null);
  const meta = useMeta();
  const orders = useQuery({ queryKey: ['orders', 'list', 'cash'], queryFn: () => api<OrderRow[]>('/orders?status=confirmed'), enabled: !!me && can.ordersRead(me.role) });
  const day = useQuery({ queryKey: ['cash', 'entries', 'day', date], queryFn: () => api<CashEntry[]>(`/cash/entries?from=${date}&to=${date}`), enabled: !!date });
  const save = useMutation({
    mutationFn: (body: object) => api<{ saved: number }>('/cash/entries', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      setRows((x) => x.map((row) => blank({ wallet_id: row.wallet_id })));
      toast(`${r.saved} ta yozuv saqlandi`);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api<{ deleted: number }>(`/cash/entries/${id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      inv();
      toast(r.deleted > 1 ? `${r.deleted} ta yozuv (juftligi bilan) o'chirildi` : 'Yozuv o\'chirildi');
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  if (!me) return null;
  const write = can.cashWrite(me.role);
  const m = meta.data;
  const opOf = (r: R) => m?.op_types.find((o) => String(o.id) === r.op_type_id);
  const special = (r: R) => opOf(r)?.special ?? null;
  const touched = (r: R) => !!(r.op_type_id || r.amount_in.trim() || r.amount_out.trim());
  const set = (i: number, p: Partial<R>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const problem = (r: R): string | null => {
    const op = opOf(r);
    if (!r.wallet_id) return 'hamyonni tanlang';
    if (!op) return 'tranzaksiya turini tanlang';
    const inV = r.amount_in.trim() ? num(r.amount_in) : 0;
    const outV = r.amount_out.trim() ? num(r.amount_out) : 0;
    if (!Number.isFinite(inV) || !Number.isFinite(outV) || inV < 0 || outV < 0) return 'summa noto\'g\'ri';
    if (r.currency !== 'UZS' && r.rate.trim() && !(num(r.rate) > 0)) return 'kurs noto\'g\'ri';
    if (op.special === 'transfer' || op.special === 'exchange') {
      if (!(outV > 0)) return 'chiqim summasini kiriting';
      if (op.special === 'transfer' && !r.to_wallet_id) return 'qaysi hamyonga';
      if (op.special === 'exchange' && (!r.to_currency || r.to_currency === r.currency || !(num(r.to_amount) > 0))) return 'qaysi valyutaga va qancha olindi';
      return null;
    }
    if ((inV > 0) === (outV > 0)) return 'kirim yoki chiqimdan bittasini kiriting';
    if (op.flow === 'in' && outV > 0) return `«${op.name}» — faqat kirim`;
    if (op.flow === 'out' && inV > 0) return `«${op.name}» — faqat chiqim`;
    if (op.special === 'expense' && (!r.item_id || !r.center_id)) return 'markaz va xarajat elementini tanlang';
    return null;
  };
  const submit = () => {
    setMsg(null);
    const t = rows.filter(touched);
    if (!t.length) return setMsg('Kamida bitta qator kiriting');
    for (const [i, r] of t.entries()) {
      const p = problem(r);
      if (p) return setMsg(`${rows.indexOf(r) + 1 || i + 1}-qator: ${p}`);
    }
    save.mutate({
      entry_date: date,
      rows: t.map((r) => ({
        wallet_id: Number(r.wallet_id),
        op_type_id: Number(r.op_type_id),
        center_id: r.center_id ? Number(r.center_id) : null,
        item_id: r.item_id ? Number(r.item_id) : null,
        counterparty: r.counterparty,
        department: r.department,
        responsible: r.responsible,
        note: r.note,
        currency: r.currency,
        rate: r.currency !== 'UZS' && r.rate.trim() ? num(r.rate) : null,
        amount_in: r.amount_in.trim() ? num(r.amount_in) : 0,
        amount_out: r.amount_out.trim() ? num(r.amount_out) : 0,
        period: r.period || null,
        order_id: r.order_id ? Number(r.order_id) : null,
        to_wallet_id: r.to_wallet_id ? Number(r.to_wallet_id) : null,
        to_currency: r.to_currency || null,
        to_amount: r.to_amount.trim() ? num(r.to_amount) : null,
      })),
    });
  };
  const sums = (list: CashEntry[]) => {
    const s: Partial<Record<CashCurrency, { in: number; out: number }>> = {};
    for (const e of list) {
      const x = (s[e.currency] ??= { in: 0, out: 0 });
      x.in += Number(e.amount_in);
      x.out += Number(e.amount_out);
    }
    return Object.entries(s) as [CashCurrency, { in: number; out: number }][];
  };

  return (
    <>
      <PageHead title="Kassa kiritish" sub="Kirim, chiqim, ichki transfer, valyuta ayriboshlash, avans-hisobot — bir sanada bir nechta qator" />
      {write && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="form" style={{ marginBottom: 12 }}>
            <Field label="Sana">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <ErrorText error={meta.error} />
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 2100 }}>
              <thead>
                <tr>
                  <th>№</th>
                  <th>Hamyon</th>
                  <th>Tranzaksiya</th>
                  <th>Markaz</th>
                  <th>Xarajat elementi</th>
                  <th>Kontragent</th>
                  <th>Bo'lim</th>
                  <th>Ma'sul shaxs</th>
                  <th>Izoh (detal)</th>
                  <th>Valyuta</th>
                  <th className="n">Kurs</th>
                  <th className="n">Kirim</th>
                  <th className="n">Chiqim</th>
                  <th>Qayerga / nimaga</th>
                  <th>Oy</th>
                  {orders.data && <th>Partiya</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const sp = special(r);
                  const op = opOf(r);
                  const p = touched(r) ? problem(r) : null;
                  return (
                    <tr key={i} className={p ? 'bad-row' : touched(r) ? 'sel-row' : ''} title={p ?? undefined}>
                      <td className="mono">{i + 1}</td>
                      <td>
                        <WalletSelect meta={m} value={r.wallet_id} onChange={(v) => set(i, { wallet_id: v })} label="Hamyon" />
                      </td>
                      <td>
                        <select value={r.op_type_id} onChange={(e) => set(i, { op_type_id: e.target.value, ...(e.target.value !== r.op_type_id ? { to_wallet_id: '', to_currency: '', to_amount: '' } : {}) })} aria-label="Tranzaksiya">
                          <option value="">—</option>
                          {m?.op_types
                            .filter((o) => o.is_active)
                            .map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                              </option>
                            ))}
                        </select>
                      </td>
                      <td>
                        <select value={r.center_id} onChange={(e) => set(i, { center_id: e.target.value })} aria-label="Markaz" disabled={sp === 'transfer' || sp === 'exchange' || sp === 'opening'}>
                          <option value="">—</option>
                          {(['PC', 'CC', 'IC'] as const).map((k) => (
                            <optgroup key={k} label={k === 'PC' ? 'Daromad (PC)' : k === 'CC' ? 'Xarajat (CC)' : 'Investitsiya (IC)'}>
                              {m?.centers
                                .filter((c) => c.kind === k && c.is_active)
                                .map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select value={r.item_id} onChange={(e) => set(i, { item_id: e.target.value })} aria-label="Xarajat elementi" disabled={sp === 'transfer' || sp === 'exchange' || sp === 'opening'}>
                          <option value="">—</option>
                          {[...new Set((m?.items ?? []).map((x) => x.group_code))].map((g) => (
                            <optgroup key={g} label={`${g} · ${m?.items.find((x) => x.group_code === g)?.group_name ?? ''}`}>
                              {m?.items
                                .filter((x) => x.group_code === g && (x.is_active || String(x.id) === r.item_id))
                                .map((x) => (
                                  <option key={x.id} value={x.id}>
                                    {x.code} {x.name}
                                  </option>
                                ))}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input className="cell" list="cash-cp" value={r.counterparty} onChange={(e) => set(i, { counterparty: e.target.value })} aria-label="Kontragent" />
                      </td>
                      <td>
                        <input className="cell" list="cash-dep" value={r.department} style={{ width: 70 }} onChange={(e) => set(i, { department: e.target.value })} aria-label="Bo'lim" />
                      </td>
                      <td>
                        <input className="cell" list="cash-resp" value={r.responsible} onChange={(e) => set(i, { responsible: e.target.value })} aria-label="Ma'sul shaxs" />
                      </td>
                      <td>
                        <input className="cell" value={r.note} onChange={(e) => set(i, { note: e.target.value })} aria-label="Izoh" />
                      </td>
                      <td>
                        <select value={r.currency} onChange={(e) => set(i, { currency: e.target.value as CashCurrency })} aria-label="Valyuta">
                          {CURS.map((c) => (
                            <option key={c} value={c}>
                              {CUR_LABEL[c]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="n">
                        {r.currency !== 'UZS' && <input className="cell num" inputMode="decimal" placeholder="avto" value={r.rate} onChange={(e) => set(i, { rate: e.target.value })} aria-label="Kurs" />}
                      </td>
                      <td className="n">
                        {op?.flow !== 'out' && <input className="cell num" inputMode="decimal" value={r.amount_in} onChange={(e) => set(i, { amount_in: e.target.value })} aria-label="Kirim" />}
                      </td>
                      <td className="n">
                        {op?.flow !== 'in' && <input className="cell num" inputMode="decimal" value={r.amount_out} onChange={(e) => set(i, { amount_out: e.target.value })} aria-label="Chiqim" />}
                      </td>
                      <td>
                        {sp === 'transfer' && <WalletSelect meta={m} value={r.to_wallet_id} onChange={(v) => set(i, { to_wallet_id: v })} label="Qaysi hamyonga" exclude={r.wallet_id} />}
                        {sp === 'exchange' && (
                          <div className="row" style={{ flexWrap: 'nowrap' }}>
                            <select value={r.to_currency} onChange={(e) => set(i, { to_currency: e.target.value })} aria-label="Qaysi valyutaga">
                              <option value="">→ valyuta</option>
                              {CURS.filter((c) => c !== r.currency).map((c) => (
                                <option key={c} value={c}>
                                  {CUR_LABEL[c]}
                                </option>
                              ))}
                            </select>
                            <input className="cell num" inputMode="decimal" placeholder="olingan summa" value={r.to_amount} onChange={(e) => set(i, { to_amount: e.target.value })} aria-label="Olingan summa" />
                          </div>
                        )}
                      </td>
                      <td>
                        <input type="month" className="cell" value={r.period} onChange={(e) => set(i, { period: e.target.value })} aria-label="Oy" />
                      </td>
                      {orders.data && (
                        <td>
                          <select value={r.order_id} onChange={(e) => set(i, { order_id: e.target.value })} aria-label="Partiya">
                            <option value="">—</option>
                            {orders.data.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.partiya_no} {o.model ?? ''}
                              </option>
                            ))}
                          </select>
                        </td>
                      )}
                      <td>
                        <button className="x" aria-label="Qatorni tozalash" onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [blank()])}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <datalist id="cash-cp">
            {m?.counterparties.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <datalist id="cash-resp">
            {m?.responsibles.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <datalist id="cash-dep">
            {m?.departments.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn ghost sm" onClick={() => setRows([...rows, ...Array.from({ length: 5 }, () => blank({ wallet_id: rows[rows.length - 1]?.wallet_id ?? '' }))])}>
              + 5 qator
            </button>
          </div>
          <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
            Transfer va avans-hisobot: chiqim summasi yoziladi, qabul qiluvchi hamyonga kirim o'zi tushadi. Ayriboshlash: berilgan (chiqim) va olingan summa. Kurs bo'sh bo'lsa — ma'lumotnomadagi kurs.
          </SubmitBar>
        </div>
      )}
      <div className="card">
        {!write && (
          <div className="form" style={{ marginBottom: 12 }}>
            <Field label="Sana">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
        )}
        <h2>Kunlik hisobot · {fmtDate(date)}</h2>
        <ErrorText error={day.error} />
        {!day.data?.length ? <p className="note">Bu kunda yozuv yo'q.</p> : <EntriesTable rows={day.data} canDelete={write} onDelete={(id) => del.mutate(id)} pending={del.isPending} />}
        {!!day.data?.length && (
          <p className="note" style={{ marginTop: 8 }}>
            {sums(day.data)
              .map(([c, s]) => `${CUR_LABEL[c]}: kirim ${money(s.in)} · chiqim ${money(s.out)}`)
              .join(' | ')}
          </p>
        )}
      </div>
    </>
  );
}

function EntriesTable({ rows, canDelete, onDelete, pending, showDate }: { rows: CashEntry[]; canDelete: boolean; onDelete: (id: number) => void; pending: boolean; showDate?: boolean }) {
  return (
    <div className="sheet-wrap">
      <table className="sheet" style={{ minWidth: 1600 }}>
        <thead>
          <tr>
            {showDate && <th>Sana</th>}
            <th>Hamyon</th>
            <th>Tranzaksiya</th>
            <th>Markaz</th>
            <th>Xarajat elementi</th>
            <th>Kontragent</th>
            <th>Bo'lim</th>
            <th>Ma'sul shaxs</th>
            <th>Izoh</th>
            <th>Valyuta</th>
            <th className="n">Kurs</th>
            <th className="n">Kirim</th>
            <th className="n">Chiqim</th>
            <th>Oy</th>
            <th>Partiya</th>
            <th>Kiritgan</th>
            {canDelete && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              {showDate && <td className="mono">{fmtDate(e.entry_date)}</td>}
              <td>{e.wallet_name}</td>
              <td>
                {e.op_name}
                {e.pair_wallet && <span className="note"> {Number(e.amount_out) ? '→' : '←'} {e.pair_wallet}</span>}
              </td>
              <td>{e.center_name ?? ''}</td>
              <td>{e.item_name ? `${e.item_code} ${e.item_name}` : ''}</td>
              <td>{e.counterparty ?? ''}</td>
              <td>{e.department ?? ''}</td>
              <td>{e.responsible ?? ''}</td>
              <td>{e.note ?? ''}</td>
              <td>{CUR_LABEL[e.currency]}</td>
              <td className="n">{e.currency === 'UZS' ? '' : money(e.rate)}</td>
              <td className="n">{amt(e.amount_in)}</td>
              <td className="n">{amt(e.amount_out)}</td>
              <td className="mono">{e.period ?? ''}</td>
              <td className="mono">{e.partiya_no ?? ''}</td>
              <td>{e.created_by_name ?? ''}</td>
              {canDelete && (
                <td>
                  <button className="x" aria-label="O'chirish" disabled={pending} onClick={() => confirm(e.pair_id ? 'Yozuv juftligi (chiqim + kirim) bilan o\'chirilsinmi?' : 'Yozuv o\'chirilsinmi?') && onDelete(e.id)}>
                    ✕
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Kassa jurnali (Kassa Baza) ----------
export function CashJournalPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useCashInvalidate();
  const meta = useMeta();
  const [f, setF] = useState({ from: monthStart(), to: today(), wallet_id: '', op_type_id: '', item_id: '', currency: '', q: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const q = useQuery({ queryKey: ['cash', 'entries', qs], queryFn: () => api<CashEntry[]>(`/cash/entries?${qs}`) });
  const del = useMutation({
    mutationFn: (id: number) => api(`/cash/entries/${id}`, { method: 'DELETE' }),
    onSuccess: () => inv(),
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  if (!me) return null;
  const m = meta.data;
  const rows = q.data ?? [];
  const byCur = CURS.map((c) => [c, rows.filter((r) => r.currency === c)] as const).filter(([, l]) => l.length);
  return (
    <>
      <PageHead title="Kassa jurnali" sub="Barcha kassa yozuvlari (Kassa Baza): filtr, qidirish, o'chirish" />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <Field label="Sanadan">
            <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          </Field>
          <Field label="Sanagacha">
            <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
          </Field>
          <Field label="Hamyon">
            <WalletSelect meta={m} value={f.wallet_id} onChange={(v) => setF({ ...f, wallet_id: v })} label="Hamyon" all="Hammasi" />
          </Field>
          <Field label="Tranzaksiya">
            <select value={f.op_type_id} onChange={(e) => setF({ ...f, op_type_id: e.target.value })}>
              <option value="">Hammasi</option>
              {m?.op_types.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Xarajat elementi">
            <select value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })}>
              <option value="">Hammasi</option>
              {m?.items.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Valyuta">
            <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
              <option value="">Hammasi</option>
              {CURS.map((c) => (
                <option key={c} value={c}>
                  {CUR_LABEL[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Qidirish (kontragent, izoh, shaxs)">
            <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          </Field>
        </div>
        <ErrorText error={q.error ?? meta.error} />
        {!!rows.length && (
          <p className="note" style={{ marginBottom: 8 }}>
            {rows.length} ta yozuv ·{' '}
            {byCur.map(([c, l]) => `${CUR_LABEL[c]}: kirim ${money(l.reduce((a, r) => a + Number(r.amount_in), 0))}, chiqim ${money(l.reduce((a, r) => a + Number(r.amount_out), 0))}`).join(' | ')}
          </p>
        )}
        {!rows.length ? <p className="note">Yozuv yo'q.</p> : <EntriesTable rows={rows} showDate canDelete={can.cashWrite(me.role)} onDelete={(id) => del.mutate(id)} pending={del.isPending} />}
      </div>
    </>
  );
}

// ---------- Kassa hisobot ----------
export function CashReportPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useQuery({ queryKey: ['cash', 'report', from, to], queryFn: () => api<CashReport>(`/cash/report?from=${from}&to=${to}`), enabled: !!from && !!to });
  const d = q.data;
  const curs = CURS.filter((c) => d?.wallets.some((w) => w.currency === c));
  const groups = [...new Set((d?.by_item ?? []).map((x) => x.group_code))];
  return (
    <>
      <PageHead title="Kassa hisobot" sub="Hamyonlar bo'yicha qoldiq va aylanma, tranzaksiya turlari va xarajat elementlari bo'yicha" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <Field label="Sanadan">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Sanagacha">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <ErrorText error={q.error} />
        {curs.map((c) => {
          const ws = (d?.wallets ?? []).filter((w) => w.currency === c);
          const tot = (k: 'opening' | 'sales_in' | 'other_in' | 'out' | 'closing') => ws.reduce((a, w) => a + Number(w[k]), 0);
          return (
            <Fragment key={c}>
              <h2>{CUR_LABEL[c]}</h2>
              <div className="tw" style={{ marginBottom: 14 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Hamyon</th>
                      <th className="n">Qoldiq kun boshiga</th>
                      <th className="n">Sotuvdan kirim</th>
                      <th className="n">Boshqa kirim</th>
                      <th className="n">Chiqim</th>
                      <th className="n">Qoldiq oxiri</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ws.map((w) => (
                      <tr key={w.wallet_id}>
                        <td>
                          {w.wallet_name} <span className="note">· {KIND[w.kind as CashWallet['kind']]}</span>
                        </td>
                        <td className="n">{money(w.opening)}</td>
                        <td className="n">{amt(w.sales_in)}</td>
                        <td className="n">{amt(w.other_in)}</td>
                        <td className="n">{amt(w.out)}</td>
                        <td className="n">
                          <b className={Number(w.closing) < 0 ? 'err' : ''}>{money(w.closing)}</b>
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <b>Jami</b>
                      </td>
                      {(['opening', 'sales_in', 'other_in', 'out', 'closing'] as const).map((k) => (
                        <td key={k} className="n">
                          <b>{money(tot(k))}</b>
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </Fragment>
          );
        })}
        {d && !d.wallets.length && <p className="note">Yozuv yo'q.</p>}
      </div>
      {d && d.by_op.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Tranzaksiya turlari bo'yicha</h2>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Tranzaksiya</th>
                  <th>Valyuta</th>
                  <th className="n">Kirim</th>
                  <th className="n">Chiqim</th>
                  <th className="n">Farq</th>
                  <th className="n">So'mda (kurs bo'yicha)</th>
                </tr>
              </thead>
              <tbody>
                {d.by_op.map((r) => (
                  <tr key={`${r.op_type_id}:${r.currency}`}>
                    <td>{r.op_name}</td>
                    <td>{CUR_LABEL[r.currency]}</td>
                    <td className="n">{amt(r.amount_in)}</td>
                    <td className="n">{amt(r.amount_out)}</td>
                    <td className="n">
                      <b>{money(r.net)}</b>
                    </td>
                    <td className="n">{money(r.net_uzs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note" style={{ marginTop: 8 }}>
            Ichki transfer va ayriboshlash hamyonlar orasida — jami 0 ga yaqin bo'ladi (ayriboshlashda kurs farqi qoladi).
          </p>
        </div>
      )}
      {d && d.by_item.length > 0 && (
        <div className="card">
          <h2>Xarajat elementlari bo'yicha (so'mda)</h2>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Kod</th>
                  <th>Xarajat elementi</th>
                  <th>Markaz</th>
                  <th className="n">Summa</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const list = d.by_item.filter((x) => x.group_code === g);
                  return (
                    <Fragment key={g}>
                      <tr>
                        <th colSpan={3} scope="rowgroup">
                          {g} · {list[0].group_name ?? ''}
                        </th>
                        <th className="n">{money(list.reduce((a, x) => a + Number(x.amount_uzs), 0))}</th>
                      </tr>
                      {list.map((x) => (
                        <tr key={`${x.item_id}:${x.center_name}`}>
                          <td className="mono">{x.code}</td>
                          <td>{x.name}</td>
                          <td>{x.center_name ?? ''}</td>
                          <td className="n">{money(x.amount_uzs)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
                <tr>
                  <td colSpan={3}>
                    <b>Jami</b>
                  </td>
                  <td className="n">
                    <b>{money(d.by_item.reduce((a, x) => a + Number(x.amount_uzs), 0))}</b>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ---------- Avans-hisobot ----------
export function CashAvansPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useQuery({ queryKey: ['cash', 'avans', from, to], queryFn: () => api<CashAvans[]>(`/cash/avans?from=${from}&to=${to}`), enabled: !!from && !!to });
  const bal = useQuery({ queryKey: ['cash', 'balances', 'now'], queryFn: () => api<CashBalance[]>('/cash/balances') });
  return (
    <>
      <PageHead title="Avans-hisobot" sub="Javobgar shaxsga topshirilgan pul va u hisobot bergan xarajat; qoldiq — hali hisobot berilmagani" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ marginBottom: 12 }}>
          <Field label="Sanadan">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Sanagacha">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <ErrorText error={q.error} />
        {!q.data?.length ? (
          <p className="note">Yozuv yo'q. Avans berish: «Kassa kiritish»da tranzaksiya «Avans-hisobot tizimi», qayerga — «Avans-hisobot tizimi» hamyoni, ma'sul shaxs — kimga.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Javobgar shaxs</th>
                  <th>Valyuta</th>
                  <th className="n">Davr boshiga</th>
                  <th className="n">Topshirilgan</th>
                  <th className="n">Hisobot bergan</th>
                  <th className="n">Davr oxiri</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((r) => (
                  <tr key={`${r.responsible}:${r.currency}`}>
                    <td>{r.responsible}</td>
                    <td>{CUR_LABEL[r.currency]}</td>
                    <td className="n">{money(r.opening)}</td>
                    <td className="n">{amt(r.given)}</td>
                    <td className="n">{amt(r.reported)}</td>
                    <td className="n">
                      <b>{money(r.closing)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Hamyonlardagi hozirgi qoldiq</h2>
        <ErrorText error={bal.error} />
        <div className="tw">
          <table>
            <tbody>
              {(bal.data ?? []).map((b) => (
                <tr key={`${b.wallet_id}:${b.currency}`}>
                  <td>{b.wallet_name}</td>
                  <td>{CUR_LABEL[b.currency]}</td>
                  <td className="n">
                    <b className={Number(b.balance) < 0 ? 'err' : ''}>{money(b.balance)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ---------- Hamyonlar va xarajat elementlari ----------
export function CashSettingsPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useCashInvalidate();
  const meta = useMeta();
  const [w, setW] = useState({ name: '', business: 'moliya' as CashWallet['business'], kind: 'naqd' as CashWallet['kind'] });
  const [it, setIt] = useState({ code: '', name: '' });
  const addW = useMutation({
    mutationFn: () => api('/cash/wallets', { method: 'POST', body: w }),
    onSuccess: () => {
      inv();
      setW({ ...w, name: '' });
      toast('Hamyon qo\'shildi');
    },
  });
  const patchW = useMutation({
    mutationFn: (b: { id: number; body: object }) => api(`/cash/wallets/${b.id}`, { method: 'PATCH', body: b.body }),
    onSuccess: () => inv(),
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  const addI = useMutation({
    mutationFn: () => api('/cash/items', { method: 'POST', body: { code: num(it.code), name: it.name } }),
    onSuccess: () => {
      inv();
      setIt({ code: '', name: '' });
      toast('Xarajat elementi qo\'shildi');
    },
  });
  const patchI = useMutation({
    mutationFn: (b: { id: number; body: object }) => api(`/cash/items/${b.id}`, { method: 'PATCH', body: b.body }),
    onSuccess: () => inv(),
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  if (!me) return null;
  const write = can.cashManage(me.role);
  const m = meta.data;
  return (
    <>
      <PageHead title="Hamyonlar va xarajat elementlari" sub="Kassa ma'lumotnomalari" />
      <ErrorText error={meta.error} />
      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Hamyonlar</h2>
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Nomi</th>
                <th>Bo'lim</th>
                <th>Turi</th>
                <th>Faol</th>
              </tr>
            </thead>
            <tbody>
              {(m?.wallets ?? []).map((x) => (
                <tr key={x.id} style={x.is_active ? undefined : { opacity: 0.55 }}>
                  <td>{x.name}</td>
                  <td>
                    {write ? (
                      <select value={x.business} onChange={(e) => patchW.mutate({ id: x.id, body: { business: e.target.value } })} aria-label="Bo'lim">
                        {Object.entries(BUSINESS).map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                          </option>
                        ))}
                      </select>
                    ) : (
                      BUSINESS[x.business]
                    )}
                  </td>
                  <td>{KIND[x.kind]}</td>
                  <td>{write ? <input type="checkbox" checked={x.is_active} onChange={(e) => patchW.mutate({ id: x.id, body: { is_active: e.target.checked } })} aria-label={`${x.name} faol`} /> : x.is_active ? 'ha' : "yo'q"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {write && (
          <div className="row" style={{ marginTop: 10 }}>
            <input placeholder="Yangi hamyon nomi" value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} aria-label="Hamyon nomi" />
            <select value={w.business} onChange={(e) => setW({ ...w, business: e.target.value as CashWallet['business'] })} aria-label="Bo'lim">
              {Object.entries(BUSINESS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <select value={w.kind} onChange={(e) => setW({ ...w, kind: e.target.value as CashWallet['kind'] })} aria-label="Turi">
              {Object.entries(KIND).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <button className="btn sm" disabled={!w.name.trim() || addW.isPending} onClick={() => addW.mutate()}>
              Qo'shish
            </button>
            <ErrorText error={addW.error} />
          </div>
        )}
      </div>
      <div className="card">
        <h2>Xarajat elementlari</h2>
        {write && (
          <div className="row" style={{ marginBottom: 10 }}>
            <input className="num" inputMode="numeric" placeholder="Kod (4021)" value={it.code} onChange={(e) => setIt({ ...it, code: e.target.value })} aria-label="Kod" style={{ width: 110 }} />
            <input placeholder="Nomi" value={it.name} onChange={(e) => setIt({ ...it, name: e.target.value })} aria-label="Nomi" />
            <button className="btn sm" disabled={!it.name.trim() || !(num(it.code) >= 1000) || addI.isPending} onClick={() => addI.mutate()}>
              Qo'shish
            </button>
            <ErrorText error={addI.error} />
          </div>
        )}
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Kod</th>
                <th>Nomi</th>
                <th>Guruh</th>
                <th>Faol</th>
              </tr>
            </thead>
            <tbody>
              {(m?.items ?? []).map((x) => (
                <tr key={x.id} style={x.is_active ? undefined : { opacity: 0.55 }}>
                  <td className="mono">{x.code}</td>
                  <td>{x.name}</td>
                  <td>
                    {x.group_code} {x.group_name ?? ''}
                  </td>
                  <td>{write ? <input type="checkbox" checked={x.is_active} onChange={(e) => patchI.mutate({ id: x.id, body: { is_active: e.target.checked } })} aria-label={`${x.name} faol`} /> : x.is_active ? 'ha' : "yo'q"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
