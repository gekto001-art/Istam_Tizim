-- 018: P&L (foyda va zarar) — har biznes alohida: ishlab chiqarish, Sotuv bo'limi, umumiy (moliya).
--   Kassa yozuvi qaysi biznesga tegishli — hamyon turi bo'yicha (ishlab / tijorat / moliya);
--   tranzaksiya turida «P&L ga kiradi» belgisi: chiqim — davr xarajati, kirim — boshqa daromad
--   (transfer, ayriboshlash, investitsiya, kredit, qarz, tovar xaridi, sotuvdan tushum — kirmaydi: daromad va tannarx tizim hujjatlaridan olinadi);
--   HR bo'limi qaysi biznesga tegishli — ish haqi nachisleniyasi shu biznes xarajati.

ALTER TABLE cash_op_types ADD COLUMN in_pnl boolean NOT NULL DEFAULT false;
UPDATE cash_op_types SET in_pnl = true WHERE name IN ('Xarajatlar', 'Boshqa xarajatlar', 'Boshqa tushumlar', 'Tikuv xizmati');

ALTER TABLE hr_departments ADD COLUMN business text NOT NULL DEFAULT 'ishlab' CHECK (business IN ('ishlab', 'sotuv', 'umumiy'));
UPDATE hr_departments SET business = 'umumiy' WHERE producer_id IS NULL;
