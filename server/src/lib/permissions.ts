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
  | 'orders.price' // Sotuv bo'limiga narx (1 / 2 sort) — zakaz holatidan qat'i nazar
  | 'purchase.read' // ta'minot: xomashyo zakazi va postavshik buyurtmalarini ko'rish
  | 'purchase.write' // buyurtma yaratish, nakladnoy kiritish, bekor qilish
  | 'purchase.approve' // postavshik kelishuvini tasdiqlash / rad etish
  | 'stock.read' // xomashyo skladi: qoldiq, prixod, rasxod, sotuv jurnali
  | 'stock.write' // sklad hujjatlarini kiritish va o'chirish
  | 'kroy.read' // bichuv: kroy, OTK, yarim tayyor
  | 'kroy.write' // kroy kiritish, brakni saralash, kroydan rasxod, zakazni kroyda yopish
  | 'otk.write' // sifat nazorati (OTK Bichuv)
  | 'tsex.read' // tsex: kroydan prixod, ishlab chiqarish, ostatka
  | 'tsex.write' // kroydan kelganini qabul qilish / rad etish, tikilgan fakt
  | 'fg.read' // OTK (tayyor mahsulot), tayyor mahsulot skladi, spisaniya
  | 'sales.read' // Sotuv bo'limi: ishlab chiqarishdan o'tkazmalar, hisob-kitob (qarz)
  | 'sales.transfer' // tayyor mahsulot skladidan Sotuv bo'limiga o'tkazma yuborish / o'chirish
  | 'sales.accept' // o'tkazmani qabul qilish / rad etish (Sotuv bo'limi)
  | 'sales.pay' // Sotuv bo'limining ishlab chiqarishga to'lovlari
  | 'billz.read' // Billz'dan olingan qoldiq va sotuv, qo'lda yangilash
  | 'billz.manage' // Billz kaliti va sozlamalari
  | 'reports.read'; // hisobotlar (ABC tahlil...)

const MATRIX: Record<Action, Role[]> = {
  'users.manage': ['admin'],
  'audit.read': ['admin', 'rahbar', 'buxgalter'],
  'catalog.write': ['admin', 'innovatsiya', 'taminot'],
  'rates.write': ['admin', 'buxgalter', 'taminot'],
  'orders.read': ['admin', 'rahbar', 'innovatsiya', 'taminot', 'sklad', 'bichuv', 'tsex', 'otk', 'buxgalter'],
  'orders.write': ['admin', 'innovatsiya'],
  'orders.confirm': ['admin', 'innovatsiya'],
  'orders.reopen': ['admin', 'rahbar'],
  'orders.price': ['admin', 'rahbar', 'innovatsiya'],
  'purchase.read': ['admin', 'rahbar', 'taminot', 'innovatsiya', 'buxgalter', 'sklad'],
  'purchase.write': ['admin', 'taminot'],
  'purchase.approve': ['admin', 'rahbar', 'taminot'],
  'stock.read': ['admin', 'rahbar', 'sklad', 'taminot', 'innovatsiya', 'bichuv', 'buxgalter'],
  'stock.write': ['admin', 'sklad'],
  'kroy.read': ['admin', 'rahbar', 'bichuv', 'otk', 'sklad', 'innovatsiya', 'tsex', 'buxgalter'],
  'kroy.write': ['admin', 'bichuv'],
  'otk.write': ['admin', 'otk'],
  'tsex.read': ['admin', 'rahbar', 'tsex', 'bichuv', 'otk', 'sklad', 'innovatsiya', 'buxgalter'],
  'tsex.write': ['admin', 'tsex'],
  'fg.read': ['admin', 'rahbar', 'otk', 'sklad', 'sotuv', 'tsex', 'bichuv', 'innovatsiya', 'buxgalter'],
  'sales.read': ['admin', 'rahbar', 'sotuv', 'sklad', 'buxgalter', 'kassir', 'innovatsiya'],
  'sales.transfer': ['admin', 'sklad'],
  'sales.accept': ['admin', 'sotuv'],
  'sales.pay': ['admin', 'buxgalter', 'kassir'],
  'billz.read': ['admin', 'rahbar', 'sklad', 'sotuv', 'buxgalter', 'otk'],
  'billz.manage': ['admin'],
  'reports.read': ['admin', 'rahbar', 'buxgalter', 'sotuv'],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[action].includes(role);
}
