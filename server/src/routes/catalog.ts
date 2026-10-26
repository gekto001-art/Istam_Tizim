import { Router, type RequestHandler } from 'express';
import { z, type ZodObject, type ZodRawShape } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { buildUpdate, decimal, idParam, optText } from '../lib/util.js';

/** Ma'lumotnomalar: ro'yxatdan tanlanadi, shuning uchun bir xil nom har xil yozilmaydi. O'chirish o'rniga is_active=false. */
export const catalogRouter = Router();

interface Spec<S extends ZodRawShape> {
  path: string;
  table: string;
  entity: string;
  schema: ZodObject<S>;
  orderBy: string;
  /** Ro'yxat uchun SELECT (qo'shimcha ustunlar bilan); bo'lmasa SELECT * */
  select?: string;
}

function crud<S extends ZodRawShape>(spec: Spec<S>) {
  const cols = Object.keys(spec.schema.shape);
  const select = spec.select ?? `SELECT * FROM ${spec.table} t`;
  const one = async (db: Db, id: number) =>
    (await db.query(`${select} WHERE t.id = $1`, [id])).rows[0];

  const list: RequestHandler = async (req, res) => {
    const active = req.query.active === '1';
    res.json((await pool.query(`${select} ${active ? 'WHERE t.is_active' : ''} ORDER BY ${spec.orderBy}`)).rows);
  };
  const create: RequestHandler = async (req, res) => {
    const ctx = ctxOf(req);
    const body = spec.schema.parse(req.body) as Record<string, unknown>;
    const keys = cols.filter((k) => body[k] !== undefined);
    const row = await tx(async (db) => {
      const id = (
        await db.query(
          `INSERT INTO ${spec.table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          keys.map((k) => body[k]),
        )
      ).rows[0].id;
      const r = await one(db, id);
      await audit(db, ctx, spec.entity, id, 'create', undefined, r);
      return r;
    });
    res.status(201).json(row);
  };
  const update: RequestHandler = async (req, res) => {
    const ctx = ctxOf(req);
    const id = idParam.parse(req.params.id);
    const body = spec.schema.partial().parse(req.body) as Record<string, unknown>;
    const row = await tx(async (db) => {
      const old = await one(db, id);
      if (!old) throw notFound();
      const { sets, values } = buildUpdate(body, cols, 2);
      if (!sets.length) return old;
      await db.query(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = $1`, [id, ...values]);
      const r = await one(db, id);
      await audit(db, ctx, spec.entity, id, 'update', old, r);
      return r;
    });
    res.json(row);
  };
  catalogRouter.get(spec.path, list);
  catalogRouter.post(spec.path, requireAction('catalog.write'), create);
  catalogRouter.patch(`${spec.path}/:id`, requireAction('catalog.write'), update);
}

const name = (max = 100) => z.string().trim().min(1).max(max);
const active = z.boolean().optional();

crud({
  path: '/colors',
  table: 'colors',
  entity: 'color',
  orderBy: 'lower(t.name)',
  schema: z.object({ name: name(60), code: optText(30), is_active: active }),
});

crud({
  path: '/sizes',
  table: 'sizes',
  entity: 'size',
  orderBy: 't.sort, lower(t.name)',
  schema: z.object({ name: name(30), sort: z.coerce.number().int().min(0).max(100000).optional(), is_active: active }),
});

crud({
  path: '/product-types',
  table: 'product_types',
  entity: 'product_type',
  orderBy: 'lower(t.name)',
  schema: z.object({ name: name(), unit: z.string().trim().min(1).max(20).optional(), is_active: active }),
});

crud({
  path: '/suppliers',
  table: 'suppliers',
  entity: 'supplier',
  orderBy: 'lower(t.name)',
  schema: z.object({ name: name(200), country: optText(60), phone: optText(40), note: optText(500), is_active: active }),
});

crud({
  path: '/producers',
  table: 'producers',
  entity: 'producer',
  orderBy: 't.kind, lower(t.name)',
  schema: z.object({ name: name(200), kind: z.enum(['own', 'contractor']).optional(), note: optText(500), is_active: active }),
});

crud({
  path: '/materials',
  table: 'materials',
  entity: 'material',
  orderBy: 'lower(t.name), t.code',
  select: `SELECT t.*, s.name AS supplier_name FROM materials t LEFT JOIN suppliers s ON s.id = t.supplier_id`,
  schema: z.object({
    name: name(200),
    code: optText(60),
    unit: z.string().trim().min(1).max(20).optional(),
    supplier_id: idParam.nullish(),
    is_active: active,
  }),
});

// ---------- Valyuta kurslari ----------
export const CURRENCIES = ['UZS', 'USD', 'CNY', 'EUR', 'RUB'] as const;

catalogRouter.get('/currency-rates', async (_req, res) => {
  res.json(
    (
      await pool.query(
        `SELECT r.*, (r.valid_from = (SELECT max(valid_from) FROM currency_rates x WHERE x.currency = r.currency AND x.valid_from <= current_date)) AS is_current
           FROM currency_rates r ORDER BY r.valid_from DESC, r.currency`,
      )
    ).rows,
  );
});

catalogRouter.post('/currency-rates', requireAction('rates.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const body = z
    .object({ currency: z.enum(['USD', 'CNY', 'EUR', 'RUB']), rate: decimal.positive().max(1e9), valid_from: z.coerce.date() })
    .parse(req.body);
  const row = await tx(async (db) => {
    const r = (
      await db.query(
        `INSERT INTO currency_rates (currency, rate, valid_from) VALUES ($1, $2, $3::date)
         ON CONFLICT (currency, valid_from) DO UPDATE SET rate = EXCLUDED.rate RETURNING *`,
        [body.currency, body.rate, body.valid_from.toISOString().slice(0, 10)],
      )
    ).rows[0];
    await audit(db, ctx, 'currency_rate', r.id, 'set', undefined, r);
    return r;
  });
  res.status(201).json(row);
});
