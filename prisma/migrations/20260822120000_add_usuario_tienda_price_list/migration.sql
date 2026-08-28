-- Store customer membership and price list per store.
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

CREATE UNIQUE INDEX "usuarios_tiendas_usuario_id_tienda_id_key"
  ON "usuarios_tiendas"("usuario_id", "tienda_id");
CREATE INDEX "usuarios_tiendas_tienda_id_local_cliente_id_idx"
  ON "usuarios_tiendas"("tienda_id", "local_cliente_id");

ALTER TABLE "usuarios_tiendas"
  ADD CONSTRAINT "usuarios_tiendas_usuario_id_fkey"
  FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "usuarios_tiendas"
  ADD CONSTRAINT "usuarios_tiendas_tienda_id_fkey"
  FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
