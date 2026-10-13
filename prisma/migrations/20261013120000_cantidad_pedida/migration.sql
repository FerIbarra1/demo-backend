-- F19 (oct 2026): `cantidad_original` → `cantidad_pedida`.
--
-- RENAME, no add+drop: los datos ya son correctos en todas las filas. La
-- columna se escribe una sola vez (al crear el item, en `construirItemPedido`)
-- y ningún camino la muta, así que conserva la cantidad que el cliente pidió
-- incluso después de que bodega cierre el surtido y sobrescriba `cantidad`.
--
-- El nombre viejo describía un consumidor que ya no existe: el handler de
-- MOVPED que comparaba esta columna contra la cantidad reportada por Firebird
-- se eliminó cuando el pedido pasó a llegar al ERP con las cantidades ya
-- confirmadas por bodega (ver `pedido-pago.handler.ts`).
--
-- Sin cambio de tipo ni de semántica: sólo el nombre. Aditiva en el sentido de
-- que no pierde ni reinterpreta un solo dato.
ALTER TABLE "items_pedido"
    RENAME COLUMN "cantidad_original" TO "cantidad_pedida";
