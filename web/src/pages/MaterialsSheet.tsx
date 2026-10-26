import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ErrorText, Modal, fmtNum } from '../components/ui';
import { CURRENCIES, type Color, type CurrencyRate, type Material, type OrderDetail, type Supplier } from '../types';
import { useCatalog } from './Orders';

/**
 * Xomashyo jadvali — Google Sheets "Innovatsion bo'lim → Zakazlar" dagidek:
 * har qator bitta xomashyo, tayyor mahsulot razmeri × rangi uchun; Summa, Kurs, Umumiy miqdor/summa, T.M. soni avtomatik;
 * to'liq bo'lmagan qator "X" bilan belgilanadi. Hammasi bir joyda tahrirlanib, bitta "Saqlash" bilan yoziladi.
 */

interface Row {
  key: string;
  id?: number;
  supplier_id: string;
  name: string;
  material_id: string;
  material_color_id: string;
  color_code: string;
  material_size: string;
  per_unit: string;
  price: string;
  from_us: boolean;
  currency: string;
  rate: string;
  size_id: string; // '' — rangning barcha razmerlari
  color_id: string;
  is_main: boolean;
  note: string;
}

const num = (s: string) => Number(String(s).replace(/\s/g, '').replace(',', '.'));
const plain = (v: string | number | null | undefined) => (v == null ? '' : String(Number(v)));
const money = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? '—' : fmtNum(Math.round(v * 100) / 100, 2));
let seq = 0;
const newKey = () => `n${++seq}`;

function fromDetail(d: OrderDetail): Row[] {
  return d.materials.map((m) => ({
    key: `m${m.id}`,
    id: m.id,
    supplier_id: m.supplier_id ? String(m.supplier_id) : '',
    name: m.material_name,
    material_id: String(m.material_id),
    material_color_id: m.material_color_id ? String(m.material_color_id) : '',
    color_code: m.color_code ?? '',
    material_size: m.material_size ?? '',
    per_unit: plain(m.per_unit),
    price: plain(m.price),
    from_us: m.from_us,
    currency: m.currency,
    rate: m.currency === 'UZS' ? '' : plain(m.rate),
    size_id: m.size_id ? String(m.size_id) : '',
    color_id: String(m.color_id),
    is_main: m.is_main,
    note: m.note ?? '',
  }));
}

/** Saqlash uchun taqqoslanadigan ko'rinish (key siz) */
const snapshot = (rows: Row[]) => JSON.stringify(rows.map(({ key: _k, ...r }) => r));

export function MaterialsSheet({ d, editable, onSaved }: { d: OrderDetail; editable: boolean; onSaved: (d: OrderDetail, msg: string) => void }) {
  const materials = useCatalog<Material>('materials');
  const suppliers = useCatalog<Supplier>('suppliers');
  const colors = useCatalog<Color>('colors');
  const rates = useQuery({ queryKey: ['catalog', 'currency-rates'], queryFn: () => api<CurrencyRate[]>('/currency-rates') });
  const [rows, setRows] = useState<Row[]>(() => fromDetail(d));
  const [filter, setFilter] = useState('');
  const [copy, setCopy] = useState(false);
  useEffect(() => setRows(fromDetail(d)), [d]);
  const dirty = snapshot(rows) !== snapshot(fromDetail(d));

  // jadvaldagi (razmer × rang) kataklar
  const matrixColors = useMemo(() => [...new Map(d.items.map((i) => [i.color_id, i.color_name])).entries()], [d.items]);
  const sizesOf = (colorId: string) => d.items.filter((i) => String(i.color_id) === colorId);
  const tmQty = (r: Row) =>
    d.items.filter((i) => String(i.color_id) === r.color_id && (!r.size_id || String(i.size_id) === r.size_id)).reduce((a, i) => a + i.qty, 0);
  // zakaz sanasidagi kurs (qatorda kurs yozilmasa)
  const rateFor = (cur: string) =>
    cur === 'UZS'
      ? 1
      : Number(
          (rates.data ?? [])
            .filter((x) => x.currency === cur && x.valid_from <= d.order.order_date)
            .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0]?.rate ?? NaN,
        );
  const names = useMemo(
    () => [...new Set((materials.data ?? []).filter((m) => m.is_active).map((m) => m.name))].sort((a, b) => a.localeCompare(b)),
    [materials.data],
  );
  const codesOf = (name: string) => (materials.data ?? []).filter((m) => m.name === name && (m.is_active || rows.some((r) => r.material_id === String(m.id))));
  const supplierName = (id: string) => suppliers.data?.find((s) => String(s.id) === id)?.name ?? '';
  const colorName = (id: string) => colors.data?.find((c) => String(c.id) === id)?.name ?? '';

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const pickName = (r: Row, name: string) => {
    const c = codesOf(name);
    const m = c.length === 1 ? c[0] : undefined;
    set(r.key, {
      name,
      material_id: m ? String(m.id) : '',
      supplier_id: r.supplier_id || (m?.supplier_id ? String(m.supplier_id) : ''),
    });
  };
  const pickCode = (r: Row, id: string) => {
    const m = materials.data?.find((x) => String(x.id) === id);
    set(r.key, { material_id: id, supplier_id: r.supplier_id || (m?.supplier_id ? String(m.supplier_id) : '') });
  };
  const addRow = () => {
    const last = rows[rows.length - 1];
    setRows([
      ...rows,
      {
        key: newKey(),
        supplier_id: '',
        name: '',
        material_id: '',
        material_color_id: '',
        color_code: '',
        material_size: '',
        per_unit: '',
        price: '',
        from_us: true,
        currency: last?.currency ?? 'UZS',
        rate: '',
        size_id: '',
        color_id: filter || last?.color_id || (matrixColors[0] ? String(matrixColors[0][0]) : ''),
        is_main: false,
        note: '',
      },
    ]);
  };
  const duplicate = (r: Row) => {
    const i = rows.findIndex((x) => x.key === r.key);
    setRows([...rows.slice(0, i + 1), { ...r, key: newKey(), id: undefined, is_main: false }, ...rows.slice(i + 1)]);
  };

  /** Sheets'dagi "Natija": qator to'liq bo'lmasa X */
  const problems = (r: Row) => {
    const p: string[] = [];
    if (!r.material_id) p.push('xomashyo');
    if (!(num(r.per_unit) > 0)) p.push('miqdor');
    if (!r.color_id) p.push('tayyor mahsulot rangi');
    if (!r.supplier_id) p.push('postavshik');
    if (r.currency !== 'UZS' && !r.rate && Number.isNaN(rateFor(r.currency))) p.push('kurs');
    return p;
  };
  const blocking = rows.filter((r) => !r.material_id || !(num(r.per_unit) > 0) || !r.color_id);

  const save = useMutation({
    mutationFn: () =>
      api<OrderDetail>(`/orders/${d.order.id}/materials`, {
        method: 'PUT',
        body: {
          lines: rows.map((r) => ({
            id: r.id,
            color_id: Number(r.color_id),
            size_id: r.size_id ? Number(r.size_id) : null,
            material_id: Number(r.material_id),
            supplier_id: r.supplier_id ? Number(r.supplier_id) : null,
            material_color_id: r.material_color_id ? Number(r.material_color_id) : null,
            color_code: r.color_code,
            material_size: r.material_size,
            per_unit: num(r.per_unit),
            price: r.price ? num(r.price) : 0,
            currency: r.currency,
            rate: r.currency !== 'UZS' && r.rate ? num(r.rate) : null,
            from_us: r.from_us,
            is_main: r.is_main,
            note: r.note,
          })),
        },
      }),
    onSuccess: (r) => onSaved(r, 'Xomashyo jadvali saqlandi'),
  });

  const visible = rows.filter((r) => !filter || r.color_id === filter);
  const totalUzs = rows.reduce((a, r) => {
    const k = r.currency === 'UZS' ? 1 : r.rate ? num(r.rate) : rateFor(r.currency);
    const v = num(r.per_unit) * (num(r.price) || 0) * tmQty(r) * k;
    return Number.isNaN(v) ? a : a + v;
  }, 0);

  if (!d.items.length) {
    return (
      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Xomashyo</h2>
        <p className="note">Avval razmer × rang jadvalini to'ldiring — har xomashyo qatori tayyor mahsulot razmeri va rangi uchun yoziladi.</p>
      </div>
    );
  }

  const colorOpts = (colors.data ?? []).filter((c) => c.is_active);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h2>Xomashyo ({rows.length} qator)</h2>
        <div className="row">
          <select aria-label="Tayyor mahsulot rangi bo'yicha filtr" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Barcha ranglar</option>
            {matrixColors.map(([id, n]) => (
              <option key={id} value={id}>
                {n}
              </option>
            ))}
          </select>
          {editable && (
            <>
              <button className="btn ghost sm" disabled={!rows.length} onClick={() => setCopy(true)}>
                Rangdan rangga nusxa
              </button>
              <button className="btn ghost sm" onClick={addRow}>
                + qator
              </button>
              {dirty && (
                <button className="btn ghost sm" onClick={() => setRows(fromDetail(d))}>
                  Qaytarish
                </button>
              )}
              <button className="btn sm" disabled={!dirty || save.isPending || blocking.length > 0} onClick={() => save.mutate()}>
                Saqlash
              </button>
            </>
          )}
        </div>
      </div>
      <ErrorText error={save.error} />
      {editable && blocking.length > 0 && (
        <p className="err">{blocking.length} ta qatorda xomashyo, miqdor yoki tayyor mahsulot rangi to'ldirilmagan ("X") — saqlashdan oldin to'ldiring yoki o'chiring.</p>
      )}
      <div className="tw sheet-wrap">
        <table className="sheet">
          <thead>
            <tr>
              <th>№</th>
              <th>Postavshik</th>
              <th>Xomashyo nomi</th>
              <th>Kodi</th>
              <th>Xomashyo rangi</th>
              <th>Rang kodi</th>
              <th>Razmer</th>
              <th className="n">Miqdor</th>
              <th className="n">Narx</th>
              <th className="n">Summa</th>
              <th>Bizdanmi</th>
              <th>Valyuta</th>
              <th className="n">Kurs</th>
              <th className="n">Umumiy miqdor</th>
              <th className="n">Umumiy summa</th>
              <th>T.M. razmer</th>
              <th>T.M. rangi</th>
              <th className="n">T.M. soni</th>
              <th>Asosiy mato</th>
              <th>Natija</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const idx = rows.indexOf(r) + 1;
              const q = tmQty(r);
              const summa = num(r.per_unit) * (num(r.price) || 0);
              const rateShown = r.currency === 'UZS' ? null : r.rate ? num(r.rate) : rateFor(r.currency);
              const unit = materials.data?.find((m) => String(m.id) === r.material_id)?.unit ?? '';
              const p = problems(r);
              const lbl = `${idx}-qator`;
              if (!editable) {
                return (
                  <tr key={r.key}>
                    <td className="mono">{idx}</td>
                    <td>{supplierName(r.supplier_id) || '—'}</td>
                    <td>
                      <b>{r.name}</b>
                    </td>
                    <td className="mono">{materials.data?.find((m) => String(m.id) === r.material_id)?.code ?? '—'}</td>
                    <td>{colorName(r.material_color_id) || '—'}</td>
                    <td className="mono">{r.color_code || '—'}</td>
                    <td className="mono">{r.material_size || '—'}</td>
                    <td className="n">
                      {r.per_unit} <span className="note">{unit}</span>
                    </td>
                    <td className="n">{r.price || '0'}</td>
                    <td className="n">{fmtNum(summa, 2)}</td>
                    <td>{r.from_us ? 'Ha' : <span className="pill muted">korxonadan</span>}</td>
                    <td>{CURRENCIES[r.currency]}</td>
                    <td className="n">{rateShown == null ? '—' : fmtNum(rateShown, 2)}</td>
                    <td className="n">
                      {fmtNum(num(r.per_unit) * q, 3)} <span className="note">{unit}</span>
                    </td>
                    <td className="n">{money(summa * q)}</td>
                    <td>{r.size_id ? d.items.find((i) => String(i.size_id) === r.size_id)?.size_name : 'Hammasi'}</td>
                    <td>{colorName(r.color_id)}</td>
                    <td className="n">{fmtNum(q)}</td>
                    <td>{r.is_main && <span className="pill good">asosiy</span>}</td>
                    <td>{p.length ? <span className="pill bad" title={p.join(', ')}>X</span> : ''}</td>
                  </tr>
                );
              }
              return (
                <tr key={r.key} className={p.length ? 'bad-row' : ''}>
                  <td className="mono">{idx}</td>
                  <td>
                    <select aria-label={`${lbl}: postavshik`} value={r.supplier_id} onChange={(e) => set(r.key, { supplier_id: e.target.value })}>
                      <option value="">—</option>
                      {(suppliers.data ?? [])
                        .filter((s) => s.is_active || String(s.id) === r.supplier_id)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td>
                    <select aria-label={`${lbl}: xomashyo nomi`} value={r.name} onChange={(e) => pickName(r, e.target.value)}>
                      <option value="">—</option>
                      {(names.includes(r.name) || !r.name ? names : [r.name, ...names]).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select aria-label={`${lbl}: kodi`} value={r.material_id} disabled={!r.name} onChange={(e) => pickCode(r, e.target.value)}>
                      <option value="">—</option>
                      {codesOf(r.name).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.code || '(kodsiz)'}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select aria-label={`${lbl}: xomashyo rangi`} value={r.material_color_id} onChange={(e) => set(r.key, { material_color_id: e.target.value })}>
                      <option value="">—</option>
                      {colorOpts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input className="cell sm" aria-label={`${lbl}: rang kodi`} value={r.color_code} onChange={(e) => set(r.key, { color_code: e.target.value })} />
                  </td>
                  <td>
                    <input className="cell sm" aria-label={`${lbl}: razmer`} value={r.material_size} onChange={(e) => set(r.key, { material_size: e.target.value })} />
                  </td>
                  <td className="n">
                    <input className="cell num" inputMode="decimal" aria-label={`${lbl}: miqdor`} value={r.per_unit} onChange={(e) => set(r.key, { per_unit: e.target.value })} />
                    <div className="note">{unit}</div>
                  </td>
                  <td className="n">
                    <input className="cell num" inputMode="decimal" aria-label={`${lbl}: narx`} value={r.price} onChange={(e) => set(r.key, { price: e.target.value })} />
                  </td>
                  <td className="n">{Number.isNaN(summa) ? '—' : fmtNum(summa, 2)}</td>
                  <td>
                    <input type="checkbox" aria-label={`${lbl}: xomashyo bizdanmi`} checked={r.from_us} onChange={(e) => set(r.key, { from_us: e.target.checked })} />
                  </td>
                  <td>
                    <select aria-label={`${lbl}: valyuta`} value={r.currency} onChange={(e) => set(r.key, { currency: e.target.value, rate: '' })}>
                      {Object.entries(CURRENCIES).map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="n">
                    {r.currency === 'UZS' ? (
                      '—'
                    ) : (
                      <input
                        className="cell num"
                        inputMode="decimal"
                        aria-label={`${lbl}: kurs`}
                        placeholder={Number.isNaN(rateFor(r.currency)) ? 'kurs?' : plain(rateFor(r.currency))}
                        value={r.rate}
                        onChange={(e) => set(r.key, { rate: e.target.value })}
                      />
                    )}
                  </td>
                  <td className="n">{Number.isNaN(num(r.per_unit) * q) ? '—' : fmtNum(num(r.per_unit) * q, 3)}</td>
                  <td className="n">{money(summa * q)}</td>
                  <td>
                    <select aria-label={`${lbl}: tayyor mahsulot razmeri`} value={r.size_id} onChange={(e) => set(r.key, { size_id: e.target.value })}>
                      <option value="">Hammasi</option>
                      {sizesOf(r.color_id).map((i) => (
                        <option key={i.size_id} value={i.size_id}>
                          {i.size_name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`${lbl}: tayyor mahsulot rangi`}
                      value={r.color_id}
                      onChange={(e) => set(r.key, { color_id: e.target.value, size_id: sizesOf(e.target.value).some((i) => String(i.size_id) === r.size_id) ? r.size_id : '' })}
                    >
                      <option value="">—</option>
                      {matrixColors.map(([id, n]) => (
                        <option key={id} value={id}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="n">{fmtNum(q)}</td>
                  <td>
                    <input type="checkbox" aria-label={`${lbl}: asosiy mato`} checked={r.is_main} onChange={(e) => set(r.key, { is_main: e.target.checked })} />
                  </td>
                  <td>{p.length ? <span className="pill bad" title={`To'ldirilmagan: ${p.join(', ')}`}>X</span> : ''}</td>
                  <td>
                    <div className="row" style={{ flexWrap: 'nowrap', gap: 2 }}>
                      <button className="x" title="Nusxa (pastiga)" aria-label={`${lbl}: nusxa`} onClick={() => duplicate(r)}>
                        ⧉
                      </button>
                      <button className="x" title="O'chirish" aria-label={`${lbl}: o'chirish`} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
                        ×
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="note">Xomashyo yo'q. {editable && '"+ qator" bilan qo\'shing.'}</p>}
      <p className="note">
        Summa = miqdor × narx · Umumiy miqdor = miqdor × T.M. soni · T.M. soni — razmer × rang jadvalidan ("Hammasi" — rangning barcha razmerlari) ·
        Kurs bo'sh bo'lsa zakaz sanasidagi kurs olinadi · Asosiy mato — avval zakaz qilinadi, son fakt matoga qarab qayta hisoblanadi.
        {rows.length > 0 && <> Jami so'mda: <b>{money(totalUzs)}</b></>}
        {dirty && editable && ' · O\'zgarishlar saqlanmagan.'}
      </p>
      {copy && (
        <CopyColorsModal
          colors={matrixColors}
          onClose={() => setCopy(false)}
          onCopy={(from, to) => {
            const src = rows.filter((r) => r.color_id === from);
            const add: Row[] = to.flatMap((c) =>
              src
                .filter((r) => !r.size_id || sizesOf(c).some((i) => String(i.size_id) === r.size_id))
                .map((r) => ({ ...r, key: newKey(), id: undefined, color_id: c })),
            );
            setRows([...rows, ...add]);
            setCopy(false);
          }}
        />
      )}
    </div>
  );
}

function CopyColorsModal({ colors, onClose, onCopy }: { colors: [number, string][]; onClose: () => void; onCopy: (from: string, to: string[]) => void }) {
  const [from, setFrom] = useState(colors[0] ? String(colors[0][0]) : '');
  const [to, setTo] = useState<string[]>([]);
  return (
    <Modal title="Rangdan rangga nusxa" onClose={onClose}>
      <p className="note">Tanlangan rangdagi barcha qatorlar boshqa ranglarga qo'shiladi (keyin farqli joylarini — masalan mato rangini — tahrirlang va saqlang).</p>
      <label className="f">
        Qaysi rangdan
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          {colors.map(([id, n]) => (
            <option key={id} value={id}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        {colors
          .filter(([id]) => String(id) !== from)
          .map(([id, n]) => (
            <label key={id} className="chk">
              <input
                type="checkbox"
                checked={to.includes(String(id))}
                onChange={() => setTo(to.includes(String(id)) ? to.filter((x) => x !== String(id)) : [...to, String(id)])}
              />{' '}
              {n}
            </label>
          ))}
      </div>
      <div className="actions">
        <button className="btn" disabled={!to.length} onClick={() => onCopy(from, to)}>
          Nusxa olish
        </button>
      </div>
    </Modal>
  );
}
