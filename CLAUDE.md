# Playerytees — Backend

NestJS 11 + Prisma 6 + PostgreSQL. API de la tienda de camisetas: catálogo,
pedidos con flujo bodega → mostrador → pago, kiosko de tablet y sincronización
con el ERP (Firebird).

El frontend vive en `../demo-frontend` y tiene su propio `CLAUDE.md`.

## Comandos

```bash
npm run start:dev        # Desarrollo con watch
npm run build            # prisma generate + nest build
npm run test             # Jest (57 suites, 656 tests)
npm run lint             # ESLint con --fix

npm run prisma:migrate   # Migraciones
npm run prisma:seed      # Seed (idempotente, preserva imágenes de S3)
npm run db:up / db:down  # PostgreSQL en Docker
```

**El `lint` usa `--fix`**: formatea al correr. Si vas a revisar un diff, córrelo
antes de empezar, no después.

## Estructura

```
src/
├── common/            # Guards, decoradores, interceptores (globales)
│   ├── guards/        # jwt-auth, roles, api-key
│   └── decorators/    # @Public, @Roles, @CurrentUser, @ApiKeyAuth
├── config/app.config.ts   # Toda la config desde env (sin fallbacks peligrosos)
├── modules/
│   ├── pedidos/       # El módulo grande: ver abajo
│   ├── mostrador/     # Consola de mostrador (acciones + consultas)
│   ├── kiosko/        # Tablet: pairing, heartbeat, aviso de llegada
│   ├── realtime/      # Socket.IO + outbox de eventos
│   ├── sync/          # Agente Firebird: upload, poll, ACK
│   └── …              # auth, catalogo, precios, imagenes, mail, …
└── prisma/            # PrismaService
```

### `modules/pedidos/` en detalle

```
pedidos/
├── core/              # Compartido por todas las consolas
│   ├── pedido-state.service.ts    # LA máquina de estados
│   ├── pedido-access.service.ts   # Quién puede ver/operar qué pedido
│   ├── item-pedido.util.ts        # Alta de ItemPedido con snapshot de precios
│   ├── aplicar-propuesta-ventas.util.ts
│   ├── totales.util.ts            # Recálculo de subtotal/total
│   ├── destino-post-surtido.util.ts
│   ├── llegada-aviso.util.ts      # ¿Se puede avisar llegada?
│   ├── escaneo.util.ts            # ¿Quién tiene el pedido ahora?
│   └── …                          # urgencia, similitud, zona, promo-volumen
├── bodega/  cajero/  cliente/  ventas/  admin/  propuesta/  reposicion/
└── messages/          # Chat del pedido (con adjuntos de propuesta)
```

## Los 8 procesos del pedido

F17 (oct 2026): los estados se llaman **como los llama el negocio**. Antes el
enum decía `PENDING_REVIEW`/`EN_MOSTRADOR` y el piso decía "solicitado" y "la
plancha"; cuando código y pantalla dicen distinto, cada conversación necesita
una traducción mental y los bugs se esconden ahí.

| # | Proceso | Estado | Qué pasa |
|---|---------|--------|----------|
| 1 | Solicitado | `SOLICITADO` | El cliente lo creó. En cola de bodega. |
| 2 | En revisión | `EN_REVISION` | Un bodeguero lo tomó y lo está surtiendo. |
| 3 | **Revisado (la plancha)** | `REVISADO` | La bolsa con el ticket está en la mesa de mostrador. Si hay faltantes, el sistema ya mandó la propuesta. |
| 4 | **En mostrador** | `EN_ATENCION` | El operador llamó al cliente y está haciendo el recuento. |
| 5 | Pendiente de pago | `PENDIENTE_PAGO` | Se envió a pagar. **Aquí entra al ERP.** |
| 6 | Pagado | `PAGADO` | Cobrado en VFP. |
| 7 | (listo para entregar) | `PAGADO` sin domicilio | El operador entrega. |
| 8 | Entregado | `ENTREGADO` | Cerrado. |

Domicilio: `PAGADO → ENVIADO → ENTREGADO`. `EN_ASESORIA` y
`ESPERANDO_APROBACION` son el camino del asesor de ventas, ortogonal a la
plancha.

**Salidas de `EN_ASESORIA` (oct 2026).** `TRANSICIONES` ya contemplaba cuatro
salidas, pero solo una tenía quien la disparara (la contrapropuesta). Las otras
dos se agregaron:

- `POST /ventas/pedidos/:id/devolver-a-bodega` — el asesor revisó y no hay nada
  que negociar: el pedido vuelve a bodega a surtirse tal cual.
- `POST /pedidos/mostrador/:id/traer-a-entrega` — el operador trae al área de
  entrega un pedido en asesoría porque el cliente ya está enfrente. Antes solo
  podía "avisar llegada", que registra la presencia pero **no** mete el pedido a
  la cola (el gate exige `REVISADO`).

**El texto del cliente ES el primer mensaje del chat (oct 2026).** Cuando el
cliente presiona "Quiero ajustes" en una propuesta de bodega, el input que
aparece es **obligatorio** y su contenido se guarda como un `PedidoMensaje` con
`autorRol: CLIENTE` — el primer mensaje de la conversación con el asesor.

Antes ese texto viajaba como `nota` fuera del chat: a `PedidoPropuesta.notaCliente`
y a `Pedido.asesorSolicitudNota`, mientras el chat arrancaba con un texto fijo
("Solicitaste hablar con un asesor de ventas…"). El asesor leía "Dice: …" en su
cola pero la conversación no decía nada de lo que el cliente quería, así que
tenía que preguntar todo de nuevo. `asesorSolicitudNota` **se eliminó de la BD**
(migración `20261007120000_quitar_asesor_solicitud_nota`); la cola y el detalle
de ventas ya no la pintan.

La obligatoriedad se valida en dos sitios a propósito: `ResponderPropuestaDto`
(`@ValidateIf` sobre `CONTACTAR_ASESOR`) y `contactarAsesor` — el service es
frontera de confianza propia, lo llaman también los tests y el camino del
operador. El resto de las decisiones conservan `nota` opcional: ahí sigue siendo
el motivo que alimenta `notaCliente` y la lista de reposición.

**Los correos del ciclo de propuesta (oct 2026).** `ASESOR_SOLICITADO` estaba
cableado en `NotificationsService` (subject + template) pero **nadie lo
despachaba**: el comentario de `notifTipoParaEstado` decía que lo disparaba
`PropuestaService` y ahí no había ninguna llamada. El cliente que pedía un asesor
no recibía nada. Ya lo dispara `contactarAsesor`, después del commit.

Quedan dos tipos **muertos** que conviene conocer antes de tocar esto:

- `PROPUESTA_VENTAS` — redundante, no roto: `REVISION_PROPUESTA` ya deduce el
  origen de la propuesta PENDIENTE y manda el texto correcto para ventas. Si
  alguien lo cablea "para arreglarlo", el cliente recibe **dos** correos.
- `REVISION_RECHAZADA` — sin disparador y sin template propio. El rechazo ya
  manda `CANCELADO` (con el motivo de la reposición), así que cablearlo
  duplicaría. Se dejó a propósito; si producto lo pide, hay que crear el template
  y decidir cuál de los dos correos se reemplaza.

`REVISION_APROBADA` **sí se usa**, pero por otra vía: `enviarListoParaPagar` lo
pasa a `MailService` para el correo "listo para pagar" con QR, disparado desde el
ACK del agente. No borrar el enum: el `case` de `enviar()` es código muerto, el
enum no.

### La máquina de estados

`core/pedido-state.service.ts` es la **fuente única** de transiciones. Declara
`TRANSICIONES` y aplica historial, realtime y notificación en un solo sitio.

```
SOLICITADO → EN_REVISION → REVISADO → EN_ATENCION → PENDIENTE_PAGO → PAGADO → ENTREGADO
                  │            │            │
                  │            │            └─→ REVISADO   (deshacer la llamada)
                  │            ├─→ EN_REVISION   (el cliente pidió cambios)
                  │            └─→ CANCELADO     (+ lista de reposición)
                  └─→ PENDIENTE_PAGO  (solo DOMICILIO: salta mostrador)
```

### Tres invariantes que sostienen el diseño

1. **El ERP solo ve pedidos liberados por mostrador.** El encolado a Firebird
   ocurre al pasar a `PENDIENTE_PAGO`, no al surtir. Así un ajuste o cancelación
   nunca deja al ERP desincronizado.
2. **`PENDIENTE_PAGO` ⟺ fila en `PedidoPendienteEnvio`.** Un pedido en ese estado
   sin fila es invisible al agente, nunca recibe folio y se queda atascado para
   siempre. La máquina lo **verifica**: `cambiarEstado` exige
   `encolarFirebird: true` (o una fila preexistente) al ir a `PENDIENTE_PAGO`.
3. **El cierre de surtido es UN SOLO PASO.** El bodeguero marca los items y
   aprieta "Terminar surtido"; el sistema decide. La propuesta se crea
   automáticamente en el servidor (`core/propuesta-bodega.util.ts`) **junto con
   su `PedidoMensaje` con adjunto** — sin el mensaje el cliente no tiene dónde
   verla ni responderla.

### A dónde va el pedido al cerrar el surtido (F18)

| Surtido | Cliente | Destino |
|---|---|---|
| completo | — | `REVISADO` (área de entrega) |
| incompleto | **presente** | `REVISADO` — mostrador lo resuelve enfrente |
| incompleto | **ausente** | `ESPERANDO_APROBACION` — el cliente decide en su app |
| cualquiera | domicilio | `PENDIENTE_PAGO` + encolado a Firebird |

**"Cliente presente" reusa el gate de llegada** de la cola de mostrador: KIOSKO
siempre, WEB solo con aviso vigente (`clientePresenteEnTienda` en
`core/destino-post-surtido.util.ts`).

**El bug que esto arregla:** F17 mandaba TODO incompleto a `REVISADO`, pero
`resolverPropuesta` exige `ESPERANDO_APROBACION`. La propuesta nacía
**irrespondible** — ni el cliente, ni el operador, ni el admin podían decidirla
— y el cliente nunca se enteraba de que su pedido estaba incompleto.

**`resolverPropuesta` acepta DOS estados, pero NO para el mismo actor**
(oct 2026):

- `ESPERANDO_APROBACION` → el camino del **cliente** (no está en tienda).
- `REVISADO` y `EN_ATENCION` → solo el **operador de mostrador**, que responde
  en nombre del cliente que tiene enfrente (`opts.enNombreDelCliente`).

Es a propósito: si el pedido ya está en el área de entrega, el cliente está
físicamente en la tienda y decide enfrente. Dejar que los dos respondan produce
una carrera sobre una decisión de dinero donde el segundo se come un
`ConflictException` sin entender por qué.

**La propuesta NO vive en el chat** (oct 2026). Es una sección propia del detalle
del pedido (`components/pedidos/PropuestaDetalle.tsx` en el frontend), porque es
una decisión de dinero, no una conversación. El chat es del **asesor de ventas**
y solo aparece cuando el pedido está en `EN_ASESORIA` o ya hay mensajes: desde
F13 bodega no puede leerlo ni escribirlo.

### Reglas al tocar la máquina

- **Nunca escribas `estado` directo.** Usa `cambiarEstado`. Hay dos excepciones
  deliberadas y comentadas en el código:
  - `BodegaService.tomarGrupo`: toma un lote y necesita que la guarda TOCTOU
    (`asignadoAId: null` + estado en cola) y la escritura sean la misma
    sentencia. `cambiarEstado` resuelve un pedido a la vez.
  - `AdminService.marcarComoPagado`: el agente puede llegar desde **cualquier**
    estado no-terminal (el cobro ya ocurrió en VFP), que `TRANSICIONES` no modela.
- **Ir a `EN_REVISION` exige `opts.asignacion` explícito** (`'caller'` si un
  bodeguero lo toma, `'limpiar'` si vuelve a la cola, `'mantener'`).
- **`estado` NO se persiste en Firebird.** El payload de descarga lo incluye
  (`pedido-descarga.handler.ts`) pero el agente nunca lo lee, así que renombrar
  un valor del enum no toca la sincronización. Verificado con grep.
- **Los efectos externos se disparan DESPUÉS del commit.** `ejecutarCambio`
  devuelve los efectos y el caller los emite cuando la transacción confirmó:
  emitir dentro del callback manda el evento antes del commit, y un rollback
  posterior deja a los clientes con un aviso de algo que nunca pasó.
- **`opts.tx`** permite componer la transición dentro de una transacción del
  caller (lo usa `MessagesService.crearConAdjunto` para que la propuesta y el
  mensaje de chat sean atómicos). **El caller queda OBLIGADO a llamar
  `dispararEfectosDeTransicion` después de su commit**: con `tx`, `cambiarEstado`
  no puede emitir nada, y si el caller no lo hace, el correo al cliente se queda
  en el objeto de retorno. Ese contrato vivía solo en un comentario y
  `crearConAdjunto` no lo cumplía — la contrapropuesta del asesor llegaba al chat
  pero el cliente nunca recibía el correo.
- **`opts.permitirMismoEstado`** deja llamar `cambiarEstado` con el estado que el
  pedido YA tiene, ejecutando los `efectos` sin escribir estado ni historial. Lo
  usa `aprobarPropuestaBodega` cuando el operador resuelve la propuesta de un
  pedido que ya está en `REVISADO`: sin esto lanzaba
  "Transición no permitida: REVISADO → REVISADO" y el operador se quedaba sin
  salida. **No** se agregó `REVISADO` a `TRANSICIONES[REVISADO]` a propósito: eso
  dejaría que cualquier caller transicione al mismo estado.

## Vocabulario: "liberar" significa UNA cosa

**Devolver un pedido a la cola.** Nombraba tres acciones distintas:

| Consola | Acción | Nombre en código |
|---|---|---|
| Bodega | Suelta el pedido para que otro lo tome | `liberarPedido` |
| Cajero | Suelta de tu ventanilla, vuelve a la cola | `liberarPedidoCajero` |
| Mostrador | **NO devuelve: manda a pagar** | `enviarAPagar` |

En mostrador es `enviarAPagar` de punta a punta —servicio, ruta
`POST /pedidos/mostrador/:id/enviar-a-pagar`, DTO `EnviarAPagarDto`— para que el
código y la pantalla digan lo mismo.

## La plancha y el ciclo de ajuste (F17)

**"La plancha" es el estado `REVISADO`.** Es la mesa de mostrador donde el
bodeguero deja la bolsa con el ticket. No es un concepto aparte que haya que
modelar: es el nombre de piso del proceso 3.

El ciclo completo cuando el cliente pide cambios:

```
bodega cierra surtido → REVISADO (la bolsa está en la mesa)
cliente pide cambios  → EN_REVISION (vuelve a bodega, SIN ASIGNAR)
bodeguero lo toma     → ve el CHECKLIST DE RETIRO en el sheet
bodeguero cierra      → REVISADO otra vez
```

Dos piezas que hacen esto posible:

- **`GET /bodega/pedidos/ajustes-plancha`** — los pedidos que volvieron con
  cambios. Alimenta la tarjeta de aviso de `/bodega`. Solo lista los que
  **necesitan** ajuste: un pedido liberado no aparece.
- **El checklist de retiro** (`BodegaSurtidoSheet`) — obligatorio. Hasta que el
  bodeguero marca cada prenda que sacó, "Terminar surtido" queda bloqueado. Al
  confirmar se suma a `ItemPedido.piezasRetiradas` lo que sacó.

**Un ajuste NO genera reposición (oct 2026).** Las prendas que el ajuste quita
las saca el bodeguero de la bolsa y las regresa al anaquel **él mismo, durante el
ajuste** (el checklist). No queda trabajo posterior. La lista de reposición
(`/bodega/reposicion`) es **solo de pedidos cancelados o rechazados**.

F17 hacía lo contrario (`ReposicionService.crearDesdeAjuste`): además de sacarlas,
las listaba en reposición, así que el bodeguero acomodaba una prenda y la lista se
la pedía acomodar otra vez. El método se eliminó; un spec
(`cancelacion-reposicion.spec.ts`) falla si alguien lo recrea.

**Tampoco hay reposición si cancelan el pedido mientras bodega lo tiene (oct 2026).**
Sin surtir o a medias, el bodeguero lo trae en las manos y lo regresa al anaquel él
mismo. La reposición es solo de lo que **ya salió de sus manos** (la bolsa quedó en
el área de entrega). Quien cancela lo decide ANTES de cancelar con
`bolsaEnManosDeBodega` (`core/bolsa-en-bodega.util.ts`) y se lo pasa a
`crearDesdePedido(..., { bolsaEnManosDeBodega })`: la máquina de estados corre los
`efectos` *después* de escribir el estado y limpiar la asignación, así que desde
adentro ya no se puede saber. Hoy solo `ClienteService.cancelarPedido` puede
cancelar en SOLICITADO/EN_REVISION; mostrador y las propuestas cancelan siempre
desde un estado posterior al surtido.

En su lugar el bodeguero **recibe un aviso**: `PedidoStateService` emite
`pedido.cancelado-en-bodega` a `user-{id}` del bodeguero asignado en
`EN_REVISION → CANCELADO` (el frontend lo muestra como toast que se quita solo y
cierra el sheet). Se captura la asignación de la lectura *previa* al update, porque
`'limpiar'` ya la puso en null.

Lo que sí hay que cuidar para que la regla se sostenga:

- **`crearDesdePedido` descuenta `piezasRetiradas`.** Si un pedido ajustado se
  cancela después, solo lista lo que sigue en la bolsa
  (`piezasEnLaBolsa = cantidadSurtida − piezasRetiradas`). Una línea que un
  ajuste quitó y cuyas piezas ya salieron no entra a la lista.
- **`PedidoReposicion.motivo` también es el motivo del correo de cancelación**
  (`NotificationsService` lo lee como `motivoCancelacion`). Por eso la fila se
  crea siempre al cancelar; cuando no hay nada que devolver nace `REPUESTO` con
  `items: []` (no aparece en la lista pendiente ni en el contador).
- **`crearDesdePedido` ya no cae a la cantidad PEDIDA** cuando `cantidadSurtida`
  es 0: un item que nadie surtió no tiene nada que volver al anaquel.
- **Subir la cantidad cuenta contra lo que HAY en la bolsa**, no contra lo que se
  encontró (`calcularAjusteDeCantidad`). Con 5 encontradas y 2 ya sacadas, subir a
  4 manda el item a `PENDIENTE` (bodega re-verifica) y reinicia `piezasRetiradas`
  junto con `cantidadSurtida`: el conteo pertenece al hallazgo al que se refiere.

**Los pedidos ajustados se EXCLUYEN del surtido por lote** (`obtenerLoteSurtirJuntos`):
el lote es picking por zona y no tiene checklist de retiro; meterlos ahí dejaría
salir un pedido con prendas de más en la bolsa.

## La consulta de pedidos (F17)

`GET /pedidos/consulta/buscar?q=` y `GET /pedidos/consulta/:id` — la búsqueda
transversal que comparten las **5 consolas de empleado** (bodega, cajero,
mostrador, ventas, admin).

Busca en **todos los estados** por folio interno, folio de VFP, nombre y correo.
Antes vivía encerrada en `@Controller('pedidos/mostrador')`: los otros roles
filtraban solo la página visible, así que encontrar un pedido entre 300 era
imposible fuera de mostrador.

- **Vive en `MostradorModule`**, no en `PedidosModule`: depende de
  `MostradorQueryService`, y la flecha va `MostradorModule → PedidosModule`.
  Registrarlo allá crearía un ciclo.
- **La regla de tienda es la misma de siempre:** sale SOLO del JWT
  (`user.tiendaId`), nunca de un header. Falla cerrado.
- **El detalle devuelve `responsable`, `puedeOperar` y `mensaje`** — el mismo
  contrato que `resolverEscaneo` (`core/escaneo.util.ts`). El frontend NO debe
  duplicar el mapa de "qué rol opera qué estado": es la regla que más fácil se
  desincroniza al agregar un estado nuevo.
- **`resolverEscaneo` ya NO devuelve `rutaAccion`** (F17). El escáner dejó de
  navegar: abre el detalle en un modal. Devolver una ruta que nadie usa es una
  invitación a que alguien la use y aterrice en un 404 — la ruta de bodega se
  eliminó. Hay un spec que lo fija (`pedido-busqueda.controller.spec.ts`).

## Acceso a pedidos

`core/pedido-access.service.ts` es la fuente única de "¿puede este usuario ver u
operar este pedido?". Reglas:

- **ADMIN** pasa sin validar tienda (es lo que usa el sistema/agente).
- **CLIENTE** solo su propio pedido (`usuarioId`).
- **Empleados** solo pedidos de su tienda, y la tienda sale **solo del JWT**
  (`user.tiendaId`), nunca del header `X-Tienda-Id` — confiar en el header
  permitiría IDOR cross-tienda.

Al añadir un endpoint que opere un pedido, usa `cargarYValidar`. No reimplementes
la regla: el gateway de realtime ya lo hizo una vez y le quedó más permisiva.

## Realtime

- Los servicios emiten a través de `RealtimeService` (`emitToTienda`,
  `emitToPedido`, `emitToUser`), nunca del gateway directo.
- Cada evento se persiste en `realtime_event_outbox` antes de emitirse; el
  worker re-emite los huérfanos tras una caída.
- **Los nombres de evento son strings sueltos** (no hay catálogo central). Si
  añades uno, revisa que el frontend lo escuche: un typo falla en silencio.
- El gateway valida acceso con su propio predicado; `CLIENTE` solo entra a su
  propio room.

## Convenciones

- **DTOs con class-validator** en todo endpoint con body. Sin DTO = sin
  validación.
- **Transacciones**: cualquier operación multi-tabla va en `$transaction`. Un
  `catch` que se traga un error **debe** comprobar `err.code` antes de asumir
  P2002 (el patrón correcto está en `cliente.service.ts`).
- **Excepciones**: `ForbiddenException` para permisos, `ConflictException` para
  carreras, `BadRequestException` para datos inválidos. No usar `BadRequest`
  donde corresponde `Forbidden`.
- **Comentarios**: explicar el *porqué*. Cuando se corrige un bug, dejar dicho
  qué pasaba antes — es lo que evita que vuelva.
- **Los comentarios y mensajes van en español**, igual que el resto del repo.

## Tests

57 suites, 656 tests, todos verdes. Cubren las invariantes del flujo completo
(`flujo-completo.spec.ts`), la máquina de estados
(`pedido-state.service.spec.ts`), el dinero (`invariantes-dinero.spec.ts`) y la
idempotencia de llegada.

**Antes de tocar la máquina de estados o el acceso, corre la suite.** Es la red
que evita que un cambio de transición rompa el encolado al ERP.
