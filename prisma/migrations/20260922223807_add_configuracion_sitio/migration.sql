-- CreateTable
CREATE TABLE "configuracion_sitio" (
    "id" SERIAL NOT NULL,
    "clave" VARCHAR(50) NOT NULL,
    "valor" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuracion_sitio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "configuracion_sitio_clave_key" ON "configuracion_sitio"("clave");
