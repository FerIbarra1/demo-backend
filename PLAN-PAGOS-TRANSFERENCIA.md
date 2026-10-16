# PLAN — Pagos por transferencia (rol Tesorería)

> Oct 2026. Análisis del backend + plan de implementación. **Nada de esto está
> implementado**: es el resultado de leer el código y de correr la suite (72
> suites / 1046 tests, todos verdes, 15-oct-2026).
>
> Lo marcado **[SUPUESTO]** es una decisión que tomé por default y que hay que
> confirmar (ver §14). Lo marcado **[VERIFICAR]** es algo que no se puede saber
> leyendo este repo (vive en VFP/Firebird o en AWS).

---

## 0. Resumen en 12 líneas

1. Hoy el backend **no sabe con qué se paga**. No existe el concepto de método de
   pago: el cobro ocurre en VFP, el agente sube `FINALIZADA=true` y el pedido pasa
   a `PAGADO` (`pedido-pago.handler.ts:72`).
2. **Principio rector: `PAGADO` sigue naciendo SOLO de VFP.** La nube no marca
   pagado por una transferencia. Tesorería *verifica que el dinero llegó*; la
   tienda *registra el cobro en VFP* (como ya hace hoy cuando le avisan por
   teléfono); el agente lo sube y el flujo existente hace el resto.
3. Por eso la feature **no agrega ningún estado a `EstadoPedido`**, no toca la
   cola `PedidoPendienteEnvio`, no cambia el payload de `GRABAR_PEDIDOS`, no toca
   triggers de Firebird y no toca el agente. Es un **subsistema de pago paralelo
   al pedido** (como `llegada*` es ortogonal al estado).
4. El subsistema es un modelo propio, `PedidoPagoTransferencia`, con su propia
   máquina de estados, N comprobantes y una bitácora append-only.
5. Las instrucciones de transferencia se emiten **cuando el total es firme**, es
   decir en `PENDIENTE_PAGO` (§3, D1). Eso hace que "no se puede ajustar un pedido
   pagado" se cumpla *estructuralmente*, sin código nuevo.
6. Rol nuevo: **`TESORERIA`**, multi-tienda, sin `tiendaId`. El `CAJERO` que ya
   existe es el de ventanilla de **una** tienda; son cosas distintas y hay que
   mantenerlas separadas (§6).
7. El dinero que llega **nunca se ignora**: o se aplica al pedido o se reembolsa.
   De ahí salen los estados `REEMBOLSO_PENDIENTE` / `REEMBOLSADO`.
8. Los comprobantes son datos bancarios de clientes: van a almacenamiento
   **privado** y se sirven por un endpoint autorizado, **no** por el bucket
   público de imágenes de producto (§10).
9. **Domicilio queda fuera de esta feature** (decisión del dueño, 15-oct): el flujo de
   envíos se va a rediseñar por completo. La transferencia se bloquea para pedidos
   `DOMICILIO` en un solo punto de control y en §18 documento lo que habrá que
   resolver cuando llegue esa feature (incluye el hueco H1).
10. Antes de construir hay una **Fase 0** con 8 arreglos a bugs/discrepancias que
    ya existen y que esta feature volvería más caros (§2).
11. El repo tiene un historial de "agregué un rol y se me olvidó en N listas"
    (`MOSTRADOR_MONITOR`, `VENTAS`). El plan incluye un **spec de contrato de
    roles** para que no vuelva a pasar (§6.3).
12. Decisiones del dueño (15-oct): no se paga antes de `PENDIENTE_PAGO`; domicilio fuera
    de alcance; el cruce con la forma de pago de VFP se hace **a mano** por ahora (§8).
    Quedan 5 preguntas menores con supuesto (§14).

---

## 1. Cómo funciona hoy (lo que verifiqué en el código)

```
SOLICITADO → EN_REVISION → REVISADO → EN_ATENCION → PENDIENTE_PAGO → PAGADO → ENTREGADO
 (cliente)    (bodega)     (plancha)   (mostrador)        │              ▲
                                                          │   VFP: FINALIZADA=true
                              enviarAPagar ───────────────┘   agente → /sync/agent/upload
                              encolarFirebird:true                 → PedidoPagoHandler
                              (mostrador.service.ts:102)           → AdminService.marcarComoPagado
```

- **Entrada al ERP**: `REVISADO|EN_ATENCION → PENDIENTE_PAGO` con
  `encolarFirebird:true` (`mostrador.service.ts:142`). Los pedidos a **DOMICILIO**
  saltan mostrador: `EN_REVISION → PENDIENTE_PAGO` (`destino-post-surtido.util.ts`).
- **Invariante 2** (`pedido-state.service.ts:448`): `PENDIENTE_PAGO ⟺ fila en
  PedidoPendienteEnvio`. La fila nace con `externalIdPEDIDOS = 1_000_000_000 + id`
  (`:723`); el folio VFP llega en el ACK del agente.
- **Salida de `PENDIENTE_PAGO`**: solo `PAGADO` o `CANCELADO`
  (`pedido-state.service.ts:117`).
- **`PAGADO`** lo escribe `AdminService.marcarComoPagado`, que **no usa
  `cambiarEstado`** (excepción documentada). Lo llaman: el handler del agente y
  `POST /admin/pedidos/:id/marcar-pagado` (agente con `X-Agent-Key` **o ADMIN con
  JWT**).
- **El cajero hoy no cobra ni aprueba nada** (`cajero.controller.ts:10-17`): es
  una cola de ventanilla de una tienda. Cobrar se hace en VFP.
- **Cancelar**: el cliente puede cancelar hasta `PENDIENTE_PAGO` inclusive
  (`cliente.service.ts:454-462`). `PAGADO` en adelante solo lo cancela VFP
  (`SWCANCEL`), porque `TRANSICIONES[PAGADO]` incluye `CANCELADO` a propósito.
- **Ajustar**: `mostrador.ajustar` solo acepta `REVISADO|EN_ATENCION|ESPERANDO_APROBACION`;
  ventas solo `EN_ASESORIA`. **Ningún camino ajusta un pedido en `PENDIENTE_PAGO`
  o posterior** → la regla "no se ajusta lo pagado" ya se cumple por estado.
- **`PENDIENTE_PAGO` no caduca**: `ESTADOS_ESPERA_CLIENTE` es
  `[REVISADO, ESPERANDO_APROBACION]` (`presencia.util.ts:25`) y `SinRecogerService`
  no lo mira. Un pedido sin pagar puede quedarse ahí indefinidamente.
- **Almacenamiento**: `StorageService` es de **bucket público** (`publicUrlBase`,
  `urlPublica`) y valida solo JPEG/PNG/WEBP ≤ 5 MB. Sin S3 cae a `uploads/` servido
  en `/files/` (público). No hay `@aws-sdk/s3-request-presigner`.
- **Realtime**: ADMIN entra a `admin:all`; el resto a `tienda-{id}` (JWT). Un
  usuario sin `tiendaId` solo entra a `user-{id}` (`realtime.gateway.ts:127-133`).
- **Roles**: `RolesGuard` deja pasar a ADMIN siempre; si un endpoint **no** tiene
  `@Roles`, lo puede usar **cualquier** rol autenticado. Revisé todos los
  controllers y no encontré endpoints en ese caso, pero nada lo garantiza hacia
  adelante (§6.3).

---

## 2. Hallazgos: lo roto o inconsistente (entra en la Fase 0 salvo que diga otra cosa)

Ordenados por riesgo para **esta** feature.

| # | Sev. | Hallazgo | Dónde | Por qué importa aquí | Arreglo |
|---|---|---|---|---|---|
| H1 | **Diferida** | Un pedido `DOMICILIO` en `PENDIENTE_PAGO` queda **fuera de todas las consolas de caja** (`modoEntrega: { not: DOMICILIO }` en cola, monitor, `llamarSiguiente`, `mis-pedidos`). Hoy se cobra "por fuera". | `cajero.service.ts:55,266`; `cajero-monitor.service.ts:79,129` | Transferencia es *el* medio natural del domicilio. Verificado el dinero, nadie ve que falta registrarlo en VFP → nunca `PAGADO` → nunca `ENVIADO`. Es exactamente la clase de "atascado para siempre" que la Invariante 2 intenta evitar. | **Fuera de alcance** (§18): la transferencia se bloquea para `DOMICILIO`; se resuelve con la feature de envíos. |
| H2 | **Alta** | Evento de pago/cancelación **sin mapeo** se descarta **y se marca `PROCESADO`**; el checkpoint avanza. | `pedido-pago.handler.ts:55-57` + `sync-agent.service.ts:147-159` | Si el ACK del agente se retrasa/falla y la tienda cobra antes, el `FINALIZADA` se pierde para siempre y el pedido pagado en VFP queda `PENDIENTE_PAGO` en la nube. Con transferencias es dinero verificado sin aplicar. | **HECHO (Fase 0).** Ojo: la versión ingenua de este arreglo —`ok:false` para todo lo que no tenga mapeo— era PELIGROSA: el trigger dispara con TODOS los pedidos de Firebird, y los creados directo en VFP nunca van a tener mapeo; reintentarlos dejaría el checkpoint atorado ~7 min y llenaría el DEAD_LETTER. Lo que se hizo: se reintenta solo si puede ser nuestro (ID en el rango pre-asignado `1B+id`, o el agente tiene pedidos reclamados sin ACK en los últimos 10 min) y solo para cobro/cancelación. **[VERIFICAR]** si `GRABAR_PEDIDOS` respeta el ID pre-asignado: el código cubre las dos posibilidades. |
| H3 | **Alta** | `marcarComoPagado` actualiza con `estado: { not: PAGADO }`, no con el estado leído. Si el pedido se cancela entre la lectura y el `updateMany`, **`CANCELADO` → `PAGADO`**. El comentario dice que conserva `estado: estadoAnterior`; el código no. | `admin.service.ts:176` | Resucitar un pedido terminal con dinero de por medio. Probabilidad baja, impacto alto. | **HECHO (Fase 0).** El estado se lee dentro de la transacción y es la guarda de la escritura; spec contra Postgres que simula la cancelación en medio. |
| H4 | **Media** | `PedidoPagoHandler` ignora los demás cambios que el trigger sí reporta: **`TTOTAL`**, `NOTAS`, `IDFACTURA`, y las **reversas** (`FINALIZADA` true→false, `SWCANCEL` true→false). | `firebird/02_sync_fixes_prefijo_folio.sql:152-166` vs `pedido-pago.handler.ts:59-97` | Si la tienda cambia el total en VFP *después* de dar instrucciones, el cliente transfirió un monto que ya no es el correcto. Si reversan un cobro, la nube sigue en `PAGADO`. | **HECHO (alerta mínima).** `ALERTA_TOTAL` y `ALERTA_REVERSA` en el log y en el mensaje del evento; no corrige nada. El bloqueo de aprobación (D9) llega con la feature. |
| H5 | **Media** | Dos cajeros pueden "tomar" el mismo pedido: se lee `cajeroAsignadoId` y luego se hace `update` sin guarda. `llamarSiguiente` hace `findFirst` + tomar (no atómico). | `cajero.service.ts:95-126, 261-277` | Con transferencias aparece una causa nueva de duplicidad ("¿ya lo cobraste?"). | **HECHO (Fase 0).** Guarda atómica en `tomar` (409 al perdedor) y `llamarSiguiente` reintenta con el siguiente de la fila; spec con dos cajeros reales. |
| H6 | **Media** | Monitor de cajero mide "activo" solo por `lastLogin` en 12 h. El de bodega usa `lastLogin OR ultimoHeartbeat`. | `cajero-monitor.service.ts:64-72` vs `bodega/monitor.service.ts:73` | Un cajero con turno largo desaparece del monitor; uno que se fue sigue "activo". | **HECHO (Fase 0).** `lastLogin` OR `ultimoHeartbeat`, con la misma ventana que bodega. |
| H7 | **Media** | `POST /admin/pedidos/:id/marcar-pagado` permite a **cualquier ADMIN** marcar pagado sin motivo ni verificación. | `admin.controller.ts:72-84` | Es un bypass del control nuevo. | **PARCIAL (Fase 0):** DTO validado, historial marca "MANUALMENTE por …" y log de aviso. Exigir motivo/`forzar` queda para la feature (la pantalla de admin dice "Referencia (opcional)" y hay que cambiarla a la vez). |
| H8 | **Baja** | `JwtStrategy` devuelve `rol` del **token**, no de la BD. Cambiar el rol de alguien no surte efecto hasta que expira el access token (1 h); `actualizar()` no revoca sesiones. | `jwt.strategy.ts:32-38` | Para un rol que toca dinero, un usuario degradado/desactivado debe perder acceso al instante (`activo` sí se revisa; el rol no). | **HECHO (Fase 0).** `JwtStrategy` toma el rol de la BD y rechaza `deletedAt`. No hizo falta revocar refresh tokens: `refreshToken()` ya lee al usuario de la BD. |
| H9 | **Baja** | Documentación desfasada: el `README.md` describe un flujo viejo con `POST /cajero/:id/verificar-pago` que **no existe**; comentarios de `cajero.controller.ts` y `Pedido.cajeroAsignadoId` dicen "solo KIOSKO"; mensajes de `admin.service` dicen `CANCELLED`/`PAID`. Hubo un modelo `ComprobantePago` que se eliminó en jun 2026 (`schema.prisma:1046`) con la nota *"no reintroducir sin evaluar"*. | varios | Quien lea el README creerá que ya hay verificación de transferencias. | Actualizar README y comentarios. La nota de `ComprobantePago` se atiende en D3. |
| H10 | **Media** | *(nuevo, hallado al arreglar H2/H3.)* El trigger dispara también al cambiar `NOTAS`, `SERIEFAC` o `IDFACTURA` y el agente sube la fila completa, **con `FINALIZADA = true` si ya estaba cobrado**. Solo `PAGADO` contaba como "ya cobrado": un pedido `ENVIADO` **retrocedía a `PAGADO`** (y reenviaba el correo "pago confirmado"), y uno `ENTREGADO` fallaba 5 veces hasta DEAD_LETTER. Además la rama idempotente devolvía `undefined` (200 sin cuerpo). | `pedido-pago.handler.ts`; `admin.service.ts` | Basta con que se edite `NOTAS` o se asigne/cambie `IDFACTURA`/`SERIEFAC` después del cobro. Qué tan seguido ocurre depende de cómo trabajan en VFP; el código no lo puede saber. | **HECHO (Fase 0).** `cobro.util.ts` (`PAGADO`/`ENVIADO`/`ENTREGADO` = ya cobrado) usado por el handler y por `marcarComoPagado`. |

**Lo que revisé del rol CAJERO actual y está bien:** el filtro por tienda sale del
JWT (no de un header), `liberar` valida que sea el asignado o ADMIN, el realtime se
emite después del commit, y la cola es FIFO por `fechaPedido`. Los hallazgos
anteriores (H5, H6) son lo que corregiría.

**No son bugs (los descarto para que no te distraigan):** el `WARN
confirmarDesdeMostrador is not a function` del log de tests es un mock incompleto en
`acciones-cola.spec.ts`; y las 2 migraciones "pendientes" de tu memoria ya están
aplicadas (`prisma migrate status` → *up to date*).

---

## 3. Decisiones de diseño

### D1 — Las instrucciones se emiten en `PENDIENTE_PAGO` **[CONFIRMADO 15-oct: no se puede pagar antes]**
Es el único momento en que el total es firme **y** el pedido ya existe en VFP (tiene
folio), que es lo que la tienda necesita para registrar el cobro. Además:
- Mostrador existe justo para que el cliente cambie cosas *antes* de pagar
  (`PLAN-MOSTRADOR-ANTES-DE-PAGO.md`). Pagar antes reabre el problema de reembolsar
  diferencias cuando bodega reporta faltantes.
- Un pago previo no podría registrarse en VFP: el pedido todavía no está allá
  (Invariante 1).
- "No se ajusta lo pagado" se vuelve gratis (§1).

*Alternativa descartada:* prepago al hacer el pedido. Obligaría a manejar
faltantes/diferencias con dinero ya recibido y a enviar el pedido a VFP antes de que
mostrador lo libere. Si el negocio lo exige, es un proyecto aparte.

### D2 — Preferencia en el checkout, compromiso en `PENDIENTE_PAGO` **[AJUSTADO en la Fase 1]**
El cliente puede *elegir* "pagaré por transferencia" al hacer el pedido (`Pedido.metodoPagoPreferido`,
nullable, **no vinculante**, siempre null en domicilio). El compromiso real es que exista un pago activo
(`PedidoPagoTransferencia`), y se puede cambiar según §9.

**Ya NO se emiten las instrucciones solas al llegar a `PENDIENTE_PAGO`** (el plan original lo preveía).
Obligaba a que `MostradorService` conociera el módulo de pagos, y el cliente ya está en la tienda en ese
momento: la preferencia solo preselecciona la opción y él ve sus datos con un toque. Si el negocio lo
quiere para domicilio, se agrega con esa feature (§18).

### D3 — Modelo propio, no reintroducir `ComprobantePago`
La nota del schema pedía evaluar antes de reintroducir. La evaluación: `ComprobantePago`
era 1:1 con el pedido y *reemplazaba* el cobro; aquí el cobro sigue siendo de VFP y
necesitamos otra cosa: verificación + comprobantes múltiples + bitácora + reembolsos.
Por eso es `PedidoPagoTransferencia` (nombre distinto a propósito).

### D4 — `EstadoPedido` no cambia
El estado del pago vive en su propia tabla. Agregar `PENDIENTE_VERIFICACION` al enum
rompería Invariante 2 (¿en el ERP o no?), `TRANSICIONES`, `escaneo.util`
(`Record<EstadoPedido,…>`), `estadoPedidoLabel`, el frontend y la regla "el estado no
se persiste en Firebird" que hoy hace seguros los renombres.

### D5 — La verificación no escribe `PAGADO`; la tienda registra en VFP
Tesorería *verifica* (`VERIFICADO`). La tienda *registra* en VFP. El `FINALIZADA` del
agente mueve el pago a `APLICADO`. Razones:
- VFP emite el ticket/factura y la forma de pago de un CFDI sale de ahí (transferencia
  = `03`). Si la nube pusiera `PAGADO` sola, VFP no se enteraría.
- Mantiene separadas las funciones (quien verifica ≠ quien registra) — control
  interno básico en dinero.
- Es literalmente el proceso de hoy, con el teléfono reemplazado por la consola.

*Mejora posterior (Fase 3):* que el agente registre el cobro en Firebird llamando un
SP del ERP. Elimina el paso manual y el riesgo de olvido, pero depende de que
VFP/ERP lo expongan **[VERIFICAR]**.

### D6 — El comprobante es ayuda; la fuente de verdad es el banco
Mucha gente paga y no sube nada, o sube una captura. Tesorería también puede
`VERIFICAR` un pago `PENDIENTE` buscándolo por referencia/monto cuando *ella* ve el
abono (que es su proceso actual). La imagen nunca es evidencia suficiente; la UI exige
marcar *"Confirmé el abono en el estado de cuenta"* antes de aprobar.

### D7 — El dinero recibido no se ignora
Cualquier estado con dinero (`VERIFICADO`, `APLICADO`) que termina en un pedido
`CANCELADO` genera `REEMBOLSO_PENDIENTE` automáticamente. Cualquier abono que llega
sin pedido vivo (tarde, duplicado, excedente) se registra y se reembolsa o se aplica.

### D8 — Un solo punto central para reaccionar a la cancelación
Cancelan el cliente, mostrador, las propuestas y el agente (`SWCANCEL`), y todos pasan
por `PedidoStateService.ejecutarCambio`. El enganche vive
ahí, **dentro de la transacción**, no en cada caller (la lección de F13: lo que depende
de que cada caller se acuerde, se rompe).

### D9 — Cambios de total en VFP: alertar, no corregir
Si llega `TTOTAL` distinto al `Pedido.total` mientras hay un pago activo, el pago pasa
a `requiereRevision` con el motivo, se avisa a Tesorería y se **bloquea aprobar**
hasta que alguien lo resuelva. No se reescribe `Pedido.total` desde VFP: eso es otra
discusión (hoy se ignora por diseño).

### D10 — Aprobación con guarda atómica
Todas las transiciones del pago usan `updateMany` con el estado esperado en el `where`
y verifican `count===1` (como `cambiarEstado`). Dos tesoreros no pueden aprobar el
mismo pago; el segundo recibe `ConflictException`.

---

## 4. Modelo de datos

> Una sola migración aditiva por fase. **Ninguna columna se quita ni se renombra**, así
> que el agente y Firebird no se enteran.

```prisma
enum RolUsuario { …existentes…  TESORERIA }

enum MetodoPago { EN_TIENDA TRANSFERENCIA }          // solo para Pedido.metodoPagoPreferido

enum EstadoPagoTransferencia {
  PENDIENTE            // instrucciones emitidas, esperando la transferencia
  EN_REVISION          // hay un comprobante por revisar
  VERIFICADO           // Tesorería vio el abono en el banco
  APLICADO             // VFP registró el cobro (pedido PAGADO)
  CANCELADO            // se cambió a pago en tienda / el pedido murió — SIN dinero
  VENCIDO              // caducaron las instrucciones — sin dinero
  REEMBOLSO_PENDIENTE  // hubo dinero y hay que devolverlo
  REEMBOLSADO
}

enum EstadoComprobante { PENDIENTE ACEPTADO RECHAZADO }

model CuentaBancaria {                // la administra ADMIN; ver D11
  id         Int      @id @default(autoincrement())
  tiendaId   Int?     // null = cuenta global
  banco      String   @db.VarChar(60)
  titular    String   @db.VarChar(120)
  clabe      String   @db.VarChar(18)   // 18 dígitos, validada con dígito verificador
  cuenta     String?  @db.VarChar(20)
  instrucciones String? @db.Text        // texto extra que el negocio quiera agregar
  activa     Boolean  @default(true)
  …timestamps, @@index([tiendaId, activa])
}

model PedidoPagoTransferencia {
  id               Int      @id @default(autoincrement())
  pedidoId         Int      @map("pedido_id")                // N por pedido en el tiempo, 1 ACTIVO
  estado           EstadoPagoTransferencia @default(PENDIENTE)

  // Snapshot al emitir (si cambian la cuenta o el total, lo ya dicho al cliente no cambia)
  montoEsperado    Decimal  @db.Decimal(12,2)
  cuentaSnapshot   Json                                      // banco, titular, clabe, cuenta
  referencia       String   @db.VarChar(7)                   // numérica, única, para el campo "referencia"
  concepto         String   @db.VarChar(30)                  // ej. "PD2026000123"
  venceAt          DateTime

  // Resultado de la verificación
  montoVerificado  Decimal? @db.Decimal(12,2)
  abonoFecha       DateTime?
  claveRastreo     String?  @db.VarChar(40)                  // SPEI; normalizada MAYÚSCULAS
  verificadoPorId  Int?
  verificadoAt     DateTime?
  notaVerificacion String?  @db.Text

  // Cobro en VFP
  aplicadoAt       DateTime?

  // Reembolso
  reembolsoMonto   Decimal? @db.Decimal(12,2)
  reembolsoMotivo  String?  @db.Text
  reembolsoRef     String?  @db.VarChar(60)
  reembolsadoPorId Int?
  reembolsadoAt    DateTime?

  requiereRevision String?  @db.Text                         // D9: motivo si el total cambió en VFP
  intentos         Int      @default(0)
  createdAt, updatedAt
}
// Índices parciales en la migración SQL (Prisma no los declara; ya se hace en el repo):
//   UNIQUE (pedido_id)            WHERE estado IN ('PENDIENTE','EN_REVISION','VERIFICADO','REEMBOLSO_PENDIENTE')
//   UNIQUE (clave_rastreo)        WHERE estado IN ('VERIFICADO','APLICADO')   -- el mismo SPEI no paga dos pedidos
//   UNIQUE (referencia)           (global)
//   INDEX  (estado, venceAt), INDEX (pedido_id)

model PagoComprobante {
  id, pagoId (FK cascade), subidoPorId
  archivoKey   String   // key de almacenamiento PRIVADO
  mime         String   // detectado por firma, no el que declara el cliente
  bytes        Int
  sha256       String   @db.VarChar(64)                      // detecta el mismo archivo en otro pedido
  estado       EstadoComprobante @default(PENDIENTE)
  // Lo que declara el cliente (ayuda para buscar en el banco; nunca se confía en ello)
  montoDeclarado Decimal?, fechaDeclarada DateTime?, bancoEmisor String?, claveRastreoDeclarada String?
  motivoRechazo String?, revisadoPorId Int?, revisadoAt DateTime?
  createdAt
}

model PagoTransferenciaEvento {       // append-only; nunca UPDATE/DELETE
  id, pagoId, tipo String, deEstado?, aEstado?, actorId?, actorRol?, actorNombre?,
  ip String?, detalle Json?, createdAt
}

// Pedido: UNA columna nueva, nullable, informativa.
//   metodoPagoPreferido MetodoPago?
```

Notas de diseño:
- **Referencia numérica de 7 dígitos**: es el límite del campo "referencia" del SPEI.
  El concepto va aparte (alfanumérico, sin guiones: varios bancos los rechazan).
  Aleatoria y única (con reintento ante `P2002`), no el id del pedido.
- **Snapshot de cuenta**: permite cambiar la cuenta bancaria sin reescribir lo que ya
  se le dijo a clientes con pagos abiertos, y saber a qué cuenta pidió pagar cada uno.
- **Ningún monto ni cuenta viaja del cliente**: el cliente solo elige el método y
  sube archivo. Mismo criterio que la calculadora de ajuste (el servidor decide el
  dinero).
- **Retención**: comprobantes y bitácora no se borran con el pedido
  (`onDelete: Restrict` hacia `Pedido` para estas tablas; hoy `eliminarPedidoCancelado`
  borra el pedido y arrastraría todo en cascada, así que habrá que hacer que rechace los
  pedidos que tengan pagos). Plazo a confirmar con contabilidad
  (en México normalmente 5 años) **[VERIFICAR]**.

### D11 — Cuentas bancarias como modelo, no como `ConfiguracionSitio`
`ConfiguracionSitio` es clave→valor sin validación ni auditoría. Los datos bancarios
son lo que un atacante querría cambiar para desviar pagos: necesitan validación de
CLABE (18 dígitos + dígito verificador, pesos 3-7-1), edición solo ADMIN, bitácora de
cambios, y confirmación de dos pasos al modificar **[SUPUESTO: opcional]**. Cuenta
global por defecto; por tienda si el negocio lo pide (`tiendaId`).

---

## 5. Máquina de estados del pago

```
              emitir instrucciones (PENDIENTE_PAGO)
                          │
                      PENDIENTE ───────────────┬──── cliente cambia a pago en tienda ──▶ CANCELADO
                          │ sube comprobante    │ vence sin dinero ──────────────────────▶ VENCIDO
                          ▼                     │                                           │ (abono tardío)
                     EN_REVISION ◀── nuevo ─────┘                                           ▼
                      │      │  comprobante                                          (Tesorería reabre)
        rechaza ──────┘      │ aprueba
   (vuelve a PENDIENTE,      ▼
    intentos+1)          VERIFICADO ──── VFP: FINALIZADA ───▶ APLICADO ◀── pedido PAGADO
                             │                                   │
                             └── pedido CANCELADO ───────────────┴──▶ REEMBOLSO_PENDIENTE ─▶ REEMBOLSADO
```

Reglas:
- **Solo hay dinero real desde `VERIFICADO`.** Antes de eso, cambiar de idea o cancelar
  es libre. Con `EN_REVISION` ya hay una señal de que el cliente transfirió: se trata
  como *posible dinero* (ver escenario 2).
- `VERIFICADO → EN_REVISION` ("revertir verificación", p.ej. SPEI devuelto) solo si
  aún no está `APLICADO`. Después de `APLICADO` es un incidente de ADMIN.
- `VENCIDO → VERIFICADO` permitido (abono tardío) con nota obligatoria.
- Transiciones inválidas → `BadRequestException`; carreras → `ConflictException`.
- Cada transición escribe un `PagoTransferenciaEvento` en la **misma** transacción.
- Efectos externos (realtime, correo) **después** del commit — la regla de siempre.

---

## 6. Roles y permisos

### 6.1 Quién hace qué

| Acción | CLIENTE | TESORERIA | CAJERO | MOSTRADOR | ADMIN |
|---|:-:|:-:|:-:|:-:|:-:|
| Elegir método / ver instrucciones de **su** pedido | ✔ | — | — | — | — |
| Subir comprobante / avisar "ya pagué" | ✔ (suyo) | — | — | — | — |
| Cambiar a pago en tienda (sin dinero) | ✔ | ✔ | ✔ | ✔ | ✔ |
| Ver cola global, detalle, teléfono, correo | — | ✔ | — | — | ✔ |
| Copiar / reenviar instrucciones | — | ✔ | — | — | ✔ |
| **Aprobar / rechazar** comprobante | — | ✔ | — | — | ✔ (auditado) |
| Registrar reembolso | — | ✔ | — | — | ✔ |
| Ver estado del pago de un pedido de **su tienda** | — | — | ✔ | ✔ | ✔ |
| Ver badge y filtro "Transferencia verificada" en la cola de caja de su tienda | — | — | ✔ | — | ✔ |
| Administrar cuentas bancarias | — | — | — | — | ✔ |
| Marcar `PAGADO` a mano | — | **no** | **no** | **no** | solo con `forzar`+motivo |

Tesorería **no** cambia el `EstadoPedido`, **no** marca pagado y **no** ve pedidos
ajenos al flujo de transferencia. Sus endpoints devuelven un DTO propio (folio, tienda,
cliente, total, resumen de items, pago); **no** reutilizan `obtenerDetalle`, que
incluye el chat y el historial completo.

### 6.2 Rol sin tienda
`TESORERIA` tiene `tiendaId = null`. Consecuencias que hay que manejar de forma explícita:
- `CrearUsuarioDto.tiendaId` hoy es obligatorio → hacerlo condicional (no requerido
  para `TESORERIA`, y `ADMIN` ya pasa sin validar tienda).
- `PedidoAccessService.validar` lanza 403 a quien no tiene tienda: **es el default
  correcto** (deniega en todos los endpoints de otras consolas). Los endpoints de
  Tesorería no usan ese servicio; usan su propia verificación por pago.
- Realtime: hoy un usuario sin `tiendaId` solo entra a `user-{id}`. Agregar room
  `tesoreria` (join si `rol ∈ {TESORERIA, ADMIN}`) y `RealtimeService.emitToTesoreria`.
- Los correos y las pantallas no deben asumir `user.tiendaId`.

### 6.3 Checklist de "rol nuevo" + spec de contrato
Cada vez que se agregó un rol faltó algo (`MOSTRADOR_MONITOR` no estaba en el DTO ni
en `logout`/`me`; `VENTAS` no estaba en búsqueda por folio). Para `TESORERIA`:

- [ ] `schema.prisma` + migración (`ALTER TYPE … ADD VALUE`, mismo patrón que
      `20260924000000_tipo_notificacion_listo_tienda`).
- [ ] `usuarios.dto.ts` → `ROLES_EMPLEADO`; `tiendaId` condicional.
- [ ] `auth.controller.ts` → `logout`, `me`, `update-profile`, `change-password`,
      `heartbeat` (5 listas).
- [ ] `JwtStrategy`/`realtime.gateway.ts` → room.
- [ ] `propuesta.service.ts:85` (mapa por rol) y `messages` — decidir explícitamente
      (Tesorería **no** entra al chat).
- [ ] `seed` (usuario de prueba) y `README`.
- [ ] Frontend: `constants/paths.ts` (matriz de acceso), `RolShell`, redirección post-login.
- [ ] **Spec de contrato** (nuevo): enumera `Object.values(RolUsuario)` y falla si algún
      rol no está declarado en cada lista de arriba **o** no figura en una tabla
      `ROLES_SIN_ACCESO_A_PEDIDOS_AJENOS`. Así el siguiente rol que alguien agregue no
      repite el patrón.

---

## 7. API (backend)

Prefijos nuevos; ninguno pisa rutas existentes.

**Cliente** (`@Roles(CLIENTE)`, dueño del pedido)
- `GET  /cliente/pedidos/:id/pago` → estado del pago + instrucciones (siempre disponibles, aunque el correo no llegue).
- `POST /cliente/pedidos/:id/pago/transferencia` → emite instrucciones (idempotente: si ya hay activo, lo devuelve).
- `POST /cliente/pedidos/:id/pago/comprobantes` → `multipart`, 1 archivo + campos declarados opcionales. Throttle propio.
- `POST /cliente/pedidos/:id/pago/cambiar-a-tienda` → solo si el pago está `PENDIENTE` (sin comprobante).
- `PATCH /cliente/pedidos/:id/metodo-pago-preferido` y campo opcional en `CreatePedidoDto`.

**Tesorería** (`@Roles(TESORERIA, ADMIN)`)
- `GET  /tesoreria/pagos?estado=&tiendaId=&q=&pagina=` — `q` busca folio web, folio VFP, referencia, nombre, correo, teléfono, monto, clave de rastreo.
- `GET  /tesoreria/pagos/:id` — detalle + comprobantes + bitácora.
- `GET  /tesoreria/pagos/:id/instrucciones` → `{ texto, html }` — **una sola función** genera el texto del correo, de la pantalla y del botón "Copiar" (`instrucciones-transferencia.util.ts`). Evita que difieran.
- `POST /tesoreria/pagos/:id/reenviar-instrucciones` — `{ email? }` (correo alterno opcional, auditado, throttle).
- `GET  /tesoreria/pagos/comprobantes/:cid/archivo` — **stream autorizado** (§10), registra la vista.
- `POST /tesoreria/pagos/:id/aprobar` — `{ montoRecibido, abonoFecha, claveRastreo?, nota?, confirmoEnBanco: true }`.
- `POST /tesoreria/pagos/:id/rechazar` — `{ comprobanteId?, motivo (catálogo), nota }`.
- `POST /tesoreria/pagos/:id/revertir-verificacion`, `/reabrir`, `/registrar-reembolso`.

**Tienda** (`@Roles(CAJERO, MOSTRADOR, ADMIN)`, tienda del JWT)
- `GET /cajero/pedidos/cola-ventanilla?pago=verificado|en-proceso` — filtro nuevo sobre la cola existente (que ya excluye domicilio).
- Los endpoints existentes de cola/monitor/mis-pedidos devuelven además `pagoTransferencia: { estado, referencia, total, verificadoAt } | null` para los badges, junto con el folio VFP para que el cajero encuentre el pedido en VFP.

**Admin**
- CRUD `admin/cuentas-bancarias` (validación de CLABE) y `GET admin/pagos/conciliacion?desde=&hasta=` (CSV).

Validación: DTOs con class-validator en todo body, `forbidNonWhitelisted` ya activo
(un monto en el body del cliente da 400 — mismo contrato que `IntencionAjusteDto`).

---

## 8. Integración con Firebird / agente

**Lo que NO cambia (es la garantía de "no romper nada"):**
- `PedidoPendienteEnvio`, `encolarEnvioAFirebird`, lease/ACK/RETRY.
- Payload de `poll-pedidos` y los SP `GRABAR_PEDIDOS` / `GRABAR_MOVPED`.
- Triggers `TRG_*_SYNC`, `BANDEJA_SYNC`, checkpoints, el agente (`agent/`).
- `ExternalRef`.
- Un spec de regresión fija la **forma** del payload de `poll()` para que ningún
  cambio futuro lo altere sin enterarse.

**Los únicos puntos de contacto** (todos con el mismo contrato: *si el módulo de pagos
falla, el flujo de pago existente sigue funcionando*; se ejecutan en `try/catch` con log
y el barrido de conciliación §12 corrige lo que se haya quedado a medias):

| Punto | Qué hace |
|---|---|
| `PedidoPagoHandler` tras `marcarComoPagado` | pago `VERIFICADO`→`APLICADO`; si estaba `PENDIENTE/EN_REVISION` → `CANCELADO` ("pagó en tienda") + alerta a Tesorería si había comprobante. Idempotente (el evento puede repetirse). |
| `PedidoPagoHandler` ante `TTOTAL` distinto | marca `requiereRevision` (D9). |
| `PedidoStateService.ejecutarCambio` → `CANCELADO` | dentro de la tx: pago sin dinero → `CANCELADO`; con dinero → `REEMBOLSO_PENDIENTE`. Sin inyectar servicios (función pura con `tx`) para no crear ciclos de DI. |
| `AdminService.marcarComoPagado` | gate de H7 + hook a `APLICADO`. |
| `ClienteService.cancelarPedido` | bloquea si hay comprobante en revisión o dinero verificado (§9, esc. 7). |

**Forma de pago en VFP — decisión del dueño (15-oct): se maneja a mano por ahora.**

La nube solo se entera de que el pedido se cobró (`FINALIZADA=true`), no de *cómo*. Por
eso no puede detectar por sí sola "Tesorería verificó una transferencia, pero la tienda
lo registró como efectivo". Mientras no se lea la forma de pago de VFP:
- El cruce es **humano**: el reporte diario de conciliación (Fase 2) lista cada pago
  `VERIFICADO/APLICADO` con folio VFP, monto, referencia y fecha, para compararlo contra el
  corte de caja de VFP.
- El cajero ve en pantalla "Registrar en VFP como TRANSFERENCIA", con el folio VFP.
- La alerta de "verificado y sin registrar" (§12) cubre el olvido, que es el error más
  probable.

*Para automatizarlo más adelante* (Fase 3, sin urgencia): (a) leer la forma de pago que
VFP ya guarde — el agente hace `SELECT` de todas las columnas de `PEDIDOS`
(`up-processor.ts`), así que si el dato está ahí la nube ya lo recibe en `evento.datos`;
solo habría que leerlo y agregarlo al `IF` de `TRG_PEDIDOS_SYNC`; (b) que el agente
registre el cobro en Firebird con un procedimiento del ERP, como ya hace con
`GRABAR_PEDIDOS`.

---

## 9. Escenarios

**Los que me pediste**

| # | Escenario | Qué pasa | Cómo se implementa |
|---|---|---|---|
| 1 | Dijo transferencia, en tienda quiere pagar en efectivo/tarjeta — **sin** comprobante | Se permite. Cero dinero involucrado. | `cambiar-a-tienda`: `PENDIENTE→CANCELADO` (bitácora). El cajero cobra normal. |
| 2 | Idem pero **ya subió comprobante** (`EN_REVISION`) | **No se cobra todavía.** Puede haber dinero en camino. | Cajero ve `Transferencia en revisión — no cobrar`; `llamarSiguiente` la salta. Tesorería prioriza (flag "cliente en tienda"): si el abono llegó → se aplica o se reembolsa; si no → rechaza y se libera para cobrar en tienda. |
| 3 | Idem pero ya **`VERIFICADO`** | La transferencia **es** el pago. Cobrar otra vez = doble pago. | Cajero ve `Ya pagó por transferencia — registrar en VFP`. Si el cliente exige pagar en tienda: reembolso completo por Tesorería y solo entonces se libera. Nunca los dos. |
| 4 | Dijo pagar en tienda y ahora quiere transferencia | Se permite en `PENDIENTE_PAGO`. | Cliente: botón en su pedido. Mostrador/cajero: "Enviar datos de transferencia" a nombre del cliente. Si hay `cajeroAsignadoId`, se avisa a esa ventanilla (o se libera antes). |
| 5 | Ajustar el pedido ya pagado | **No existe.** Pedido nuevo. | Ya es estructural (§1). Agregar test que lo fije para `PENDIENTE_PAGO`, `PAGADO`, `ENVIADO`, `ENTREGADO` y mensaje claro en mostrador. |
| 6 | Pidió devolución/cambio ya pagado por transferencia | **Antes de salir de tienda**: se cancela en VFP (`SWCANCEL`) → `REEMBOLSO_PENDIENTE` → Tesorería devuelve. **Ya salió** (`ENVIADO`/`ENTREGADO`): política "sin devoluciones" — el sistema no ofrece ninguna acción. | D7/D8. Reembolso solo si el pedido no está `ENVIADO`/`ENTREGADO`; excepción manual de ADMIN con nota obligatoria. |
| 7 | El cliente cancela desde su cuenta | Sin dinero: ok. Con comprobante/dinero: bloqueado. | `cancelarPedido` consulta el pago: `PENDIENTE` se cancela solo; `EN_REVISION/VERIFICADO` → "Ya registramos tu transferencia. Contacta a Tesorería o a mostrador." |
| 8 | "No me llegó el correo / no tengo acceso" | Las instrucciones nunca dependen del correo. | Siempre en el detalle del pedido; Tesorería: **Copiar instrucciones** (texto listo para WhatsApp), ver **teléfono y correo** con copiar y link `tel:`/WhatsApp, **reenviar** a un correo alterno (auditado, con límite). |

**Los que faltaban**

| # | Escenario | Tratamiento |
|---|---|---|
| 9 | Monto menor/mayor al total | Fase 1: Tesorería **no aprueba**, rechaza con motivo `MONTO` y la nota dice cuánto llegó (el excedente/faltante se resuelve por reembolso). Fase 2: abonos múltiples y `excedente→reembolso`. |
| 10 | Concepto/referencia mal o ausente | La referencia es ayuda, no requisito (D6). Búsqueda por monto, fecha, cliente, clave de rastreo. |
| 11 | El mismo comprobante en dos pedidos | Índice único parcial por `claveRastreo` (aprobados) + `sha256` del archivo → advertencia al subir. |
| 12 | Comprobante editado/falso | La aprobación exige confirmar contra el estado de cuenta (D6). Fase 3: validar clave de rastreo con el CEP de Banxico. |
| 13 | Abono tardío (pago vencido o pedido ya cancelado) | `VENCIDO→VERIFICADO` con nota, o "registrar abono sin pedido vivo" → reembolso. |
| 14 | SPEI devuelto/reversado después de verificar | `revertir-verificacion` mientras no esté `APLICADO`; después, incidente de ADMIN. |
| 15 | La tienda cobra distinto a lo verificado (registró efectivo) | Reporte diario de conciliación (Fase 2) para cruzar contra el corte de caja de VFP a mano; detección automática solo si algún día se lee la forma de pago de VFP (§8). |
| 16 | Cambia el total en VFP tras dar instrucciones | D9: alerta y bloqueo de aprobación. |
| 17 | Dos tesoreros sobre el mismo pago | D10: guarda atómica + `ConflictException`. |
| 18 | VFP/agente caído | El pago queda `VERIFICADO` esperando; el `FINALIZADA` posterior se procesa idempotente. Sin pérdida (con H2 corregido). |
| 19 | Pedido a domicilio | **Fuera de alcance**: la transferencia se rechaza para `DOMICILIO` (§18). Nada cambia respecto a hoy. |
| 20 | Cliente de kiosko | Sin cambios en el kiosko en Fase 1: si quiere transferir, ve las instrucciones en su teléfono/correo. |
| 21 | Doble clic / reintentos | Emitir y aprobar son idempotentes; subir comprobante lleva `Idempotency-Key`. |
| 22 | El cliente pide factura | La forma de pago del CFDI sale de VFP: por eso el registro lo hace la tienda con el método correcto (D5). |
| 23 | Privacidad | Comprobantes con datos bancarios: acceso solo Tesorería/ADMIN, cada vista queda en bitácora, nunca en logs ni en correos. |
| 24 | Un pedido en `PENDIENTE_PAGO` sin pagar para siempre | `venceAt` de las instrucciones + lista "Transferencias vencidas" para que la tienda decida (cancelar en VFP, que es el flujo vigente). No se cancela solo. |

---

## 10. Comprobantes: almacenamiento y seguridad

- **No usar `StorageService.subirImagen`** (es de bucket público). Servicio propio,
  `ComprobanteStorageService`, **con el mismo S3 que ya usan las imágenes de producto**: prefijo
  `comprobantes/` del mismo bucket (o `AWS_S3_COMPROBANTES_BUCKET` si algún día hay uno aparte).
  **Falla cerrado**: antes de guardar el primer comprobante sube un archivo de prueba, intenta leerlo
  SIN credenciales (por la URL directa de S3 y por el CDN/dominio de las imágenes) y lo borra; si
  responde 200 el prefijo es público y **no guarda nada** (503 + motivo en el log). Requiere en la
  política IAM de la app `s3:PutObject/GetObject/DeleteObject` sobre `comprobantes/*` (hoy solo cubre
  `productos/*` y `tmp/*`) y que la política del bucket no dé lectura pública a `comprobantes/*`.
- **Servir por API, no por URL**: `GET …/archivo` valida rol y pertenencia, hace stream
  con `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` y
  `Content-Disposition: inline`, y registra la vista. Evita la dependencia de presigned
  URLs (no está el SDK) y deja auditoría.
- **Dev sin S3**: guardar fuera de `uploads/` (hoy se sirve en `/files/` público).
- **Validación por firma binaria** (extender `validar-imagen.util.ts`): JPEG, PNG, WEBP
  **y PDF** (`%PDF-`) — las apps bancarias exportan PDF. Tope 8 MB. Máximo N archivos por
  pago. HEIC no se acepta; el input del frontend usa `accept="image/jpeg,image/png,application/pdf"`.
- Guardar `sha256` (duplicados) y el mime **detectado**, no el declarado.
- IAM: la política actual solo cubre `productos/*` y `tmp/*` (`storage.service.ts`);
  hay que agregar el recurso nuevo.
- Retención: ver §4.

---

## 11. Notificaciones y textos

Nuevos `TipoNotificacion` (`ALTER TYPE … ADD VALUE`): `TRANSFERENCIA_INSTRUCCIONES`,
`TRANSFERENCIA_COMPROBANTE_RECIBIDO`, `TRANSFERENCIA_VERIFICADA`,
`TRANSFERENCIA_RECHAZADA`, `TRANSFERENCIA_POR_VENCER`, `TRANSFERENCIA_REEMBOLSADA`.

- Plantillas React Email con el patrón existente (`PedidoEmailShell`).
- **Cuidado con duplicados** (lección documentada en `CLAUDE.md` con `PROPUESTA_VENTAS`):
  el correo "listo para pagar" (`enviarListoParaPagar`, disparado en el ACK) **ya existe**.
  No mandar instrucciones de transferencia *además* sin decidir cuál lleva qué: propuesta
  → el de "listo para pagar" agrega un bloque "También puedes pagar por transferencia"
  con link al pedido; el de instrucciones solo sale cuando el cliente (o su preferencia)
  emite la transferencia.
- **Textos congruentes con el flujo** (regla vigente): "mostrador", no "barra"; "área de
  entrega"; los correos dicen *qué sigue* — p.ej. tras `VERIFICADO`: "Recibimos tu
  transferencia. En cuanto la tienda registre el pago podrás recoger tu pedido", **no**
  "pagado", porque no lo está hasta VFP.
- Tesorería recibe un aviso interno por comprobante nuevo (realtime + contador), no
  correo.

---

## 12. Realtime y barridos

**Eventos** (nombres sueltos: revisar en el frontend, un typo falla en silencio):
`pago.instrucciones`, `pago.comprobante`, `pago.verificado`, `pago.rechazado`,
`pago.aplicado`, `pago.reembolso`, `pago.requiere-revision`. Destinos: `pedido-{id}`
(cliente), `tienda-{id}` (cajero/mostrador) y el room nuevo `tesoreria`.

**Worker de conciliación** (mismo patrón que `sin-recoger.worker.ts`: `setInterval`,
sin cron externo; idempotente porque puede haber más de una instancia):
1. `PENDIENTE` con `venceAt` pasado → `VENCIDO` + correo.
2. 24 h antes de vencer → recordatorio (una vez).
3. `VERIFICADO` sin `APLICADO` pasadas N horas → alerta a Tesorería y a la tienda
   ("registra el cobro en VFP").
4. Pedido `PAGADO` con pago activo no resuelto → corrige (red por si falló el hook).
5. Pedido `CANCELADO` con pago `VERIFICADO/APLICADO` sin `REEMBOLSO_PENDIENTE` → lo crea.

---

## 13. Frontend (`../demo-frontend`) — resumen

- **Cliente** (`(customer)/pedidos/[id]`): bloque "Cómo pagar" en `PENDIENTE_PAGO` con dos
  opciones; instrucciones con botón copiar (CLABE, referencia, concepto, monto exacto),
  estado del pago, subir comprobante, cambiar a pago en tienda. El stepper ya muestra
  "Pago"; el sub-estado va dentro del paso.
- **Tesorería** (grupo de rutas nuevo `(treasury)/tesoreria`): cola con filtros y contadores
  (`StatCard compact`, `FilterChips`, `Pagination`), detalle con visor de comprobante,
  panel de contacto (copiar teléfono/correo), `ConfirmDialog` en aprobar/rechazar. Usar los
  componentes de `components/common/` (regla del `CLAUDE.md` del frontend). Query keys en
  `qk.*`. Realtime con `usePollingRealtime` como respaldo.
- **Cajero**: badge del estado del pago en la cola y el monitor, filtro "Transferencia
  verificada", y en el detalle referencia + folio VFP + aviso "registrar en VFP como TRANSFERENCIA".
- **Mostrador**: badge del estado del pago en el detalle; "Enviar datos de transferencia".
- **Admin**: CRUD de cuentas bancarias; vista de conciliación.
- Actualizar `estadoDescripcion.ts`/`constants/paths.ts` y la tabla de roles del `CLAUDE.md`.

---

## 14. Preguntas abiertas

**Respondidas por el dueño (15-oct):**
1. ~~¿Se puede pagar antes de `PENDIENTE_PAGO`?~~ **No** (D1 confirmado).
2. ~~¿Cómo se cobra hoy un pedido a domicilio?~~ **Fuera de alcance**: se va a rediseñar
   el flujo de envíos. Pendientes documentados en §18.
3. ~~VFP: ¿dónde queda la forma de pago?~~ **No se sabe todavía; se maneja a mano** (§8).

**Abiertas (todas con supuesto; solo hay que corregirlas si no aplican):**

4. **¿Una o varias cuentas bancarias?** ¿Global o por tienda? *Supuesto: una global,
   con soporte por tienda.*
5. **Nombre del rol.** *Supuesto: `TESORERIA`* (hoy "cajero" ya significa ventanilla).
6. **Vigencia de las instrucciones.** *Supuesto: 48 h, recordatorio a las 24 h*
   (configurables por env).
7. **Reembolsos**: ¿los autoriza Tesorería sola o con visto bueno de ADMIN? ¿Hay tope?
   *Supuesto: Tesorería ejecuta; ADMIN aprueba excepciones.*
8. **Montos parciales/excedentes**: ¿Fase 1 (rechazar y resolver a mano) o desde el inicio?
   *Supuesto: Fase 2.*

---

## 15. Fases y orden

**Fase 0 — Línea base y arreglos previos** *(HECHA el 15-oct, sin commit)*
- ✔ H2, H3, H4 (alerta), H5, H6, H7 (parcial), H8, H9 y el nuevo H10. Detalle en §2.
- ✔ Specs nuevos: `pedido-pago.handler.spec` (22), `pedido-externo.util.spec`,
  `admin-marcar-pagado-postgres.spec` (12), `cajero-concurrencia-postgres.spec` (7),
  `cajero-monitor.service.spec` (+6), `jwt.strategy.spec`, `marcar-pagado.dto.spec`. Los dos
  `*-postgres` se probaron también contra el código VIEJO y **fallan** (6 de 12 y 3 de 7),
  así que sí detectan los bugs.
- ✔ Suite completa: **78 suites / 1101 tests** (antes 72 / 1046).
- ✔ Los dos pendientes menores también quedaron hechos: el comentario de `Pedido.cajeroAsignadoId` y el
  literal `1_000_000_000`, que ahora vive en una sola constante (`pedidos/core/id-pedido-externo.util.ts`).
- Pendiente de ti: hacer commit del trabajo del rediseño de propuestas. Los archivos de la
  Fase 0 **no se traslapan** con los tuyos, así que pueden ir en un commit aparte.

**Fase 1 — Núcleo de transferencia** *(BACKEND HECHO el 16-oct, sin commit; FRONTEND pendiente)*
- ✔ Esquema + migración `20261018120000_pagos_transferencia` (aditiva; índices parciales y CHECKs de dinero).
- ✔ Rol `TESORERIA` en las 5 listas de auth, DTO de usuarios (sin tienda), room `tesoreria`, seed y un
  **spec de contrato de roles** (`src/common/roles-contrato.spec.ts`) que además fija que ningún endpoint
  quede sin `@Roles`/`@Public`/`@ApiKeyAuth`. Ya destapó un hueco real: `CAJERO_MONITOR` no podía mandar heartbeat.
- ✔ `modules/pagos/`: cuentas bancarias (CLABE validada), instrucciones (un solo generador), comprobantes en
  almacenamiento privado, emitir / cambiar a tienda / subir comprobante, y Tesorería (cola, detalle, aprobar,
  rechazar, abono sin pedido, reembolso, resolver revisión, reenviar instrucciones, ver archivo).
- ✔ Enganches: cancelación en la máquina de estados (dentro de la transacción), cobro de VFP, bloqueo de la
  cancelación del cliente, cajero (badge, filtro `?pago=`, "Llamar siguiente" salta transferencias abiertas),
  `TTOTAL` cambiado en VFP bloquea la aprobación, `forzar` para el cobro manual de un ADMIN.
- ✔ Correos (una plantilla, 6 variantes) y realtime (`pago.estado` + `pago.alerta`).
- ✔ 48 tests nuevos del módulo (25+ contra Postgres: carreras, índices, ciclo completo) y suite total
  **83 suites / 1170 tests** en verde.
- ✔ **Frontend HECHO el 16-oct** (otro repo, sin commit): consola de Tesorería (`/tesoreria` con pestañas por grupo y
  `/tesoreria/[id]` con visor del comprobante y las acciones), bloque "¿Cómo quieres pagar?" del cliente, preferencia en
  el checkout, avisos y filtro en la cola de caja, tarjeta de transferencia en mostrador, cuentas bancarias del admin y
  alta de usuarios de Tesorería sin tienda. Verificado con Playwright contra el backend real (admin → cliente →
  Tesorería → cajero → mostrador). Al hacerlo salieron y se corrigieron en el backend: `acciones` en el detalle,
  `puedePedirDatos` (incluye "hay cuenta activa"), `puedeEnviarDatos` que se quedaba apagado tras un pago cancelado,
  `puedeCambiarATienda`, y un doble punto en la nota de vigencia.
- ⏳ Verificar la migración desde cero en una BD temporal (`prisma migrate reset` contra una BD desechable).
- Adelantado de la Fase 2: reembolsos, abono sin pedido (dinero que llega con el pedido ya cobrado o cancelado) y
  resolver revisión. Siguen en la Fase 2: abonos parciales/excedentes, vencimiento automático, worker de
  conciliación y reporte CSV.

**Fase 2 — Dinero complicado** *(PARCIAL, 16-oct, sin commit)*
- ✔ **Vencimiento MANUAL** (decisión del dueño: automático después): pestaña "Vencidas", cerrar una o todas, abono tardío
  con nota. `cerrarPorVencimiento` está listo para que un proceso periódico lo llame.
- ✔ **Verificadas atrasadas** (visibles al leer, sin proceso) y **reporte de conciliación** (JSON, CSV y pantalla
  `/tesoreria/conciliacion`; el admin llega desde su menú).
- ⏳ Pendiente: proceso periódico (vencer solo + recordatorio "por vencer" + alertas push), montos parciales/excedentes,
  y los correos de vencimiento (hoy cerrar por vencimiento no manda correo: se decide al automatizar).

**Fase 2 (plan original) — Dinero complicado** *(tamaño M)*
Reembolsos, abonos parciales/excedentes, abono tardío, `requiereRevision` completo,
worker de conciliación, reporte CSV.

**Fase 3 — Opcional** *(depende de otros)*
Registro automático en VFP por SP; importar estado de cuenta (CSV) para sugerir
coincidencias; validar CEP en Banxico; cuenta por tienda; métricas de tiempos de
verificación.

---

## 16. Pruebas

- **Contrato**: roles (§6.3); forma del payload de `poll()`; "ningún camino ajusta un
  pedido desde `PENDIENTE_PAGO` en adelante".
- **Postgres reales** (patrón `*-postgres.spec.ts`): aprobar concurrente (dos tesoreros),
  índices parciales (un pago activo por pedido; una `claveRastreo` no paga dos pedidos),
  hook de cancelación dentro de la transacción, `marcarComoPagado` contra cancelación
  concurrente (H3), `tomar` concurrente (H5).
- **Handler**: `FINALIZADA` duplicado, sin mapeo (H2), con pago en cada estado, y con el
  módulo de pagos **lanzando error** (el pago de VFP debe completarse igual).
- **Flujo completo** (`flujo-completo.spec.ts`): pedido → `PENDIENTE_PAGO` → transferencia
  → verificada → `FINALIZADA` → `PAGADO`/`APLICADO`, y las variantes de §9.
- **Seguridad**: cliente ajeno a un comprobante (404, no 403), TESORERIA contra endpoints
  de otras consolas (403), `forbidNonWhitelisted` con `monto` en el body, archivo con
  extensión falsa, PDF disfrazado.
- Criterio general: **la suite actual (1046) sigue verde sin tocar sus expectativas**.

---

## 17. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|
| Doble cobro (transferencia + efectivo) | Media | Alto | Bloqueos visibles en caja; `llamarSiguiente` salta pagos en revisión; reembolso obligatorio antes de cobrar en tienda |
| Se verifica y nadie lo registra en VFP | Media | Alto | Badge y filtro en caja + alerta del worker + reporte de conciliación (cruce manual con el corte de VFP) |
| Fraude por comprobante falso | Media | Alto | Verificar contra el banco, no la imagen; `claveRastreo` única; `sha256` |
| Fuga de datos bancarios del cliente | Baja | Alto | Almacenamiento privado, stream autorizado, bitácora de vistas, sin PII en logs/correos |
| Desviar pagos cambiando la cuenta | Baja | Muy alto | Solo ADMIN, CLABE validada, bitácora de cambios, snapshot por pago |
| Romper la sincronización | Baja | Muy alto | Cambios solo aditivos; ningún cambio en agente/triggers/payload; enganches aislados en `try/catch`; spec de forma del payload |
| Olvidar el rol en alguna lista | Alta (histórico) | Medio | Spec de contrato de roles |
| Mezclar esta migración con el trabajo sin commit | Media | Medio | Fase 0 |

---

## 18. Pendiente — envíos a domicilio (FUERA DE ALCANCE)

Decisión del dueño (15-oct): el flujo de envíos se va a rediseñar por completo, así que
esta feature **no** lo resuelve. Esto es lo que sí se hace ahora y lo que queda anotado
para cuando llegue esa feature.

### Qué se hace en esta feature (mínimo, para no abrir un hueco)

- Una sola función, `transferenciaDisponible(pedido)`, devuelve `false` si
  `modoEntrega === DOMICILIO`. La usan: emitir instrucciones, `metodoPagoPreferido` (se
  guarda `null` en domicilio) y el detalle del pedido, que expone el resultado como
  `puedePagarPorTransferencia` para que el frontend **no** repita la regla (la misma
  lección de `responsableDe`/`puedeOperar`).
- Intentar emitir una transferencia en un pedido a domicilio da `400`: *"El pago por
  transferencia todavía no está disponible para pedidos a domicilio."* Un test lo fija.
- Es un solo punto: cuando se rediseñen los envíos, se cambia esa función y listo.
- Nada más cambia en el flujo de domicilio. Hoy sigue como está.

### Por qué hay que bloquearlo y no solo ignorarlo

Un pedido a domicilio verificado por transferencia **nunca llegaría a `PAGADO`**: no
aparece en ninguna consola de caja (`cajero.service.ts:55,266`; `cajero-monitor.service.ts:79,129`
lo excluyen a propósito), así que nadie vería que falta registrarlo en VFP, y sin `PAGADO`
no puede pasar a `ENVIADO`. Es el hallazgo H1: el mismo tipo de "atascado para siempre"
que la Invariante 2 trata de evitar.

### Lo que habrá que decidir cuando se rediseñen los envíos

1. **¿Cómo se cobra un domicilio?** Hoy se salta mostrador (`EN_REVISION → PENDIENTE_PAGO`
   con encolado inmediato, sin cliente en tienda) y queda fuera de las colas de caja. No
   está definido en el código quién cobra ni dónde.
2. **Una consola donde el cajero vea los pagos verificados de domicilio** y los registre en
   VFP (la lista que el hallazgo H1 pide). Sin ella, activar la transferencia reabre el hueco.
3. **Emisión automática de instrucciones** al llegar a `PENDIENTE_PAGO` (D2 ya lo prevé con
   `metodoPagoPreferido`): el cliente a domicilio no está en tienda para pedirlas.
4. **Costo de envío.** Hoy el pedido guarda `subtotal`, `descuento`, `impuestos` y `total`,
   sin un monto de envío aparte. Si la feature de envíos lo agrega, el `montoEsperado` de la
   transferencia debe ser el total final **incluyendo** el envío, fijado antes de emitir.
5. **Automatizar el registro en VFP** (Fase 3, §8): en domicilio el cliente no está en el
   mostrador, así que el paso manual pesa más que en tienda.
6. **Corte de reembolsos.** La regla de §9 (escenario 6) ya usa `ENVIADO`/`ENTREGADO` como
   "salió de la tienda". Confirmar que el nuevo flujo de envíos conserve esos estados o
   ajustar el corte.
7. **Caducidad.** `PENDIENTE_PAGO` no caduca y en domicilio no hay mostrador que vea el
   pedido esperando; definir quién da seguimiento a una transferencia vencida.
8. **`ENVIADO` solo después de `PAGADO`** ya se cumple (`TRANSICIONES[PAGADO]`); conservarlo.
