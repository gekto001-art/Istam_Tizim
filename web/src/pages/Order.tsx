import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Modal, PageHead, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import {
  can,
  CURRENCIES,
  type Color,
  type Material,
  type OrderDetail,
  type OrderMaterial,
  type Producer,
  type Size,
  type Supplier,
} from '../types';
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
                        qtyFmt(q(s, c) || null)
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
    </div>
  );
}

// ---------- Xomashyo qatori formasi ----------
function MaterialModal({
  d,
  line,
  colorId,
  onClose,
  onSaved,
}: {
  d: OrderDetail;
  line: OrderMaterial | null;
  colorId: number;
  onClose: () => void;
  onSaved: Save;
}) {
  const materials = useCatalog<Material>('materials');
  const suppliers = useCatalog<Supplier>('suppliers');
  const colors = useCatalog<Color>('colors');
  const matrixColors = d.by_color;
  const [colorIds, setColorIds] = useState<number[]>([colorId]);
  const [f, setF] = useState({
    material_id: line ? String(line.material_id) : '',
    supplier_id: line?.supplier_id ? String(line.supplier_id) : '',
    material_color_id: line?.material_color_id ? String(line.material_color_id) : '',
    color_code: line?.color_code ?? '',
    material_size: line?.material_size ?? '',
    per_unit: plain(line?.per_unit),
    price: plain(line?.price),
    currency: line?.currency ?? 'UZS',
    rate: line && line.currency !== 'UZS' ? plain(line.rate) : '',
    from_us: line?.from_us ?? true,
    note: line?.note ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const mat = materials.data?.find((x) => String(x.id) === f.material_id);
  const m = useMutation({
    mutationFn: () => {
      const body = {
        material_id: Number(f.material_id),
        supplier_id: f.supplier_id ? Number(f.supplier_id) : null,
        material_color_id: f.material_color_id ? Number(f.material_color_id) : null,
        color_code: f.color_code,
        material_size: f.material_size,
        per_unit: num(f.per_unit),
        price: f.price ? num(f.price) : 0,
        currency: f.currency,
        rate: f.currency !== 'UZS' && f.rate ? num(f.rate) : null,
        from_us: f.from_us,
        note: f.note,
      };
      return line
        ? api<OrderDetail>(`/orders/${d.order.id}/materials/${line.id}`, { method: 'PATCH', body })
        : api<OrderDetail>(`/orders/${d.order.id}/materials`, { method: 'POST', body: { ...body, color_ids: colorIds } });
    },
    onSuccess: (r) => {
      onSaved(r, line ? 'Xomashyo qatori saqlandi' : `Xomashyo ${colorIds.length} ta rangga qo'shildi`);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  const toggle = (id: number) => setColorIds(colorIds.includes(id) ? colorIds.filter((x) => x !== id) : [...colorIds, id]);
  const all = colorIds.length === matrixColors.length;
  // 1 dona uchun so'mda (ko'rsatish uchun)
  const preview = f.per_unit && f.price ? num(f.per_unit) * num(f.price) * (f.currency === 'UZS' ? 1 : f.rate ? num(f.rate) : NaN) : null;
  return (
    <Modal title={line ? `Xomashyo (${line.color_name})` : 'Xomashyo qo\'shish'} onClose={onClose}>
      <form className="form one" onSubmit={submit}>
        {!line && (
          <div className="grid" style={{ gap: 6 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="note">Qaysi rangdagi mahsulot uchun (bir xil xomashyo bo'lsa — bir nechtasini belgilang):</span>
              {matrixColors.length > 1 && (
                <button type="button" className="btn ghost sm" onClick={() => setColorIds(all ? [colorId] : matrixColors.map((c) => c.color_id))}>
                  {all ? 'Faqat shu rang' : 'Barcha ranglar'}
                </button>
              )}
            </div>
            <div className="row">
              {matrixColors.map((c) => (
                <label key={c.color_id} className="chk">
                  <input type="checkbox" checked={colorIds.includes(c.color_id)} onChange={() => toggle(c.color_id)} /> {c.color_name}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="form">
          <Field label="Xomashyo">
            <select
              value={f.material_id}
              required
              autoFocus
              onChange={(e) => {
                const x = materials.data?.find((mm) => String(mm.id) === e.target.value);
                setF({ ...f, material_id: e.target.value, supplier_id: f.supplier_id || (x?.supplier_id ? String(x.supplier_id) : '') });
              }}
            >
              <option value="">—</option>
              {(materials.data ?? [])
                .filter((x) => x.is_active || String(x.id) === f.material_id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.code ? ` · ${x.code}` : ''}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Postavshik">
            <select value={f.supplier_id} onChange={set('supplier_id')}>
              <option value="">—</option>
              {(suppliers.data ?? [])
                .filter((x) => x.is_active || String(x.id) === f.supplier_id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Xomashyo rangi">
            <select value={f.material_color_id} onChange={set('material_color_id')}>
              <option value="">—</option>
              {(colors.data ?? [])
                .filter((x) => x.is_active || String(x.id) === f.material_color_id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Rang kodi">
            <input value={f.color_code} onChange={set('color_code')} maxLength={30} />
          </Field>
          <Field label="Xomashyo razmeri">
            <input value={f.material_size} onChange={set('material_size')} maxLength={30} placeholder="16, 20/31" />
          </Field>
          <Field label={`1 donaga sarf${mat ? `, ${mat.unit}` : ''}`}>
            <input value={f.per_unit} inputMode="decimal" required onChange={set('per_unit')} />
          </Field>
          <Field label="Narx (1 birlik)">
            <input value={f.price} inputMode="decimal" onChange={set('price')} />
          </Field>
          <Field label="Valyuta">
            <select value={f.currency} onChange={set('currency')}>
              {Object.entries(CURRENCIES).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {f.currency !== 'UZS' && (
            <Field label="Kurs (bo'sh — zakaz sanasidagi)">
              <input value={f.rate} inputMode="decimal" onChange={set('rate')} />
            </Field>
          )}
        </div>
        <label className="chk">
          <input type="checkbox" checked={f.from_us} onChange={(e) => setF({ ...f, from_us: e.target.checked })} /> Xomashyo bizdan (korxonaga biz beramiz)
        </label>
        <Field label="Izoh">
          <input value={f.note} onChange={set('note')} maxLength={300} />
        </Field>
        {preview != null && !Number.isNaN(preview) && <p className="note">1 dona mahsulotga: {money(preview)} so'm</p>}
        <ErrorText error={m.error} />
        <div className="actions">
          <button className="btn" disabled={m.isPending || (!line && !colorIds.length)}>
            Saqlash
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CopyModal({ d, from, onClose, onSaved }: { d: OrderDetail; from: number; onClose: () => void; onSaved: Save }) {
  const targets = d.by_color.filter((c) => c.color_id !== from);
  const [sel, setSel] = useState<number[]>(targets.filter((c) => !d.materials.some((m) => m.color_id === c.color_id)).map((c) => c.color_id));
  const m = useMutation({
    mutationFn: () => api<OrderDetail>(`/orders/${d.order.id}/materials/copy`, { method: 'POST', body: { from_color_id: from, to_color_ids: sel } }),
    onSuccess: (r) => {
      onSaved(r, 'Nusxa olindi');
      onClose();
    },
  });
  return (
    <Modal title={`${d.by_color.find((c) => c.color_id === from)?.color_name} — xomashyoni nusxalash`} onClose={onClose}>
      <p className="note">Shu rangdagi barcha xomashyo qatorlari tanlangan ranglarga qo'shiladi. Keyin farqli qatorlarni (masalan, mato rangi) tahrirlang.</p>
      <div className="row">
        {targets.map((c) => (
          <label key={c.color_id} className="chk">
            <input type="checkbox" checked={sel.includes(c.color_id)} onChange={() => setSel(sel.includes(c.color_id) ? sel.filter((x) => x !== c.color_id) : [...sel, c.color_id])} />{' '}
            {c.color_name}
          </label>
        ))}
      </div>
      <ErrorText error={m.error} />
      <div className="actions">
        <button className="btn" disabled={!sel.length || m.isPending} onClick={() => m.mutate()}>
          Nusxalash
        </button>
      </div>
    </Modal>
  );
}

// ---------- Rang bo'yicha xomashyo normasi ----------
function MaterialsCard({ d, editable, onSaved }: { d: OrderDetail; editable: boolean; onSaved: Save }) {
  const [colorId, setColorId] = useState<number | null>(null);
  const [edit, setEdit] = useState<OrderMaterial | 'new' | null>(null);
  const [copy, setCopy] = useState(false);
  const cid = colorId && d.by_color.some((c) => c.color_id === colorId) ? colorId : d.by_color[0]?.color_id;
  const lines = d.materials.filter((m) => m.color_id === cid);
  const cur = d.by_color.find((c) => c.color_id === cid);
  const del = useMutation({
    mutationFn: (mid: number) => api<OrderDetail>(`/orders/${d.order.id}/materials/${mid}`, { method: 'DELETE' }),
    onSuccess: (r) => onSaved(r, 'Qator o\'chirildi'),
  });
  if (!d.by_color.length) {
    return (
      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Xomashyo normasi</h2>
        <p className="note">Avval razmer × rang jadvalini to'ldiring — xomashyo har rangdagi mahsulot uchun yoziladi.</p>
      </div>
    );
  }
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h2>Xomashyo normasi (1 dona mahsulotga)</h2>
        {editable && cid && (
          <div className="row">
            {lines.length > 0 && d.by_color.length > 1 && (
              <button className="btn ghost sm" onClick={() => setCopy(true)}>
                Boshqa rangga nusxalash
              </button>
            )}
            <button className="btn sm" onClick={() => setEdit('new')}>
              Xomashyo qo'shish
            </button>
          </div>
        )}
      </div>
      <div className="tabs" role="tablist">
        {d.by_color.map((c) => {
          const n = d.materials.filter((m) => m.color_id === c.color_id).length;
          return (
            <button key={c.color_id} role="tab" aria-selected={c.color_id === cid} className={c.color_id === cid ? 'on' : ''} onClick={() => setColorId(c.color_id)}>
              {c.color_name} <span className={`pill ${n ? 'muted' : 'warn'}`}>{n || 'bo\'sh'}</span>
            </button>
          );
        })}
      </div>
      <ErrorText error={del.error} />
      {cur && (
        <p className="note">
          {cur.color_name}: {qtyFmt(cur.qty)} dona · xomashyo 1 donaga {money(cur.material_cost)} so'm
        </p>
      )}
      {!lines.length ? (
        <p className="note">Bu rang uchun xomashyo yo'q.{editable && ' "Xomashyo qo\'shish" yoki boshqa rangdan nusxalang.'}</p>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Xomashyo</th>
                <th>Postavshik</th>
                <th>Rangi / kodi</th>
                <th>Razmer</th>
                <th className="n">Sarf</th>
                <th className="n">Narx</th>
                <th className="n">1 donaga, so'm</th>
                <th className="n">Kerak</th>
                <th className="n">Jami, so'm</th>
                {editable && <th />}
              </tr>
            </thead>
            <tbody>
              {lines.map((m) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.material_name}</b>
                    {m.material_code && <div className="note mono">{m.material_code}</div>}
                    {!m.from_us && <span className="pill muted">korxonadan</span>}
                  </td>
                  <td>{m.supplier_name ?? '—'}</td>
                  <td>
                    {m.material_color_name ?? '—'}
                    {m.color_code && <div className="note mono">{m.color_code}</div>}
                  </td>
                  <td className="mono">{m.material_size ?? '—'}</td>
                  <td className="n">
                    {plain(m.per_unit)} <span className="note">{m.unit}</span>
                  </td>
                  <td className="n">
                    {plain(m.price)} <span className="note">{m.currency}</span>
                    {m.currency !== 'UZS' && <div className="note">kurs {fmtNum(m.rate, 2)}</div>}
                  </td>
                  <td className="n">{money(m.unit_cost_uzs)}</td>
                  <td className="n">
                    {fmtNum(m.total_qty, 3)} <span className="note">{m.unit}</span>
                  </td>
                  <td className="n">{money(m.total_uzs)}</td>
                  {editable && (
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <button className="btn ghost sm" onClick={() => setEdit(m)}>
                          Tahrirlash
                        </button>
                        <button
                          className="btn ghost sm"
                          aria-label={`${m.material_name} qatorini o'chirish`}
                          disabled={del.isPending}
                          onClick={() => confirm(`${m.material_name} qatori o'chirilsinmi?`) && del.mutate(m.id)}
                        >
                          ×
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && cid && <MaterialModal d={d} line={edit === 'new' ? null : edit} colorId={cid} onClose={() => setEdit(null)} onSaved={onSaved} />}
      {copy && cid && <CopyModal d={d} from={cid} onClose={() => setCopy(false)} onSaved={onSaved} />}
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
      <MaterialsCard d={d} editable={editable} onSaved={onSaved} />
      <WorksCard d={d} editable={editable} onSaved={onSaved} />
      <SummaryCard d={d} />

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
