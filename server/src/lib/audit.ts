import type { RequestCtx } from '../auth/context.js';
import type { Db } from '../db/pool.js';

/** Har bir o'zgarish shu yerga yoziladi: kim, nima, eski va yangi qiymat. */
export async function audit(
  db: Db,
  ctx: RequestCtx,
  entity: string,
  entityId: string | number | null,
  action: string,
  oldData?: unknown,
  newData?: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (user_id, entity, entity_id, action, old_data, new_data) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ctx.userId,
      entity,
      entityId == null ? null : String(entityId),
      action,
      oldData === undefined ? null : JSON.stringify(oldData),
      newData === undefined ? null : JSON.stringify(newData),
    ],
  );
}
