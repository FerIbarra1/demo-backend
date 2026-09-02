-- CreateEnum
CREATE TYPE "EstadoPropuesta" AS ENUM ('PENDIENTE', 'ACEPTADA', 'RECHAZADA');

-- AlterTable
ALTER TABLE "pedidos" ADD COLUMN     "bodega_turno_desde_at" TIMESTAMP(3),
ADD COLUMN     "tiempo_atencion_bodega_ms" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "pedidos_propuestas" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "estado" "EstadoPropuesta" NOT NULL DEFAULT 'PENDIENTE',
    "items" JSON NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "nota" TEXT,
    "creada_por_id" INTEGER NOT NULL,
    "enviada_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondida_at" TIMESTAMP(3),
    "forzada_por_id" INTEGER,
    "forzada_at" TIMESTAMP(3),

    CONSTRAINT "pedidos_propuestas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pedidos_propuestas_pedido_id_estado_idx" ON "pedidos_propuestas"("pedido_id", "estado");

-- AddForeignKey
ALTER TABLE "pedidos_propuestas" ADD CONSTRAINT "pedidos_propuestas_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_propuestas" ADD CONSTRAINT "pedidos_propuestas_creada_por_id_fkey" FOREIGN KEY ("creada_por_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_propuestas" ADD CONSTRAINT "pedidos_propuestas_forzada_por_id_fkey" FOREIGN KEY ("forzada_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
