-- Oct 2026: las transferencias ya no tienen plazo de vigencia (decisión del dueño, 17-oct).
--
-- Había un `vence_at` (48 h por defecto) que nadie entendía y que no cerraba nada solo: el
-- vencimiento ya era MANUAL, pero la fecha seguía saliendo en pantallas y correos como si fuera un
-- plazo. Ahora no hay fecha límite: Tesorería ve cuánto lleva esperando cada pago (se calcula con
-- `created_at`) y marca "vencida" cuando lo decide.
--
-- DESTRUCTIVA a propósito: se pierde la fecha de vigencia de los pagos existentes (eran de prueba).
-- Los eventos del pago que guardaron `venceAt` en su `detalle` JSON no se tocan.
--
-- `TRANSFERENCIA_POR_VENCER` nunca tuvo quien lo despachara y hablaba de un plazo que ya no existe.
-- Postgres no puede quitar un valor de un enum: se recrea el tipo (generado con `prisma migrate
-- diff`). Falla si alguna notificación lo usa, y no debe haber ninguna porque nadie lo envió.

-- AlterEnum
BEGIN;
CREATE TYPE "TipoNotificacion_new" AS ENUM ('PEDIDO_RECIBIDO', 'LISTO_EN_TIENDA', 'REVISION_PROPUESTA', 'REVISION_APROBADA', 'REVISION_RECHAZADA', 'PAGO_CONFIRMADO', 'ENVIADO', 'ENTREGADO', 'CANCELADO', 'MENSAJE_BODEGUERO', 'RESET_PASSWORD', 'BIENVENIDA', 'ASESOR_SOLICITADO', 'PROPUESTA_VENTAS', 'RECORDATORIO_RECOGER', 'TRANSFERENCIA_INSTRUCCIONES', 'TRANSFERENCIA_COMPROBANTE_RECIBIDO', 'TRANSFERENCIA_VERIFICADA', 'TRANSFERENCIA_RECHAZADA', 'TRANSFERENCIA_REEMBOLSADA', 'DTF_RECIBIDO', 'DTF_NECESITA_CORRECCION', 'DTF_APROBADO', 'DTF_RECHAZADO');
ALTER TABLE "notificaciones" ALTER COLUMN "tipo" TYPE "TipoNotificacion_new" USING ("tipo"::text::"TipoNotificacion_new");
ALTER TYPE "TipoNotificacion" RENAME TO "TipoNotificacion_old";
ALTER TYPE "TipoNotificacion_new" RENAME TO "TipoNotificacion";
DROP TYPE "public"."TipoNotificacion_old";
COMMIT;

-- DropIndex
DROP INDEX "pedidos_pagos_transferencia_estado_vence_at_idx";

-- AlterTable
ALTER TABLE "pedidos_pagos_transferencia" DROP COLUMN "vence_at";
