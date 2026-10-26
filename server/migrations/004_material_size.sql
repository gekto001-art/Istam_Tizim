-- 004: xomashyo normasi razmer × rang bo'yicha (Sheets "Zakazlar": Tayyor Mahsulot Razmer + Rangi).
-- size_id NULL — shu rangning barcha razmerlari uchun (masalan tugma hamma razmerga bir xil).

ALTER TABLE order_materials ADD COLUMN size_id int REFERENCES sizes;

-- Asosiy mato: bitta razmer × rang uchun bittadan (rang bo'yicha umumiy yoki razmer bo'yicha)
DROP INDEX order_materials_one_main;
CREATE UNIQUE INDEX order_materials_one_main ON order_materials (order_id, color_id, coalesce(size_id, 0)) WHERE is_main;

-- Qatordagi tayyor mahsulot soni: aniq razmer bo'lsa — shu katak, bo'lmasa — rangning jami
CREATE OR REPLACE FUNCTION order_material_qty(p_order int, p_color int, p_size int, p_actual boolean) RETURNS numeric
  LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_actual THEN
           CASE WHEN bool_and(actual_qty IS NOT NULL) THEN sum(actual_qty) END
         ELSE coalesce(sum(qty), 0) END
    FROM order_items
   WHERE order_id = p_order AND color_id = p_color AND (p_size IS NULL OR size_id = p_size)
$$;
