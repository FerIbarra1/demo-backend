-- Jul 2026: Eliminar el estado PREPARING_SHIPMENT del flujo de pedidos.
--   - Antes: PAID → PREPARING_SHIPMENT → SHIPPED → COMPLETED
--   - Ahora: PAID → SHIPPED (sólo domicilio) o PAID → COMPLETED (kiosko/web-recoger)
--
-- El estado PREPARING_SHIPMENT nunca llegó a usarse en producción real (no hay
-- pedidos en ese estado en la BD), por lo que se puede quitar sin perder datos.
-- Si por alguna razón existieran pedidos huérfanos en PREPARING_SHIPMENT, se
-- migran a SHIPPED para que el flujo pueda continuar (un admin puede corregirlos
-- después manualmente).
--
-- También se elimina EN_PREPARACION de TipoNotificacion por la misma razón.

-- Defensa: si hay pedidos en PREPARING_SHIPMENT, migrarlos a SHIPPED para no
-- perderlos. El admin puede corregirlos manualmente si hace falta.
UPDATE "Pedido"
SET estado = 'SHIPPED'
WHERE estado = 'PREPARING_SHIPMENT';

-- Recrear el enum EstadoPedido sin PREPARING_SHIPMENT.
ALTER TYPE "EstadoPedido" RENAME TO "EstadoPedido_old";
CREATE TYPE "EstadoPedido" AS ENUM (
  'PENDING_REVIEW',
  'REVIEWING',
  'WAITING_CUSTOMER_APPROVAL',
  'APPROVED',
  'PENDING_PAID',
  'PAID',
  'SHIPPED',
  'COMPLETED',
  'CANCELLED'
);
ALTER TABLE "Pedido"
  ALTER COLUMN estado DROP DEFAULT,
  ALTER COLUMN estado TYPE "EstadoPedido" USING estado::text::"EstadoPedido",
  ALTER COLUMN estado SET DEFAULT 'PENDING_REVIEW';
DROP TYPE "EstadoPedido_old";

-- Recrear el enum TipoNotificacion sin EN_PREPARACION.
ALTER TYPE "TipoNotificacion" RENAME TO "TipoNotificacion_old";
CREATE TYPE "TipoNotificacion" AS ENUM (
  'PEDIDO_RECIBIDO',
  'REVISION_PROPUESTA',
  'REVISION_APROBADA',
  'REVISION_RECHAZADA',
  'PAGO_CONFIRMADO',
  'ENVIADO',
  'ENTREGADO',
  'CANCELADO'
);
ALTER TABLE "Notificacion"
  ALTER COLUMN tipo DROP DEFAULT,
  ALTER COLUMN tipo TYPE "TipoNotificacion" USING tipo::text::"TipoNotificacion",
  ALTER COLUMN tipo SET DEFAULT 'PEDIDO_RECIBIDO';
DROP TYPE "TipoNotificacion_old";
