-- 019: Ish nazorati — xodimning faolligi (Status): Aktiv / Neytral / Passiv.
--   Status ish haqiga ta'sir qilmaydi (ishbay summasi o'zgarmaydi), bonusni belgilashda hisobga olinadi — vedomostda status bo'yicha ko'rinadi.
--   Sheets "Ish nazorati baza" importi: partiya bilan birga bekor qilinadi.

ALTER TABLE hr_work_logs ADD COLUMN status text NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv', 'neytral', 'passiv'));

ALTER TABLE import_batches DROP CONSTRAINT import_batches_kind_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_kind_check CHECK (kind IN ('employees', 'salaries', 'work_types', 'cash', 'work_logs'));
ALTER TABLE hr_work_logs ADD COLUMN import_batch_id int REFERENCES import_batches ON DELETE CASCADE;
CREATE INDEX hr_work_logs_import ON hr_work_logs (import_batch_id);
