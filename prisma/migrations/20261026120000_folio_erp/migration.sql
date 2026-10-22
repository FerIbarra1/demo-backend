-- Oct 2026 (parte B): el folio REAL del Sistema Comercial como ID del pedido.
--
-- Hasta hoy el folio solo existía en `pedidos_pendientes_envio.external_folio`, o sea DESPUÉS de mandar el pedido a
-- pagar, y el agente mandaba `numeroPedido.slice(0,10)` (todo pedido web quedaba con folio "PD-2026-00" en el ERP).
-- Ahora se toma del consecutivo del ERP cuando bodega cierra el surtido:
--   · `pedidos.folio_erp`           el folio (10 dígitos), único por tienda; NULL hasta que llega.
--   · `tiendas.serie`               TIENDAS.SERIE (HMO, MXL…): el prefijo visual.
--   · `pedido_folio_solicitudes`    la cola por la que la nube le pide el folio al agente (la nube no puede llamarlo).
-- No toca nada de Firebird.

-- AlterTable
ALTER TABLE "pedidos" ADD COLUMN "folio_erp" VARCHAR(10);

-- AlterTable
ALTER TABLE "tiendas" ADD COLUMN "serie" VARCHAR(10);

-- CreateTable
CREATE TABLE "pedido_folio_solicitudes" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "claimed_by" VARCHAR(100),
    "lease_token" VARCHAR(80),
    "lease_until" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "asignado_at" TIMESTAMP(3),

    CONSTRAINT "pedido_folio_solicitudes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pedido_folio_solicitudes_pedido_id_key" ON "pedido_folio_solicitudes"("pedido_id");

-- CreateIndex
CREATE INDEX "pedido_folio_solicitudes_tienda_id_estado_next_attempt_at_idx" ON "pedido_folio_solicitudes"("tienda_id", "estado", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "pedido_folio_solicitudes" ADD CONSTRAINT "pedido_folio_solicitudes_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Los pedidos que YA se grabaron en el ERP conservan su folio real. Solo los de 10 dígitos (los "PD-2026-00" que dejó el
-- agente anterior no son folios) y solo uno por (tienda, folio): el consecutivo del ERP no era único en datos viejos.
UPDATE "pedidos" p
   SET "folio_erp" = x."external_folio"
  FROM (
        SELECT e."pedido_id", e."external_folio",
               ROW_NUMBER() OVER (PARTITION BY pe."tienda_id", e."external_folio" ORDER BY e."pedido_id") AS n
          FROM "pedidos_pendientes_envio" e
          JOIN "pedidos" pe ON pe."id" = e."pedido_id"
         WHERE e."estado" = 'PROCESADO' AND e."external_folio" ~ '^[0-9]{10}$'
       ) x
 WHERE x."pedido_id" = p."id" AND x."n" = 1;

-- CreateIndex
CREATE UNIQUE INDEX "pedidos_tienda_folio_erp_key" ON "pedidos"("tienda_id", "folio_erp");
