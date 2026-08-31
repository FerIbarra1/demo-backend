-- CreateTable
CREATE TABLE "productos_imagenes" (
    "id" SERIAL NOT NULL,
    "producto_id" INTEGER NOT NULL,
    "color_id" INTEGER,
    "url" VARCHAR(500) NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "es_principal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "productos_imagenes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "productos_imagenes_producto_id_color_id_idx" ON "productos_imagenes"("producto_id", "color_id");

-- CreateIndex
CREATE INDEX "productos_imagenes_producto_id_es_principal_idx" ON "productos_imagenes"("producto_id", "es_principal");

-- AddForeignKey
ALTER TABLE "productos_imagenes" ADD CONSTRAINT "productos_imagenes_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos_imagenes" ADD CONSTRAINT "productos_imagenes_color_id_fkey" FOREIGN KEY ("color_id") REFERENCES "colores"("id") ON DELETE SET NULL ON UPDATE CASCADE;
