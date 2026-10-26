import { Router } from 'express';
import { z } from 'zod';
import { requireAction } from '../auth/context.js';
import { pool } from '../db/pool.js';

export const auditRouter = Router();

auditRouter.get('/', requireAction('audit.read'), async (req, res) => {
  const q = z
    .object({
      entity: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      before: z.coerce.number().int().positive().optional(),
    })
    .parse(req.query);
  const rows = (
    await pool.query(
      `SELECT a.*, u.full_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE ($1::text IS NULL OR a.entity = $1) AND ($2::bigint IS NULL OR a.id < $2)
        ORDER BY a.id DESC LIMIT $3`,
      [q.entity ?? null, q.before ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});
