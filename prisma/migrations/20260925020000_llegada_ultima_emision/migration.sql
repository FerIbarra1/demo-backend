-- F16 (sep 2026): ancla del límite de tasa del aviso de llegada.
--
-- El anti-spam medía la ventana de reintento desde `llegada_ultimo_aviso_at`,
-- que se reescribe en CADA aviso. Un cliente que insistía más seguido que la
-- ventana (10 min) nunca la cumplía, así que su pedido quedaba sin alerta en la
-- TV del mostrador indefinidamente — y con el flujo nuevo la llegada es el gate
-- que hace aparecer el pedido en la cola.
--
-- Esta columna registra cuándo se EMITIÓ el último aviso (no cuándo llegó el
-- request), que es el ancla correcta.
--
-- Nullable y sin backfill: los pedidos existentes no tienen historial de
-- emisiones, así que arrancan con NULL — que el código interpreta como "puede
-- emitir" (el caso seguro).

ALTER TABLE "pedidos" ADD COLUMN "llegada_ultima_emision_at" TIMESTAMP(3);
