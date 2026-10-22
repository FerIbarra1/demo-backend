-- Impresión DTF (oct 2026). Ver PLAN-DTF.md.
-- Aditiva: 3 enums nuevos, 1 valor en EstadoPedido (EN_DTF), 1 en RolUsuario (IMPRESION), 4 en TipoNotificacion
-- y 6 tablas (dtf_tipos, tiendas_dtf, pedidos_dtf, pedidos_dtf_archivos, pedidos_dtf_eventos, pedidos_dtf_mensajes).

-- CreateEnum
CREATE TYPE "TecnologiaDtf" AS ENUM ('TEXTIL', 'UV');

-- CreateEnum
CREATE TYPE "EstadoDtf" AS ENUM ('BORRADOR', 'ARCHIVO_PENDIENTE', 'RECIBIDO', 'EN_REVISION', 'NECESITA_CORRECCION', 'APROBADO', 'EN_IMPRESION', 'IMPRESO', 'RECHAZADO', 'CANCELADO', 'EXPIRADO');

-- CreateEnum
CREATE TYPE "EstadoPreflight" AS ENUM ('PENDIENTE', 'OK', 'CON_AVISOS', 'BLOQUEADO', 'NO_CONCLUYENTE');

-- AlterEnum
ALTER TYPE "EstadoPedido" ADD VALUE 'EN_DTF';

-- AlterEnum
ALTER TYPE "RolUsuario" ADD VALUE 'IMPRESION';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TipoNotificacion" ADD VALUE 'DTF_RECIBIDO';
ALTER TYPE "TipoNotificacion" ADD VALUE 'DTF_NECESITA_CORRECCION';
ALTER TYPE "TipoNotificacion" ADD VALUE 'DTF_APROBADO';
ALTER TYPE "TipoNotificacion" ADD VALUE 'DTF_RECHAZADO';

-- CreateTable
CREATE TABLE "dtf_tipos" (
    "id" SERIAL NOT NULL,
    "tecnologia" "TecnologiaDtf" NOT NULL,
    "nombre" VARCHAR(60) NOT NULL,
    "descripcion" TEXT,
    "producto_id" INTEGER,
    "precio_metro" DECIMAL(10,2),
    "ancho_util_cm" DECIMAL(6,1) NOT NULL DEFAULT 57,
    "tolerancia_ancho_cm" DECIMAL(4,1) NOT NULL DEFAULT 0.5,
    "minimo_cm" DECIMAL(6,1) NOT NULL,
    "max_altura_cm" DECIMAL(6,1) NOT NULL DEFAULT 250,
    "paso_cobro_cm" INTEGER NOT NULL,
    "dpi_minimo" INTEGER NOT NULL DEFAULT 300,
    "texto_min_pt" DECIMAL(4,1) NOT NULL DEFAULT 6,
    "pago_antes" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dtf_tipos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiendas_dtf" (
    "id" SERIAL NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "tipo_id" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "maquina" VARCHAR(60),
    "velocidad_metros_hora" DECIMAL(6,2),
    "hora_corte" VARCHAR(5),
    "cupo_metros_dia" DECIMAL(8,2),
    "fuera_de_servicio" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tiendas_dtf_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedidos_dtf" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER,
    "usuario_id" INTEGER NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "tipo_id" INTEGER NOT NULL,
    "estado" "EstadoDtf" NOT NULL DEFAULT 'BORRADOR',
    "nombre" VARCHAR(80) NOT NULL,
    "nota_cliente" TEXT,
    "copias" INTEGER NOT NULL DEFAULT 1,
    "ancho_cm" DECIMAL(6,1),
    "alto_cm" DECIMAL(7,1),
    "metros_cobrados" DECIMAL(8,2),
    "precio_metro" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "version_vigente" INTEGER NOT NULL DEFAULT 0,
    "asignado_a_id" INTEGER,
    "asignado_at" TIMESTAMP(3),
    "correccion_motivos" JSONB,
    "correccion_nota" TEXT,
    "rechazo_motivo" VARCHAR(40),
    "rechazo_nota" TEXT,
    "acepto_riesgo" BOOLEAN NOT NULL DEFAULT false,
    "recibido_at" TIMESTAMP(3),
    "aprobado_at" TIMESTAMP(3),
    "plano_blanco_at" TIMESTAMP(3),
    "imprimiendo_at" TIMESTAMP(3),
    "impreso_at" TIMESTAMP(3),
    "hora_estimada_at" TIMESTAMP(3),
    "orden_cola" INTEGER,
    "reimpresiones" INTEGER NOT NULL DEFAULT 0,
    "expira_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pedidos_dtf_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedidos_dtf_archivos" (
    "id" SERIAL NOT NULL,
    "dtf_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "archivo_key" VARCHAR(255) NOT NULL,
    "preview_key" VARCHAR(255),
    "nombre_original" VARCHAR(200) NOT NULL,
    "mime" VARCHAR(40) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "canal" VARCHAR(20) NOT NULL,
    "subido_por_id" INTEGER,
    "subido_por_rol" VARCHAR(20),
    "preflight_estado" "EstadoPreflight" NOT NULL DEFAULT 'PENDIENTE',
    "preflight" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pedidos_dtf_archivos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedidos_dtf_eventos" (
    "id" SERIAL NOT NULL,
    "dtf_id" INTEGER NOT NULL,
    "tipo" VARCHAR(40) NOT NULL,
    "de_estado" "EstadoDtf",
    "a_estado" "EstadoDtf",
    "actor_id" INTEGER,
    "actor_rol" VARCHAR(20),
    "actor_nombre" VARCHAR(100),
    "detalle" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pedidos_dtf_eventos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedidos_dtf_mensajes" (
    "id" SERIAL NOT NULL,
    "dtf_id" INTEGER NOT NULL,
    "autor_id" INTEGER NOT NULL,
    "autor_rol" "RolUsuario" NOT NULL,
    "contenido" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pedidos_dtf_mensajes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dtf_tipos_tecnologia_key" ON "dtf_tipos"("tecnologia");

-- CreateIndex
CREATE UNIQUE INDEX "tiendas_dtf_tienda_id_tipo_id_key" ON "tiendas_dtf"("tienda_id", "tipo_id");

-- CreateIndex
CREATE INDEX "pedidos_dtf_tienda_id_estado_idx" ON "pedidos_dtf"("tienda_id", "estado");

-- CreateIndex
CREATE INDEX "pedidos_dtf_pedido_id_idx" ON "pedidos_dtf"("pedido_id");

-- CreateIndex
CREATE INDEX "pedidos_dtf_usuario_id_estado_idx" ON "pedidos_dtf"("usuario_id", "estado");

-- CreateIndex
CREATE INDEX "pedidos_dtf_estado_expira_at_idx" ON "pedidos_dtf"("estado", "expira_at");

-- CreateIndex
CREATE INDEX "pedidos_dtf_archivos_sha256_idx" ON "pedidos_dtf_archivos"("sha256");

-- CreateIndex
CREATE INDEX "pedidos_dtf_archivos_preflight_estado_created_at_idx" ON "pedidos_dtf_archivos"("preflight_estado", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pedidos_dtf_archivos_dtf_id_version_key" ON "pedidos_dtf_archivos"("dtf_id", "version");

-- CreateIndex
CREATE INDEX "pedidos_dtf_eventos_dtf_id_created_at_idx" ON "pedidos_dtf_eventos"("dtf_id", "created_at");

-- CreateIndex
CREATE INDEX "pedidos_dtf_mensajes_dtf_id_created_at_idx" ON "pedidos_dtf_mensajes"("dtf_id", "created_at");

-- AddForeignKey
ALTER TABLE "dtf_tipos" ADD CONSTRAINT "dtf_tipos_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiendas_dtf" ADD CONSTRAINT "tiendas_dtf_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiendas_dtf" ADD CONSTRAINT "tiendas_dtf_tipo_id_fkey" FOREIGN KEY ("tipo_id") REFERENCES "dtf_tipos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_dtf" ADD CONSTRAINT "pedidos_dtf_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_dtf" ADD CONSTRAINT "pedidos_dtf_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_dtf" ADD CONSTRAINT "pedidos_dtf_asignado_a_id_fkey" FOREIGN KEY ("asignado_a_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_dtf" ADD CONSTRAINT "pedidos_dtf_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_dtf" ADD CONSTRAINT "pedidos_dtf_tipo_id_fkey" FOREIGN KEY ("tipo_id") REFERENCES "dtf_tipos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_dtf_archivos" ADD CONSTRAINT "pedidos_dtf_archivos_dtf_id_fkey" FOREIGN KEY ("dtf_id") REFERENCES "pedidos_dtf"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_dtf_eventos" ADD CONSTRAINT "pedidos_dtf_eventos_dtf_id_fkey" FOREIGN KEY ("dtf_id") REFERENCES "pedidos_dtf"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_dtf_mensajes" ADD CONSTRAINT "pedidos_dtf_mensajes_dtf_id_fkey" FOREIGN KEY ("dtf_id") REFERENCES "pedidos_dtf"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_dtf_mensajes" ADD CONSTRAINT "pedidos_dtf_mensajes_autor_id_fkey" FOREIGN KEY ("autor_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

