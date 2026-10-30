import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { AppError, forbidden } from '../lib/errors.js';
import { can, type Action, type Role } from '../lib/permissions.js';

export interface RequestCtx {
  userId: number;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: RequestCtx;
    }
  }
}

export interface AccessPayload {
  sub: number;
  role: Role;
}

export function signAccess(p: AccessPayload): string {
  return jwt.sign(p, config.jwtSecret, { expiresIn: config.accessTtlSec, algorithm: 'HS256' });
}

/** Bearer tokenni tekshiradi; rol va faollik har so'rovda bazadan olinadi (o'chirilgan foydalanuvchi darhol chiqadi). */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHORIZED', 'Tizimga kiring');
  let payload: AccessPayload;
  try {
    payload = jwt.verify(h.slice(7), config.jwtSecret, { algorithms: ['HS256'] }) as unknown as AccessPayload;
  } catch {
    throw new AppError(401, 'TOKEN_EXPIRED', 'Sessiya muddati tugadi');
  }
  const u = (await pool.query('SELECT id, role, is_active FROM users WHERE id = $1', [payload.sub])).rows[0];
  if (!u || !u.is_active) throw new AppError(401, 'UNAUTHORIZED', 'Foydalanuvchi faol emas');
  req.ctx = { userId: u.id, role: u.role };
  next();
}

export function ctxOf(req: Request): RequestCtx {
  if (!req.ctx) throw new AppError(401, 'UNAUTHORIZED', 'Tizimga kiring');
  return req.ctx;
}

export const requireAction = (action: Action) => (req: Request, _res: Response, next: NextFunction) => {
  if (!can(ctxOf(req).role, action)) throw forbidden();
  next();
};

/** Berilgan amallardan kamida bittasiga ruxsat bo'lsa o'tkazadi */
export const requireAnyAction = (...actions: Action[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!actions.some((a) => can(ctxOf(req).role, a))) throw forbidden();
  next();
};
