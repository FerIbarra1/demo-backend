-- PR5 (kiosko-profesional): branding configurable desde admin.
-- ConfiguracionSitio.valor pasa de VARCHAR(500) a TEXT para soportar
-- el JSON array de keys S3 del kiosko_idle_media (más de 500 chars
-- si hay más de 5 im��genes). Reversible: los valores actuales caben
-- en TEXT sin problema.

ALTER TABLE "configuracion_sitio"
    ALTER COLUMN "valor" TYPE TEXT;