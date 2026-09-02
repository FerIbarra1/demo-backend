-- AlterEnum
BEGIN;
CREATE TYPE "EstadoPedido_new" AS ENUM ('PENDING_REVIEW', 'REVIEWING', 'WAITING_CUSTOMER_APPROVAL', 'PENDING_PAID', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED');
ALTER TABLE "public"."pedidos" ALTER COLUMN "estado" DROP DEFAULT;
ALTER TABLE "pedidos" ALTER COLUMN "estado" TYPE "EstadoPedido_new" USING ("estado"::text::"EstadoPedido_new");
ALTER TABLE "historial_pedidos" ALTER COLUMN "estado_anterior" TYPE "EstadoPedido_new" USING ("estado_anterior"::text::"EstadoPedido_new");
ALTER TABLE "historial_pedidos" ALTER COLUMN "estado_nuevo" TYPE "EstadoPedido_new" USING ("estado_nuevo"::text::"EstadoPedido_new");
ALTER TYPE "EstadoPedido" RENAME TO "EstadoPedido_old";
ALTER TYPE "EstadoPedido_new" RENAME TO "EstadoPedido";
DROP TYPE "public"."EstadoPedido_old";
ALTER TABLE "pedidos" ALTER COLUMN "estado" SET DEFAULT 'PENDING_REVIEW';
COMMIT;

-- DropForeignKey
ALTER TABLE "pedidos_revisiones" DROP CONSTRAINT "pedidos_revisiones_aprobada_por_id_fkey";

-- DropForeignKey
ALTER TABLE "pedidos_revisiones" DROP CONSTRAINT "pedidos_revisiones_creada_por_id_fkey";

-- DropForeignKey
ALTER TABLE "pedidos_revisiones" DROP CONSTRAINT "pedidos_revisiones_pedido_id_fkey";

-- DropForeignKey
ALTER TABLE "pedidos_revisiones_items" DROP CONSTRAINT "pedidos_revisiones_items_decided_por_id_fkey";

-- DropForeignKey
ALTER TABLE "pedidos_revisiones_items" DROP CONSTRAINT "pedidos_revisiones_items_item_pedido_original_id_fkey";

-- DropForeignKey
ALTER TABLE "pedidos_revisiones_items" DROP CONSTRAINT "pedidos_revisiones_items_nuevo_precioco_id_fkey";

-- DropForeignKey
ALTER TABLE "pedidos_revisiones_items" DROP CONSTRAINT "pedidos_revisiones_items_revision_id_fkey";

-- DropTable
DROP TABLE "pedidos_revisiones";

-- DropTable
DROP TABLE "pedidos_revisiones_items";

-- DropEnum
DROP TYPE "EstadoDecision";

-- DropEnum
DROP TYPE "EstadoRevision";

