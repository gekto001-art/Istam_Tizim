-- 013: Kassa — Sheets "Kassa ISTAM Moliya bo'limi" o'rniga:
--   hamyonlar (kassa, karta, bank hisob, avans-hisobot) — har birida bir nechta valyuta;
--   tranzaksiya turlari, markazlar (PC — daromad, CC — xarajat, IC — investitsiya), xarajat elementlari (kod, guruh);
--   kassa yozuvlari: kirim / chiqim, kontragent, bo'lim, ma'sul shaxs, kurs, oy, partiya;
--   ichki transfer va valyuta ayriboshlash — ikki yozuv (chiqim + kirim) bitta juftlikda;
--   avans-hisobot: avans hamyoniga ma'sul shaxs nomiga o'tkaziladi, u shu hamyondan xarajat qiladi (hisobot beradi).

CREATE TABLE cash_wallets (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  business    text NOT NULL DEFAULT 'moliya' CHECK (business IN ('moliya', 'tijorat', 'ishlab')),
  kind        text NOT NULL DEFAULT 'naqd' CHECK (kind IN ('naqd', 'karta', 'bank', 'avans', 'boshqa')),
  is_active   boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cash_wallets_name_key ON cash_wallets (lower(name));
INSERT INTO cash_wallets (name, kind, sort) VALUES
  ('MB Umumiy Kassa', 'naqd', 1), ('MB Rezerv Kassa', 'naqd', 2), ('MB ALIPAY', 'boshqa', 3), ('Avans-hisobot tizimi', 'avans', 4),
  ('MB UZCARD_7946_KOMRON', 'karta', 10), ('MB HUMO_8018_SAFO', 'karta', 11), ('MB UZCARD_4495_DT_FM', 'karta', 12), ('MB UZCARD_5478_DT_AN', 'karta', 13),
  ('MB UZCARD_2884_DT_ST', 'karta', 14), ('MB UZCARD_5178_DT_SG', 'karta', 15), ('MB UZCARD_7838_DT_GULOM', 'karta', 16), ('MB UZCARD_6646_ERKIN', 'karta', 17),
  ('MB UZCARD_0000_MIRZO', 'karta', 18), ('MB UZCARD_6350_MIRZO', 'karta', 19), ('MB UZCARD_0000_ISTAM', 'karta', 20), ('MB VISA_4085_LAZIZ', 'karta', 21),
  ('MB VISA_0000_ISTAM', 'karta', 22),
  ('202080009_001_BANK ASOSIY UZS', 'bank', 30), ('231060006_003_BANK MAOSH', 'bank', 31), ('226130008_001_BANK KONVERTATSIYA UZS', 'bank', 32),
  ('226148409_002_BANK KONVERTATSIYA USD', 'bank', 33), ('235100007_001_BANK TERMINAL', 'bank', 34), ('226141561_001_BANK_KONVERTATSIYA YUAN', 'bank', 35);

-- Tranzaksiya turlari: flow — faqat kirim / faqat chiqim / ikkalasi; special — maxsus ishlov
CREATE TABLE cash_op_types (
  id        serial PRIMARY KEY,
  name      text NOT NULL UNIQUE,
  flow      text NOT NULL CHECK (flow IN ('in', 'out', 'both')),
  special   text CHECK (special IN ('opening', 'transfer', 'exchange', 'expense')),
  sort      int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);
INSERT INTO cash_op_types (name, flow, special, sort) VALUES
  ('Kun boshiga qoldiq', 'in', 'opening', 1),
  ('Sotuvdan tushum', 'in', NULL, 2),
  ('Boshqa tushumlar', 'in', NULL, 3),
  ('Xarajatlar', 'out', 'expense', 4),
  ('Boshqa xarajatlar', 'out', NULL, 5),
  ('Ichki transfer', 'out', 'transfer', 6),
  ('Avans-hisobot tizimi', 'out', 'transfer', 7),
  ('Valyuta ayriboshlash', 'out', 'exchange', 8),
  ('Investitsiya', 'in', NULL, 10),
  ('Investitsiya qaytarilishi', 'out', NULL, 11),
  ('Reinvestitsiya', 'both', NULL, 12),
  ('Dividend', 'out', NULL, 13),
  ('Moliyaviy yordam', 'both', NULL, 14),
  ('Moliyaviy yordam qaytarilishi', 'both', NULL, 15),
  ('Kredit', 'in', NULL, 16),
  ('Kredit qaytarilishi', 'out', NULL, 17),
  ('Qarz olindi', 'in', NULL, 18),
  ('Olingan qarz qaytarildi', 'out', NULL, 19),
  ('Qarz berildi', 'out', NULL, 20),
  ('Berilgan qarz qaytarildi', 'in', NULL, 21),
  ('Asosiy vositalar', 'out', NULL, 22),
  ('Ustav', 'in', NULL, 23),
  ('Tranzit hisob', 'both', NULL, 24),
  ('Shubhali hisob', 'both', NULL, 25),
  ('Tikuv xizmati', 'both', NULL, 26);

-- Markazlar: PC — daromad, CC — xarajat, IC — investitsiya
CREATE TABLE cash_centers (
  id        serial PRIMARY KEY,
  kind      text NOT NULL CHECK (kind IN ('PC', 'CC', 'IC')),
  name      text NOT NULL UNIQUE,
  code      text,
  is_active boolean NOT NULL DEFAULT true
);
INSERT INTO cash_centers (kind, name, code) VALUES
  ('PC', 'Asosiy faoliyatdan daromad', 'IGSL-PCREV01'), ('PC', 'Boshqa daromadlar', 'IGSL-PCOTI01'),
  ('CC', 'Tovarlar tannarxi (ishlab chiqarish)', 'IGSL-CCCOS01'), ('CC', 'Sotish va yetkazib berish', 'IGSL-CCDSC01'),
  ('CC', 'Administratsiya', 'IGSL-CCADM01'), ('CC', 'Marketing', 'IGSL-CCMKT01'), ('CC', 'Boshqa xarajatlar', 'IGSL-CCOTE01'),
  ('IC', 'Loyiha investitsiyalari', 'IGSL-ICOPI01'), ('IC', 'Ekspluatatsiyadagi asosiy vositalar', 'IGSL-ICNCA01'),
  ('IC', 'Tugallanmagan asosiy vositalar', 'IGSL-ICAUC01');

-- Xarajat elementlari: kod (1001...) va guruh (1000 Ijara, 2000 Kommunal ...)
CREATE TABLE cash_items (
  id        serial PRIMARY KEY,
  code      int NOT NULL UNIQUE,
  name      text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE cash_item_groups (code int PRIMARY KEY, name text NOT NULL);
INSERT INTO cash_item_groups (code, name) VALUES
  (1000, 'Ijara'), (2000, 'Kommunal'), (3000, 'Ishchilar'), (4000, 'Materiallar va postavshiklar'), (5000, 'Logistika'),
  (6000, 'Reklama va marketing'), (7000, 'Soliqlar va moliyaviy'), (8000, 'Xizmatlar va ma''muriy'), (9000, 'Vositalar');
INSERT INTO cash_items (code, name) VALUES
  (1001, 'Ofis ijara to''lovi'), (1002, 'Turar joy ijarasi'), (1003, 'Jihozlar, mashinalar va uskunalar ijarasi'), (1004, 'Ijara bilan bog''liq boshqa xarajatlar'),
  (2001, 'Gaz'), (2002, 'Elektr energiyasi'), (2003, 'Ichimlik suvi'), (2004, 'Chiqindilarni olib chiqish'), (2005, 'Boshqa kommunal xarajatlari'),
  (3001, 'Ish haqi va maoshlar - doimiy'), (3002, 'JSH lardan olinadigan daromad solig''i'), (3003, 'Ish haqi va maoshlar bo''yicha ijtimoiy to''lovlar'),
  (3004, 'Ovqatlanish xarajatlari'), (3005, 'Safar xarajatlari - mahalliy'), (3006, 'Safar xarajatlari - xorijiy'), (3007, 'Mehnat ta''tili (otpusk, bolnichniy)'),
  (3008, 'Sovg''alar va boshqa mukofotlar'), (3009, 'Komissiya (savdo agentlari uchun)'), (3010, 'Bonuslar'), (3011, 'Xodimlar bilan bog''liq boshqa xarajatlar'),
  (4001, 'Qadoqlash materiallari'), (4002, 'Furnitura'), (4003, 'Klevoy'), (4004, 'Astar'), (4005, 'Mato'), (4006, 'Kardigan - tugmali'), (4007, 'Kardigan - zamok'),
  (4008, 'Bezrukavka - tugmasiz'), (4009, 'Bezrukavka - tugmali'), (4010, 'Shim - jinsi'), (4011, 'Shim - klassik'), (4012, 'Ko''ylak - oq'),
  (4013, 'Ko''ylak - odnotonnaya'), (4014, 'Ko''ylak - polosatiy'), (4015, 'Ko''ylak - pechat'), (4016, 'Ehtiyot qismlar'),
  (4017, 'Ta''mirlash va texnik xizmat ko''rsatish uchun materiallar'), (4018, 'Jihozlar va uskunalar ta''mirlash va texnik xizmat ko''rsatish'),
  (4019, 'Kam qiymatli inventar - asosiy faoliyat'), (4020, 'Boshqa materiallar va xizmatlar'),
  (5001, 'Logistika va tashish - mahalliy'), (5002, 'Logistika va tashish - xalqaro'), (5003, 'Taksi va yetkazib berish xizmati'), (5004, 'Bojxona bojlari'),
  (5005, 'Sertifikatlash'), (5006, 'Boshqa logistika va bojxona xarajatlari'),
  (6001, 'Reklama - onlayn'), (6002, 'Reklama - offlayn'), (6003, 'Reklama materiallari'), (6004, 'Promo qadoqlash materiallari'), (6005, 'Promo uniformalar'),
  (6006, 'Chegirmalar'), (6007, 'Boshqa marketing xarajatlari'),
  (7001, 'Bank va o''tkazmalardan komissiya'), (7002, 'Foyda solig''i'), (7003, 'Boshqa soliqlar'), (7004, 'Jarimalar'), (7005, 'Foizlarni qaytarish'),
  (7006, 'Boshqa moliyaviy xarajatlar'),
  (8001, 'Kam qiymatli inventar - ofis'), (8002, 'Ofis uchun kanstovar'), (8003, 'Trening, malaka oshirish'), (8004, 'Professional xizmatlar'),
  (8005, 'Tozalash xizmatlari'), (8006, 'Aloqa xizmatlari'), (8007, 'Xavfsizlik xizmatlari'), (8008, 'Vakillik xarajatlari'), (8009, 'Homiylik'),
  (8010, 'Dasturiy ta''minot va texnik yordam'), (8011, 'Boshqa ma''muriy xarajatlar'),
  (9001, 'Amortizatsiya');

CREATE TABLE cash_entries (
  id            serial PRIMARY KEY,
  entry_date    date NOT NULL,
  wallet_id     int NOT NULL REFERENCES cash_wallets,
  op_type_id    int NOT NULL REFERENCES cash_op_types,
  center_id     int REFERENCES cash_centers,
  item_id       int REFERENCES cash_items,
  counterparty  text,                        -- kontragent
  department    text,                        -- bo'lim: MB, TB, FTB, IB ...
  responsible   text,                        -- ma'sul shaxs (avans-hisobotda — kimning nomiga)
  note          text,                        -- detal / izoh
  currency      text NOT NULL CHECK (currency IN ('UZS', 'USD', 'CNY', 'EUR', 'RUB')),
  rate          numeric(14,4) NOT NULL CHECK (rate > 0),   -- so'mga kurs
  amount_in     numeric(18,2) NOT NULL DEFAULT 0 CHECK (amount_in >= 0),
  amount_out    numeric(18,2) NOT NULL DEFAULT 0 CHECK (amount_out >= 0),
  period        date,                        -- qaysi oy uchun (oyning 1-kuni)
  order_id      int REFERENCES orders,       -- partiya (ishlab chiqarish xarajati)
  pair_id       int,                         -- transfer / ayriboshlash: juftlikdagi birinchi yozuv id si
  created_by    int REFERENCES users ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((amount_in > 0) <> (amount_out > 0))
);
CREATE INDEX cash_entries_date ON cash_entries (entry_date, id);
CREATE INDEX cash_entries_wallet ON cash_entries (wallet_id, currency, entry_date);
CREATE INDEX cash_entries_pair ON cash_entries (pair_id);
