# Instalación del trigger de pedidos en Firebird — `playerytees`

**Un solo script: `04_trg_pedidos_sync.sql`.** Crea `TRG_PEDIDOS_SYNC`, el trigger que le avisa a la nube cuando el
Sistema Comercial **cobra** (`FINALIZADA`) o **cancela** (`SWCANCEL`) un pedido, o cambia su total.

> `01_`, `02_` y `03_` quedan como historia y **no se deben aplicar**: se probaron contra una copia de la BD real
> (Firebird 3.0.10) y sobrescribirían `TRG_TIENDAS_SYNC` y `TRG_USUARIOS_SYNC` (la BD real ya los tiene, con otras
> columnas), agregarían `TIENDAS.PREFIJO` cuando la BD ya trae `TIENDAS.SERIE`, y crearían `TRG_MOVPED_SYNC`, que la
> nube ya no usa. A la BD real solo le falta `TRG_PEDIDOS_SYNC`.

## Qué cambia en la nube cuando está instalado

| En el Sistema Comercial | En la nube |
|---|---|
| `ACTUALIZA_PEDIDOS` (cobro: `FINALIZADA = TRUE`) | El pedido pasa a PAGADO (con su correo e historial) y se cierra la tarea "registrar el cobro" |
| `CANCELA_PEDIDOS` (`SWCANCEL = TRUE`) | El pedido pasa a CANCELADO y se cierra la tarea "cancelar en el Sistema Comercial" |
| Cambia `TTOTAL`, `NOTAS`, `SERIEFAC` o `IDFACTURA` | Si el total ya no coincide, la salud del sistema lo marca |

No dispara con los `INSERT` (los pedidos de la web los creó la nube) ni con un `UPDATE` que no cambie esas columnas.
Cada cambio inserta UNA fila en `BANDEJA_SYNC`, como ya hacen los otros triggers. Los pedidos que se capturan en VFP y
que la nube no conoce generan un evento que la nube ignora sin ruido.

## Aplicar

1. **Respaldo** (siempre):
   `gbak -b -user SYSDBA -password *** localhost:C:\Datos\DATOSINV.FDB C:\Backups\DATOSINV_antes_trigger.fbk`
2. **Script** (idempotente: `CREATE OR ALTER`, solo toca `TRG_PEDIDOS_SYNC`):
   `isql -user SYSDBA -password *** localhost:C:\Datos\DATOSINV.FDB -i 04_trg_pedidos_sync.sql`
3. **Verificar**:
   ```sql
   SELECT TRIM(RDB$TRIGGER_NAME), RDB$TRIGGER_INACTIVE FROM RDB$TRIGGERS
    WHERE TRIM(RDB$RELATION_NAME) = 'PEDIDOS' AND COALESCE(RDB$SYSTEM_FLAG,0) = 0;
   ```
   Debe salir `TRG_PEDIDOS_SYNC` con `INACTIVE` en 0.

**Rollback:** `DROP TRIGGER TRG_PEDIDOS_SYNC;`

## Qué se probó (oct 2026, copia de la BD real en Docker, agente real, nube de prueba)

Cobro y cancelación desde el Sistema Comercial → la nube los refleja; cancelar en la nube un pedido que ya está allá
abre la tarea y el evento posterior la cierra sola; un pedido de VFP que la nube no creó no deja errores; con el trigger
APAGADO, la **conciliación activa** del agente (cada 10 min) detecta y corrige lo que el aviso no trajo.
Ver `CLAUDE.md` § "Destrabar pedidos" → etapa 3.
