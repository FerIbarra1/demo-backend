# Playerytees — Backend

NestJS 11 + Prisma 6 + PostgreSQL. API de la tienda de camisetas: catálogo,
pedidos con flujo bodega → mostrador → pago, kiosko de tablet y sincronización
con el ERP (Firebird).

El frontend vive en `../demo-frontend` y tiene su propio `CLAUDE.md`.

## Comandos

```bash
npm run start:dev        # Desarrollo con watch
npm run build            # prisma generate + nest build
npm run test             # Jest (95 suites, 1451 tests)
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

## Pagos por transferencia (oct 2026)

Plan completo y decisiones: `PLAN-PAGOS-TRANSFERENCIA.md`. Lo que hay que saber antes de tocar el cobro:

- **`PAGADO` sigue naciendo SOLO de VFP** (`FINALIZADA` vía agente). La transferencia es un
  subsistema paralelo (`PedidoPagoTransferencia`, módulo `pagos/`) con su propia máquina de estados;
  **no** agrega estados a `EstadoPedido`, ni toca `PedidoPendienteEnvio`, `GRABAR_*`, triggers ni el agente.
- **Tesorería (`TESORERIA`) verifica, no cobra.** Sin tienda (multi-tienda). Aprobar exige el monto EXACTO y
  `confirmoEnBanco`; la tienda registra el cobro en VFP y el agente lo sube (el pago pasa a `APLICADO`).
  **El `CAJERO` es otra cosa**: la ventanilla de UNA tienda.
- Las instrucciones solo se emiten con el pedido en `PENDIENTE_PAGO` y **no en DOMICILIO**
  (`transferenciaDisponible`, un solo punto de control; ver §18 del plan).
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
- **El vencimiento es MANUAL (decisión del dueño, oct 2026): nada pasa un pago a `VENCIDO` solo.** Tesorería
  cierra desde la pestaña "Vencidas" (`POST tesoreria/pagos/:id/vencer`, o `cerrar-vencidas` para todas). Solo
  cierra instrucciones `PENDIENTE` sin comprobante y ya pasadas de vigencia; con un comprobante en revisión puede
  haber dinero en camino y NO se cierra. Importa porque mientras siga `PENDIENTE` caja ve "no cobres" (el texto
  de caja ya le dice que pida a Tesorería cerrarla). La lógica vive en `cerrarPorVencimiento`, sin nada de HTTP:
  el día que se automatice (un proceso periódico, con su correo de "por vencer") llama a lo mismo y solo cambia
  QUIÉN lo dispara. "Esperando" y "Vencidas" se reparten las `PENDIENTE` por su vigencia (cada pago en una sola).
- **Abono tardío**: un pago `VENCIDO` se puede verificar (`acciones.aprobarRequiereNota`) con una nota de qué pasó;
  no si el cliente ya pidió otras instrucciones (solo cabe un pago vivo): el abono se resuelve en ese.
- **"Verificada y sin registrar en VFP" se ve, no se avisa**: `atrasado` (horas en `PAGOS_ALERTA_SIN_REGISTRAR_HORAS`,
  default 4) se calcula al leer; la cola de Tesorería lo marca y ordena lo más viejo primero; caja ve "verificada
  hace N h". Sin proceso ni push.
- **Conciliación** (`GET tesoreria/pagos/conciliacion` y `/csv`): pagos por el día del NEGOCIO en que se verificaron
  (rango en `PAGOS_ZONA_HORARIA`, no UTC), con folio VFP y totales; es el cruce humano contra el corte de caja
  porque la nube no sabe cómo registró VFP el cobro. El CSV va con BOM, y neutraliza fórmulas (`= + - @`).
  `Content-Disposition` está en `exposedHeaders` de CORS: sin eso el navegador pierde el nombre del archivo.
- **La fecha de vigencia sale en la zona de `PAGOS_ZONA_HORARIA`** (default `America/Mexico_City`). Mexicali
  y otras plazas de la frontera no coinciden con la hora del centro: configúrala por env si aplica.
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

95 suites, 1451 tests, todos verdes. Cubren las invariantes del flujo completo
(`flujo-completo.spec.ts`), la máquina de estados
(`pedido-state.service.spec.ts`), el dinero (`invariantes-dinero.spec.ts`) y la
idempotencia de llegada.

**Antes de tocar la máquina de estados o el acceso, corre la suite.** Es la red
que evita que un cambio de transición rompa el encolado al ERP.
