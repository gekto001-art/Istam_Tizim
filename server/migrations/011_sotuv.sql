-- 011: Sotuv bo'limi — alohida biznes (1-qism: ishlab chiqarishdan prixod va hisob-kitob).
--   Ishlab chiqarish tayyor mahsulotni Sotuv bo'limiga ichki narxda sotadi: narx modelda (zakazda) — 1 sort va 2 sort;
--   tayyor mahsulot skladi o'tkazma yuboradi, Sotuv bo'limi qabul qiladi yoki rad etadi;
--   qabul qilingani Sotuvning ishlab chiqarishdan qarzi bo'ladi va to'lovlar bilan yopiladi.
--   Ishlab chiqarish foydasi = ichki narx − tannarx.

ALTER TABLE orders
  ADD COLUMN sale_price1 numeric(18,2) CHECK (sale_price1 >= 0),   -- Sotuv bo'limiga narx, 1 sort (1 dona)
  ADD COLUMN sale_price2 numeric(18,2) CHECK (sale_price2 >= 0);   -- 2 sort

CREATE TABLE sales_transfers (
  id            serial PRIMARY KEY,
  doc_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'accepted', 'rejected')),
  note          text,
  created_by    int REFERENCES users ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_date  date,
  reject_reason text,
  decided_by    int REFERENCES users ON DELETE SET NULL,
  decided_at    timestamptz
);
CREATE INDEX sales_transfers_status ON sales_transfers (status, doc_date);

CREATE TABLE sales_transfer_items (
  id            serial PRIMARY KEY,
  transfer_id   int NOT NULL REFERENCES sales_transfers ON DELETE CASCADE,
  order_id      int NOT NULL REFERENCES orders,
  color_id      int NOT NULL REFERENCES colors,
  size_id       int NOT NULL REFERENCES sizes,
  sort          smallint NOT NULL CHECK (sort IN (1, 2)),
  qty           int NOT NULL CHECK (qty > 0),
  price         numeric(18,2) NOT NULL CHECK (price >= 0),   -- ichki narx (yuborilgan paytdagi)
  unit_cost_uzs numeric(18,2) NOT NULL DEFAULT 0,            -- tannarx (skladdagi o'rtacha)
  UNIQUE (transfer_id, order_id, color_id, size_id, sort)
);

-- Tayyor mahsulot skladidan chiqim: o'tkazma yuborilganda; rad etilsa yoki o'chirilsa — qaytadi (qator o'chadi)
ALTER TABLE fg_moves DROP CONSTRAINT fg_moves_kind_check;
ALTER TABLE fg_moves
  ADD CONSTRAINT fg_moves_kind_check CHECK (kind IN ('otk', 'transfer')),
  ADD COLUMN transfer_id int REFERENCES sales_transfers ON DELETE CASCADE;
CREATE INDEX fg_moves_transfer ON fg_moves (transfer_id);

-- Sotuv bo'limining ishlab chiqarishga to'lovlari
CREATE TABLE sales_payments (
  id          serial PRIMARY KEY,
  pay_date    date NOT NULL,
  amount_uzs  numeric(18,2) NOT NULL CHECK (amount_uzs > 0),
  method      text NOT NULL CHECK (method IN ('naqd', 'plastik', 'bank')),
  note        text,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_payments_date ON sales_payments (pay_date);
