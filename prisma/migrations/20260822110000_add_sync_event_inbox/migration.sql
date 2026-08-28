-- Deduplicate Firebird change events across retries and the local upload outbox.
CREATE TABLE "sync_event_inbox" (
    "id" SERIAL NOT NULL,
    "event_id" VARCHAR(160) NOT NULL,
    "tienda_id" INTEGER NOT NULL,
    "bandeja_id" BIGINT,
    "entidad" VARCHAR(40) NOT NULL,
    "operacion" VARCHAR(1) NOT NULL,
    "local_id" INTEGER NOT NULL,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'PROCESANDO',
    "mensaje" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    CONSTRAINT "sync_event_inbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sync_event_inbox_event_id_key" ON "sync_event_inbox"("event_id");
CREATE INDEX "sync_event_inbox_tienda_id_created_at_idx" ON "sync_event_inbox"("tienda_id", "created_at");
CREATE INDEX "sync_event_inbox_estado_created_at_idx" ON "sync_event_inbox"("estado", "created_at");

ALTER TABLE "sync_event_inbox"
  ADD CONSTRAINT "sync_event_inbox_tienda_id_fkey"
  FOREIGN KEY ("tienda_id") REFERENCES "tiendas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
