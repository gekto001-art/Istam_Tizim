import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction, requireAnyAction } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, optText } from '../lib/util.js';

/**
 * HR — Sheets "HR Istam Ishlab chiqarish Ko'ylak / Shim" va "HR Istam yangi" (tabel) o'rniga.
 *  - bo'limlar, xodimlar (qabul / bo'shatish), oylik maosh tarixi (sanadan amal qiladi);
 *  - tabel: kelgan / ketgan vaqt, javob so'ragan (−) va qo'shimcha (+) soat, kelmaganlar va sababi;
 *  - ish turlari va narxlari (sanadan amal qiladi), ish nazorati (ishbay);
 *  - bonus / ushlab qolish, to'lovlar (avans naqd, bank), vedomost va xodim kartochkasi (akt sverka).
 * Nachisleniya = tabel soati × (oylik ÷ oylik ish soati) + ishbay soni × o'sha sanadagi narx + bonus + boshqa − ushlab qolish.
 * Summalar saqlanmaydi — har safar narx / maosh tarixidan hisoblanadi (narx orqaga sanadan o'zgarsa, shu sanadan keyingilar qayta hisoblanadi).
 */
export const hrRouter = Router();
hrRouter.use(requireAnyAction('hr.read', 'hr.work'));

const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));
const money = z.coerce.number().finite().min(0).max(1e12);
const time = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Vaqt SS:DD ko\'rinishida')
  .transform((s) => s.slice(0, 5).padStart(5, '0'));
const LUNCH_AFTER = 6; // smena 6 soatdan uzun bo'lsa — 1 soat tushlik ayriladi (8:00–17:00 → 8 soat)
const r2 = (v: number) => Math.round(v * 100) / 100;

const employed = (alias: string, d: string) => `${alias}.hired_on <= ${d} AND (${alias}.fired_on IS NULL OR ${alias}.fired_on >= ${d})`;

async function employeeOf(db: Db | typeof pool, id: number, lock = false) {
  const e = (await db.query(`SELECT * FROM employees WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!e) throw notFound('Xodim');
  return e;
}

// ---------- Bo'limlar ----------
hrRouter.get('/departments', async (_req, res) => {
  res.json(
    (
      await pool.query(
        `SELECT d.*, p.name AS producer_name,
                (SELECT count(*)::int FROM employees e WHERE e.department_id = d.id AND e.fired_on IS NULL) AS employees
           FROM hr_departments d LEFT JOIN producers p ON p.id = d.producer_id ORDER BY d.is_active DESC, lower(d.name)`,
      )
    ).rows,
  );
});

const deptBody = z.object({ name: z.string().trim().min(1).max(100), producer_id: idParam.nullish(), is_active: z.boolean().optional() });

hrRouter.post('/departments', requireAction('hr.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = deptBody.parse(req.body);
  const row = await tx(async (db) => {
    const d = (await db.query('INSERT INTO hr_departments (name, producer_id) VALUES ($1, $2) RETURNING *', [b.name, b.producer_id ?? null])).rows[0];
    await audit(db, ctx, 'hr_department', d.id, 'create', undefined, d);
    return d;
  });
  res.status(201).json(row);
});

hrRouter.patch('/departments/:id', requireAction('hr.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = deptBody.partial().parse(req.body);
  const row = await tx(async (db) => {
    const old = (await db.query('SELECT * FROM hr_departments WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw notFound('Bo\'lim');
    const d = (
      await db.query(
        `UPDATE hr_departments SET name = coalesce($2, name), producer_id = CASE WHEN $3 THEN $4 ELSE producer_id END, is_active = coalesce($5, is_active)
          WHERE id = $1 RETURNING *`,
        [id, b.name ?? null, b.producer_id !== undefined, b.producer_id ?? null, b.is_active ?? null],
      )
    ).rows[0];
    await audit(db, ctx, 'hr_department', id, 'update', old, d);
    return d;
  });
  res.json(row);
});

// ---------- Xodimlar ----------
const EMP = `
  SELECT e.id, e.full_name, e.department_id, d.name AS department_name, e.brigade, e.position, e.schedule, e.work_mode, e.gender, e.phone,
         e.hired_on, e.fired_on, e.fire_reason, e.note, e.created_at
    FROM employees e JOIN hr_departments d ON d.id = e.department_id`;

hrRouter.get('/employees', async (req, res) => {
  const q = z
    .object({ department_id: idParam.optional(), status: z.enum(['active', 'fired', 'all']).default('active'), on: date.optional() })
    .parse(req.query);
  const cond = { active: 'e.fired_on IS NULL', fired: 'e.fired_on IS NOT NULL', all: 'true' }[q.status];
  const rows = (
    await pool.query(
      `${EMP} WHERE ${cond} AND ($1::int IS NULL OR e.department_id = $1) AND ($2::date IS NULL OR (${employed('e', '$2')}))
        ORDER BY d.name, e.brigade NULLS LAST, lower(e.full_name)`,
      [q.department_id ?? null, q.on ?? null],
    )
  ).rows;
  res.json(rows);
});

hrRouter.get('/employees/:id', requireAction('hr.read'), async (req, res) => {
  const id = idParam.parse(req.params.id);
  const e = (await pool.query(`${EMP} WHERE e.id = $1`, [id])).rows[0];
  if (!e) throw notFound('Xodim');
  const salaries = (
    await pool.query(
      `SELECT s.*, round(s.amount / s.norm_hours, 2) AS hourly, u.full_name AS created_by_name
         FROM employee_salaries s LEFT JOIN users u ON u.id = s.created_by WHERE s.employee_id = $1 ORDER BY s.valid_from DESC`,
      [id],
    )
  ).rows;
  res.json({ ...e, salaries });
});

const empBody = z.object({
  full_name: z.string().trim().min(2).max(150),
  department_id: idParam,
  brigade: optText(50),
  position: optText(100),
  schedule: optText(200),
  work_mode: z.enum(['full', 'part']).default('full'),
  gender: z.enum(['erkak', 'ayol']).nullish(),
  phone: optText(30),
  hired_on: date,
  note: optText(500),
});
const EMP_COLS = Object.keys(empBody.shape);
const salaryBody = z.object({ valid_from: date, amount: money, norm_hours: z.coerce.number().positive().max(744).default(208), note: optText(300) });

hrRouter.post('/employees', requireAction('hr.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = empBody.extend({ salary: salaryBody.omit({ valid_from: true }).optional() }).parse(req.body);
  const row = await tx(async (db) => {
    const vals = EMP_COLS.map((k) => (b as Record<string, unknown>)[k] ?? null);
    const id = (
      await db.query(
        `INSERT INTO employees (${EMP_COLS.join(', ')}, created_by) VALUES (${EMP_COLS.map((_, i) => `$${i + 1}`).join(', ')}, $${EMP_COLS.length + 1}) RETURNING id`,
        [...vals, ctx.userId],
      )
    ).rows[0].id as number;
    if (b.salary) {
      await db.query('INSERT INTO employee_salaries (employee_id, valid_from, amount, norm_hours, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        id, b.hired_on, b.salary.amount, b.salary.norm_hours, b.salary.note, ctx.userId,
      ]);
    }
    await audit(db, ctx, 'employee', id, 'hire', undefined, b);
    return (await db.query(`${EMP} WHERE e.id = $1`, [id])).rows[0];
  });
  res.status(201).json(row);
});

hrRouter.patch('/employees/:id', requireAction('hr.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = empBody.partial().parse(req.body) as Record<string, unknown>;
  const row = await tx(async (db) => {
    const old = await employeeOf(db, id, true);
    if (b.hired_on && old.fired_on && (b.hired_on as string) > old.fired_on) throw badRequest('Qabul sanasi bo\'shatish sanasidan keyin bo\'lishi mumkin emas');
    const keys = EMP_COLS.filter((k) => b[k] !== undefined);
    if (keys.length) await db.query(`UPDATE employees SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => b[k] ?? null)]);
    const e = (await db.query(`${EMP} WHERE e.id = $1`, [id])).rows[0];
    await audit(db, ctx, 'employee', id, 'update', old, e);
    return e;
  });
  res.json(row);
});

hrRouter.post('/employees/:id/fire', requireAction('hr.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = z.object({ fired_on: date, reason: optText(300) }).parse(req.body);
  const row = await tx(async (db) => {
    const old = await employeeOf(db, id, true);
    if (old.fired_on) throw conflict('Xodim allaqachon bo\'shatilgan');
    if (b.fired_on < old.hired_on) throw badRequest('Bo\'shatish sanasi qabul sanasidan oldin bo\'lishi mumkin emas');
    const later = (await db.query('SELECT max(work_date) AS d FROM hr_timesheet WHERE employee_id = $1 AND work_date > $2 AND NOT absent', [id, b.fired_on])).rows[0].d;
    if (later) throw conflict(`Tabelda ${later} sanada ishlagan — bo'shatish sanasi undan oldin bo'lishi mumkin emas`);
    await db.query('UPDATE employees SET fired_on = $2, fire_reason = $3 WHERE id = $1', [id, b.fired_on, b.reason]);
    await audit(db, ctx, 'employee', id, 'fire', { fired_on: null }, b);
    return (await db.query(`${EMP} WHERE e.id = $1`, [id])).rows[0];
  });
  res.json(row);
});

hrRouter.post('/employees/:id/restore', requireAction('hr.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const row = await tx(async (db) => {
    const old = await employeeOf(db, id, true);
    if (!old.fired_on) throw conflict('Xodim ishlayapti');
    await db.query('UPDATE employees SET fired_on = NULL, fire_reason = NULL WHERE id = $1', [id]);
    await audit(db, ctx, 'employee', id, 'restore', { fired_on: old.fired_on, fire_reason: old.fire_reason }, { fired_on: null });
    return (await db.query(`${EMP} WHERE e.id = $1`, [id])).rows[0];
  });
  res.json(row);
});

hrRouter.post('/employees/:id/salaries', requireAction('hr.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = salaryBody.parse(req.body);
  const row = await tx(async (db) => {
    await employeeOf(db, id, true);
    const s = (
      await db.query(
        `INSERT INTO employee_salaries (employee_id, valid_from, amount, norm_hours, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (employee_id, valid_from) DO UPDATE SET amount = EXCLUDED.amount, norm_hours = EXCLUDED.norm_hours, note = EXCLUDED.note
         RETURNING *`,
        [id, b.valid_from, b.amount, b.norm_hours, b.note, ctx.userId],
      )
    ).rows[0];
    await audit(db, ctx, 'employee_salary', s.id, 'set', undefined, s);
    return s;
  });
  res.status(201).json(row);
});

hrRouter.delete('/employees/:id/salaries/:sid', requireAction('hr.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const sid = idParam.parse(req.params.sid);
  await tx(async (db) => {
    const s = (await db.query('DELETE FROM employee_salaries WHERE id = $1 AND employee_id = $2 RETURNING *', [sid, id])).rows[0];
    if (!s) throw notFound('Oylik yozuvi');
    await audit(db, ctx, 'employee_salary', sid, 'delete', s, undefined);
  });
  res.status(204).end();
});

// ---------- Tabel ----------
/** Hisoblangan soat: ketgan − kelgan (tunda o'tsa +24), 6 soatdan uzun smenada 1 soat tushlik, ± javob so'ragan / qo'shimcha */
export function calcHours(came: string | null, left: string | null, extra: number) {
  if (!came || !left) return null;
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let span = (m(left) - m(came)) / 60;
  if (span < 0) span += 24;
  const h = span - (span > LUNCH_AFTER ? 1 : 0) + extra;
  return r2(Math.min(24, Math.max(0, h)));
}

hrRouter.get('/timesheet/day', requireAction('hr.read'), async (req, res) => {
  const q = z.object({ date, department_id: idParam }).parse(req.query);
  const rows = (
    await pool.query(
      `SELECT e.id AS employee_id, e.full_name, e.position, e.brigade, e.department_id AS home_department_id, hd.name AS home_department_name,
              t.id, t.absent, t.reason, to_char(t.came_at, 'HH24:MI') AS came_at, to_char(t.left_at, 'HH24:MI') AS left_at, t.extra_hours, t.hours, t.note,
              (e.department_id <> $2) AS extra_worker
         FROM employees e JOIN hr_departments hd ON hd.id = e.department_id
         LEFT JOIN hr_timesheet t ON t.employee_id = e.id AND t.work_date = $1
        WHERE (e.department_id = $2 AND ${employed('e', '$1')} AND (t.id IS NULL OR t.department_id = $2)) OR t.department_id = $2
        ORDER BY (e.department_id <> $2), e.brigade NULLS LAST, lower(e.full_name)`,
      [q.date, q.department_id],
    )
  ).rows;
  res.json(rows);
});

hrRouter.put('/timesheet/day', requireAction('hr.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      work_date: date,
      department_id: idParam,
      rows: z
        .array(
          z.object({
            employee_id: idParam,
            absent: z.boolean().default(false),
            reason: optText(200),
            came_at: time.nullish(),
            left_at: time.nullish(),
            extra_hours: z.coerce.number().min(-24).max(24).default(0),
            hours: z.coerce.number().min(0).max(24).nullish(),
            note: optText(300),
          }),
        )
        .max(1000),
    })
    .parse(req.body);
  if (new Set(b.rows.map((r) => r.employee_id)).size !== b.rows.length) throw badRequest('Bir xodim ikki marta yozilgan');
  const result = await tx(async (db) => {
    const dept = (await db.query('SELECT * FROM hr_departments WHERE id = $1', [b.department_id])).rows[0];
    if (!dept) throw notFound('Bo\'lim');
    const ids = b.rows.map((r) => r.employee_id);
    const removed = (
      await db.query('DELETE FROM hr_timesheet WHERE work_date = $1 AND department_id = $2 AND NOT (employee_id = ANY($3::int[])) RETURNING *', [b.work_date, b.department_id, ids])
    ).rows;
    let saved = 0;
    for (const r of b.rows) {
      const e = await employeeOf(db, r.employee_id);
      if (e.hired_on > b.work_date || (e.fired_on && e.fired_on < b.work_date)) throw badRequest(`${e.full_name}: ${b.work_date} sanada ishda emas (qabul / bo'shatish sanasi)`);
      const other = (
        await db.query('SELECT d.name FROM hr_timesheet t JOIN hr_departments d ON d.id = t.department_id WHERE t.employee_id = $1 AND t.work_date = $2 AND t.department_id <> $3', [
          r.employee_id, b.work_date, b.department_id,
        ])
      ).rows[0];
      if (other) throw conflict(`${e.full_name}: bu kuni «${other.name}» tabelida bor`);
      let hours: number;
      if (r.absent) hours = 0;
      else {
        const h = calcHours(r.came_at ?? null, r.left_at ?? null, r.extra_hours);
        if (h == null && r.hours == null) throw badRequest(`${e.full_name}: kelgan va ketgan vaqtni yoki soatni kiriting`);
        hours = h ?? r2(r.hours!);
      }
      if (r.absent && !r.reason) throw badRequest(`${e.full_name}: kelmagan sababini yozing`);
      await db.query(
        `INSERT INTO hr_timesheet (work_date, employee_id, department_id, absent, reason, came_at, left_at, extra_hours, hours, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (employee_id, work_date) DO UPDATE SET absent = EXCLUDED.absent, reason = EXCLUDED.reason, came_at = EXCLUDED.came_at,
           left_at = EXCLUDED.left_at, extra_hours = EXCLUDED.extra_hours, hours = EXCLUDED.hours, note = EXCLUDED.note`,
        [
          b.work_date, r.employee_id, b.department_id, r.absent, r.absent ? r.reason : null, r.absent ? null : r.came_at ?? null,
          r.absent ? null : r.left_at ?? null, r.absent ? 0 : r.extra_hours, hours, r.note, ctx.userId,
        ],
      );
      saved++;
    }
    await audit(db, ctx, 'hr_timesheet', null, 'save_day', { removed }, b);
    return { saved, removed: removed.length };
  });
  res.json(result);
});

/** Oylik tabel: xodim × kun (soat), jami */
hrRouter.get('/timesheet/month', requireAction('hr.read'), async (req, res) => {
  const q = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), department_id: idParam }).parse(req.query);
  const from = `${q.month}-01`;
  const rows = (
    await pool.query(
      `SELECT t.employee_id, e.full_name, e.position, e.brigade, to_char(t.work_date, 'YYYY-MM-DD') AS d, t.hours, t.absent, t.reason
         FROM hr_timesheet t JOIN employees e ON e.id = t.employee_id
        WHERE t.department_id = $1 AND t.work_date >= $2::date AND t.work_date < ($2::date + interval '1 month')
        ORDER BY e.brigade NULLS LAST, lower(e.full_name), t.work_date`,
      [q.department_id, from],
    )
  ).rows;
  const last = new Date(Date.UTC(Number(q.month.slice(0, 4)), Number(q.month.slice(5, 7)), 0)).getUTCDate();
  const days = Array.from({ length: last }, (_, i) => `${q.month}-${String(i + 1).padStart(2, '0')}`);
  type Row = { employee_id: number; full_name: string; position: string | null; brigade: string | null; cells: Record<string, { hours: number; absent: boolean; reason: string | null }>; hours: number; days: number; absent: number };
  const byEmp = new Map<number, Row>();
  for (const r of rows) {
    const e: Row = byEmp.get(r.employee_id) ?? { employee_id: r.employee_id, full_name: r.full_name, position: r.position, brigade: r.brigade, cells: {}, hours: 0, days: 0, absent: 0 };
    e.cells[r.d] = { hours: Number(r.hours), absent: r.absent, reason: r.reason };
    e.hours = r2(e.hours + Number(r.hours));
    if (r.absent) e.absent++;
    else if (Number(r.hours) > 0) e.days++;
    byEmp.set(r.employee_id, e);
  }
  const list = [...byEmp.values()];
  const totals = Object.fromEntries(days.map((d) => [d, r2(list.reduce((a, e) => a + (e.cells[d]?.hours ?? 0), 0))]));
  res.json({ days, rows: list, totals, hours: r2(list.reduce((a, e) => a + e.hours, 0)) });
});

// ---------- Ish turlari va narxlari ----------
hrRouter.get('/work-types', async (req, res) => {
  const q = z.object({ department_id: idParam.optional(), all: z.coerce.boolean().default(false), on: date.optional() }).parse(req.query);
  const rows = (
    await pool.query(
      `SELECT w.*, d.name AS department_name, hr_price_at(w.id, coalesce($3::date, current_date)) AS price,
              (SELECT max(p.valid_from) FROM hr_work_prices p WHERE p.work_type_id = w.id AND p.valid_from <= coalesce($3::date, current_date)) AS price_from
         FROM hr_work_types w JOIN hr_departments d ON d.id = w.department_id
        WHERE ($1::int IS NULL OR w.department_id = $1) AND ($2 OR w.is_active)
        ORDER BY d.name, lower(w.category), lower(w.name)`,
      [q.department_id ?? null, q.all, q.on ?? null],
    )
  ).rows;
  res.json(rows);
});

hrRouter.get('/work-types/:id/prices', async (req, res) => {
  const id = idParam.parse(req.params.id);
  res.json(
    (
      await pool.query(
        'SELECT p.*, u.full_name AS created_by_name FROM hr_work_prices p LEFT JOIN users u ON u.id = p.created_by WHERE p.work_type_id = $1 ORDER BY p.valid_from DESC',
        [id],
      )
    ).rows,
  );
});

hrRouter.post('/work-types', requireAction('hr.rates'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({ department_id: idParam, category: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200), price: money.nullish(), valid_from: date.optional() })
    .parse(req.body);
  if (b.price != null && !b.valid_from) throw badRequest('Narx qaysi sanadan amal qilishini kiriting');
  const row = await tx(async (db) => {
    const w = (await db.query('INSERT INTO hr_work_types (department_id, category, name) VALUES ($1, $2, $3) RETURNING *', [b.department_id, b.category, b.name])).rows[0];
    if (b.price != null) {
      await db.query('INSERT INTO hr_work_prices (work_type_id, valid_from, price, created_by) VALUES ($1, $2, $3, $4)', [w.id, b.valid_from, b.price, ctx.userId]);
    }
    await audit(db, ctx, 'hr_work_type', w.id, 'create', undefined, b);
    return w;
  });
  res.status(201).json(row);
});

hrRouter.patch('/work-types/:id', requireAction('hr.rates'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = z.object({ category: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200), is_active: z.boolean() }).partial().parse(req.body);
  const row = await tx(async (db) => {
    const old = (await db.query('SELECT * FROM hr_work_types WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw notFound('Ish turi');
    const w = (
      await db.query('UPDATE hr_work_types SET category = coalesce($2, category), name = coalesce($3, name), is_active = coalesce($4, is_active) WHERE id = $1 RETURNING *', [
        id, b.category ?? null, b.name ?? null, b.is_active ?? null,
      ])
    ).rows[0];
    await audit(db, ctx, 'hr_work_type', id, 'update', old, w);
    return w;
  });
  res.json(row);
});

hrRouter.post('/work-types/:id/prices', requireAction('hr.rates'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const b = z.object({ valid_from: date, price: money }).parse(req.body);
  const row = await tx(async (db) => {
    if (!(await db.query('SELECT 1 FROM hr_work_types WHERE id = $1', [id])).rowCount) throw notFound('Ish turi');
    const p = (
      await db.query(
        `INSERT INTO hr_work_prices (work_type_id, valid_from, price, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (work_type_id, valid_from) DO UPDATE SET price = EXCLUDED.price RETURNING *`,
        [id, b.valid_from, b.price, ctx.userId],
      )
    ).rows[0];
    await audit(db, ctx, 'hr_work_price', p.id, 'set', undefined, p);
    return p;
  });
  res.status(201).json(row);
});

// ---------- Ish nazorati (ishbay) ----------
const LOGS = `
  SELECT l.id, l.work_date, l.employee_id, e.full_name, e.department_id, d.name AS department_name, l.work_type_id, w.category, w.name AS work_name,
         l.qty, hr_price_at(l.work_type_id, l.work_date) AS price, round(l.qty * hr_price_at(l.work_type_id, l.work_date), 2) AS amount,
         l.order_id, o.partiya_no, l.note, l.created_at, u.full_name AS created_by_name
    FROM hr_work_logs l JOIN employees e ON e.id = l.employee_id JOIN hr_departments d ON d.id = e.department_id
    JOIN hr_work_types w ON w.id = l.work_type_id LEFT JOIN orders o ON o.id = l.order_id LEFT JOIN users u ON u.id = l.created_by`;

hrRouter.get('/work-logs', async (req, res) => {
  const q = z
    .object({ from: date.optional(), to: date.optional(), department_id: idParam.optional(), employee_id: idParam.optional(), limit: z.coerce.number().int().min(1).max(10000).default(2000) })
    .parse(req.query);
  const rows = (
    await pool.query(
      `${LOGS} WHERE ($1::date IS NULL OR l.work_date >= $1) AND ($2::date IS NULL OR l.work_date <= $2)
          AND ($3::int IS NULL OR e.department_id = $3) AND ($4::int IS NULL OR l.employee_id = $4)
        ORDER BY l.work_date DESC, l.id DESC LIMIT $5`,
      [q.from ?? null, q.to ?? null, q.department_id ?? null, q.employee_id ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

hrRouter.post('/work-logs', requireAction('hr.work'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      work_date: date,
      rows: z
        .array(z.object({ employee_id: idParam, work_type_id: idParam, qty: z.coerce.number().int().min(1).max(1e7), order_id: idParam.nullish(), note: optText(300) }))
        .min(1)
        .max(1000),
    })
    .parse(req.body);
  const data = await tx(async (db) => {
    const ids: number[] = [];
    for (const r of b.rows) {
      const e = await employeeOf(db, r.employee_id);
      if (e.hired_on > b.work_date || (e.fired_on && e.fired_on < b.work_date)) throw badRequest(`${e.full_name}: ${b.work_date} sanada ishda emas`);
      const w = (await db.query('SELECT * FROM hr_work_types WHERE id = $1', [r.work_type_id])).rows[0];
      if (!w) throw notFound('Ish turi');
      if (!w.is_active) throw badRequest(`«${w.name}» ish turi o'chirilgan`);
      ids.push(
        (
          await db.query('INSERT INTO hr_work_logs (work_date, employee_id, work_type_id, qty, order_id, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [
            b.work_date, r.employee_id, r.work_type_id, r.qty, r.order_id ?? null, r.note, ctx.userId,
          ])
        ).rows[0].id,
      );
    }
    await audit(db, ctx, 'hr_work_log', ids[0], 'create', undefined, b);
    const rows = (await db.query(`${LOGS} WHERE l.id = ANY($1::int[]) ORDER BY l.id`, [ids])).rows;
    return { saved: rows.length, amount: r2(rows.reduce((a, x) => a + Number(x.amount), 0)).toFixed(2), zero_price: rows.filter((x) => Number(x.price) === 0).length };
  });
  res.status(201).json(data);
});

hrRouter.delete('/work-logs/:id', requireAction('hr.work'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const l = (await db.query('DELETE FROM hr_work_logs WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!l) throw notFound('Ish nazorati yozuvi');
    await audit(db, ctx, 'hr_work_log', id, 'delete', l, undefined);
  });
  res.status(204).end();
});

// ---------- Bonus / ushlab qolish va to'lovlar ----------
const rangeQ = z.object({ from: date.optional(), to: date.optional(), employee_id: idParam.optional() });

hrRouter.get('/adjustments', requireAction('hr.read'), async (req, res) => {
  const q = rangeQ.parse(req.query);
  res.json(
    (
      await pool.query(
        `SELECT a.*, e.full_name, d.name AS department_name, u.full_name AS created_by_name
           FROM hr_adjustments a JOIN employees e ON e.id = a.employee_id JOIN hr_departments d ON d.id = e.department_id LEFT JOIN users u ON u.id = a.created_by
          WHERE ($1::date IS NULL OR a.adj_date >= $1) AND ($2::date IS NULL OR a.adj_date <= $2) AND ($3::int IS NULL OR a.employee_id = $3)
          ORDER BY a.adj_date DESC, a.id DESC`,
        [q.from ?? null, q.to ?? null, q.employee_id ?? null],
      )
    ).rows,
  );
});

hrRouter.post('/adjustments', requireAction('hr.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({ adj_date: date, employee_id: idParam, kind: z.enum(['bonus', 'penalty', 'other']), amount: money.refine((v) => v > 0, 'Summa 0 dan katta'), note: optText(300) })
    .parse(req.body);
  if (b.kind !== 'bonus' && !b.note) throw badRequest('Izoh yozing (nima uchun)');
  const row = await tx(async (db) => {
    await employeeOf(db, b.employee_id);
    const a = (
      await db.query('INSERT INTO hr_adjustments (adj_date, employee_id, kind, amount, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [
        b.adj_date, b.employee_id, b.kind, b.amount, b.note, ctx.userId,
      ])
    ).rows[0];
    await audit(db, ctx, 'hr_adjustment', a.id, 'create', undefined, a);
    return a;
  });
  res.status(201).json(row);
});

hrRouter.delete('/adjustments/:id', requireAction('hr.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const a = (await db.query('DELETE FROM hr_adjustments WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!a) throw notFound('Yozuv');
    await audit(db, ctx, 'hr_adjustment', id, 'delete', a, undefined);
  });
  res.status(204).end();
});

hrRouter.get('/payments', requireAction('hr.read'), async (req, res) => {
  const q = rangeQ.parse(req.query);
  res.json(
    (
      await pool.query(
        `SELECT p.*, e.full_name, d.name AS department_name, u.full_name AS created_by_name
           FROM hr_payments p JOIN employees e ON e.id = p.employee_id JOIN hr_departments d ON d.id = e.department_id LEFT JOIN users u ON u.id = p.created_by
          WHERE ($1::date IS NULL OR p.pay_date >= $1) AND ($2::date IS NULL OR p.pay_date <= $2) AND ($3::int IS NULL OR p.employee_id = $3)
          ORDER BY p.pay_date DESC, p.id DESC`,
        [q.from ?? null, q.to ?? null, q.employee_id ?? null],
      )
    ).rows,
  );
});

hrRouter.post('/payments', requireAction('hr.pay'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({ pay_date: date, employee_id: idParam, method: z.enum(['naqd', 'bank']), amount: money.refine((v) => v > 0, 'Summa 0 dan katta'), note: optText(300) })
    .parse(req.body);
  const row = await tx(async (db) => {
    await employeeOf(db, b.employee_id);
    const p = (
      await db.query('INSERT INTO hr_payments (pay_date, employee_id, method, amount, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [
        b.pay_date, b.employee_id, b.method, b.amount, b.note, ctx.userId,
      ])
    ).rows[0];
    await audit(db, ctx, 'hr_payment', p.id, 'create', undefined, p);
    return p;
  });
  res.status(201).json(row);
});

hrRouter.delete('/payments/:id', requireAction('hr.pay'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  await tx(async (db) => {
    const p = (await db.query('DELETE FROM hr_payments WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!p) throw notFound('To\'lov');
    await audit(db, ctx, 'hr_payment', id, 'delete', p, undefined);
  });
  res.status(204).end();
});

// ---------- Nachisleniya: vedomost va xodim kartochkasi ----------
/** Har xodim bo'yicha kunlik harakatlar: hisoblangan (oylik, ishbay, bonus, boshqa, ushlab qolish) va to'langan (naqd, bank) */
const EVENTS = `
  SELECT t.employee_id, t.work_date AS d, round(t.hours * hr_rate_at(t.employee_id, t.work_date), 2) AS salary,
         0::numeric AS piece, 0::numeric AS bonus, 0::numeric AS other, 0::numeric AS penalty, 0::numeric AS cash, 0::numeric AS bank
    FROM hr_timesheet t WHERE NOT t.absent AND t.hours > 0
  UNION ALL
  SELECT l.employee_id, l.work_date, 0, round(l.qty * hr_price_at(l.work_type_id, l.work_date), 2), 0, 0, 0, 0, 0 FROM hr_work_logs l
  UNION ALL
  SELECT a.employee_id, a.adj_date, 0, 0, CASE WHEN a.kind = 'bonus' THEN a.amount ELSE 0 END, CASE WHEN a.kind = 'other' THEN a.amount ELSE 0 END,
         CASE WHEN a.kind = 'penalty' THEN a.amount ELSE 0 END, 0, 0 FROM hr_adjustments a
  UNION ALL
  SELECT p.employee_id, p.pay_date, 0, 0, 0, 0, 0, CASE WHEN p.method = 'naqd' THEN p.amount ELSE 0 END, CASE WHEN p.method = 'bank' THEN p.amount ELSE 0 END
    FROM hr_payments p`;
const NET = '(salary + piece + bonus + other - penalty - cash - bank)';

hrRouter.get('/payroll', requireAction('hr.read'), async (req, res) => {
  const q = z.object({ from: date, to: date, department_id: idParam.optional() }).parse(req.query);
  if (q.to < q.from) throw badRequest('Sanagacha sanadan oldin bo\'lishi mumkin emas');
  const rows = (
    await pool.query(
      `WITH ev AS (${EVENTS}),
            per AS (
              SELECT employee_id,
                     coalesce(sum(${NET}) FILTER (WHERE d < $1), 0) AS opening,
                     coalesce(sum(salary) FILTER (WHERE d BETWEEN $1 AND $2), 0) AS salary,
                     coalesce(sum(piece) FILTER (WHERE d BETWEEN $1 AND $2), 0) AS piece,
                     coalesce(sum(bonus) FILTER (WHERE d BETWEEN $1 AND $2), 0) AS bonus,
                     coalesce(sum(other) FILTER (WHERE d BETWEEN $1 AND $2), 0) AS other,
                     coalesce(sum(penalty) FILTER (WHERE d BETWEEN $1 AND $2), 0) AS penalty,
                     coalesce(sum(cash) FILTER (WHERE d BETWEEN $1 AND $2), 0) AS cash,
                     coalesce(sum(bank) FILTER (WHERE d BETWEEN $1 AND $2), 0) AS bank
                FROM ev WHERE d <= $2 GROUP BY employee_id),
            ts AS (
              SELECT employee_id, count(*) FILTER (WHERE NOT absent AND hours > 0)::int AS days, count(*) FILTER (WHERE absent)::int AS absent_days,
                     coalesce(sum(hours), 0) AS hours
                FROM hr_timesheet WHERE work_date BETWEEN $1 AND $2 GROUP BY employee_id)
       SELECT e.id AS employee_id, e.full_name, e.position, e.brigade, e.department_id, d.name AS department_name, e.fired_on,
              coalesce(ts.days, 0) AS days, coalesce(ts.absent_days, 0) AS absent_days, coalesce(ts.hours, 0) AS hours,
              coalesce(per.opening, 0) AS opening, coalesce(per.salary, 0) AS salary, coalesce(per.piece, 0) AS piece,
              coalesce(per.bonus, 0) AS bonus, coalesce(per.other, 0) AS other, coalesce(per.penalty, 0) AS penalty,
              coalesce(per.salary + per.piece + per.bonus + per.other - per.penalty, 0) AS accrued,
              coalesce(per.cash, 0) AS cash, coalesce(per.bank, 0) AS bank,
              coalesce(per.opening + per.salary + per.piece + per.bonus + per.other - per.penalty - per.cash - per.bank, 0) AS closing
         FROM employees e JOIN hr_departments d ON d.id = e.department_id
         LEFT JOIN per ON per.employee_id = e.id LEFT JOIN ts ON ts.employee_id = e.id
        WHERE ($3::int IS NULL OR e.department_id = $3)
          AND (per.employee_id IS NOT NULL OR (e.hired_on <= $2 AND (e.fired_on IS NULL OR e.fired_on >= $1)))
        ORDER BY d.name, e.brigade NULLS LAST, lower(e.full_name)`,
      [q.from, q.to, q.department_id ?? null],
    )
  ).rows;
  const keys = ['opening', 'salary', 'piece', 'bonus', 'other', 'penalty', 'accrued', 'cash', 'bank', 'closing'] as const;
  const totals = Object.fromEntries(keys.map((k) => [k, r2(rows.reduce((a, r) => a + Number(r[k]), 0)).toFixed(2)]));
  res.json({ rows, totals });
});

/** Xodim kartochkasi: davomat, ishbay ishlar (ish turi bo'yicha), bonuslar va akt sverka (kunlik qoldiq) */
hrRouter.get('/employees/:id/statement', requireAction('hr.read'), async (req, res) => {
  const id = idParam.parse(req.params.id);
  const q = z.object({ from: date, to: date }).parse(req.query);
  if (q.to < q.from) throw badRequest('Sanagacha sanadan oldin bo\'lishi mumkin emas');
  const e = (await pool.query(`${EMP} WHERE e.id = $1`, [id])).rows[0];
  if (!e) throw notFound('Xodim');
  const opening = (await pool.query(`SELECT coalesce(sum(${NET}), 0) AS v FROM (${EVENTS}) ev WHERE employee_id = $1 AND d < $2`, [id, q.from])).rows[0].v;
  const daily = (
    await pool.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS date, sum(salary) AS salary, sum(piece) AS piece, sum(bonus + other) AS bonus, sum(penalty) AS penalty,
              sum(salary + piece + bonus + other - penalty) AS accrued, sum(cash) AS cash, sum(bank) AS bank
         FROM (${EVENTS}) ev WHERE employee_id = $1 AND d BETWEEN $2 AND $3 GROUP BY d ORDER BY d`,
      [id, q.from, q.to],
    )
  ).rows;
  let bal = Math.round(Number(opening) * 100);
  const rows = daily.map((r) => {
    bal += Math.round(Number(r.accrued) * 100) - Math.round(Number(r.cash) * 100) - Math.round(Number(r.bank) * 100);
    return { ...r, balance: (bal / 100).toFixed(2) };
  });
  const works = (
    await pool.query(
      `SELECT w.category, w.name AS work_name, hr_price_at(l.work_type_id, l.work_date) AS price, sum(l.qty)::int AS qty,
              round(sum(l.qty) * hr_price_at(l.work_type_id, l.work_date), 2) AS amount
         FROM hr_work_logs l JOIN hr_work_types w ON w.id = l.work_type_id
        WHERE l.employee_id = $1 AND l.work_date BETWEEN $2 AND $3
        GROUP BY w.category, w.name, l.work_type_id, hr_price_at(l.work_type_id, l.work_date)
        ORDER BY lower(w.category), lower(w.name), price`,
      [id, q.from, q.to],
    )
  ).rows;
  const att = (
    await pool.query(
      `SELECT count(*) FILTER (WHERE NOT absent AND hours > 0)::int AS days, count(*) FILTER (WHERE absent)::int AS absent_days, coalesce(sum(hours), 0) AS hours
         FROM hr_timesheet WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3`,
      [id, q.from, q.to],
    )
  ).rows[0];
  const sum = (k: string) => r2(daily.reduce((a, r) => a + Number(r[k]), 0)).toFixed(2);
  res.json({
    employee: e,
    attendance: att,
    works,
    rows,
    opening: r2(Number(opening)).toFixed(2),
    totals: { salary: sum('salary'), piece: sum('piece'), bonus: sum('bonus'), penalty: sum('penalty'), accrued: sum('accrued'), cash: sum('cash'), bank: sum('bank'), closing: (bal / 100).toFixed(2) },
  });
});
