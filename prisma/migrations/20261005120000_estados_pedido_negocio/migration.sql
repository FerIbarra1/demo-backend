-- F17 (oct 2026): los estados del pedido pasan a llamarse como los llama el
-- negocio, y se agrega EN_ATENCION (el operador atendiendo al cliente).
--
-- Por qué renombrar y no sólo cambiar las etiquetas de pantalla: el negocio
-- habla de "solicitado / en revisión / revisado (la plancha) / en mostrador",
-- y el código decía PENDING_REVIEW / REVIEWING / EN_MOSTRADOR. Cuando el
-- código y la pantalla dicen distinto, cada conversación sobre el flujo
-- necesita una traducción mental y los bugs se esconden en la traducción.
--
-- El estado NO se persiste en Firebird: el payload de descarga
-- (pedido-descarga.handler.ts) incluye el campo `estado`, pero el agente
-- (agent/src/down-processor.ts) nunca lo lee. Verificado con grep. Así que
-- este renombrado no toca la sincronización con el ERP.
--
-- Mapa:
--   PENDING_REVIEW            → SOLICITADO
--   REVIEWING                 → EN_REVISION
--   WAITING_CUSTOMER_APPROVAL → ESPERANDO_APROBACION
--   EN_MOSTRADOR              → REVISADO            (la PLANCHA, ya existía)
--   PENDING_PAID              → PENDIENTE_PAGO
--   PAID                      → PAGADO
--   SHIPPED                   → ENVIADO
--   COMPLETED                 → ENTREGADO
--   CANCELLED                 → CANCELADO
--   (nuevo)                     EN_ATENCION
--
-- EN_ASESORIA no cambia.
--
-- Nota sobre el nombre del estado nuevo: se llama EN_ATENCION y no
-- EN_MOSTRADOR a propósito. Si se llamara EN_MOSTRADOR, cualquier referencia
-- vieja que quedara sin migrar seguiría COMPILANDO y significaría lo
-- contrario (el operador atendiendo en vez de la plancha) — TypeScript no la
-- atraparía porque el string seguiría existiendo. Con un nombre nuevo, toda
-- referencia vieja rompe el build y el compilador enumera los sitios solo.

-- PostgreSQL no permite renombrar valores de un enum in-place en todas las
-- versiones; se recrea el tipo. El orden de los valores importa sólo para
-- `ORDER BY` sobre la columna, que no se usa en ningún query del proyecto.

BEGIN;

ALTER TYPE "EstadoPedido" RENAME TO "EstadoPedido_old";

CREATE TYPE "EstadoPedido" AS ENUM (
  'SOLICITADO',
  'EN_REVISION',
  'ESPERANDO_APROBACION',
  'EN_ASESORIA',
  'REVISADO',
  'EN_ATENCION',
  'PENDIENTE_PAGO',
  'PAGADO',
  'ENVIADO',
  'ENTREGADO',
  'CANCELADO'
);

-- pedidos.estado
ALTER TABLE "pedidos"
  ALTER COLUMN "estado" DROP DEFAULT,
  ALTER COLUMN "estado" TYPE "EstadoPedido"
    USING (
      CASE "estado"::text
        WHEN 'PENDING_REVIEW'            THEN 'SOLICITADO'
        WHEN 'REVIEWING'                 THEN 'EN_REVISION'
        WHEN 'WAITING_CUSTOMER_APPROVAL' THEN 'ESPERANDO_APROBACION'
        WHEN 'EN_MOSTRADOR'              THEN 'REVISADO'
        WHEN 'PENDING_PAID'              THEN 'PENDIENTE_PAGO'
        WHEN 'PAID'                      THEN 'PAGADO'
        WHEN 'SHIPPED'                   THEN 'ENVIADO'
        WHEN 'COMPLETED'                 THEN 'ENTREGADO'
        WHEN 'CANCELLED'                 THEN 'CANCELADO'
        ELSE "estado"::text
      END
    )::"EstadoPedido",
  ALTER COLUMN "estado" SET DEFAULT 'SOLICITADO';

-- historial_pedidos.estado_anterior (nullable)
ALTER TABLE "historial_pedidos"
  ALTER COLUMN "estado_anterior" TYPE "EstadoPedido"
    USING (
      CASE "estado_anterior"::text
        WHEN 'PENDING_REVIEW'            THEN 'SOLICITADO'
        WHEN 'REVIEWING'                 THEN 'EN_REVISION'
        WHEN 'WAITING_CUSTOMER_APPROVAL' THEN 'ESPERANDO_APROBACION'
        WHEN 'EN_MOSTRADOR'              THEN 'REVISADO'
        WHEN 'PENDING_PAID'              THEN 'PENDIENTE_PAGO'
        WHEN 'PAID'                      THEN 'PAGADO'
        WHEN 'SHIPPED'                   THEN 'ENVIADO'
        WHEN 'COMPLETED'                 THEN 'ENTREGADO'
        WHEN 'CANCELLED'                 THEN 'CANCELADO'
        ELSE "estado_anterior"::text
      END
    )::"EstadoPedido";

-- historial_pedidos.estado_nuevo
ALTER TABLE "historial_pedidos"
  ALTER COLUMN "estado_nuevo" TYPE "EstadoPedido"
    USING (
      CASE "estado_nuevo"::text
        WHEN 'PENDING_REVIEW'            THEN 'SOLICITADO'
        WHEN 'REVIEWING'                 THEN 'EN_REVISION'
        WHEN 'WAITING_CUSTOMER_APPROVAL' THEN 'ESPERANDO_APROBACION'
        WHEN 'EN_MOSTRADOR'              THEN 'REVISADO'
        WHEN 'PENDING_PAID'              THEN 'PENDIENTE_PAGO'
        WHEN 'PAID'                      THEN 'PAGADO'
        WHEN 'SHIPPED'                   THEN 'ENVIADO'
        WHEN 'COMPLETED'                 THEN 'ENTREGADO'
        WHEN 'CANCELLED'                 THEN 'CANCELADO'
        ELSE "estado_nuevo"::text
      END
    )::"EstadoPedido";

DROP TYPE "EstadoPedido_old";

COMMIT;

-- Índice parcial del panel "Atendiendo" de la TV de mostrador.
--
-- Antes el panel se derivaba de `llamado_at IS NOT NULL` (el índice
-- `pedidos_tienda_llamado_idx`). Con el estado EN_ATENCION el panel es un
-- WHERE sobre el estado, así que el índice se reemplaza por uno sobre
-- (tienda_id, estado) limitado a EN_ATENCION — el mismo patrón de índice
-- parcial que ya usa la llegada. `llamado_at` se conserva como dato de
-- auditoría (cuándo se llamó), pero ya no es el discriminador del panel.
DROP INDEX IF EXISTS "pedidos_tienda_llamado_idx";
CREATE INDEX IF NOT EXISTS "pedidos_tienda_atencion_idx"
  ON "pedidos" ("tienda_id", "estado")
  WHERE "estado" = 'EN_ATENCION';
