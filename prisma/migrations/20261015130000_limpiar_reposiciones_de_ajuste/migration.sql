-- Oct 2026: la lista de reposición es SOLO de pedidos cancelados o rechazados.
--
-- Hasta hoy un AJUSTE (de mostrador o de ventas) también creaba una entrada en
-- `pedidos_reposicion` por cada pieza que quitaba de la bolsa. Pero esas piezas
-- las saca el bodeguero y las regresa al anaquel él mismo mientras hace el
-- ajuste, así que la lista le pedía acomodar otra vez lo que ya acomodó. El
-- código que las creaba (`ReposicionService.crearDesdeAjuste`) se eliminó.
--
-- Esta migración borra las entradas que ya quedaron en la BD. Se identifican sin
-- ambigüedad: una reposición PENDIENTE de un pedido que NO está cancelado solo
-- pudo salir de un ajuste, porque `crearDesdePedido` corre en la misma
-- transacción que pasa el pedido a CANCELADO.
--
-- Qué NO toca, a propósito:
--   - las REPUESTO (historial de trabajo ya hecho por bodega);
--   - las de pedidos CANCELADOS: ahí no se puede distinguir si la entrada vino de
--     la cancelación o de un ajuste previo (el motivo de mostrador es texto libre),
--     y borrar una de cancelación real dejaría mercancía sin devolver.
--
-- Es DATOS, no esquema: no cambia ninguna tabla. Es una lista de trabajo derivada
-- (se puede reconstruir desde los items), no un registro contable.
DELETE FROM "pedidos_reposicion" r
USING "pedidos" p
WHERE r."pedido_id" = p."id"
  AND r."estado" = 'PENDIENTE'
  AND p."estado" <> 'CANCELADO';
