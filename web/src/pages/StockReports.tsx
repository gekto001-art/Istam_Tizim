import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { ErrorText, PageHead, fmtDate, fmtNum } from '../components/ui';
import type { StockBalance, StockMove } from '../types';
import { money } from './purchaseUi';
import { ITEM_HEADS, ItemCells, destLabel, itemKey } from './stockUi';

// ---------- Ostatka ----------
export function OstatkaPage() {
  const [name, setName] = useState('');
  const q = useQuery({ queryKey: ['stock', 'balance'], queryFn: () => api<StockBalance[]>('/stock/balance') });
  const names = [...new Set((q.data ?? []).map((b) => b.material_name))];
  const rows = (q.data ?? []).filter((b) => !name || b.material_name === name);
  const total = rows.reduce((a, b) => a + Number(b.value_uzs ?? 0), 0);
  return (
    <>
      <PageHead title="Ostatka" sub="Ombordagi xomashyo qoldig'i va o'rtacha tannarx (prixod summasi ÷ prixod miqdori)" />
      <div className="card">
        <div className="form" style={{ marginBottom: 12 }}>
          <label className="f">
            Xomashyo nomi
            <select value={name} onChange={(e) => setName(e.target.value)}>
              <option value="">Hammasi</option>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>
        <ErrorText error={q.error} />
        {!rows.length ? (
          <p className="note">Omborda xomashyo yo'q.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 1000 }}>
              <thead>
                <tr>
                  <th>Tartib raqam</th>
                  {ITEM_HEADS.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                  <th>O'lchov birligi</th>
                  <th className="n">Miqdori</th>
                  <th className="n">O'rtacha narx, so'm</th>
                  <th className="n">Summa, so'm</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b, i) => (
                  <tr key={itemKey(b)} className={Number(b.qty) < 0 ? 'bad-row' : ''}>
                    <td className="mono">{i + 1}</td>
                    <ItemCells i={b} />
                    <td>{b.unit}</td>
                    <td className="n">
                      <b>{fmtNum(b.qty)}</b>
                    </td>
                    <td className="n">{b.avg_cost == null ? '—' : money(b.avg_cost)}</td>
                    <td className="n">{b.value_uzs == null ? '—' : money(b.value_uzs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!!rows.length && (
          <p className="note" style={{ marginTop: 8 }}>
            {rows.length} xil xomashyo · jami {money(total)} so'm
          </p>
        )}
      </div>
    </>
  );
}

// ---------- Nakladnoy ----------
export function NakladnoyPage() {
  const [orderId, setOrderId] = useState('');
  const list = useQuery({ queryKey: ['stock', 'nakladnoy'], queryFn: () => api<{ order_id: number; partiya_no: string }[]>('/stock/nakladnoy') });
  const d = useQuery({
    queryKey: ['stock', 'nakladnoy', orderId],
    queryFn: () =>
      api<{ order: { id: number; partiya_no: string; artikul: string | null; model: string | null; product_type_name: string; producer_name: string | null }; rows: StockMove[] }>(
        `/stock/nakladnoy/${orderId}`,
      ),
    enabled: !!orderId,
  });
  return (
    <>
      <PageHead title="Nakladnoy" sub="Partiya bo'yicha berilgan xomashyo (Rasxod) — chop etish uchun">
        {d.data && (
          <button className="btn ghost no-print" onClick={() => window.print()}>
            Chop etish
          </button>
        )}
      </PageHead>
      <div className="card no-print" style={{ marginBottom: 14 }}>
        <div className="form">
          <label className="f">
            Partiya raqam
            <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
              <option value="">— tanlang —</option>
              {list.data?.map((o) => (
                <option key={o.order_id} value={o.order_id}>
                  {o.partiya_no}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <ErrorText error={d.error} />
      {d.data && (
        <div className="card print-sheet">
          <h2>
            Nakladnoy · partiya {d.data.order.partiya_no}
          </h2>
          <p className="note">
            {[d.data.order.product_type_name, d.data.order.artikul, d.data.order.model, d.data.order.producer_name].filter(Boolean).join(' · ')}
          </p>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Tartib raqam</th>
                  <th>Sana</th>
                  {ITEM_HEADS.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                  <th className="n">Miqdor</th>
                  <th>Qayerga</th>
                  <th>Operatsiya</th>
                </tr>
              </thead>
              <tbody>
                {d.data.rows.map((m, i) => (
                  <tr key={m.id}>
                    <td className="mono">{i + 1}</td>
                    <td className="mono">{fmtDate(m.doc_date)}</td>
                    <ItemCells i={m} />
                    <td className="n">
                      {m.dir > 0 ? '−' : ''}
                      {fmtNum(m.qty)} <span className="note">{m.unit}</span>
                    </td>
                    <td>{destLabel(m)}</td>
                    <td>{m.op === 'vozvrat' ? 'Vozvrat' : 'Peremesheniya'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 40 }}>
            <span>Berdi: ____________________</span>
            <span>Qabul qildi: ____________________</span>
          </div>
        </div>
      )}
    </>
  );
}
