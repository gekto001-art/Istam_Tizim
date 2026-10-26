# Istam boshqaruv tizimi

Istam bolalar kiyimlari ishlab chiqarishi uchun hisob tizimi. Stek: PostgreSQL, Node.js (Express, TypeScript), React.

Tizim hozirgi Google Sheets fayllarini bosqichma-bosqich almashtiradi. Butun jarayon qamrab olinadi: zakaz, xomashyo, kroy, tsex, OTK, tayyor mahsulot, sotuv, kassa va moliyaviy hisobotlar.

Holat: **0-bosqich** tugadi (asos). Bosqichlar ro'yxati `CLAUDE.md` da, tizim ichida esa **Dashboard** sahifasida.

## Serverga o'rnatish (Docker)

```bash
git clone https://github.com/gekto001-art/Istam_Tizim.git && cd Istam_Tizim
cp .env.example .env        # parollar, JWT_SECRET, BACKUP_ENCRYPTION_KEY ni albatta o'zgartiring
docker compose up -d --build
```

Tizim `http://SERVER:8080` da ochiladi, port `.env` dagi `WEB_PORT` bilan beriladi. Birinchi marta `.env` dagi `ADMIN_LOGIN` / `ADMIN_PASSWORD` bilan kiring. Keyin admin **Foydalanuvchilar** bo'limida xodimlarni qo'shadi:
- har xodimga rol beriladi (innovatsiya, ta'minot, sklad, bichuv, tsex, OTK, sotuv, kassir, buxgalter, HR, rahbar);
- vaqtinchalik parol bir marta ko'rsatiladi;
- xodim birinchi kirishda o'z parolini o'rnatadi.

**HTTPS:** tizim domen va HTTPS orqali ochilishi kerak, masalan oldiga Caddy yoki Nginx + Let's Encrypt qo'yiladi. Sessiya cookie'si faqat HTTPS da ishlaydi. Faqat HTTP bilan sinab ko'rish uchun `.env` da `COOKIE_SECURE=false` qiling.

**Yangilash:** `git pull && docker compose up -d --build` buyrug'i bilan. Baza migratsiyalari ishga tushishda avtomatik qo'llanadi.

## Zaxira nusxa

`backup` xizmati quyidagilarni avtomatik bajaradi:
- har kuni 03:00 da bazani nusxalaydi, tekshiradi va AES-256 bilan shifrlaydi;
- nusxa serverda 7 kun, S3 da 30 kun saqlanadi, oylik nusxa esa 12 oy;
- har oy nusxadan tiklashni sinab ko'radi;
- xato bo'lsa Telegram'ga xabar beradi.

`S3_*` va `BACKUP_ENCRYPTION_KEY` ni albatta sozlang. Kalitni va `.env` faylini server tashqarisida saqlang.

```bash
docker compose exec backup /scripts/backup.sh                              # hozir nusxa olish
docker compose exec backup /scripts/restore.sh list                        # nusxalar ro'yxati
docker compose exec backup /scripts/restore.sh latest --target istam_check # tekshirish uchun boshqa bazaga tiklash
```

## Lokal ishlab chiqish

Talablar: Node.js 22, PostgreSQL 16.

```bash
cd server && cp .env.example .env && npm install
npm run migrate && npm run seed && npm run dev     # API: http://localhost:4000
cd ../web && npm install && npm run dev            # http://localhost:5173
cd ../server && npm test                           # testlar (alohida istam_test bazasi)
```
