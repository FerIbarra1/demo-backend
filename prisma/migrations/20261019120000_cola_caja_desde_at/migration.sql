-- Oct 2026: `pedidos.cola_caja_desde_at` — desde cuándo el cliente espera su turno en la fila de caja.
--
-- El problema que arregla: la fila de caja se ordenaba por `fecha_pedido` (cuándo se HIZO el
-- pedido), no por cuándo llegó a caja. Un pedido web hecho a las 9:00 que mostrador mandó a pagar
-- a las 11:10 pasaba delante del cliente de kiosko que llegó a caja a las 11:05. Y no había forma
-- de mandar al final de la fila a quien no se presenta: "Devolver a la cola" lo dejaba primero y
-- "Llamar siguiente" lo volvía a llamar, y otra vez.
--
-- ADITIVA y nullable. Se rellena para los pedidos que YA están en la fila (PENDIENTE_PAGO) con la
-- hora en que entraron a ese estado según su historial (o, si no hay historial, la del pedido),
-- para que el despliegue no reordene a nadie que ya está esperando. Fuera de PENDIENTE_PAGO la
-- columna queda en NULL: no significa nada.
ALTER TABLE "pedidos"
    ADD COLUMN "cola_caja_desde_at" TIMESTAMP(3);

UPDATE "pedidos" p
SET "cola_caja_desde_at" = COALESCE(
    (
        SELECT MAX(h."created_at")
        FROM "historial_pedidos" h
        WHERE h."pedido_id" = p."id"
          AND h."estado_nuevo" = 'PENDIENTE_PAGO'
          AND h."estado_anterior" IS DISTINCT FROM 'PENDIENTE_PAGO'
    ),
    p."fecha_pedido"
)
WHERE p."estado" = 'PENDIENTE_PAGO';
