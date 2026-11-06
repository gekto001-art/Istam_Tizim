-- 017: Agentlar va ulgurji savdo (4.3).
--   Agent (Abu Saxiy, Safo, G'ulom ...) — mijozlarga Sotuv bo'limi skladidan ulgurji sotadi; komissiya foizi.
--   Mijoz — agentga biriktirilgan; nasiya: qarz = sotuv − vozvrat − to'lov; kredit limiti (ixtiyoriy).
--   Nakladnoy: sotuv (skladdan chiqim) yoki vozvrat (skladga qaytadi); narx — ulgurji narx (tovarda), tannarx — o'rtacha.
--   Mijoz to'lovi hamyon tanlansa kassaga «Sotuvdan tushum» kirimi bo'lib yoziladi.

CREATE TABLE sales_agents (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  phone          text,
  commission_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct BETWEEN 0 AND 100),
  note           text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sales_agents_name ON sales_agents (lower(name));
INSERT INTO sales_agents (name) VALUES ('Abu Saxiy'), ('Safo'), ('G''ulom');

CREATE TABLE sales_clients (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  phone        text,
  address      text,
  agent_id     int REFERENCES sales_agents,
  credit_limit numeric(18,2) CHECK (credit_limit >= 0),   -- nasiya chegarasi; bo'sh — cheklanmagan
  note         text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sales_clients_name ON sales_clients (lower(name));

ALTER TABLE sales_products ADD COLUMN wholesale_price numeric(18,2) CHECK (wholesale_price >= 0);

CREATE TABLE sales_invoices (
  id         serial PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('sale', 'return')),
  doc_date   date NOT NULL,
  client_id  int NOT NULL REFERENCES sales_clients,
  agent_id   int REFERENCES sales_agents,
  due_date   date,                                   -- nasiya muddati
  note       text,
  created_by int REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_date IS NULL OR due_date >= doc_date)
);
CREATE INDEX sales_invoices_client ON sales_invoices (client_id, doc_date);
CREATE INDEX sales_invoices_agent ON sales_invoices (agent_id, doc_date);

ALTER TABLE sales_moves DROP CONSTRAINT sales_moves_kind_check;
ALTER TABLE sales_moves DROP CONSTRAINT sales_moves_check;
ALTER TABLE sales_moves
  ADD COLUMN invoice_id int REFERENCES sales_invoices ON DELETE CASCADE,
  ADD COLUMN price      numeric(18,2) CHECK (price >= 0),          -- sotuv / vozvrat narxi (1 dona)
  ADD CONSTRAINT sales_moves_kind_check CHECK (kind IN ('transfer', 'purchase', 'shop', 'shop_return', 'adjust', 'sale', 'return')),
  ADD CONSTRAINT sales_moves_ref_check CHECK (num_nonnulls(transfer_id, doc_id, invoice_id) = 1),
  ADD CONSTRAINT sales_moves_invoice_price_check CHECK ((invoice_id IS NULL) = (price IS NULL));
CREATE INDEX sales_moves_invoice ON sales_moves (invoice_id);

CREATE TABLE sales_client_payments (
  id          serial PRIMARY KEY,
  pay_date    date NOT NULL,
  client_id   int NOT NULL REFERENCES sales_clients,
  agent_id    int REFERENCES sales_agents,              -- kim yig'di
  amount_uzs  numeric(18,2) NOT NULL CHECK (amount_uzs > 0),
  method      text NOT NULL CHECK (method IN ('naqd', 'plastik', 'bank')),
  wallet_id   int REFERENCES cash_wallets,
  note        text,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_client_payments_client ON sales_client_payments (client_id, pay_date);

ALTER TABLE cash_entries DROP CONSTRAINT cash_entries_source_check;
ALTER TABLE cash_entries ADD CONSTRAINT cash_entries_source_check
  CHECK (source IN ('hr_payment', 'sales_payment', 'sales_supplier_payment', 'sales_client_payment'));
