# Playerytees — Backend

NestJS 11 + Prisma 6 + PostgreSQL. API de la tienda de camisetas: catálogo,
pedidos con flujo bodega → mostrador → pago, kiosko de tablet y sincronización
con el ERP (Firebird).

El frontend vive en `../demo-frontend` y tiene su propio `CLAUDE.md`.

## Comandos

```bash
npm run start:dev        # Desarrollo con watch
npm run build            # prisma generate + nest build
npm run test             # Jest (151 suites, 2736 tests)
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

Resolver una propuesta de bodega con el pedido en `EN_ATENCION` lo **deja en
`EN_ATENCION`** (`aprobarPropuestaBodega` no usa el destino `REVISADO` en ese caso):
`EN_ATENCION → REVISADO` es "deshacer la llamada" y el cliente en pleno recuento
perdía su "te toca" en la TV por haber resuelto el faltante. La ruta de ventas
(`aprobarPropuestaVentas`) sigue pasando por `EN_REVISION`, así que ahí la llamada se
pierde de todos modos — es el pendiente del doble `cambiarEstado`.

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
- **`opts.desdeEstados`** (oct 2026): la transición solo vale si el pedido SIGUE en uno de esos estados, comprobado DENTRO de la transacción (409 si no).
  Es para quien decidió con una lectura previa: el cliente que cancela mira `REVISADO` y, en esos segundos, el operador lo llama (`EN_ATENCION`). Como
  `EN_ATENCION → CANCELADO` existe para el operador, sin la guarda la cancelación del cliente entraba a mitad del recuento, justo lo que la regla cerró.
  No sustituye a `TRANSICIONES`.
- **`opts.permitirMismoEstado`** deja llamar `cambiarEstado` con el estado que el
  pedido YA tiene, ejecutando los `efectos` sin escribir estado ni historial. Lo
  usa `aprobarPropuestaBodega` cuando el operador resuelve la propuesta de un
  pedido que ya está en `REVISADO`: sin esto lanzaba
  "Transición no permitida: REVISADO → REVISADO" y el operador se quedaba sin
  salida. **No** se agregó `REVISADO` a `TRANSICIONES[REVISADO]` a propósito: eso
  dejaría que cualquier caller transicione al mismo estado. Dos cosas del camino de
  "mismo estado": **no limpia `llamadoAt`** (`EN_ATENCION → EN_ATENCION` conserva la
  llamada; salir de `EN_ATENCION` sí la limpia), y cuando no hay nada que escribir
  (`data` vacío: sin asignación ni reloj) el guard TOCTOU se comprueba con un
  **conteo**, no con `updateMany` — Prisma no emite un UPDATE con `data: {}` y
  devolvía `count: 0`, un falso "el pedido cambió". Los mocks que devuelven siempre
  `count: 1` lo esconden: lo destapó el spec contra PostgreSQL.

## El folio del Sistema Comercial como ID del pedido (parte B1, oct 2026)

Decisiones del dueño (18-oct): el folio REAL del ERP se toma cuando **bodega cierra el surtido** (opción A); los huecos en la numeración no
importan; el origen WEB se marca con `IDPEDIDO ≥ 1 000 000 000` + `WEB PD-… | ` en `NOTAS` (opciones 1+2; un usuario WEB en Firebird queda
pendiente de que alguien lo dé de alta). Antes el agente mandaba `numeroPedido.slice(0,10)` y TODO pedido web quedaba con el folio "PD-2026-00".

- **Qué es el folio:** consecutivo de 10 dígitos POR TIENDA (`CONSECUTIVOS`, TIPO='PEDIDOS', guarda el ÚLTIMO usado; el mismo número existe en
  cada tienda). Se muestra `SERIE-folio` (`HMO-0000152573`, `Tienda.serie` ← `TIENDAS.SERIE`, que llega con el catálogo); el prefijo es solo visual.
  `Pedido.folioErp` guarda los 10 dígitos, **único por `(tienda, folio)`** (`pedidos_tienda_folio_erp_key`). `numeroPedido` (`PD-…`) sigue siendo la llave
  interna. Funciones puras en `pedidos/core/folio-erp.util.ts` (`formatearFolio`, `interpretarFolio`, `etiquetaDelPedido`, `guardarFolioDelPedido`…).
- **La nube no puede llamar al agente: deja una solicitud y el agente sondea** (`PedidoFolioSolicitud`, mismo patrón claim/lease que
  `PedidoPendienteEnvio`). Un solo punto la crea: `cambiarEstado` (`necesitaFolio`: todo estado posterior al surtido que no sea `SOLICITADO`,
  `EN_REVISION` ni `CANCELADO`), dentro de la transacción de la transición y con `createMany + skipDuplicates`: los tres cierres de bodega la heredan,
  un ajuste que regresa el pedido a bodega no pide otro, y cualquier atajo (admin, agente caído al cerrar) la deja igual. **El cierre NO espera al agente.**
- **Canal:** `GET sync/agent/poll-folios` (reparte con lease de 60 s; omite cancelados y los que ya tienen folio) y `POST sync/agent/folios-ack`
  (`FolioReservaHandler`). El ACK **no exige lease**: tirar un folio ya reservado gastaría otro número sin beneficio, y el índice único impide asignarlo
  dos veces. Si el pedido ya tenía OTRO folio gana ese (el reservado queda como hueco); si OTRO pedido de la misma tienda ya usa ese número
  (`FOLIO_EN_USO`: el consecutivo del ERP retrocedió, ¿respaldo restaurado?) NO se asigna y se loguea en rojo. Un ACK repetido, o de un folio que el pedido
  ya tiene sin solicitud (lo grabó el respaldo), es idempotente. Al asignar emite `pedido.folio-asignado` `{id, folio, serie, etiqueta}` a la tienda y al pedido.
- **El agente** (`agent/src/folio-processor.ts` + `folio.ts`, corre ANTES de `DownProcessor` en cada ciclo): toma el número con
  `UPDATE CONSECUTIVOS SET CONSECUTIVO = CONSECUTIVO + 1 WHERE TIPO='PEDIDOS' AND IDTIENDA=? RETURNING LPAD(CONSECUTIVO,10,'0')` — **la misma sentencia que
  `GRABAR_PEDIDOS` ejecuta con `IDPEDIDO = 0`**, en su propia transacción corta; no se toca ningún objeto de Firebird. Lo guarda en su SQLite
  (`folio_reservado`) ANTES de avisar: si el ACK falla el siguiente ciclo reusa ESE número. **Firebird 3 contesta "update conflicts with concurrent update"
  al que esperaba la fila aunque sea READ COMMITTED + WAIT** (medido: con 4 transacciones simultáneas ~30% fallan), así que la reserva reintenta con jitter
  (`reservarFolioConReintentos`, 6 intentos) y solo un error de otro tipo sube. Con ello 80/80 reservas simultáneas distintas.
- **GRABAR_PEDIDOS** recibe el folio en este orden: el que el agente ya grabó (SQLite: lo que está en el ERP manda) → el de la nube (`folio` del payload de
  `poll-pedidos`) → uno que el agente ya tomó y no llegó a grabar → **el respaldo**: tomar el siguiente en su propia transacción ANTES de la de
  `GRABAR_PEDIDOS` (dentro de ella el candado sobre `CONSECUTIVOS`, que comparte VFP, duraría todo el grabado del pedido y sus líneas). El ACK del pedido guarda
  el folio que quedó en el ERP (`elErpManda`) y cierra la solicitud; un folio que no es de 10 dígitos (el "PD-2026-00" viejo) se ignora. `poll-pedidos` NO
  manda un pedido mientras el agente tiene en sus manos la reserva de su folio (lease vivo): si no, tomaría otro número y el ticket ya impreso quedaría con un folio distinto.
- **Origen WEB:** `IDPEDIDO = 1B + id` (ya existía) y `NOTAS = "WEB PD-2026-000123 | <notas del cliente>"` (`notasParaErp`, ≤2000). **Hallazgo pendiente de
  producción:** el agente baja los pedidos con `pedidos.vendedorId`/`usuarioId` de su config (ejemplo y default `1`/`1` = JUAN PACHECO / FRANCISCO en la BD real:
  personas reales a las que se les atribuye todo lo web). Poner en la config de producción un vendedor/usuario propio de la web cuando existan.
- **Salud (admin y gerente):** cada tienda trae `folios` (`sinAsignar`, `masViejaMin`, `conError`, `conProblema`); ámbar a los 2 min, rojo a los 10, ámbar si el
  agente intentó y falló. El gerente ve cuántos y cuáles, no el texto del error del agente (lista blanca, fijada en `salud-gerente.spec`).
- **Orden de despliegue:** la nube primero (migración `20261026120000_folio_erp`, que además copia los folios reales ya grabados), el agente después. Un agente
  nuevo contra una nube vieja solo ve 404 en `poll-folios` (aviso por tienda, no fatal) y el respaldo sigue funcionando; un agente viejo contra la nube nueva ignora
  los endpoints nuevos pero manda el folio basura de siempre (el ACK lo descarta: no es de 10 dígitos).
- **Probado de punta a punta** (nube de prueba con BD propia + agente REAL + copia de Firebird en Docker; 40 comprobaciones): cierre → folio en segundos, el
  siguiente consecutivo de SU tienda, el pedido NO está en el ERP hasta que mostrador lo manda a pagar y entonces baja con ESE folio sin gastar otro, el respaldo,
  agente caído al cerrar (el cierre responde y el folio llega al volver), y 4 sesiones simulando VFP + 5 reservas del agente a la vez sin repetir ni dejar
  huecos. Specs: `folio-erp.util.spec`, `folios-postgres.spec` (cola, lease, ACK, índice único, serie), `pedido-state.service.spec` (el punto único), `salud-*`,
  y en el agente `folio.spec`, `folio-processor.spec`, `down-processor.spec`.
- **Pendiente (siguientes piezas):** ~~B2~~ y ~~B3~~ hechas (ver más abajo) y B4 (ticket térmico).

## Cómo se llama un pedido en pantalla: `folio` y `turno` (parte B2, oct 2026)

Decisión del dueño (18-oct): el ID que ve la gente es el folio del Sistema Comercial; las TV de pared (públicas, de espacio chico) muestran solo los
**últimos 4 dígitos**. **El servidor decide cómo se llama el pedido; la pantalla no arma la etiqueta ni conoce la serie de cada tienda.**

- **`folio`** (`HMO-0000152573`, o `null` mientras el agente no asigna el folio): lo agrega **`FolioPedidoInterceptor`** (global, `common/folio/`,
  registrado por `SeriesModule`) a todo objeto de TODA respuesta HTTP que traiga `numeroPedido` + `tiendaId` + `folioErp` (`decorarConFolio`, pura). Hay ~40
  sitios que devuelven un pedido; la regla vive en uno. La serie sale de `SeriesDeTiendaService` (8 filas en memoria, TTL 60 s). Nunca tumba una respuesta
  (sin serie, el folio sale solo). **Regla para quien devuelva un pedido a una pantalla que muestre el ID:** incluye `folioErp` y `tiendaId` (en el `select` y en el
  objeto que arma); si no, la pantalla cae a su número de siempre. Hecho en: mis pedidos y ajustes de la plancha de bodega, el escáner, tesorería (lista y detalle),
  reposición, tareas ERP, y las respuestas de llamar (mostrador) y llamar siguiente (caja). Los listados que ya devuelven la fila completa (mostrador, caja, ventas, admin,
  cliente, consulta, `obtenerDetalle`) lo traen solos.
- **`turno`** (`"2573"`, `turnoCorto`, `DIGITOS_DE_TURNO = 4`, la ÚNICA constante): lo llevan **explícitamente** los monitores de mostrador, caja y TV de bodega y los
  eventos que anuncian a un cliente (`pedido.llamado-mostrador`, `pedido.enviado-a-pagar`, `pedido.llamado`, `pedido.cajero-asignado`). **La TV NO recibe el folio
  completo** (esos objetos no llevan `tiendaId` ni `folioErp`, así que el interceptor tampoco los decora; lo fijan los specs de cada monitor y un test HTTP). Se
  conservan los ceros ("0611") para que coincida con el final del folio impreso. Cuatro bastan: el consecutivo avanza de uno en uno por tienda, así que dos pedidos
  que esperan a la vez no coinciden salvo que los separen 10 000. Sin folio (`null`) la TV muestra lo de siempre.
- **Mientras no hay folio el pedido se llama `PD-…`, NUNCA `Pedido #id` (19-oct-2026).** El respaldo de `folioVisible` (frontend) era el `id` de la BD ("Pedido #17310"): un
  número que no está en el correo, el kiosko ni el ticket, así que el cliente veía hasta TRES números para un pedido (`PD-…` en el correo, `#id` en la app, el folio en el ticket).
  Ahora el orden es el mismo en pantalla, correos (`folioVisible`) e instrucciones de pago (`folioDe`): folio del ERP con serie → folio de bandeja **solo si tiene 10 dígitos**
  (`esFolioErp`; el "PD-2026-00" del agente anterior no es un folio) → `numeroPedido`. Antes de que bodega cierre el surtido no hay folio por diseño (decisión A): ahí es `PD-…`.
  Correos corregidos: el de "tu asesor te envió un mensaje" llevaba el `PD-…` en asunto y cuerpo aunque el asesor solo escribe con el folio ya asignado, y el asunto de
  "listo para pagar" llevaba el folio crudo del ACK (`0000152573`) mientras el cuerpo decía `HMO-0000152573`.
- **`pedido.folio-asignado` lo escucha UN solo sitio: `RealtimeProvider`** → `invalidarPedidosPorFolio` (`lib/utils/invalidarPedidos.ts`: refresca por NOMBRE de llave todo lo que empiece con
  "pedido" más cola de mostrador, cola de ventas, reposición, pagos y DTF). Asignar el folio no cambia el estado, así que `pedido.estado` no llega: antes solo la página de bodega lo
  escuchaba (el comentario del handler decía que el cliente y mostrador también y no era cierto) y el folio no se pintaba hasta que algo más refrescara. El backend emite además
  `monitor.invalidado` para que las TV recalculen el turno (cola del `PD-…` → últimos 4 dígitos del folio). Si agregas una query nueva que muestre pedidos, nómbrala `pedido-…`.
- **El puente entre `PD-…` y el folio para el cliente (19-oct-2026).** El cliente conoce su pedido por el `PD-…` de su correo; al llegar el folio el título cambia, y sin una palabra de por medio parece otro
  pedido. Nunca se le dice "Sistema Comercial": el `PD-…` pasa a ser **"Pedido en línea"** y el folio "el número que te pedirán en tienda". Tres piezas:
  (1) detalle del pedido (`NumeroDelPedido`): el `PD-…` siempre a la vista + **`turno`** ("Tu turno en pantalla: 2573"), que manda el SERVIDOR (`turnoParaElCliente`, `folio-erp.util.ts`:
  solo con folio, no domicilio, y en `REVISADO`/`EN_ATENCION`/`PENDIENTE_PAGO`, que son los estados que salen en una TV); (2) aviso único en el pedido (`AvisoFolioNuevo`, se cierra con "Entendido",
  por pedido en `localStorage`; no sale si está entregado o cancelado); (3) el **primer correo que ya lleva el folio** añade "Pedido en línea: PD-…" (`mail/referencia-web.ts`: ningún correo exitoso del
  pedido desde `PedidoFolioSolicitud.asignadoAt`; un folio anterior a esa tabla no tiene fecha y no lleva la línea). Solo el primero: `correos.spec` no deja repetir datos.
- **El seguimiento del pedido que ve el cliente (19-oct-2026).** Auditoría completa en `AUDITORIA-TEXTOS.md`. La barra de pasos pintaba el estado interno casi tal cual y tenía seis defectos
  (el paso actual en verde como los hechos, «Pago» verde sin pagar, pasos de tienda en un pedido a domicilio, un estado con tres nombres, dos pasos de lo que para el cliente es uno, voz mezclada).
  Ahora es un **recorrido de 5 hitos** que agrupa estados (`demo-frontend/src/lib/utils/seguimiento.ts`, puro, 55 pruebas): *Recibido · Preparando · Listo en tienda · Pago · Entrega*, y a domicilio
  *Recibido · Preparando · Pago · Envío · Entrega*. `REVISADO` y `EN_ATENCION` son **un solo hito** (cambia el detalle, no el hito). El hito de pago es UNO que cambia de texto: «Pago» →
  «Pendiente de pago» (actual, no verde) → «Pagado» (verde). Las excepciones (decidir una propuesta, hablar con un asesor) **no son pasos**: son el mismo hito en terracota.
  **Dos tablas de estado, a propósito**: `ESTADO_PEDIDO_LABEL` (frontend, **personal**: nombres del negocio, voz neutra) y `ETIQUETA_ESTADO` / `ESTADO_PEDIDO_LABELS` (**cliente**, kiosko y la
  búsqueda: «Recibido», «En preparación», «Listo en tienda»…). La del servidor (`mail/estado-labels.ts`) y la del frontend son la MISMA tabla y las fijan `estado-labels.spec.ts` y
  `scripts/test-seguimiento.ts` con los mismos valores: si cambias una, cambia la otra. **Vocabulario**: «caja» es el lugar y «ventanilla N» la ventana concreta que anuncia la pantalla;
  «bodega» y «administrador» no se le dicen al cliente.
  **Los correos** rotulan el número «**Pedido:**» mientras es el `PD-…` y «**Folio:**» solo cuando es el folio del Sistema Comercial (`rotuloDelNumero`); «recibido» y «listo para pagar» tienen variante
  de **domicilio**. **`/confirmacion`** recibe `?pedido=PD-…&entrega=domicilio` para mostrar el número y no mandar a la tienda a quien pidió envío.
  **A domicilio SOLO se paga por transferencia (decisión del dueño, 19-oct-2026).** Antes la transferencia estaba bloqueada para DOMICILIO porque un domicilio verificado nunca llegaba a `PAGADO`:
  ninguna consola de caja lo mostraba (hallazgo H1 de `PLAN-PAGOS-TRANSFERENCIA.md` §18). Se cerró el hueco en cuatro puntos: (1) `transferenciaDisponible` ya no excluye DOMICILIO;
  (2) `cliente.service` **fuerza** `metodoPagoPreferido = TRANSFERENCIA` a domicilio y **rechaza el pedido (409) si la tienda no tiene cuenta bancaria** (`hayCuentaParaTienda`, `hooks.ts`): a domicilio NO hay
  caja de respaldo, así que sin cuenta el pedido llegaría a pago sin forma de cobrarse; (3) las instrucciones salen solas al pasar a pago (`emitirTransferenciaAlPasarAPago`, ya existía); (4) la pestaña
  **«Por registrar» de caja incluye los domicilios verificados** (`whereFilaDeCaja(..., { incluirDomicilio })`, solo con `?pago=verificado`) marcados `soloRegistrar: true`: no se llaman ni se atienden, la cajera
  solo los registra en el Sistema Comercial; la fila, «Llamar siguiente» y las TV siguen sin verlos. A domicilio no existe «pagar en tienda»: `puedeCambiarATienda` es false y `cambiarATienda` responde 400; los
  mensajes y correos de transferencia tienen variante de domicilio (`esDomicilio`, `cierreDomicilio`). **Sigue abierto** (plan §18): el costo de envío no está en el total; y un `PENDIENTE_PAGO` de domicilio
  no caduca (lo ve Tesorería en «Esperando» y el gerente puede cancelarlo sin pago).
- **El historial que lee el cliente son SUS hitos (19-oct-2026).** `HistorialPedido` se escribe para el personal y el cliente lo leía tal cual («propuesta #45», «por AGENT_EXTERNAL», «Llamado a mostrador 2 por Ana»,
  «pasa al final de la cola»). Decisión: el cliente ve **solo los cambios de estado reales, cada uno con una frase fija en su voz** («Recibimos tu pedido», «Tu pedido quedó listo en tienda», «Recibimos tu pago»),
  **sin quién lo hizo** y sin los movimientos del piso (tomar, liberar, llamar, deshacer una llamada, descartes). `core/historial-cliente.util.ts` (`historialParaCliente`, usado por `obtenerMiPedido`) lo arma; como
  la frase es fija, **ningún texto libre del personal puede llegar a esa pantalla** (ni un `#id` futuro), y de paso limpia los pedidos ya guardados. Las dos tablas de frases viven ahí (`fraseDelHito`) y el motivo
  de una cancelación va en `avisoDeTienda`, no en el historial. Los textos de origen con jerga (`propuesta.service`, `cliente.service`…) también se reescribieron: el personal y el admin siguen viendo el historial
  completo. Los «Item #id» de `cambios[]` nunca fueron de este problema: solo se cuentan, no se guardan.
- **Buscar:** `pedido-access.buscarPorFolio` (escáner y buscador de las consolas) acepta `HMO-0000152573`, `0000152573` y `152573` (`interpretarFolio`), **acotado a la
  tienda del token** (el mismo número existe en cada tienda); el ADMIN, sin tienda, ve "existe en varias tiendas: escribe la serie" si hay ambigüedad. Un empleado sin tienda
  no busca por folio (falla cerrado). El buscador del mostrador y el de tesorería comparan además los DÍGITOS (≥3: también los últimos que el cliente lee en la TV).
- **Kiosko:** el aviso de llegada resuelve el folio SIEMPRE dentro de la tienda del kiosko, y `folioVisible` de sus pantallas ya es el folio con serie. (B2 solo aceptaba la
  forma completa porque no había segundo factor; **B3 lo cambió**: ahora acepta también `152573` y exige los últimos 4 dígitos del teléfono. Ver «Kioskos» más abajo.)
- **Correos y pagos:** `folioVisible` (correos) y `folioDe` (instrucciones de pago) muestran `SERIE-folio`; el CSV de conciliación lleva el folio de 10 dígitos.
- **Pendiente:** el buscador de DTF/impresión y la salud del sistema siguen mostrando `numeroPedido` (paneles técnicos); los listados de bodega ANTES del surtido
  muestran el `PD-…` porque todavía no existe el folio (es la decisión A: se toma al cerrar el surtido). Specs: `common/folio/*` (decorador, series, interceptor, HTTP),
  `folio-erp.util.spec` (`turnoCorto`), `pedido-access-folio-postgres.spec` (mismo folio en dos tiendas), `kiosko-llegada-folio.spec`, `mail/folio-visible.spec`, y los de
  monitores. Probado en la app completa contra la BD de desarrollo (búsqueda por `999001`/`HMO-…`/`0000…`, detalle y escáner), con el cambio revertido.

## Kioskos: la tablet, su identidad y el aviso de llegada (oct 2026)

Módulo `src/modules/kiosko/`. Una tablet de mostrador es un `Kiosko` que pertenece a **UNA tienda** (`tiendaId` fijo: `actualizar` solo cambia nombre y estado; no hay
forma de mover un kiosko de tienda). Se identifica con `X-Kiosko-Id` + `X-Kiosko-Token` (el token es de 32 bytes, en la BD solo su SHA-256; se compara en tiempo constante
y **antes** de revelar el estado del kiosko para que no sea un oráculo de qué ids existen). Detalle del lado de la tablet: «La tablet de kiosko…» en el `CLAUDE.md` del frontend.

- **Quién manda: el servidor.** `POST kiosko/:id/heartbeat` (público, exige el token) responde además `{ nombre, tiendaId, tiendaNombre }`; la tablet corrige su copia local
  con eso. Un `tiendaId` alterado en el navegador se corrige solo, y crear un pedido ya exigía que el kiosko perteneciera a la tienda del pedido (`cliente.service`).
  **Se eliminó `GET kiosko/tienda/:id/activo`** (público): devolvía la fila COMPLETA del kiosko —con `deviceTokenHash` y `activadoPorId`— a cualquiera, y era lo que el welcome
  usaba para "adoptar" un kiosko (el bug de las dos tablets por tienda).
- **Emparejamiento (`KioskoPairingService`) = la forma de dar de alta y de recuperar una tablet, sin iniciar sesión en ella.** La tablet pide un código de 6 dígitos
  (`POST kiosko/pairing`, público), lo muestra, el admin lo teclea (`GET kiosko/pairing/lookup`) y elige el kiosko (`POST …/aprobar`); la tablet reclama su token
  (`POST …/reclamar`, exige el `deviceSecret` que nunca sale de su memoria: el código solo correlaciona). Cambios de oct 2026:
  - **`aprobar` avisa si la tablet cree ser de OTRA tienda** (`409 TIENDA_DISTINTA`; la pista `tiendaIdHint` sale de su vínculo anterior). Se confirma con
    `confirmarOtraTienda: true`. No bloquea: la pista no es una credencial y una tablet pudo moverse.
  - **El kiosko nace ACTIVO y sin token** (antes nacía INACTIVO con un token que nadie tenía, y por eso una tablet nueva no podía vincularse). `ACTIVO/INACTIVO` es solo
    el interruptor de quien administra; "pendiente de instalar" y "sin tablet" se DEDUCEN (`calcularSaludKiosko`: sin token y sin `primerConexionAt` = nunca tuvo tablet; sin
    token y con `primerConexionAt` = se la quitaron). `reclamar` fija `primerConexionAt` la primera vez y rechaza (403) a un kiosko APAGADO.
- **Aviso de llegada con folio TECLEADO = segundo factor (B3).** `POST kiosko/llegada/consultar|confirmar` (`ResolverLlegadaDto`, antes un tipo inline que no validaba nada):
  - `{ qr }` — el token firmado; la firma es la prueba, no pide nada más. `{ folio, telefono4 }` — `telefono4` (`/^\d{4}$/`) debe ser los últimos 4 dígitos de
    `pedido.clienteTelefono` **o** del teléfono del usuario (`telefonoCoincide`, `kiosko-llegada-intentos.ts`). Un pedido sin ningún teléfono nunca coincide: el cliente pasa a
    mostrador y el operador marca la llegada.
  - Vale `HMO-0000152573`, `0000152573`, `152573` y el `PD-…`; siempre dentro de la tienda del kiosko.
  - **"No existe", "teléfono distinto" y "sin teléfono registrado" dan la MISMA respuesta** (`404 PEDIDO_NO_VERIFICADO`, sin ningún dato del pedido): si no, el mensaje sería un
    oráculo de qué folios existen. Lo fija `kiosko-llegada-folio.spec.ts`.
  - **Tope de fallos** (`LimiteIntentosLlegada`, EN MEMORIA del proceso): 5 por folio+kiosko en 10 min y 30 por kiosko (contiene el barrido de folios con teléfonos al azar);
    pasado el tope, `429 DEMASIADOS_INTENTOS` aunque ya traiga el teléfono correcto. La clave del folio es el folio NORMALIZADO (variar la serie o los ceros no reinicia el
    contador). Un acierto limpia el del folio pero NO el del kiosko. Con varios procesos cada uno cuenta aparte (el límite efectivo se multiplica, no desaparece).
    El tope por kiosko lo propuse yo; el de por folio lo acordó el dueño.
- **Salud y alertas** (`kiosko-salud.ts`, `KioskoAlertasWorker`) sin cambios: la alerta `kiosko.caido` va solo a `admin:all` (el gerente de una tienda no la recibe; ve sus
  kioskos en `/gerencia/salud`).
- **`TRUST_PROXY_HOPS`** (`app.config.ts` + `main.ts`): detrás de nginx en la VPS debe ser **1**. Sin él Express toma como IP del cliente la del proxy: el `ThrottlerGuard`
  (por IP, 100/min global) juntaría a TODOS los clientes del negocio en un solo cubo —las tablets toparían con 429 en hora pico— y la IP que guardan la auditoría y los
  emparejamientos sería siempre la de nginx. En producción con 0 arranca con una advertencia. Más alto que los proxies reales permite falsificar `X-Forwarded-For`.
- **Alta, nombres y quién la hace (decisiones del dueño, 19-oct):**
  - El **GERENTE** da de alta, apaga, desvincula y vincula las tablets de **SU tienda** (el ADMIN, las de todas). Endpoints: `GET/POST kiosko`, `PATCH kiosko/:id`,
    `POST kiosko/:id/desvincular` y `kiosko/pairing/{lookup,:id/aprobar,:id/cancelar}`. El alcance lo impone el SERVICIO (`KioskoService.tiendaDelActor`/`cargarParaActor`,
    `KioskoPairingService.aprobar`), no el controller: la tienda del gerente sale de su token; un kiosko de otra tienda es **404** (no revela que existe); dar de alta en otra
    tienda es 403; una tablet cuya pista dice ser de OTRA tienda no se la lleva un gerente ni confirmando (403: moverla de tienda es del ADMIN). Una tablet NUEVA (sin pista)
    la puede vincular cualquier gerente a un kiosko de su tienda; el riesgo (necesita ver el código de 6 dígitos de la pantalla en los 5 min de vida) se aceptó.
    `roles-contrato.spec.ts` nombra esas rutas en la lista cerrada del GERENTE; `kiosko.service.spec` y `kiosko-pairing.service.spec` fijan el alcance.
  - **El nombre lo pone el sistema** (`Kiosko N`: el siguiente número libre de la tienda; dos altas a la vez chocan en `@@unique([tiendaId, nombre])` y la perdedora reintenta). No se
    edita; lo que se escribe es la **`ubicacion`** (opcional, ≤40, editable: "Entrada"). El mostrador ve "Avisó: Kiosko 2 · Entrada" (`llegadaAnunciadaPor`).
  - **Se eliminó lo que ya no hacía falta:** `POST kiosko/activar`, `POST :id/desactivar` (queda `PATCH estado`), `POST :id/regenerar-token` (ahora `desvincular` borra el token y la
    tablet pide emparejarse sola), la rama de "reactivar por latido" (código muerto), `recienActivado` del latido, `ActivarKioskoDto`, `tokenEsDeTienda`.
    Migración `20261027120000_kiosko_ubicacion` (ubicación; deja los kioskos nunca instalados ACTIVOS y sin token).
  - La alerta `kiosko.caido` ahora llega TAMBIÉN al gerente de cada tienda (`emitToTienda`, una por tienda).
- **Pendiente:** el límite de peticiones por IP (100/min) aprieta a una tienda entera detrás de una misma IP pública (varias tablets + PCs + TV): si en producción aparecen 429,
  cambiar el rastreador del `ThrottlerGuard` a usuario/kiosko cuando hay sesión.

## Pagos por transferencia (oct 2026)

Plan completo y decisiones: `PLAN-PAGOS-TRANSFERENCIA.md`. Lo que hay que saber antes de tocar el cobro:

- **`PAGADO` sigue naciendo SOLO de VFP** (`FINALIZADA` vía agente). La transferencia es un
  subsistema paralelo (`PedidoPagoTransferencia`, módulo `pagos/`) con su propia máquina de estados;
  **no** agrega estados a `EstadoPedido`, ni toca `PedidoPendienteEnvio`, `GRABAR_*`, triggers ni el agente.
- **Tesorería (`TESORERIA`) verifica, no cobra.** Sin tienda (multi-tienda). Aprobar exige el monto EXACTO y
  `confirmoEnBanco`; la tienda registra el cobro en VFP y el agente lo sube (el pago pasa a `APLICADO`).
  **El `CAJERO` es otra cosa**: la ventanilla de UNA tienda.
- Las instrucciones solo se emiten con el pedido en `PENDIENTE_PAGO` (`transferenciaDisponible`, un solo punto de control). Desde el 19-oct-2026 **también a DOMICILIO, donde es el único medio
  de pago** (ver el párrafo de domicilio arriba y §18 del plan).
- **El dinero que llega no se ignora.** Los módulos viejos reaccionan con las funciones puras de
  `pagos/transferencia/hooks.ts` (no inyectan el módulo de pagos: sería un ciclo): cancelar el pedido
  (`resolverPagoAlCancelarse`, dentro de la transacción de `cambiarEstado`) y el cobro de VFP
  (`resolverPagoAlCobrarse`, después del commit y con errores contenidos).
- **Comprobantes: almacenamiento PRIVADO** (`AWS_S3_COMPROBANTES_BUCKET`, o `storage-privado/` en dev),
  nunca el bucket público de imágenes, y solo salen por un endpoint autorizado.
- **El servidor decide qué botones caben; el frontend no mapea estado→acción.** Cada vista lleva sus
  banderas: `acciones.*` (detalle de Tesorería), `puedePedirDatos` (cliente), `puedeEnviarDatos` y
  `pago.puedeCambiarATienda` (tienda). Comparten guardas con la acción real. `puedePedirDatos` /
  `puedeEnviarDatos` incluyen que **haya una cuenta bancaria activa** (`hayCuentaVigente`): antes de que el
  admin dé de alta la primera, todo cliente veía "Por transferencia" y topaba con un 409. Y lo que bloquea
  pedir los datos es un pago VIVO (`hayPagoVivo`), no que haya habido alguno: tras "pagar en tienda" o un
  vencimiento se puede emitir otro (antes `!pago?.estado` lo impedía en mostrador).
- **`transferenciaEnCurso`** (vista del cliente) dice si ya está pagando por transferencia; el detalle de su
  pedido lo usa para no decirle "pasa a caja a pagar" a quien está transfiriendo.
- **Las rutas `@ApiKeyAuth()` también aceptan a un ADMIN con JWT** (`POST admin/pedidos/:id/marcar-pagado` desde el
  panel). `JwtAuthGuard` solo las exime cuando la petición trae `X-Agent-Key`; sin ella autentica el JWT para que
  `ApiKeyGuard` vea `request.user`. Antes las eximía todas y el botón "Marcar como pagado (manual)" daba 401 siempre
  (roto desde `586a78cc`). Lo fija `jwt-auth.guard.spec.ts`. Con una transferencia EN CURSO el cobro manual pide
  `forzar: true` + motivo en `referencia`; el panel lo pide con una confirmación (`MarcarPagadoManualCard`).
- **El método de pago se ELIGE al hacer el pedido y el cliente ya no lo cambia (oct 2026).** `Pedido.metodoPagoPreferido`
  (web Y kiosko; domicilio no). Si es `TRANSFERENCIA`, el pago se crea SOLO al pasar a `PENDIENTE_PAGO`
  (`emitirTransferenciaAlPasarAPago`, dentro de la transacción de `cambiarEstado`, como la cancelación): el cliente ve sus
  datos sin pedirlos y caja/Tesorería lo ven desde ese instante. **El correo con los datos NO sale al crear el pago sino al
  llegar el ACK del agente** (ya hay folio de VFP): `NotificationsService.enviarListoParaPagar` manda
  `TRANSFERENCIA_INSTRUCCIONES` (banco, CLABE, monto exacto, referencia) EN LUGAR del de "listo para pagar" con el QR de caja
  —un solo correo—, solo si el pago sigue `PENDIENTE` (con comprobante en revisión o verificada no manda nada), y si no hay
  pago vivo (caja lo pasó a tienda, o no había cuenta) manda el de caja con su QR. Es a propósito después del folio: mandar a
  transferir antes de que el pedido exista en VFP deja dinero que la tienda no tiene dónde registrar. Consecuencia en dev:
  **sin agente de VFP conectado no sale ningún correo** (los datos sí están en el pedido). Nunca bloquea mandar a pagar (sin
  cuenta bancaria, domicilio o pago ya vivo → no hace nada). Cambiar el método a
  petición del cliente es de **CAJA** (`PagoTiendaController` es solo `CAJERO`, ADMIN pasa); **MOSTRADOR solo manda a pagar**.
  Se quitaron del cliente `POST …/pago/transferencia` y `…/cambiar-a-tienda`; sigue viendo y subiendo comprobantes.
- **Caja sube el comprobante EN NOMBRE del cliente (16-oct)**: `POST pedidos/:id/pago-transferencia/comprobantes` (`PagoTiendaController`,
  solo `CAJERO`, `@RequiereEstacion()`; MOSTRADOR no — decisión del dueño). Es el mismo `subirComprobante` del cliente: mismas
  validaciones (firma del archivo, 8 MB, idempotente por sha256, 3 pendientes / 10 por pago) y misma transición
  `PENDIENTE → EN_REVISION`. **NO verifica**: la cajera no se aprueba su propio cobro, Tesorería sigue confirmando contra el banco.
  Queda anotado quién (`subidoPorId`, y el evento `COMPROBANTE_SUBIDO` con `actorRol: CAJERO` y `porTienda: true`); caja y Tesorería
  ven el comprobante como "lo subió caja (Ana)". La respuesta es la vista de quien sube. Por qué: llegan clientes sin internet, que no
  saben subirlo o a quienes manda su patrón. Mientras Tesorería valida, la cajera tiene "esperar ahí" o "regresar a la cola".
- **`resumenParaTienda` lleva `pago.puedeSubirComprobante`, `pago.comprobantes[]` y `pago.datosParaTransferir`** (banco, titular,
  CLABE, monto exacto, referencia: las mismas instrucciones del correo y de la pantalla del cliente, vía `instruccionesDeUnPago`),
  solo mientras la transferencia esté abierta. Es para que la cajera los **muestre o dicte** al mandadero que no tiene el correo del
  patrón. Esa vista es autenticada y solo de `CAJERO`: **nunca** va a una TV.
- **Correos: un dato, un lugar.** El folio solo en el resumen ("Folio"), el título dice el evento y el saludo no lo repite, no
  hay fila "Estado", el enlace al pedido es solo el botón, y los correos de transferencia no llevan la lista de productos. Todo
  texto debe ser cierto con el flujo actual (no mencionar un chat fuera de EN_ASESORIA, ni "sustituciones", ni "saldo a
  favor"). `src/modules/mail/correos.spec.ts` renderiza los 20 casos y falla si algo se repite.
- **El vencimiento es MANUAL y SIN PLAZO (decisión del dueño, 17-oct-2026): no existe ninguna fecha de vigencia.**
  Antes había `venceAt` (48 h, `PAGO_TRANSFERENCIA_VENCE_HORAS`) que salía en pantallas y correos como plazo, aunque
  nada cerraba solo; la columna, la variable, la nota "válidas hasta…", los avisos "ya vencieron", la pestaña "Vencidas",
  el botón masivo `cerrar-vencidas` y el correo `TRANSFERENCIA_POR_VENCER` (nadie lo despachaba) se eliminaron
  (migración `20261022120000_transferencia_sin_plazo`, DESTRUCTIVA: los pagos de prueba pierden su fecha). Lo que hay:
  - **`espera`** (`esperaDelPago`, `reglas.ts`): `{ desde, dias, texto: "Lleva 3 días esperando" }`, solo con el pago
    `PENDIENTE`, contado desde `createdAt` (cuando se emitieron las instrucciones). Lo arma el servidor y lo ven Tesorería
    (fila y detalle), caja y mostrador (`resumirPagoParaCaja`, `resumenParaTienda`). El cliente NO lo ve: no es para él.
  - **"Esperando"** de Tesorería = TODAS las `PENDIENTE` de cualquier edad, la más vieja primero.
  - **Marcar vencida** (`POST tesoreria/pagos/:id/vencer`, body `{ motivo }` ≥3 caracteres, `VencerPagoDto`): siempre
    disponible en una `PENDIENTE` sin comprobante (`acciones.puedeVencer`); con un comprobante en revisión puede haber
    dinero en camino y NO se cierra (409). El MOTIVO es obligatorio porque ya no hay un plazo que justifique el cierre; queda
    en el evento `VENCIDO` (`detalle.motivo`, `diasEsperando`) y la bitácora de la pantalla lo muestra.
    Importa porque mientras siga `PENDIENTE` caja ve "no cobres". La lógica vive en `cerrarPorVencimiento`, sin nada de HTTP.
  - **"Cancelar por falta de pago" NO está aquí** (se movió a la pieza de destrabar pedidos). OJO, corrección del 17-oct: el CLIENTE sí
    puede cancelar un pedido en `PENDIENTE_PAGO` (`ClienteService.cancelarPedido`), y el poll del agente ya ignora los pedidos
    cancelados (`pedido-descarga.handler.ts`: `estado: { not: 'CANCELADO' }`) y el ACK maneja el pedido cancelado en vuelo; así que NO
    existe el riesgo de "crear en el ERP un pedido ya cancelado". Lo que SÍ falta: (1) un pedido que YA está en el Sistema Comercial y
    se cancela en la nube sigue vivo allá y nadie se entera (no hay tarea ni aviso), (2) el ACK de un pedido cancelado en vuelo deja un
    folio huérfano en el ERP sin decírselo a nadie, y (3) la fila de la bandeja de un pedido cancelado antes de que el agente la
    recogiera se queda `PENDIENTE` y la salud la cuenta como atorada.
  - Los avisos/mensajes dicen "marcaron vencidas" / "ya no están activas", nunca "vencieron" (nada vence solo).
- **Abono tardío**: un pago `VENCIDO` se puede verificar (`acciones.aprobarRequiereNota`) con una nota de qué pasó;
  no si el cliente ya pidió otras instrucciones (solo cabe un pago vivo): el abono se resuelve en ese.
- **"Verificada y sin registrar en VFP" se ve, no se avisa**: `atrasado` (horas en `PAGOS_ALERTA_SIN_REGISTRAR_HORAS`,
  default 4) se calcula al leer; la cola de Tesorería lo marca y ordena lo más viejo primero; caja ve "verificada
  hace N h". Sin proceso ni push.
- **Conciliación** (`GET tesoreria/pagos/conciliacion` y `/csv`): pagos por el día del NEGOCIO en que se verificaron
  (rango en `PAGOS_ZONA_HORARIA`, no UTC), con folio VFP y totales; es el cruce humano contra el corte de caja
  porque la nube no sabe cómo registró VFP el cobro. El CSV va con BOM, y neutraliza fórmulas (`= + - @`).
  `Content-Disposition` está en `exposedHeaders` de CORS: sin eso el navegador pierde el nombre del archivo.
- **`PAGOS_ZONA_HORARIA`** (default `America/Mexico_City`) fija el "día del negocio" de la conciliación y su CSV. Mexicali
  y otras plazas de la frontera no coinciden con la hora del centro: configúrala por env si aplica. (Ya no escribe
  ninguna fecha de vigencia: no existe.)
- Dev sin S3: los comprobantes van a `storage-privado/` (en `.gitignore`: son datos bancarios de clientes).
- Al agregar un rol: `src/common/roles-contrato.spec.ts` falla hasta que se nombre en cada lista.

## La fila de caja y las TV de pared (oct 2026)

`core/cola-caja.util.ts` es la **única definición** de "quién sigue en caja": la usan la consola
(`obtenerColaVentanilla`), "Llamar siguiente" y la TV de ventanillas. Antes cada una armaba lo suyo y
divergían (la TV listaba a quien esperaba una transferencia, que `llamarSiguiente` saltaba).
Decisiones del dueño del 16-oct (que **revierten** lo que decía esta sección antes): las transferencias sin validar
**se llaman en su turno** y **se ven de inmediato en la TV**.

- **El turno es de cuándo llegó a CAJA**, no de cuándo se hizo el pedido: `Pedido.colaCajaDesdeAt` (migración
  `20261019120000_cola_caja_desde_at`) se escribe en `cambiarEstado` al entrar a `PENDIENTE_PAGO` y se limpia al salir.
  Antes se ordenaba por `fechaPedido`: un web hecho a las 9:00 y mandado a pagar a las 11:10 pasaba delante del kiosko que
  llegó a caja a las 11:05.
- **Orden: SOLO la llegada a caja** (`colaCajaDesdeAt`; `id` desempata) — **nadie pasa adelante**: ni la transferencia
  verificada (antes se atendía primero, "registrarla en VFP toma segundos") ni se manda al final la que espera validación (antes
  "Llamar siguiente" la saltaba). Decisión del dueño, 16-oct: "orden de llegada, y la misma importancia para todos". Razón: hay
  clientes que llegan a la ventanilla sin haber pagado —un patrón o un familiar les va a transferir, no tienen internet o no saben
  subir el comprobante— y justo ahí necesitan que caja les ayude. Ya no existe `tienePrioridadDeCaja`.
- **La TV SÍ muestra a los de transferencia, de inmediato** (sin `WHERE_COBRABLE`; domicilio nunca), y **sin ningún distintivo**:
  es pública y no revela cómo paga cada quien. La consola los marca "no cobrar" con el texto de `mensajeParaCaja`.
- **"Regresar a la cola hasta que se valide"** (`POST cajero/pedidos/:id/esperar-validacion`, `CajeroService.esperarValidacion`).
  El cliente con transferencia sin validar llegó a la ventanilla: la cajera **o lo espera ahí** (no hace nada) **o lo regresa**:
  se suelta conservando su lugar (`colaCajaDesdeAt` NO se toca; a diferencia de "No se presentó") y se escribe
  `Pedido.esperaValidacionDesdeAt` (migración `20261020120000_espera_validacion_caja`). `WHERE_LLAMABLE` hace que "Llamar
  siguiente" salte SOLO lo que tiene la marca **y** una transferencia aún sin verificar: al verificarse Tesorería deja de contar
  sola (no hay quien deba limpiarla) y vuelve a ser llamable EN SU LUGAR de siempre (conservó `colaCajaDesdeAt`: queda delante de quien llegó después, sin regla de prioridad aparte). La marca se limpia
  al tomar el pedido una cajera, en "No se presentó" y al salir de `PENDIENTE_PAGO` (`cambiarEstado`). Solo cabe con una
  transferencia sin validar (400 si no) y solo para la cajera que lo tiene (403) o el admin; el servidor lo dice con
  `puedeEsperarValidacion` en "mis pedidos" y `esperandoValidacion` en la cola; `meta.llamables` habilita "Llamar siguiente".
  Sin tope de tiempo ni cronómetro, y el cliente no ve aviso en su app (decisiones del dueño: la cajera se lo dice de palabra).
  En la TV el folio sigue en su lugar, sin distintivo.
- **Devolver a la cola conserva el lugar; "No se presentó" manda al final.** `liberarPedidoCajero` no toca
  `colaCajaDesdeAt`; `CajeroService.noSePresento` (`POST cajero/pedidos/:id/no-se-presento`) lo reinicia a `now()`. Sin esto el
  cliente ausente volvía a ser el primero y "Llamar siguiente" lo llamaba otra vez, y otra. Vale igual para una transferencia
  ya verificada: pasa al final como cualquiera. (Mostrador ya hacía esto con `presenteDesdeAt`: `PresenciaService.noSePresento`.)
- **Soltar la ventanilla** (`VentanillasService.liberar`, que el frontend llama al cerrar sesión un `CAJERO`) devuelve a la
  fila los pedidos que el cajero tenía asignados, conservando su lugar. Antes quedaban asignados a un cajero sin ventanilla:
  invisibles en la TV (solo lista a un cajero activo) Y en la fila (solo lista los sin asignar).
- **`enviarAPagar` responde `destinoPago` (`CAJA` | `TRANSFERENCIA`) SOLO en la respuesta HTTP** (el toast de la operadora es
  privado). El evento `pedido.enviado-a-pagar` que va a la sala de la tienda —o sea, a la TV pública— lleva únicamente
  `{id, numeroPedido}` y el aviso es el mismo para todos: **"A pagar → pasa a CAJA"**. Una versión intermedia mandaba
  `destinoPago` para pintar "Transfiere"; el dueño lo quitó: lo que viaja a la TV se ve en la pared. El aviso de antes se
  armaba buscando el folio en el snapshot nuevo, donde ya no estaba: **nunca se veía**.
- **Las TV públicas reciben SOLO folio + números** (16-oct, §9.4 del plan). `monitor-mostrador.dto.ts` y
  `CajeroMonitorService` ya no mandan nombre del cliente, correo, total, canal, fechas, minutos en cola, `cajeroId`, ni las
  listas de "sin recoger" y "listos para entregar" (la TV nunca las pintó, pero cualquiera leía la pestaña de red). Lo único con
  nombre es el operador/cajero de cada puesto (personal, no cliente), porque la tarjeta lo muestra. La TV de bodega es operativa
  y conserva lo que usa. Los specs de cada monitor fijan las llaves exactas del payload.
- **TV de mostrador por PUESTOS** (como la de caja): `mostradores[]` (`{mostradorId, numero, operadorNombre, abierto,
  atendiendo[]}`), `sinMostrador[]` (llamados sin puesto válido: no desaparecen) y `cola[]`. `abierto` = operador con señales de
  vida en los últimos 15 min (`core/estacion.util.ts`), no "se logueó en las últimas 12 h"; falso → la TV pinta "Cerrado".
  `atendiendo[]` plano se conserva por una TV con la versión anterior de la pantalla.
- **TV de bodega:** `MonitorPedidoDto.clienteEnTienda` / `presenteDesdeAt` (misma regla `clientePresenteEnTienda` que la cola
  de bodega y mostrador). Un web con aviso de llegada va primero en su columna (entre presentes, el que llegó antes), su
  cronómetro cuenta desde que LLEGÓ y usa los umbrales de tienda. `contadores.clientesEnTienda` cuenta también los que ya
  están en manos de un bodeguero. El aviso de llegada (`pedido.llegada-anunciada`) **no** emite `monitor.invalidado` por la
  vía de la app/QR del kiosko: la TV debe escucharlo (y con el WS conectado el polling se pausa).

## Quién recoge el pedido: `recogioNombre` (oct 2026)

A la tienda llegan mandaderos y familiares, no solo el titular, y `entregar` no dejaba constancia de quién se llevó la mercancía.
`POST pedidos/mostrador/:id/entregar` acepta `recogioNombre` (opcional, `EntregarPedidoDto`; migración
`20261020130000_pedido_recogio_nombre`). **Solo se guarda si NO es el titular** (comparado sin acentos ni mayúsculas con
`clienteNombre`; `null` = lo recogió el titular o el pedido es anterior): el del titular ya está en `clienteNombre`. Mínimo 3 letras (400).
Es constancia, no un permiso: no se pide identificación. Se escribe en la MISMA transacción que la transición (`efectos` de
`cambiarEstado`): la notificación relee el pedido después del commit y lo encuentra ya guardado. Dónde se ve: **historial**
("Entregado en mostrador por Diego — lo recogió Juan Pérez (no es el titular)"), **`Pedido.recogioNombre`** (fila "Recogió" en
`DatosClienteCard`, o sea detalle de admin, bodega, cliente y el modal del buscador) y el **correo "entregado"** (`PedidoEntregado`:
"Lo recogió: … Si no reconoces a esa persona, avísanos"), solo cuando no fue el titular. No se sincroniza a Firebird.

## Estaciones de trabajo: ventanilla y mostrador (oct 2026)

Plan completo y decisiones: `PLAN-ESTACIONES-CAJA-MOSTRADOR.md` (§9 = ajustes del dueño, mandan sobre el resto).

**Principio: la estación autoriza a ACTUAR; sin estación se puede MIRAR.** La regla vive en el servidor
(`common/guards/estacion.guard.ts`): `@RequiereEstacion()` en toda ruta que cambia algo de caja, mostrador y forma de pago
(`tomar`, `liberar`, `llamar-siguiente`, `no-se-presento`, `esperar-validacion`, `enviar-a-pagar`, `ajustar`, `cancelar`,
`entregar`, `traer-a-entrega`, `marcar-llegada`, `cancelar-vencidos`, `enviar-datos`, `cambiar-a-tienda`…). Lecturas (colas,
detalle, búsqueda) siguen abiertas. **ADMIN queda exento.** Un cliente de la API o una pantalla desfasada no puede saltársela:
antes solo `llamar-siguiente` exigía ventanilla, así que un cajero que liberaba la suya seguía atendiendo y el pedido quedaba
asignado a un cajero sin ventanilla (invisible en la TV y en la fila).

- **Nadie nace con estación** (el seed ya no pre-asigna) y **no hay modo genérico**: una tienda sin mostradores ya no llama "sin
  número"; `resolverParaLlamar` pide al admin crearlos. El seed crea 3 mostradores en Mexicali y 2 en Monterrey.
- **Ocupada por otra persona → 409** (`VENTANILLA_OCUPADA` / `MOSTRADOR_OCUPADO`, con quién) salvo `forzar: true`
  ("tomar el control", con confirmación en la pantalla y aunque el ocupante esté activo: decisión del dueño). La guarda es
  atómica: dos que eligen a la vez, uno gana y el otro 409. Al perderla, el ocupante recibe `ventanilla.perdida` /
  `mostrador.perdido` (a su `user-{id}`) y su consola pasa a observador.
- **Soltar una estación devuelve a su gente:** ventanilla → los pedidos asignados vuelven a la fila conservando su lugar;
  mostrador → los `EN_ATENCION` llamados desde él vuelven a `REVISADO` por la máquina de estados (`regresarLlamados`), sin
  perder `presenteDesdeAt`. `GET mostrador/puesto` trae `clientesEnCurso` para que la confirmación diga cuántos.
- **Barrido de inactividad** (`EstacionesWorker`, cada 5 min): suelta lo que lleva +15 min sin latido (`lastLogin` /
  `ultimoHeartbeat`) y regresa a la gente. Va por `liberar`, que es idempotente.
- **Observador no es un estado del servidor:** es no tener estación + la preferencia de la pestaña (frontend).
- Al agregar una ruta que cambie un pedido desde caja o mostrador, ponle `@RequiereEstacion()`; si no, un observador la usa.

## Presencia de bodega: la TV sabe quién está (oct 2026)

`modules/estaciones/bodega-presencia.service.ts` (`BodegaPresenciaService`, en su propio módulo sin imports porque lo usan
`AuthModule` y `EstacionesModule`). La TV de bodega daba por "activo" a quien hubiera entrado en las **últimas 12 horas**: cerrar
sesión no lo quitaba y entrar no avisaba a la pantalla. Ahora es un **estado** que cambia con la persona:

- **Entrar** (`AuthService.login`, también el login por QR de kiosko) pone `ultimoHeartbeat = now` y emite `bodeguero.entro`.
- **Salir** (`AuthService.logout`, DESPUÉS de revocar los refresh tokens) deja `ultimoHeartbeat = null`, **regresa a la cola sus
  pedidos `EN_REVISION`** (sin asignar, conservando su lugar, con el reloj de atención pausado y una línea de historial) y emite
  `pedido.liberado` por cada uno + `bodeguero.salio`. Mismo criterio que soltar una ventanilla o un mostrador: sus pedidos no pueden
  quedar asignados a alguien que ya no está. Nunca impide cerrar sesión (si falla se loguea y el barrido lo saca después).
- **El latido** (`auth/heartbeat`, cada 5 min) lo mantiene en línea. Si estaba fuera (el barrido lo sacó) y tiene **sesión abierta**
  lo vuelve a poner y avisa; **sin sesión abierta no lo revive**: un latido rezagado que llega después de cerrar sesión no debe
  devolver a la TV a quien ya se fue (se mira `RefreshToken` sin revocar).
- **Barrido** (`EstacionesWorker`, cada 5 min, `salirInactivos`): quien lleva más de 15 min sin latido sale igual que si cerrara
  sesión. Es la red de seguridad de la pestaña cerrada o la tablet sin red.
- **En línea = `ultimoHeartbeat` dentro de `INACTIVIDAD_ESTACION_MS`** (15 min), más quien **aún trae pedidos** aunque su latido
  haya caducado: el barrido corre cada 5 min y, sin esa cláusula, sus pedidos desaparecían de la TV (viven en su ficha, no en
  las columnas) durante ese rato. `lastLogin` ya NO cuenta para la TV: es el historial del último acceso, no de la presencia.
  `lastLogin`/`ultimaActividad` se quitaron del DTO del monitor (nadie los leía).
- Lo fija `estaciones/bodega-presencia-postgres.spec.ts` (contra la BD: las guardas viven en el `where` de un `updateMany`).

## `puedeAvisarLlegada` y el folio en el pedido del cliente (oct 2026)

- **`GET cliente/pedidos/:id` trae `puedeAvisarLlegada`**: lo calcula `avisoDeLlegadaSirve` (`core/llegada-aviso.util.ts`). El
  servidor ACEPTA el aviso en cualquier estado no terminal, pero de `PENDIENTE_PAGO` en adelante (y en `EN_ATENCION`) "solo deja
  constancia": el cliente ya pasó por mostrador. La pantalla seguía ofreciendo "Ya llegué" con el pedido por pagar porque
  deducía los estados por su cuenta. El servidor decide qué se ofrece; la pantalla no mapea estado→botón.
- **`obtenerMiPedido` incluye `pendienteEnvio: { select: { externalFolio } }`.** La pantalla pintaba el folio y el QR desde
  siempre, pero el `include` nunca lo pedía y no se veían **jamás**. Solo el folio: el resto de la fila es del agente.

## Vocabulario: el cliente y la tienda dicen "Sistema Comercial", no "VFP"

Todo texto que se LEE (mensajes de `mensajeParaCaja`, errores de caja, encabezados del CSV de conciliación) dice **Sistema
Comercial**. "VFP" queda en el código (`REGISTRAR_EN_VFP`, `COBRO_EN_VFP`, `folioVfp`, comentarios) porque son valores guardados
y contrato con el frontend: no se renombran. Los mensajes del agente de sync (`pedido-pago.handler.ts`) son diagnóstico técnico y
tampoco se tocaron.

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

**Cuándo hay reposición (oct 2026): una regla — la lista es de la mercancía que ya
salió de la bolsa y NADIE va a regresar al anaquel durante otra tarea.** Depende de
quién saca las prendas:

- **Ajuste de VENTAS: NO genera reposición.** El pedido vuelve a bodega y el
  bodeguero saca las prendas de la bolsa y las regresa al anaquel **él mismo,
  durante el ajuste** (el checklist). No queda trabajo posterior.
- **Ajuste de MOSTRADOR que QUITA o BAJA piezas: SÍ genera reposición** (decisión 4
  del dueño). Las saca el operador enfrente del cliente y nadie más las regresa; ver
  la sección de abajo.
- **Pedido CANCELADO o rechazado:** lo que siga en la bolsa.

F17 listaba en reposición TAMBIÉN las prendas que el bodeguero ya había sacado
(`ReposicionService.crearDesdeAjuste`): acomodaba una prenda y la lista se la pedía
otra vez. El método se eliminó; un spec (`cancelacion-reposicion.spec.ts`) falla si
alguien lo recrea. El camino de mostrador usa **otro método con otro nombre**
(`registrarQuitadasEnMostrador`) y no repite ese bug porque suma `piezasRetiradas`
en el momento de quitar: el checklist de bodega nunca las ve como pendientes.

### El ajuste de mostrador se resuelve en el lugar (oct 2026)

`MostradorService.ajustar` decide el destino **antes** de la transacción con
`ajusteNecesitaBodega` (`core/ajuste-cantidad.util.ts`), que usa la misma
`calcularAjusteDeCantidad` que decide qué se escribe — la decisión de "va a bodega"
y el dato de la línea no pueden contradecirse:

| El cliente… | Destino |
|---|---|
| solo **quita o baja** piezas | **Se queda** (`REVISADO` / `EN_ATENCION`; desde `ESPERANDO_APROBACION` pasa a `REVISADO`). Lo quitado → reposición. |
| **agrega** un producto o **sube** por encima de lo que hay en la bolsa | `EN_REVISION` sin asignar (bodega surte lo nuevo). |
| sin items (solo la nota) o todos `completo` | `EN_REVISION` (comportamiento de siempre). |

- **Lo que se quita, se saca en el momento.** `aplicarAjuste` suma
  `piezasRetiradas` en el mismo update que cancela/baja la línea y devuelve las
  `quitadas`; `registrarQuitadasEnMostrador` las lista, en la misma transacción.
  También vale en una tanda **mixta** (quita una línea y sube otra): lo quitado va a
  reposición y el pedido viaja a bodega igual — la regla del piso es "lo que quitas,
  lo sacas tú". El dueño no especificó este caso; si prefiere que la tanda mixta use
  el checklist de bodega, el cambio es no sumar `piezasRetiradas` ni listar cuando
  `vaABodega`.
- **`pedidoId` es único en `PedidoReposicion`**, así que convive con la fila de una
  cancelación posterior: las entradas suman **por línea**; una fila `REPUESTO` se
  reabre con **solo lo nuevo** (lo anterior ya volvió al anaquel); y
  `crearDesdePedido` **fusiona** la bolsa restante en vez de salir si la fila existe
  (antes `if (existente) return` dejaba esas piezas sin volver nunca). La marca
  `deCancelacion` en las entradas hace idempotente esa fusión, y `motivo` solo lo
  escribe la cancelación (es el texto del correo): la fila de un ajuste nace con
  `motivo: null`.
- **Sin transición no hay historial ni `pedido.estado`.** El servicio escribe su
  propia fila de historial y emite `reposicion.creada` (después del commit) para que
  la lista y el badge de bodega se refresquen; el frontend lo escucha en
  `bodega/page.tsx` y `bodega/reposicion/page.tsx`. La respuesta trae `vaABodega` y
  `piezasAReposicion` para que el toast diga lo que pasó.
- **`observacion` de `cambiarEstado` va con getter.** Se copiaba por valor antes de
  que los `efectos` calcularan el conteo real de cambios, así que F21 decía
  registrarlo y no lo hacía.

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
  ajuste quitó y cuyas piezas ya salieron no entra a la lista. Con el ajuste de
  mostrador esto es lo que impide listar dos veces lo que el operador ya sacó
  (que quedó en la fila al quitarlo).
- **`PedidoReposicion.motivo` también es el motivo del correo de cancelación**
  (`NotificationsService` lo lee como `motivoCancelacion`). Por eso la fila se
  crea siempre al cancelar; cuando no hay nada que devolver nace `REPUESTO` con
  `items: []` (no aparece en la lista pendiente ni en el contador).
- **`crearDesdePedido` ya no cae a la cantidad PEDIDA** cuando `cantidadSurtida`
  es 0: un item que nadie surtió no tiene nada que volver al anaquel.
- **Subir la cantidad cuenta contra lo que HAY en la bolsa**, no contra lo que se
  encontró (`calcularAjusteDeCantidad`). Con 5 encontradas y 2 ya sacadas, subir a
  4 manda el item a `PENDIENTE` y **rebasa** la línea a lo que hay en la bolsa
  (ver "Subir la cantidad: bodega verifica solo las de más").

**Los pedidos ajustados se EXCLUYEN del surtido por lote** (`obtenerLoteSurtirJuntos`):
el lote es picking por zona y no tiene checklist de retiro; meterlos ahí dejaría
salir un pedido con prendas de más en la bolsa.

## La calculadora de ajuste y lo que lee el cliente (oct 2026)

La propuesta es un snapshot JSON (`PedidoPropuesta.items`) y el cliente decide
viéndolo. **El navegador ya no arma ese snapshot ni calcula un precio.**

- **`core/calculadora-ajuste.util.ts` (`calcularAjuste`) es la ÚNICA función que
  decide qué dice una propuesta y cuánto cuesta.** La usan bodega
  (`construirPropuestaDeBodega` es un envoltorio: la calculadora sin
  intenciones), el editor (vista previa) y el envío de la contrapropuesta. Antes
  cada camino tenía su copia y divergieron: filas que no sumaban su total,
  productos agregados sin promo ($854 mostrado vs $836 cobrado), un "pedido
  original" falso.
- **El cliente de la API manda su INTENCIÓN, no líneas**: `{ accion: 'CANTIDAD',
  itemId, cantidad } | { accion: 'QUITAR', itemId } | { accion: 'AGREGAR',
  precioCOId, cantidad }` (`IntencionAjusteDto`). Un precio, subtotal o total en
  el body da 400 (`forbidNonWhitelisted`, fijado en `propuesta-dto.spec.ts` y por
  HTTP en `propuesta.controller.spec.ts`). `POST mensajes/con-adjunto` recibe
  `ajuste`, no `propuestaItems`.
- **`AjusteService`** carga los items (con imagen), resuelve los AGREGAR contra el
  catálogo **con la lista del CLIENTE que hizo el pedido** y falla al ENVIAR si la
  variante es ajena o no existe (antes fallaba al aprobar). `vistaPrevia` expone
  `POST /pedidos/:id/ajuste/vista-previa` (VENTAS, MOSTRADOR, ADMIN; límite propio
  de 180/min porque el límite global de 100/min por IP se comparte con la tienda).
- **`enviarPropuesta` recibe un `ResultadoAjuste`**, no un DTO: ningún controller
  puede pasarle líneas de un cliente. Rechaza una propuesta sin cambios. Solo
  VENTAS/ADMIN; la de bodega la arma el sistema al cerrar el surtido.
- **El aplicador no cambió** (`aplicarPropuestaDeVentas`, `aplicarAjuste` de
  mostrador). `calculadora-ajuste.spec.ts` corre la calculadora **contra el
  aplicador real** sobre una BD en memoria: el total propuesto es el que se cobra.
  Si cambias una regla de dinero, ese spec es el que tiene que seguir verde.
- **`subtotalOriginal`** (lo que la línea valía *antes*) lo sella la calculadora:
  el `subtotal` de la línea es del *destino* (sin existencia trae `0`).
  `piezasPorSurtir` y `mayoreoCondicional` también: la tarjeta del cliente solo
  los suma/lee, no reimplementa la regla de qué hay en la bolsa ni la del umbral.
- **Un solo vocabulario de cantidades** en el frontend (`disponibilidadTexto`):
  el cliente lee *Pediste · Hay · Te llevas*; el personal, *Pidió · Hay · Se lleva*.
  Ver `demo-frontend/CLAUDE.md`.

**Decisiones del dueño (Fase 3).** *Hecha (3a):* cuando el operador de mostrador
**quita** piezas, el pedido pasa a **reposición** en vez de viajar a bodega a
re-surtirse (ver "El ajuste de mostrador se resuelve en el lugar"); y resolver una
propuesta de bodega con el pedido en `EN_ATENCION` ya no le quita la llamada al
cliente. *Hecha (3b):* al subir de 3 a 5 con 3 en la bolsa, bodega verifica solo las 2
extra (`piezasBase`), y una línea que bodega no encontró se puede **reponer**
(`REPONER`); ver las dos secciones de abajo. *Hecha (3c):* `vistaAt` (abajo).

### El cliente abrió la propuesta (`vistaAt`, oct 2026, 3c)

`PedidoPropuesta.vistaAt` (migración `20261017130000_propuesta_vista_at`, nullable) es
cuándo el CLIENTE abrió la propuesta por primera vez. Sin ella mostrador solo podía decir
"sin respuesta", y "no contestó" y "ni siquiera la abrió" piden acciones distintas: lo
segundo es el cliente que no se enteró y está parado en el mostrador.

- `POST cliente/pedidos/:id/propuesta/:propuestaId/vista` → `PropuestaService.marcarVista`.
  **Solo rol CLIENTE** (ni ADMIN): el personal que lee la propuesta no es "el cliente que
  la vio", y marcarla por él mentiría. Lo fija `propuesta.controller.spec`.
- **Idempotente y sin carrera:** el `updateMany` lleva `vistaAt: null` + `estado: PENDIENTE`
  + `pedidoId` en el `where`, así que la primera apertura gana, repetirla no mueve la fecha
  ni vuelve a emitir, una propuesta ya resuelta no se marca, y no se puede marcar la
  propuesta de otro pedido por id. Eso no lo ve un mock: lo prueba
  `propuesta-vista-postgres.spec` contra la BD.
- Emite `propuesta.vista` a la tienda y al pedido **solo cuando de verdad marcó**; no hay
  `pedido.estado` porque no cambia el estado. Mostrador (`mostrador/[id]/page.tsx`) la
  escucha y recarga el pedido.
- Una propuesta nueva es otra fila: nace con `vistaAt = null`.

### Subir la cantidad: bodega verifica solo las de más (oct 2026, 3b)

Al subir de 3 a 5 con 3 en la bolsa, `calcularAjusteDeCantidad` ya no reinicia la
línea (`cantidadSurtida: 0`, bodega re-verifica las 5). La **rebasa**:

| | Antes | Ahora |
|---|---|---|
| `cantidadSurtida` | 0 | **lo que hay en la bolsa** (3) |
| `piezasRetiradas` | 0 | 0 (el conteo pertenece al hallazgo; al rebasar se reinicia) |
| `piezasBase` | — | **3** (columna nueva, migración `20261017120000_item_piezas_base`) |
| `estadoSurtido` | `PENDIENTE` | `PENDIENTE` |

- **El invariante `PENDIENTE ⟹ cantidadSurtida === 0` ya no existe.** Una línea
  `PENDIENTE` con `cantidadSurtida > 0` es una línea subida: parte de ella ya está en
  la bolsa. `validarCoherencia` (el DTO de `marcarItem`) sigue rechazando que BODEGA
  mande `PENDIENTE` con piezas: eso es de lo que se manda, no de lo que se guarda.
- **Bodega marca el TOTAL** (las de la bolsa + las que encuentre), nunca menos que
  `piezasBase`. `marcarItem` lo hace cumplir: un 0 / `NO_DISPONIBLE` se rechaza, porque
  `datosDeFaltaDeBodega()` cancelaría una línea con piezas dentro de la bolsa y limpiaría
  el hallazgo — ni el checklist de retiro ni la reposición sabrían de ellas. "No hay
  más" es marcar el piso: queda `PARCIAL` y, al cerrar, la línea se liquida a lo que hay
  en la bolsa (no se cancela) y el cliente recibe una propuesta por la diferencia.
- **Por qué una columna.** El piso no se deriva: en cuanto bodega marca,
  `cantidadSurtida` pasa a ser el total y se pierde cuántas ya estaban. Sin ella, el
  "No hay" por costumbre —o corregir hacia abajo tras recargar— deja piezas fantasma.
- **Vive UNA ronda de surtido.** `confirmarSurtido` la limpia en todas las líneas (solo
  escribe si alguna la tiene), y una baja de cantidad también (`piezasBase: 0`).
- **Lo que la lee:** `pedidoTraeAjuste` / `itemPideTrabajo` (la tarjeta de ajustes y la
  exclusión del surtido por lote: el lote trataría la línea como "surtir N piezas"),
  y la red de seguridad de `aprobarPropuestaBodega`, que liquida una línea subida a lo
  que hay en la bolsa en vez de cancelarla.

### Reponer una línea que bodega no encontró (oct 2026, 3b)

Intención `{ accion: 'REPONER', itemId, cantidad }` (y `tipo: 'reponer'` en el endpoint
de mostrador). **Deshace la salida de la línea original**, no crea una nueva: conserva el
"Pediste N" (`cantidadPedida`) y el par de precios congelado; agregar la misma variante
como producto nuevo duplicaba el renglón y falseaba el "Pediste".

- **Qué se puede reponer** (`sePuedeReponer`, `core/cancelacion-linea.util.ts`): lo que
  deja `datosDeFaltaDeBodega()` — `cancelada` + `NO_DISPONIBLE` + `cantidadSurtida === 0`.
  Una línea que alguien QUITÓ teniendo piezas apartadas ya tiene trabajo en marcha
  (checklist o reposición) y no se repone. El frontend espeja el predicado
  (`estaSinExistencia`).
- **Vuelve como una línea que nadie ha visto** (`datosDeReposicion`): `PENDIENTE`,
  `cantidadSurtida: 0`, sin piso. Por eso el pedido pasa por bodega (`ajusteNecesitaBodega`
  la cuenta igual que a un producto agregado).
- **En el snapshot es un `parcial`** ("Pediste 5 · Hay 0 · Te llevas 3") con
  `subtotalOriginal: 0`: antes del ajuste no estaba en el pedido, así que no suma a "lo que
  valía" (si no, la línea se leería como una baja siendo un aumento). El aplicador
  (`aplicarPropuestaDeVentas`) la reconoce por el estado de la línea en la BD, no por una
  marca del snapshot: un snapshot viejo no puede resucitar una línea que no esté sin
  existencia.
- **Pedir MÁS de lo solicitado** ya era posible (`CANTIDAD` no tiene tope); no hizo falta
  código.
- `AjusteService.calcular` carga también las líneas sin existencia (la calculadora filtra).

**Pendiente conocido:** `aprobarPropuestaVentas` hace dos `cambiarEstado` en commits
separados (una ventana con el pedido `EN_REVISION` sin asignar visible en la cola
de bodega); y los guards de `PARCIAL`/`NO_DISPONIBLE` activos en
`aprobarPropuestaBodega` parecen inalcanzables desde F17.

## Cancelar el pedido: el cliente (oct 2026)

Decisiones del dueño (19-oct-2026). Antes había **cuatro** reglas para cancelar: el botón de «Mis pedidos» (4 estados), `PedidoApartadoCard`, el «Cancelar pedido» de la propuesta
(`RECHAZAR` / `CANCELAR_PEDIDO`) y el servidor (7 estados); el detalle no tenía botón y el cliente se enteraba del bloqueo hasta recibir el 409. Ahora **UNA función decide y todo lo demás la pinta**.

- **`core/cancelacion-cliente.util.ts` (`decidirCancelacionDelCliente(pedido, pago)`, pura) es la ÚNICA decisión.** La usan la cancelación real (`ClienteService.cancelarPedido`), «Mis pedidos»
  (`obtenerMisPedidos`, una sola consulta de pagos por página: `pagosParaCancelar` en `pagos/transferencia/hooks.ts`) y el detalle (`obtenerMiPedido`) por el mismo camino
  (`ClienteService.decisionesDeCancelacion`). Devuelve `{ puede, codigo, motivo, mercanciaApartada, preguntarTransferencia }`; `banderasDeCancelacion` las pasa a lo que viaja:
  **`puedeCancelar`, `motivoNoPuedeCancelar`, `cancelarDevuelveMercancia`, `cancelarPideConfirmarTransferencia`**.
- **Qué cancela el cliente:** Recibido, En preparación, Pendiente de aprobación, Con asesor, Listo en tienda y Pendiente de pago SIN comprobante enviado. **No cancela** (409 con `codigo` y un motivo que lee el cliente):
  `EN_ATENCION` («díselo a la persona que te atiende»; la cancelación del operador de mostrador NO cambia), `EN_DTF` (se cancela cada diseño desde su tarjeta), comprobante en revisión o transferencia verificada
  (primero se resuelve el dinero), `PAGADO`/`ENVIADO`/`ENTREGADO` (→ mostrador; a domicilio dice «comunícate con la tienda»: no hay mostrador al que ir) y `CANCELADO`. El estado manda sobre el pago.
- **Transferencia PENDIENTE (dinero posiblemente en camino):** la pantalla pregunta «¿ya transferiste?»; «ya» manda a la tienda en vez de cancelar. **El servidor lo exige también**: sin `noHeTransferido: true`
  en el body responde `409 CONFIRMAR_TRANSFERENCIA` (una pantalla desfasada o un cliente de la API no cancelan a ciegas). Con `enableImplicitConversion` el STRING `"false"` se volvería `true`: el DTO lee el valor crudo (`@Transform`) y lo fija una prueba por HTTP.
- **La propiedad se comprueba PRIMERO** (`findFirst { id, usuarioId }` → 404). Antes se leía el pedido a secas y la propiedad la comprobaba recién `cambiarEstado`: un cliente recibía «ya fue pagado» o «comprobante en revisión»
  (409) sobre el pedido de OTRO. Consecuencia: el ADMIN ya no cancela por `POST cliente/pedidos/:id/cancelar` pedidos ajenos (nadie lo usaba; el admin cancela por destrabar/mostrador).
- **La decisión se re-comprueba DENTRO de la transacción**: `desdeEstados: [estado leído]` (ver «Reglas al tocar la máquina») y, en los `efectos`, el pago (un comprobante que llegó entre la lectura y la escritura revienta la
  transacción con 409; si llega DESPUÉS, el hook de la máquina lo deja marcado para Tesorería, como siempre).
- **Una sola cancelación, también desde la propuesta.** El «Cancelar pedido» de `PropuestaDetalle` ya NO llama `RECHAZAR`/`CANCELAR_PEDIDO`: abre el mismo diálogo y llama a `cancelarPedido`, que **cierra la propuesta PENDIENTE en la
  misma transacción** (`RECHAZADA`, `respondidaAt`; `notaCliente` NO se toca) y emite `propuesta.respondida` después del commit. Antes, cancelar desde `ESPERANDO_APROBACION` por la lista dejaba la propuesta `PENDIENTE` sobre un pedido
  cancelado y «Mis pedidos» pintaba «Pendiente de aprobación» en él. Los caminos `RECHAZAR`/`CANCELAR_PEDIDO` de `PropuestaService` siguen existiendo (los usan destrabar y el operador en nombre del cliente).
- **El motivo es OPCIONAL, como Amazon/Uber** (`core/motivos-cancelacion-cliente.ts`: `CAMBIE_DE_OPINION`, `ME_EQUIVOQUE`, `TARDO_MUCHO`, `MEJOR_PRECIO`, `OTRO` con texto ≤200). Se guarda en **`PedidoCancelacionCliente`**
  (`pedido_cancelaciones_cliente`, migración `20261028120000_pedido_cancelacion_cliente`, 1:1 con el pedido, cascade): motivo, texto, tienda, usuario y el **estado en que estaba**. **La fila solo existe si el cliente dio un motivo**; omitirlo no
  deja nada. Es una TABLA APARTE y no una columna de `Pedido` a propósito: muchas respuestas devuelven la fila completa y el motivo es para el negocio, no para el cliente ni las TV. `motivo` es un slug validado en el servidor
  (no un enum de la BD): el catálogo crece sin migración, como `PedidoIntervencion.tipo`. `motivoElegido` rechaza (400) texto sin motivo y texto con un motivo que no es «Otro»; «Otro» sin texto vale.
  **NO va al historial** (`observacion` es siempre «Cancelado por el cliente»), **ni a `notaCliente`, ni al correo** (`PedidoReposicion.motivo` es el texto fijo, y el correo lo lee), ni a nada que lea el cliente.
- **Quién lo ve:** `GET pedidos/:id/destrabar` (solo GERENTE de SU tienda y ADMIN) trae `cancelacionDelCliente { motivo, etiqueta, detalle, estadoAlCancelar, createdAt } | null`; el frontend lo pinta en `CancelacionDelClienteCard`.
  `GET cliente/pedidos/motivos-cancelacion` da la lista al diálogo (declarada ANTES de `:id`: `ParseIntPipe` daría 400). **Ojo:** el cuerpo de la petición (con el texto de «Otro») también queda en `log_actividades.metadata.body`
  (`AuditLogInterceptor`), visible solo al admin.
- **Pruebas:** `cancelacion-cliente.util.spec` (los 12 estados × sin pago/PENDIENTE/EN_REVISION/VERIFICADO = 48 casos con expectativas escritas a mano + guardián del enum), `motivos-cancelacion-cliente.spec`, `cancelar-pedido.dto.spec`,
  `cliente-cancelar.spec` (servicio con mocks), `cliente.controller.spec` (HTTP real con el `ValidationPipe` de `main.ts`), `cliente-cancelar-postgres.spec` (**contra la BD: los 48 pedidos reales; lista = detalle = cancelación real**, motivo guardado/omitido,
  carreras con `EN_ATENCION` y con un comprobante, propiedad, propuesta cerrada, el motivo no llega al cliente) y un bloque en `destrabar-postgres.spec`. Se comprobó que muerden (8 mutaciones: quitar `desdeEstados`, el re-chequeo del pago, la propiedad, el cierre de la
  propuesta, escribir el motivo en el historial, reabrir `EN_ATENCION`, guardar siempre el motivo, no exigir la confirmación; y quitar el `@Transform`). Probado además de punta a punta contra el servidor vivo (33 comprobaciones) y en un navegador real (ver el `CLAUDE.md` del frontend).
- **Abierto (NO se tocó, decisión del dueño):**
  1. **Mostrador y destrabar al cancelar tampoco cierran la propuesta `PENDIENTE`** (la cancelación del cliente ya sí). El arreglo de raíz sería hacerlo en `cambiarEstado` al ir a `CANCELADO`; cambia el comportamiento de todos los caminos.
  2. **Cancelar un pedido no cancela sus trabajos DTF** (y la cola de Impresión no mira el estado del pedido): un `REVISADO`/`PENDIENTE_PAGO` mixto cancelado deja sus diseños vivos en la cola. Ya era así.
  3. **Un `PENDIENTE_PAGO` que una cajera ya tomó** (`cajeroAsignadoId`, el cliente puede estar pagando en la ventanilla) sigue siendo cancelable por el cliente: el dueño enumeró «Pendiente de pago sin comprobante» y no distinguió. Es el mismo conflicto que «En atención».

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

### La búsqueda GLOBAL del ADMIN (N2, oct 2026)

`GET admin/busqueda/pedidos?q=` (`PedidoBusquedaGlobalController`) — "¿dónde está el pedido PD-…?" sin adivinar la tienda. Es la **única** ruta que busca en
todas las tiendas; la de las consolas (`pedidos/consulta/buscar`) sigue siendo de UNA (D1).

- **Controller APARTE con `@Roles(ADMIN)` a nivel de clase**, no un método más de `PedidoConsultaController` (cuyo `@Roles` incluye a los 5 roles de empleado): con
  un método bastaba que alguien le quitara el `@Roles` para abrirle a un cajero los pedidos de todas las tiendas. Vive en `MostradorModule` por la misma razón de ciclo
  que la consulta (depende de `MostradorQueryService`).
- **No reimplementa la búsqueda**: `buscarPedidos(q, user, undefined, …)` sin tienda ya buscaba en todas (acentos, teléfono, palabras sueltas, folio de VFP) y cada fila
  trae su `tienda` completa (la pantalla pinta la ciudad). Solo el ADMIN llega ahí; un empleado sin tienda sigue fallando cerrado (403).
- **`?tiendaId=` es 400** (`BuscarPedidoGlobalDto` = `BuscarPedidoDto` sin `tiendaId`): aquí no acota nada, y ignorarlo en silencio haría creer a quien llama que acota.
  `q` < 2 caracteres también es 400 (`@MinLength`); sin `q`, vacío.
- **El detalle no necesita ruta nueva**: `GET pedidos/consulta/:id` ya exime al ADMIN de la tienda (`cargarYValidar`).
- Specs: `pedido-busqueda-global.controller.spec.ts` (por HTTP con el `RolesGuard` real: cada rol de empleado y CLIENTE → 403, el servicio se llama SIN tienda solo para el
  ADMIN —aunque traiga una en el token—, `?tiendaId=` → 400) y `busqueda-global-postgres.spec.ts` (contra la BD, dos tiendas: encuentra en todas y en cualquier estado, cada fila
  trae su `tienda`, y la del empleado sigue acotada / cerrada).

## La torre de control del ADMIN (N1, oct 2026)

`GET admin/torre-control` (`modules/admin-torre/`, solo ADMIN, `@Roles` de clase) — "¿cómo va cada tienda?" sin entrar a cuatro consolas. Una entrada por tienda
ACTIVA: pedidos por etapa, la espera más larga, transferencias, DTF y un **semáforo**. Es la única vista multi-tienda con la búsqueda global (D1).

- **El semáforo mide la ESPERA, no el volumen** (`torre-control.util.ts`, pura y con spec): 30 pedidos en caja pueden ser un buen día; lo que importa es cuánto lleva esperando
  el primero. Etapas y umbrales (min, ámbar/rojo; `UMBRALES_MIN`): bodega sin tomar 15/30 · surtiendo 30/60 · ventas 30/60 · mostrador (cliente YA en tienda) 10/20 · fila de caja
  10/20 · transferencia por verificar 60/180 · DTF recibido sin revisar 60/180 · transferencia verificada sin registrar = `PAGOS_ALERTA_SIN_REGISTRAR_HORAS` (4 h → ámbar) y el
  triple (rojo). **Los umbrales son decisión de operación y NO están medidos**: viven juntos para ajustarlos en una tabla (N4 "Atorados" los generalizará y hará editables).
  La frontera es inclusiva (llegar al umbral YA es el nivel). La tienda toma el peor nivel de sus etapas y lista los `motivos` del peor al menos malo (a igual nivel, el que más espera).
- **Qué NO es espera del personal** (y por eso no cuenta): un REVISADO cuyo cliente no está (espera al cliente; solo cuenta con `presenteDesdeAt`, medido desde que LLEGÓ), una
  propuesta por decidir, un PAGADO sin recoger, un PENDIENTE_PAGO a DOMICILIO (no es de ventanilla) ni uno que ya tiene cajero (ya lo atienden).
- **Desde CUÁNDO se mide cada espera:** SOLICITADO desde `fechaPedido`; EN_REVISION con bodeguero desde `asignadoAt`; EN_REVISION LIBRE y EN_ASESORIA desde su última fila de historial
  hacia ese estado (un pedido que bodega liberó escribe la suya: mide desde que quedó libre, no desde que se hizo); caja desde `colaCajaDesdeAt`; transferencia por verificar desde
  su `updatedAt`; sin registrar desde `verificadoAt`.
- **Pocas consultas para TODAS las tiendas a la vez** (un `groupBy` de estados, un `findMany` de lo que espera con su historial, uno de transferencias, uno de DTF), no un monitor por
  tienda (cada monitor arma el snapshot de UNA tienda y son pantallas públicas con otra forma). Solo el DTF se pide por tienda a `ImpresionService.resumen`
  (`DtfModule` ahora lo exporta): el número de la torre es EXACTAMENTE el de la consola de Impresión y la regla del "día del negocio" no tiene una segunda copia.
- Specs: `torre-control.util.spec.ts` (umbrales, fronteras, orden de motivos), `torre-control-postgres.spec.ts` (contra la BD, dos tiendas activas + una inactiva que no sale: qué estados
  entran en cada número, desde cuándo, qué no cuenta, semáforo) y `torre-control.controller.spec.ts` (por HTTP con el `RolesGuard`: cada rol de empleado, CLIENTE, TESORERIA e
  IMPRESION → 403). Probado en vivo contra la BD de desarrollo (35 ms para 4 tiendas).

## La salud del sistema (N3, oct 2026)

`GET admin/salud` (`modules/admin-torre/`, solo ADMIN, `@Roles` de clase) — hoy un pedido atorado hacia el Sistema Comercial NO lo ve nadie hasta que el cliente reclama (un
PENDIENTE_PAGO sin folio no se cobra). Junta, con pocas consultas para todas las tiendas, lo que antes había que ir a buscar a la BD:

- **Agente del ERP por tienda** (`SyncCheckpoint`): estado `EN_LINEA | SIN_LATIDO | NUNCA`, minutos sin latido, versión, último error. **`NUNCA` solo es rojo si ya hay pedidos esperándolo**:
  una tienda sin agente instalado y sin trabajo no está rota, aún no se instala. En la BD de desarrollo salió de inmediato: Mexicali con 8 pedidos en la bandeja ~42 h y ningún agente.
- **Bandeja nube→ERP** (`PedidoPendienteEnvio`): pendientes / procesando / en reintento / expirados, y los que tienen problema con su `ultimoError` y `ultimoErrorCode`. Un PENDIENTE
  viejo, un RETRY y un PROCESSING con el lease vencido (el agente se cayó a medio proceso) pesan por separado.
- **Eventos ERP→nube** (`SyncEventInbox`): `ERROR` (se reintenta, ámbar) y `DEAD_LETTER` (ya no se reintenta solo, rojo), con los 10 más recientes. **El único reintento que existe es
  `POST sync/admin/events/:eventId/replay`** y es el único botón de la pantalla: no se inventó ninguna acción nueva sobre el ERP (la del plan decía "donde ya exista la acción").
- **Kioskos** (reusa `calcularSaludKiosko`), **TV de bodega** (`BODEGA_MONITOR` con `ultimoHeartbeat`: son las ÚNICAS pantallas que reportan latido; las de caja y mostrador no, así que no se
  pueden vigilar todavía), **outbox de realtime** (eventos sin emitir) y **barridos**.
- **`common/actividad-workers.ts` (`ActividadWorkers`, módulo global)**: cada worker (`estaciones`, `kiosko-alertas`, `dtf-barrido`, `realtime-outbox`) declara su periodo y avisa al terminar cada
  pasada; se inyecta como `@Optional()` (los workers y sus specs funcionan igual sin él). **EN MEMORIA a propósito** (el outbox corre cada segundo): al reiniciar todos empiezan "aún sin
  correr" y se cuentan desde que se DECLARARON, así que un reinicio reciente no los pinta de rojo. Ámbar tras 3 periodos sin correr, rojo tras 6, con piso de 1 / 5 min para los de 1 segundo;
  fallando en su último intento también es ámbar.
- **Umbrales** en `UMBRALES_SALUD` (`salud-sistema.util.ts`, pura y con spec): agente 5/15 min sin latido, PENDIENTE sin tomar 5/15, reintento desde 1 / rojo a 30, TV 10/30, outbox 2/10.
  **Son decisión de operación y NO están medidos** (se ignora el periodo real de latido del agente): ajustables en una tabla.
- Specs: `salud-sistema.util.spec.ts` (22), `salud-sistema-postgres.spec.ts` (contra la BD: una tienda con agente caído y la bandeja atorada, una sana, una sin agente ni trabajo, eventos y un
  worker rojo), `salud-sistema.controller.spec.ts` (HTTP + `RolesGuard`: todo rol de empleado → 403) y `common/actividad-workers.spec.ts`.

## El GERENTE: supervisor de UNA tienda (oct 2026)

Rol `GERENTE` (migración `20261022130000_rol_gerente`, solo agrega el valor al enum). Es un empleado de **una tienda**
(`tiendaId` obligatorio en el alta, como todos menos Tesorería; la tienda sale SOLO del token) que **supervisa**: no opera
consolas. Decisiones del dueño, 17-oct-2026:

- **Qué ve y hace (A2, solo LECTURA):** la torre y la salud de SU tienda (`GET gerencia/torre-control`, `GET gerencia/salud`,
  `GerenciaController`, `@Roles(GERENTE)` de CLASE y aparte de `admin/*` por la misma razón que la búsqueda global), y
  buscar/abrir pedidos de su tienda (`pedidos/consulta/*` y el escáner `pedidos/escaneo`, que ya acotan por tienda del token con
  `cargarYValidar`). `puedeOperar` le da `false` siempre: ve quién tiene el pedido, no lo opera. Las acciones para destrabar
  pedidos son otra pieza (con motivo obligatorio y bitácora).
- **Qué NO tiene:** Tesorería (ve CLABE y comprobantes y aprueba dinero), las consolas de bodega/mostrador/caja/ventas/impresión
  (el ADMIN las cubre con puesto) y todo `/admin/*`. **Lo que solo hace el ADMIN** (marcar gratis, cancelar pagados, cambiar
  precios, crear empleados) **no se programó como excepción**: `RolesGuard` niega por defecto, así que basta con que GERENTE no
  esté nombrado. `roles-contrato.spec.ts` lo convierte en contrato con una **lista cerrada**: escanea TODOS los controllers y falla
  si GERENTE aparece en un `@Roles` fuera de `GerenciaController`, `PedidoConsultaController`, `PedidoBusquedaController` y 5
  handlers de `AuthController` (sesión/perfil/latido). Se comprobó que muerde: darle GERENTE a `UsuariosController` lo rompe.
- **Torre acotada:** `TorreControlService.obtener(user, ahora, tiendaId)` y `SaludSistemaService.obtener(ahora, tiendaId)` son la
  MISMA consulta de siempre filtrada a una tienda (no hay una segunda definición de "cómo va una tienda"); el spec contra la BD
  comprueba que la tarjeta del gerente es idéntica a la de su tienda en la torre del ADMIN.
- **La salud del gerente va redactada en el SERVIDOR** (`salud-gerente.ts`, `redactarParaGerente`): por LISTA BLANCA, campo por
  campo. Lleva agente (estado, latido, versión), cuántos pedidos esperan al ERP y cuáles, kioskos y TV de su tienda y solo los
  CONTEOS de eventos fallidos. NO lleva el texto crudo de los errores del ERP (`ultimoError`, `mensaje`: traen rutas internas y
  nombres de tablas), ni el outbox ni los barridos (son del sistema), ni el `replay` de eventos (acción sobre el ERP, solo ADMIN).
  `salud-gerente.spec.ts` fija las llaves exactas: un campo técnico que mañana se agregue a `SaludSistema` no llega al gerente.
- **`?tiendaId=` de un gerente se IGNORA** (`@TiendaConsola`); el ADMIN que entra por `gerencia/*` tiene que elegir tienda.
- Nada de presencia: el gerente no entra a la TV de bodega (`marcarEntrada` solo mira a BODEGA) ni manda latido desde la pantalla.
- Seed: `gerente.mexicali@puntotextil.com` y `gerente.mty@puntotextil.com` (123456). El seed es destructivo: en una BD con datos
  que se quieran conservar, crea los gerentes por el panel de usuarios (o con un `upsert` suelto).
- **Pendiente (siguiente pieza):** marcar vencida / cancelar por falta de pago y el resto de acciones de destrabar para el gerente
  de su tienda, desde el detalle del pedido y SIN darle Tesorería.

## Destrabar pedidos y las tareas del Sistema Comercial (oct 2026, etapa 1)

Módulo `src/modules/destrabar/`. El gerente de UNA tienda y el admin resuelven un pedido atorado desde su detalle. **Decisiones del dueño (17-oct):**
"dar gratis" NO existe (descartado); no se reabre un cancelado (`CANCELA_PEDIDOS` del ERP borra las líneas y deja el total en 0: se hace un pedido nuevo); al
cliente NO le llega correo, solo un aviso en SU pedido; el que refleja lo pendiente en el Sistema Comercial es el **CAJERO** (el cobro que él registra allá llega a la web por el agente).

- **Una puerta:** `GET pedidos/:id/destrabar` (el SERVIDOR dice qué acciones caben, con `bloqueadaPor` si algo las impide; más bitácora y tareas del pedido) y `POST pedidos/:id/destrabar/:accion`
  `{ motivo (≥3, obligatorio), mensajeCliente? }`. `@Roles(GERENTE)` de clase (el ADMIN pasa); el gerente solo en SU tienda (`cargarYValidar`); cajero y demás roles, 403.
  `forbidNonWhitelisted`: un precio o estado en el body da 400. Cada acción REUTILIZA el servicio que ya existía (no hay segunda copia de ninguna regla).
- **Acciones de la etapa 1:** `CANCELAR_SIN_PAGO` (estados anteriores al cobro; espejo de `ClienteService.cancelarPedido`: reposición, aviso a bodega, `sinNotificar`; bloqueada con un comprobante en revisión o dinero verificado),
  `MARCAR_VENCIDA` (transferencia PENDIENTE, vía `TesoreriaService.vencer`) y `MARCAR_PAGADO` (`AdminService.marcarComoPagado`; bloqueada con comprobante/dinero).
- **Acciones de la etapa 2 (oct 2026)** — cada una reutiliza el servicio que ya existía, con una opción que dice "lo hace la tienda, el cliente NO está":
  - `APROBAR_PROPUESTA` / `RECHAZAR_PROPUESTA` (`PropuestaService.responderPorLaTienda`; pedido en `ESPERANDO_APROBACION`, `REVISADO` o `EN_ATENCION` con una propuesta PENDIENTE). Es el camino del operador (`enNombreDelCliente`) con tres
    diferencias: el historial dice "por la tienda" (no "<nombre> desde mostrador"), queda marcada `forzadaPorId/forzadaAt` (la marca que ya tenía `forzarAprobacion`, cuyo endpoint se había eliminado por no tener pantalla), y **rechazar la de
    BODEGA cancela el pedido sin correo** (`sinNotificar`; el cliente lo lee en su pedido). Rechazar la del ASESOR lo regresa a `EN_ASESORIA` y no deja mensaje. Aprobar sí notifica normal ("tu pedido está listo": es cierto).
  - `DEVOLVER_A_BODEGA` (`VentasService.devolverABodega`, `EN_ASESORIA`): con `opts.observacion` propia — el historial no puede decir "por el asesor" ni llevar el motivo.
  - `QUITAR_PRODUCTOS` (`MostradorService.ajustar(..., { porLaTienda: true })`; `ESPERANDO_APROBACION` y `REVISADO`, NO `EN_ATENCION`: ahí hay un operador con el cliente enfrente). **Solo quita o baja**, nunca sube ni agrega (eso lo acuerda
    el cliente): el body es `items: [{ itemId, cantidad }]` con la cantidad con la que debe QUEDAR (0 = quitar), validado contra las líneas que el servidor mismo devuelve en `lineas`; un precio o un `precioCOId` da 400. Se traduce a las
    intenciones `no-disponible`/`parcial` de `ajustar`, así el total, la reposición y la propuesta superada salen de la misma regla. **Aparece BLOQUEADA si alguna línea pide más piezas de las que hay en la bolsa** (el caso típico:
    bodega no surtió completo y la propuesta sigue en la mesa): `ajusteNecesitaBodega` cuenta también las líneas SIN cambio, así que ajustar otra línea mandaría el pedido a bodega, justo lo que esta acción promete no hacer. Se resuelve primero con la propuesta. **`porLaTienda` apaga tres cosas del ajuste de mostrador**: registrar la LLEGADA del cliente (sería un aviso
    de presencia falso: bodega lo trataría como "cliente en tienda"), la `nota` en el historial y en `notaCliente` (aquí es el motivo interno) y la firma "mostrador por <operador>". Un pedido en `ESPERANDO_APROBACION` queda en `REVISADO`.
  - `LIBERAR_BODEGA` (`EN_REVISION` con bodeguero) y `LIBERAR_CAJA` (`PENDIENTE_PAGO` con cajero): `BodegaService.liberarPedido` / `CajeroService.liberarPedidoCajero` aceptan ahora al GERENTE (el de caja comprueba su tienda a mano: no pasa
    por `cargarYValidar`). **No hay "reasignar" a una persona**: liberar devuelve el pedido a la cola y lo toma quien esté, que es lo que ya hace el piso.
  - `MARCAR_ENTREGADO` (`PAGADO`/`ENVIADO`): `cambiarEstado` directo con `sinNotificar`, NO `MostradorService.entregar` (ese manda el correo "entregado", falso aquí, y firma "en mostrador por <operador>"). `ENTREGADO` no se persiste en
    Firebird: no hay tarea.
  - `CANCELAR_PAGADO` (**solo ADMIN**, `PAGADO`; no `ENVIADO`: la mercancía ya salió y la reposición mentiría). Misma cancelación que `CANCELAR_SIN_PAGO`. El dinero se reembolsa por sí solo donde ya había mecanismo: una transferencia
    `VERIFICADO`/`APLICADO` pasa a `REEMBOLSO_PENDIENTE` dentro de `cambiarEstado` (Tesorería lo ve). Si el pedido está cobrado en el ERP (fila `PROCESADO`), `reflejarCancelacionEnErp(…, { yaCobrado })` abre una tarea **`ANULAR_VENTA_EN_ERP`**
    (migración `20261023120000_destrabar_etapa2`, solo agrega el valor al enum) en vez de `CANCELAR_EN_ERP`: allá la venta está cobrada y no basta cancelar. **Se cierra a mano** (cajero/gerente/admin): cómo anula el ERP una venta ya facturada
    NO está confirmado y el agente no reporta ese evento (etapa 3). Si el cobro fue en caja, devolver el dinero lo hace la tienda: la instrucción de la tarea lo dice.
  - Un gerente que llama directo a una acción del ADMIN recibe **403** (no el "ya no cabe" genérico): `SOLO_ADMIN` en `destrabar.service.ts`. `RolesGuard` es de clase (`@Roles(GERENTE)`), así que la distinción vive en el servicio.
  - **Mensaje para el cliente solo cuando se CANCELA** (`pideMensajeCliente`): `avisoDeTienda` se pinta únicamente en el banner de "Este pedido fue cancelado"; en las demás acciones no hay dónde mostrarlo, y ofrecer el campo prometía algo falso.
  - La bitácora se escribe en la MISMA transacción solo donde la acción es un `cambiarEstado` (cancelaciones, entregado); en las que delegan en otro servicio con su propia transacción (propuestas, devolver, quitar, liberar) se escribe justo
    después: si ese `create` fallara, la acción ya ocurrió sin fila de bitácora (queda en el log del servidor con el motivo).
  - Las rutas de destrabar no llevan `@RequiereEstacion()`: el GERENTE no tiene estación y el ADMIN está exento; el gerente no "opera una consola", supervisa.
  - Specs: `destrabar-etapa2-postgres.spec.ts` (contra la BD: cada acción, que ningún texto del cliente lleve el motivo, sin correo en las que cancelan, 403 al gerente en la del admin, validaciones de `QUITAR_PRODUCTOS`) y el caso nuevo de
    `destrabar.controller.spec.ts` (cada línea solo `itemId` + `cantidad`). Se comprobó que muerden: quitar el `!opts.porLaTienda` del aviso de llegada, el `yaCobrado` o el `sinNotificar` del rechazo rompe su prueba.
- **Bitácora (N5):** `PedidoIntervencion` (`pedido_intervenciones`): tipo, motivo, actor (id, rol, nombre), estado antes/después, `mensajeCliente`. Cascade con el pedido. **El historial del pedido (`HistorialPedido`) lo PINTA EL CLIENTE**, por eso
  allí va un texto neutro ("Cancelado por la tienda: falta de pago", "Cobro registrado por la tienda") y el motivo real vive SOLO en la bitácora. Un spec lo fija. El gerente aparece como "Nombre (Gerente)" (`nombre-actor.ts`).
- **Tareas del Sistema Comercial** (`TareaSistemaComercial`, `tareas_sistema_comercial`; tipos `CANCELAR_EN_ERP` y `REGISTRAR_COBRO_EN_ERP`): lo que la nube hizo y el ERP todavía no sabe. Una sola ABIERTA por pedido y tipo (índice único parcial en la migración).
  Las crea el servidor SOLO si el pedido YA está en el ERP (su `PedidoPendienteEnvio` está PROCESADO) — `core/tareas-erp.util.ts`, funciones puras (el ciclo de módulos impide inyectar el servicio):
  - **Toda cancelación** pasa por `cambiarEstado` y lo engancha ahí (cliente, mostrador, propuestas, destrabar): PROCESADO → tarea; sin entregar al agente (PENDIENTE/RETRY/ERROR/EXPIRADO) → la fila de envío se marca `CANCELADO` (ya no cuenta como "bandeja atorada"
    en la salud, que además ignora pedidos cancelados); en vuelo (PROCESSING) → no se toca y lo resuelve el ACK; lo cancela el sistema/agente (`SWCANCEL`, `userId 0`) → nada, el ERP ya lo sabe.
  - **El ACK de un pedido cancelado en vuelo** (`procesarPedidosAck`) ahora guarda el folio y abre la tarea: antes quedaba un folio vivo en el ERP y solo un warning.
  - **Cobro manual** (`marcarComoPagado` por una persona) con folio → `REGISTRAR_COBRO_EN_ERP`.
  - **Se cierran solas** cuando el ERP confirma (`PedidoPagoHandler`: `SWCANCEL=true` / `FINALIZADA=true`, incluida la rama idempotente de "ya estaba cobrado"), o a mano. Eso depende de que el agente reporte esos eventos (ver abajo).
  - `GET tareas-erp` (de UNA tienda, `@TiendaConsola`; CAJERO, GERENTE y ADMIN), `POST tareas-erp/:id/hecha` ("ya lo hice") y `…/descartar` ("no aplica", solo gerente/admin, nota obligatoria). `atrasada` desde `PAGOS_ALERTA_SIN_REGISTRAR_HORAS` (4 h). `eliminarPedidoCancelado` se niega con tareas abiertas.
- **Aviso al cliente:** `GET cliente/pedidos/:id` trae `avisoDeTienda` (el último `mensajeCliente`): texto estándar + lo que escribió el gerente. Sin correo.
- **Etapa 3 (oct 2026): el contrato nube ↔ agente ↔ Firebird PROBADO de punta a punta.** Contra una copia de la BD real (`DATOSINV.FDB`, Firebird 3.0.10, Docker `fb-datosinv`), el agente REAL, una nube de prueba aparte (BD propia, otro puerto) y el
  catálogo completo de Firebird (94 389 eventos). **Hasta hoy ninguna de las dos direcciones había funcionado** (los scripts y el agente nunca se habían corrido contra Firebird); cada defecto se vio solo contra el sistema real, porque los tests
  usaban una transacción/BD de mentira:
  - **`TRG_PEDIDOS_SYNC`**: un solo script, `firebird/04_trg_pedidos_sync.sql` (solo ese trigger). `01`/`02` NO se aplican a la BD real: sobrescribirían `TRG_TIENDAS_SYNC`/`TRG_USUARIOS_SYNC` (ya existen, con otras columnas), agregan `TIENDAS.PREFIJO` cuando
    ya hay `TIENDAS.SERIE`, y crean `TRG_MOVPED_SYNC` (la nube ya no lo usa). Ya están marcados y `INSTALL*.md` reescritos. **Está instalado en la copia local; la BD de producción sigue sin él** (falta aplicarlo: ver `firebird/INSTALL.md`).
  - **Bajada (nube → Firebird), 3 defectos del agente:** (1) `GRABAR_PEDIDOS` recibe 16 parámetros y el SQL llevaba 15 `?` ("Input parameter mismatch"); (2) es un procedimiento EJECUTABLE: `SELECT … FROM` da "not selectable", va `EXECUTE PROCEDURE`, que
    devuelve UN objeto, no un arreglo (`primeraFila`); (3) el folio CHAR(10) vuelve relleno de espacios y se recorta. Con esto ningún pedido de la web podía bajar al Sistema Comercial.
  - **Subida (Firebird → nube), 2 defectos:** (1) el agente mandaba `_bandejaId` en cada evento y la nube, con `forbidNonWhitelisted`, contestaba **400 a TODO lote de `BANDEJA_SYNC`** (el trigger habría servido de nada); (2) un lote de 200 filas pasa de los
    100 kb del cuerpo JSON (413 en el bootstrap): `CloudClient.upload` quita las llaves `_*` y parte por TAMAÑO (80 kb por POST). Guardas: el spec del agente cuenta `?` contra parámetros y rechaza llaves `_`.
  - **`AuditLogInterceptor` ya no audita `/sync/agent/*`**: cada petición del agente intentaba una fila con `usuarioId = 0` (FK rota, una advertencia por heartbeat cada 5 s por tienda) y, de "arreglarse", habría guardado cada lote con filas de clientes en `log_actividades`.
  - **Probado:** el pedido baja con su `IDPEDIDO` preasignado (`1B + id`) y sus líneas; cobro (`ACTUALIZA_PEDIDOS`) → PAGADO; cancelación en el ERP → CANCELADO; cancelado en la nube + `CANCELA_PEDIDOS` → la tarea `CANCELAR_EN_ERP` se cierra sola; cobro manual +
    `ACTUALIZA_PEDIDOS` → la tarea del cobro se cierra; un pedido de VFP que la nube no creó se omite sin errores.
- **La CONCILIACIÓN ACTIVA (etapa 3, nueva).** El trigger avisa de los CAMBIOS; esto verifica el RESULTADO y cubre un evento perdido, un agente caído o un trigger sin instalar. Cada ~10 min (`sync.conciliacionIntervalMs`, 0 la apaga; primera pasada 30 s tras arrancar) el agente
  (`agent/src/conciliacion.ts`, SOLO LECTURA sobre Firebird) pide `GET sync/agent/conciliacion` (los pedidos PROCESADOS de esa tienda que pueden diverger: por pagar/pagados/enviados, cancelados de los últimos 30 días, y los que tienen una tarea o un hallazgo abierto),
    lee `SWCANCEL/FINALIZADA/TTOTAL/IDFACTURA` en `PEDIDOS` y hace `POST sync/agent/conciliacion`. La regla es `sync/conciliacion.util.ts` (`conciliar`, PURA, con tabla de casos); `ConciliacionService` la aplica:
  - **Se corrige SOLO lo que el evento del trigger habría corregido igual**, por el MISMO `PedidoPagoHandler` (misma transición, correo, historial y tareas): cobrado en el ERP y por pagar en la nube → PAGADO (`COBRO_PERDIDO`); cancelado en el ERP y vivo en la nube →
    CANCELADO (`CANCELACION_PERDIDA`). Nacen ya resueltos (`curado`): constancia, no trabajo. Si el handler se niega, NO se fuerza: queda `ESTADO_DISTINTO`.
  - **Dinero sin respuesta obvia: se VE, no se toca** (hallazgo ABIERTO en la salud del sistema): `COBRADO_Y_CANCELADO`, `REVERSA_DE_COBRO` (pagado en la nube, sin cobro en el ERP y sin tarea que lo explique), `TOTAL_DISTINTO`; en ámbar `NO_EXISTE_EN_ERP`,
    `CANCELADO_VIVO_EN_ERP`, `ESTADO_DISTINTO`. Una fila abierta por pedido y tipo (índice único parcial `conciliacion_hallazgos_abierto_unico_idx`), se refresca y se **cierra sola** cuando la pasada siguiente ya no lo encuentra.
  - **Tareas:** si el ERP ya cobró, `REGISTRAR_COBRO_EN_ERP` se cierra; si ya canceló, `CANCELAR_EN_ERP` se cierra. **`ANULAR_VENTA_EN_ERP` NO**: devolver el dinero no se deduce de `SWCANCEL` (sigue a mano).
  - **Salud del sistema (N3):** cada tienda trae `conciliacion` (última comparación, revisados, corregidas solas en 24 h, abiertas con su texto y el `detalle` de cada lado). Rojo con dinero que no coincide; ámbar con el agente EN LÍNEA que no compara hace 30 min (rojo 2 h) o **que nunca
    ha comparado** (un agente anterior a esta versión se verá ámbar hasta actualizarlo). El gerente ve qué pedido y qué pasa, SIN el `detalle` crudo ni cuántos se revisaron (lista blanca en `salud-gerente.ts`, fijada por su spec). Migración `20261024120000_conciliacion_erp`.
  - Specs: `conciliacion.util.spec.ts` (tabla de casos), `conciliacion-postgres.spec.ts` (contra la BD: corrige solo, no toca dinero, no duplica, cierra tareas, aislamiento por tienda), `salud-sistema-postgres.spec.ts` y `salud-gerente.spec.ts`; en el agente `conciliacion.spec.ts`,
    `cloud-client.spec.ts`, `firebird-client.spec.ts`, `down-processor.spec.ts` (`cd agent && npm test`, 33). Probada en vivo con el trigger APAGADO: cobro, cancelación, tarea, total distinto y fila desaparecida detectados por el agente real y mostrados en `/admin/salud` y `/gerencia/salud`.
  - **Hallazgos de la prueba, ya ARREGLADOS (18-oct; regla del dueño: Firebird manda, si la web discrepa el error es de la web):**
    - **SKU**: `PrecioCO.sku` era `@unique` global y el ERP repite el SKU de la variante en cada tienda (1 025 SKUs en 7 733 filas, ninguno repetido DENTRO de una tienda). Ahora `@@unique([tiendaId, sku])` (migración `20261025120000_catalogo_sku_color`; relaja una restricción
      más estricta, ningún dato existente la viola). Antes solo la primera tienda guardaba el precio de una variante: las tiendas 4 a 8 casi no tenían precios.
    - **Colores**: `COLORES.DESCRIP` mide 40 en Firebird y `Color.nombre`/`ItemPedido.colorNombre` 30 (44 colores reales no se creaban y un pedido con uno de ellos no podía guardar su línea). Ensanchados a 40 en la misma migración. `catalogo-sku-color-postgres.spec.ts`.
    - **Bootstrap del catálogo** (`up-processor.ts`): avanzaba bloqueando el ciclo ~6 min (los pedidos no bajaban), cargaba 90 000 filas en memoria, no era reanudable y daba por hecho un lote con errores. Ahora va por PÁGINAS de 200 ordenadas por llave, en rebanadas de 10 s por ciclo (el resto del
      ciclo corre entre una y otra), guarda `fase` + última llave en `meta.bootstrap_estado` tras cada página (reanudable tras un reinicio) y la nube devuelve `fallidos` (los `eventId` que fallaron y se van a reintentar): el agente los guarda en su outbox. Un lote que no se pudo subir no avanza.
      Un evento `DEAD_LETTER` ya no cuenta como error al reenviarse (antes chocaba con su fila y daba `errores++` para siempre).
  - **Siguen abiertos:** (a) ~~**folio**: el agente mandaba `numeroPedido.slice(0,10)` y TODO pedido web quedaba con folio `PD-2026-00`~~ — **RESUELTO en la parte B1** (sección «El folio del Sistema Comercial como ID del pedido»); (b) `PRECIOS/PRECIOSCO` con `IDPRODUCTO = 0`
    (basura del ERP: se reportan como error y se reintentan hasta DEAD_LETTER; no se "arregla" en la web); (c) `PRECIOSCO` con dependencias aún no sincronizadas responde `ok: true` ("skipped") y ese evento en vivo no se reintenta.
- Specs: `destrabar-postgres.spec.ts` (contra la BD, dos tiendas), `destrabar.controller.spec.ts` (HTTP con `RolesGuard` y `ValidationPipe` reales), y `roles-contrato.spec.ts` (lista cerrada del GERENTE ahora incluye `DestrabarController` y `TareasErpController`).

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

## La tienda de una consola (oct 2026)

`common/tienda-consola.ts` es la **única** definición de "¿de qué tienda es esta lista?" para las consolas de empleado
(PLAN-ADMIN-MULTITIENDA, F1). Antes cada controller armaba su ternario y los que no lo copiaron leían `user.tiendaId` a secas:
el ADMIN —que no trae tienda en el token— recibía 500 en mostrador y, **peor**, en bodega un `where` sin tienda (la cola de
TODAS las tiendas mezclada; `obtenerPedidosBodega` hace `if (tiendaId) where.tiendaId = …`).

- **Se usa `@TiendaConsola() tienda: number`** (y `@ApiTiendaConsola()` para Swagger), nunca `user.tiendaId` ni `@Query('tiendaId')`.
  Aplicado a mostrador (`cola/listos/sin-aviso/buscar`), consulta, caja, bodega, ventas y reposición.
- **Empleado: la tienda sale SOLO del JWT** y un `?tiendaId=` se IGNORA (ni 400 ni se usa: con eso habría IDOR entre tiendas). Sin tienda → 403.
- **ADMIN: elige con `?tiendaId=`**, una tienda a la vez (D1). Sin elegir → `400 "Elige una tienda"`; mal formado (`abc`, `0`, `1.5`,
  `1e3`, repetido, fuera de rango de un `Int`) → 400; inexistente → `404 "La tienda no existe"` (`TiendaConsolaGuard`, solo consulta la BD para un
  ADMIN con un id bien formado). Un ADMIN que SÍ trae tienda en el token la usa si no elige otra (así ya funcionaba en impresión).
- **`{ opcional: true }`** para un INDICADOR, no una lista (el badge `bodega/reposicion/contador`): sin tienda responde 0 en vez de error.
- **`ImpresionService.tienda()` delega aquí**: dejó de ser una segunda copia de la regla.
- **Los `buscar` declaran `tiendaId` en `BuscarPedidoDto`**: el `ValidationPipe` global tiene `forbidNonWhitelisted`, y sin la propiedad `?tiendaId=`
  daba 400 a TODOS los roles. `buscarPedidos` ahora acota a la tienda también para el ADMIN que eligió una (antes la ignoraba y su buscador,
  dentro de la consola de "Obregón", traía pedidos de todas). Sin tienda (`undefined`) sigue siendo la búsqueda global: es la base de N2.
- **`ventas/pedidos/:id` ya no compara con `user.tiendaId`**: `cargarYValidar` (`PedidoAccessService`) es la única que decide quién ve qué pedido.
- **La ventanilla de caja es de la tienda que opera el ADMIN (F3.5, abajo); el MOSTRADOR sigue siendo del operador.** `GET mostrador/puesto/disponibles`
  devuelve `[]` al ADMIN en vez de 500 (le llegaba `undefined` a Prisma al abrir el selector de estación): el ADMIN llama sin número y no ocupa mostrador.
  `cajero/ventanilla/*` (`disponibles`, `miVentanilla`, `elegir`, `liberar`) usan `@TiendaConsola()` y están en la tabla `ENDPOINTS` del spec HTTP.

**Tres specs lo sostienen** (en `src/common/`): `tienda-consola.spec.ts` (la función y el guard), `tienda-consola.http.spec.ts` (**rol × tiendaId ×
endpoint por HTTP real**, con el mismo `ValidationPipe` de `main.ts`; los roles salen del `@Roles` de cada endpoint, no de una lista copiada) y
`tienda-consola-contrato.spec.ts` (escanea los controllers y falla si alguno lee `user.tiendaId` o `@Query('tiendaId')` sin estar en su lista de
excepciones, cada una con su razón: estaciones, TV de pared, favoritos, DTF del cliente, filtro del panel ADMIN). **Al agregar un endpoint de lista
de una consola:** usa `@TiendaConsola()`, agrégalo a la tabla `ENDPOINTS` del spec HTTP y declara `tiendaId` en su DTO de query si lo tiene.
**Realtime del ADMIN (F3, oct 2026).** El ADMIN entra a `admin:all`, no a `tienda-{id}`. Para recibir los eventos de la tienda que opera manda
`tienda.mirar` `{ tiendaId }` y el gateway lo une a ESE room (`realtime.gateway.ts`; ack `{ ok, tiendaId }`): una a la vez (al cambiar sale de la anterior),
solo ADMIN **re-comprobado en la BD** (un token viejo de alguien degradado no vale), id bien formado (`leerTiendaElegida`) y tienda existente.
`tienda.dejar-de-mirar` lo saca. Spec: `realtime-gateway-mirar.spec.ts`; probado en vivo con clientes socket.io (el que mira recibe `mostrador.asignado`,
el que no, nada). Pendiente: las TV de pared (F4).

**El ADMIN actúa, con salvaguardas (F2, oct 2026).** Opera la consola de cualquier tienda con su propia identidad (no hay "ver como"), pero:

- **Cubre un puesto, no toma "a secas" (F3.5, 17-oct; decisión del dueño, no se reabre).** El ADMIN SÍ toma pedidos en caja y bodega: bloquearlo lo obligaba a
  entrar con la cuenta de otro y se perdía la atribución. Pero tomar ASIGNA el pedido a quien lo toma, y todo lo que rodea una asignación (TV, fila, barrido)
  asume un puesto visible; antes un pedido tomado por el ADMIN quedaba asignado a un usuario invisible en la TV y en la fila (el bug que las estaciones
  vinieron a evitar). Por eso cada consola lo cubre a su manera (la regla vive en el servicio, no en el botón):
  - **Caja.** `VentanillasService.elegir` acepta al ADMIN sin tienda propia (comprueba que la ventanilla sea de la tienda que opera). `cajeroId` es único
    (una persona, una ventanilla, en cualquier tienda): elegir en OTRA tienda SUELTA la anterior y regresa sus pedidos a la fila conservando `colaCajaDesdeAt`,
    avisando a la tienda que deja (`ventanilla.liberada`, `pedido.cajero-liberado`); cambiar de ventanilla DENTRO de la tienda conserva sus pedidos.
    `tomarPedidoCajero` exige al ADMIN una ventanilla **en la tienda del pedido** (403; 404 si el pedido no existe); `llamarSiguiente(usuario, tiendaId)` usa la
    tienda resuelta por `@TiendaConsola()` y exige ventanilla en ella (400, igual que al cajero). Al CAJERO esto no le cuesta nada: `EstacionGuard` ya se la exige.
  - **Bodega.** Sin bloqueo: `tomarPedido` y `tomarGrupo(ids, usuario, tiendaId)`, que filtra por la tienda resuelta (antes, con `tiendaId: undefined`, Prisma
    no filtra y un ADMIN tomaba grupos de CUALQUIER tienda). Presencia: `BodegaPresenciaService.salio`/`salirInactivos` y el logout incluyen al ADMIN;
    `pedido.liberado` va a la tienda de CADA pedido (no tiene una propia). `salio(id, { soloPedidos: true })` devuelve sus pedidos SIN sacarlo de línea:
    cambiar de tienda no es irse. La TV de bodega (`monitor.service`) lo lista como un bodeguero más SOLO mientras trae pedidos de ESA tienda
    (`pedidosAsignados` se filtra por tienda); sin pedidos ahí no sale, aunque esté en línea.
  - **`POST /estaciones/soltar`** (solo ADMIN, `EstacionesController`): suelta su ventanilla —en cualquier tienda— y sus pedidos de bodega. Responde
    `{ ventanilla: { numero, pedidosRegresados } | null, pedidosDeBodegaRegresados }` para el aviso de la pantalla, que lo llama ANTES de cambiar de tienda y al
    cerrar sesión. Red de seguridad: el barrido de 15 min (`EstacionesWorker`; el ADMIN manda latido desde `RolShell`). El logout del servidor solo devuelve
    sus pedidos de bodega: la ventanilla la suelta esta ruta (igual que el CAJERO la suelta desde el frontend).
  - **Mostrador no cambia**: llamar no asigna, así que el ADMIN llama sin número y no ocupa mostrador.
  - Reglas que no cambian: sin ventanilla no hay asignación en caja; el selector de ventanilla del ADMIN es opt-in (frontend) y nunca se abre solo; su nombre
    sigue siendo "(Administrador)". Una duda de si el ADMIN "debería" tomar ya está contestada: sí, con puesto.
  - **Specs:** `pedidos/core/admin-cubre-puesto.spec.ts` (las reglas, con mocks), `admin-cubre-puesto-postgres.spec.ts` (contra la BD con DOS tiendas: ventanilla,
    caja, TV de caja, `tomarGrupo`), `estaciones/bodega-presencia-postgres.spec.ts` (bloque del ADMIN: salir, `soloPedidos`, barrido, TV por tienda) y
    `estaciones/estaciones.controller.spec.ts` (por HTTP con el `RolesGuard` real). Reemplazan a `admin-no-retiene-pedidos.spec.ts`, que fijaba lo contrario.
    Se comprobó que muerden: quitar el `tiendaId` de `tomarGrupo` o el filtro por tienda al soltar la ventanilla anterior rompe su prueba.
- **Todo lo demás pasa por `cargarYValidar`**, que lo exime de tienda y de estación: mira, cambia la forma de pago, corrige lo ya asignado, devuelve a la cola,
  cancela, envía a pagar…
- **Su nombre dice que es el ADMIN** (`common/nombre-actor.ts`, aplicado en `JwtStrategy`): "Fernando (Administrador)" en el historial, los avisos y los
  eventos. Se resuelve UNA vez en el `UserContext`, no en los ~16 sitios que escriben `usuario.nombre`.
- **Motivo obligatorio al cancelar**: `cancelarVencidos` exige ≥3 caracteres al ADMIN (el operador conserva el texto por defecto). `cancelar` ya lo exigía a todos.
- **`mostrador/llamar-siguiente` recibe la tienda** (`@TiendaConsola()`): elige de la cola de UNA tienda; sin ella el ADMIN recibía "no tiene tienda asignada".

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

151 suites, 2736 tests, todos verdes (más 71 del agente: `cd agent && npm test`). Cubren las invariantes del flujo completo
(`flujo-completo.spec.ts`), la máquina de estados
(`pedido-state.service.spec.ts`), el dinero (`invariantes-dinero.spec.ts`) y la
idempotencia de llegada.

**Antes de tocar la máquina de estados o el acceso, corre la suite.** Es la red
que evita que un cambio de transición rompa el encolado al ERP.
