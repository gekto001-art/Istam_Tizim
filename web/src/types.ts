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
  purchaseRead: has(['admin', 'rahbar', 'taminot', 'innovatsiya', 'buxgalter', 'sklad']),
  purchaseWrite: has(['admin', 'taminot']),
  purchaseApprove: has(['admin', 'rahbar', 'taminot']),
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
  size_id: number | null;
  size_name: string | null;
  unit_amount: string;
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
  is_main: boolean;
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
  is_main: boolean;
  total_qty: string;
  total_amount: string;
  total_uzs: string;
  for_colors: string;
}

export interface OrderDetail {
  order: Order;
  items: { size_id: number; size_name: string; color_id: number; color_name: string; qty: number; actual_qty: number | null }[];
  materials: OrderMaterial[];
  works: { id: number; producer_id: number; producer_name: string; producer_kind: string; price: string; note: string | null }[];
  by_color: { color_id: number; color_name: string; qty: number; actual_qty: number | null; material_cost: string; work_cost: string; unit_cost: string; total_cost: string }[];
  needs: OrderNeed[];
  totals: { qty: number; actual_qty: number | null; material_uzs: string; work_uzs: string };
  warnings: string[];
}

// ---------- Ta'minot ----------
export type PurchaseStatus = 'negotiation' | 'rejected' | 'preparing' | 'in_transit' | 'arrived' | 'closed' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'advance' | 'partial' | 'paid';

export interface SupplyOrderRow {
  id: number;
  partiya_no: string;
  order_date: string;
  artikul: string | null;
  model: string | null;
  product_type_name: string;
  producer_name: string | null;
  plan_qty: number;
  actual_qty: number | null;
  mato_pos: number;
  mato_agreed: number;
  furnitura_pos: number;
  furnitura_agreed: number;
}

export interface SupplyNeed {
  order_material_id: number;
  color_id: number;
  color_name: string;
  size_id: number | null;
  size_name: string | null;
  material_id: number;
  material_name: string;
  material_code: string | null;
  unit: string;
  supplier_name: string | null;
  material_color_name: string | null;
  color_code: string | null;
  material_size: string | null;
  per_unit: string;
  price: string;
  currency: string;
  plan_count: number;
  actual_count: number | null;
  qty: string | null;
  ordered_po_id: number | null;
}

export interface SupplyPlan {
  order: { id: number; partiya_no: string; order_date: string; status: string; artikul: string | null; model: string | null; product_type_name: string; producer_name: string | null };
  colors: { color_id: number; color_name: string; plan_count: number; actual_count: number | null; main_material: string | null }[];
  mato: SupplyNeed[];
  furnitura: SupplyNeed[];
  purchases: { id: number; stage: 'mato' | 'furnitura'; status: PurchaseStatus; payment_status: PaymentStatus; po_date: string; eta: string | null; supplier_name: string; lines: number }[];
  can: { mato: boolean; furnitura: boolean };
  reasons: { mato: string | null; furnitura: string | null };
}

export interface PurchaseRow {
  id: number;
  order_id: number;
  partiya_no: string;
  product_type_name: string;
  supplier_name: string;
  stage: 'mato' | 'furnitura';
  status: PurchaseStatus;
  payment_status: PaymentStatus;
  po_date: string;
  eta: string | null;
  tracking: string | null;
  manager: string | null;
  lines: number;
  amount_uzs: string | null;
}

export interface PurchaseLine {
  id: number;
  material_id: number;
  material_name: string;
  material_code: string | null;
  unit: string;
  material_color_name: string | null;
  color_code: string | null;
  material_size: string | null;
  plan_qty: string;
  price: string;
  currency: string;
  rate: string;
  fact_qty: string | null;
  fact_price: string | null;
  note: string | null;
  plan_amount: string;
  fact_amount: string | null;
  amount_uzs: string;
  sources: { color_name: string; plan_qty: string; per_unit: string; fact_qty: string | null; products: number | null }[];
}

export interface PurchaseDetail {
  po: PurchaseRow & {
    note: string | null;
    reject_reason: string | null;
    arrived_date: string | null;
    supplier_country: string | null;
    artikul: string | null;
    model: string | null;
    agreed_by_name: string | null;
    agreed_at: string | null;
    created_by_name: string | null;
  };
  lines: PurchaseLine[];
  totals: { plan_uzs: string | null; fact_uzs: string | null; all_fact: boolean };
}
