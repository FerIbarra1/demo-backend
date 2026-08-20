-- AlterTable
ALTER TABLE "pedidos_mensajes" ADD COLUMN     "item_id" INTEGER;

-- CreateIndex
CREATE INDEX "pedidos_mensajes_item_id_idx" ON "pedidos_mensajes"("item_id");

-- AddForeignKey
ALTER TABLE "pedidos_mensajes" ADD CONSTRAINT "pedidos_mensajes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items_pedido"("id") ON DELETE SET NULL ON UPDATE CASCADE;
