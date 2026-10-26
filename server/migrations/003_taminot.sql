-- 003: Ta'minot — xomashyo zakazi va postavshik kelishuvi (Google Sheets "Zakaz&Tracking": Xomashyo Zakaz, Postavshik Kelishuv).
-- Tartib: avval asosiy mato zakaz qilinadi → postavshik nakladnoyi (fakt metr) tasdiqlanadi →
-- har rang bo'yicha mahsulot soni qayta hisoblanadi (fakt ÷ sarf, yuqoriga) → furnitura shu songa qarab zakaz qilinadi.

-- Asosiy mato: mahsulot soni shu qatorning fakt miqdoriga qarab o'zgaradi. Har rangda ko'pi bilan bitta.
ALTER TABLE order_materials ADD COLUMN is_main boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX order_materials_one_main ON order_materials (order_id, color_id) WHERE is_main;

-- Fakt mato kelgandan keyingi son (razmerlarga proporsional bo'lingan). NULL — hali aniqlanmagan.
ALTER TABLE order_items ADD COLUMN actual_qty int CHECK (actual_qty >= 0);

-- Postavshikka buyurtma ("Buyurtma ID"). stage: mato yoki furnitura.
CREATE TABLE purchase_orders (
  id              serial PRIMARY KEY,
  order_id        int NOT NULL REFERENCES orders,
  supplier_id     int NOT NULL REFERENCES suppliers,
  stage           text NOT NULL CHECK (stage IN ('mato','furnitura')),
  po_date         date NOT NULL DEFAULT current_date,
  -- negotiation: kelishuv (nakladnoy kutilmoqda); rejected: rad etildi; preparing: tayyorlanmoqda (kelishilgan);
  -- in_transit: yo'lda; arrived: yetib keldi; closed: yopildi; cancelled: bekor qilindi
  status          text NOT NULL DEFAULT 'negotiation'
                  CHECK (status IN ('negotiation','rejected','preparing','in_transit','arrived','closed','cancelled')),
  payment_status  text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','advance','partial','paid')),
  eta             date,
  tracking        text,
  arrived_date    date,
  manager         text,
  note            text,
  reject_reason   text,
  agreed_by       int REFERENCES users ON DELETE SET NULL,
  agreed_at       timestamptz,
  created_by      int REFERENCES users ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_orders_order ON purchase_orders (order_id, stage);
CREATE INDEX purchase_orders_status ON purchase_orders (status, po_date DESC);
CREATE TRIGGER t_po_upd BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Buyurtma qatorlari: reja (zakazdan) va fakt (postavshik nakladnoyi)
CREATE TABLE purchase_order_lines (
  id                serial PRIMARY KEY,
  po_id             int NOT NULL REFERENCES purchase_orders ON DELETE CASCADE,
  material_id       int NOT NULL REFERENCES materials,
  material_color_id int REFERENCES colors,
  color_code        text,
  material_size     text,
  plan_qty          numeric(14,3) NOT NULL CHECK (plan_qty > 0),
  price             numeric(18,4) NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency          text NOT NULL DEFAULT 'UZS' CHECK (currency IN ('UZS','USD','CNY','EUR','RUB')),
  rate              numeric(14,4) NOT NULL DEFAULT 1 CHECK (rate > 0),
  fact_qty          numeric(14,3) CHECK (fact_qty >= 0),
  fact_price        numeric(18,4) CHECK (fact_price >= 0),
  note              text
);
CREATE INDEX purchase_order_lines_po ON purchase_order_lines (po_id, id);

-- Qator qaysi zakaz normasidan (rang) kelgani: fakt miqdor ranglarga reja ulushi bo'yicha taqsimlanadi
CREATE TABLE purchase_line_sources (
  line_id            int NOT NULL REFERENCES purchase_order_lines ON DELETE CASCADE,
  order_material_id  int NOT NULL REFERENCES order_materials,
  plan_qty           numeric(14,3) NOT NULL CHECK (plan_qty > 0),
  PRIMARY KEY (line_id, order_material_id)
);
CREATE INDEX purchase_line_sources_om ON purchase_line_sources (order_material_id);
