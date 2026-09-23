-- PR7 (kiosko-profesional): avisar llegada para pedidos web.
--
-- Decisión de diseño: NO añadir un estado al enum EstadoPedido. La
-- llegada es ortogonal al ciclo de vida del pedido (puede ocurrir en
-- REVIEWING, PENDING_PAID, PAID, SHIPPED, etc.) — meterla como estado
-- rompería la máquina de transiciones. En su lugar, columnas en Pedido
-- con un campo derivado en el mapper del mostrador.
--
-- PR7 además añade un índice en pedidos_pendientes_envio.externalFolio
-- que faltaba (bug latente: la búsqueda por folio hacía seq scan).

-- Enum del canal por el que el cliente (o un operador) anunció la llegada.
CREATE TYPE "CanalLlegada" AS ENUM ('QR', 'FOLIO', 'WEB', 'MOSTRADOR');

ALTER TABLE "pedidos"
    ADD COLUMN "llegada_anunciada_at" TIMESTAMP(3),
    ADD COLUMN "llegada_ultimo_aviso_at" TIMESTAMP(3),
    ADD COLUMN "llegada_anunciada_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "llegada_anunciada_canal" "CanalLlegada",
    ADD COLUMN "llegada_anunciada_kiosko_id" INTEGER,
    ADD COLUMN "llegada_anunciada_por" VARCHAR(60),
    ADD COLUMN "llegada_descartada_at" TIMESTAMP(3),
    ADD COLUMN "llegada_descartada_por_id" INTEGER;

-- FK opcional al kiosko (SetNull si el kiosko se elimina).
ALTER TABLE "pedidos"
    ADD CONSTRAINT "pedidos_llegada_anunciada_kiosko_id_fkey"
    FOREIGN KEY ("llegada_anunciada_kiosko_id") REFERENCES "kioskos"("id")
    ON DELETE SET NULL;

ALTER TABLE "pedidos"
    ADD CONSTRAINT "pedidos_llegada_descartada_por_id_fkey"
    FOREIGN KEY ("llegada_descartada_por_id") REFERENCES "usuarios"("id")
    ON DELETE SET NULL;

-- Índice principal para el orden del mostrador (clientes físicamente
-- presentes primero, FIFO entre ellos).
CREATE INDEX "pedidos_tienda_llegada_idx"
    ON "pedidos" ("tienda_id", "llegada_anunciada_at")
    WHERE "llegada_descartada_at" IS NULL;

-- Bug latente: la búsqueda por externalFolio hacía seq scan.
CREATE INDEX "pedidos_pendientes_envio_external_folio_idx"
    ON "pedidos_pendientes_envio" ("external_folio");