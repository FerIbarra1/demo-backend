-- ============================================================================
-- F9 (ago 2026) — Triggers Firebird 3.0 para sync nube
-- ============================================================================
--
-- Este archivo agrega los 3 triggers que FALTAN a la BD Firebird (DATOSINV.FDB)
-- para soportar el flujo completo de pedidos. Los 14 triggers originales
-- (CLIENTES, PRODUCTOS, CORRIDAS, COLORES, etc.) YA EXISTEN en tu BD y
-- NO se tocan aquí.
--
-- Lo que agrega este script:
--   1. Columna PREFIJO a TIENDAS (VFP la va a llenar manualmente por tienda).
--   2. TRG_TIENDAS_SYNC (sincroniza creación/edición/desactivación de tiendas
--      a la nube, incluyendo el nuevo campo PREFIJO).
--   3. TRG_PEDIDOS_SYNC (sincroniza cambios en PEDIDOS: cancelación, pago,
--      facturación — disparado por VFP/Firebird).
--   4. TRG_MOVPED_SYNC (sincroniza ajustes del bodeguero en items de pedido:
--      cambio de cantidad, precio, etc.).
--   5. TRG_USUARIOS_SYNC (sincroniza usuarios/empleados de tienda para que la
--      nube los pueda autenticar vía JWT).
--
-- COMPATIBILIDAD: Firebird 3.0 y 4.0.
--   - Usa CREATE OR ALTER TRIGGER (disponible desde FB 1.5).
--   - Usa NEXT VALUE FOR (estándar SQL, disponible desde FB 2.0).
--   - No usa DROP TRIGGER dentro de EXECUTE BLOCK (no soportado en FB 3.0).
--
-- IMPORTANTE: este script es IDEMPOTENTE. CREATE OR ALTER TRIGGER crea el
-- trigger si no existe, o lo reemplaza si ya existe. La columna PREFIJO se
-- agrega con EXECUTE BLOCK + verificación previa.
--
-- CÓMO APLICAR (Windows):
--   1. Hacer backup completo de la BD Firebird:
--        "C:\Program Files\Firebird\Firebird_3_0\bin\gbak.exe" -b ^
--          -user SYSDBA -password masterkey ^
--          localhost:C:\Datos\DATOSINV.FDB ^
--          C:\Backups\DATOSINV_YYYYMMDD_HHMMSS.fbk
--   2. Abrir cmd y conectar:
--        "C:\Program Files\Firebird\Firebird_3_0\bin\isql.exe" ^
--          -user SYSDBA -password masterkey ^
--          localhost:C:\Datos\DATOSINV.FDB
--   3. En el prompt de isql, ejecutar:
--        INPUT 'C:\Migraciones\02_sync_fixes_prefijo_folio.sql';
--        COMMIT;
--   4. Verificar:
--        SELECT TRIM(RDB$TRIGGER_NAME) FROM RDB$TRIGGERS
--         WHERE RDB$TRIGGER_NAME LIKE 'TRG_%_SYNC' ORDER BY RDB$TRIGGER_NAME;
--      Deben aparecer 17 triggers (14 originales + TIENDAS + PEDIDOS + MOVPED).
--        SELECT IDTIENDA, NOMBRE, PREFIJO FROM TIENDAS ORDER BY IDTIENDA;
--      Las tiendas activas deben tener PREFIJO de 3 chars.
-- ============================================================================

SET TERM ^ ;

-- ============================================================================
-- 1. Agregar columna PREFIJO a TIENDAS
-- ============================================================================
-- Para generar folios con prefijo (MXL-20260826-000001). VFP mantiene la
-- correspondencia tienda→prefijo. La nube lo sincroniza al campo
-- `tienda.prefijo_folio` para mostrar el folio correcto.

EXECUTE BLOCK AS
BEGIN
  IF (NOT EXISTS(SELECT 1 FROM RDB$RELATION_FIELDS
                 WHERE RDB$RELATION_NAME = 'TIENDAS'
                   AND RDB$FIELD_NAME = 'PREFIJO')) THEN
  BEGIN
    EXECUTE STATEMENT 'ALTER TABLE TIENDAS ADD PREFIJO VARCHAR(5)';
  END
END ^

-- Auto-poblar con las primeras 3 letras del nombre (en mayúsculas).
-- Esto se puede sobreescribir manualmente con un UPDATE específico por tienda.
EXECUTE BLOCK AS
DECLARE VARIABLE IDTIENDA INTEGER;
DECLARE VARIABLE NOMBRE VARCHAR(100);
BEGIN
  FOR SELECT FIRST 100 IDTIENDA, NOMBRE FROM TIENDAS
      INTO :IDTIENDA, :NOMBRE DO
  BEGIN
    UPDATE TIENDAS
       SET PREFIJO = UPPER(SUBSTRING(NOMBRE FROM 1 FOR 3))
     WHERE IDTIENDA = :IDTIENDA
       AND (PREFIJO IS NULL OR TRIM(PREFIJO) = '');
  END
END ^

-- ============================================================================
-- 2. TRG_TIENDAS_SYNC
-- ============================================================================
-- POR QUÉ EXISTE: el admin de la red crea/edita/desactiva tiendas desde VFP.
-- La nube necesita enterarse para crear/actualizar el registro en su tabla
-- `Tienda` (Tienda.externalId = IDTIENDA).
--
-- QUÉ DETECTA: cambios en ACTIVO (soft-delete), NOMBRE, DIRECCION, CIUDAD,
-- TELEFONO, EMAIL, PREFIJO.
--
-- POR QUÉ NO DETECTA DELETE REAL: BORRAR físicamente una tienda en Firebird
-- sería catastrófico. VFP usa soft-delete via ACTIVO='N'.
--
-- Idempotente: si ya existe, lo reemplaza (CREATE OR ALTER).

CREATE OR ALTER TRIGGER TRG_TIENDAS_SYNC FOR TIENDAS
ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 10
AS
BEGIN
  IF (INSERTING) THEN
  BEGIN
    INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
    VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'TIENDAS', NEW.IDTIENDA, 'I');
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
      OR COALESCE(TRIM(OLD.PREFIJO), '') <> COALESCE(TRIM(NEW.PREFIJO), '')
    ) THEN
    BEGIN
      INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
      VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'TIENDAS', NEW.IDTIENDA, 'U');
    END
  END

  IF (DELETING) THEN
  BEGIN
    INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
    VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'TIENDAS', OLD.IDTIENDA, 'D');
  END
END ^

-- ============================================================================
-- 3. TRG_PEDIDOS_SYNC
-- ============================================================================
-- POR QUÉ EXISTE: cuando VFP/FoxPro cambia el estado de un pedido (lo marca
-- como PAGADO, CANCELADO, FACTURADO), necesitamos que esa info viaje a la
-- nube para:
--   a) Actualizar el `Pedido.estado` en PostgreSQL.
--   b) Disparar el email PAGO_CONFIRMADO al cliente.
--   c) Reflejar los cambios en tiempo real (realtime WS).
--
-- QUÉ DETECTA: cancelación (SWCANCEL), finalización/pago (FINALIZADA),
-- edición del total (TTOTAL), edición de notas, facturación (SERIEFAC, IDFACTURA).
--
-- POR QUÉ INSERT NO DISPARA: los pedidos creados desde la web ya llegan a
-- Firebird por la vía opuesta (GRABAR_PEDIDOS). Solo los pedidos creados
-- directos en VFP (caso raro) requerirían esta ruta; por ahora se omiten.

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

-- ============================================================================
-- 4. TRG_MOVPED_SYNC
-- ============================================================================
-- POR QUÉ EXISTE: el bodeguero en VFP puede corregir items de un pedido
-- (cambiar cantidad, agregar uno, quitar otro). Esos ajustes también deben
-- replicarse a la nube para que el cliente vea los items actualizados y
-- bodega/monitor reflejen la realidad.
--
-- Detecta cambios en CANTIDAD y PRECIO. Emite TABLA='MOVPED' con
-- IDTABLA=NEW.IDMOVPED, y el agente deduce IDTIENDA via join con PEDIDOS.

CREATE OR ALTER TRIGGER TRG_MOVPED_SYNC FOR MOVPED
ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 10
AS
BEGIN
  IF (INSERTING) THEN
  BEGIN
    INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
    VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'MOVPED', NEW.IDMOVPED, 'I');
  END

  IF (UPDATING) THEN
  BEGIN
    IF (
         COALESCE(OLD.CANTIDAD, 0) <> COALESCE(NEW.CANTIDAD, 0)
      OR COALESCE(OLD.PRECIO, 0) <> COALESCE(NEW.PRECIO, 0)
    ) THEN
    BEGIN
      INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
      VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'MOVPED', NEW.IDMOVPED, 'U');
    END
  END

  IF (DELETING) THEN
  BEGIN
    INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
    VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'MOVPED', OLD.IDMOVPED, 'D');
  END
END ^

-- ============================================================================
-- 5. TRG_USUARIOS_SYNC
-- ============================================================================
-- POR QUÉ EXISTE: VFP gestiona empleados/usuarios de tienda en su propia BD.
-- Para que la nube pueda autenticar empleados vía JWT, debe conocerlos.
-- La nube los matchea por EMAIL (case-insensitive).

CREATE OR ALTER TRIGGER TRG_USUARIOS_SYNC FOR USUARIOS
ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 10
AS
BEGIN
  IF (INSERTING) THEN
  BEGIN
    INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
    VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'USUARIOS', NEW.IDUSUARIO, 'I');
  END

  IF (UPDATING) THEN
  BEGIN
    IF (
         COALESCE(TRIM(OLD.NOMBRE), '') <> COALESCE(TRIM(NEW.NOMBRE), '')
      OR COALESCE(TRIM(OLD.USUARIO), '') <> COALESCE(TRIM(NEW.USUARIO), '')
      OR COALESCE(TRIM(OLD.EMAIL), '') <> COALESCE(TRIM(NEW.EMAIL), '')
      OR COALESCE(TRIM(OLD.ACTIVO), '') <> COALESCE(TRIM(NEW.ACTIVO), '')
      OR COALESCE(TRIM(OLD.AUTORIZA), '') <> COALESCE(TRIM(NEW.AUTORIZA), '')
      OR COALESCE(TRIM(OLD.SUPER), '') <> COALESCE(TRIM(NEW.SUPER), '')
    ) THEN
    BEGIN
      INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
      VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'USUARIOS', NEW.IDUSUARIO, 'U');
    END
  END

  IF (DELETING) THEN
  BEGIN
    INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
    VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'USUARIOS', OLD.IDUSUARIO, 'D');
  END
END ^

SET TERM ; ^

COMMIT WORK;

-- ============================================================================
-- Verificación post-instalación:
--
-- 1. Verificar que los 18 triggers están activos:
--    SELECT TRIM(RDB$TRIGGER_NAME) AS TRIGGER_NAME
--      FROM RDB$TRIGGERS
--     WHERE RDB$TRIGGER_NAME LIKE 'TRG_%_SYNC'
--     ORDER BY TRIGGER_NAME;
--    Deben aparecer: CLIENTES, CLIENTESCXC, CLITIEN, CLITIENCXC, COLORES,
--    CONFTIENDAS, CORRIDAS, CORRIDASREN, LINEAS, MOVPED, PEDIDOS, PRECIOS,
--    PRECIOSCO, PRODUCTOS, SUBLINEAS, TIENDAS, USUARIOS, USUARIOSTIENDAS,
--    VENDEDORES (18 triggers en total: 14 originales + 4 nuevos).
--
-- 2. Verificar que TIENDAS tiene columna PREFIJO:
--    SELECT IDTIENDA, NOMBRE, PREFIJO FROM TIENDAS ORDER BY IDTIENDA;
--    Las tiendas activas deben tener PREFIJO de 3 chars.
--
-- 3. Ajustar manualmente los prefijos que no coincidan:
--    UPDATE TIENDAS SET PREFIJO = 'MXL' WHERE IDTIENDA = 1;
--    UPDATE TIENDAS SET PREFIJO = 'HMO' WHERE IDTIENDA = 2;
-- ============================================================================
