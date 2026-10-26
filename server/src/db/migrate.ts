import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/db -> ../../migrations, dist/db -> ../../migrations
const MIGRATIONS_DIR = path.resolve(here, '../../migrations');

export async function migrate(log: (m: string) => void = console.log): Promise<void> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Bir vaqtda ikki nusxa migratsiya qilmasligi uchun
    await client.query('SELECT pg_advisory_lock(727101)');
    const done = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string),
    );
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`✓ ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migratsiya ${f} xato: ${(e as Error).message}`);
      }
    }
    await ensureAppRole(client, log);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727101)').catch(() => {});
    await client.end();
  }
}

/** Ilova uchun superuser bo'lmagan rol yaratadi: jadval tuzilmasini o'zgartira olmaydi, faqat ma'lumot bilan ishlaydi. */
async function ensureAppRole(client: pg.Client, log: (m: string) => void) {
  const user = config.appDbUser;
  if (!config.appDbPassword) {
    log('APP_DB_PASSWORD berilmagan — ilova roli yaratilmadi (APP_DATABASE_URL ni o\'zingiz sozlang).');
    return;
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(user)) throw new Error('APP_DB_USER noto\'g\'ri');
  const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user])).rowCount;
  const pw = client.escapeLiteral(config.appDbPassword);
  if (!exists) {
    await client.query(`CREATE ROLE ${user} LOGIN PASSWORD ${pw} NOSUPERUSER NOBYPASSRLS`);
    log(`✓ ${user} roli yaratildi`);
  } else {
    await client.query(`ALTER ROLE ${user} LOGIN PASSWORD ${pw} NOSUPERUSER NOBYPASSRLS`);
  }
  const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
  await client.query(`GRANT CONNECT ON DATABASE "${db}" TO ${user}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${user}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${user}`);
  await client.query(`REVOKE ALL ON schema_migrations FROM ${user}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${user}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${user}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  migrate().then(
    () => console.log('Migratsiyalar tugadi'),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
