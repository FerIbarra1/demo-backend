-- Oct 2026: `pedidos.recogio_nombre` — quién recogió el pedido cuando no es el titular.
--
-- A la tienda llegan mandaderos (los manda su patrón), familiares, gente que no es quien hizo el
-- pedido. Hasta ahora `entregar` no dejaba constancia de quién se llevó la mercancía. El operador de
-- mostrador captura el nombre al confirmar la entrega; NULL = lo recogió el titular (o es anterior a
-- este campo).
--
-- ADITIVA y nullable: sin nombre = comportamiento de siempre. No hay nada que rellenar.
ALTER TABLE "pedidos"
    ADD COLUMN "recogio_nombre" VARCHAR(150);
