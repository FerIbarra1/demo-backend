-- F16 (sep 2026): panel "Atendiendo" del monitor de mostrador.
--
-- Decisión de diseño: NO añadir un estado al enum EstadoPedido. "Atendiendo"
-- es ortogonal al ciclo de vida (el pedido sigue en EN_MOSTRADOR mientras el
-- operador lo revisa con el cliente) — meterlo como estado rompería la máquina
-- de transiciones y obligaría a inventar transiciones de ida y vuelta.
--
-- En su lugar, una columna en Pedido. `PedidoStateService.cambiarEstado` la
-- limpia automáticamente en cuanto el pedido sale de EN_MOSTRADOR, así que no
-- puede quedar un pedido "atendido" en PENDING_PAID/CANCELLED/etc.

ALTER TABLE "pedidos"
    ADD COLUMN "llamado_at" TIMESTAMP(3);

-- Índice parcial: el panel "Atendiendo" solo consulta pedidos EN_MOSTRADOR con
-- llamado_at no nulo, que son un puñado. Un índice completo sobre
-- (tienda_id, llamado_at) sería casi todo NULL y no aportaría nada.
CREATE INDEX "pedidos_tienda_llamado_idx"
    ON "pedidos" ("tienda_id", "llamado_at")
    WHERE "llamado_at" IS NOT NULL;
