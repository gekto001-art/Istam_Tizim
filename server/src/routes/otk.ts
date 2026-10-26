import { Router } from 'express';
import { z } from 'zod';
import { ctxOf, requireAction } from '../auth/context.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam } from '../lib/util.js';

/**
 * OTK (tayyor mahsulot) va tayyor mahsulot skladi:
 *  - tsex tikkan har yozuv (Ish/Chiq GP) — 1 sort + 2 sort + yaroqsiz = tikilgan son;
 *  - 1 va 2 sort tayyor mahsulot skladiga kiradi;
 *  - yaroqsiz spisat — tannarxi bo'yicha P&L xarajat.
 * Tannarx (1 dona) = kroydagi mato sarfi ÷ kesilgan son (partiya, rang, razmer)
 *                  + shu yozuvning furnitura sarfi ÷ tikilgan son + zakazdagi ish narxlari yig'indisi.
 * Spisaniya ro'yxatida bichuvdagi yaroqsiz (OTK Brak) ham ko'rinadi.
 */
export const otkRouter = Router();
otkRouter.use(requireAction('fg.read'));

const date = z.coerce.date().transform((d) => d.toISOString().slice(0, 10));
const int = z.coerce.number().int();
const r2 = (v: number) => Math.round(v * 100) / 100;

const OUTPUTS = `
  SELECT o.id, d.id AS doc_id, d.out_date, d.created_at, d.issue_no, d.order_id, od.partiya_no, pt.name AS product_type_name, od.artikul, od.model,
         d.producer_id, pr.name AS producer_name, o.color_id, c.name AS color_name, o.size_id, s.name AS size_name, o.fact_qty,
         o.otk_date, o.otk_sort1, o.otk_sort2, o.otk_scrap, o.unit_cost_uzs, o.scrap_cost_uzs, u.full_name AS otk_by_name
    FROM tsex_outputs o JOIN tsex_docs d ON d.id = o.doc_id JOIN orders od ON od.id = d.order_id JOIN product_types pt ON pt.id = od.product_type_id
    JOIN producers pr ON pr.id = d.producer_id JOIN colors c ON c.id = o.color_id JOIN sizes s ON s.id = o.size_id
    LEFT JOIN users u ON u.id = o.otk_by`;

otkRouter.get('/outputs', async (req, res) => {
  const q = z
    .object({ status: z.enum(['pending', 'done']).default('pending'), order_id: idParam.optional(), limit: z.coerce.number().int().min(1).max(5000).default(1000) })
    .parse(req.query);
  const rows = (
    await pool.query(
      `${OUTPUTS} WHERE o.otk_at IS ${q.status === 'pending' ? '' : 'NOT'} NULL AND ($1::int IS NULL OR d.order_id = $1)
        ORDER BY ${q.status === 'pending' ? 'd.out_date, o.id' : 'o.otk_at DESC, o.id DESC'} LIMIT $2`,
      [q.order_id ?? null, q.limit],
    )
  ).rows;
  res.json(rows);
});

/** 1 dona tannarxi (so'm) */
async function unitCost(db: Db, outputId: number) {
  const r = (
    await db.query(
      `SELECT o.fact_qty,
              (SELECT sum(m.cost_uzs) FROM tsex_materials m WHERE m.output_id = o.id) AS furn,
              (SELECT sum(km.cost_uzs) FROM kroy_cut_materials km JOIN kroy_cut_items ki ON ki.id = km.item_id JOIN kroy_cuts k ON k.id = ki.cut_id
                WHERE k.order_id = d.order_id AND ki.color_id = o.color_id AND ki.size_id = o.size_id) AS mato,
              (SELECT sum(ki.fact_qty) FROM kroy_cut_items ki JOIN kroy_cuts k ON k.id = ki.cut_id
                WHERE k.order_id = d.order_id AND ki.color_id = o.color_id AND ki.size_id = o.size_id) AS cut_qty,
              (SELECT coalesce(sum(w.price), 0) FROM order_works w WHERE w.order_id = d.order_id) AS work
         FROM tsex_outputs o JOIN tsex_docs d ON d.id = o.doc_id WHERE o.id = $1`,
      [outputId],
    )
  ).rows[0];
  const mato = r.mato && Number(r.cut_qty) ? Number(r.mato) / Number(r.cut_qty) : 0;
  const furn = r.furn ? Number(r.furn) / r.fact_qty : 0;
  return { mato, furn, work: Number(r.work), total: r2(mato + furn + Number(r.work)) };
}

otkRouter.post('/outputs', requireAction('otk.write'), async (req, res) => {
  const ctx = ctxOf(req);
  const b = z
    .object({
      otk_date: date,
      rows: z
        .array(z.object({ output_id: idParam, sort1: int.min(0).max(1e7), sort2: int.min(0).max(1e7), scrap: int.min(0).max(1e7) }))
        .min(1)
        .max(1000),
    })
    .parse(req.body);
  const data = await tx(async (db) => {
    let scrap = 0;
    for (const r of b.rows) {
      const o = (
        await db.query('SELECT o.*, d.order_id FROM tsex_outputs o JOIN tsex_docs d ON d.id = o.doc_id WHERE o.id = $1 FOR UPDATE OF o', [r.output_id])
      ).rows[0];
      if (!o) throw notFound('Ishlab chiqarish yozuvi');
      if (o.otk_at) throw conflict(`ID ${r.output_id}: OTK allaqachon tekshirgan`);
      if (r.sort1 + r.sort2 + r.scrap !== o.fact_qty) {
        throw badRequest(`ID ${r.output_id}: 1 sort + 2 sort + yaroqsiz tikilgan miqdorga (${o.fact_qty}) teng bo'lishi kerak — Ostatka 0`);
      }
      const cost = await unitCost(db, r.output_id);
      const scrapCost = r2(r.scrap * cost.total);
      scrap += scrapCost;
      await db.query(
        `UPDATE tsex_outputs SET otk_date = $2, otk_sort1 = $3, otk_sort2 = $4, otk_scrap = $5, unit_cost_uzs = $6, scrap_cost_uzs = $7,
                otk_by = $8, otk_at = now() WHERE id = $1`,
        [r.output_id, b.otk_date, r.sort1, r.sort2, r.scrap, cost.total, scrapCost, ctx.userId],
      );
      for (const [sort, qty] of [[1, r.sort1], [2, r.sort2]] as const) {
        if (!qty) continue;
        await db.query(
          `INSERT INTO fg_moves (move_date, kind, order_id, color_id, size_id, sort, dir, qty, unit_cost_uzs, output_id, created_by)
           VALUES ($1, 'otk', $2, $3, $4, $5, 1, $6, $7, $8, $9)`,
          [b.otk_date, o.order_id, o.color_id, o.size_id, sort, qty, cost.total, r.output_id, ctx.userId],
        );
      }
    }
    await audit(db, ctx, 'otk_final', b.rows[0].output_id, 'otk', undefined, b);
    return { saved: b.rows.length, scrap_cost_uzs: r2(scrap).toFixed(2) };
  });
  res.json(data);
});

// ---------- Tayyor mahsulot skladi ----------
otkRouter.get('/stock', async (req, res) => {
  const q = z.object({ order_id: idParam.optional() }).parse(req.query);
  const rows = (
    await pool.query(
      `SELECT m.order_id, o.partiya_no, pt.name AS product_type_name, o.artikul, o.model, m.color_id, c.name AS color_name, m.size_id, s.name AS size_name,
              coalesce(sum(m.dir * m.qty) FILTER (WHERE m.sort = 1), 0)::int AS sort1,
              coalesce(sum(m.dir * m.qty) FILTER (WHERE m.sort = 2), 0)::int AS sort2,
              sum(m.dir * m.qty)::int AS total,
              round(sum(m.qty * m.unit_cost_uzs) FILTER (WHERE m.dir = 1) / nullif(sum(m.qty) FILTER (WHERE m.dir = 1), 0), 2) AS avg_cost
         FROM fg_moves m JOIN orders o ON o.id = m.order_id JOIN product_types pt ON pt.id = o.product_type_id
         JOIN colors c ON c.id = m.color_id JOIN sizes s ON s.id = m.size_id
        WHERE ($1::int IS NULL OR m.order_id = $1)
        GROUP BY m.order_id, o.partiya_no, pt.name, o.artikul, o.model, m.color_id, c.name, m.size_id, s.name, s.sort
       HAVING sum(m.dir * m.qty) <> 0
        ORDER BY m.order_id DESC, lower(c.name), s.sort`,
      [q.order_id ?? null],
    )
  ).rows;
  res.json(rows);
});

// ---------- Spisaniya (yaroqsiz — P&L xarajat) ----------
otkRouter.get('/writeoffs', async (req, res) => {
  const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
  const rows = (
    await pool.query(
      `SELECT * FROM (
         SELECT 'kroy' AS source, b.sort_date AS date, k.order_id, o.partiya_no, pt.name AS product_type_name, c.name AS color_name, s.name AS size_name,
                b.scrap AS qty, round(b.scrap_cost_uzs / nullif(b.scrap, 0), 2) AS unit_cost_uzs, b.scrap_cost_uzs AS amount_uzs, i.id AS ref_id
           FROM kroy_brak_sorts b JOIN kroy_cut_items i ON i.id = b.item_id JOIN kroy_cuts k ON k.id = i.cut_id
           JOIN orders o ON o.id = k.order_id JOIN product_types pt ON pt.id = o.product_type_id JOIN colors c ON c.id = i.color_id JOIN sizes s ON s.id = i.size_id
          WHERE b.scrap > 0
         UNION ALL
         SELECT 'otk', t.otk_date, d.order_id, o.partiya_no, pt.name, c.name, s.name, t.otk_scrap, t.unit_cost_uzs, t.scrap_cost_uzs, t.id
           FROM tsex_outputs t JOIN tsex_docs d ON d.id = t.doc_id JOIN orders o ON o.id = d.order_id JOIN product_types pt ON pt.id = o.product_type_id
           JOIN colors c ON c.id = t.color_id JOIN sizes s ON s.id = t.size_id
          WHERE t.otk_scrap > 0
       ) w WHERE ($1::date IS NULL OR w.date >= $1) AND ($2::date IS NULL OR w.date <= $2)
       ORDER BY w.date DESC, w.ref_id DESC`,
      [q.from ?? null, q.to ?? null],
    )
  ).rows;
  res.json(rows);
});
