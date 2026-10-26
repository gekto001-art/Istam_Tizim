import crypto from 'node:crypto';
import { z } from 'zod';

/** Vaqtinchalik parol: 12 belgi, kamida bitta harf va raqam, chalkash belgilarsiz. */
export function tempPassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  const pick = (s: string) => s[crypto.randomInt(s.length)];
  const chars = [pick(letters), pick(digits), ...Array.from({ length: 10 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export const idParam = z.coerce.number().int().positive();
export const inn = z
  .string()
  .trim()
  .regex(/^[0-9]{9}$/, 'INN 9 ta raqam')
  .nullish()
  .or(z.literal('').transform(() => null));
/** Bo'sh satrni null ga aylantiradi */
export const optText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
export const decimal = z.coerce.number().finite();

/** PATCH uchun: faqat berilgan maydonlardan SET qismini quradi (ustun nomlari oq ro'yxatdan). */
export function buildUpdate(data: Record<string, unknown>, allowed: string[], startIdx = 1) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const k of allowed) {
    if (data[k] !== undefined) {
      values.push(data[k]);
      sets.push(`${k} = $${startIdx + values.length - 1}`);
    }
  }
  return { sets, values };
}
