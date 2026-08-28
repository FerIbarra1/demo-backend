-- Durable dependency retry and administrative replay metadata.
ALTER TABLE "sync_event_inbox"
  ADD COLUMN "intentos" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "ultimo_error_code" VARCHAR(60),
  ADD COLUMN "payload" JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX "sync_event_inbox_retry_idx"
  ON "sync_event_inbox"("estado", "next_attempt_at");
