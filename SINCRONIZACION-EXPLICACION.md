# Cómo funciona la sincronización Firebird ↔ Nube — Explicación paso a paso

> Documento explicativo complementario al plan
> `/Users/fernandoibarra/.claude/plans/idempotent-floating-ritchie.md` y al
> código del proyecto.

---

## Arquitectura general: el flujo completo

```
╔════════════════════════════════════════╗      ╔════════════════════════════════════════╗
║   SERVIDOR CENTRAL FIREBIRD (10+       ║      ║   NUBE (PostgreSQL + NestJS)            ║
║   sucursales → 1 sola BD DATOSINV.FDB) ║      ║                                        ║
║                                        ║      ║   PostgreSQL                            ║
║  ┌─────────────���─────────────────┐    ║      ║   ┌──────────────────────────────┐     ║
║  │   VFP + FoxPro + 10 cajeros   │    ║      ║   │  Mismo modelo de Prisma       │     ║
║  │   modificando CLIENTES,       │    ║      ║   │  (Usuario, Pedido, Producto,  │     ║
║  │   PRODUCTOS, PEDIDOS, etc.    │    ║      ║   │   Precio, PrecioCO, etc.)     │     ║
║  └───────────────┬───────────────┘    ║      ║   └──────────────────────────────┘     ║
║                  ↓ dispara triggers   ║      ║             ↑ REST ↑                  ║
║  ┌───────────────────────────────┐    ║      ║   ┌──────────────────────────────┐     ║
║  │   BANDEJA_SYNC (cola)         │    ║ HTTPS ║   │  NestJS API REST (/api/...)  │     ║
║  │   INSERTs automáticos         │◀───┼──────┼──▶│                              │     ║
║  │   por 16 triggers TRG_*_SYNC  │    ║      ║   │  SyncModule:                 │     ║
║  └───────────────┬───────────────┘    ║      ║   │    /sync/agent/*             │     ║
║                  ↑ lee cada 5s        ║      ║   └──────────────────────────────┘     ║
║  ┌───────────────────────────────┐    ║      ║             ↑                            ║
║  │   AGENTE (Node.js)            │    ║      ║             │ Web → crea pedido         ║
║  │   playerytees-sync-agent.exe  │────┼──────┼─────────────┘   encolar para baja        ║
║  │   corre como servicio Win     │    ║      ║                                        ║
║  └───────────────────────────────┘    ║      ╚════════════════════════════════════════╝
╚════════════════════════════════════════╝
```

**El servidor central Firebird** es UNA sola BD. Todas las tiendas se
identifican por la columna `IDTIENDA` (presente en CLIENTES, PEDIDOS,
PRECIOS, PRODUCTOS_TIENDA, etc.). Eso simplifica todo: **un solo agente**
corre en ese servidor y mantiene un checkpoint por tienda.

---

## PASO A PASO: sentido 1 → Firebird → Nube (catálogo, clientes, pagos)

### 1. El operador en VFP modifica un dato

Por ejemplo, en el sistema Visual FoxPro, el bodeguero cambia el precio
del producto X para la tienda Y:

```foxpro
USE PRECIOS
LOCATE FOR IDPRODUCTO = 123 AND IDTIENDA = 5
REPLACE PRECIO2 WITH 159.90   && nueva lista 2
USE
```

### 2. El trigger `TRG_PRECIOS_SYNC` ejecuta automáticamente

Tu BD Firebird ya tiene (la configuró el DBA hace tiempo) este trigger:

```sql
CREATE TRIGGER TRG_PRECIOS_SYNC FOR PRECIOS
ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 10
AS
BEGIN
  IF (UPDATING) THEN
  BEGIN
    IF (COALESCE(OLD.PRECIO2, 0) <> COALESCE(NEW.PRECIO2, 0)) THEN
      INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
      VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'PRECIOS', NEW.IDPRECIO, 'U');
  END
  ...
END ^
```

**Qué hace**: cuando `OLD.PRECIO2 <> NEW.PRECIO2`, inserta una fila en
`BANDEJA_SYNC` con `TABLA='PRECIOS'`, `IDTABLA=12345` (el ID interno
del registro), `OPERACION='U'`. La columna `ID` se auto-incrementa vía
`BANDEJA_SYNC_ID_GEN`. **Todo esto es automático: ni VFP ni el operador
lo notan.**

### 3. El agente local sondea cada 5 segundos

El archivo `agent/src/up-processor.ts` corre un loop infinito:

```ts
while (running) {
  await up.runOnce();
  await down.runOnce();
  await sleep(5000);
}
```

Dentro de `runOnce()`:

```sql
SELECT FIRST 200 ID, TRIM(TABLA), IDTABLA, OPERACION
FROM BANDEJA_SYNC
WHERE ID > :lastCheckpoint
ORDER BY ID ASC
```

`:lastCheckpoint` viene del archivo SQLite local `agent-data.db`. En la
primera ejecución es 0; después de cada batch exitoso se avanza.

### 4. El agente lee el registro completo

Para cada `BANDEJA_SYNC.ID`, el agente hace una segunda query contra la
tabla real:

```sql
SELECT "IDPRECIO", "IDPRODUCTO", "IDTIENDA", "PRECIO1", "PRECIO2",
       "PRECIO3", "PRECIO4", "PRECIO5", "PRECIO6", "REORDEN"
FROM PRECIOS WHERE IDPRECIO = ?
```

Las columnas se descubren dinámicamente consultando
`RDB$RELATION_FIELDS` (esta lista se cachea en memoria para no repetir).

### 5. Resuelve el `localTiendaId` y arma el evento

`agente/src/tienda-resolver.ts` mira la entidad del evento:

- `PRECIOS` tiene `IDTIENDA` en sus propios datos → `localTiendaId=5`.
- `CLIENTES` no tiene tienda directa → el agente joinea con `CLITIEN`
  para encontrarla. Si el cliente está en N tiendas, emite N eventos
  (fan-out).
- `PRODUCTOS`, `CORRIDAS`, `COLORES`, `LINEAS`, `SUBLINEAS` → entidades
  globales, `localTiendaId=null`. Se sincronizan una sola vez para
  toda la red.

El payload final es:

```json
{
  "tipo": "CATALOGO",
  "operacion": "U",
  "entidad": "PRECIOS",
  "localId": 12345,
  "localTiendaId": 5,
  "datos": {
    "IDPRODUCTO": 123,
    "IDTIENDA": 5,
    "PRECIO1": 199.90,
    "PRECIO2": 159.90,
    ...
  }
}
```

### 6. POST al backend nube

`agente/src/cloud-client.ts` hace:

```ts
POST /api/sync/agent/upload
Headers:
  X-Agent-Key: <AGENT_API_KEY>
  X-Sucursal-Id: 5
  X-Agent-Tienda-Ids: 5  (opcional, para multi-sucursal)
Body:
{
  "tiendaId": 5,
  "hastaBANDEJAId": 93847,
  "eventos": [{ ... }]
}
```

### 7. El backend autentica y procesa

**Autenticación** (`src/common/guards/api-key.guard.ts`): compara
`X-Agent-Key` contra `process.env.AGENT_API_KEY`. Si pasa, marca el
request como del agente. Si no, 401.

**Throttle**: el endpoint tiene `@SkipThrottle()` porque es un agente
interno y no debe contar contra el límite de 100 req/60s de la API
pública.

**Procesamiento** (`src/modules/sync/sync-agent.controller.ts`):
recibe el batch y delega a `SyncAgentService.procesarUpload()`.

### 8. `CatalogHandler` aplica el UPSERT

`src/modules/sync/handlers/catalog.handler.ts` ejecuta:

```ts
case 'PRECIOS':
  return this.procesarPrecio(evento);
```

```ts
private async procesarPrecio(evento) {
  // 1. Encontrar el producto en PG via ExternalRef.
  const productoSystemId = await this.externalRefs.findSystemId('PRODUCTOS', IDPRODUCTO);

  // 2. Encontrar la tienda en PG via externalId.
  const tienda = await this.prisma.tienda.findFirst({
    where: { externalId: IDTIENDA },  // TIENDAS.IDTIENDA == Tienda.externalId
  });

  // 3. UPSERT en Precio con las 6 listas.
  await this.prisma.precio.upsert({
    where: { productoId_tiendaId: { productoId, tiendaId } },
    update: {
      lista1, lista2, lista3, lista4, lista5, lista6,
      precioBase: lista1, // compatibilidad legacy
    },
    create: { productoId, tiendaId, ...listas, precioBase: lista1 },
  });

  // 4. Registrar mapeo.
  await this.externalRefs.upsert({
    systemEntity: 'PRECIO',
    systemId: nuevoPrecioId,
    localEntity: 'PRECIOS',
    localId: evento.localId,
    localTiendaId: IDTIENDA,
  });
}
```

### 9. El cliente ve el nuevo precio

El cliente autenticado (con `listaPrecioCodigo='2'` desde `CLIENTES.LISPRE`)
visita el catálogo. El endpoint `GET /api/catalogo` ejecuta
`CatalogoService.obtenerProductos`:

```ts
const columnaLista = resolverColumnaLista(usuario.listaPrecioCodigo);
// Devuelve 'lista2' si el cliente tiene LISPRE='2', o 'lista1' por defecto.

const precio = producto.precios[0];
const precioBase = Number(precio[columnaLista] ?? 0) || Number(precio.precioBase);
```

Y la respuesta JSON trae `precioBase: 159.90`. El frontend lo muestra
directamente.

### 10. Checkpoint avanza

Si todos los eventos del batch se procesaron OK, el servidor responde:

```json
{ "procesados": 1, "errores": 0, "checkpointAvanzado": true }
```

El backend guarda en `SyncCheckpoint.ultimoBANDEJAId = 93847`. Y el
agente también guarda en su `agent-data.db` (SQLite local) por si el
backend nube está caído.

El loop vuelve al paso 3. Cada 5 segundos se repite todo.

---

## PASO A PASO: sentido 2 → Nube → Firebird (pedidos nuevos)

### 1. Cliente hace checkout en la web

`POST /api/cliente/pedidos` con el carrito, dirección y método de pago.

### 2. `ClienteService.crearPedido` ejecuta

`src/modules/pedidos/cliente/cliente.service.ts`:

```ts
const pedido = await this.prisma.pedido.create({
  data: {
    numeroPedido,
    usuarioId, tiendaId,
    estado: 'PENDING_REVIEW',
    items: { create: itemsData },
    historial: { create: { estadoNuevo: 'PENDING_REVIEW' } },
    // Dentro de la MISMA transacción:
    pendienteEnvio: { create: { estado: 'PENDIENTE' } },
  },
  include: {
    items: true,
    tienda: true,
    pendienteEnvio: true,
  },
});
```

Esto crea DOS filas atómicas: el `Pedido` y su `PedidoPendienteEnvio`
(estado PENDIENTE). Si una falla, se hace rollback completo.

### 3. La columna `Pedido.id` está lista. Se notifica al cliente

Realtime (Socket.IO): `emitToTienda(pedido.tiendaId, 'pedido.creado', ...)`.
Email: `NotificationsService.enviar(pedido, TipoNotificacion.PEDIDO_RECIBIDO)`.

### 4. El agente hace `GET /poll-pedidos`

`agent/src/down-processor.ts`, cada 5s, hace:

```ts
GET /api/sync/agent/poll-pedidos?limit=20
Headers:
  X-Agent-Key: ...
  X-Sucursal-Id: 5
```

### 5. `PedidoDescargaHandler` arma el payload

`src/modules/sync/handlers/pedido-descarga.handler.ts`:

```ts
const pendientes = await prisma.pedidoPendienteEnvio.findMany({
  where: { estado: 'PENDIENTE', pedido: { tiendaId: 5 } },
  orderBy: { createdAt: 'asc' },
  take: 20,
  include: { pedido: { include: { items: { include: { precioCO: ... } } } } },
});
```

Para cada item, resuelve el `PrecioCO.id` local (Firebird) vía `ExternalRef`:

```ts
const pcoLocalId = await externalRefs.findLocalId(
  'PRECIOCO', precioCOIdNube, 'PRECIOSCO', IDTIENDA,
);
```

Si no hay mapeo, marca `skip=true` (la sucursal creará el PrecioCO
después cuando llegue la primera sincronización de catálogo).

### 6. El agente ejecuta `GRABAR_PEDIDOS`

Con el `precioCOId` local, llama al SP en Firebird:

```ts
const r1 = await tx.callScalar(
  `SELECT PEDIDO_ID, PEDIDO_FOLIO, CMENSAJEERROR
   FROM GRABAR_PEDIDOS(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    pedido.externalIdPEDIDOS ?? 0,  // 0 = nuevo, dejar que el generador asigne
    localTiendaId,
    pedido.numeroPedido,
    pedido.fechaPedido,
    pedido.clienteNombre, ...
  ],
);
```

Si `externalIdPEDIDOS` ya existe (reintento porque el agente crasheó),
se pasa como argumento: Firebird hace UPSERT en lugar de INSERT.

### 7. Por cada item, ejecuta `GRABAR_MOVPED`

```ts
const r2 = await tx.callScalar(
  `SELECT MOVPED_ID, CMENSAJEERROR FROM GRABAR_MOVPED(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [0, pedidoIdLocal, item.productoCodigo, ..., item.precioUnitario],
);
```

Todo dentro de `tx.transaction(...)` para garantizar atomicidad:
si falla CUALQUIER item, se hace rollback completo y no se queda el
pedido "huérfano" en Firebird.

### 8. `POST /pedidos-ack`

El agente confirma al backend:

```json
{
  "acks": [
    { "pedidoId": 1234, "externalIdPEDIDOS": 987, "externalFolio": "0000012345", "exito": true },
    { "pedidoId": 1235, "exito": false, "error": "GRABAR_PEDIDOS: timeout" }
  ]
}
```

### 9. `SyncAgentService.procesarPedidosAck` actualiza la cola

```ts
// Éxito:
await prisma.pedidoPendienteEnvio.update({
  where: { pedidoId: ack.pedidoId },
  data: {
    estado: 'PROCESADO',
    processedAt: new Date(),
    externalIdPEDIDOS: ack.externalIdPEDIDOS,
    externalFolio: ack.externalFolio,
  },
});

// Error: incrementar intentos. Si llega a 5, marcar ERROR.
await prisma.pedidoPendienteEnvio.update({
  data: {
    estado: 'ERROR',
    intentos: { increment: 1 },
    ultimoError: ack.error,
    ultimoIntentoAt: new Date(),
  },
});
```

También registra `ExternalRef(PEDIDO, systemId=1234, PEDIDOS,
localId=987, localTiendaId=5)` para que el siguiente evento de pago
desde Firebird pueda mapear de vuelta.

### 10. Job de mantenimiento (cron)

`SyncAgentService.expirarPedidosViejos(24h)` se invoca diariamente:

```ts
await prisma.pedidoPendienteEnvio.updateMany({
  where: { estado: 'PENDIENTE', createdAt: { lt: hace24h } },
  data: { estado: 'EXPIRADO' },
});
```

Pedidos que llevan más de 24h sin procesarse (probablemente porque el
agente lleva 24h caído en la tienda) se marcan `EXPIRADO` y el admin
recibe una alerta.

---

## PASO A PASO: Pago → email al cliente

Esta ruta es el "**killer feature**" de todo el sistema: cuando un
cliente paga en tienda, **se entera por correo al instante**.

### 1. Cajero en VFP marca el pedido como pagado

```foxpro
USE PEDIDOS
LOCATE FOR IDPEDIDO = 987
REPLACE FINALIZADA WITH .T.   && marca pago
```

### 2. `TRG_PEDIDOS_SYNC` (NUEVO, lo agregamos nosotros) dispara

```sql
IF (OLD.FINALIZADA <> NEW.FINALIZADA) THEN
  INSERT INTO BANDEJA_SYNC (ID, TABLA, IDTABLA, OPERACION)
  VALUES (NEXT VALUE FOR BANDEJA_SYNC_ID_GEN, 'PEDIDOS', 987, 'U');
```

### 3. El agente lo sube a la nube

`up-processor.ts` lee BANDEJA_SYNC, arma un `UploadEvent{tipo:'PAGO',
entidad:'PEDIDOS', datos:{FINALIZADA:true, IDPEDIDO:987, ...}}` y
hace `POST /upload`.

### 4. `PedidoPagoHandler` resuelve y delega

```ts
const pedidoIdNube = await externalRefs.findSystemId(
  'PEDIDOS', evento.localId, evento.localTiendaId
);

if (d.FINALIZADA === true) {
  await adminService.marcarComoPagado(
    pedidoIdNube,
    { fechaPago: new Date().toISOString(), referencia: 'FACTURA-...' },
    AGENT_USER,
  );
}
```

### 5. `AdminService.marcarComoPagado` (YA EXISTE, no se tocó)

Hace la transición PENDING_PAID → PAID, crea historial, emite realtime
y dispara el email `PAGO_CONFIRMADO`:

```ts
const pedidoActualizado = await tx.pedido.update({
  data: { estado: 'PAID', fechaPago, cajeroAsignadoId: null },
});

await tx.historialPedido.create({
  data: { pedidoId, estadoAnterior: 'PENDING_PAID', estadoNuevo: 'PAID', observacion: 'Pago confirmado por sistema externo' },
});

setImmediate(() => {
  this.notifications.enviar(pedidoCompleto, TipoNotificacion.PAGO_CONFIRMADO)
    .catch(err => this.logger.error(...));
});

this.realtime.emitToTienda(pedido.tiendaId, 'pedido.estado', { ... });
```

### 6. `NotificationsService` envía el email

Renderiza la plantilla React Email `mailTemplates.PagoConfirmado`:

```ts
case TipoNotificacion.PAGO_CONFIRMADO:
  subject = mailSubjects.PAGO_CONFIRMADO(pedido.numeroPedido);
  template = mailTemplates.PagoConfirmado({ pedido: pedidoData, pedidoUrl, ... });
```

Y lo envía vía SMTP (`MailService.sendEmail`). El cliente lo recibe en
su bandeja en menos de 30 segundos desde que pagó en el mostrador.

---

## ¿Y si la BD Firebird o el agente está apagado?

| Escenario | Comportamiento |
|---|---|
| Internet del servidor central cae 1h | BANDEJA_SYNC acumula. Al volver, agente sube todo en orden. `PedidoPendienteEnvio` también acumula del lado nube. |
| BD Firebird caída 30min | Agente reintenta conexión cada 10s con backoff. NO se cae el servicio. |
| Nube caída | Agente encola uploads en SQLite local (`outbox`). Cada 60s intenta vaciarla. Cuando vuelve, los mete en orden. |
| Agente crashea mid-batch | Checkpoint no avanza. Al reiniciar, lee el checkpoint de SQLite (`agent-data.db`) y reanuda. |
| Agente se reinstala | La nube mantiene el `SyncCheckpoint.ultimoBANDEJAId` por tienda. Al primer heartbeat, el agente pide el checkpoint. |
| Pedido nube creado, agente offline 24h+ | Job diario marca `estado='EXPIRADO'` y alerta al admin. |

---

## Diferencias vs la versión anterior (webhook)

| Antes | Ahora |
|---|---|
| Webhook manual `POST /admin/pedidos/:id/marcar-pagado` | El agente detecta el cambio vía trigger |
| Admin tenía que llamar al endpoint cuando cobraba | Disparado AUTOMÁTICAMENTE al marcar `FINALIZADA=TRUE` en VFP |
| Sin sync de catálogo | Precios, productos, clientes, tiendas sincronizados cada 5s |
| Sin sync de pedidos nuevos nube→local | Cola `PedidoPendienteEnvio` automática |
| Si VFP estaba offline, no había forma de enterarse | BANDEJA_SYNC acumula y se vacía cuando vuelve |

---

## Archivos clave a leer en orden

1. `/Users/fernandoibarra/Documents/Development/Playerytees/demo-backend/prisma/schema.prisma` (líneas que tengan `// F9`)
2. `src/modules/sync/sync.module.ts` — entrypoint del backend
3. `src/modules/sync/sync-agent.controller.ts` — los 5 endpoints REST
4. `src/modules/sync/sync-agent.service.ts` — orquestador del backend
5. `src/modules/sync/handlers/catalog.handler.ts` — UPSERT de catálogo
6. `src/modules/sync/handlers/pedido-pago.handler.ts` — pago confirmado
7. `agent/src/index.ts` — entrypoint del agente
8. `agent/src/up-processor.ts` — BANDEJA_SYNC → nube
9. `agent/src/down-processor.ts` — pedidos nube → GRABAR_PEDIDOS
10. `agent/src/checkpoint-store.ts` — cola durable en SQLite
11. `firebird/01_add_pedidos_movped_tiendas_sync.sql` — los 3 triggers nuevos

---

## TL;DR

1. VFP cambia un dato → trigger pone fila en BANDEJA_SYNC.
2. Agente local sondea BANDEJA_SYNC cada 5s → arma eventos → POST a `/api/sync/agent/upload`.
3. Backend procesa con `ApiKeyGuard` → handlers hacen UPSERT en PG → ExternalRef guarda mapeo.
4. Si el cliente creó pedido en la web, va a `PedidoPendienteEnvio`. El agente sondea `/poll-pedidos` cada 5s → `GRABAR_PEDIDOS` + `GRABAR_MOVPED` → ack.
5. Si VFP marca un pedido como PAGADO, el trigger `TRG_PEDIDOS_SYNC` (nuevo) mete la fila, el agente la sube, el backend llama a `AdminService.marcarComoPagado` que ya dispara el email `PAGO_CONFIRMADO`.
6. Checkpoints en PG (`SyncCheckpoint`) y SQLite local sobreviven caídas.
