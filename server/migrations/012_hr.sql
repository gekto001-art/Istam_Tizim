-- 012: HR — Sheets "HR Istam Ishlab chiqarish Ko'ylak / Shim" va "HR Istam yangi" (tabel) o'rniga:
--   bo'limlar (Ko'ylak Fabrika, Shim Fabrika ...), xodimlar (qabul / bo'shatish), oylik maosh tarixi;
--   tabel (kelgan / ketgan vaqt, javob so'ragan va qo'shimcha soat, kelmaganlar va sababi);
--   ish turlari va narxlari (sanadan amal qiladi), ish nazorati (ishbay: xodim × ish turi × soni);
--   bonus / ushlab qolish, to'lovlar (avans naqd, bank);
--   nachisleniya = tabel soati × soatlik stavka (oylik ÷ oylik ish soati) + ishbay (soni × o'sha sanadagi narx) + bonus − ushlab qolish.

CREATE TABLE hr_departments (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  producer_id int REFERENCES producers,        -- ishlab chiqarishdagi tsex (ish haqi tannarxi uchun)
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hr_departments_name_key ON hr_departments (lower(name));
INSERT INTO hr_departments (name, producer_id) VALUES
  ('Ko''ylak Fabrika', (SELECT id FROM producers WHERE name = '1-ISTAM KO''YLAK')),
  ('Shim Fabrika', (SELECT id FROM producers WHERE name = '2-ISTAM SHIM'));

CREATE TABLE employees (
  id            serial PRIMARY KEY,
  full_name     text NOT NULL,
  department_id int NOT NULL REFERENCES hr_departments,
  brigade       text,                            -- 1-Brigada ...
  position      text,                            -- lavozim: Tikuvchi, Dazmollovchi ...
  schedule      text,                            -- ish grafigi
  work_mode     text NOT NULL DEFAULT 'full' CHECK (work_mode IN ('full', 'part')),
  gender        text CHECK (gender IN ('erkak', 'ayol')),
  phone         text,
  hired_on      date NOT NULL,
  fired_on      date,
  fire_reason   text,
  note          text,
  created_by    int REFERENCES users ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (fired_on IS NULL OR fired_on >= hired_on)
);
CREATE INDEX employees_department ON employees (department_id, lower(full_name));
CREATE TRIGGER t_employees_upd BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Oylik maosh (sanadan amal qiladi); soatlik stavka = oylik ÷ oylik ish soati
CREATE TABLE employee_salaries (
  id          serial PRIMARY KEY,
  employee_id int NOT NULL REFERENCES employees ON DELETE CASCADE,
  valid_from  date NOT NULL,
  amount      numeric(18,2) NOT NULL CHECK (amount >= 0),
  norm_hours  numeric(6,2) NOT NULL DEFAULT 208 CHECK (norm_hours > 0),
  note        text,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, valid_from)
);

CREATE OR REPLACE FUNCTION hr_rate_at(p_employee int, p_date date) RETURNS numeric
  LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT amount / norm_hours FROM employee_salaries
                    WHERE employee_id = p_employee AND valid_from <= p_date ORDER BY valid_from DESC LIMIT 1), 0)
$$;

-- Tabel: kunlik davomat (bir xodim — bir kunda bitta yozuv)
CREATE TABLE hr_timesheet (
  id            serial PRIMARY KEY,
  work_date     date NOT NULL,
  employee_id   int NOT NULL REFERENCES employees,
  department_id int NOT NULL REFERENCES hr_departments,   -- qayerda ishlagan (qo'shimcha ishchi boshqa bo'limda bo'lishi mumkin)
  absent        boolean NOT NULL DEFAULT false,
  reason        text,                                     -- kelmagan sababi
  came_at       time,
  left_at       time,
  extra_hours   numeric(5,2) NOT NULL DEFAULT 0,          -- javob so'ragan (−) va qo'shimcha (+) soat
  hours         numeric(5,2) NOT NULL CHECK (hours >= 0 AND hours <= 24),
  note          text,
  created_by    int REFERENCES users ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date),
  CHECK (NOT absent OR hours = 0)
);
CREATE INDEX hr_timesheet_day ON hr_timesheet (work_date, department_id);

-- Ish turlari (operatsiyalar) va narxlari
CREATE TABLE hr_work_types (
  id            serial PRIMARY KEY,
  department_id int NOT NULL REFERENCES hr_departments,
  category      text NOT NULL,                            -- Zagatovka, Yarim tayyor, Tayyor mahsulot, Manjet ...
  name          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hr_work_types_name_key ON hr_work_types (department_id, lower(name));

CREATE TABLE hr_work_prices (
  id           serial PRIMARY KEY,
  work_type_id int NOT NULL REFERENCES hr_work_types ON DELETE CASCADE,
  valid_from   date NOT NULL,
  price        numeric(18,2) NOT NULL CHECK (price >= 0),
  created_by   int REFERENCES users ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_type_id, valid_from)
);

CREATE OR REPLACE FUNCTION hr_price_at(p_work_type int, p_date date) RETURNS numeric
  LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT price FROM hr_work_prices WHERE work_type_id = p_work_type AND valid_from <= p_date ORDER BY valid_from DESC LIMIT 1), 0)
$$;

-- Ish nazorati: ishbay bajarilgan ish (summa — o'sha sanadagi narx bo'yicha hisoblanadi)
CREATE TABLE hr_work_logs (
  id           serial PRIMARY KEY,
  work_date    date NOT NULL,
  employee_id  int NOT NULL REFERENCES employees,
  work_type_id int NOT NULL REFERENCES hr_work_types,
  qty          int NOT NULL CHECK (qty > 0),
  order_id     int REFERENCES orders,                     -- qaysi partiya (ixtiyoriy)
  note         text,
  created_by   int REFERENCES users ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hr_work_logs_date ON hr_work_logs (work_date, employee_id);

-- Bonus / ushlab qolish / boshqa hisoblash
CREATE TABLE hr_adjustments (
  id          serial PRIMARY KEY,
  adj_date    date NOT NULL,
  employee_id int NOT NULL REFERENCES employees,
  kind        text NOT NULL CHECK (kind IN ('bonus', 'penalty', 'other')),
  amount      numeric(18,2) NOT NULL CHECK (amount > 0),
  note        text,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hr_adjustments_date ON hr_adjustments (adj_date, employee_id);

-- Xodimga to'lovlar: avans (naqd, kassadan) va bank orqali
CREATE TABLE hr_payments (
  id          serial PRIMARY KEY,
  pay_date    date NOT NULL,
  employee_id int NOT NULL REFERENCES employees,
  method      text NOT NULL CHECK (method IN ('naqd', 'bank')),
  amount      numeric(18,2) NOT NULL CHECK (amount > 0),
  note        text,
  created_by  int REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hr_payments_date ON hr_payments (pay_date, employee_id);
