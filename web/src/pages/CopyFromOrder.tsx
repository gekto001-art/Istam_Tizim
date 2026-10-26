import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ErrorText, Modal, fmtDate, fmtNum } from '../components/ui';
import type { OrderDetail, OrderRow } from '../types';
import { ORDER_STATUS } from './Orders';

type CopyResult = OrderDetail & { copy: { lines: number; skipped: number; works: number; items: number } };

/**
 * Oldingi zakazdan olish: bir xil model qayta tikilganda xomashyo normasi, ish narxlari,
 * kerak bo'lsa razmer × rang jadvali va sarlavha bitta bosishda ko'chiriladi.
 */
export function CopyFromOrderModal({ d, onClose, onDone }: { d: OrderDetail; onClose: () => void; onDone: (r: CopyResult) => void }) {
  const list = useQuery({ queryKey: ['orders', 'list', 'copy-source'], queryFn: () => api<OrderRow[]>('/orders?limit=500') });
  const o = d.order;
  // bir xil model / artikul / tovar birinchi
  const sources = useMemo(() => {
    const score = (x: OrderRow) =>
      (o.model && x.model === o.model ? 4 : 0) + (o.artikul && x.artikul === o.artikul ? 2 : 0) + (x.product_type_name === o.product_type_name ? 1 : 0);
    return (list.data ?? []).filter((x) => x.id !== o.id && x.status !== 'cancelled').sort((a, b) => score(b) - score(a) || b.order_date.localeCompare(a.order_date));
  }, [list.data, o]);
  const [sourceId, setSourceId] = useState('');
  const src = useQuery({ queryKey: ['orders', 'detail', Number(sourceId)], queryFn: () => api<OrderDetail>(`/orders/${sourceId}`), enabled: !!sourceId });
  const [parts, setParts] = useState({ header: false, items: d.items.length === 0, materials: true, works: true });
  const [replace, setReplace] = useState(true);
  const [adapt, setAdapt] = useState(true);
  const [map, setMap] = useState<Record<string, string>>({});

  // manbadagi xomashyosi bor ranglar
  const srcColors = useMemo(() => {
    const m = new Map<number, { name: string; n: number }>();
    for (const l of src.data?.materials ?? []) m.set(l.color_id, { name: l.color_name, n: (m.get(l.color_id)?.n ?? 0) + 1 });
    return [...m.entries()];
  }, [src.data]);
  // yangi zakazdagi ranglar (jadval ham ko'chirilsa — manbaniki)
  const targetColors = useMemo(
    () => [...new Map((parts.items ? (src.data?.items ?? []) : d.items).map((i) => [i.color_id, i.color_name])).entries()],
    [parts.items, src.data, d.items],
  );
  useEffect(() => {
    // odatiy moslik: o'sha rang bo'lsa — o'zi, bo'lmasa bo'sh (tanlanadi)
    setMap(Object.fromEntries(targetColors.map(([id]) => [String(id), srcColors.some(([s]) => s === id) ? String(id) : ''])));
  }, [targetColors, srcColors]);

  const m = useMutation({
    mutationFn: () =>
      api<CopyResult>(`/orders/${o.id}/copy-from`, {
        method: 'POST',
        body: {
          source_id: Number(sourceId),
          ...parts,
          replace_materials: replace,
          adapt_color: adapt,
          color_map: Object.entries(map).map(([t, s]) => ({ target_color_id: Number(t), source_color_id: s ? Number(s) : null })),
        },
      }),
    onSuccess: onDone,
  });
  const any = parts.header || parts.items || parts.materials || parts.works;
  const noMatrix = parts.materials && !targetColors.length;
  const toggle = (k: keyof typeof parts) => setParts({ ...parts, [k]: !parts[k] });
  return (
    <Modal title="Oldingi zakazdan olish" onClose={onClose}>
      <label className="f">
        Qaysi zakazdan
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} autoFocus>
          <option value="">— tanlang —</option>
          {sources.map((x) => (
            <option key={x.id} value={x.id}>
              {x.partiya_no} · {x.product_type_name}
              {x.model ? ` · model ${x.model}` : ''}
              {x.artikul ? ` · ${x.artikul}` : ''} · {fmtDate(x.order_date)} · {ORDER_STATUS[x.status][0]}
              {o.model && x.model === o.model ? '  ★ shu model' : ''}
            </option>
          ))}
        </select>
      </label>
      <ErrorText error={list.error ?? src.error} />
      {src.data && (
        <p className="note">
          Partiya {src.data.order.partiya_no}: {fmtNum(src.data.totals.qty)} dona, {src.data.materials.length} ta xomashyo qatori, {src.data.works.length} ta ish narxi.
        </p>
      )}

      <div className="grid" style={{ gap: 6 }}>
        <span className="note">Nimani olish:</span>
        <label className="chk">
          <input type="checkbox" checked={parts.materials} onChange={() => toggle('materials')} /> Xomashyo normasi
        </label>
        <label className="chk">
          <input type="checkbox" checked={parts.works} onChange={() => toggle('works')} /> Ish narxlari (kroy, tikuv)
        </label>
        <label className="chk">
          <input type="checkbox" checked={parts.items} onChange={() => toggle('items')} /> Razmer × rang jadvali (sonlar bilan)
        </label>
        <label className="chk">
          <input type="checkbox" checked={parts.header} onChange={() => toggle('header')} /> Sarlavha: tovar, artikul, model, mavsum, korxona, kim berdi
        </label>
      </div>

      {parts.materials && src.data && (
        <div className="grid" style={{ gap: 6 }}>
          <span className="note">Ranglar mosligi — yangi zakazdagi har rang uchun qaysi rangning normasi olinadi:</span>
          {noMatrix ? (
            <p className="err">Bu zakazda razmer × rang jadvali bo'sh — avval jadvalni to'ldiring yoki "Razmer × rang jadvali"ni ham belgilang.</p>
          ) : (
            <table className="picker">
              <tbody>
                {targetColors.map(([id, name]) => (
                  <tr key={id}>
                    <td>
                      <b>{name}</b>
                    </td>
                    <td>←</td>
                    <td>
                      <select aria-label={`${name} uchun manba rang`} value={map[String(id)] ?? ''} onChange={(e) => setMap({ ...map, [String(id)]: e.target.value })}>
                        <option value="">— olinmasin —</option>
                        {srcColors.map(([sid, s]) => (
                          <option key={sid} value={sid}>
                            {s.name} ({s.n} qator)
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <label className="chk">
            <input type="checkbox" checked={adapt} onChange={(e) => setAdapt(e.target.checked)} /> Mato rangi mahsulot rangi bilan bir xil bo'lsa — yangi rangga moslash
          </label>
          <label className="chk">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Mavjud xomashyo qatorlarini almashtirish (belgilanmasa — qo'shiladi)
          </label>
          <p className="note">Valyuta kursi yangi zakaz sanasidagi kurs bilan olinadi. Yangi zakazda yo'q razmerga bog'langan qatorlar o'tkazib yuboriladi.</p>
        </div>
      )}
      <ErrorText error={m.error} />
      <div className="actions">
        <button className="btn" disabled={!sourceId || !any || noMatrix || m.isPending} onClick={() => m.mutate()}>
          Olish
        </button>
      </div>
    </Modal>
  );
}
