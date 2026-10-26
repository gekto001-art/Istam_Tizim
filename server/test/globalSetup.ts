import pg from 'pg';

/** Har test yugurishida test bazasini noldan tayyorlaydi. */
export default async function setup() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  const { migrate } = await import('../src/db/migrate.js');
  const { seed } = await import('../src/db/seed.js');
  await migrate(() => {});
  await seed({ log: () => {} });
}
