CREATE UNIQUE INDEX IF NOT EXISTS "pedidos_propuestas_pendiente_unica_idx"
  ON "pedidos_propuestas" ("pedido_id")
  WHERE "estado" = 'PENDIENTE';

-- Índices parciales que Prisma no puede expresar en el schema (@@index no
-- soporta WHERE). Se formalizan aquí para que `migrate deploy` los aplique
-- en cualquier entorno nuevo; antes vivían sueltos en prisma/sql/ y había
-- que aplicarlos a mano (fuente de drift entre local y prod).
