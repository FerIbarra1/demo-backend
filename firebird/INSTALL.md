# Instalación de Triggers Firebird — `playerytees`

Estos triggers son los **3 que faltan** para que la sincronización
bidireccional entre tu BD Firebird local (`DATOSINV.FDB`) y el backend
nube funcione para **pedidos** y **tiendas**.

Los 13 triggers `TRG_*_SYNC` ya existentes (CLIENTES, PRECIOS, PRODUCTOS,
CORRIDAS, COLORES, etc.) los agregó alguien antes; este archivo agrega:

| Trigger | Tabla | Detecta |
|---|---|---|
| `TRG_PEDIDOS_SYNC` | `PEDIDOS` | Cancelación (SWCANCEL), pago (FINALIZADA), cambio de total, edición de notas |
| `TRG_MOVPED_SYNC` | `MOVPED` | Cambio de cantidad o precio en un item de pedido |
| `TRG_TIENDAS_SYNC` | `TIENDAS` | Cambio de nombre, dirección, ciudad, soft-delete (ACTIVO='N') |

## Por qué son necesarios

Sin estos triggers, **`BANDEJA_SYNC` no recibe notificaciones** cuando
el sistema Visual FoxPro local (en el mostrador de cada tienda) crea o
modifica un pedido, o cuando se renombra/desactiva una tienda. El
agente local (que sondea `BANDEJA_SYNC` cada 5 segundos) no se entera
de nada y la BD nube queda desincronizada.

Los triggers insertan filas en `BANDEJA_SYNC` con `IDTABLA=PEDIDOS.IDPEDIDO`
(el agente luego hace JOINS para resolver dependencias).

## Pre-requisitos

- Acceso de lectura/escritura a `DATOSINV.FDB`.
- `isql` o cualquier cliente Firebird (también hay GUI: FlameRobin, IBExpert).
- Backup reciente (¡importante!).

## Procedimiento

### Paso 1: Backup (CRÍTICO)

Antes de tocar nada, backup completo de la BD:

```bash
gbak -b localhost:C:\Datos\TIENDA.FDB C:\Backups\TIENDA_2026-08-10.fbk
```

Verifica el tamaño del archivo `.fbk` y que no esté corrupto. Si algo
sale mal, restaurar con:

```bash
gbak -r C:\Backups\TIENDA_2026-08-10.fbk localhost:C:\Datos\TIENDA.FDB
```

### Paso 2: Aplicar los triggers

Conectar con `isql` (incluido en la instalación de Firebird):

```bash
cd firebird
isql -user SYSDBA -password masterkey localhost:C:\Datos\TIENDA.FDB -i 01_add_pedidos_movped_tiendas_sync.sql
```

Si la BD está en un equipo remoto:

```bash
isql -user SYSDBA -password masterkey servidor-remoto:C:\Datos\TIENDA.FDB -i 01_add_pedidos_movped_tiendas_sync.sql
```

Reemplaza `masterkey` con la contraseña real.

### Paso 3: Verificar que se aplicaron

En `isql` (mismo cliente, conectado):

```sql
SELECT TRIM(RDB$TRIGGER_NAME) AS TRIGGER_NAME, TRIM(RDB$RELATION_NAME) AS TABLA
  FROM RDB$TRIGGERS
 WHERE RDB$TRIGGER_NAME LIKE '%_SYNC'
 ORDER BY RDB$RELATION_NAME, RDB$TRIGGER_NAME;
```

Debes ver las 16 entradas (13 originales + 3 nuevos):

```
COLORES                       TRG_COLORES_SYNC
CONFTIENDAS                    TRG_CONFTIENDAS_SYNC
CORRIDAS                       TRG_CORRIDAS_SYNC
...
MOVPED                         TRG_MOVPED_SYNC          ← NUEVO
PEDIDOS                        TRG_PEDIDOS_SYNC         ← NUEVO
...
TIENDAS                        TRG_TIENDAS_SYNC         ← NUEVO
```

### Paso 4: Probar el flujo end-to-end

1. Asegúrate de que el **agente local** (`playerytees-sync-agent`) está
   corriendo y conectado (`npm start` o como servicio Windows).

2. En VFP, abre un pedido existente y márcalo como PAGADO
   (`FINALIZADA=TRUE`) o cancelado (`SWCANCEL=TRUE`).

3. En `BANDEJA_SYNC` debería aparecer una nueva fila:

   ```sql
   SELECT * FROM BANDEJA_SYNC WHERE TABLA = 'PEDIDOS' ORDER BY ID DESC ROWS 5;
   ```

4. En 5-10 segundos, el agente la procesa y el pedido en la nube
   cambia a `PAID` (con email PAGO_CONFIRMADO enviado).

5. En el panel admin de la nube → Sincronización, deberías ver el
   evento registrado en `sync_event_log`.

### Paso 5 (opcional): limpieza de `BANDEJA_SYNC`

Con el tiempo, `BANDEJA_SYNC` acumula filas. El agente puede hacer
housekeeping, pero si quieres hacerlo manualmente:

```sql
-- Mantener los últimos 1000 IDs para diagnóstico
DELETE FROM BANDEJA_SYNC
WHERE ID < (SELECT MAX(ID) - 1000 FROM BANDEJA_SYNC);
```

Hazlo fuera de horario punta.

## Rollback

Si necesitas revertir los triggers:

```sql
DROP TRIGGER TRG_PEDIDOS_SYNC;
DROP TRIGGER TRG_MOVPED_SYNC;
DROP TRIGGER TRG_TIENDAS_SYNC;
```

(Esto NO borra datos, solo los triggers. La sincronización se detiene
pero no se pierde nada.)

## Aplicar en múltiples tiendas

Como confirmación final: **todas las tiendas comparten UNA sola BD
Firebird** (`DATOSINV.FDB` en el servidor central), así que solo necesitas
ejecutar este script UNA vez.

Si en el futuro se separan las tiendas a BDs independientes, hay que
ejecutar este script + el agente local en cada una.

## Dónde está el código que lee estos triggers

- Backend nube: `src/modules/sync/handlers/catalog.handler.ts` (catálogo),
  `cliente.handler.ts` (clientes), `pedido-pago.handler.ts` (pagos/cancelaciones).
- Agente local: `agent/src/up-processor.ts` lee `BANDEJA_SYNC` cada 5s y
  emite los eventos que estos triggers generan.
