-- ============================================================
-- drop_lada_and_cliente_whatsapp
-- ============================================================
-- Concatena lada + telefono en un solo telefono E.164 y dropea
-- la columna lada. Dropea cliente_whatsapp de pedidos (sin
-- migrar: ya no se usa, todas las pantallas migran a clienteTelefono).
--
-- Orden importante: el UPDATE debe ejecutarse ANTES del DROP de
-- lada, o la concatenación fallaría con "column does not exist".
-- ============================================================

-- 1) Concatenar lada + telefono en usuarios.
--    COALESCE maneja los casos donde lada o telefono sean NULL.
--    TRIM elimina espacios accidentales en datos legacy.
UPDATE "usuarios"
SET "telefono" = TRIM(COALESCE(lada, '')) || TRIM(COALESCE(telefono, ''))
WHERE lada IS NOT NULL
  AND telefono IS NOT NULL
  AND lada <> '';

-- 2) Dropear lada.
ALTER TABLE "usuarios" DROP COLUMN "lada";

-- 3) Dropear cliente_whatsapp de pedidos.
ALTER TABLE "pedidos" DROP COLUMN "cliente_whatsapp";
