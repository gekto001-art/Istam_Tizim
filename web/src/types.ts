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

/** Rollar bo'yicha ruxsatlar (server/src/lib/permissions.ts dagi jadval bilan bir xil). */
export const can = {
  users: (r: Role) => r === 'admin',
  audit: (r: Role) => r === 'admin' || r === 'rahbar' || r === 'buxgalter',
};
