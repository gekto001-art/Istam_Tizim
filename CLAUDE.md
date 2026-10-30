# Istam boshqaruv tizimi — Claude Code uchun yo'riqnoma

Istam — bolalar kiyimlari ishlab chiqaruvchi kompaniya. Hozir ish jarayoni Google Sheets fayllarida yuritiladi
(Zakaz&Tracking, Xomashyo Sklad, Kroy, Ishlab chiqarish Shim/Ko'ylak, Finmodel). Bu tizim ularni bosqichma-bosqich almashtiradi.

Ish jarayoni (bo'limlar tartibi):
innovatsion bo'lim (model, zakaz) → ta'minot (Xitoy/Turkiya xomashyo zakazi, tracking) → xomashyo skladi → bichuv (kroy)
→ tsex (shim, ko'ylak) → OTK → tayyor mahsulot skladi → sotuv (agentlar: Abu Saxiy, Safo, G'ulom) → kassa, oldi-berdi,
HR (ish hajmi bo'yicha nachisleniya) → P&L, Balans, Cash Flow, analitika.

## Stek
- server/: Node.js 22, TypeScript, Express 5, `pg` (ORM yo'q, toza SQL), Zod, JWT, vitest + supertest
- web/: React 19 + Vite + TypeScript, react-router, TanStack Query, oddiy CSS (`src/styles.css` tokenlari)
- PostgreSQL 16, migratsiyalar: `server/migrations/NNN_nomi.sql` (faqat yangi fayl qo'shiladi, eskisi o'zgartirilmaydi)
- backup/: zaxira skriptlari (POSIX sh, busybox bilan mos)
- Docker Compose: db + api + web (nginx) + backup

## Qat'iy qoidalar
1. Bitta kompaniya: ko'p tashkilotli qism (RLS) yo'q. Ilova jadval egasi bo'lmagan `istam_app` roli bilan ishlaydi.
2. Bir nechta yozuvli o'zgarishlar `tx(db => ...)` ichida (tranzaksiya).
3. Ruxsatlar `server/src/lib/permissions.ts` dagi jadval orqali (`requireAction`). Frontenddagi `can` (web/src/types.ts) shu bilan bir xil bo'lsin.
4. Har bir o'zgartirish `audit()` bilan yoziladi (eski va yangi qiymat).
5. Pul — `numeric(18,2)`, miqdor (metr, dona, kg) — `numeric(14,3)`, string sifatida qaytadi; JS da hisoblashda yaxlitlashga e'tibor.
6. Xatolar: `AppError` → `{code, message, details}`. Foydalanuvchiga ko'rinadigan matnlar **o'zbek tilida (lotin)**.
7. Har yangi funksiya uchun `server/test/` da test (haqiqiy PostgreSQL, `istam_test` bazasi), ruxsatlar testi bilan.
8. Yangi bo'lim tayyor bo'lgach `web/src/pages/Dashboard.tsx` dagi holat yangilanadi.

## Buyruqlar
```bash
cd server && npm run migrate && npm run seed && npm run dev   # API :4000 (ADMIN_LOGIN/ADMIN_PASSWORD .env da)
cd server && npm test                                         # testlar (istam_test bazasi)
cd web && npm run dev                                         # :5173 (/api -> :4000)
cd web && npm run build                                       # tsc + vite build
docker compose up -d --build                                  # serverda: hammasi birga (.env kerak)
```

## Bosqichlar
- [x] 0 — asos: kirish, rollar, foydalanuvchilar, audit, Docker, zaxira nusxa
- [x] 1 — innovatsion bo'lim: model va zakazni shakllantirish
- [x] 2 — zakaz & tracking (ta'minot)
- [x] 3 — xomashyo skladi, bichuv, tsex, OTK, tayyor mahsulot; Billz integratsiyasi
- [ ] 4 — sotuv va agentlar, kassa, oldi-berdi
  - Sotuv bo'limi — alohida biznes: ishlab chiqarishdan ichki narxda (zakazdagi 1 / 2 sort narxi) oladi,
    qabul qilingani ishlab chiqarishdan qarz bo'ladi; boshqa postavshiklardan ham tovar oladi;
    klientlarga Billz do'konlari va agentlar (ulgurji, nasiya) orqali sotadi.
  - [x] 4.1 — o'tkazma (qabul / rad etish), qarz va to'lovlar (`routes/sales.ts`)
  - [ ] 4.2 — Sotuv bo'limi skladi (bizdan + boshqa postavshiklardan), Billz bilan solishtirish
  - [ ] 4.3 — agentlar va ulgurji: mijozlar, nakladnoy, nasiya, vozvrat
  - [ ] 4.4 — ikki biznes foydasi alohida; kassa, oldi-berdi
- [ ] 5 — HR, P&L / Balans / Cash Flow, analitika
  - [x] 5.1 — HR (`routes/hr.ts`): xodimlar, tabel, ish nazorati (ishbay) va narxlar, oylik, bonus, to'lovlar, vedomost, akt sverka
- [ ] 6 — Google Sheets'dan ma'lumot ko'chirish
