-- ============================================================================
-- F9 (ago 2026): triggers Firebird adicionales para sincronización nube
-- ============================================================================
--
-- Los 13 triggers TRG_*_SYNC ya existentes (CLIENTES, PRECIOS, PRODUCTOS,
-- CORRIDAS, etc.) cubren cambios de catálogo y clientes. Faltan los de
-- PEDIDOS, MOVPED y TIENDAS — sin estos, el agente en la nube no se
-- entera cuando el sistema VFP local crea/modifica un pedido o cambia
-- una tienda.
--
-- IMPORTANTE: este script es IDEMPOTENTE. Antes de crear cada trigger,
-- pregunta a RDB$TRIGGERS si ya existe; si sí, lo borra y lo recrea.
-- Eso permite ejecutar este archivo múltiples veces sin error.
--
-- CÓMO APLICAR:
--   1. Hacer backup completo de la BD Firebird (gbak -b ...).
--   2. Conectar con isql o cualquier herramienta: isql -user SYSDBA
--      -password masterkey localhost:C:\Datos\TIENDA.FDB -i 01_add_*.sql
--   3. Verificar: SELECT TRIM(RDB$TRIGGER_NAME) FROM RDB$TRIGGERS
--      WHERE RDB$TRIGGER_NAME LIKE 'TRG_PEDIDOS_SYNC'
--         OR RDB$TRIGGER_NAME LIKE 'TRG_MOVPED_SYNC'
--         OR RDB$TRIGGER_NAME LIKE 'TRG_TIENDAS_SYNC';
--      Deben aparecer los 3.
-- ============================================================================

SET TERM ^ ;

-- ============================================================================
-- TRG_PEDIDOS_SYNC
-- ============================================================================
-- POR QUÉ EXISTE: cuando el sistema VFP/FoxPro (en el mostrador de cada
-- tienda) cambia el estado de un pedido (lo marca como PAGADO,
-- CANCELADO, FACTURADO, etc.), necesitamos que esa información viaje
-- a la nube para:
--   a) Actualizar el `Pedido.estado` en PostgreSQL.
--   b) Disparar el email PAGO_CONFIRMADO al cliente.
--   c) Que la UI admin / RТ ver reflejados los cambios en tiempo real.
--
-- QUÉ DETECTA: cambios en SWCANCEL (cancelado en mostrador), FINALIZADA
-- (pagado en VFP), TTOTAL (modificación manual del total por admin),
-- NOTAS (el bodeguero o cajero local agregó una nota).
--
-- POR QUÉ NO DETECTA INSERT: cuando un pedido se crea desde la web, el
-- camino es AL REVÉS (nube -> agente -> Firebird vía GRABAR_PEDIDOS).
-- Los INSERTs en PEDIDOS desde VFP son casos raros (pedidos tomados en
-- mostrador sin pasar por la web) que requieren un endpoint admin
-- especial; por ahora quedan fuera del sync automático.
--
EXECUTE BLOCK AS
BEGIN
  IF (EXISTS(SELECT 1 FROM RDB$TRIGGERS WHERE RDB$TRIGGER_NAME = 'TRG_PEDIDOS_SYNC')) THEN
    EXECUTE STATEMENT 'DROP TRIGGER TRG_PEDIDOS_SYNC';
END ^

CREATE TRIGGER TRG_PEDIDOS_SYNC FOR PEDIDOS
ACTIVE AFTER UPDATE POSITION 10
AS
BEGIN
  /* Detectar cambios relevantes: cancelación, finalización (pago),
     modificación del total, edición de notas. Las columnas como FECHA
     o IDVENDEDOR se ignoran a propósito — son cambios operativos
     internos que no necesitamos replicar. */
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
-- ya creado (cambiar cantidad, agregar uno, quitar otro). Esas
-- modificaciones también deben replicarse a la nube para que el cliente
-- vea en su "Mis Pedidos" los ajustes hechos por bodega.
--
-- QUÉ DETECTA: cambios en CANTIDAD o PRECIO de cualquier item.
-- No detecta INSERT (los nuevos ítems vía VFP se manejan por un
-- endpoint admin manual en la nube, no por sync automático).
--
-- POR QUÉ ES POSITION 10 también: para que se dispare DESPUÉS de
-- cualquier trigger BEFORE/AFTER que la BD pueda tener. No debería
-- chocar con los triggers MOVINV_AI/AU/AD del schema original porque
-- son sobre MOVINV, no MOVPED.
--
EXECUTE BLOCK AS
BEGIN
  IF (EXISTS(SELECT 1 FROM RDB$TRIGGERS WHERE RDB$TRIGGER_NAME = 'TRG_MOVPED_SYNC')) THEN
    EXECUTE STATEMENT 'DROP TRIGGER TRG_MOVPED_SYNC';
END ^

CREATE TRIGGER TRG_MOVPED_SYNC FOR MOVPED
ACTIVE AFTER UPDATE POSITION 10
AS
BEGIN
  IF (
         COALESCE(OLD.CANTIDAD, 0) <> COALESCE(NEW.CANTIDAD, 0)
      OR COALESCE(OLD.PRECIO, 0) <> COALESCE(NEW.PRECIO, 0)
  ) THEN
  BEGIN
    /* El BANDEJA_SYNC.IDTABLA guarda IDMOVPED, pero el handler de la
       nube necesita saber a qué pedido pertenece. Devolvemos el IDPEDIDO
       en lugar del IDMOVPED para que el handler pueda resolver via
       ExternalRef(PEDIDO) sin tener que joinear aquí. */
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
-- TRG_TIENDAS_SYNC
-- ============================================================================
-- POR QUÉ EXISTE: el operador admin de la red puede crear/desactivar
-- tiendas desde VFP. La nube necesita enterarse para reflejar esos
-- cambios en su tabla `Tienda` (CREATE / UPDATE / SOFT-DELETE).
--
-- QUÉ DETECTA: cambios en ACTIVO (campo char(1) 'S'/'N'), NOMBRE,
-- DIRECCION, CIUDAD.
--
-- POR QUÉ DELETE NO DISPARA: BORRAR físicamente una tienda en Firebird
-- sería catastrófico (perdería todos los pedidos históricos). VFP usa
-- soft-delete via ACTIVO='N', no DELETE real. Por eso el trigger solo
-- detecta UPDATE de ACTIVO.
--
-- POR QUÉ POSITION 10: convención del resto de TRG_*_SYNC.
--
EXECUTE BLOCK AS
BEGIN
  IF (EXISTS(SELECT 1 FROM RDB$TRIGGERS WHERE RDB$TRIGGER_NAME = 'TRG_TIENDAS_SYNC')) THEN
    EXECUTE STATEMENT 'DROP TRIGGER TRG_TIENDAS_SYNC';
END ^

CREATE TRIGGER TRG_TIENDAS_SYNC FOR TIENDAS
ACTIVE AFTER UPDATE POSITION 10
AS
BEGIN
  IF (
         COALESCE(OLD.NOMBRE, '') <> COALESCE(NEW.NOMBRE, '')
      OR COALESCE(OLD.DIRECCION, '') <> COALESCE(NEW.DIRECCION, '')
      OR COALESCE(OLD.CIUDAD, '') <> COALESCE(NEW.CIUDAD, '')
      OR COALESCE(TRIM(OLD.ACTIVO), '') <> COALESCE(TRIM(NEW.ACTIVO), '')
      OR COALESCE(OLD.TELEFONO, '') <> COALESCE(NEW.TELEFONO, '')
      OR COALESCE(OLD.EMAIL, '') <> COALESCE(NEW.EMAIL, '')
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
END ^

SET TERM ; ^

COMMIT WORK;

-- ============================================================================
-- Verificación post-instalación (descomentar si quieres validar):
--
-- SELECT TRIM(RDB$TRIGGER_NAME) AS TRIGGER_NAME, RDB$RELATION_NAME AS TABLA
--   FROM RDB$TRIGGERS
--  WHERE RDB$TRIGGER_NAME LIKE '%_SYNC'
--  ORDER BY RDB$RELATION_NAME, RDB$TRIGGER_NAME;
-- ============================================================================
