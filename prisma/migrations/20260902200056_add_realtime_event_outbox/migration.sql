-- CreateTable
CREATE TABLE "realtime_event_outbox" (
    "id" SERIAL NOT NULL,
    "room" VARCHAR(100) NOT NULL,
    "evento" VARCHAR(60) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emitido_at" TIMESTAMP(3),

    CONSTRAINT "realtime_event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "realtime_event_outbox_room_created_at_idx" ON "realtime_event_outbox"("room", "created_at");

-- CreateIndex
CREATE INDEX "realtime_event_outbox_emitido_at_idx" ON "realtime_event_outbox"("emitido_at");
