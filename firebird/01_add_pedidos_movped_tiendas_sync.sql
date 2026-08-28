-- ============================================================================
-- F9 (ago 2026): triggers Firebird adicionales para sincronización nube
-- ============================================================================
--
-- Este archivo agrega los 3 triggers que faltan para que el agente de
-- sincronización reciba los cambios de PEDIDOS, MOVPED y TIENDAS desde la
-- BD Firebird (DATOSINV.FDB). Los 14 triggers TRG_*_SYNC ya existentes
-- (CLIENTES, PRECIOS, PRODUCTOS, CORRIDAS, COLORES, etc.) cubren catálogo
-- y clientes; este archivo cubre pedidos y tiendas.
--
-- Requisito: haber aplicado el handler TIENDAS en el backend para que
-- las tiendas se creen solas en la nube a partir del externalId
-- (que equivale al IDTIENDA local de Firebird).
--
-- IMPORTANTE: este script es IDEMPOTENTE. Antes de crear cada trigger,
-- pregunta a RDB$TRIGGERS si ya existe; si sí, lo borra y lo recrea.
-- Eso permite ejecutar este archivo múltiples veces sin error.
--
-- CÓMO APLICAR:
--   1. Hacer backup completo de la BD Firebird (gbak -b ...).
--   2. Conectar con isql o cualquier herramienta:
--        isql -user SYSDBA -password masterkey \
--          localhost:C:\Datos\TIENDA.FDB \
--          -i 01_add_pedidos_movped_tiendas_sync.sql
--   3. Verificar:
--        SELECT TRIM(RDB$TRIGGER_NAME) FROM RDB$TRIGGERS
--         WHERE RDB$TRIGGER_NAME LIKE 'TRG_%_SYNC'
--           AND RDB$TRIGGER_NAME IN (
--             'TRG_PEDIDOS_SYNC','TRG_MOVPED_SYNC','TRG_TIENDAS_SYNC'
--           );
--      Deben aparecer los 3.
-- ============================================================================

SET TERM ^ ;

-- ============================================================================
-- TRG_TIENDAS_SYNC
-- ============================================================================
-- POR QUÉ EXISTE: el admin de la red crea/edita/desactiva tiendas desde
-- VFP. La nube necesita enterarse para crear/actualizar el registro en
-- su tabla `Tienda` (Tienda.externalId = IDTIENDA).
--
-- QUÉ DETECTA: cambios en ACTIVO (soft-delete), NOMBRE, DIRECCION, CIUDAD,
-- TELEFONO, EMAIL.
--
-- POR QUÉ NO DETECTA DELETE: BORRAR físicamente una tienda en Firebird
-- sería catastrófico (perdería todos los pedidos históricos). VFP usa
-- soft-delete via ACTIVO='N', no DELETE real.
--
-- COMPATIBILIDAD: FB 3.0 y 4.0. Usa CREATE OR ALTER TRIGGER (disponible
-- desde FB 1.5) en lugar del patrón DROP IF EXISTS + CREATE TRIGGER que
-- NO es soportado dentro de EXECUTE BLOCK en FB 3.0.
--
CREATE OR ALTER TRIGGER TRG_TIENDAS_SYNC FOR TIENDAS
ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 10
AS
BEGIN
  IF (INSERTING) THEN
  BEGIN
    INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
    VALUES (
      NEXT VALUE FOR BANDEJA_SYNC_ID_GEN,
      'TIENDAS',
      NEW.IDTIENDA,
      'I'
    );
  END

  IF (UPDATING) THEN
  BEGIN
    IF (
         COALESCE(TRIM(OLD.NOMBRE), '') <> COALESCE(TRIM(NEW.NOMBRE), '')
      OR COALESCE(TRIM(OLD.DIRECCION), '') <> COALESCE(TRIM(NEW.DIRECCION), '')
      OR COALESCE(TRIM(OLD.CIUDAD), '') <> COALESCE(TRIM(NEW.CIUDAD), '')
      OR COALESCE(TRIM(OLD.ACTIVO), '') <> COALESCE(TRIM(NEW.ACTIVO), '')
      OR COALESCE(TRIM(OLD.TELEFONO), '') <> COALESCE(TRIM(NEW.TELEFONO), '')
      OR COALESCE(TRIM(OLD.EMAIL), '') <> COALESCE(TRIM(NEW.EMAIL), '')
    ) THEN
    BEGIN
      INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
      VALUES (
        NEXT VALUE FOR BANDEJA_SYNC_ID_GEN,
        'TIENDAS',
        NEW.IDTIENDA,
        'U'
      );
    END
  END

  IF (DELETING) THEN
  BEGIN
    INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
    VALUES (
      NEXT VALUE FOR BANDEJA_SYNC_ID_GEN,
      'TIENDAS',
      OLD.IDTIENDA,
      'D'
    );
  END
END ^

-- ============================================================================
-- TRG_PEDIDOS_SYNC
-- ============================================================================
-- POR QUÉ EXISTE: cuando VFP/FoxPro cambia el estado de un pedido (lo
-- marca como PAGADO, CANCELADO, FACTURADO), necesitamos que esa info
-- viaje a la nube para:
--   a) Actualizar el `Pedido.estado` en PostgreSQL.
--   b) Disparar el email PAGO_CONFIRMADO al cliente.
--   c) Reflejar los cambios en tiempo real (realtime WS).
--
-- QUÉ DETECTA: cancelación (SWCANCEL), finalización/pago (FINALIZADA),
-- edición del total (TTOTAL), edición de notas, facturación (SERIEFAC,
-- IDFACTURA).
--
-- POR QUÉ INSERT NO DISPARA: los pedidos creados desde la web ya llegan
-- a Firebird por la vía opuesta (GRABAR_PEDIDOS). Solo los pedidos
-- creados directos en VFP (caso raro) requerirían esta ruta; por ahora
-- se omiten (queda igual que el comportamiento actual).
--
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
    VALUES (
      NEXT VALUE FOR BANDEJA_SYNC_ID_GEN,
      'PEDIDOS',
      NEW.IDPEDIDO,
      'U'
    );
  END
END ^

-- ============================================================================
-- TRG_MOVPED_SYNC
-- ============================================================================
-- POR QUÉ EXISTE: el bodeguero en VFP puede corregir items de un pedido
-- (cambiar cantidad, agregar uno, quitar otro). Esos ajustes también
-- deben replicarse a la nube para que el cliente vea los items
-- actualizados y bodega/monitor reflejen la realidad.
--
-- CAMBIO RESPECTO A LA VERSIÓN ANTERIOR: ANTES este trigger insertaba
-- en BANDEJA_SYNC con TABLA='PEDIDOS' e IDTABLA=NEW.IDPEDIDO. Esto hacía
-- que el PedidoPagoHandler (que solo lee SWCANCEL/FINALIZADA) ignorara
-- el evento. La versión correcta emite TABLA='MOVPED' con
-- IDTABLA=NEW.IDMOVPED, y el agente deduce IDTIENDA via join con PEDIDOS.
--
CREATE OR ALTER TRIGGER TRG_MOVPED_SYNC FOR MOVPED
ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 10
AS
BEGIN
  IF (INSERTING) THEN
  BEGIN
    INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
    VALUES (
      NEXT VALUE FOR BANDEJA_SYNC_ID_GEN,
      'MOVPED',
      NEW.IDMOVPED,
      'I'
    );
  END

  IF (UPDATING) THEN
  BEGIN
    IF (
         COALESCE(OLD.CANTIDAD, 0) <> COALESCE(NEW.CANTIDAD, 0)
      OR COALESCE(OLD.PRECIO, 0) <> COALESCE(NEW.PRECIO, 0)
    ) THEN
    BEGIN
      INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
      VALUES (
        NEXT VALUE FOR BANDEJA_SYNC_ID_GEN,
        'MOVPED',
        NEW.IDMOVPED,
        'U'
      );
    END
  END

  IF (DELETING) THEN
  BEGIN
    INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
    VALUES (
      NEXT VALUE FOR BANDEJA_SYNC_ID_GEN,
      'MOVPED',
      OLD.IDMOVPED,
      'D'
    );
  END
END ^

SET TERM ; ^

COMMIT WORK;

-- ============================================================================
-- Verificación post-instalación (descomentar para validar):
--
-- SELECT TRIM(RDB$TRIGGER_NAME) AS TRIGGER_NAME, TRIM(RDB$RELATION_NAME) AS TABLA
--   FROM RDB$TRIGGERS
--  WHERE RDB$TRIGGER_NAME IN ('TRG_PEDIDOS_SYNC','TRG_MOVPED_SYNC','TRG_TIENDAS_SYNC')
--  ORDER BY RDB$RELATION_NAME;
--
-- Deben aparecer 3 filas (MOVPED, PEDIDOS, TIENDAS).
-- ============================================================================
