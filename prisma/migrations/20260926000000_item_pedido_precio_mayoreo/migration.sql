-- Promo de volumen (sep 2026): 12+ piezas → precio de lista 2.
--
-- Cada item congela los DOS precios candidatos al crear el pedido; el efectivo
-- sigue viviendo en `precio_unitario`, así que el ERP, los totales y toda la UI
-- existente no cambian.
--
-- El par congelado es lo que permite RE-EVALUAR la promo cuando el pedido
-- cambia de tamaño (bodega surte de menos, mostrador agrega productos) sin
-- releer `preciosco`: ese precio pudo cambiar en Firebird mientras el pedido
-- estaba en bodega, y la variante pudo borrarse (`precioco_id` es nullable).
--
-- Ambas columnas son NULLABLE a propósito: las filas existentes quedan en NULL
-- y nunca entran a la regla, así que la migración es aditiva y sin riesgo.

ALTER TABLE "items_pedido"
    ADD COLUMN "precio_unitario_base" DECIMAL(10, 2),
    ADD COLUMN "precio_unitario_mayoreo" DECIMAL(10, 2);
