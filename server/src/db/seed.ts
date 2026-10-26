/**
 * Boshlang'ich ma'lumot: birinchi admin (ADMIN_LOGIN / ADMIN_PASSWORD).
 * Admin bor bo'lsa hech narsa qilmaydi — har ishga tushishda xavfsiz chaqiriladi.
 * Birinchi kirishda admin parolni almashtiradi (boshlang'ich parol .env faylida qoladi).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { config } from '../config.js';

export async function seed({ log = console.log } = {}) {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    if ((await client.query(`SELECT 1 FROM users WHERE role = 'admin'`)).rowCount) return;
    const login = process.env.ADMIN_LOGIN ?? 'admin';
    const password = process.env.ADMIN_PASSWORD;
    if (!password || password.length < 8) throw new Error('ADMIN_PASSWORD (kamida 8 belgi) ni .env da bering');
    await client.query(
      `INSERT INTO users (login, password_hash, full_name, role, must_change_password) VALUES ($1, $2, 'Administrator', 'admin', true)`,
      [login, await bcrypt.hash(password, 10)],
    );
    log(`✓ Admin yaratildi: ${login}`);
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  seed().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
