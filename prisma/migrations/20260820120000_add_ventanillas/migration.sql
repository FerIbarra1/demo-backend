-- F11 (ago 2026): módulo de ventanillas físicas del módulo de cajeros.
-- Cada tienda tiene N ventanillas (1, 2, 3...). El cajero elige en cuál
-- trabajar al login (1:1 via cajeroId único).

-- CreateTable
CREATE TABLE "ventanillas" (
    "id" SERIAL NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "numero" INTEGER NOT NULL,
    "cajero_id" INTEGER,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ventanillas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ventanillas_cajero_id_key" ON "ventanillas"("cajero_id");

-- CreateIndex
CREATE INDEX "ventanillas_tienda_id_idx" ON "ventanillas"("tienda_id");

-- CreateIndex
CREATE UNIQUE INDEX "ventanillas_tienda_id_numero_key" ON "ventanillas"("tienda_id", "numero");

-- AddForeignKey
ALTER TABLE "ventanillas" ADD CONSTRAINT "ventanillas_tienda_id_fkey" FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ventanillas" ADD CONSTRAINT "ventanillas_cajero_id_fkey" FOREIGN KEY ("cajero_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;