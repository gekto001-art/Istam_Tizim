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

/** Har bir modul qo'shilganda shu yerga amal va unga ruxsatli rollar yoziladi (frontenddagi `can` bilan bir xil). */
export type Action =
  | 'users.manage' // foydalanuvchilar va rollar
  | 'audit.read'
  | 'catalog.write' // ranglar, razmerlar, tovar turlari, xomashyo, postavshik, korxona
  | 'rates.write' // valyuta kurslari
  | 'orders.read' // zakazlarni ko'rish
  | 'orders.write' // zakaz yaratish va qoralamani tahrirlash (innovatsion bo'lim)
  | 'orders.confirm' // zakazni tasdiqlash — xomashyo ta'minotga ketadi
  | 'orders.reopen' // tasdiqlangan zakazni qoralamaga qaytarish yoki bekor qilish
  | 'purchase.read' // ta'minot: xomashyo zakazi va postavshik buyurtmalarini ko'rish
  | 'purchase.write' // buyurtma yaratish, nakladnoy kiritish, bekor qilish
  | 'purchase.approve' // postavshik kelishuvini tasdiqlash / rad etish
  | 'stock.read' // xomashyo skladi: qoldiq, prixod, rasxod, sotuv jurnali
  | 'stock.write'; // sklad hujjatlarini kiritish va o'chirish

const MATRIX: Record<Action, Role[]> = {
  'users.manage': ['admin'],
  'audit.read': ['admin', 'rahbar', 'buxgalter'],
  'catalog.write': ['admin', 'innovatsiya', 'taminot'],
  'rates.write': ['admin', 'buxgalter', 'taminot'],
  'orders.read': ['admin', 'rahbar', 'innovatsiya', 'taminot', 'sklad', 'bichuv', 'tsex', 'otk', 'buxgalter'],
  'orders.write': ['admin', 'innovatsiya'],
  'orders.confirm': ['admin', 'innovatsiya'],
  'orders.reopen': ['admin', 'rahbar'],
  'purchase.read': ['admin', 'rahbar', 'taminot', 'innovatsiya', 'buxgalter', 'sklad'],
  'purchase.write': ['admin', 'taminot'],
  'purchase.approve': ['admin', 'rahbar', 'taminot'],
  'stock.read': ['admin', 'rahbar', 'sklad', 'taminot', 'innovatsiya', 'bichuv', 'buxgalter'],
  'stock.write': ['admin', 'sklad'],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[action].includes(role);
}
