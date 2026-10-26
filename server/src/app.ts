import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { requireAuth } from './auth/context.js';
import { authRouter } from './auth/routes.js';
import { pool } from './db/pool.js';
import { AppError, errorHandler } from './lib/errors.js';
import { auditRouter } from './routes/audit.js';
import { usersRouter } from './routes/users.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }));

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  const api = Router();
  api.use('/auth', authRouter);
  api.use('/users', requireAuth, usersRouter);
  api.use('/audit', requireAuth, auditRouter);
  app.use('/api', api);

  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Bunday API yo\'q')));
  app.use(errorHandler);
  return app;
}
