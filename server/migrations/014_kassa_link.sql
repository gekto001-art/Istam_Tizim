-- 014: HR va Sotuv to'lovlari kassaga bog'lanadi — ikki joyga alohida kiritilmaydi.
--   HR: xodimga to'lovda hamyon tanlansa — kassada chiqim (Xarajatlar · 3001 Ish haqi), kontragent — xodim;
--   Sotuv: ishlab chiqarishga to'lovda ikki hamyon tanlansa — kassada ichki transfer (Sotuv hamyoni → ishlab chiqarish hamyoni).
--   Bunday kassa yozuvi manba (HR / Sotuv) orqali o'chiriladi; kassadan to'g'ridan-to'g'ri o'chirib bo'lmaydi.

ALTER TABLE cash_entries
  ADD COLUMN source    text CHECK (source IN ('hr_payment', 'sales_payment')),
  ADD COLUMN source_id int,
  ADD CONSTRAINT cash_entries_source_chk CHECK ((source IS NULL) = (source_id IS NULL));
CREATE INDEX cash_entries_source ON cash_entries (source, source_id);

ALTER TABLE hr_payments ADD COLUMN wallet_id int REFERENCES cash_wallets;
ALTER TABLE sales_payments
  ADD COLUMN from_wallet_id int REFERENCES cash_wallets,
  ADD COLUMN to_wallet_id   int REFERENCES cash_wallets,
  ADD CONSTRAINT sales_payments_wallets_chk CHECK ((from_wallet_id IS NULL) = (to_wallet_id IS NULL) AND (from_wallet_id IS NULL OR from_wallet_id <> to_wallet_id));
