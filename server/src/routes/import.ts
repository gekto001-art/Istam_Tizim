import { Router } from 'express';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { ctxOf, requireAction, type RequestCtx } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { mapHeaders, normHeader, normName, parseCurrency, parseDate, parseMonth, parseNumber, parseTsv } from '../lib/sheet.js';
import { idParam } from '../lib/util.js';

/**
 * Google Sheets'dan import: foydalanuvchi jadvaldan qatorlarni sarlavhasi bilan nusxalab joylashtiradi.
 * Sarlavhalar nomi bo'yicha topiladi (ustunlar tartibi ahamiyatsiz, ortiqcha ustunlar e'tiborsiz).
 * dry_run — hammasi tranzaksiyada bajariladi va orqaga qaytariladi: natija (nechtasi yaratiladi, xatolar) ko'rsatiladi.
 * Takroriy import: xodim (ism + bo'lim), ish turi (nom), oylik (xodim + sana) — mavjudi qayta yaratilmaydi;
 * kassa — partiya bo'lib yoziladi va partiyasi bilan bekor qilinadi.
 */
export const importRouter = Router();
importRouter.use(requireAction('import.run'));

type Kind = 'employees' | 'salaries' | 'work_types' | 'cash';
type Result = { created: number; updated: number; skipped: number; errors: { row: number; message: string }[]; warnings: string[] };
type Ctx = { db: Db; ctx: RequestCtx; batchId: number; opts: Opts; res: Result };
type Opts = { department_id?: number | null; business?: 'moliya' | 'tijorat' | 'ishlab' };
type Cells = (field: string) => string;

const FIELDS: Record<Kind, { fields: Record<string, string[]>; required: string[] }> = {
  employees: {
    fields: {
      name: ['fio', 'фио', 'fish', 'fishxodim'],
      fire_name: ['фиосотрудникувол', 'fishishdanboshatilgan', 'fioishdanboshatilganishchilar'],
      type: ['тип', 'turi'],
      position: ['lavozim', 'должность'],
      mode: ['графикработы', 'ishrejim', 'ishrejimi', 'grafik'],
      hired: ['датаприема', 'ishgaqabulsanasi', 'qabulqilingansana', 'qabulsanasi'],
      fired: ['датауволнения', 'датаувольнения', 'ishdanboshashsanasi', 'ishdanboshatilgansana'],
      gender: ['jinsi', 'пол'],
      dept: ['подразделения', 'подразделение', 'bolim', 'bolimi'],
      brigade: ['субподраделения', 'субподразделения', 'brigada'],
      phone: ['telefon', 'телефон'],
    },
    required: ['name', 'hired'],
  },
  salaries: {
    fields: { name: ['fio', 'фио', 'fish'], date: ['sana'], hours: ['biroylikishsoati', 'oylikishsoati', 'ishsoati'], amount: ['oylik'] },
    required: ['name', 'date', 'amount'],
  },
  work_types: {
    fields: {
      date: ['sana'],
      category: ['kategoriyalar', 'kategoriya'],
      name: ['ishlarnomi', 'ishlarroyxati', 'ishnomi', 'ishturi', 'yangiishnomi'],
      price: ['ishnarxi', 'belgilangannarx', 'narx', 'narxi'],
    },
    required: ['name'],
  },
  cash: {
    fields: {
      date: ['sana'],
      wallet: ['hamyon', 'koshelok'],
      op: ['tranzaksiya'],
      center: ['markaz'],
      item: ['xarajatelementlari', 'xarajatelementi'],
      code: ['kategoriyakodi'],
      counterparty: ['kontragent'],
      department: ['bolim'],
      responsible: ['masulshaxs'],
      detal: ['detal'],
      izoh: ['izoh'],
      izoh2: ['qoshimchaizoh'],
      currency: ['valyutaturi', 'valyuta'],
      rate: ['valyutakurs', 'kurs'],
      in: ['kirim'],
      out: ['chiqim'],
      period: ['oylar', 'oy'],
      partiya: ['partiya', 'partiyano'],
    },
    required: ['date', 'wallet', 'op', 'in', 'out'],
  },
};

const LABEL: Record<Kind, string> = { employees: 'Xodimlar', salaries: 'Oyliklar', work_types: 'Ish turlari va narxlar', cash: 'Kassa' };

class DryRun extends Error {}

// ---------- Xodimlar (Ishchilar / Qabul-Bo'shatish baza) ----------
async function departmentOf(c: Ctx, name: string) {
  const n = name.trim();
  if (!n) return c.opts.department_id ?? null;
  const d = (await c.db.query('SELECT id FROM hr_departments WHERE lower(name) = lower($1)', [n])).rows[0];
  if (d) return d.id as number;
  const id = (await c.db.query('INSERT INTO hr_departments (name) VALUES ($1) RETURNING id', [n])).rows[0].id as number;
  c.res.warnings.push(`Yangi bo'lim yaratildi: «${n}»`);
  return id;
}

async function findEmployee(db: Db, name: string, deptId?: number | null) {
  return (
    await db.query(
      `SELECT * FROM employees WHERE upper(regexp_replace(trim(full_name), '\\s+', ' ', 'g')) = $1 AND ($2::int IS NULL OR department_id = $2)
        ORDER BY (fired_on IS NULL) DESC, id DESC LIMIT 1`,
      [normName(name), deptId ?? null],
    )
  ).rows[0];
}

async function employeeRow(c: Ctx, v: Cells) {
  const type = normHeader(v('type'));
  const fireName = v('fire_name').trim();
  const firedOn = parseDate(v('fired'));
  if (type.startsWith('увол') || type.startsWith('bosh') || (!v('name').trim() && fireName)) {
    const name = fireName || v('name');
    if (!firedOn) throw new Error('bo\'shatish sanasi yo\'q yoki noto\'g\'ri');
    const e = await findEmployee(c.db, name);
    if (!e) throw new Error(`«${name.trim()}» xodimi topilmadi (bo'shatish)`);
    if (e.fired_on) return void c.res.skipped++;
    if (firedOn < e.hired_on) throw new Error('bo\'shatish sanasi qabul sanasidan oldin');
    await c.db.query('UPDATE employees SET fired_on = $2 WHERE id = $1', [e.id, firedOn]);
    c.res.updated++;
    return;
  }
  const name = normName(v('name'));
  if (name.length < 2) throw new Error('FIO yo\'q');
  const hired = parseDate(v('hired'));
  if (!hired) throw new Error('ishga qabul sanasi yo\'q yoki noto\'g\'ri');
  const dept = await departmentOf(c, v('dept'));
  if (!dept) throw new Error('bo\'lim yo\'q — ustunni qo\'shing yoki «Bo\'lim (bo\'sh bo\'lsa)»ni tanlang');
  const exist = await findEmployee(c.db, name, dept);
  if (exist) {
    if (firedOn && !exist.fired_on && firedOn >= exist.hired_on) {
      await c.db.query('UPDATE employees SET fired_on = $2 WHERE id = $1', [exist.id, firedOn]);
      c.res.updated++;
    } else c.res.skipped++;
    return;
  }
  const mode = normHeader(v('mode'));
  const g = normHeader(v('gender'));
  const gender = g.startsWith('ayol') || g.startsWith('жен') ? 'ayol' : g.startsWith('erkak') || g.startsWith('муж') ? 'erkak' : null;
  await c.db.query(
    `INSERT INTO employees (full_name, department_id, brigade, position, schedule, work_mode, gender, phone, hired_on, fired_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      name, dept, v('brigade').trim() || null, v('position').trim() || null,
      mode.includes('toliq') || mode.includes('полн') ? null : v('mode').trim() || null,
      mode.includes('toliqsiz') || mode.includes('неполн') ? 'part' : 'full', gender, v('phone').trim() || null, hired,
      firedOn && firedOn >= hired ? firedOn : null, c.ctx.userId,
    ],
  );
  c.res.created++;
}

// ---------- Oyliklar ----------
async function salaryRow(c: Ctx, v: Cells) {
  const name = normName(v('name'));
  const date = parseDate(v('date'));
  const amount = parseNumber(v('amount'));
  const hours = parseNumber(v('hours')) ?? 208;
  if (!name) throw new Error('FIO yo\'q');
  if (!date) throw new Error('sana yo\'q yoki noto\'g\'ri');
  if (amount == null || !Number.isFinite(amount) || amount < 0) throw new Error('oylik summasi noto\'g\'ri');
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('oylik ish soati noto\'g\'ri');
  let e = await findEmployee(c.db, name);
  if (!e) {
    if (!c.opts.department_id) throw new Error(`«${name}» xodimi topilmadi — avval xodimlarni import qiling yoki «Bo'lim»ni tanlang (yangi xodim yaratiladi)`);
    e = (await c.db.query('INSERT INTO employees (full_name, department_id, hired_on, created_by) VALUES ($1, $2, $3, $4) RETURNING *', [name, c.opts.department_id, date, c.ctx.userId])).rows[0];
    c.res.warnings.push(`Yangi xodim yaratildi: ${name}`);
  }
  const r = await c.db.query(
    `INSERT INTO employee_salaries (employee_id, valid_from, amount, norm_hours, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (employee_id, valid_from) DO UPDATE SET amount = EXCLUDED.amount, norm_hours = EXCLUDED.norm_hours
     RETURNING (xmax = 0) AS inserted`,
    [e.id, date, amount, hours, c.ctx.userId],
  );
  if (r.rows[0].inserted) c.res.created++;
  else c.res.updated++;
}

// ---------- Ish turlari va narxlar ----------
async function workTypeRow(c: Ctx, v: Cells) {
  const dept = c.opts.department_id;
  if (!dept) throw new Error('bo\'limni tanlang');
  const name = v('name').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('ish nomi yo\'q');
  const priceRaw = v('price').trim();
  const price = priceRaw === '' ? null : parseNumber(priceRaw);
  if (price != null && (!Number.isFinite(price) || price < 0)) throw new Error('narx noto\'g\'ri');
  const date = parseDate(v('date'));
  if (price != null && !date) throw new Error('narx bor, lekin sana yo\'q yoki noto\'g\'ri');
  let w = (await c.db.query('SELECT * FROM hr_work_types WHERE department_id = $1 AND lower(name) = lower($2)', [dept, name])).rows[0];
  const isNew = !w;
  if (isNew) {
    w = (await c.db.query('INSERT INTO hr_work_types (department_id, category, name) VALUES ($1, $2, $3) RETURNING *', [dept, v('category').trim() || 'Boshqa', name])).rows[0];
    c.res.created++;
  }
  if (price == null) {
    if (!isNew) c.res.skipped++;
    return;
  }
  // narx shu sanadan amal qiladi (bir sanada qayta yuborilsa — yangilanadi)
  await c.db.query(
    `INSERT INTO hr_work_prices (work_type_id, valid_from, price, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (work_type_id, valid_from) DO UPDATE SET price = EXCLUDED.price`,
    [w.id, date, price, c.ctx.userId],
  );
  if (!isNew) c.res.updated++;
}

// ---------- Kassa (Kassa Baza / Kassa Ish/Ch / Kassa Tijorat ...) ----------
type CashCache = { wallets: Map<string, number>; ops: Map<string, number>; centers: { id: number; name: string; code: string | null }[]; items: Map<string, number>; codes: Map<number, number>; orders: Map<string, number> };
const CENTER_ALIAS: Record<string, string> = { ishlabchiqarish: 'IGSL-CCCOS01', tovarlartannarxi: 'IGSL-CCCOS01', boshqadaromadlar: 'IGSL-PCOTI01' };

async function cashCache(db: Db): Promise<CashCache> {
  const [w, o, c, i, od] = await Promise.all([
    db.query('SELECT id, name FROM cash_wallets'),
    db.query('SELECT id, name FROM cash_op_types'),
    db.query('SELECT id, name, code FROM cash_centers'),
    db.query('SELECT id, code, name FROM cash_items'),
    db.query('SELECT id, partiya_no FROM orders'),
  ]);
  return {
    wallets: new Map(w.rows.map((x) => [normHeader(x.name), x.id])),
    ops: new Map(o.rows.map((x) => [normHeader(x.name), x.id])),
    centers: c.rows,
    items: new Map(i.rows.map((x) => [normHeader(x.name), x.id])),
    codes: new Map(i.rows.map((x) => [Number(x.code), x.id])),
    orders: new Map(od.rows.map((x) => [normHeader(x.partiya_no), x.id])),
  };
}

const walletKind = (name: string) => {
  const n = name.toUpperCase();
  if (n.includes('AVANS')) return 'avans';
  if (n.includes('BANK')) return 'bank';
  if (/UZCARD|HUMO|VISA|KARTA|КАРТА|CLICK|PAYME/.test(n)) return 'karta';
  return 'naqd';
};

async function cashRow(c: Ctx, v: Cells, cache: CashCache) {
  const date = parseDate(v('date'));
  if (!date) throw new Error('sana yo\'q yoki noto\'g\'ri');
  const inV = parseNumber(v('in')) ?? 0;
  const outV = parseNumber(v('out')) ?? 0;
  if (!Number.isFinite(inV) || !Number.isFinite(outV)) throw new Error('kirim / chiqim soni noto\'g\'ri');
  const amountIn = inV < 0 ? 0 : inV;
  const amountOut = (outV < 0 ? -outV : outV) + (inV < 0 ? -inV : 0);
  if (!amountIn && !amountOut) return void c.res.skipped++;
  if (amountIn && amountOut) throw new Error('bir qatorda ham kirim, ham chiqim');

  const wName = v('wallet').replace(/\s+/g, ' ').trim();
  if (!wName) throw new Error('hamyon yo\'q');
  let wallet = cache.wallets.get(normHeader(wName));
  if (!wallet) {
    wallet = (await c.db.query('INSERT INTO cash_wallets (name, business, kind, sort) VALUES ($1, $2, $3, 100) RETURNING id', [wName, c.opts.business ?? 'moliya', walletKind(wName)])).rows[0].id as number;
    cache.wallets.set(normHeader(wName), wallet);
    c.res.warnings.push(`Yangi hamyon yaratildi: «${wName}»`);
  }
  const opName = v('op').replace(/\s+/g, ' ').trim();
  if (!opName) throw new Error('tranzaksiya yo\'q');
  let op = cache.ops.get(normHeader(opName));
  if (!op) {
    op = (await c.db.query('INSERT INTO cash_op_types (name, flow, sort) VALUES ($1, \'both\', 100) RETURNING id', [opName])).rows[0].id as number;
    cache.ops.set(normHeader(opName), op);
    c.res.warnings.push(`Yangi tranzaksiya turi yaratildi: «${opName}»`);
  }
  let center: number | null = null;
  const cName = normHeader(v('center'));
  if (cName) {
    const byAlias = CENTER_ALIAS[cName];
    const hit = cache.centers.find((x) => (byAlias && x.code === byAlias) || normHeader(x.name) === cName || normHeader(x.name).startsWith(cName) || cName.startsWith(normHeader(x.name)));
    if (hit) center = hit.id;
    else if (!c.res.warnings.includes(`Markaz topilmadi: «${v('center').trim()}»`)) c.res.warnings.push(`Markaz topilmadi: «${v('center').trim()}»`);
  }
  let item: number | null = null;
  const iName = v('item').replace(/\s+/g, ' ').trim();
  if (iName) {
    const code = parseNumber(v('code'));
    item = cache.items.get(normHeader(iName)) ?? (code && Number.isInteger(code) ? cache.codes.get(code) : undefined) ?? null;
    if (!item) {
      let newCode = code && Number.isInteger(code) && code >= 1000 && !cache.codes.has(code) ? code : 9900;
      while (cache.codes.has(newCode)) newCode++;
      item = (await c.db.query('INSERT INTO cash_items (code, name) VALUES ($1, $2) RETURNING id', [newCode, iName])).rows[0].id as number;
      cache.items.set(normHeader(iName), item);
      cache.codes.set(newCode, item);
      c.res.warnings.push(`Yangi xarajat elementi yaratildi: ${newCode} «${iName}»`);
    }
  }
  const currency = parseCurrency(v('currency'));
  if (!currency) throw new Error(`valyuta tanilmadi: «${v('currency')}»`);
  let rate = currency === 'UZS' ? 1 : parseNumber(v('rate'));
  if (rate == null || !Number.isFinite(rate) || rate <= 0) {
    rate = Number((await c.db.query('SELECT rate_at($1, $2) AS r', [currency, date])).rows[0].r);
    if (!rate) throw new Error(`${currency} kursi yo'q`);
  }
  const month = parseMonth(v('period'));
  const period = month ? `${date.slice(0, 4)}-${String(month).padStart(2, '0')}-01` : null;
  const partiya = v('partiya').trim();
  const orderId = partiya ? cache.orders.get(normHeader(partiya)) ?? null : null;
  const note = [v('detal').trim(), v('izoh').trim(), v('izoh2').trim(), partiya && !orderId ? `Partiya: ${partiya}` : ''].filter(Boolean).join(' · ') || null;
  await c.db.query(
    `INSERT INTO cash_entries (entry_date, wallet_id, op_type_id, center_id, item_id, counterparty, department, responsible, note, currency, rate,
       amount_in, amount_out, period, order_id, import_batch_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      date, wallet, op, center, item, v('counterparty').trim() || null, v('department').trim() || null, v('responsible').trim() || null, note,
      currency, rate, Math.round(amountIn * 100) / 100, Math.round(amountOut * 100) / 100, period, orderId, c.batchId, c.ctx.userId,
    ],
  );
  c.res.created++;
}

// ---------- Endpoint ----------
importRouter.post('/:kind', async (req, res) => {
  const ctx = ctxOf(req);
  const kind = z.enum(['employees', 'salaries', 'work_types', 'cash']).parse(req.params.kind);
  const b = z
    .object({
      text: z.string().min(1).max(20_000_000).optional(),
      gz: z.string().min(1).max(20_000_000).optional(), // brauzerda gzip bilan siqilgan matn (base64) — tashqi nginx chegarasidan o'tish uchun
      dry_run: z.boolean().default(true),
      department_id: idParam.nullish(),
      business: z.enum(['moliya', 'tijorat', 'ishlab']).optional(),
      label: z.string().trim().max(200).optional(),
    })
    .parse(req.body);
  let text = b.text ?? '';
  if (b.gz) {
    try {
      text = gunzipSync(Buffer.from(b.gz, 'base64'), { maxOutputLength: 60_000_000 }).toString('utf8');
    } catch {
      throw badRequest('Siqilgan matnni ochib bo\'lmadi');
    }
  }
  if (!text.trim()) throw badRequest('Matn bo\'sh — jadvaldan nusxalab joylashtiring');
  const spec = FIELDS[kind];
  const rows = parseTsv(text);
  const found = mapHeaders(rows, spec.fields, spec.required);
  if (!found) {
    throw badRequest(`Sarlavha qatori topilmadi — jadvaldan sarlavhasi bilan nusxalang. Kerakli ustunlar: ${spec.required.map((f) => spec.fields[f][0]).join(', ')}`);
  }
  const data = rows.slice(found.headerRow + 1);
  if (data.length > 50000) throw badRequest('Bir martada ko\'pi bilan 50 000 qator');
  const res0: Result = { created: 0, updated: 0, skipped: 0, errors: [], warnings: [] };
  let batchId = 0;
  try {
    await tx(async (db) => {
      if (kind === 'work_types' && b.department_id && !(await db.query('SELECT 1 FROM hr_departments WHERE id = $1', [b.department_id])).rowCount) throw notFound('Bo\'lim');
      batchId = (await db.query('INSERT INTO import_batches (kind, label, rows_total, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [kind, b.label || null, data.length, ctx.userId])).rows[0].id;
      const c: Ctx = { db, ctx, batchId, opts: { department_id: b.department_id, business: b.business }, res: res0 };
      const cache = kind === 'cash' ? await cashCache(db) : null;
      for (const [i, r] of data.entries()) {
        const v: Cells = (f) => (found.map[f] != null ? (r[found.map[f]] ?? '') : '');
        await db.query('SAVEPOINT r');
        try {
          if (kind === 'employees') await employeeRow(c, v);
          else if (kind === 'salaries') await salaryRow(c, v);
          else if (kind === 'work_types') await workTypeRow(c, v);
          else await cashRow(c, v, cache!);
          await db.query('RELEASE SAVEPOINT r');
        } catch (e) {
          await db.query('ROLLBACK TO SAVEPOINT r');
          if (e instanceof AppError) throw e;
          res0.errors.push({ row: found.headerRow + i + 2, message: e instanceof Error ? e.message : String(e) });
        }
      }
      if (res0.errors.length && kind === 'cash') {
        // kassa yarim-yorti import qilinmaydi: xatosi bor qatorlar tuzatilib, butunlay qayta yuboriladi
        throw new DryRun();
      }
      await db.query('UPDATE import_batches SET created = $2, summary = $3 WHERE id = $1', [batchId, res0.created, JSON.stringify({ ...res0, errors: res0.errors.length })]);
      await audit(db, ctx, 'import', batchId, kind, undefined, { rows: data.length, created: res0.created, updated: res0.updated, errors: res0.errors.length });
      if (b.dry_run) throw new DryRun();
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    const saved = !b.dry_run && !(res0.errors.length && kind === 'cash');
    return void res.json({ ...res0, saved, rows: data.length, header_row: found.headerRow + 1, batch_id: null, errors: res0.errors.slice(0, 200), error_count: res0.errors.length });
  }
  res.json({ ...res0, saved: true, rows: data.length, header_row: found.headerRow + 1, batch_id: batchId, errors: res0.errors.slice(0, 200), error_count: res0.errors.length });
});

importRouter.get('/batches', async (_req, res) => {
  res.json(
    (
      await pool.query(
        `SELECT b.*, u.full_name AS created_by_name,
                (SELECT count(*)::int FROM cash_entries e WHERE e.import_batch_id = b.id) AS cash_rows
           FROM import_batches b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 100`,
      )
    ).rows.map((r) => ({ ...r, kind_label: LABEL[r.kind as Kind] })),
  );
});

/** Kassa importini bekor qilish — shu partiyadagi barcha kassa yozuvlari o'chadi */
importRouter.delete('/batches/:id', async (req, res) => {
  const ctx = ctxOf(req);
  const id = idParam.parse(req.params.id);
  const n = await tx(async (db) => {
    const bt = (await db.query('SELECT * FROM import_batches WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!bt) throw notFound('Import');
    if (bt.kind !== 'cash') throw badRequest('Faqat kassa importi bekor qilinadi (xodim, oylik, ish turlari — o\'z sahifasida tahrirlanadi)');
    const del = (await db.query('DELETE FROM cash_entries WHERE import_batch_id = $1', [id])).rowCount ?? 0;
    await db.query('DELETE FROM import_batches WHERE id = $1', [id]);
    await audit(db, ctx, 'import', id, 'undo', bt, { deleted: del });
    return del;
  });
  res.json({ deleted: n });
});
