-- Oct 2026: dos defectos del catálogo que solo aparecieron al sincronizar el Firebird REAL (el sistema que manda).
--
--  1. El SKU de `preciosco` era único en TODA la nube, pero el ERP lo repite en cada tienda (es el SKU de la variante: 1 025
--     distintos en 7 733 filas, ninguno repetido dentro de una misma tienda). Solo la primera tienda en sincronizar guardaba
--     el precio de una variante; las demás fallaban. Ahora es único por tienda. Relaja una restricción más estricta, así que
--     ningún dato existente puede violar la nueva.
--  2. El nombre del color: `COLORES.DESCRIP` mide 40 en Firebird y aquí 30; 44 colores reales no se creaban. Solo se ensancha.

-- DropIndex
DROP INDEX "preciosco_sku_key";

-- CreateIndex
CREATE UNIQUE INDEX "preciosco_tienda_id_sku_key" ON "preciosco"("tienda_id", "sku");

-- AlterTable
ALTER TABLE "colores" ALTER COLUMN "nombre" TYPE VARCHAR(40);

-- AlterTable
ALTER TABLE "items_pedido" ALTER COLUMN "color_nombre" TYPE VARCHAR(40);
