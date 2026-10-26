import 'dotenv/config';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Muhit o'zgaruvchisi topilmadi: ${name}`);
  return v;
}

const env = process.env.NODE_ENV ?? 'development';

export const config = {
  env,
  isProd: env === 'production',
  port: Number(process.env.PORT ?? 4000),
  // Migratsiyalar uchun (jadval egasi)
  databaseUrl: req('DATABASE_URL'),
  // Ilova ishlaydigan foydalanuvchi: jadval egasi ham, superuser ham emas (faqat ma'lumot o'qish/yozish huquqi)
  appDatabaseUrl: process.env.APP_DATABASE_URL || req('DATABASE_URL'),
  appDbUser: process.env.APP_DB_USER ?? 'istam_app',
  appDbPassword: process.env.APP_DB_PASSWORD ?? '',
  jwtSecret: req('JWT_SECRET', env === 'production' ? undefined : 'dev-secret-change-me'),
  accessTtlSec: Number(process.env.ACCESS_TTL_SEC ?? 15 * 60),
  refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS ?? 7),
  // HTTPS orqali ishlaganda true. Faqat HTTP bilan sinov uchun COOKIE_SECURE=false
  cookieSecure: (process.env.COOKIE_SECURE ?? (env === 'production' ? 'true' : 'false')) === 'true',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  logLevel: process.env.LOG_LEVEL ?? (env === 'test' ? 'silent' : 'info'),
};

if (config.isProd && config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET kamida 32 belgidan iborat bo\'lishi kerak');
}
