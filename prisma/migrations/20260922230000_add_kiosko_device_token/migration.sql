-- PR2 (kiosko-profesional, sep 2026): identidad de dispositivo.
-- device_token_hash es SHA-256 del token que el admin pega en la tablet
-- al activarla. Se exige vía header `X-Kiosko-Token` en heartbeat y en
-- crear pedido para impedir spoofing de X-Kiosko-Id. Ver kiosko.service.ts.
-- Nullable para no romper kioskos legacy (el admin debe regenerar).

ALTER TABLE "kioskos"
    ADD COLUMN "device_token_hash" VARCHAR(64),
    ADD COLUMN "device_token_creado_at" TIMESTAMP(3);

-- Solo puede haber un kiosko con un device_token_hash dado. Dos kioskos
-- distintos no pueden compartir token (sería equivalente a tener el mismo
-- dispositivo emparejado dos veces).
CREATE UNIQUE INDEX "kioskos_device_token_hash_key" ON "kioskos"("device_token_hash")
    WHERE "device_token_hash" IS NOT NULL;