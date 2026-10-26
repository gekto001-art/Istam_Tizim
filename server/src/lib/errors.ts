import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Yozuv') => new AppError(404, 'NOT_FOUND', `${what} topilmadi`);
export const forbidden = (msg = 'Bu amal uchun ruxsat yo\'q') => new AppError(403, 'FORBIDDEN', msg);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/** Yagona xato formati: { code, message, details } */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      code: 'VALIDATION',
      message: 'Ma\'lumotlar noto\'g\'ri',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  const pgErr = err as PgError;
  if (pgErr.code === '23505') {
    res.status(409).json({ code: 'CONFLICT', message: 'Bunday yozuv allaqachon mavjud', details: pgErr.constraint });
    return;
  }
  if (pgErr.code === '23503') {
    res.status(409).json({ code: 'REFERENCE', message: 'Bog\'liq yozuv topilmadi yoki ishlatilmoqda', details: pgErr.constraint });
    return;
  }
  if (pgErr.code === '23514' || pgErr.code === '22P02') {
    res.status(400).json({ code: 'VALIDATION', message: 'Qiymat noto\'g\'ri', details: pgErr.constraint });
    return;
  }
  if (pgErr.code === '42501') {
    // RLS siyosati yozishni rad etdi
    res.status(403).json({ code: 'FORBIDDEN', message: 'Bu ma\'lumotga ruxsat yo\'q' });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ code: 'BAD_JSON', message: 'JSON noto\'g\'ri' });
    return;
  }
  req.log?.error({ err }, 'Kutilmagan xato');
  res.status(500).json({ code: 'INTERNAL', message: 'Serverda xatolik' });
};
