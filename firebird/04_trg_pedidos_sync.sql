-- ============================================================================
-- 04 (oct 2026): TRG_PEDIDOS_SYNC — el ÚNICO script que hay que aplicar a la BD real
-- ============================================================================
--
-- Hace llegar a la nube lo que pasa en el Sistema Comercial (VFP) con un pedido:
--   * FINALIZADA = TRUE   → el cobro. La nube lo marca PAGADO (y cierra la tarea
--                           "registrar el cobro en el Sistema Comercial").
--   * SWCANCEL   = TRUE   → la cancelación. La nube lo cancela (y cierra la tarea
--                           "cancelar en el Sistema Comercial").
--   * TTOTAL / NOTAS / SERIEFAC / IDFACTURA → la nube avisa si el total ya no coincide.
--
-- POR QUÉ ESTE ARCHIVO Y NO 01 / 02:
--   Se probaron contra una COPIA de la BD real (DATOSINV.FDB, Firebird 3.0.10) y NO se deben aplicar a la real:
--     * 02 agrega TIENDAS.PREFIJO (las 3 primeras letras del nombre), pero la BD real ya tiene TIENDAS.SERIE
--       (HMO, MXL, CUL…), que es el prefijo de verdad.
--     * 01 y 02 hacen CREATE OR ALTER TRIGGER TRG_TIENDAS_SYNC y TRG_USUARIOS_SYNC: la BD real YA los tiene,
--       con otras columnas (CP, SERIE…). Los SOBRESCRIBIRÍAN y cambiarían qué cambios llegan a la nube.
--     * 01 y 02 crean TRG_MOVPED_SYNC, que 03 vuelve a borrar: la nube ya no sincroniza MOVPED (el pedido baja
--       con cantidades finales).
--   Lo único que le falta a la BD real es ESTE trigger. Aquí no se toca nada más.
--
-- IDEMPOTENTE: CREATE OR ALTER crea el trigger o lo reemplaza. Solo afecta a TRG_PEDIDOS_SYNC.
--
-- QUÉ NO DISPARA: los INSERT. Los pedidos de la web llegan por GRABAR_PEDIDOS y la nube ya sabe de ellos (los
-- creó ella); un pedido creado directo en VFP no le interesa. Un UPDATE que no cambia ninguna de las columnas
-- de abajo tampoco genera evento (GRABAR_PEDIDOS reintentado hace un UPDATE OR INSERT sin cambios: silencioso).
--
-- CÓMO APLICAR:
--   1. Respaldo:  gbak -b -user SYSDBA -password *** localhost:<ruta>\DATOSINV.FDB <ruta>\DATOSINV_antes_trigger.fbk
--   2. isql -user SYSDBA -password *** localhost:<ruta>\DATOSINV.FDB -i 04_trg_pedidos_sync.sql
--   3. Verificar:
--        SELECT TRIM(RDB$TRIGGER_NAME), RDB$TRIGGER_INACTIVE FROM RDB$TRIGGERS
--         WHERE TRIM(RDB$RELATION_NAME) = 'PEDIDOS' AND COALESCE(RDB$SYSTEM_FLAG,0) = 0;
--      Debe salir TRG_PEDIDOS_SYNC con INACTIVE = 0 (o NULL).
--
-- ROLLBACK:  DROP TRIGGER TRG_PEDIDOS_SYNC;
--
-- IMPACTO: cada UPDATE de PEDIDOS que cambie alguna de esas columnas inserta UNA fila en BANDEJA_SYNC (lo mismo que
-- ya hacen los otros 15 triggers). VFP marca FINALIZADA en cada venta: son decenas de filas al día por tienda. El
-- agente las lee, y la nube ignora (sin ruido) las de pedidos que no creó ella.
-- ============================================================================

SET TERM ^ ;

CREATE OR ALTER TRIGGER TRG_PEDIDOS_SYNC FOR PEDIDOS
ACTIVE AFTER UPDATE POSITION 10
AS
BEGIN
  IF (
         COALESCE(OLD.SWCANCEL, FALSE) <> COALESCE(NEW.SWCANCEL, FALSE)
      OR COALESCE(OLD.FINALIZADA, FALSE) <> COALESCE(NEW.FINALIZADA, FALSE)
      OR COALESCE(OLD.TTOTAL, 0) <> COALESCE(NEW.TTOTAL, 0)
      OR COALESCE(OLD.NOTAS, '') <> COALESCE(NEW.NOTAS, '')
      OR COALESCE(OLD.SERIEFAC, '') <> COALESCE(NEW.SERIEFAC, '')
      OR COALESCE(OLD.IDFACTURA, 0) <> COALESCE(NEW.IDFACTURA, 0)
  ) THEN
  BEGIN
    INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
    VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'PEDIDOS', NEW.IDPEDIDO, 'U');
  END
END ^

SET TERM ; ^

COMMIT WORK;
