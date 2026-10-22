-- Oct 2026: por qué canceló el CLIENTE su pedido (opcional). Aditiva: una tabla nueva, ningún dato existente cambia.
-- La fila solo existe si el cliente dio un motivo; omitirlo no guarda nada.

-- CreateTable
CREATE TABLE "pedido_cancelaciones_cliente" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "usuario_id" INTEGER,
    "motivo" VARCHAR(30) NOT NULL,
    "detalle" VARCHAR(200),
    "estado_al_cancelar" "EstadoPedido" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pedido_cancelaciones_cliente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pedido_cancelaciones_cliente_pedido_id_key" ON "pedido_cancelaciones_cliente"("pedido_id");

-- CreateIndex
CREATE INDEX "pedido_cancelaciones_cliente_tienda_id_created_at_idx" ON "pedido_cancelaciones_cliente"("tienda_id", "created_at");

-- CreateIndex
CREATE INDEX "pedido_cancelaciones_cliente_motivo_created_at_idx" ON "pedido_cancelaciones_cliente"("motivo", "created_at");

-- AddForeignKey
ALTER TABLE "pedido_cancelaciones_cliente" ADD CONSTRAINT "pedido_cancelaciones_cliente_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
