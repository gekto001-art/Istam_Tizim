-- 008: Tsex (ishlab chiqarish) — Sheets "Ishlab Chiqarish ko'ylak / Shim" (har tsex uchun bir xil):
--   Prixod_Kroy — tsex kroydan kelgan yarim tayyorni qabul qiladi (Munosabat: Tasdiqlash / Rad etish);
--   Ishlab chiqarish — rang × razmer bo'yicha tikilgan fakt (Ish/Chiq GP) va zakaz normasi bo'yicha furnitura sarfi (Ish/Chiq Xa);
--   Ostatka — tsexdagi tikilmagan yarim tayyor.

ALTER TABLE kroy_issues
  ADD COLUMN decided_date date,
  ADD COLUMN decided_by   int REFERENCES users ON DELETE SET NULL,
  ADD COLUMN decided_at   timestamptz;

CREATE TABLE tsex_docs (
  id          serial PRIMARY KEY,
  order_id    int NOT NULL REFERENCES orders,
  producer_id int NOT NULL REFERENCES producers,   -- Ishlab chiqaruvchi (tsex)
  out_date    date NOT NULL,
  issue_no    text,                                -- Ish/Chiq raqami (ixtiyoriy)
  note        text,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tsex_docs_order ON tsex_docs (order_id, producer_id);

-- Ish/Chiq GP: tikilgan tayyor mahsulot
CREATE TABLE tsex_outputs (
  id          serial PRIMARY KEY,
  doc_id      int NOT NULL REFERENCES tsex_docs ON DELETE CASCADE,
  color_id    int NOT NULL REFERENCES colors,
  size_id     int NOT NULL REFERENCES sizes,
  need_qty    int NOT NULL,                        -- Tikishi kerak (shu paytdagi tikilmagan)
  fact_qty    int NOT NULL CHECK (fact_qty > 0),
  UNIQUE (doc_id, color_id, size_id)
);

-- Ish/Chiq Xa: furnitura sarfi = zakaz normasi × fakt
CREATE TABLE tsex_materials (
  id                serial PRIMARY KEY,
  doc_id            int NOT NULL REFERENCES tsex_docs ON DELETE CASCADE,
  output_id         int NOT NULL REFERENCES tsex_outputs ON DELETE CASCADE,
  material_id       int NOT NULL REFERENCES materials,
  material_color_id int REFERENCES colors,
  color_code        text,
  material_size     text,
  per_unit          numeric(14,4) NOT NULL,
  qty               numeric(14,3) NOT NULL,          -- Jami miqdor
  cost_uzs          numeric(18,2) NOT NULL DEFAULT 0
);
CREATE INDEX tsex_materials_doc ON tsex_materials (doc_id);
