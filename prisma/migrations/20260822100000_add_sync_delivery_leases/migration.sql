-- Add durable claim/lease fields for cloud-to-agent order delivery.
ALTER TABLE "pedidos_pendientes_envio"
  ADD COLUMN "claimed_by" VARCHAR(100),
  ADD COLUMN "lease_token" VARCHAR(80),
  ADD COLUMN "lease_until" TIMESTAMP(3),
  ADD COLUMN "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "ultimo_error_code" VARCHAR(60);

CREATE INDEX "pedidos_pendientes_envio_claim_idx"
  ON "pedidos_pendientes_envio"("estado", "next_attempt_at", "lease_until");

CREATE INDEX "pedidos_pendientes_envio_lease_token_idx"
  ON "pedidos_pendientes_envio"("lease_token");
