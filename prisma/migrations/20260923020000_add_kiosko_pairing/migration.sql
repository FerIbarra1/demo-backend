-- PR7 (sep 2026): emparejamiento remoto de tablets de kiosko.
-- Esta migración faltaba del historial original: la migración siguiente
-- asumía que la tabla ya existía y migrate deploy fallaba desde cero.
--
-- OJO: la tabla se crea como era el 23-sep, SIN `updated_at`. Esa columna (y su
-- índice) la agrega `20260924000000_kiosko_pairing_updated_at`. Esta migración
-- la traía ya incluida, así que desde cero la siguiente fallaba con
-- `column "updated_at" ... already exists` (P3006 en la shadow database de
-- `migrate dev`). Las bases existentes nunca ejecutaron este archivo (se
-- marcó con `migrate resolve`), solo cambia su checksum.

CREATE TYPE "KioskoPairingEstado" AS ENUM (
    'PENDIENTE', 'APROBADO', 'RECLAMADO', 'EXPIRADO', 'CANCELADO'
);

CREATE TABLE "kiosko_pairings" (
    "id" TEXT NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "device_secret_hash" VARCHAR(64) NOT NULL,
    "estado" "KioskoPairingEstado" NOT NULL DEFAULT 'PENDIENTE',
    "tienda_id_hint" INTEGER,
    "kiosko_id_hint" INTEGER,
    "kiosko_id" INTEGER,
    "aprobado_por_id" INTEGER,
    "aprobado_at" TIMESTAMP(3),
    "reclamado_at" TIMESTAMP(3),
    "intentos_fallidos" INTEGER NOT NULL DEFAULT 0,
    "ip_primera_vista" VARCHAR(64),
    "user_agent" VARCHAR(255),
    "expira_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "kiosko_pairings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kiosko_pairings_code_hash_key" ON "kiosko_pairings" ("code_hash");
CREATE INDEX "kiosko_pairings_estado_expira_at_idx" ON "kiosko_pairings" ("estado", "expira_at");
CREATE INDEX "kiosko_pairings_kiosko_id_idx" ON "kiosko_pairings" ("kiosko_id");

ALTER TABLE "kiosko_pairings"
    ADD CONSTRAINT "kiosko_pairings_kiosko_id_fkey"
    FOREIGN KEY ("kiosko_id") REFERENCES "kioskos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kiosko_pairings"
    ADD CONSTRAINT "kiosko_pairings_aprobado_por_id_fkey"
    FOREIGN KEY ("aprobado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
