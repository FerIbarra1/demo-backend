-- Sincronización bidireccional: snapshot de cantidad original para distinguir
-- surtido completo vs parcial cuando MOVPED actualiza la cantidad.
--
-- Antes, PedidoPagoHandler.procesarMovped siempre marcaba el item como
-- COMPLETO, incluso cuando el bodeguero en VFP reducía la cantidad (ej. 5→3).
-- Con esta columna, comparamos la nueva cantidad contra la cantidad_original
-- que tenía el item al crear el pedido.

ALTER TABLE "items_pedido" ADD COLUMN "cantidad_original" INTEGER;

-- Backfill: para items existentes, asumimos que la cantidad actual ES la
-- cantidad original (no tenemos cómo reconstruirla). Esto significa que
-- items viejos siempre se evaluarán como "completos" al recibir MOVPED.
UPDATE "items_pedido" SET "cantidad_original" = "cantidad" WHERE "cantidad_original" IS NULL;

ALTER TABLE "items_pedido" ALTER COLUMN "cantidad_original" SET NOT NULL;
ALTER TABLE "items_pedido" ALTER COLUMN "cantidad_original" SET DEFAULT 0;
