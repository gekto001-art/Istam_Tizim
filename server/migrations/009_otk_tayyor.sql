-- 009: OTK (tayyor mahsulot) va tayyor mahsulot skladi:
--   tsex tikkan har yozuv (Ish/Chiq GP) OTKda 1 sort / 2 sort / yaroqsizga ajratiladi;
--   1 va 2 sort tayyor mahsulot skladiga kiradi (fg_moves);
--   yaroqsiz spisat qilinadi — tannarxi bo'yicha P&L xarajat.
-- Tannarx (1 dona) = kroydagi mato sarfi + tsexdagi furnitura sarfi + zakazdagi ish narxlari.

ALTER TABLE tsex_outputs
  ADD COLUMN otk_date       date,
  ADD COLUMN otk_sort1      int CHECK (otk_sort1 >= 0),
  ADD COLUMN otk_sort2      int CHECK (otk_sort2 >= 0),
  ADD COLUMN otk_scrap      int CHECK (otk_scrap >= 0),
  ADD COLUMN unit_cost_uzs  numeric(18,2),
  ADD COLUMN scrap_cost_uzs numeric(18,2),
  ADD COLUMN otk_by         int REFERENCES users ON DELETE SET NULL,
  ADD COLUMN otk_at         timestamptz,
  ADD CONSTRAINT tsex_outputs_otk_sum CHECK (otk_at IS NULL OR otk_sort1 + otk_sort2 + otk_scrap = fact_qty);
CREATE INDEX tsex_outputs_otk ON tsex_outputs (otk_at);

-- Tayyor mahsulot skladi harakatlari (hozir — OTKdan kirim; keyin sotuv, vozvrat...)
CREATE TABLE fg_moves (
  id            serial PRIMARY KEY,
  move_date     date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('otk')),
  order_id      int NOT NULL REFERENCES orders,
  color_id      int NOT NULL REFERENCES colors,
  size_id       int NOT NULL REFERENCES sizes,
  sort          smallint NOT NULL CHECK (sort IN (1, 2)),
  dir           smallint NOT NULL CHECK (dir IN (1, -1)),
  qty           int NOT NULL CHECK (qty > 0),
  unit_cost_uzs numeric(18,2) NOT NULL DEFAULT 0,
  output_id     int REFERENCES tsex_outputs ON DELETE CASCADE,
  created_by    int REFERENCES users ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fg_moves_item ON fg_moves (order_id, color_id, size_id, sort);
