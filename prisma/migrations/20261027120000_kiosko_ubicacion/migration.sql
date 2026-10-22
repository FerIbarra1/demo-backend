-- Kioskos: ubicación opcional y estado más simple.
-- AlterTable
ALTER TABLE "kioskos" ADD COLUMN "ubicacion" VARCHAR(40);

-- Un kiosko dado de alta que nunca se instaló quedaba INACTIVO con un token que nadie tenía. Ahora nace
-- ACTIVO y SIN token (el token lo entrega el emparejamiento). Se normalizan los que ya existen.
UPDATE "kioskos"
   SET "device_token_hash" = NULL, "device_token_creado_at" = NULL
 WHERE "primer_conexion_at" IS NULL AND "ultimo_heartbeat" IS NULL;

UPDATE "kioskos"
   SET "estado" = 'ACTIVO'
 WHERE "estado" = 'INACTIVO' AND "desactivado_at" IS NULL;
