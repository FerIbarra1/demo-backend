-- F16 (sep 2026): el pedido pasa por mostrador ANTES de pagar.
--
-- Estado nuevo `EN_MOSTRADOR`: bodega ya verificó físicamente los productos y
-- el pedido está apartado, esperando que el cliente lo revise en tienda. Es el
-- "pedido retenido" del negocio, ahora explícito en el modelo.
--
-- Se agregó al FINAL del enum a propósito: nada ordena por `EstadoPedido` en
-- SQL (el orden de presentación vive en el frontend), y agregar al final evita
-- cualquier reescritura de la columna.
--
-- `ALTER TYPE ... ADD VALUE` no puede correr dentro de una transacción en
-- Postgres < 12. Prisma ejecuta cada migración en su propia transacción, así
-- que si el servidor es antiguo esta migración falla con:
--   "ALTER TYPE ... ADD cannot run inside a transaction block"
-- Postgres 12+ (el proyecto usa 18-alpine) sí lo soporta.
--
-- OJO: el orden respecto al deploy importa — el código nuevo no puede correr
-- antes de que este valor exista en la BD.

ALTER TYPE "EstadoPedido" ADD VALUE 'EN_MOSTRADOR';
