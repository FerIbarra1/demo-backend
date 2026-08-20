-- F8 (jul 2026): MailModule. Cambios:
--   - Drop enum value WHATSAPP de CanalNotificacion (queda solo EMAIL).
--   - Add MENSAJE_BODEGUERO, RESET_PASSWORD, BIENVENIDA a TipoNotificacion.
--   - Create table password_reset_tokens.
--   - Create table mensaje_bodeguero_enviado (flag "ya se envió la 1ra
--     respuesta del bodeguero" — evita spamear al cliente con cada mensaje).

-- AlterEnum
BEGIN;
CREATE TYPE "CanalNotificacion_new" AS ENUM ('EMAIL');
ALTER TABLE "notificaciones" ALTER COLUMN "canal" TYPE "CanalNotificacion_new" USING ("canal"::text::"CanalNotificacion_new");
ALTER TYPE "CanalNotificacion" RENAME TO "CanalNotificacion_old";
ALTER TYPE "CanalNotificacion_new" RENAME TO "CanalNotificacion";
DROP TYPE "public"."CanalNotificacion_old";
COMMIT;

-- AlterEnum
ALTER TYPE "TipoNotificacion" ADD VALUE 'MENSAJE_BODEGUERO';
ALTER TYPE "TipoNotificacion" ADD VALUE 'RESET_PASSWORD';
ALTER TYPE "TipoNotificacion" ADD VALUE 'BIENVENIDA';

-- CreateTable
CREATE TABLE "mensaje_bodeguero_enviado" (
    "pedido_id" INTEGER NOT NULL,
    "mensaje_id" INTEGER NOT NULL,
    "enviado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mensaje_bodeguero_enviado_pkey" PRIMARY KEY ("pedido_id")
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

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_key" ON "password_reset_tokens"("token");

-- CreateIndex
CREATE INDEX "password_reset_tokens_usuario_id_idx" ON "password_reset_tokens"("usuario_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "mensaje_bodeguero_enviado" ADD CONSTRAINT "mensaje_bodeguero_enviado_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensaje_bodeguero_enviado" ADD CONSTRAINT "mensaje_bodeguero_enviado_mensaje_id_fkey" FOREIGN KEY ("mensaje_id") REFERENCES "pedidos_mensajes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
