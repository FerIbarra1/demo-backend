-- F15 (sep 2026): marcas de agua de lectura del chat (modelo WhatsApp/Telegram).
-- Se aplican a mano porque el proyecto usa `db push` (ver prisma/sql/f13_propuesta_pendiente_unica.sql).
--
-- Por qué watermarks por ID de mensaje y NO por timestamp:
--   * PedidoMensaje.id es autoincrement monótono y clock-free (no deriva entre instancias).
--   * createdAt es timestamp(3) con colisiones de ms posibles y deriva entre réplicas.
--   * Comparar `m.id <= watermark` es O(1) y estable sin importar el reloj.
--
-- Hay UN asesor por tienda, así que el watermark "tienda" representa "el lado tienda leyó",
-- no "este usuario leyó". Si algún día hay varios asesores por tienda, migrar a una tabla
-- PedidoChatLectura con (userId, pedidoId, ultimoMensajeLeidoId).
--
-- cliente_ultimo_mensaje_entregado_id: el cliente recibió el último eco del socket.
--   No se persiste via REST; el cliente lo bumpea al recibir el eco, idempotente.
-- cliente_ultimo_mensaje_leido_id: el cliente abrió el detalle con foco, persisto via REST.
-- tienda_ultimo_mensaje_leido_id: alguien del lado tienda abrió el detalle con foco.

ALTER TABLE "pedidos" ADD COLUMN IF NOT EXISTS "cliente_ultimo_mensaje_entregado_id" INTEGER;
ALTER TABLE "pedidos" ADD COLUMN IF NOT EXISTS "cliente_ultimo_mensaje_leido_id"     INTEGER;
ALTER TABLE "pedidos" ADD COLUMN IF NOT EXISTS "tienda_ultimo_mensaje_leido_id"     INTEGER;
