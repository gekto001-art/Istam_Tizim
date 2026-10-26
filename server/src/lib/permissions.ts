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
  | 'audit.read';

const MATRIX: Record<Action, Role[]> = {
  'users.manage': ['admin'],
  'audit.read': ['admin', 'rahbar', 'buxgalter'],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[action].includes(role);
}
