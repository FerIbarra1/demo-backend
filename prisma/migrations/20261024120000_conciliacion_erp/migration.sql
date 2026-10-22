-- Oct 2026: la conciliación activa nube ↔ Sistema Comercial (destrabar, etapa 3). Aditiva: una tabla y dos columnas.
--
--  * `conciliacion_hallazgos`: lo que el agente encuentra al comparar un pedido contra el ERP.
--  * `sync_checkpoints.ultima_conciliacion_*`: cuándo se comparó por última vez y cuántos pedidos se revisaron.

-- AlterTable
ALTER TABLE "sync_checkpoints" ADD COLUMN "ultima_conciliacion_at" TIMESTAMP(3),
ADD COLUMN "ultima_conciliacion_revisados" INTEGER;

-- CreateTable
CREATE TABLE "conciliacion_hallazgos" (
    "id" SERIAL NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "tipo" VARCHAR(40) NOT NULL,
    "detalle" JSONB,
    "curado" BOOLEAN NOT NULL DEFAULT false,
    "primera_vez_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultima_vez_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resuelto_at" TIMESTAMP(3),

    CONSTRAINT "conciliacion_hallazgos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conciliacion_hallazgos_tienda_id_resuelto_at_idx" ON "conciliacion_hallazgos"("tienda_id", "resuelto_at");

-- CreateIndex
CREATE INDEX "conciliacion_hallazgos_pedido_id_idx" ON "conciliacion_hallazgos"("pedido_id");

-- UNA fila ABIERTA por pedido y tipo. Prisma no expresa un índice único parcial: va a mano (como el de las tareas del
-- Sistema Comercial). Una fila ya resuelta no cuenta: el mismo problema puede volver a aparecer.
CREATE UNIQUE INDEX "conciliacion_hallazgos_abierto_unico_idx"
  ON "conciliacion_hallazgos"("pedido_id", "tipo") WHERE "resuelto_at" IS NULL;

-- AddForeignKey
ALTER TABLE "conciliacion_hallazgos" ADD CONSTRAINT "conciliacion_hallazgos_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conciliacion_hallazgos" ADD CONSTRAINT "conciliacion_hallazgos_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
