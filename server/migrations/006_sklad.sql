-- 006: Xomashyo skladi (Sheets "Xomashyo Sklad"):
--   Prixod (Ta'minot orqali) — yo'lga chiqqan buyurtmalardan qabul, fakt miqdor va qo'shimcha xarajatlar (kargo, bojxona...);
--   Prixod — oddiy kirim / postavshikka vozvrat;
--   Rasxod (Zayavka) — partiya uchun kroy yoki tsexga peremesheniya / vozvrat;
--   Rasxod — oddiy chiqim; Sotuv — xomashyo sotuvi; Ostatka — qoldiq va o'rtacha tannarx.
-- Xomashyo kaliti: nomi (material) + rangi + rang kodi + razmeri (Sheets'dagi "Umumiy nomi").

CREATE TABLE stock_docs (
  id          serial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('prixod_taminot','prixod','rasxod_zayavka','rasxod','sotuv')),
  op          text NOT NULL CHECK (op IN ('prixod','vozvrat','peremesheniya','sotuv')),
  doc_date    date NOT NULL,
  order_id    int REFERENCES orders,                -- partiya (Zakaz raqami)
  supplier_id int REFERENCES suppliers,             -- prixod: kontragent
  counterparty text,                                -- sotuv: mijoz
  currency    text,
  rate        numeric(14,4),
  note        text,
  goods_uzs   numeric(18,2) NOT NULL DEFAULT 0,     -- xomashyo summasi so'mda
  extra_uzs   numeric(18,2) NOT NULL DEFAULT 0,     -- qo'shimcha xarajatlar so'mda
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_docs_kind ON stock_docs (kind, doc_date DESC);
CREATE INDEX stock_docs_order ON stock_docs (order_id);

CREATE TABLE stock_moves (
  id                serial PRIMARY KEY,
  doc_id            int NOT NULL REFERENCES stock_docs ON DELETE CASCADE,
  material_id       int NOT NULL REFERENCES materials,
  material_color_id int REFERENCES colors,
  color_code        text,
  material_size     text,
  dir               smallint NOT NULL CHECK (dir IN (1, -1)),   -- +1 kirim, -1 chiqim
  qty               numeric(14,3) NOT NULL CHECK (qty > 0),      -- Miqdor real
  sent_qty          numeric(14,3),                               -- Yuborilgan miqdor (ta'minot orqali)
  price             numeric(18,4) NOT NULL DEFAULT 0,            -- prixod/sotuv: hujjat valyutasida; rasxod: o'rtacha tannarx so'mda
  currency          text NOT NULL DEFAULT 'UZS',
  rate              numeric(14,4) NOT NULL DEFAULT 1,
  amount_uzs        numeric(18,2) NOT NULL DEFAULT 0,            -- Summa so'm (xomashyo / sotuv)
  extra_uzs         numeric(18,2) NOT NULL DEFAULT 0,            -- Summa so'm qo'shimcha (taqsimlangan)
  cost_uzs          numeric(18,2) NOT NULL DEFAULT 0,            -- tannarx: prixodda jami, chiqimda qty × o'rtacha
  destination       text CHECK (destination IN ('kroy','producer','other')),  -- Qayergaligi
  producer_id       int REFERENCES producers,
  order_id          int REFERENCES orders,
  purchase_line_id  int REFERENCES purchase_order_lines
);
CREATE INDEX stock_moves_item ON stock_moves (material_id, material_color_id, color_code, material_size);
CREATE INDEX stock_moves_doc ON stock_moves (doc_id);
CREATE INDEX stock_moves_order ON stock_moves (order_id);
CREATE INDEX stock_moves_pline ON stock_moves (purchase_line_id);

-- Qo'shimcha xarajatlar (Kargo, Bojxona, Logistika, Boshqa) — prixod qatorlariga miqdor ulushida taqsimlanadi
CREATE TABLE stock_expenses (
  id          serial PRIMARY KEY,
  doc_id      int NOT NULL REFERENCES stock_docs ON DELETE CASCADE,
  category    text NOT NULL,
  supplier_id int NOT NULL REFERENCES suppliers,
  amount      numeric(18,2) NOT NULL CHECK (amount > 0),
  currency    text NOT NULL,
  rate        numeric(14,4) NOT NULL,
  amount_uzs  numeric(18,2) NOT NULL
);
