import pg from 'pg';
import { config } from '../config.js';

// NUMERIC aniqlik yo'qolmasligi uchun string bo'lib qoladi; faqat int8 (count, bigserial) songa o'giriladi.
pg.types.setTypeParser(20, (v) => Number(v));
// DATE ustunlari "2026-10-26" ko'rinishida (vaqt mintaqasi siljimasligi uchun)
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.appDatabaseUrl, max: 20 });

export type Db = pg.PoolClient;

/** Bitta tranzaksiya: xato bo'lsa hammasi bekor qilinadi. */
export async function tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Ilova jadval egasi (superuser) bilan ulanmaganini tekshiradi. */
export async function checkAppRole(): Promise<{ user: string; superuser: boolean }> {
  const { rows } = await pool.query(`SELECT current_user AS user, rolsuper AS su FROM pg_roles WHERE rolname = current_user`);
  return { user: rows[0].user, superuser: rows[0].su };
}
