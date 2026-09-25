-- Retención de terminales (RECLAMADO, CANCELADO, EXPIRADO) antes de purgar.
-- Necesita `updated_at` en la fila para saber cuándo terminó. Prisma lo
-- actualizará en cada UPDATE; DEFAULT now() para las 21 filas existentes.

ALTER TABLE "kiosko_pairings"
    ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Índice para que la purga sea eficiente: filtra por estado y
-- compara updated_at contra la ventana de retención.
CREATE INDEX "kiosko_pairings_estado_updated_at_idx"
    ON "kiosko_pairings"("estado", "updated_at");

-- `@updatedAt` es gestionado por Prisma, no por un DEFAULT de PostgreSQL.
-- El default solo se necesita durante el ADD COLUMN para filas existentes.
ALTER TABLE "kiosko_pairings"
    ALTER COLUMN "updated_at" DROP DEFAULT;
