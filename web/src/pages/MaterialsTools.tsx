import { useState, type FormEvent } from 'react';
import { Field, Modal } from '../components/ui';
import { CURRENCIES, type Color, type Material, type OrderDetail, type Supplier } from '../types';

/** Xomashyo jadvalining bitta qatori (forma holati) */
export interface Row {
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

/** Tayyor mahsulot katagi: rang + razmer ('' — rangning barcha razmerlari) */
export interface Target {
  color_id: string;
  size_id: string;
}

let seq = 0;
export const newKey = () => `n${++seq}`;

export const emptyRow = (patch: Partial<Row> = {}): Row => ({
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
  currency: 'UZS',
  rate: '',
  size_id: '',
  color_id: '',
  is_main: false,
  note: '',
  ...patch,
});

/**
 * Qatorni boshqa katakka ko'chirish. Mato rangi mahsulot rangi bilan bir xil bo'lsa (Sini-oq mahsulot — Sini-oq mato),
 * "moslash" yoqilganda yangi qatorda xomashyo rangi ham yangi mahsulot rangiga o'zgaradi.
 */
export function cloneTo(r: Row, t: Target, adaptColor: boolean): Row {
  const sameColor = adaptColor && r.material_color_id !== '' && r.material_color_id === r.color_id;
  return { ...r, key: newKey(), id: undefined, color_id: t.color_id, size_id: t.size_id, material_color_id: sameColor ? t.color_id : r.material_color_id };
}

// ---------- Razmer × rang kataklarini tanlash ----------
export function VariantPicker({ d, value, onChange }: { d: OrderDetail; value: Target[]; onChange: (v: Target[]) => void }) {
  const colors = [...new Map(d.items.map((i) => [String(i.color_id), i.color_name])).entries()];
  const has = (c: string, s: string) => value.some((t) => t.color_id === c && t.size_id === s);
  const toggle = (c: string, s: string) =>
    onChange(
      has(c, s)
        ? value.filter((t) => !(t.color_id === c && t.size_id === s))
        : // "Hammasi" tanlansa — shu rangning alohida razmerlari olib tashlanadi (va aksincha)
          [...value.filter((t) => !(t.color_id === c && (s === '' ? t.size_id !== '' : t.size_id === ''))), { color_id: c, size_id: s }],
    );
  const allCells = colors.flatMap(([c]) => d.items.filter((i) => String(i.color_id) === c).map((i) => ({ color_id: c, size_id: String(i.size_id) })));
  return (
    <div className="grid" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="note">Qaysi tayyor mahsulot uchun (rang · razmer):</span>
        <div className="row">
          <button type="button" className="btn ghost sm" onClick={() => onChange(colors.map(([c]) => ({ color_id: c, size_id: '' })))}>
            Barcha ranglar (hammasi)
          </button>
          <button type="button" className="btn ghost sm" onClick={() => onChange(allCells)}>
            Har katak alohida
          </button>
          <button type="button" className="btn ghost sm" onClick={() => onChange([])}>
            Tozalash
          </button>
        </div>
      </div>
      <table className="picker">
        <tbody>
          {colors.map(([c, name]) => (
            <tr key={c}>
              <td>
                <b>{name}</b>
              </td>
              <td>
                <label className="chk">
                  <input type="checkbox" checked={has(c, '')} onChange={() => toggle(c, '')} /> Hammasi
                </label>
              </td>
              {d.items
                .filter((i) => String(i.color_id) === c)
                .map((i) => (
                  <td key={i.size_id}>
                    <label className="chk">
                      <input type="checkbox" checked={has(c, String(i.size_id))} onChange={() => toggle(c, String(i.size_id))} /> {i.size_name}
                    </label>
                  </td>
                ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Bir nechta katakka birdan xomashyo qo'shish ----------
export function AddMaterialModal({
  d,
  materials,
  suppliers,
  colors,
  onClose,
  onAdd,
}: {
  d: OrderDetail;
  materials: Material[];
  suppliers: Supplier[];
  colors: Color[];
  onClose: () => void;
  onAdd: (rows: Row[]) => void;
}) {
  const names = [...new Set(materials.filter((m) => m.is_active).map((m) => m.name))].sort((a, b) => a.localeCompare(b));
  const [f, setF] = useState(emptyRow());
  const [targets, setTargets] = useState<Target[]>([]);
  const [sameColor, setSameColor] = useState(false);
  const codes = materials.filter((m) => m.is_active && m.name === f.name);
  const set = (p: Partial<Row>) => setF({ ...f, ...p });
  const pickName = (name: string) => {
    const one = materials.filter((m) => m.is_active && m.name === name);
    const m = one.length === 1 ? one[0] : undefined;
    set({ name, material_id: m ? String(m.id) : '', supplier_id: f.supplier_id || (m?.supplier_id ? String(m.supplier_id) : '') });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onAdd(targets.map((t) => ({ ...f, key: newKey(), color_id: t.color_id, size_id: t.size_id, material_color_id: sameColor ? t.color_id : f.material_color_id })));
  };
  const ok = f.material_id && Number(f.per_unit.replace(',', '.')) > 0 && targets.length > 0;
  return (
    <Modal title="Xomashyo qo'shish (bir nechta razmer / rangga)" onClose={onClose}>
      <form className="form one" onSubmit={submit}>
        <div className="form">
          <Field label="Xomashyo nomi">
            <select value={f.name} onChange={(e) => pickName(e.target.value)} required autoFocus>
              <option value="">—</option>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </Field>
          <Field label="Kodi">
            <select
              value={f.material_id}
              required
              disabled={!f.name}
              onChange={(e) => {
                const m = materials.find((x) => String(x.id) === e.target.value);
                set({ material_id: e.target.value, supplier_id: f.supplier_id || (m?.supplier_id ? String(m.supplier_id) : '') });
              }}
            >
              <option value="">—</option>
              {codes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code || '(kodsiz)'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Postavshik">
            <select value={f.supplier_id} onChange={(e) => set({ supplier_id: e.target.value })}>
              <option value="">—</option>
              {suppliers
                .filter((s) => s.is_active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Xomashyo rangi">
            <select value={sameColor ? '=' : f.material_color_id} onChange={(e) => (e.target.value === '=' ? setSameColor(true) : (setSameColor(false), set({ material_color_id: e.target.value })))}>
              <option value="">—</option>
              <option value="=">= mahsulot rangi bilan bir xil</option>
              {colors
                .filter((c) => c.is_active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Rang kodi">
            <input value={f.color_code} onChange={(e) => set({ color_code: e.target.value })} maxLength={30} />
          </Field>
          <Field label="Razmer (xomashyo)">
            <input value={f.material_size} onChange={(e) => set({ material_size: e.target.value })} maxLength={30} placeholder="16, 20/31" />
          </Field>
          <Field label="Miqdor (1 donaga)">
            <input value={f.per_unit} inputMode="decimal" required onChange={(e) => set({ per_unit: e.target.value })} />
          </Field>
          <Field label="Narx">
            <input value={f.price} inputMode="decimal" onChange={(e) => set({ price: e.target.value })} />
          </Field>
          <Field label="Valyuta">
            <select value={f.currency} onChange={(e) => set({ currency: e.target.value, rate: '' })}>
              {Object.entries(CURRENCIES).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {f.currency !== 'UZS' && (
            <Field label="Kurs (bo'sh — zakaz sanasidagi)">
              <input value={f.rate} inputMode="decimal" onChange={(e) => set({ rate: e.target.value })} />
            </Field>
          )}
        </div>
        <div className="row">
          <label className="chk">
            <input type="checkbox" checked={f.from_us} onChange={(e) => set({ from_us: e.target.checked })} /> Xomashyo bizdan
          </label>
          <label className="chk">
            <input type="checkbox" checked={f.is_main} onChange={(e) => set({ is_main: e.target.checked })} /> Asosiy mato
          </label>
        </div>
        <VariantPicker d={d} value={targets} onChange={setTargets} />
        <div className="actions">
          <span className="note">{targets.length ? `${targets.length} ta qator qo'shiladi` : 'Kamida bitta rang/razmerni belgilang'}</span>
          <button className="btn" disabled={!ok}>
            Qo'shish
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Belgilangan qatorlardan bir nechta katakka nusxa ----------
export function CopyRowsModal({ d, source, onClose, onCopy }: { d: OrderDetail; source: Row[]; onClose: () => void; onCopy: (rows: Row[]) => void }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [adapt, setAdapt] = useState(true);
  const rows = targets.flatMap((t) => source.map((r) => cloneTo(r, t, adapt)));
  return (
    <Modal title={`Nusxa: ${source.length} ta qator`} onClose={onClose}>
      <p className="note">
        Belgilangan qatorlar tanlangan har bir rang/razmerga qo'shiladi. Keyin faqat farqli joylarini o'zgartirasiz (masalan, katta razmerda mato sarfi).
      </p>
      <label className="chk">
        <input type="checkbox" checked={adapt} onChange={(e) => setAdapt(e.target.checked)} /> Mato rangi mahsulot rangi bilan bir xil bo'lgan qatorlarda —
        xomashyo rangini yangi rangga moslash
      </label>
      <VariantPicker d={d} value={targets} onChange={setTargets} />
      <div className="actions">
        <span className="note">{rows.length} ta yangi qator</span>
        <button className="btn" disabled={!rows.length} onClick={() => onCopy(rows)}>
          Nusxa olish
        </button>
      </div>
    </Modal>
  );
}

// ---------- Belgilangan qatorlarga bitta ustunni birdan o'zgartirish ----------
type BulkField = 'per_unit' | 'price' | 'supplier_id' | 'material_color_id' | 'color_code' | 'material_size' | 'currency' | 'rate' | 'from_us' | 'size_id' | 'note';
export const BULK_FIELDS: [BulkField, string][] = [
  ['per_unit', 'Miqdor (sarf)'],
  ['price', 'Narx'],
  ['supplier_id', 'Postavshik'],
  ['material_color_id', 'Xomashyo rangi'],
  ['color_code', 'Rang kodi'],
  ['material_size', 'Razmer (xomashyo)'],
  ['currency', 'Valyuta'],
  ['rate', 'Kurs'],
  ['from_us', 'Bizdanmi'],
  ['size_id', 'T.M. razmer'],
  ['note', 'Izoh'],
];

export function BulkBar({
  count,
  d,
  suppliers,
  colors,
  onApply,
  onCopy,
  onDelete,
  onClear,
}: {
  count: number;
  d: OrderDetail;
  suppliers: Supplier[];
  colors: Color[];
  onApply: (field: BulkField, value: string | boolean) => void;
  onCopy: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [field, setField] = useState<BulkField>('per_unit');
  const [value, setValue] = useState('');
  const sizes = [...new Map(d.items.map((i) => [String(i.size_id), i.size_name])).entries()];
  const input = (() => {
    switch (field) {
      case 'supplier_id':
        return (
          <select aria-label="Qiymat" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">—</option>
            {suppliers.filter((s) => s.is_active).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        );
      case 'material_color_id':
        return (
          <select aria-label="Qiymat" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">—</option>
            <option value="=">= mahsulot rangi</option>
            {colors.filter((c) => c.is_active).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        );
      case 'currency':
        return (
          <select aria-label="Qiymat" value={value} onChange={(e) => setValue(e.target.value)}>
            {Object.entries(CURRENCIES).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        );
      case 'from_us':
        return (
          <select aria-label="Qiymat" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="1">Ha</option>
            <option value="0">Yo'q (korxonadan)</option>
          </select>
        );
      case 'size_id':
        return (
          <select aria-label="Qiymat" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">Hammasi</option>
            {sizes.map(([id, n]) => (
              <option key={id} value={id}>
                {n}
              </option>
            ))}
          </select>
        );
      default:
        return <input aria-label="Qiymat" value={value} inputMode={['per_unit', 'price', 'rate'].includes(field) ? 'decimal' : undefined} onChange={(e) => setValue(e.target.value)} />;
    }
  })();
  return (
    <div className="bulk-bar" role="region" aria-label="Belgilangan qatorlar">
      <b>{count} ta belgilangan:</b>
      <select
        aria-label="Ustun"
        value={field}
        onChange={(e) => {
          const f = e.target.value as BulkField;
          setField(f);
          setValue(f === 'currency' ? 'UZS' : f === 'from_us' ? '1' : '');
        }}
      >
        {BULK_FIELDS.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      <span>=</span>
      {input}
      <button className="btn sm" onClick={() => onApply(field, field === 'from_us' ? value === '1' : value)}>
        Qo'llash
      </button>
      <span className="sep" />
      <button className="btn ghost sm" onClick={onCopy}>
        Nusxa olish…
      </button>
      <button className="btn ghost sm" onClick={() => confirm(`${count} ta qator o'chirilsinmi?`) && onDelete()}>
        O'chirish
      </button>
      <button className="btn ghost sm" onClick={onClear}>
        Bekor qilish
      </button>
    </div>
  );
}
