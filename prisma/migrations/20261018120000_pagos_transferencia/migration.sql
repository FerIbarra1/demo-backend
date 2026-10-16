-- Pagos por transferencia (oct 2026). Ver PLAN-PAGOS-TRANSFERENCIA.md.
--
-- 100% ADITIVA: no se quita ni se renombra nada. Solo agrega un rol, valores a un enum de
-- notificaciones, UNA columna nullable en `pedidos` y 4 tablas nuevas. La cola hacia Firebird
-- (`pedidos_pendientes_envio`), el agente y los triggers no se enteran.
--
-- CreateEnum
CREATE TYPE "MetodoPago" AS ENUM ('EN_TIENDA', 'TRANSFERENCIA');

-- CreateEnum
CREATE TYPE "EstadoPagoTransferencia" AS ENUM ('PENDIENTE', 'EN_REVISION', 'VERIFICADO', 'APLICADO', 'CANCELADO', 'VENCIDO', 'REEMBOLSO_PENDIENTE', 'REEMBOLSADO');

-- CreateEnum
CREATE TYPE "EstadoComprobante" AS ENUM ('PENDIENTE', 'ACEPTADO', 'RECHAZADO');

-- AlterEnum
ALTER TYPE "RolUsuario" ADD VALUE 'TESORERIA';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TipoNotificacion" ADD VALUE 'TRANSFERENCIA_INSTRUCCIONES';
ALTER TYPE "TipoNotificacion" ADD VALUE 'TRANSFERENCIA_COMPROBANTE_RECIBIDO';
ALTER TYPE "TipoNotificacion" ADD VALUE 'TRANSFERENCIA_VERIFICADA';
ALTER TYPE "TipoNotificacion" ADD VALUE 'TRANSFERENCIA_RECHAZADA';
ALTER TYPE "TipoNotificacion" ADD VALUE 'TRANSFERENCIA_POR_VENCER';
ALTER TYPE "TipoNotificacion" ADD VALUE 'TRANSFERENCIA_REEMBOLSADA';

-- AlterTable
ALTER TABLE "pedidos" ADD COLUMN     "metodo_pago_preferido" "MetodoPago";

-- CreateTable
CREATE TABLE "cuentas_bancarias" (
    "id" SERIAL NOT NULL,
    "tienda_id" INTEGER,
    "banco" VARCHAR(60) NOT NULL,
    "titular" VARCHAR(120) NOT NULL,
    "clabe" VARCHAR(18) NOT NULL,
    "cuenta" VARCHAR(20),
    "instrucciones" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cuentas_bancarias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedidos_pagos_transferencia" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "estado" "EstadoPagoTransferencia" NOT NULL DEFAULT 'PENDIENTE',
    "monto_esperado" DECIMAL(12,2) NOT NULL,
    "cuenta_snapshot" JSONB NOT NULL,
    "referencia" VARCHAR(7) NOT NULL,
    "concepto" VARCHAR(30) NOT NULL,
    "vence_at" TIMESTAMP(3) NOT NULL,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "requiere_revision" TEXT,
    "monto_verificado" DECIMAL(12,2),
    "abono_fecha" TIMESTAMP(3),
    "clave_rastreo" VARCHAR(40),
    "verificado_por_id" INTEGER,
    "verificado_at" TIMESTAMP(3),
    "nota_verificacion" TEXT,
    "aplicado_at" TIMESTAMP(3),
    "reembolso_monto" DECIMAL(12,2),
    "reembolso_motivo" TEXT,
    "reembolso_ref" VARCHAR(60),
    "reembolsado_por_id" INTEGER,
    "reembolsado_at" TIMESTAMP(3),
    "creado_por_id" INTEGER,
    "creado_por_rol" "RolUsuario",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pedidos_pagos_transferencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pagos_comprobantes" (
    "id" SERIAL NOT NULL,
    "pago_id" INTEGER NOT NULL,
    "subido_por_id" INTEGER NOT NULL,
    "archivo_key" VARCHAR(255) NOT NULL,
    "mime" VARCHAR(40) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "estado" "EstadoComprobante" NOT NULL DEFAULT 'PENDIENTE',
    "monto_declarado" DECIMAL(12,2),
    "fecha_declarada" TIMESTAMP(3),
    "banco_emisor" VARCHAR(60),
    "clave_rastreo_declarada" VARCHAR(40),
    "motivo_rechazo" VARCHAR(30),
    "nota_rechazo" TEXT,
    "revisado_por_id" INTEGER,
    "revisado_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pagos_comprobantes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pagos_transferencia_eventos" (
    "id" SERIAL NOT NULL,
    "pago_id" INTEGER NOT NULL,
    "tipo" VARCHAR(40) NOT NULL,
    "de_estado" "EstadoPagoTransferencia",
    "a_estado" "EstadoPagoTransferencia",
    "actor_id" INTEGER,
    "actor_rol" VARCHAR(20),
    "actor_nombre" VARCHAR(100),
    "ip" VARCHAR(45),
    "detalle" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pagos_transferencia_eventos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cuentas_bancarias_tienda_id_activa_idx" ON "cuentas_bancarias"("tienda_id", "activa");

-- CreateIndex
CREATE INDEX "pedidos_pagos_transferencia_pedido_id_idx" ON "pedidos_pagos_transferencia"("pedido_id");

-- CreateIndex
CREATE INDEX "pedidos_pagos_transferencia_estado_vence_at_idx" ON "pedidos_pagos_transferencia"("estado", "vence_at");

-- CreateIndex
CREATE INDEX "pedidos_pagos_transferencia_estado_created_at_idx" ON "pedidos_pagos_transferencia"("estado", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pedidos_pagos_transferencia_referencia_key" ON "pedidos_pagos_transferencia"("referencia");

-- CreateIndex
CREATE INDEX "pagos_comprobantes_pago_id_estado_idx" ON "pagos_comprobantes"("pago_id", "estado");

-- CreateIndex
CREATE INDEX "pagos_comprobantes_sha256_idx" ON "pagos_comprobantes"("sha256");

-- CreateIndex
CREATE INDEX "pagos_transferencia_eventos_pago_id_created_at_idx" ON "pagos_transferencia_eventos"("pago_id", "created_at");

-- AddForeignKey
ALTER TABLE "cuentas_bancarias" ADD CONSTRAINT "cuentas_bancarias_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_pagos_transferencia" ADD CONSTRAINT "pedidos_pagos_transferencia_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_pagos_transferencia" ADD CONSTRAINT "pedidos_pagos_transferencia_verificado_por_id_fkey" FOREIGN KEY ("verificado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_pagos_transferencia" ADD CONSTRAINT "pedidos_pagos_transferencia_reembolsado_por_id_fkey" FOREIGN KEY ("reembolsado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_comprobantes" ADD CONSTRAINT "pagos_comprobantes_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pedidos_pagos_transferencia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_comprobantes" ADD CONSTRAINT "pagos_comprobantes_subido_por_id_fkey" FOREIGN KEY ("subido_por_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_comprobantes" ADD CONSTRAINT "pagos_comprobantes_revisado_por_id_fkey" FOREIGN KEY ("revisado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_transferencia_eventos" ADD CONSTRAINT "pagos_transferencia_eventos_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pedidos_pagos_transferencia"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- Lo que Prisma no sabe declarar: índices PARCIALES y CHECKs. Son los invariantes de dinero.
-- ============================================================================

-- A lo más UN pago activo por pedido. Cierra la carrera de "emitir instrucciones" dos veces
-- (dos clics, o cliente y mostrador a la vez). Un pago CANCELADO / VENCIDO / APLICADO /
-- REEMBOLSADO ya no cuenta: el pedido puede tener uno nuevo.
CREATE UNIQUE INDEX "pedidos_pagos_transferencia_activo_uq"
  ON "pedidos_pagos_transferencia" ("pedido_id")
  WHERE "estado" IN ('PENDIENTE', 'EN_REVISION', 'VERIFICADO', 'REEMBOLSO_PENDIENTE');

-- Un mismo SPEI (clave de rastreo) no puede pagar dos pedidos, ni siquiera después de
-- reembolsado.
CREATE UNIQUE INDEX "pedidos_pagos_transferencia_clave_rastreo_uq"
  ON "pedidos_pagos_transferencia" ("clave_rastreo")
  WHERE "clave_rastreo" IS NOT NULL
    AND "estado" IN ('VERIFICADO', 'APLICADO', 'REEMBOLSO_PENDIENTE', 'REEMBOLSADO');

-- Una sola cuenta bancaria ACTIVA por ámbito (la global, o la de cada tienda). Sin esto, "¿a
-- qué cuenta le digo al cliente que transfiera?" tendría dos respuestas.
CREATE UNIQUE INDEX "cuentas_bancarias_activa_uq"
  ON "cuentas_bancarias" ((COALESCE("tienda_id", 0)))
  WHERE "activa";

ALTER TABLE "cuentas_bancarias"
  ADD CONSTRAINT "cuentas_bancarias_clabe_chk" CHECK ("clabe" ~ '^[0-9]{18}$');

ALTER TABLE "pedidos_pagos_transferencia"
  ADD CONSTRAINT "pedidos_pagos_transferencia_monto_chk" CHECK ("monto_esperado" > 0),
  ADD CONSTRAINT "pedidos_pagos_transferencia_referencia_chk" CHECK ("referencia" ~ '^[0-9]{7}$'),
  -- Todo pago con dinero verificado dice cuánto, cuándo y quién.
  ADD CONSTRAINT "pedidos_pagos_transferencia_verificacion_chk" CHECK (
    "estado" NOT IN ('VERIFICADO', 'APLICADO', 'REEMBOLSO_PENDIENTE', 'REEMBOLSADO')
    OR ("monto_verificado" IS NOT NULL AND "verificado_at" IS NOT NULL AND "verificado_por_id" IS NOT NULL)
  );
