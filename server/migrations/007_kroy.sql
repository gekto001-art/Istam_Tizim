-- 007: Bichuv (kroy) va sifat nazorati (Sheets "Kroy" va "Sifat Nazorati_Bichuv"):
--   Kroy — partiya kataklari (rang × razmer) bo'yicha kesilgan fakt soni va har katakka xomashyo sarfi;
--   OTK Bichuv — har kesilgan yozuv (ID) bo'yicha 1 sort va brak;
--   OTK Brak — brak kroyda 1 sort, 2 sort va yaroqsizga ajratiladi (yaroqsiz — P&L xarajat);
--   Kroydan rasxod — yarim tayyor mahsulot ishlab chiqarishga (korxonaga) jo'natiladi;
--   Yopilgan zakazlar — kroyda yopilgan partiyalar.

CREATE TABLE kroy_cuts (
  id          serial PRIMARY KEY,
  order_id    int NOT NULL REFERENCES orders,
  cut_date    date NOT NULL,
  is_recut    boolean NOT NULL DEFAULT false,              -- PereKroymi
  note        text,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kroy_cuts_order ON kroy_cuts (order_id);

-- Kroy TM: kesilgan yarim tayyor (ID — Sheets'dagi ID), OTK natijasi shu qatorda
CREATE TABLE kroy_cut_items (
  id          serial PRIMARY KEY,
  cut_id      int NOT NULL REFERENCES kroy_cuts ON DELETE CASCADE,
  color_id    int NOT NULL REFERENCES colors,
  size_id     int NOT NULL REFERENCES sizes,
  plan_qty    int NOT NULL DEFAULT 0,
  fact_qty    int NOT NULL CHECK (fact_qty > 0),
  otk_date    date,
  otk_first   int CHECK (otk_first >= 0),                  -- OTK 1 sort
  otk_brak    int CHECK (otk_brak >= 0),                   -- OTK brak
  otk_by      int REFERENCES users ON DELETE SET NULL,
  otk_at      timestamptz,
  CHECK (otk_at IS NULL OR otk_first + otk_brak = fact_qty),
  UNIQUE (cut_id, color_id, size_id)
);
CREATE INDEX kroy_cut_items_otk ON kroy_cut_items (otk_at);

-- Kroy Xa: katak bo'yicha xomashyo sarfi (tannarx — sarf paytidagi o'rtacha narx)
CREATE TABLE kroy_cut_materials (
  id                serial PRIMARY KEY,
  item_id           int NOT NULL REFERENCES kroy_cut_items ON DELETE CASCADE,
  material_id       int NOT NULL REFERENCES materials,
  material_color_id int REFERENCES colors,
  color_code        text,
  material_size     text,
  qty               numeric(14,3) NOT NULL CHECK (qty > 0),
  cost_uzs          numeric(18,2) NOT NULL DEFAULT 0
);
CREATE INDEX kroy_cut_materials_item ON kroy_cut_materials (item_id);

-- OTK Brak → kroyda saralash (OTK_KROY)
CREATE TABLE kroy_brak_sorts (
  id          serial PRIMARY KEY,
  item_id     int NOT NULL UNIQUE REFERENCES kroy_cut_items ON DELETE CASCADE,
  sort_date   date NOT NULL,
  sort1       int NOT NULL CHECK (sort1 >= 0),
  sort2       int NOT NULL CHECK (sort2 >= 0),
  scrap       int NOT NULL CHECK (scrap >= 0),              -- Yaroqsiz
  scrap_cost_uzs numeric(18,2) NOT NULL DEFAULT 0,         -- P&L xarajat
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Kroydan rasxod (Rasxod baza): yarim tayyor ishlab chiqarishga
CREATE TABLE kroy_issues (
  id          serial PRIMARY KEY,
  order_id    int NOT NULL REFERENCES orders,
  issue_date  date NOT NULL,
  issue_no    text NOT NULL,                                -- Ish/Chiq raqam: partiya_N
  producer_id int NOT NULL REFERENCES producers,            -- Qayerga (qaysi korxonaga)
  color_id    int NOT NULL REFERENCES colors,
  size_id     int NOT NULL REFERENCES sizes,
  qty         int NOT NULL CHECK (qty > 0),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),  -- Munosabat (ishlab chiqarish)
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kroy_issues_order ON kroy_issues (order_id, color_id, size_id);

-- Yopilgan zakazlar (kroy ro'yxatidan chiqadi)
ALTER TABLE orders ADD COLUMN kroy_closed_at date, ADD COLUMN kroy_close_note text;
