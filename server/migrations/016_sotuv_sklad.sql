-- 016: Sotuv bo'limi skladi (4.2).
--   Tovar: o'zimizniki (partiya × rang × razmer × sort — ishlab chiqarishdan qabul qilinganda o'zi yaratiladi)
--          yoki boshqa postavshikniki (nomi, artikul, rang, razmer qo'lda).
--   Harakatlar: ishlab chiqarishdan qabul (+), postavshikdan prixod (+), do'konga jo'natish (−), do'kondan qaytish (+),
--   inventarizatsiya (±). Narx (tannarx Sotuv uchun): o'zimizniki — ichki narx, boshqalarniki — xarid narxi.
--   Postavshiklar oldidagi qarz: prixod − to'lov; to'lov hamyon tanlansa kassaga chiqim bo'lib yoziladi.
--   Billz bilan solishtirish — barcode bo'yicha.

CREATE TABLE sales_suppliers (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  phone      text,
  note       text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sales_suppliers_name ON sales_suppliers (lower(name));

CREATE TABLE sales_products (
  id          serial PRIMARY KEY,
  source      text NOT NULL CHECK (source IN ('own', 'other')),
  order_id    int REFERENCES orders,
  color_id    int REFERENCES colors,
  size_id     int REFERENCES sizes,
  sort        smallint CHECK (sort IN (1, 2)),
  name        text NOT NULL,
  artikul     text,
  color_name  text,
  size_name   text,
  barcode     text,
  supplier_id int REFERENCES sales_suppliers,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'own') = (order_id IS NOT NULL AND color_id IS NOT NULL AND size_id IS NOT NULL AND sort IS NOT NULL)),
  UNIQUE (order_id, color_id, size_id, sort)
);
CREATE UNIQUE INDEX sales_products_barcode ON sales_products (barcode) WHERE barcode IS NOT NULL;

-- Sklad hujjati: postavshikdan prixod, do'konga jo'natish, do'kondan qaytish, inventarizatsiya
CREATE TABLE sales_docs (
  id          serial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('purchase', 'shop', 'shop_return', 'adjust')),
  doc_date    date NOT NULL,
  supplier_id int REFERENCES sales_suppliers,
  shop_id     text,                       -- Billz do'koni (billz_shops.id) yoki bo'sh
  shop_name   text,
  note        text,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'purchase') = (supplier_id IS NOT NULL))
);
CREATE INDEX sales_docs_date ON sales_docs (kind, doc_date);

CREATE TABLE sales_moves (
  id          serial PRIMARY KEY,
  move_date   date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('transfer', 'purchase', 'shop', 'shop_return', 'adjust')),
  product_id  int NOT NULL REFERENCES sales_products,
  dir         smallint NOT NULL CHECK (dir IN (1, -1)),
  qty         int NOT NULL CHECK (qty > 0),
  unit_cost   numeric(18,2) NOT NULL DEFAULT 0,      -- Sotuv uchun tannarx (1 dona)
  transfer_id int REFERENCES sales_transfers ON DELETE CASCADE,
  doc_id      int REFERENCES sales_docs ON DELETE CASCADE,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((transfer_id IS NULL) <> (doc_id IS NULL))
);
CREATE INDEX sales_moves_product ON sales_moves (product_id, move_date);
CREATE INDEX sales_moves_doc ON sales_moves (doc_id);
CREATE INDEX sales_moves_transfer ON sales_moves (transfer_id);

-- Postavshiklarga to'lovlar
CREATE TABLE sales_supplier_payments (
  id          serial PRIMARY KEY,
  pay_date    date NOT NULL,
  supplier_id int NOT NULL REFERENCES sales_suppliers,
  amount_uzs  numeric(18,2) NOT NULL CHECK (amount_uzs > 0),
  method      text NOT NULL CHECK (method IN ('naqd', 'plastik', 'bank')),
  wallet_id   int REFERENCES cash_wallets,
  note        text,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_supplier_payments_sup ON sales_supplier_payments (supplier_id, pay_date);

-- Kassa: postavshikka to'lov — «Tovar xaridi» chiqimi
INSERT INTO cash_op_types (name, flow, special, sort) VALUES ('Tovar xaridi', 'out', NULL, 9) ON CONFLICT (name) DO NOTHING;
ALTER TABLE cash_entries DROP CONSTRAINT cash_entries_source_check;
ALTER TABLE cash_entries ADD CONSTRAINT cash_entries_source_check CHECK (source IN ('hr_payment', 'sales_payment', 'sales_supplier_payment'));

-- Avval qabul qilingan o'tkazmalar Sotuv skladiga kiritiladi
INSERT INTO sales_products (source, order_id, color_id, size_id, sort, name, artikul, color_name, size_name)
SELECT DISTINCT 'own', i.order_id, i.color_id, i.size_id, i.sort,
       concat_ws(' ', pt.name, nullif(o.model, '')), o.artikul, c.name, s.name
  FROM sales_transfer_items i JOIN sales_transfers t ON t.id = i.transfer_id AND t.status = 'accepted'
  JOIN orders o ON o.id = i.order_id JOIN product_types pt ON pt.id = o.product_type_id
  JOIN colors c ON c.id = i.color_id JOIN sizes s ON s.id = i.size_id;
INSERT INTO sales_moves (move_date, kind, product_id, dir, qty, unit_cost, transfer_id, created_by)
SELECT t.decided_date, 'transfer', p.id, 1, i.qty, i.price, t.id, t.decided_by
  FROM sales_transfer_items i JOIN sales_transfers t ON t.id = i.transfer_id AND t.status = 'accepted'
  JOIN sales_products p ON p.order_id = i.order_id AND p.color_id = i.color_id AND p.size_id = i.size_id AND p.sort = i.sort;
