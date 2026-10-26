-- 005: ta'minot Sheets "Zakaz&Tracking"dagidek qator darajasida:
--   har qatorning o'z buyurtma statusi, to'lov statusi, ETA, tracking, yetib kelish kuni, menejeri va kelishuvi bor;
--   "Status o'zgartirish": yo'lga chiqqan miqdorlar jurnali (qisman yo'lga chiqish, qoldiq).
-- purchase_orders endi faqat guruh (partiya × postavshik × bosqich); holat qatorlarda.

ALTER TABLE purchase_order_lines
  ADD COLUMN status         text NOT NULL DEFAULT 'negotiation'
                            CHECK (status IN ('negotiation','rejected','preparing','in_transit','arrived','closed','cancelled')),
  ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','advance','partial','paid')),
  ADD COLUMN eta            date,
  ADD COLUMN tracking       text,
  ADD COLUMN arrived_date   date,
  ADD COLUMN manager        text,
  ADD COLUMN reject_reason  text,
  ADD COLUMN agreed_by      int REFERENCES users ON DELETE SET NULL,
  ADD COLUMN agreed_at      timestamptz,
  ADD COLUMN created_at     timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now();

-- mavjud buyurtmalarning holati qatorlariga ko'chiriladi
UPDATE purchase_order_lines l
   SET status = p.status, payment_status = p.payment_status, eta = p.eta, tracking = p.tracking, arrived_date = p.arrived_date,
       manager = p.manager, reject_reason = p.reject_reason, agreed_by = p.agreed_by, agreed_at = p.agreed_at, created_at = p.created_at
  FROM purchase_orders p WHERE p.id = l.po_id;

ALTER TABLE purchase_orders
  DROP COLUMN status, DROP COLUMN payment_status, DROP COLUMN eta, DROP COLUMN tracking, DROP COLUMN arrived_date,
  DROP COLUMN manager, DROP COLUMN reject_reason, DROP COLUMN agreed_by, DROP COLUMN agreed_at;

CREATE INDEX purchase_order_lines_status ON purchase_order_lines (status);
CREATE TRIGGER t_pol_upd BEFORE UPDATE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Yo'lga chiqqan miqdorlar (Sheets "Yo'lga chiqqan buyurtmalar")
CREATE TABLE purchase_shipments (
  id          serial PRIMARY KEY,
  line_id     int NOT NULL REFERENCES purchase_order_lines ON DELETE CASCADE,
  ship_date   date NOT NULL,
  qty         numeric(14,3) NOT NULL CHECK (qty > 0),
  note        text,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_shipments_line ON purchase_shipments (line_id, ship_date);
