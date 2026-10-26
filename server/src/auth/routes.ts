import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { AppError, badRequest } from '../lib/errors.js';
import { ROLE_LABELS, type Role } from '../lib/permissions.js';
import { ctxOf, requireAuth, signAccess } from './context.js';

export const authRouter = Router();

const COOKIE = 'istam_rt';
// Foydalanuvchi topilmaganda ham bcrypt ishlaydi — javob vaqti bo'yicha login borligini bilib bo'lmaydi
const DUMMY_HASH = bcrypt.hashSync('dummy-password-0', 10);
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// Oddiy login cheklovchi: 15 daqiqada IP+login bo'yicha 10 ta urinish
const attempts = new Map<string, { n: number; until: number }>();
function limit(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.until > now) {
    if (a.n >= 10) throw new AppError(429, 'TOO_MANY', 'Juda ko\'p urinish. 15 daqiqadan keyin qayta urinib ko\'ring');
    a.n++;
  } else attempts.set(key, { n: 1, until: now + 15 * 60_000 });
}

export const passwordSchema = z
  .string()
  .min(8, 'Parol kamida 8 belgi')
  .max(128)
  .regex(/[A-Za-z]/, 'Parolda harf bo\'lishi kerak')
  .regex(/[0-9]/, 'Parolda raqam bo\'lishi kerak');

async function issueTokens(res: Response, user: { id: number; role: Role }) {
  const raw = crypto.randomBytes(48).toString('base64url');
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [user.id, sha256(raw), config.refreshTtlDays],
  );
  res.cookie(COOKIE, raw, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: config.refreshTtlDays * 86400_000,
  });
  return signAccess({ sub: user.id, role: user.role });
}

async function profile(userId: number) {
  const u = (
    await pool.query('SELECT id, login, full_name, role, phone, must_change_password FROM users WHERE id = $1', [userId])
  ).rows[0];
  return { ...u, role_label: ROLE_LABELS[u.role as Role] };
}

authRouter.post('/login', async (req: Request, res: Response) => {
  const body = z.object({ login: z.string().trim().min(1).max(100), password: z.string().min(1).max(200) }).parse(req.body);
  const key = `${req.ip}|${body.login.toLowerCase()}`;
  limit(key);
  const user = (await pool.query('SELECT id, role, password_hash, is_active FROM users WHERE lower(login) = lower($1)', [body.login]))
    .rows[0];
  const ok = await bcrypt.compare(body.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || !user.is_active) throw new AppError(401, 'BAD_CREDENTIALS', 'Login yoki parol noto\'g\'ri');
  attempts.delete(key);
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const accessToken = await issueTokens(res, user);
  res.json({ accessToken, user: await profile(user.id) });
});

authRouter.post('/refresh', async (req: Request, res: Response) => {
  const raw = req.cookies?.[COOKIE];
  if (!raw) throw new AppError(401, 'UNAUTHORIZED', 'Tizimga kiring');
  const user = await tx(async (db) => {
    // Rotatsiya: eski token bekor qilinadi
    const t = (
      await db.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING user_id`,
        [sha256(raw)],
      )
    ).rows[0];
    if (!t) return null;
    return (await db.query('SELECT id, role FROM users WHERE id = $1 AND is_active', [t.user_id])).rows[0];
  });
  if (!user) {
    res.clearCookie(COOKIE, { path: '/api/auth' });
    throw new AppError(401, 'UNAUTHORIZED', 'Sessiya tugadi, qayta kiring');
  }
  const accessToken = await issueTokens(res, user);
  res.json({ accessToken, user: await profile(user.id) });
});

authRouter.post('/logout', async (req: Request, res: Response) => {
  const raw = req.cookies?.[COOKIE];
  if (raw) await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(raw)]);
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  res.json(await profile(ctxOf(req).userId));
});

authRouter.post('/password', requireAuth, async (req: Request, res: Response) => {
  const body = z.object({ current: z.string().min(1), next: passwordSchema }).parse(req.body);
  const ctx = ctxOf(req);
  await tx(async (db) => {
    const u = (await db.query('SELECT password_hash FROM users WHERE id = $1', [ctx.userId])).rows[0];
    if (!(await bcrypt.compare(body.current, u.password_hash))) throw badRequest('Joriy parol noto\'g\'ri');
    if (body.current === body.next) throw badRequest('Yangi parol eskisidan farq qilishi kerak');
    await db.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [
      await bcrypt.hash(body.next, 10),
      ctx.userId,
    ]);
    // Boshqa qurilmalardagi sessiyalar yopiladi
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [ctx.userId]);
  });
  res.json({ accessToken: await issueTokens(res, { id: ctx.userId, role: ctx.role }) });
});
