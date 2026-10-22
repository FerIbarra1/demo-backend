-- Oct 2026: destrabar pedidos (gerente y admin). Aditiva: dos tablas nuevas y dos enums; ningún dato existente cambia.
--
--  * `pedido_intervenciones`: la bitácora de las acciones de destrabar (quién, qué, POR QUÉ).
--  * `tareas_sistema_comercial`: lo que la nube hizo y el Sistema Comercial aún no sabe (cancelar allá, registrar el
--    cobro allá). Las crea el servidor cuando el pedido YA tiene folio; se cierran solas cuando el agente confirma.

-- CreateEnum
CREATE TYPE "TipoTareaErp" AS ENUM ('CANCELAR_EN_ERP', 'REGISTRAR_COBRO_EN_ERP');

-- CreateEnum
CREATE TYPE "EstadoTareaErp" AS ENUM ('PENDIENTE', 'HECHA', 'DESCARTADA');

-- CreateTable
CREATE TABLE "pedido_intervenciones" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "tipo" VARCHAR(40) NOT NULL,
    "motivo" TEXT NOT NULL,
    "mensaje_cliente" TEXT,
    "actor_id" INTEGER,
    "actor_rol" "RolUsuario",
    "actor_nombre" VARCHAR(120) NOT NULL,
    "estado_antes" "EstadoPedido",
    "estado_despues" "EstadoPedido",
    "detalle" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pedido_intervenciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tareas_sistema_comercial" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "tipo" "TipoTareaErp" NOT NULL,
    "estado" "EstadoTareaErp" NOT NULL DEFAULT 'PENDIENTE',
    "folio" VARCHAR(10),
    "erp_id_pedido" INTEGER,
    "motivo" TEXT NOT NULL,
    "creada_por_id" INTEGER,
    "creada_por_rol" VARCHAR(20),
    "creada_por_nombre" VARCHAR(120),
    "intervencion_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resuelta_at" TIMESTAMP(3),
    "resuelta_por_id" INTEGER,
    "resuelta_por_nombre" VARCHAR(120),
    "resuelta_via" VARCHAR(12),
    "nota_resolucion" TEXT,

    CONSTRAINT "tareas_sistema_comercial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pedido_intervenciones_pedido_id_created_at_idx" ON "pedido_intervenciones"("pedido_id", "created_at");

-- CreateIndex
CREATE INDEX "pedido_intervenciones_tienda_id_created_at_idx" ON "pedido_intervenciones"("tienda_id", "created_at");

-- CreateIndex
CREATE INDEX "tareas_sistema_comercial_tienda_id_estado_created_at_idx" ON "tareas_sistema_comercial"("tienda_id", "estado", "created_at");

-- CreateIndex
CREATE INDEX "tareas_sistema_comercial_pedido_id_estado_idx" ON "tareas_sistema_comercial"("pedido_id", "estado");

-- AddForeignKey
ALTER TABLE "pedido_intervenciones" ADD CONSTRAINT "pedido_intervenciones_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tareas_sistema_comercial" ADD CONSTRAINT "tareas_sistema_comercial_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tareas_sistema_comercial" ADD CONSTRAINT "tareas_sistema_comercial_intervencion_id_fkey" FOREIGN KEY ("intervencion_id") REFERENCES "pedido_intervenciones"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Una sola tarea ABIERTA por pedido y tipo (Prisma no modela índices parciales). Cerrada (HECHA/DESCARTADA) puede haber
-- todas las que sean: si el ERP no la reflejó y el pedido vuelve a necesitarla, se abre otra.
CREATE UNIQUE INDEX "tareas_sistema_comercial_abierta_uq"
    ON "tareas_sistema_comercial" ("pedido_id", "tipo")
    WHERE "estado" = 'PENDIENTE';
