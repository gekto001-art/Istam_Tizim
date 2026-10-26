-- 002: Innovatsion bo'lim — ma'lumotnomalar va zakaz (partiya).
-- Google Sheets "Innovatsion bo'lim" → "Zakazlar" varag'i o'rniga:
--   zakaz sarlavhasi + razmer × rang matritsasi + har rang uchun xomashyo normasi + ish narxlari.

-- ---------- Ma'lumotnomalar ----------
CREATE TABLE colors (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  code        text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX colors_name_key ON colors (lower(name));

CREATE TABLE sizes (
  id          serial PRIMARY KEY,
  name        text NOT NULL,            -- "3--6", "7--10" ...
  sort        int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sizes_name_key ON sizes (lower(name));

CREATE TABLE product_types (
  id          serial PRIMARY KEY,
  name        text NOT NULL,            -- Rubashka, Dvoyka, Shim ...
  unit        text NOT NULL DEFAULT 'Dona',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_types_name_key ON product_types (lower(name));

-- Postavshiklar (xomashyo yetkazib beruvchilar)
CREATE TABLE suppliers (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  country     text,
  phone       text,
  note        text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppliers_name_key ON suppliers (lower(name));

-- Korxonalar: o'z tsexlari yoki tashqi tikuvchi (podryadchik)
CREATE TABLE producers (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'own' CHECK (kind IN ('own','contractor')),
  note        text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX producers_name_key ON producers (lower(name));

CREATE TABLE materials (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  code        text,
  unit        text NOT NULL DEFAULT 'Dona',
  supplier_id int REFERENCES suppliers,          -- odatiy postavshik (zakazda o'zgartirsa bo'ladi)
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX materials_name_code_key ON materials (lower(name), lower(coalesce(code, '')));

-- Valyuta kurslari (so'mga). So'm uchun kurs har doim 1.
CREATE TABLE currency_rates (
  id          serial PRIMARY KEY,
  currency    text NOT NULL CHECK (currency IN ('USD','CNY','EUR','RUB')),
  rate        numeric(14,4) NOT NULL CHECK (rate > 0),
  valid_from  date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency, valid_from)
);

-- Berilgan sanadagi kurs (oxirgi kiritilgani)
CREATE OR REPLACE FUNCTION rate_at(p_currency text, p_date date) RETURNS numeric
  LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_currency = 'UZS' THEN 1::numeric ELSE
    (SELECT rate FROM currency_rates WHERE currency = p_currency AND valid_from <= p_date ORDER BY valid_from DESC LIMIT 1) END
$$;

-- ---------- Zakaz (partiya) ----------
CREATE TABLE orders (
  id              serial PRIMARY KEY,
  partiya_no      text NOT NULL,
  order_date      date NOT NULL,
  product_type_id int NOT NULL REFERENCES product_types,
  artikul         text,
  model           text,
  season          text CHECK (season IN ('Bahor','Yoz','Kuz','Qish')),
  unit            text NOT NULL DEFAULT 'Dona',
  producer_id     int REFERENCES producers,      -- qaysi korxonaga
  ordered_by      text,                          -- kim zakaz bergani
  start_date      date,                          -- muddat boshi
  end_date        date,                          -- muddat oxiri
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','cancelled')),
  note            text,
  created_by      int REFERENCES users ON DELETE SET NULL,
  confirmed_by    int REFERENCES users ON DELETE SET NULL,
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX orders_partiya_key ON orders (lower(partiya_no));
CREATE INDEX orders_date ON orders (order_date DESC, id DESC);
CREATE TRIGGER t_orders_upd BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Razmer × rang matritsasi: nechta dona tikiladi
CREATE TABLE order_items (
  id        serial PRIMARY KEY,
  order_id  int NOT NULL REFERENCES orders ON DELETE CASCADE,
  size_id   int NOT NULL REFERENCES sizes,
  color_id  int NOT NULL REFERENCES colors,
  qty       int NOT NULL CHECK (qty > 0),
  UNIQUE (order_id, size_id, color_id)
);

-- Xomashyo normasi: har qator shu rangdagi mahsulot uchun (1 dona mahsulotga sarf)
CREATE TABLE order_materials (
  id                serial PRIMARY KEY,
  order_id          int NOT NULL REFERENCES orders ON DELETE CASCADE,
  color_id          int NOT NULL REFERENCES colors,        -- tayyor mahsulot rangi
  material_id       int NOT NULL REFERENCES materials,
  supplier_id       int REFERENCES suppliers,
  material_color_id int REFERENCES colors,                 -- xomashyo rangi
  color_code        text,                                  -- postavshikdagi rang kodi
  material_size     text,                                  -- xomashyo razmeri (tugma 16, salafan 20/31)
  per_unit          numeric(14,4) NOT NULL CHECK (per_unit > 0),
  price             numeric(18,4) NOT NULL DEFAULT 0 CHECK (price >= 0),   -- valyutadagi birlik narxi
  currency          text NOT NULL DEFAULT 'UZS' CHECK (currency IN ('UZS','USD','CNY','EUR','RUB')),
  rate              numeric(14,4) NOT NULL DEFAULT 1 CHECK (rate > 0),     -- so'mga kurs (zakaz sanasidagi)
  from_us           boolean NOT NULL DEFAULT true,                         -- xomashyo bizdanmi
  note              text,
  sort              int NOT NULL DEFAULT 0
);
CREATE INDEX order_materials_order ON order_materials (order_id, color_id, sort, id);

-- Ish narxlari (1 dona uchun): kroy, tikuv ...
CREATE TABLE order_works (
  id           serial PRIMARY KEY,
  order_id     int NOT NULL REFERENCES orders ON DELETE CASCADE,
  producer_id  int NOT NULL REFERENCES producers,
  price        numeric(18,2) NOT NULL CHECK (price >= 0),
  note         text,
  UNIQUE (order_id, producer_id)
);

-- ---------- Boshlang'ich ro'yxatlar (Sheets'dagi toza qiymatlar) ----------
INSERT INTO sizes (name, sort) VALUES ('3--6', 10), ('6--11', 20), ('7--10', 30), ('7--11', 40), ('7--14', 50), ('11--14', 60), ('3--14', 70);
INSERT INTO colors (name, code) VALUES
  ('Goluboy', '14'), ('Shaffof', '1111'), ('MOKRI', '7'), ('aranjivi', '2233'), ('Bardovi', '1234'), ('Qora-Oq', '001'),
  ('Sini-oq', '1112'), ('Qora-siniy', '1212'), ('QIZGISH', '780'), ('Qora', NULL), ('Oq', NULL), ('Bejeviy', NULL), ('Seriy', NULL),
  ('T-siniy', NULL), ('Yashil', NULL), ('Sariq', NULL), ('Kafeine', NULL), ('Jigarrang', NULL);
INSERT INTO product_types (name) VALUES ('Rubashka'), ('Dvoyka'), ('Troyka'), ('Shim'), ('Bryuk'), ('Kardigan'), ('Bezrukavka'), ('Rub-Kar');
INSERT INTO producers (name, kind) VALUES
  ('Kroy', 'own'), ('1-ISTAM KO''YLAK', 'own'), ('2-ISTAM SHIM', 'own'),
  ('ADIN HABIBULLOX', 'contractor'), ('An nur', 'contractor'), ('MUSTANG', 'contractor'), ('Ruslan aka', 'contractor');
INSERT INTO suppliers (name, country) VALUES
  ('ISTAM', NULL), ('XIUDONG', 'Xitoy'), ('BUTTON', NULL), ('SHEVRON', NULL), ('ETIKETKA', NULL), ('TIAMO', NULL),
  ('KIXAY Textile', 'Xitoy'), ('Vilvet', NULL), ('LEON', NULL), ('YIGU TEKCTILE', 'Xitoy'), ('Sunum', NULL), ('MERGANTEKS', NULL),
  ('BAHMAL GROUP', NULL), ('Ozdemir', 'Turkiya');
INSERT INTO currency_rates (currency, rate, valid_from) VALUES
  ('CNY', 1790, '2025-01-01'), ('USD', 12000, '2025-01-01'), ('EUR', 15000, '2025-01-01'), ('RUB', 150, '2025-01-01');
