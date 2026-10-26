-- 001: asos — foydalanuvchilar, rollar, sessiyalar, audit.
-- Istam bitta kompaniya: ko'p tashkilotli (RLS) qism yo'q. Ilova baribir jadval egasi bo'lmagan alohida rol bilan ishlaydi.

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Rollar bo'limlarga mos (taqdimotdagi biznes jarayon):
--   admin — hammasi; rahbar — barcha bo'limlarni ko'radi;
--   innovatsiya — model va zakaz shakllantirish; taminot — xomashyo zakazi va tracking;
--   sklad, bichuv, tsex, otk — ishlab chiqarish zanjiri; sotuv — tayyor mahsulot va agentlar;
--   kassir — pul oqimlari; buxgalter — oldi-berdi va hisobotlar; hr — xodimlar va ish haqi.
CREATE TABLE users (
  id                    serial PRIMARY KEY,
  login                 text NOT NULL,
  password_hash         text NOT NULL,
  full_name             text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('admin','rahbar','innovatsiya','taminot','sklad','bichuv','tsex','otk','sotuv','kassir','buxgalter','hr')),
  phone                 text,
  is_active             boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT true,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_login_key ON users (lower(login));
CREATE TRIGGER t_users_upd BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE refresh_tokens (
  id          bigserial PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);

-- Har bir o'zgarish: kim, qachon, nimani, eski va yangi qiymat
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  user_id     int REFERENCES users ON DELETE SET NULL,
  entity      text NOT NULL,
  entity_id   text,
  action      text NOT NULL,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_time ON audit_log (created_at DESC);
CREATE INDEX audit_log_entity ON audit_log (entity, entity_id);
