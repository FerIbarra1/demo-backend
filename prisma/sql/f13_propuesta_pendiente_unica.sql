-- F13 (sep 2026): índice único PARCIAL para impedir propuestas PENDIENTE
-- apiladas sobre el mismo pedido.
--
-- Prisma no soporta índices parciales en el schema, así que vive aquí y hay
-- que aplicarlo a mano (el proyecto usa `db push`, no `migrate deploy`).
--
-- Por qué importa: `enviarPropuesta` valida "no apilar PENDIENTES" con un
-- read-then-write sin constraint. Ahora que BODEGA y VENTAS pueden proponer
-- sobre el mismo pedido, dos envíos concurrentes crearían dos PENDIENTES; el
-- cliente aprueba una por propuestaId y la otra queda zombi, renderizando una
-- card fantasma en el detalle del cliente.
CREATE UNIQUE INDEX IF NOT EXISTS "pedidos_propuestas_pendiente_unica_idx"
  ON "pedidos_propuestas" ("pedido_id")
  WHERE "estado" = 'PENDIENTE';
