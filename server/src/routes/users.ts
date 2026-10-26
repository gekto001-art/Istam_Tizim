import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ROLES } from '../lib/permissions.js';
import { idParam, optText, tempPassword } from '../lib/util.js';

/** Foydalanuvchilar va rollar (faqat admin). */
export const usersRouter = Router();
usersRouter.use(requireAction('users.manage'));

const SAFE_COLS = `id, login, full_name, role, phone, is_active, must_change_password, last_login_at, created_at`;

const userOf = async (db: Db, id: number) => (await db.query(`SELECT ${SAFE_COLS} FROM users WHERE id = $1`, [id])).rows[0];

usersRouter.get('/', async (_req, res) => {
  res.json(await tx(async (db) => (await db.query(`SELECT ${SAFE_COLS} FROM users ORDER BY full_name`)).rows));
});

const userBody = z.object({
  login: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'Login: lotin harflar, raqam, . _ -'),
  full_name: z.string().trim().min(2).max(200),
  role: z.enum(ROLES),
  phone: optText(40),
});

usersRouter.post('/', async (req, res) => {
  const body = userBody.parse(req.body);
  const ctx = ctxOf(req);
  const password = tempPassword();
  const user = await tx(async (db) => {
    const id = (
      await db.query(
        `INSERT INTO users (login, password_hash, full_name, role, phone, must_change_password)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [body.login, await bcrypt.hash(password, 10), body.full_name, body.role, body.phone],
      )
    ).rows[0].id;
    const u = await userOf(db, id);
    await audit(db, ctx, 'user', id, 'create', undefined, u);
    return u;
  });
  res.status(201).json({ user, temp_password: password });
});

usersRouter.patch('/:id', async (req, res) => {
  const id = idParam.parse(req.params.id);
  const body = userBody.omit({ login: true }).partial().extend({ is_active: z.boolean().optional() }).parse(req.body);
  const ctx = ctxOf(req);
  if (id === ctx.userId && (body.is_active === false || (body.role && body.role !== 'admin'))) {
    throw badRequest('O\'zingizni o\'chira olmaysiz yoki rolingizni pasaytira olmaysiz');
  }
  const user = await tx(async (db) => {
    const old = await userOf(db, id);
    if (!old) throw notFound('Foydalanuvchi');
    await db.query(
      `UPDATE users SET full_name = coalesce($2, full_name), role = coalesce($3, role), is_active = coalesce($4, is_active),
              phone = CASE WHEN $5::boolean THEN $6 ELSE phone END
        WHERE id = $1`,
      [id, body.full_name ?? null, body.role ?? null, body.is_active ?? null, body.phone !== undefined, body.phone ?? null],
    );
    if (body.is_active === false) {
      await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    const now = await userOf(db, id);
    await audit(db, ctx, 'user', id, 'update', old, now);
    return now;
  });
  res.json(user);
});

usersRouter.post('/:id/reset-password', async (req, res) => {
  const id = idParam.parse(req.params.id);
  const ctx = ctxOf(req);
  const password = tempPassword();
  await tx(async (db) => {
    const r = await db.query('UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1 RETURNING id', [
      id,
      await bcrypt.hash(password, 10),
    ]);
    if (!r.rowCount) throw notFound('Foydalanuvchi');
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await audit(db, ctx, 'user', id, 'reset_password');
  });
  res.json({ temp_password: password });
});
