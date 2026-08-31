-- CreateEnum
CREATE TYPE "RolUsuario" AS ENUM ('CLIENTE', 'BODEGA', 'BODEGA_MONITOR', 'CAJERO', 'CAJERO_MONITOR', 'MOSTRADOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "EstadoPedido" AS ENUM ('PENDING_REVIEW', 'REVIEWING', 'WAITING_CUSTOMER_APPROVAL', 'APPROVED', 'PENDING_PAID', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EstadoRevision" AS ENUM ('PENDIENTE', 'APROBADA', 'RECHAZADA');

-- CreateEnum
CREATE TYPE "EstadoDecision" AS ENUM ('PENDIENTE', 'ACEPTADO', 'RECHAZADO');

-- CreateEnum
CREATE TYPE "CanalOrigen" AS ENUM ('WEB', 'KIOSKO');

-- CreateEnum
CREATE TYPE "ModoEntrega" AS ENUM ('DOMICILIO', 'RECOGER_TIENDA', 'KIOSKO');

-- CreateEnum
CREATE TYPE "Paqueteria" AS ENUM ('ALBATROS', 'TUFESA', 'ESTAFETA', 'DHL', 'FEDEX', 'PAQUETEXPRESS');

-- CreateEnum
CREATE TYPE "CanalNotificacion" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "TipoNotificacion" AS ENUM ('PEDIDO_RECIBIDO', 'REVISION_PROPUESTA', 'REVISION_APROBADA', 'REVISION_RECHAZADA', 'PAGO_CONFIRMADO', 'ENVIADO', 'ENTREGADO', 'CANCELADO', 'MENSAJE_BODEGUERO', 'RESET_PASSWORD', 'BIENVENIDA');

-- CreateEnum
CREATE TYPE "EstadoSurtido" AS ENUM ('PENDIENTE', 'PARCIAL', 'COMPLETO', 'NO_DISPONIBLE');

-- CreateEnum
CREATE TYPE "EstadoKiosko" AS ENUM ('ACTIVO', 'INACTIVO');

-- CreateTable
CREATE TABLE "tiendas" (
    "id" SERIAL NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "direccion" VARCHAR(255) NOT NULL,
    "ciudad" VARCHAR(50) NOT NULL,
    "estado" VARCHAR(50) NOT NULL,
    "telefono" VARCHAR(20),
    "email" VARCHAR(100),
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "external_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tiendas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuarios" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(100) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "apellido" VARCHAR(100),
    "telefono" VARCHAR(20),
    "rol" "RolUsuario" NOT NULL DEFAULT 'CLIENTE',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "tienda_id" INTEGER,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "last_login" TIMESTAMP(3),
    "ultimo_heartbeat" TIMESTAMP(3),
    "lista_precio_codigo" VARCHAR(2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuarios_tiendas" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "local_cliente_id" INTEGER,
    "lista_precio_codigo" VARCHAR(2),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuarios_tiendas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ventanillas" (
    "id" SERIAL NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "numero" INTEGER NOT NULL,
    "cajero_id" INTEGER,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ventanillas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productos" (
    "id" SERIAL NOT NULL,
    "codigo" VARCHAR(50) NOT NULL,
    "nombre" VARCHAR(150) NOT NULL,
    "descripcion" TEXT,
    "imagen_principal" VARCHAR(255),
    "imagenes" TEXT[],
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "categoria" VARCHAR(50),
    "subcategoria" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "productos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productos_tienda" (
    "id" SERIAL NOT NULL,
    "producto_id" INTEGER NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "destacado" BOOLEAN NOT NULL DEFAULT false,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "productos_tienda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corridas" (
    "id" SERIAL NOT NULL,
    "nombre" VARCHAR(50) NOT NULL,
    "descripcion" VARCHAR(100),
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "corridas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tallas" (
    "id" SERIAL NOT NULL,
    "corrida_id" INTEGER NOT NULL,
    "nombre" VARCHAR(10) NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tallas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "colores" (
    "id" SERIAL NOT NULL,
    "codigo" VARCHAR(10) NOT NULL,
    "nombre" VARCHAR(30) NOT NULL,
    "hex" VARCHAR(7),
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "colores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "precios" (
    "id" SERIAL NOT NULL,
    "producto_id" INTEGER NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "precio_base" DECIMAL(10,2) NOT NULL,
    "precio_oferta" DECIMAL(10,2),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "vigencia_desde" DATE,
    "vigencia_hasta" DATE,
    "lista1" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lista2" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lista3" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lista4" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lista5" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lista6" DECIMAL(10,2) NOT NULL DEFAULT 0,

    CONSTRAINT "precios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preciosco" (
    "id" SERIAL NOT NULL,
    "producto_id" INTEGER NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "corrida_id" INTEGER NOT NULL,
    "talla_id" INTEGER NOT NULL,
    "color_id" INTEGER NOT NULL,
    "precio" DECIMAL(10,2) NOT NULL,
    "sku" VARCHAR(50),
    "lista1" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lista2" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lista3" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lista4" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lista5" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lista6" DECIMAL(10,2) NOT NULL DEFAULT 0,

    CONSTRAINT "preciosco_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedidos" (
    "id" SERIAL NOT NULL,
    "numero_pedido" VARCHAR(20) NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "estado" "EstadoPedido" NOT NULL DEFAULT 'PENDING_REVIEW',
    "canal_origen" "CanalOrigen" NOT NULL DEFAULT 'WEB',
    "kiosko_id" INTEGER,
    "notas" TEXT,
    "cliente_nombre" VARCHAR(100) NOT NULL,
    "cliente_email" VARCHAR(100) NOT NULL,
    "cliente_telefono" VARCHAR(20),
    "modo_entrega" "ModoEntrega" NOT NULL DEFAULT 'DOMICILIO',
    "shipping_direccion" TEXT,
    "shipping_referencia" VARCHAR(255),
    "shipping_colonia" VARCHAR(120),
    "shipping_codigo_postal" VARCHAR(10),
    "shipping_paqueteria" "Paqueteria",
    "dejar_admin_decide_paqueteria" BOOLEAN NOT NULL DEFAULT false,
    "recoger_programado" TIMESTAMP(3),
    "subtotal" DECIMAL(12,2) NOT NULL,
    "descuento" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "impuestos" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "idempotency_key" VARCHAR(64),
    "asignado_a_id" INTEGER,
    "asignado_at" TIMESTAMP(3),
    "cajero_asignado_id" INTEGER,
    "cajero_asignado_at" TIMESTAMP(3),
    "fecha_pedido" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_pago" TIMESTAMP(3),

    CONSTRAINT "pedidos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items_pedido" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "producto_id" INTEGER NOT NULL,
    "precioco_id" INTEGER,
    "cantidad" INTEGER NOT NULL,
    "precio_unitario" DECIMAL(10,2) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "cantidad_original" INTEGER NOT NULL DEFAULT 0,
    "producto_nombre" VARCHAR(150) NOT NULL,
    "producto_codigo" VARCHAR(50) NOT NULL,
    "corrida_nombre" VARCHAR(50) NOT NULL,
    "talla_nombre" VARCHAR(10) NOT NULL,
    "color_nombre" VARCHAR(30) NOT NULL,
    "original" BOOLEAN NOT NULL DEFAULT true,
    "cancelada" BOOLEAN NOT NULL DEFAULT false,
    "cantidad_surtida" INTEGER NOT NULL DEFAULT 0,
    "estado_surtido" "EstadoSurtido" NOT NULL DEFAULT 'PENDIENTE',
    "surtido_at" TIMESTAMP(3),
    "motivo_surtido" TEXT,
    "sustitucion_propuesta_precioco_id" INTEGER,

    CONSTRAINT "items_pedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedidos_revisiones" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "estado_revision" "EstadoRevision" NOT NULL DEFAULT 'PENDIENTE',
    "creada_por_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "aprobada_at" TIMESTAMP(3),
    "aprobada_por_id" INTEGER,

    CONSTRAINT "pedidos_revisiones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedidos_revisiones_items" (
    "id" SERIAL NOT NULL,
    "revision_id" INTEGER NOT NULL,
    "item_pedido_original_id" INTEGER NOT NULL,
    "nuevo_precioco_id" INTEGER,
    "nueva_cantidad" INTEGER,
    "motivo" TEXT NOT NULL,
    "decision" "EstadoDecision" NOT NULL DEFAULT 'PENDIENTE',
    "decided_at" TIMESTAMP(3),
    "decided_por_id" INTEGER,

    CONSTRAINT "pedidos_revisiones_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedidos_mensajes" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "item_id" INTEGER,
    "autor_id" INTEGER NOT NULL,
    "autor_rol" "RolUsuario" NOT NULL,
    "contenido" TEXT NOT NULL,
    "visible_para_cliente" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pedidos_mensajes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mensaje_bodeguero_enviado" (
    "pedido_id" INTEGER NOT NULL,
    "mensaje_id" INTEGER NOT NULL,
    "enviado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mensaje_bodeguero_enviado_pkey" PRIMARY KEY ("pedido_id")
);

-- CreateTable
CREATE TABLE "notificaciones" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER,
    "canal" "CanalNotificacion" NOT NULL,
    "tipo" "TipoNotificacion" NOT NULL,
    "destinatario" VARCHAR(200) NOT NULL,
    "payload" JSONB,
    "exitosa" BOOLEAN NOT NULL DEFAULT false,
    "error_msg" TEXT,
    "enviada_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notificaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historial_pedidos" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "estado_anterior" "EstadoPedido",
    "estado_nuevo" "EstadoPedido" NOT NULL,
    "observacion" TEXT,
    "usuario_id" INTEGER,
    "usuario_nombre" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historial_pedidos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "log_actividades" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER,
    "pedido_id" INTEGER,
    "accion" VARCHAR(50) NOT NULL,
    "descripcion" TEXT NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "log_actividades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kioskos" (
    "id" SERIAL NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "nombre" VARCHAR(50) NOT NULL,
    "estado" "EstadoKiosko" NOT NULL DEFAULT 'ACTIVO',
    "activado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activado_por_id" INTEGER NOT NULL,
    "desactivado_at" TIMESTAMP(3),
    "desactivado_por_id" INTEGER,
    "ultimo_heartbeat" TIMESTAMP(3),
    "primer_conexion_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kioskos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favoritos" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "producto_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favoritos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "token" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "ip_origen" VARCHAR(45),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "family_id" VARCHAR(36) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by" INTEGER,
    "ip_origen" VARCHAR(45),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_refs" (
    "id" SERIAL NOT NULL,
    "systemEntity" VARCHAR(40) NOT NULL,
    "systemId" INTEGER NOT NULL,
    "localEntity" VARCHAR(40) NOT NULL,
    "localId" INTEGER NOT NULL,
    "localTiendaId" INTEGER,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "pedidos_pendientes_envio" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "claimed_by" VARCHAR(100),
    "lease_token" VARCHAR(80),
    "lease_until" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_error" TEXT,
    "ultimo_intento_at" TIMESTAMP(3),
    "ultimo_error_code" VARCHAR(60),
    "external_id_pedidos" INTEGER,
    "external_folio" VARCHAR(10),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "pedidos_pendientes_envio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_event_inbox" (
    "id" SERIAL NOT NULL,
    "event_id" VARCHAR(160) NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "bandeja_id" BIGINT,
    "entidad" VARCHAR(40) NOT NULL,
    "operacion" VARCHAR(1) NOT NULL,
    "local_id" INTEGER NOT NULL,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'PROCESANDO',
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_error_code" VARCHAR(60),
    "payload" JSONB NOT NULL,
    "mensaje" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "sync_event_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX "tiendas_external_id_key" ON "tiendas"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- CreateIndex
CREATE INDEX "usuarios_tiendas_tienda_id_local_cliente_id_idx" ON "usuarios_tiendas"("tienda_id", "local_cliente_id");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_tiendas_usuario_id_tienda_id_key" ON "usuarios_tiendas"("usuario_id", "tienda_id");

-- CreateIndex
CREATE UNIQUE INDEX "ventanillas_cajero_id_key" ON "ventanillas"("cajero_id");

-- CreateIndex
CREATE INDEX "ventanillas_tienda_id_idx" ON "ventanillas"("tienda_id");

-- CreateIndex
CREATE UNIQUE INDEX "ventanillas_tienda_id_numero_key" ON "ventanillas"("tienda_id", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "productos_codigo_key" ON "productos"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "productos_tienda_producto_id_tienda_id_key" ON "productos_tienda"("producto_id", "tienda_id");

-- CreateIndex
CREATE UNIQUE INDEX "tallas_corrida_id_nombre_key" ON "tallas"("corrida_id", "nombre");

-- CreateIndex
CREATE UNIQUE INDEX "colores_codigo_key" ON "colores"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "precios_producto_id_tienda_id_key" ON "precios"("producto_id", "tienda_id");

-- CreateIndex
CREATE UNIQUE INDEX "preciosco_sku_key" ON "preciosco"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "preciosco_producto_id_tienda_id_corrida_id_talla_id_color_i_key" ON "preciosco"("producto_id", "tienda_id", "corrida_id", "talla_id", "color_id");

-- CreateIndex
CREATE UNIQUE INDEX "pedidos_numero_pedido_key" ON "pedidos"("numero_pedido");

-- CreateIndex
CREATE UNIQUE INDEX "pedidos_idempotency_key_key" ON "pedidos"("idempotency_key");

-- CreateIndex
CREATE INDEX "pedidos_tienda_id_estado_idx" ON "pedidos"("tienda_id", "estado");

-- CreateIndex
CREATE INDEX "pedidos_usuario_id_idx" ON "pedidos"("usuario_id");

-- CreateIndex
CREATE INDEX "pedidos_cajero_asignado_id_idx" ON "pedidos"("cajero_asignado_id");

-- CreateIndex
CREATE INDEX "pedidos_estado_canal_origen_idx" ON "pedidos"("estado", "canal_origen");

-- CreateIndex
CREATE INDEX "pedidos_asignado_a_id_idx" ON "pedidos"("asignado_a_id");

-- CreateIndex
CREATE INDEX "pedidos_kiosko_id_idx" ON "pedidos"("kiosko_id");

-- CreateIndex
CREATE INDEX "items_pedido_pedido_id_cancelada_idx" ON "items_pedido"("pedido_id", "cancelada");

-- CreateIndex
CREATE INDEX "pedidos_revisiones_pedido_id_estado_revision_idx" ON "pedidos_revisiones"("pedido_id", "estado_revision");

-- CreateIndex
CREATE INDEX "pedidos_revisiones_items_revision_id_decision_idx" ON "pedidos_revisiones_items"("revision_id", "decision");

-- CreateIndex
CREATE INDEX "pedidos_mensajes_pedido_id_created_at_idx" ON "pedidos_mensajes"("pedido_id", "created_at");

-- CreateIndex
CREATE INDEX "pedidos_mensajes_item_id_idx" ON "pedidos_mensajes"("item_id");

-- CreateIndex
CREATE INDEX "notificaciones_pedido_id_idx" ON "notificaciones"("pedido_id");

-- CreateIndex
CREATE INDEX "notificaciones_enviada_at_idx" ON "notificaciones"("enviada_at");

-- CreateIndex
CREATE INDEX "log_actividades_usuario_id_idx" ON "log_actividades"("usuario_id");

-- CreateIndex
CREATE INDEX "log_actividades_pedido_id_idx" ON "log_actividades"("pedido_id");

-- CreateIndex
CREATE INDEX "log_actividades_created_at_idx" ON "log_actividades"("created_at");

-- CreateIndex
CREATE INDEX "kioskos_tienda_id_estado_idx" ON "kioskos"("tienda_id", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "kioskos_tienda_id_nombre_key" ON "kioskos"("tienda_id", "nombre");

-- CreateIndex
CREATE INDEX "favoritos_usuario_id_idx" ON "favoritos"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "favoritos_usuario_id_producto_id_key" ON "favoritos"("usuario_id", "producto_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_key" ON "password_reset_tokens"("token");

-- CreateIndex
CREATE INDEX "password_reset_tokens_usuario_id_idx" ON "password_reset_tokens"("usuario_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_usuario_id_idx" ON "refresh_tokens"("usuario_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "external_refs_systemEntity_systemId_idx" ON "external_refs"("systemEntity", "systemId");

-- CreateIndex
CREATE INDEX "external_refs_localEntity_localId_idx" ON "external_refs"("localEntity", "localId");

-- CreateIndex
CREATE INDEX "external_refs_localEntity_localTiendaId_localId_idx" ON "external_refs"("localEntity", "localTiendaId", "localId");

-- CreateIndex
CREATE UNIQUE INDEX "external_refs_systemEntity_systemId_localEntity_localTienda_key" ON "external_refs"("systemEntity", "systemId", "localEntity", "localTiendaId");

-- CreateIndex
CREATE UNIQUE INDEX "sync_checkpoints_tienda_id_key" ON "sync_checkpoints"("tienda_id");

-- CreateIndex
CREATE UNIQUE INDEX "pedidos_pendientes_envio_pedido_id_key" ON "pedidos_pendientes_envio"("pedido_id");

-- CreateIndex
CREATE INDEX "pedidos_pendientes_envio_estado_created_at_idx" ON "pedidos_pendientes_envio"("estado", "created_at");

-- CreateIndex
CREATE INDEX "pedidos_pendientes_envio_claim_idx" ON "pedidos_pendientes_envio"("estado", "next_attempt_at", "lease_until");

-- CreateIndex
CREATE INDEX "pedidos_pendientes_envio_lease_token_idx" ON "pedidos_pendientes_envio"("lease_token");

-- CreateIndex
CREATE UNIQUE INDEX "sync_event_inbox_event_id_key" ON "sync_event_inbox"("event_id");

-- CreateIndex
CREATE INDEX "sync_event_inbox_tienda_id_created_at_idx" ON "sync_event_inbox"("tienda_id", "created_at");

-- CreateIndex
CREATE INDEX "sync_event_inbox_estado_created_at_idx" ON "sync_event_inbox"("estado", "created_at");

-- CreateIndex
CREATE INDEX "sync_event_inbox_retry_idx" ON "sync_event_inbox"("estado", "next_attempt_at");

-- CreateIndex
CREATE INDEX "sync_event_log_tienda_id_created_at_idx" ON "sync_event_log"("tienda_id", "created_at");

-- CreateIndex
CREATE INDEX "sync_event_log_tipo_exitoso_created_at_idx" ON "sync_event_log"("tipo", "exitoso", "created_at");

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuarios_tiendas" ADD CONSTRAINT "usuarios_tiendas_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuarios_tiendas" ADD CONSTRAINT "usuarios_tiendas_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ventanillas" ADD CONSTRAINT "ventanillas_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ventanillas" ADD CONSTRAINT "ventanillas_cajero_id_fkey" FOREIGN KEY ("cajero_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos_tienda" ADD CONSTRAINT "productos_tienda_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos_tienda" ADD CONSTRAINT "productos_tienda_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tallas" ADD CONSTRAINT "tallas_corrida_id_fkey" FOREIGN KEY ("corrida_id") REFERENCES "corridas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "precios" ADD CONSTRAINT "precios_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "precios" ADD CONSTRAINT "precios_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preciosco" ADD CONSTRAINT "preciosco_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preciosco" ADD CONSTRAINT "preciosco_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preciosco" ADD CONSTRAINT "preciosco_corrida_id_fkey" FOREIGN KEY ("corrida_id") REFERENCES "corridas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preciosco" ADD CONSTRAINT "preciosco_talla_id_fkey" FOREIGN KEY ("talla_id") REFERENCES "tallas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preciosco" ADD CONSTRAINT "preciosco_color_id_fkey" FOREIGN KEY ("color_id") REFERENCES "colores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_kiosko_id_fkey" FOREIGN KEY ("kiosko_id") REFERENCES "kioskos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_asignado_a_id_fkey" FOREIGN KEY ("asignado_a_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_cajero_asignado_id_fkey" FOREIGN KEY ("cajero_asignado_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items_pedido" ADD CONSTRAINT "items_pedido_sustitucion_propuesta_precioco_id_fkey" FOREIGN KEY ("sustitucion_propuesta_precioco_id") REFERENCES "preciosco"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items_pedido" ADD CONSTRAINT "items_pedido_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items_pedido" ADD CONSTRAINT "items_pedido_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items_pedido" ADD CONSTRAINT "items_pedido_precioco_id_fkey" FOREIGN KEY ("precioco_id") REFERENCES "preciosco"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_revisiones" ADD CONSTRAINT "pedidos_revisiones_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_revisiones" ADD CONSTRAINT "pedidos_revisiones_creada_por_id_fkey" FOREIGN KEY ("creada_por_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_revisiones" ADD CONSTRAINT "pedidos_revisiones_aprobada_por_id_fkey" FOREIGN KEY ("aprobada_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_revisiones_items" ADD CONSTRAINT "pedidos_revisiones_items_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "pedidos_revisiones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_revisiones_items" ADD CONSTRAINT "pedidos_revisiones_items_item_pedido_original_id_fkey" FOREIGN KEY ("item_pedido_original_id") REFERENCES "items_pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_revisiones_items" ADD CONSTRAINT "pedidos_revisiones_items_nuevo_precioco_id_fkey" FOREIGN KEY ("nuevo_precioco_id") REFERENCES "preciosco"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_revisiones_items" ADD CONSTRAINT "pedidos_revisiones_items_decided_por_id_fkey" FOREIGN KEY ("decided_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_mensajes" ADD CONSTRAINT "pedidos_mensajes_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_mensajes" ADD CONSTRAINT "pedidos_mensajes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items_pedido"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_mensajes" ADD CONSTRAINT "pedidos_mensajes_autor_id_fkey" FOREIGN KEY ("autor_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensaje_bodeguero_enviado" ADD CONSTRAINT "mensaje_bodeguero_enviado_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensaje_bodeguero_enviado" ADD CONSTRAINT "mensaje_bodeguero_enviado_mensaje_id_fkey" FOREIGN KEY ("mensaje_id") REFERENCES "pedidos_mensajes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notificaciones" ADD CONSTRAINT "notificaciones_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historial_pedidos" ADD CONSTRAINT "historial_pedidos_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "log_actividades" ADD CONSTRAINT "log_actividades_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "log_actividades" ADD CONSTRAINT "log_actividades_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kioskos" ADD CONSTRAINT "kioskos_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kioskos" ADD CONSTRAINT "kioskos_activado_por_id_fkey" FOREIGN KEY ("activado_por_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kioskos" ADD CONSTRAINT "kioskos_desactivado_por_id_fkey" FOREIGN KEY ("desactivado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favoritos" ADD CONSTRAINT "favoritos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favoritos" ADD CONSTRAINT "favoritos_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_pendientes_envio" ADD CONSTRAINT "pedidos_pendientes_envio_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_event_inbox" ADD CONSTRAINT "sync_event_inbox_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
