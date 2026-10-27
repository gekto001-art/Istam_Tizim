import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import { can, type BillzSales, type BillzSettings, type BillzStockRow } from '../types';
import { money } from './purchaseUi';
import { today } from './stockUi';

const useSettings = () => useQuery({ queryKey: ['billz', 'settings'], queryFn: () => api<BillzSettings>('/billz/settings'), refetchInterval: 60_000 });

/** Oxirgi yangilanish holati va "Hozir yangilash" tugmasi */
function SyncBar() {
  const toast = useToast();
  const qc = useQueryClient();
  const s = useSettings();
  const sync = useMutation({
    mutationFn: () => api<{ stock_rows: number; sales_rows: number }>('/billz/sync', { method: 'POST' }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['billz'] });
      toast(`Billz'dan olindi: qoldiq ${r.stock_rows} qator, sotuv ${r.sales_rows} qator`);
    },
    onError: () => qc.invalidateQueries({ queryKey: ['billz', 'settings'] }),
  });
  const last = s.data?.runs[0];
  const lastOk = s.data?.runs.find((r) => r.ok);
  if (!s.data) return null;
  return (
    <div className="banner row" style={{ justifyContent: 'space-between' }}>
      <span>
        {!s.data.configured ? (
          'Billz ulanmagan — admin «Billz sozlamalari»da kalitni kiritadi.'
        ) : (
          <>
            {s.data.enabled ? 'Har 5 daqiqada avtomatik yangilanadi.' : 'Avtomatik yangilash o\'chirilgan.'} Oxirgi muvaffaqiyatli:{' '}
            <b>{lastOk ? fmtDateTime(lastOk.finished_at) : '—'}</b>
            {last && last.ok === false && <span className="err"> · oxirgi urinish xato: {last.message}</span>}
          </>
        )}
      </span>
      {s.data.configured && (
        <button className="btn sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
          {sync.isPending ? 'Yangilanmoqda…' : 'Hozir yangilash'}
        </button>
      )}
      <ErrorText error={sync.error} />
    </div>
  );
}

function ShopFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const s = useSettings();
  const shops = (s.data?.shops ?? []).filter((x) => !s.data?.shop_ids.length || s.data.shop_ids.includes(x.id));
  return (
    <label className="f">
      Do'kon
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Hammasi</option>
        {shops.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------- Billz qoldiq ----------
export function BillzStockPage() {
  const [shop, setShop] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const qs = new URLSearchParams({ ...(shop && { shop_id: shop }), ...(search && { q: search }) }).toString();
  const r = useQuery({ queryKey: ['billz', 'stock', qs], queryFn: () => api<BillzStockRow[]>(`/billz/stock${qs ? `?${qs}` : ''}`) });
  const rows = r.data ?? [];
  const sum = (f: (x: BillzStockRow) => number) => rows.reduce((a, x) => a + f(x), 0);
  return (
    <>
      <PageHead title="Billz qoldiq" sub="Tayyor mahsulot qoldig'i Billz'dan (do'kon × tovar, barcode)" />
      <SyncBar />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <ShopFilter value={shop} onChange={setShop} />
          <label className="f">
            Qidirish (nomi, SKU, barcode)
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rubashka, 2000000…" />
          </label>
        </div>
        <ErrorText error={r.error} />
        {!rows.length ? (
          <p className="note">Ma'lumot yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1200 }}>
              <thead>
                <tr>
                  <th>Do'kon</th>
                  <th>Tovar nomi</th>
                  <th>SKU</th>
                  <th>Barcode</th>
                  <th>Kategoriya</th>
                  <th className="n">Qoldiq</th>
                  <th className="n">Tannarx</th>
                  <th className="n">Sotuv narxi</th>
                  <th className="n">Summa (tannarx)</th>
                  <th className="n">Summa (sotuv)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={`${x.shop_id}:${x.product_id}`}>
                    <td>{x.shop_name ?? ''}</td>
                    <td>
                      <b>{x.product_name}</b>
                      {x.brand_name && <div className="note">{x.brand_name}</div>}
                    </td>
                    <td className="mono">{x.sku ?? ''}</td>
                    <td className="mono">{x.barcode ?? ''}</td>
                    <td className="note">{x.categories ?? ''}</td>
                    <td className="n">
                      <b>{fmtNum(x.qty)}</b> <span className="note">{x.unit ?? ''}</span>
                    </td>
                    <td className="n">{x.supply_price == null ? '' : money(x.supply_price)}</td>
                    <td className="n">{x.retail_price == null ? '' : money(x.retail_price)}</td>
                    <td className="n">{money(Number(x.qty) * Number(x.supply_price ?? 0))}</td>
                    <td className="n">{money(Number(x.qty) * Number(x.retail_price ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!!rows.length && (
          <p className="note" style={{ marginTop: 8 }}>
            {rows.length} qator · jami {fmtNum(sum((x) => Number(x.qty)))} · tannarxda {money(sum((x) => Number(x.qty) * Number(x.supply_price ?? 0)))} so'm · sotuv narxida{' '}
            {money(sum((x) => Number(x.qty) * Number(x.retail_price ?? 0)))} so'm
          </p>
        )}
      </div>
    </>
  );
}

// ---------- Billz sotuv ----------
const monthStart = () => `${today().slice(0, 8)}01`;

export function BillzSalesPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [shop, setShop] = useState('');
  const [by, setBy] = useState<'product' | 'day'>('product');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const qs = new URLSearchParams({ from, to, by, ...(shop && { shop_id: shop }), ...(search && { q: search }) }).toString();
  const r = useQuery({ queryKey: ['billz', 'sales', qs], queryFn: () => api<BillzSales>(`/billz/sales?${qs}`), enabled: !!from && !!to });
  const t = r.data?.total;
  return (
    <>
      <PageHead title="Billz sotuv" sub="Billz'dagi sotuvlar: tovar yoki kun bo'yicha (sof sotuv, qaytarish, foyda)" />
      <SyncBar />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <label className="f">
            Sanadan
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="f">
            Sanagacha
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <ShopFilter value={shop} onChange={setShop} />
          <label className="f">
            Ko'rinish
            <select value={by} onChange={(e) => setBy(e.target.value as 'product' | 'day')}>
              <option value="product">Tovar bo'yicha</option>
              <option value="day">Kun bo'yicha</option>
            </select>
          </label>
          <label className="f">
            Qidirish
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="nomi, SKU, barcode" />
          </label>
        </div>
        {t && (
          <div className="cards" style={{ marginBottom: 12 }}>
            {(
              [
                ['Sotilgan (dona)', fmtNum(t.sold)],
                ['Qaytarilgan', fmtNum(t.returned)],
                ['Sof sotuv', `${money(t.net_sales)} so'm`],
                ['Tannarx', `${money(t.supply_sum)} so'm`],
                ['Sof foyda', `${money(t.net_profit)} so'm`],
              ] as const
            ).map(([l, v]) => (
              <div key={l} className="card stat">
                <span className="note">{l}</span>
                <b>{v}</b>
              </div>
            ))}
          </div>
        )}
        <ErrorText error={r.error} />
        {!r.data?.rows.length ? (
          <p className="note">Bu oraliqda sotuv yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1200 }}>
              <thead>
                <tr>
                  {by === 'day' ? (
                    <th>Sana</th>
                  ) : (
                    <>
                      <th>Tovar nomi</th>
                      <th>SKU</th>
                      <th>Barcode</th>
                    </>
                  )}
                  <th className="n">Sotilgan</th>
                  <th className="n">Qaytarilgan</th>
                  <th className="n">Sof (dona)</th>
                  <th className="n">Yalpi sotuv</th>
                  <th className="n">Qaytarish summasi</th>
                  <th className="n">Chegirma</th>
                  <th className="n">Sof sotuv</th>
                  <th className="n">Tannarx</th>
                  <th className="n">Sof foyda</th>
                </tr>
              </thead>
              <tbody>
                {r.data.rows.map((x, i) => (
                  <tr key={x.product_id ?? x.date ?? i}>
                    {by === 'day' ? (
                      <td className="mono">{fmtDate(x.date)}</td>
                    ) : (
                      <>
                        <td>
                          <b>{x.product_name}</b>
                        </td>
                        <td className="mono">{x.sku ?? ''}</td>
                        <td className="mono">{x.barcode ?? ''}</td>
                      </>
                    )}
                    <td className="n">{fmtNum(x.sold)}</td>
                    <td className="n">{Number(x.returned) ? fmtNum(x.returned) : ''}</td>
                    <td className="n">
                      <b>{fmtNum(x.net_sold)}</b>
                    </td>
                    <td className="n">{money(x.gross_sales)}</td>
                    <td className="n">{Number(x.returned_sum) ? money(x.returned_sum) : ''}</td>
                    <td className="n">{Number(x.discount) ? money(x.discount) : ''}</td>
                    <td className="n">
                      <b>{money(x.net_sales)}</b>
                    </td>
                    <td className="n">{money(x.supply_sum)}</td>
                    <td className="n">{money(x.net_profit)}</td>
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

// ---------- Billz sozlamalari ----------
export function BillzSettingsPage() {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const s = useSettings();
  const [secret, setSecret] = useState('');
  const [shopIds, setShopIds] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [salesStart, setSalesStart] = useState('');
  useEffect(() => {
    if (!s.data) return;
    setShopIds(s.data.shop_ids);
    setEnabled(s.data.enabled);
    setSalesStart(s.data.sales_start?.slice(0, 10) ?? '');
  }, [s.data]);
  const save = useMutation({
    mutationFn: (body: object) => api<BillzSettings>('/billz/settings', { method: 'PUT', body }),
    onSuccess: (r) => {
      qc.setQueryData(['billz', 'settings'], r);
      setSecret('');
      toast('Billz sozlamalari saqlandi');
    },
  });
  if (!me || !s.data) return <ErrorText error={s.error} />;
  const manage = can.billzManage(me.role);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ ...(secret.trim() && { secret_token: secret.trim() }), enabled, shop_ids: shopIds, sales_start: salesStart || null });
  };
  return (
    <>
      <PageHead title="Billz sozlamalari" sub="Billz'dan tayyor mahsulot qoldig'i va sotuvlarni har 5 daqiqada olish" />
      <form className="card" style={{ marginBottom: 14 }} onSubmit={submit}>
        <div className="form">
          <label className="f">
            Billz kaliti (secret token)
            <input
              type="password"
              autoComplete="off"
              value={secret}
              disabled={!manage}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={s.data.configured ? `kiritilgan (${s.data.token_hint ?? ''}) — almashtirish uchun yangisini yozing` : 'Billz → Sozlamalar → Integratsiyalar'}
            />
          </label>
          <label className="f">
            Sotuvlar qaysi sanadan olinsin
            <input type="date" value={salesStart} disabled={!manage} onChange={(e) => setSalesStart(e.target.value)} />
          </label>
          <label className="chk" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={enabled} disabled={!manage} onChange={(e) => setEnabled(e.target.checked)} />
            Har 5 daqiqada avtomatik yangilash
          </label>
        </div>
        <h2 style={{ marginTop: 16 }}>Do'konlar</h2>
        {!s.data.shops.length ? (
          <p className="note">Kalit saqlangach Billz'dagi do'konlar shu yerda chiqadi.</p>
        ) : (
          <div className="row" style={{ gap: 16 }}>
            {s.data.shops.map((x) => (
              <label key={x.id} className="chk">
                <input
                  type="checkbox"
                  disabled={!manage}
                  checked={shopIds.includes(x.id)}
                  onChange={(e) => setShopIds((v) => (e.target.checked ? [...v, x.id] : v.filter((id) => id !== x.id)))}
                />
                {x.name}
              </label>
            ))}
            <span className="note">Hech biri belgilanmasa — barcha do'konlar olinadi.</span>
          </div>
        )}
        <ErrorText error={save.error} />
        {manage && (
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn" disabled={save.isPending}>
              {save.isPending ? 'Billz bilan tekshirilmoqda…' : secret.trim() ? 'Tekshirish va saqlash' : 'Saqlash'}
            </button>
          </div>
        )}
        <p className="note" style={{ marginTop: 8 }}>
          Kalit serverda shifrlangan holda saqlanadi va hech qayerda qayta ko'rsatilmaydi. Yangi kalit kiritilganda avval Billz'ga kirib tekshiriladi.
        </p>
      </form>

      <SyncBar />
      <div className="card">
        <h2>Yangilanishlar jurnali</h2>
        {!s.data.runs.length ? (
          <p className="note">Hali yangilanmagan.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Boshlandi</th>
                  <th>Turi</th>
                  <th>Natija</th>
                  <th className="n">Qoldiq qatorlari</th>
                  <th className="n">Sotuv qatorlari</th>
                  <th>Izoh</th>
                </tr>
              </thead>
              <tbody>
                {s.data.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{fmtDateTime(r.started_at)}</td>
                    <td>{r.trigger === 'auto' ? 'Avtomatik' : "Qo'lda"}</td>
                    <td>{r.ok == null ? <span className="pill warn">ketmoqda</span> : r.ok ? <span className="pill good">OK</span> : <span className="pill bad">Xato</span>}</td>
                    <td className="n">{r.stock_rows ?? ''}</td>
                    <td className="n">{r.sales_rows ?? ''}</td>
                    <td className="note">{r.ok ? '' : r.message ?? ''}</td>
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
