-- F22 (oct 2026): la cola de mostrador justa, el mostrador que llama y los
-- pedidos sin recoger.
--
-- Tres problemas, una migración (comparten la tabla `pedidos`):
--
-- 1. ORDEN DE LA COLA. Se ordenaba por `llegada_anunciada_at nulls last`: un
--    pedido de kiosko no tiene aviso, así que TODO web con aviso pasaba delante
--    de cualquier kiosko aunque llevara media hora esperando. `presente_desde_at`
--    es la llave de orden única: la hora del pedido (kiosko) o del aviso (web).
--
-- 2. MOSTRADORES. Igual que las ventanillas del cajero: el admin define cuántos
--    hay y el operador elige en cuál trabaja. La TV dice "Pasa al mostrador N".
--    Es una tabla APARTE de `ventanillas` a propósito: las queries del cajero
--    listan todas las ventanillas de la tienda, y un discriminador `tipo` habría
--    colado los mostradores en su selector.
--
-- 3. PEDIDOS SIN RECOGER. `espera_cliente_desde_at` mide cuánto lleva la bolsa
--    apartada esperando al cliente; de ahí salen el recordatorio "¿aún lo
--    quieres?" y la lista de vencidos que el mostrador puede cancelar.

-- AlterEnum
ALTER TYPE "TipoNotificacion" ADD VALUE 'RECORDATORIO_RECOGER';

-- AlterTable
ALTER TABLE "pedidos"
  ADD COLUMN "presente_desde_at"        TIMESTAMP(3),
  ADD COLUMN "llegada_descartes"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "llamado_por_id"           INTEGER,
  ADD COLUMN "llamado_mostrador_id"     INTEGER,
  ADD COLUMN "llamadas_fallidas"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "espera_cliente_desde_at"  TIMESTAMP(3),
  ADD COLUMN "recordatorio_recoger_at"  TIMESTAMP(3),
  ADD COLUMN "interes_confirmado_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "mostradores" (
    "id" SERIAL NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "numero" INTEGER NOT NULL,
    "operador_id" INTEGER,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mostradores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mostradores_operador_id_key" ON "mostradores"("operador_id");
CREATE INDEX "mostradores_tienda_id_idx" ON "mostradores"("tienda_id");
CREATE UNIQUE INDEX "mostradores_tienda_id_numero_key" ON "mostradores"("tienda_id", "numero");
CREATE INDEX "pedidos_tienda_id_estado_presente_desde_at_idx"
  ON "pedidos"("tienda_id", "estado", "presente_desde_at");
CREATE INDEX "pedidos_estado_espera_cliente_desde_at_idx"
  ON "pedidos"("estado", "espera_cliente_desde_at");

-- AddForeignKey
ALTER TABLE "mostradores" ADD CONSTRAINT "mostradores_tienda_id_fkey"
  FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mostradores" ADD CONSTRAINT "mostradores_operador_id_fkey"
  FOREIGN KEY ("operador_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_llamado_por_id_fkey"
  FOREIGN KEY ("llamado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_llamado_mostrador_id_fkey"
  FOREIGN KEY ("llamado_mostrador_id") REFERENCES "mostradores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: los pedidos que HOY están en la cola conservan su lugar.
--   KIOSKO → la hora del pedido (el cliente estaba en tienda al hacerlo).
--   WEB    → la hora de su aviso de llegada (si lo hay).
UPDATE "pedidos"
   SET "presente_desde_at" = "fecha_pedido"
 WHERE "canal_origen" = 'KIOSKO';

UPDATE "pedidos"
   SET "presente_desde_at" = "llegada_anunciada_at"
 WHERE "canal_origen" = 'WEB'
   AND "llegada_anunciada_at" IS NOT NULL;

-- Backfill: desde cuándo espera la bolsa al cliente = la última vez que el pedido
-- ENTRÓ al grupo "bolsa apartada" (REVISADO / ESPERANDO_APROBACION / EN_ATENCION)
-- desde fuera de él. Es la misma regla que aplica la máquina de estados: llamar o
-- devolver a la cola (moverse DENTRO del grupo) no reinicia la espera. Sin este
-- backfill, los pedidos que ya están en el área de entrega nacerían con antigüedad
-- NULL y el recordatorio nunca los vería.
UPDATE "pedidos" p
   SET "espera_cliente_desde_at" = COALESCE(
         (SELECT MAX(h."created_at")
            FROM "historial_pedidos" h
           WHERE h."pedido_id" = p."id"
             AND h."estado_nuevo" IN ('REVISADO', 'ESPERANDO_APROBACION', 'EN_ATENCION')
             AND h."estado_anterior" IS NOT NULL
             AND h."estado_anterior" NOT IN ('REVISADO', 'ESPERANDO_APROBACION', 'EN_ATENCION')),
         p."fecha_pedido")
 WHERE p."estado" IN ('REVISADO', 'ESPERANDO_APROBACION', 'EN_ATENCION');

-- Huérfanos: un pedido en EN_ATENCION (ya llamado) cuyo cliente NO está presente
-- (web que nunca avisó, o con el aviso descartado) es invisible: la consola y la TV
-- exigen cliente presente y `llamar` no lo comprobaba. Solo se encontraba con el
-- buscador. Se regresan a REVISADO, donde la lista "Sin aviso" sí los muestra.
-- Va DESPUÉS del backfill de la espera para que ese cálculo no vea la fila de
-- historial que se escribe aquí.
INSERT INTO "historial_pedidos" ("pedido_id", "estado_anterior", "estado_nuevo", "observacion", "usuario_nombre", "created_at")
SELECT p."id", 'EN_ATENCION', 'REVISADO',
       'Regresado a REVISADO por mantenimiento: estaba llamado sin que el cliente estuviera en la tienda',
       'Sistema', NOW()
  FROM "pedidos" p
 WHERE p."estado" = 'EN_ATENCION'
   AND (p."llegada_descartada_at" IS NOT NULL
        OR (p."canal_origen" = 'WEB' AND p."llegada_anunciada_at" IS NULL));

UPDATE "pedidos"
   SET "estado" = 'REVISADO', "llamado_at" = NULL
 WHERE "estado" = 'EN_ATENCION'
   AND ("llegada_descartada_at" IS NOT NULL
        OR ("canal_origen" = 'WEB' AND "llegada_anunciada_at" IS NULL));
