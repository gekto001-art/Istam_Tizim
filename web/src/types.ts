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
  ordersPrice: has(['admin', 'rahbar', 'innovatsiya']),
  purchaseRead: has(['admin', 'rahbar', 'taminot', 'innovatsiya', 'buxgalter', 'sklad']),
  purchaseWrite: has(['admin', 'taminot']),
  purchaseApprove: has(['admin', 'rahbar', 'taminot']),
  stockRead: has(['admin', 'rahbar', 'sklad', 'taminot', 'innovatsiya', 'bichuv', 'buxgalter']),
  stockWrite: has(['admin', 'sklad']),
  kroyRead: has(['admin', 'rahbar', 'bichuv', 'otk', 'sklad', 'innovatsiya', 'tsex', 'buxgalter']),
  kroyWrite: has(['admin', 'bichuv']),
  otkWrite: has(['admin', 'otk']),
  tsexRead: has(['admin', 'rahbar', 'tsex', 'bichuv', 'otk', 'sklad', 'innovatsiya', 'buxgalter']),
  tsexWrite: has(['admin', 'tsex']),
  fgRead: has(['admin', 'rahbar', 'otk', 'sklad', 'sotuv', 'tsex', 'bichuv', 'innovatsiya', 'buxgalter']),
  salesRead: has(['admin', 'rahbar', 'sotuv', 'sklad', 'buxgalter', 'kassir', 'innovatsiya']),
  salesTransfer: has(['admin', 'sklad']),
  salesAccept: has(['admin', 'sotuv']),
  salesPay: has(['admin', 'buxgalter', 'kassir']),
  hrRead: has(['admin', 'rahbar', 'hr', 'buxgalter', 'kassir']),
  hrWrite: has(['admin', 'hr']),
  hrWork: has(['admin', 'hr', 'tsex']),
  hrRates: has(['admin', 'rahbar', 'hr']),
  hrPay: has(['admin', 'buxgalter', 'kassir']),
  cashRead: has(['admin', 'rahbar', 'buxgalter', 'kassir']),
  cashWrite: has(['admin', 'buxgalter', 'kassir']),
  cashManage: has(['admin', 'buxgalter']),
  billzRead: has(['admin', 'rahbar', 'sklad', 'sotuv', 'buxgalter', 'otk']),
  billzManage: has(['admin']),
  reportsRead: has(['admin', 'rahbar', 'buxgalter', 'sotuv']),
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
  sale_price1: string | null;
  sale_price2: string | null;
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

export type Stage = 'mato' | 'furnitura';
/** Kelishilgan qatorlar holatlari (fakt hisobga olinadi) */
export const AGREED: PurchaseStatus[] = ['preparing', 'in_transit', 'arrived', 'closed'];

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
  mato_lines: number;
  mato_agreed: number;
  furnitura_lines: number;
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
  is_main: boolean;
  plan_count: number;
  actual_count: number | null;
  qty: string | null;
  ordered_line_id: number | null;
  ordered_status: PurchaseStatus | null;
}

export interface SupplyPlan {
  order: {
    id: number;
    partiya_no: string;
    order_date: string;
    status: string;
    artikul: string | null;
    model: string | null;
    start_date: string | null;
    end_date: string | null;
    product_type_name: string;
    producer_name: string | null;
  };
  colors: { color_id: number; color_name: string; plan_count: number; actual_count: number | null; main_material: string | null }[];
  mato: SupplyNeed[];
  furnitura: SupplyNeed[];
  can: { mato: boolean; furnitura: boolean };
  reasons: { mato: string | null; furnitura: string | null };
}

/** Postavshik buyurtmasi qatori (Sheets: Postavshik Kelishuv / Tasdiqlangan buyurtmalar) */
export interface PurchaseLine {
  id: number;
  po_id: number;
  created_at: string;
  order_id: number;
  partiya_no: string;
  po_date: string;
  stage: Stage;
  supplier_id: number;
  supplier_name: string;
  product_type_name: string;
  material_id: number;
  material_name: string;
  material_code: string | null;
  unit: string;
  material_color_id: number | null;
  material_color_name: string | null;
  color_code: string | null;
  material_size: string | null;
  plan_qty: string;
  price: string;
  plan_amount: string;
  currency: string;
  rate: string;
  status: PurchaseStatus;
  payment_status: PaymentStatus;
  eta: string | null;
  tracking: string | null;
  arrived_date: string | null;
  manager: string | null;
  note: string | null;
  reject_reason: string | null;
  fact_qty: string | null;
  fact_price: string | null;
  fact_amount: string;
  agreed_at: string | null;
  agreed_by_name: string | null;
  shipped_qty: string;
  remaining_qty: string;
  for_colors: string | null;
}

export interface TrackingOrder {
  order_id: number;
  partiya_no: string;
  product_type_name: string;
  lines: number;
  remaining_qty: string;
}

export interface Shipment {
  id: number;
  created_at: string;
  ship_date: string;
  qty: string;
  note: string | null;
  partiya_no: string;
  po_date: string;
  supplier_name: string;
  material_name: string;
  material_code: string | null;
  material_color_name: string | null;
  color_code: string | null;
  material_size: string | null;
  price: string;
  amount: string;
  currency: string;
  rate: string;
  amount_uzs: string;
  created_by_name: string | null;
}

export interface TrackingDetail {
  lines: PurchaseLine[];
  shipments: Shipment[];
}

// ---------- Xomashyo skladi ----------
export type StockKind = 'prixod_taminot' | 'prixod' | 'rasxod_zayavka' | 'rasxod' | 'sotuv';
export type StockOp = 'prixod' | 'vozvrat' | 'peremesheniya' | 'sotuv';
export type Destination = 'kroy' | 'producer' | 'other';

/** Xomashyo kaliti: nomi + rangi + rang kodi + razmeri */
export interface StockItem {
  material_id: number;
  material_name: string;
  material_code: string | null;
  unit: string;
  material_color_id: number | null;
  material_color_name: string | null;
  color_code: string | null;
  material_size: string | null;
}

export interface StockBalance extends StockItem {
  qty: string;
  avg_cost: string | null;
  value_uzs: string | null;
}

export interface TransitOrder { order_id: number; partiya_no: string; product_type_name: string; lines: number }
export interface TransitLine extends StockItem {
  purchase_line_id: number;
  supplier_name: string;
  transit_qty: string;
  price: string;
  currency: string;
  rate: string;
}

export interface ZayavkaOrder { order_id: number; partiya_no: string; product_type_name: string; producer_name: string | null; items: number }
export interface ZayavkaItem extends StockItem {
  received: string;
  issued: string;
  left_qty: string;
  stock: string;
  avg_cost: string | null;
}
export interface ZayavkaDetail {
  order: { id: number; partiya_no: string; producer_id: number | null; producer_name: string | null };
  items: ZayavkaItem[];
}

export interface StockMove extends StockItem {
  id: number;
  doc_id: number;
  kind: StockKind;
  op: StockOp;
  doc_date: string;
  created_at: string;
  created_by_name: string | null;
  dir: 1 | -1;
  qty: string;
  sent_qty: string | null;
  price: string;
  currency: string;
  rate: string;
  amount_uzs: string;
  extra_uzs: string;
  cost_uzs: string;
  destination: Destination | null;
  producer_name: string | null;
  partiya_no: string | null;
  order_id: number | null;
  counterparty: string | null;
}

export interface StockExpense {
  id: number;
  doc_id: number;
  kind: StockKind;
  doc_date: string;
  created_at: string;
  category: string;
  supplier_name: string;
  amount: string;
  currency: string;
  rate: string;
  amount_uzs: string;
  partiya_no: string | null;
}

// ---------- Bichuv (kroy) va sifat nazorati ----------
export interface KroyOrderHead {
  id: number;
  partiya_no: string;
  status: string;
  artikul: string | null;
  model: string | null;
  kroy_closed_at: string | null;
  kroy_close_note: string | null;
  product_type_name: string;
  producer_id: number | null;
  producer_name: string | null;
}
export interface KroyCell { color_id: number; color_name: string; size_id: number; size_name: string; plan_qty: number; cut_qty: number }
export interface KroyMaterial extends StockItem { received: string; used: string; left_qty: string }
export interface KroyOrder {
  order: KroyOrderHead;
  cells: KroyCell[];
  materials: KroyMaterial[];
}
/** Kroy TM: kesilgan yozuv (ID), OTK va brak saralash natijasi */
export interface KroyItem {
  id: number;
  cut_id: number;
  cut_date: string;
  created_at: string;
  is_recut: boolean;
  order_id: number;
  partiya_no: string;
  product_type_name: string;
  artikul: string | null;
  model: string | null;
  color_id: number;
  color_name: string;
  size_id: number;
  size_name: string;
  plan_qty: number;
  fact_qty: number;
  otk_date: string | null;
  otk_first: number | null;
  otk_brak: number | null;
  otk_by_name: string | null;
  created_by_name: string | null;
  sort_date: string | null;
  sort1: number | null;
  sort2: number | null;
  scrap: number | null;
  scrap_cost_uzs: string | null;
  unit_cost: string | null;
}
export interface SemiRow {
  order_id: number;
  partiya_no: string;
  product_type_name: string;
  color_id: number;
  color_name: string;
  size_id: number;
  size_name: string;
  otk_first: number;
  sort1: number;
  sort2: number;
  total: number;
  issued: number;
  accepted: number;
  left_qty: number;
}
export interface KroyIssue {
  id: number;
  issue_no: string;
  issue_date: string;
  created_at: string;
  order_id: number;
  partiya_no: string;
  producer_id: number;
  producer_name: string;
  color_name: string;
  size_name: string;
  qty: number;
  status: 'pending' | 'accepted' | 'rejected';
  created_by_name: string | null;
}
export interface KroyClosed {
  closed: KroyOrderHead[];
  minus: (KroyMaterial & { order_id: number; partiya_no: string; kroy_closed_at: string | null })[];
}

// ---------- Tsex (ishlab chiqarish) ----------
export interface TsexIssue {
  id: number;
  issue_no: string;
  issue_date: string;
  created_at: string;
  order_id: number;
  partiya_no: string;
  product_type_name: string;
  artikul: string | null;
  model: string | null;
  producer_id: number;
  producer_name: string;
  color_id: number;
  color_name: string;
  size_id: number;
  size_name: string;
  qty: number;
  status: 'pending' | 'accepted' | 'rejected';
  decided_date: string | null;
  decided_by_name: string | null;
  created_by_name: string | null;
}
export interface TsexBalance {
  order_id: number;
  partiya_no: string;
  product_type_name: string;
  producer_id: number;
  producer_name: string;
  color_id: number;
  color_name: string;
  size_id: number;
  size_name: string;
  received: number;
  pending: number;
  produced: number;
  left_qty: number;
}
export interface TsexNorm {
  color_id: number;
  size_id: number | null;
  material_id: number;
  material_name: string;
  material_code: string | null;
  unit: string;
  material_color_id: number | null;
  material_color_name: string | null;
  color_code: string | null;
  material_size: string | null;
  per_unit: string;
}
export interface TsexPlan {
  order: { id: number; partiya_no: string; artikul: string | null; model: string | null; product_type_name: string };
  cells: TsexBalance[];
  norms: TsexNorm[];
  materials: { material_id: number; material_color_id: number | null; color_code: string | null; material_size: string | null; received: string; used: string; left_qty: string }[];
  issue_nos: { issue_no: string; cells: string[] }[];
}
export interface TsexOutput {
  id: number;
  doc_id: number;
  out_date: string;
  created_at: string;
  issue_no: string | null;
  order_id: number;
  partiya_no: string;
  product_type_name: string;
  producer_id: number;
  producer_name: string;
  color_name: string;
  size_name: string;
  need_qty: number;
  fact_qty: number;
  materials_cost: string | null;
  created_by_name: string | null;
}
export interface TsexMaterial {
  id: number;
  doc_id: number;
  out_date: string;
  created_at: string;
  partiya_no: string;
  producer_name: string;
  material_name: string;
  material_code: string | null;
  unit: string;
  material_color_name: string | null;
  color_code: string | null;
  material_size: string | null;
  per_unit: string;
  color_name: string;
  size_name: string;
  fact_qty: number;
  qty: string;
  cost_uzs: string;
}

// ---------- OTK (tayyor mahsulot) va tayyor mahsulot skladi ----------
export interface OtkOutput {
  id: number;
  doc_id: number;
  out_date: string;
  created_at: string;
  issue_no: string | null;
  order_id: number;
  partiya_no: string;
  product_type_name: string;
  artikul: string | null;
  model: string | null;
  producer_id: number;
  producer_name: string;
  color_id: number;
  color_name: string;
  size_id: number;
  size_name: string;
  fact_qty: number;
  otk_date: string | null;
  otk_sort1: number | null;
  otk_sort2: number | null;
  otk_scrap: number | null;
  unit_cost_uzs: string | null;
  scrap_cost_uzs: string | null;
  otk_by_name: string | null;
}
export interface FgStock {
  order_id: number;
  partiya_no: string;
  product_type_name: string;
  artikul: string | null;
  model: string | null;
  color_id: number;
  color_name: string;
  size_id: number;
  size_name: string;
  sort1: number;
  sort2: number;
  total: number;
  avg_cost: string | null;
  sale_price1: string | null;
  sale_price2: string | null;
}
export interface Writeoff {
  source: 'kroy' | 'otk';
  date: string;
  order_id: number;
  partiya_no: string;
  product_type_name: string;
  color_name: string;
  size_name: string;
  qty: number;
  unit_cost_uzs: string | null;
  amount_uzs: string;
  ref_id: number;
}

// ---------- Billz integratsiyasi ----------
export interface BillzRun {
  id: number;
  trigger: 'auto' | 'manual';
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  message: string | null;
  stock_rows: number | null;
  sales_rows: number | null;
}
export interface BillzSettings {
  configured: boolean;
  token_hint: string | null;
  enabled: boolean;
  shop_ids: string[];
  sales_start: string | null;
  updated_at: string;
  shops: { id: string; name: string; synced_at: string }[];
  runs: BillzRun[];
}
export interface BillzStockRow {
  shop_id: string;
  shop_name: string | null;
  product_id: string;
  product_name: string;
  base_name: string | null;
  sku: string | null;
  barcode: string | null;
  brand_name: string | null;
  supplier_name: string | null;
  unit: string | null;
  qty: string;
  supply_price: string | null;
  retail_price: string | null;
  categories: string | null;
  synced_at: string;
}
export interface BillzSalesSums {
  sold: string;
  returned: string;
  net_sold: string;
  gross_sales: string;
  returned_sum: string;
  net_sales: string;
  net_profit: string;
  supply_sum: string;
  discount: string;
}
export interface BillzSales {
  rows: (BillzSalesSums & { product_id?: string; product_name?: string; sku?: string | null; barcode?: string | null; date?: string })[];
  total: BillzSalesSums;
}

// ---------- Sotuv bo'limi (alohida biznes) ----------
export type TransferStatus = 'sent' | 'accepted' | 'rejected';
export interface SalesTransferItem {
  order_id: number;
  partiya_no: string;
  product_type_name: string;
  artikul: string | null;
  model: string | null;
  color_id: number;
  color_name: string;
  size_id: number;
  size_name: string;
  sort: 1 | 2;
  qty: number;
  price: string;
  unit_cost_uzs: string;
}
export interface SalesTransfer {
  id: number;
  doc_date: string;
  status: TransferStatus;
  note: string | null;
  created_at: string;
  decided_date: string | null;
  decided_at: string | null;
  reject_reason: string | null;
  created_by_name: string | null;
  decided_by_name: string | null;
  qty: number;
  amount_uzs: string;
  cost_uzs: string;
  items: SalesTransferItem[];
}
export type PayMethod = 'naqd' | 'plastik' | 'bank';
export interface SalesPayment {
  id: number;
  pay_date: string;
  amount_uzs: string;
  method: PayMethod;
  note: string | null;
  created_by_name: string | null;
  created_at: string;
}
export interface SalesLedger {
  opening: string;
  rows: { date: string; kind: 'transfer' | 'payment'; ref_id: number; note: string | null; debit: string; credit: string; cost: string; qty: number | null; balance: string }[];
  totals: { debit: string; credit: string; closing: string; cost: string; margin: string };
  pending: { count: number; amount_uzs: string };
}

// ---------- HR ----------
export interface HrDepartment { id: number; name: string; producer_id: number | null; producer_name: string | null; is_active: boolean; employees: number }
export interface Employee {
  id: number;
  full_name: string;
  department_id: number;
  department_name: string;
  brigade: string | null;
  position: string | null;
  schedule: string | null;
  work_mode: 'full' | 'part';
  gender: 'erkak' | 'ayol' | null;
  phone: string | null;
  hired_on: string;
  fired_on: string | null;
  fire_reason: string | null;
  note: string | null;
}
export interface EmployeeSalary { id: number; valid_from: string; amount: string; norm_hours: string; hourly: string; note: string | null; created_by_name: string | null }
export interface EmployeeDetail extends Employee { salaries: EmployeeSalary[] }
export interface TimesheetRow {
  employee_id: number;
  full_name: string;
  position: string | null;
  brigade: string | null;
  home_department_name: string;
  extra_worker: boolean;
  id: number | null;
  absent: boolean | null;
  reason: string | null;
  came_at: string | null;
  left_at: string | null;
  extra_hours: string | null;
  hours: string | null;
  note: string | null;
}
export interface TimesheetMonth {
  days: string[];
  rows: { employee_id: number; full_name: string; position: string | null; brigade: string | null; cells: Record<string, { hours: number; absent: boolean; reason: string | null }>; hours: number; days: number; absent: number }[];
  totals: Record<string, number>;
  hours: number;
}
export interface WorkType { id: number; department_id: number; department_name: string; category: string; name: string; is_active: boolean; price: string; price_from: string | null }
export interface WorkPrice { id: number; valid_from: string; price: string; created_by_name: string | null }
export interface WorkLog {
  id: number;
  work_date: string;
  employee_id: number;
  full_name: string;
  department_name: string;
  category: string;
  work_name: string;
  qty: number;
  price: string;
  amount: string;
  partiya_no: string | null;
  note: string | null;
  created_by_name: string | null;
}
export type AdjKind = 'bonus' | 'penalty' | 'other';
export interface HrAdjustment { id: number; adj_date: string; employee_id: number; full_name: string; department_name: string; kind: AdjKind; amount: string; note: string | null; created_by_name: string | null }
export interface HrPayment { id: number; pay_date: string; employee_id: number; full_name: string; department_name: string; method: 'naqd' | 'bank'; amount: string; note: string | null; created_by_name: string | null }
type Sums = { salary: string; piece: string; bonus: string; penalty: string; accrued: string; cash: string; bank: string };
export interface PayrollRow extends Sums {
  employee_id: number;
  full_name: string;
  position: string | null;
  brigade: string | null;
  department_name: string;
  fired_on: string | null;
  days: number;
  absent_days: number;
  hours: string;
  opening: string;
  other: string;
  closing: string;
}
export interface Payroll { rows: PayrollRow[]; totals: Record<'opening' | 'salary' | 'piece' | 'bonus' | 'other' | 'penalty' | 'accrued' | 'cash' | 'bank' | 'closing', string> }
export interface EmployeeStatement {
  employee: Employee;
  attendance: { days: number; absent_days: number; hours: string };
  works: { category: string; work_name: string; price: string; qty: number; amount: string }[];
  rows: (Sums & { date: string; balance: string })[];
  opening: string;
  totals: Sums & { closing: string };
}

// ---------- Kassa ----------
export type CashCurrency = 'UZS' | 'USD' | 'CNY' | 'EUR' | 'RUB';
export interface CashWallet { id: number; name: string; business: 'moliya' | 'tijorat' | 'ishlab'; kind: 'naqd' | 'karta' | 'bank' | 'avans' | 'boshqa'; is_active: boolean; sort: number }
export interface CashOpType { id: number; name: string; flow: 'in' | 'out' | 'both'; special: 'opening' | 'transfer' | 'exchange' | 'expense' | null; is_active: boolean }
export interface CashCenter { id: number; kind: 'PC' | 'CC' | 'IC'; name: string; code: string | null; is_active: boolean }
export interface CashItem { id: number; code: number; name: string; is_active: boolean; group_code: number; group_name: string | null }
export interface CashMeta {
  wallets: CashWallet[];
  op_types: CashOpType[];
  centers: CashCenter[];
  items: CashItem[];
  counterparties: string[];
  responsibles: string[];
  departments: string[];
}
export interface CashEntry {
  id: number;
  entry_date: string;
  wallet_id: number;
  wallet_name: string;
  op_name: string;
  special: CashOpType['special'];
  center_name: string | null;
  center_kind: string | null;
  item_code: number | null;
  item_name: string | null;
  counterparty: string | null;
  department: string | null;
  responsible: string | null;
  note: string | null;
  currency: CashCurrency;
  rate: string;
  amount_in: string;
  amount_out: string;
  net_uzs: string;
  period: string | null;
  partiya_no: string | null;
  pair_id: number | null;
  pair_wallet: string | null;
  created_by_name: string | null;
}
export interface CashBalance { wallet_id: number; wallet_name: string; kind: string; business: string; currency: CashCurrency; balance: string }
export interface CashReport {
  wallets: { wallet_id: number; wallet_name: string; kind: string; business: string; currency: CashCurrency; opening: string; sales_in: string; other_in: string; out: string; closing: string }[];
  by_op: { op_type_id: number; op_name: string; special: string | null; currency: CashCurrency; amount_in: string; amount_out: string; net: string; net_uzs: string }[];
  by_item: { item_id: number; code: number; name: string; group_code: number; group_name: string | null; center_kind: string | null; center_name: string | null; amount_uzs: string }[];
}
export interface CashAvans { responsible: string; currency: CashCurrency; opening: string; given: string; reported: string; closing: string }
