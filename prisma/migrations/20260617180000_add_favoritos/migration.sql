-- Favoritos: lista personal de productos marcados con corazón por cada cliente.
CREATE TABLE "favoritos" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "producto_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favoritos_pkey" PRIMARY KEY ("id")
);

-- Un usuario no puede tener el mismo producto como favorito dos veces.
CREATE UNIQUE INDEX "favoritos_usuario_id_producto_id_key" ON "favoritos"("usuario_id", "producto_id");

-- Acelera la query "mis favoritos" que filtra por usuario.
CREATE INDEX "favoritos_usuario_id_idx" ON "favoritos"("usuario_id");

-- Cascade: si se elimina el usuario o el producto, se limpian los favoritos relacionados.
ALTER TABLE "favoritos" ADD CONSTRAINT "favoritos_usuario_id_fkey"
    FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "favoritos" ADD CONSTRAINT "favoritos_producto_id_fkey"
    FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;