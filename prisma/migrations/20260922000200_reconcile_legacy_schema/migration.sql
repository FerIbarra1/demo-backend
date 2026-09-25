-- Reconciliación segura de instalaciones creadas desde un schema anterior.
-- Algunas bases ya tienen esta columna; otras no. No modifica datos.
ALTER TABLE "pedidos_mensajes"
    ADD COLUMN IF NOT EXISTS "adjunto" JSONB;
