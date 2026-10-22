-- ============================================================================
-- ⚠ NO APLICAR contra la BD real. SUPERADO por 04_trg_pedidos_sync.sql (oct 2026).
--   Se probó contra una copia de DATOSINV.FDB: este script sobrescribiría TRG_TIENDAS_SYNC / TRG_USUARIOS_SYNC (la
--   BD real ya los tiene, con otras columnas), agrega TIENDAS.PREFIJO cuando la BD ya trae TIENDAS.SERIE y crea
--   TRG_MOVPED_SYNC, que la nube ya no usa. Lo único que le falta a la BD real es TRG_PEDIDOS_SYNC: ver 04.
-- ============================================================================
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
-- "3. TRG_MOVPED_SYNC" de firebird/02_sync_fixes_prefijo_folio.sql.
-- ============================================================================

DROP TRIGGER TRG_MOVPED_SYNC;

COMMIT;

-- Verificación: debe dar 17 (los 14 originales + TIENDAS + PEDIDOS + USUARIOS,
-- sin MOVPED)
-- SELECT COUNT(*) FROM RDB$TRIGGERS WHERE RDB$TRIGGER_NAME LIKE 'TRG_%_SYNC';