-- CreateEnum
CREATE TYPE "RolUsuario" AS ENUM ('CLIENTE', 'BODEGA', 'CAJERO', 'MOSTRADOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "EstadoPedido" AS ENUM ('PENDING_REVIEW', 'REVIEWING', 'WAITING_CUSTOMER_APPROVAL', 'APPROVED', 'WAITING_PAYMENT', 'PAID', 'PREPARING_SHIPMENT', 'SHIPPED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EstadoRevision" AS ENUM ('PENDIENTE', 'APROBADA', 'RECHAZADA');

-- CreateEnum
CREATE TYPE "EstadoDecision" AS ENUM ('PENDIENTE', 'ACEPTADO', 'RECHAZADO');

-- CreateEnum
CREATE TYPE "CanalOrigen" AS ENUM ('WEB', 'KIOSKO');

-- CreateEnum
CREATE TYPE "CanalNotificacion" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "TipoNotificacion" AS ENUM ('PEDIDO_RECIBIDO', 'REVISION_PROPUESTA', 'REVISION_APROBADA', 'REVISION_RECHAZADA', 'PAGO_SOLICITADO', 'COMPROBANTE_RECIBIDO', 'PAGO_APROBADO', 'PAGO_RECHAZADO', 'EN_PREPARACION', 'ENVIADO', 'ENTREGADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "TipoPago" AS ENUM ('TIENDA', 'TRANSFERENCIA');

-- CreateEnum
CREATE TYPE "EstadoPago" AS ENUM ('PENDIENTE', 'VERIFICADO', 'RECHAZADO');

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
    "lada" VARCHAR(8),
    "rol" "RolUsuario" NOT NULL DEFAULT 'CLIENTE',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "tienda_id" INTEGER,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "last_login" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
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
    "notas" TEXT,
    "cliente_nombre" VARCHAR(100) NOT NULL,
    "cliente_email" VARCHAR(100) NOT NULL,
    "cliente_telefono" VARCHAR(20),
    "cliente_whatsapp" VARCHAR(20),
    "shipping_direccion" TEXT,
    "shipping_referencia" VARCHAR(255),
    "subtotal" DECIMAL(12,2) NOT NULL,
    "descuento" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "impuestos" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "tipo_pago" "TipoPago" NOT NULL,
    "estado_pago" "EstadoPago" NOT NULL DEFAULT 'PENDIENTE',
    "referencia_pago" VARCHAR(100),
    "idempotency_key" VARCHAR(64),
    "asignado_a_id" INTEGER,
    "asignado_at" TIMESTAMP(3),
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
    "producto_nombre" VARCHAR(150) NOT NULL,
    "producto_codigo" VARCHAR(50) NOT NULL,
    "corrida_nombre" VARCHAR(50) NOT NULL,
    "talla_nombre" VARCHAR(10) NOT NULL,
    "color_nombre" VARCHAR(30) NOT NULL,
    "original" BOOLEAN NOT NULL DEFAULT true,
    "cancelada" BOOLEAN NOT NULL DEFAULT false,

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
    "autor_id" INTEGER NOT NULL,
    "autor_rol" "RolUsuario" NOT NULL,
    "contenido" TEXT NOT NULL,
    "visible_para_cliente" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pedidos_mensajes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comprobantes_pago" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by_id" INTEGER NOT NULL,

    CONSTRAINT "comprobantes_pago_pkey" PRIMARY KEY ("id")
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

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

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
CREATE INDEX "pedidos_estado_pago_idx" ON "pedidos"("estado_pago");

-- CreateIndex
CREATE INDEX "pedidos_estado_estado_pago_idx" ON "pedidos"("estado", "estado_pago");

-- CreateIndex
CREATE INDEX "pedidos_asignado_a_id_idx" ON "pedidos"("asignado_a_id");

-- CreateIndex
CREATE INDEX "items_pedido_pedido_id_cancelada_idx" ON "items_pedido"("pedido_id", "cancelada");

-- CreateIndex
CREATE INDEX "pedidos_revisiones_pedido_id_estado_revision_idx" ON "pedidos_revisiones"("pedido_id", "estado_revision");

-- CreateIndex
CREATE INDEX "pedidos_revisiones_items_revision_id_decision_idx" ON "pedidos_revisiones_items"("revision_id", "decision");

-- CreateIndex
CREATE INDEX "pedidos_mensajes_pedido_id_created_at_idx" ON "pedidos_mensajes"("pedido_id", "created_at");

-- CreateIndex
CREATE INDEX "comprobantes_pago_pedido_id_idx" ON "comprobantes_pago"("pedido_id");

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

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_asignado_a_id_fkey" FOREIGN KEY ("asignado_a_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "pedidos_mensajes" ADD CONSTRAINT "pedidos_mensajes_autor_id_fkey" FOREIGN KEY ("autor_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes_pago" ADD CONSTRAINT "comprobantes_pago_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes_pago" ADD CONSTRAINT "comprobantes_pago_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notificaciones" ADD CONSTRAINT "notificaciones_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historial_pedidos" ADD CONSTRAINT "historial_pedidos_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "log_actividades" ADD CONSTRAINT "log_actividades_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "log_actividades" ADD CONSTRAINT "log_actividades_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
