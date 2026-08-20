-- AlterTable
ALTER TABLE "items_pedido" ADD COLUMN     "motivo_surtido" TEXT,
ADD COLUMN     "sustitucion_propuesta_precioco_id" INTEGER;

-- AddForeignKey
ALTER TABLE "items_pedido" ADD CONSTRAINT "items_pedido_sustitucion_propuesta_precioco_id_fkey" FOREIGN KEY ("sustitucion_propuesta_precioco_id") REFERENCES "preciosco"("id") ON DELETE SET NULL ON UPDATE CASCADE;
