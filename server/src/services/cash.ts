import type { Db } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';

/** HR va Sotuv to'lovlarini kassaga yozish (so'mda). Manba (source, source_id) bilan bog'lanadi. */
export type CashSource = 'hr_payment' | 'sales_payment';

async function walletOf(db: Db, id: number) {
  const w = (await db.query('SELECT * FROM cash_wallets WHERE id = $1', [id])).rows[0];
  if (!w) throw notFound('Hamyon');
  if (!w.is_active) throw badRequest(`«${w.name}» hamyoni yopilgan`);
  if (w.kind === 'avans') throw badRequest('Avans-hisobot hamyonidan to\'lab bo\'lmaydi — kassa yoki bank hamyonini tanlang');
  return w;
}

const idOf = async (db: Db, sql: string, arg: unknown, what: string) => {
  const r = (await db.query(sql, [arg])).rows[0];
  if (!r) throw notFound(what);
  return r.id as number;
};

const INSERT = `INSERT INTO cash_entries (entry_date, wallet_id, op_type_id, center_id, item_id, counterparty, department, note, currency, rate,
                  amount_in, amount_out, period, pair_id, source, source_id, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'UZS', 1, $9, $10, $11, $12, $13, $14, $15) RETURNING id`;

/** Xodimga to'lov → kassada chiqim: Xarajatlar · 3001 Ish haqi; markaz — bo'lim tsexga bog'langan bo'lsa ishlab chiqarish, aks holda administratsiya */
export async function postHrPayment(
  db: Db,
  p: { id: number; pay_date: string; wallet_id: number; amount: number | string; method: string; note: string | null; employee: string; production: boolean },
  userId: number,
) {
  await walletOf(db, p.wallet_id);
  const op = await idOf(db, 'SELECT id FROM cash_op_types WHERE name = $1', 'Xarajatlar', 'Tranzaksiya turi');
  const item = await idOf(db, 'SELECT id FROM cash_items WHERE code = $1', 3001, 'Xarajat elementi 3001');
  const center = await idOf(
    db,
    'SELECT id FROM cash_centers WHERE name = $1',
    p.production ? 'Tovarlar tannarxi (ishlab chiqarish)' : 'Administratsiya',
    'Markaz',
  );
  const note = [p.method === 'naqd' ? 'Avans' : 'Ish haqi (bank)', p.note].filter(Boolean).join(' · ');
  await db.query(INSERT, [
    p.pay_date, p.wallet_id, op, center, item, p.employee, p.production ? 'FTB' : null, note, 0, p.amount, `${p.pay_date.slice(0, 7)}-01`, null,
    'hr_payment', p.id, userId,
  ]);
}

/** Sotuv → ishlab chiqarish to'lovi → kassada ichki transfer (chiqim + kirim juftligi) */
export async function postSalesPayment(
  db: Db,
  p: { id: number; pay_date: string; from_wallet_id: number; to_wallet_id: number; amount: number | string; note: string | null },
  userId: number,
) {
  if (p.from_wallet_id === p.to_wallet_id) throw badRequest('Qaysi hamyondan va qaysi hamyonga — har xil bo\'lishi kerak');
  await walletOf(db, p.from_wallet_id);
  await walletOf(db, p.to_wallet_id);
  const op = await idOf(db, 'SELECT id FROM cash_op_types WHERE name = $1', 'Ichki transfer', 'Tranzaksiya turi');
  const note = ['Sotuv bo\'limi → ishlab chiqarish to\'lovi', p.note].filter(Boolean).join(' · ');
  const out = (
    await db.query(INSERT, [p.pay_date, p.from_wallet_id, op, null, null, 'Ishlab chiqarish', 'TB', note, 0, p.amount, null, null, 'sales_payment', p.id, userId])
  ).rows[0].id as number;
  await db.query('UPDATE cash_entries SET pair_id = $1 WHERE id = $1', [out]);
  await db.query(INSERT, [p.pay_date, p.to_wallet_id, op, null, null, 'Sotuv bo\'limi', 'FTB', note, p.amount, 0, null, out, 'sales_payment', p.id, userId]);
}

export async function deleteCashBySource(db: Db, source: CashSource, id: number) {
  await db.query('DELETE FROM cash_entries WHERE source = $1 AND source_id = $2', [source, id]);
}
