-- 015: Google Sheets'dan import (jadvaldan nusxalab joylashtirish): xodimlar, oyliklar, ish turlari va narxlar, kassa yozuvlari.
--   Har import — partiya; kassa importi partiyasi bilan birga bekor qilinadi (yozuvlar o'chadi).

CREATE TABLE import_batches (
  id          serial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('employees', 'salaries', 'work_types', 'cash')),
  label       text,
  rows_total  int NOT NULL DEFAULT 0,
  created     int NOT NULL DEFAULT 0,
  summary     jsonb,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cash_entries ADD COLUMN import_batch_id int REFERENCES import_batches ON DELETE CASCADE;
CREATE INDEX cash_entries_import ON cash_entries (import_batch_id);
