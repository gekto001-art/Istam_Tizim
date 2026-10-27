-- 010: Billz integratsiyasi (faqat Billz'dan bizga): tayyor mahsulot prixodi Billz'da qilinadi;
-- har 5 daqiqada do'konlar, qoldiq (Stock by product) va sotuv (Sales by product, kun bo'yicha) olinadi.

-- Sozlamalar (bitta qator). Billz kaliti shifrlangan (AES-256-GCM), hech qachon qaytarilmaydi.
CREATE TABLE billz_settings (
  id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  secret_enc     text,
  token_hint     text,                       -- kalitning oxirgi 4 belgisi (ko'rsatish uchun)
  enabled        boolean NOT NULL DEFAULT false,
  shop_ids       text[] NOT NULL DEFAULT '{}',
  sales_start    date,                       -- sotuvlar shu sanadan olinadi
  access_token   text,
  access_expires timestamptz,
  updated_by     int REFERENCES users ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billz_settings (id) VALUES (1);

CREATE TABLE billz_shops (
  id        text PRIMARY KEY,
  name      text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

-- Qoldiq: har yangilanishda to'liq almashtiriladi
CREATE TABLE billz_stock (
  shop_id       text NOT NULL,
  product_id    text NOT NULL,
  product_name  text NOT NULL,
  base_name     text,
  sku           text,
  barcode       text,
  brand_name    text,
  supplier_name text,
  unit          text,
  qty           numeric(14,3) NOT NULL DEFAULT 0,
  supply_price  numeric(18,2),
  retail_price  numeric(18,2),
  attributes    jsonb,
  categories    text,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, product_id)
);
CREATE INDEX billz_stock_barcode ON billz_stock (barcode);

-- Sotuv: kun × do'kon × tovar; oxirgi kunlar har safar qayta yoziladi
CREATE TABLE billz_sales (
  date         date NOT NULL,
  shop_id      text NOT NULL,
  product_id   text NOT NULL,
  product_name text NOT NULL,
  sku          text,
  barcode      text,
  sold         numeric(14,3) NOT NULL DEFAULT 0,
  returned     numeric(14,3) NOT NULL DEFAULT 0,
  net_sold     numeric(14,3) NOT NULL DEFAULT 0,
  gross_sales  numeric(18,2) NOT NULL DEFAULT 0,
  returned_sum numeric(18,2) NOT NULL DEFAULT 0,
  net_sales    numeric(18,2) NOT NULL DEFAULT 0,
  net_profit   numeric(18,2) NOT NULL DEFAULT 0,
  supply_sum   numeric(18,2) NOT NULL DEFAULT 0,
  discount     numeric(18,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (date, shop_id, product_id)
);

CREATE TABLE billz_sync_runs (
  id          serial PRIMARY KEY,
  trigger     text NOT NULL CHECK (trigger IN ('auto', 'manual')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  message     text,
  stock_rows  int,
  sales_rows  int
);
CREATE INDEX billz_sync_runs_started ON billz_sync_runs (started_at DESC);
