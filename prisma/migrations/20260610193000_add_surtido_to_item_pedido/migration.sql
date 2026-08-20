-- Surtido por item: el bodeguero marca cuánto encontró realmente y el estado
-- del surtido (PENDIENTE | PARCIAL | COMPLETO | NO_DISPONIBLE).
CREATE TYPE "EstadoSurtido" AS ENUM ('PENDIENTE', 'PARCIAL', 'COMPLETO', 'NO_DISPONIBLE');

ALTER TABLE "items_pedido" ADD COLUMN "cantidad_surtida" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "items_pedido" ADD COLUMN "estado_surtido" "EstadoSurtido" NOT NULL DEFAULT 'PENDIENTE';
ALTER TABLE "items_pedido" ADD COLUMN "surtido_at" TIMESTAMP(3);

-- Índice útil para queries del monitor / reportes (items pendientes de surtir)
CREATE INDEX "items_pedido_estado_surtido_idx" ON "items_pedido"("estado_surtido");
