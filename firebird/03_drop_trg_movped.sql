-- ============================================================================
-- Eliminar TRG_MOVPED_SYNC — el pedido llega a Firebird con cantidades finales
-- ============================================================================
-- El nuevo flujo: bodeguero surte en la WEB; al confirmarSurtido (PENDING_PAID)
-- el pedido baja a Firebird ya con cantidades finales. No hay ajustes en VFP
-- que re-sincronizar, así que este trigger sobra.
--
-- TRG_PEDIDOS_SYNC (pago FINALIZADA / cancelación SWCANCEL) SÍ se conserva.
--
-- CÓMO APLICAR (IBExpert):
--   1. Conectar a la BD.
--   2. SQL Editor (Ctrl+F12).
--   3. Pegar este script y ejecutar (F9).
--
-- ROLLBACK: si necesitas restaurar el trigger, ejecuta el bloque
-- "3. TRG_MOVPED_SYNC" de firebird/02_triggers_sync_sin_asumir.sql.
-- ============================================================================

DROP TRIGGER TRG_MOVPED_SYNC;

COMMIT;

-- Verificación: debe dar 17 (los 14 originales + TIENDAS + PEDIDOS + USUARIOS,
-- sin MOVPED)
-- SELECT COUNT(*) FROM RDB$TRIGGERS WHERE RDB$TRIGGER_NAME LIKE 'TRG_%_SYNC';