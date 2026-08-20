-- F9 (ago 2026): infraestructura para sincronización bidireccional con
-- el sistema legacy Firebird/VFP (DATOSINV.FDB). Ver plan
-- /Users/fernandoibarra/.claude/plans/idempotent-floating-ritchie.md.
--
-- Cambios:
--   1) Columnas lista1..6 en precios y preciosco (6 listas de precios
--      sincronizadas desde PRECIOS.PRECIO1..6 / PRECIOSCO.PRECIO1..6).
--   2) Columna lista_precio_codigo en usuarios (CLIENTES.LISPRE '1'..'6').
--   3) Columna external_id en tiendas (TIENDAS.IDTIENDA).
--   4) Tablas nuevas: external_refs, sync_checkpoints, pedidos_pendientes_envio, sync_event_log.

-- 1) Precios: 6 listas
ALTER TABLE "precios"
  ADD COLUMN "lista1" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "lista2" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "lista3" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "lista4" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "lista5" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "lista6" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- 2) Variantes: 6 listas
ALTER TABLE "preciosco"
  ADD COLUMN "lista1" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "lista2" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "lista3" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "lista4" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "lista5" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "lista6" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- 3) Usuarios: lista de precios del cliente (CLIENTES.LISPRE)
ALTER TABLE "usuarios"
  ADD COLUMN "lista_precio_codigo" VARCHAR(2);

-- 4) Tiendas: ID externo Firebird (TIENDAS.IDTIENDA), único
ALTER TABLE "tiendas"
  ADD COLUMN "external_id" INTEGER;

-- Unicidad: una sola Tienda nube por IDTIENDA de Firebird
CREATE UNIQUE INDEX "tiendas_external_id_key" ON "tiendas"("external_id");

-- 5) Tabla external_refs: mapeo polimórfico nube ↔ Firebird
CREATE TABLE "external_refs" (
    "id" SERIAL NOT NULL,
    "system_entity" VARCHAR(40) NOT NULL,
    "system_id" INTEGER NOT NULL,
    "local_entity" VARCHAR(40) NOT NULL,
    "local_id" INTEGER NOT NULL,
    "local_tienda_id" INTEGER,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_refs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "external_refs_system_entity_system_id_idx" ON "external_refs"("system_entity", "system_id");
CREATE INDEX "external_refs_local_entity_local_id_idx" ON "external_refs"("local_entity", "local_id");
CREATE INDEX "external_refs_local_entity_local_tienda_id_local_id_idx" ON "external_refs"("local_entity", "local_tienda_id", "local_id");

-- Unicidad: una fila por (entidad-nube, id-nube, entidad-local, tienda-local).
-- Para entidades globales (sin tienda), local_tienda_id=NULL cuenta.
CREATE UNIQUE INDEX "external_refs_system_entity_system_id_local_entity_loca_key" ON "external_refs"("system_entity", "system_id", "local_entity", "local_tienda_id");

-- 6) Tabla sync_checkpoints: watermark por tienda
CREATE TABLE "sync_checkpoints" (
    "id" SERIAL NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "ultimo_bandeja_id" BIGINT NOT NULL DEFAULT 0,
    "ultimo_heartbeat_at" TIMESTAMP(3),
    "agent_version" VARCHAR(20),
    "last_error" TEXT,
    "last_error_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sync_checkpoints_tienda_id_key" ON "sync_checkpoints"("tienda_id");

-- 7) Tabla pedidos_pendientes_envio: cola nube→Firebird
CREATE TABLE "pedidos_pendientes_envio" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "ultimo_error" TEXT,
    "ultimo_intento_at" TIMESTAMP(3),
    "external_id_pedidos" INTEGER,
    "external_folio" VARCHAR(10),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "pedidos_pendientes_envio_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pedidos_pendientes_envio_pedido_id_key" ON "pedidos_pendientes_envio"("pedido_id");
CREATE INDEX "pedidos_pendientes_envio_estado_created_at_idx" ON "pedidos_pendientes_envio"("estado", "created_at");

-- 8) Tabla sync_event_log: auditoría bidireccional
CREATE TABLE "sync_event_log" (
    "id" SERIAL NOT NULL,
    "tienda_id" INTEGER,
    "direccion" VARCHAR(10) NOT NULL,
    "tipo" VARCHAR(20) NOT NULL,
    "referencia" VARCHAR(100),
    "exitoso" BOOLEAN NOT NULL DEFAULT true,
    "mensaje" TEXT,
    "payload_size" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_event_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sync_event_log_tienda_id_created_at_idx" ON "sync_event_log"("tienda_id", "created_at");
CREATE INDEX "sync_event_log_tipo_exitoso_created_at_idx" ON "sync_event_log"("tipo", "exitoso", "created_at");

-- 9) Foreign keys nuevos
ALTER TABLE "sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pedidos_pendientes_envio" ADD CONSTRAINT "pedidos_pendientes_envio_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
