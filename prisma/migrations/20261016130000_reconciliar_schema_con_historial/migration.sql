-- Oct 2026: reconcilia el HISTORIAL de migraciones con schema.prisma.
--
-- Reproducir el historial desde cero (shadow database de `migrate dev`, o una
-- BD nueva con `migrate deploy`) dejaba una BD distinta al schema. Estos huecos
-- estaban tapados porque la shadow database ni siquiera llegaba al final
-- (P3006 en `20260924000000_kiosko_pairing_updated_at`); al corregir eso
-- salieron todos juntos. Los de abajo ya existían en la BD de desarrollo
-- porque alguien los aplicó a mano o con `db push`, no por migración.
--
-- Todo es IDEMPOTENTE a propósito (IF EXISTS / IF NOT EXISTS, drop + create):
-- esta migración tiene que dejar igual a una BD que ya tiene algunos de estos
-- objetos (desarrollo), a una que tiene el historial puro (BD nueva) y a prod.
-- No toca datos.

-- 1. `kiosko_pairings.updated_at` sin DEFAULT.
--    `@updatedAt` lo gestiona Prisma, no la BD. `20260924000000` ya lo quita,
--    pero la BD de desarrollo nunca ejecutó esa migración (se baselineó con
--    `migrate resolve`) y conservaba el DEFAULT del CREATE TABLE.
ALTER TABLE "kiosko_pairings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- 2. `kioskos_device_token_hash_key`: único PLANO, no parcial.
--    `20260922230000` lo creó con `WHERE device_token_hash IS NOT NULL`, pero
--    `@unique` de Prisma no sabe expresar un WHERE, así que `migrate dev`
--    lo veía siempre como faltante y proponía crearlo de nuevo. El WHERE era
--    redundante: en PostgreSQL un índice único ya trata los NULL como
--    distintos, o sea que varios kioskos legacy sin token siguen conviviendo.
DROP INDEX IF EXISTS "kioskos_device_token_hash_key";
CREATE UNIQUE INDEX "kioskos_device_token_hash_key" ON "kioskos"("device_token_hash");

-- 3. Índices de `pedidos` que están en el schema y ninguna migración creaba.
CREATE INDEX IF NOT EXISTS "pedidos_tienda_id_llegada_anunciada_at_idx"
    ON "pedidos"("tienda_id", "llegada_anunciada_at");
CREATE INDEX IF NOT EXISTS "pedidos_tienda_id_llamado_at_idx"
    ON "pedidos"("tienda_id", "llamado_at");

-- 4. FKs de llegada: el schema pide ON UPDATE CASCADE (el default de Prisma) y
--    las migraciones las crearon sin él.
ALTER TABLE "pedidos" DROP CONSTRAINT IF EXISTS "pedidos_llegada_anunciada_kiosko_id_fkey";
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_llegada_anunciada_kiosko_id_fkey"
    FOREIGN KEY ("llegada_anunciada_kiosko_id") REFERENCES "kioskos"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "pedidos" DROP CONSTRAINT IF EXISTS "pedidos_llegada_descartada_por_id_fkey";
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_llegada_descartada_por_id_fkey"
    FOREIGN KEY ("llegada_descartada_por_id") REFERENCES "usuarios"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. `productos_imagenes.color_id`: ON DELETE RESTRICT.
--    `20261002220020_imagenes_requieren_color` pasó la columna a NOT NULL pero
--    dejó la FK en `ON DELETE SET NULL`. Antes de esto, borrar un color con
--    imágenes intentaba poner NULL en una columna NOT NULL y reventaba con un
--    error de not-null que no dice qué pasó; con RESTRICT falla por lo que es
--    (el color está en uso), igual que el schema (`onDelete: Restrict`).
ALTER TABLE "productos_imagenes" DROP CONSTRAINT IF EXISTS "productos_imagenes_color_id_fkey";
ALTER TABLE "productos_imagenes" ADD CONSTRAINT "productos_imagenes_color_id_fkey"
    FOREIGN KEY ("color_id") REFERENCES "colores"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
