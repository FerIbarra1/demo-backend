-- Imagenes requieren color: ya no existe el bucket "general" (color_id NULL).
--
-- 1. Reasigna cualquier imagen con color_id IS NULL al primer color del producto
--    (el de menor id entre los PrecioCO del producto) y normaliza el prefijo
--    de la key de storage para que concuerde con el color_id real.
-- 2. Pasa la columna a NOT NULL.
--
-- No se toca S3: solo se ajusta el string 'url' en la fila. Los objetos siguen
-- exactamente donde estaban en el bucket — StorageService.resolverImagen los
-- sigue sirviendo porque extrae la key del string 'url' y reconstruye la URL.
--
-- Antes de correr, hacer un SELECT de filas NULL para confirmar que existen.
-- Si tu producto activo no tiene ningún PrecioCO, esa fila quedaría sin color:
-- abortamos con un RAISE EXCEPTION claro para que sea intervención manual.

-- 1. Aborta si hay imágenes huérfanas en productos sin colores.
DO $$
DECLARE
    productos_sin_color INTEGER;
BEGIN
    SELECT COUNT(*) INTO productos_sin_color
    FROM "productos_imagenes" pi
    JOIN "productos" p ON p.id = pi."producto_id"
    WHERE pi."color_id" IS NULL
      AND p."activo" = TRUE
      AND NOT EXISTS (
          SELECT 1 FROM "preciosco" pc
          WHERE pc."producto_id" = pi."producto_id"
      );

    IF productos_sin_color > 0 THEN
        RAISE EXCEPTION
            'Hay % imágenes (color_id NULL) en productos activos sin PrecioCO. '
            'Asigna colores al producto antes de correr esta migración.',
            productos_sin_color;
    END IF;
END $$;

-- 2. Reasignación: UPDATE masivo usando el primer color (menor id) del producto.
--    Solo se tocan filas con color_id IS NULL.
WITH primer_color AS (
    SELECT DISTINCT ON (pc."producto_id")
        pc."producto_id",
        pc."color_id"
    FROM "preciosco" pc
    ORDER BY pc."producto_id", pc."color_id" ASC
)
UPDATE "productos_imagenes" pi
SET
    "color_id" = pc."color_id",
    -- Normaliza la key: "productos/{id}/general/uuid.ext" → "productos/{id}/color-N/uuid.ext".
    -- No toca filas con prefijo legacy (/products/) ni URLs absolutas ajenas al bucket.
    "url" = CASE
        WHEN pi."url" LIKE '%/general/%'
            THEN 'productos/' || pi."producto_id"::text || '/color-' || pc."color_id"::text || '/' ||
                 substring(pi."url" FROM '([^/]+)$')
        ELSE pi."url"
    END
FROM primer_color pc
WHERE pi."producto_id" = pc."producto_id"
  AND pi."color_id" IS NULL;

-- 3. Ahora que no quedan NULL, pasamos la columna a NOT NULL.
ALTER TABLE "productos_imagenes"
    ALTER COLUMN "color_id" SET NOT NULL;