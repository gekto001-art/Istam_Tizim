export const ROLES = [
  'admin',
  'rahbar',
  'innovatsiya',
  'taminot',
  'sklad',
  'bichuv',
  'tsex',
  'otk',
  'sotuv',
  'kassir',
  'buxgalter',
  'hr',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  rahbar: 'Rahbar',
  innovatsiya: 'Innovatsion bo\'lim',
  taminot: 'Ta\'minot (zakaz)',
  sklad: 'Skladchi',
  bichuv: 'Bichuv',
  tsex: 'Tsex',
  otk: 'OTK',
  sotuv: 'Sotuv bo\'limi',
  kassir: 'Kassir',
  buxgalter: 'Buxgalter',
  hr: 'HR',
};

export interface Me {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  role_label: string;
  phone: string | null;
  must_change_password: boolean;
}

const has = (list: Role[]) => (r: Role) => list.includes(r);

/** Rollar bo'yicha ruxsatlar (server/src/lib/permissions.ts dagi jadval bilan bir xil). */
export const can = {
  users: has(['admin']),
  audit: has(['admin', 'rahbar', 'buxgalter']),
  catalogWrite: has(['admin', 'innovatsiya', 'taminot']),
  ratesWrite: has(['admin', 'buxgalter', 'taminot']),
  ordersRead: has(['admin', 'rahbar', 'innovatsiya', 'taminot', 'sklad', 'bichuv', 'tsex', 'otk', 'buxgalter']),
  ordersWrite: has(['admin', 'innovatsiya']),
  ordersConfirm: has(['admin', 'innovatsiya']),
  ordersReopen: has(['admin', 'rahbar']),
};

// ---------- Ma'lumotnomalar ----------
export interface Color { id: number; name: string; code: string | null; is_active: boolean }
export interface Size { id: number; name: string; sort: number; is_active: boolean }
export interface ProductType { id: number; name: string; unit: string; is_active: boolean }
export interface Supplier { id: number; name: string; country: string | null; phone: string | null; note: string | null; is_active: boolean }
export interface Producer { id: number; name: string; kind: 'own' | 'contractor'; note: string | null; is_active: boolean }
export interface Material {
  id: number;
  name: string;
  code: string | null;
  unit: string;
  supplier_id: number | null;
  supplier_name: string | null;
  is_active: boolean;
}
export interface CurrencyRate { id: number; currency: string; rate: string; valid_from: string; is_current: boolean }

export const CURRENCIES: Record<string, string> = { UZS: "So'm", USD: 'Dollar', CNY: 'Yuan', EUR: 'Yevro', RUB: 'Rubl' };
export const SEASONS = ['Bahor', 'Yoz', 'Kuz', 'Qish'] as const;

// ---------- Zakaz ----------
export type OrderStatus = 'draft' | 'confirmed' | 'cancelled';

export interface OrderRow {
  id: number;
  partiya_no: string;
  order_date: string;
  artikul: string | null;
  model: string | null;
  season: string | null;
  status: OrderStatus;
  start_date: string | null;
  end_date: string | null;
  ordered_by: string | null;
  product_type_name: string;
  producer_name: string | null;
  qty: number;
  colors: number;
}

export interface Order extends Omit<OrderRow, 'qty' | 'colors'> {
  product_type_id: number;
  producer_id: number | null;
  unit: string;
  note: string | null;
  created_by_name: string | null;
  confirmed_by_name: string | null;
  confirmed_at: string | null;
}

export interface OrderMaterial {
  id: number;
  color_id: number;
  color_name: string;
  material_id: number;
  material_name: string;
  material_code: string | null;
  unit: string;
  supplier_id: number | null;
  supplier_name: string | null;
  material_color_id: number | null;
  material_color_name: string | null;
  color_code: string | null;
  material_size: string | null;
  per_unit: string;
  price: string;
  currency: string;
  rate: string;
  from_us: boolean;
  note: string | null;
  product_qty: number;
  total_qty: string;
  total_amount: string;
  total_uzs: string;
  unit_cost_uzs: string;
}

export interface OrderNeed {
  material_id: number;
  material_name: string;
  material_code: string | null;
  unit: string;
  supplier_name: string | null;
  material_color_name: string | null;
  color_code: string | null;
  material_size: string | null;
  price: string;
  currency: string;
  from_us: boolean;
  total_qty: string;
  total_amount: string;
  total_uzs: string;
  for_colors: string;
}

export interface OrderDetail {
  order: Order;
  items: { size_id: number; size_name: string; color_id: number; color_name: string; qty: number }[];
  materials: OrderMaterial[];
  works: { id: number; producer_id: number; producer_name: string; producer_kind: string; price: string; note: string | null }[];
  by_color: { color_id: number; color_name: string; qty: number; material_cost: string; work_cost: string; unit_cost: string; total_cost: string }[];
  needs: OrderNeed[];
  totals: { qty: number; material_uzs: string; work_uzs: string };
  warnings: string[];
}
