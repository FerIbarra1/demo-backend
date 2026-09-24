# Plan definitivo: el pedido pasa por mostrador **antes** de pagar

> Cambio de flujo: hoy el pedido va `bodega → pago → mostrador`. Pasa a ir
> `bodega → mostrador → pago → entrega`.
>
> Motivo (dicho por el negocio): muchos clientes hacen el pedido y, cuando les
> muestran los productos, piden más cosas o quieren cambiar. Hoy ya pagaron y
> el cambio es un problema. Con el orden nuevo, el cliente ve, ajusta y **solo
> cuando está de acuerdo paga**.

---

## 1. Decisiones confirmadas

Estas son las respuestas del negocio a las preguntas de diseño. Todo el plan
se deriva de aquí.

| # | Decisión | Elección |
|---|----------|----------|
| D1 | Cómo modelar el paso por mostrador | **Estado nuevo `EN_MOSTRADOR`** (no una columna) |
| D2 | Qué puede hacer mostrador cuando el cliente quiere cambios | **Editar el pedido directo, tipo POS** |
| D3 | Cuándo entra el pedido al ERP (Firebird/VFP) | **Al liberar mostrador**, no al confirmar bodega |
| D4 | Quién cierra el pedido como entregado | **Mostrador, después del pago** |
| D5 | Qué pedidos web aparecen en el monitor de mostrador | **Solo los que ya avisaron llegada** |
| D6 | Los pedidos a domicilio | **Saltan mostrador** (bodega → pago → envío) |
| D7 | Faltantes de bodega | **En tienda se resuelve en mostrador; web sigue con propuesta async** |
| D8 | El monitor de mostrador | **TV de solo lectura + consola del operador** |
| D9 | El editor de productos | **Componente compartido entre ventas y mostrador** |
| D10 | Alcance | **Por fases**, empezando por el reordenamiento |
| D11 | Rol de la TV de mostrador | **`MOSTRADOR_MONITOR` dedicado** (rol nuevo) |
| D12 | Quién surte lo que mostrador agrega | **Vuelve a bodega a re-surtirse** |
| D13 | Relojes de urgencia | **SOLO en bodega.** Quitarlos de cajero y mostrador |
| D14 | Mostrador cancela un pedido ya liberado | **Sí, permitirlo** (se sincroniza por `SWCANCEL`) |
| D15 | UI de llegada del cliente web | **Sí, construirla** (botón en el detalle del pedido) |
| D16 | Aviso al cliente de que su pedido está listo | **El monitor ES el canal** (estilo banco, sin email) |
| D17 | Chat durante `EN_MOSTRADOR` | **Abierto** |
| D18 | Badge de reingreso a bodega | **Sí** — ver §3.7 |

### Por qué estado nuevo y no una columna

Descartamos reusar `PENDING_PAID` + una columna `mostradorLiberadoAt`. Con una
columna, **cada** query del cajero tiene que acordarse de filtrarla, y un solo
filtro olvidado manda a un cliente a pagar antes de que mostrador le haya
mostrado su pedido — exactamente el bug que hay que evitar. Con un estado
propio, un pedido que no fue liberado es estructuralmente invisible para el
pago.

El costo es que hay que tocar todos los lugares que enumeran estados. Eso es
**una ventaja**, no un problema: TypeScript rompe la compilación en cada
`Record<EstadoPedido, …>` hasta que se actualice, así que el compilador
encuentra los sitios por nosotros. La lista completa está en §4.2.

---

## 2. Estado de partida (verificado, no asumido)

Todo lo de esta sección lo verifiqué leyendo el código, con archivo y línea.

### 2.1 La máquina de estados

`src/modules/pedidos/core/pedido-state.service.ts:46-83` — tabla `TRANSICIONES`,
fuente única de verdad. Estados actuales: `PENDING_REVIEW`, `REVIEWING`,
`WAITING_CUSTOMER_APPROVAL`, `EN_ASESORIA`, `PENDING_PAID`, `PAID`, `SHIPPED`,
`COMPLETED`, `CANCELLED`.

`cambiarEstado` (línea 175) valida la transición, escribe historial, emite
realtime y notifica. Recibe `CambiarEstadoOpts` (línea 95) con `asignacion`,
`reloj`, `encolarFirebird`, `efectos` e `invalidarMonitor`. **Es el único punto
por el que deben pasar las transiciones nuevas.**

### 2.2 El momento de Firebird — el hallazgo central

`encolarFirebird: true` aparece exactamente tres veces:

| Archivo | Línea | Cuándo |
|---------|-------|--------|
| `bodega/surtido.service.ts` | 329 | bodega confirma surtido → `PENDING_PAID` |
| `propuesta/propuesta.service.ts` | 319 | cliente aprueba propuesta de **bodega** → `PENDING_PAID` |
| `propuesta/propuesta.service.ts` | 424 | cliente aprueba propuesta de **ventas** sin items pendientes → `PENDING_PAID` |

`PedidoStateService.encolarEnvioAFirebird` (línea 364) inserta la fila en
`PedidoPendienteEnvio` con `externalIdPEDIDOS = 1B + pedidoId`. El agente la
baja por `poll-pedidos` (cada 5 s, `sync-agent.service.ts:60`),
`GRABAR_PEDIDOS` genera el folio local en VFP y el ACK lo guarda en
`externalFolio`.

**Consecuencia:** hoy, en el instante en que bodega cierra el surtido, el
pedido ya existe en el ERP con su folio. Si mostrador después lo ajusta o lo
cancela, hay que construir sincronización de ajustes y cancelaciones hacia
Firebird — y el propio handler documenta que **los ajustes de items ya NO se
sincronizan** (`sync/handlers/pedido-pago.handler.ts:24`).

Por eso D3: mover el encolado a la liberación de mostrador. El ERP solo ve
pedidos que el cliente ya confirmó.

### 2.3 El monitor de cajero está cableado a KIOSKO

`cajero/cajero-monitor.service.ts:76` y `:124` filtran
`canalOrigen: CanalOrigen.KIOSKO` **hardcodeado**. Y
`cajero/cajero.service.ts:86-88` rechaza explícitamente los pedidos web:

```ts
if (pedido.canalOrigen !== CanalOrigen.KIOSKO) {
  throw new BadRequestException('Sólo pedidos del kiosko entran al monitor de ventanillas');
}
```

Hoy los pedidos web **nunca** llegan a pago. Con el flujo nuevo sí llegan (el
cliente avisó llegada, mostrador lo liberó), así que este candado tiene que
caer.

### 2.4 Mostrador hoy solo ve pedidos ya pagados

`mostrador/mostrador.service.ts:53` y `:107` filtran
`estado: { in: [PAID, SHIPPED] }`. La transición que dispara es
`PAID|SHIPPED → COMPLETED` (`entregar`, línea 150). **El "pedido retenido" que
describe el negocio no existe en el modelo** — es puramente operativo, y es lo
que este plan formaliza.

### 2.5 No existe monitor de mostrador

Hay dos TV (`/bodega-monitor`, `/cajero-monitor`), cada una con su rol
(`BODEGA_MONITOR`, `CAJERO_MONITOR`) y su service. `/mostrador` es la consola
del operador, no una TV. Falta la tercera.

### 2.6 La reposición ya existe

`reposicion/reposicion.service.ts:40` — `crearDesdePedido(tx, pedidoId, motivo)`
crea la entrada 1:1 con el pedido (`PedidoReposicion`, `schema.prisma:1132`),
con snapshot JSON de los items. `confirmarRepuesto` (línea 122) la cierra
cuando bodega devuelve la mercancía al anaquel. **Se llama dentro de la
transacción de cancelación** y es idempotente. Se reusa tal cual para la
cancelación desde mostrador.

### 2.7 El aviso de llegada ya existe

`kiosko/kiosko-llegada.service.ts` — columnas `llegada*` en `Pedido`
(`schema.prisma`, bloque PR7), canales `QR | FOLIO | WEB | MOSTRADOR`, canje
por folio o QR firmado con HMAC, idempotencia 60 s, anti-spam 5 avisos, evento
realtime `pedido.llegada-anunciada` a `tienda-{id}` y `pedido-{id}`.

**La llegada es ortogonal al estado** — el propio servicio lo documenta
(línea 46). Eso es exactamente lo que necesita el gate de D5: el pedido está en
`EN_MOSTRADOR` y aparece en la cola solo cuando llega el aviso.

### 2.8 El editor de productos de ventas ya existe y es casi reutilizable

`components/ventas/PropuestaSheet.tsx` (435 líneas) tiene ya el patrón
completo: `quitados: Set`, `cantidades: Map`, `agregados: []`, nota,
`hayCambios`, total recalculado, y una `FilaItemEditor` (línea 320) con imagen,
código, variante, stepper y disponibilidad.

`components/ventas/BuscarProductoModal.tsx` (451 líneas) ya es un componente
genérico con dos modos (`agregar` / `sustitucion`), búsqueda por nombre o
código, split lista/variantes, stepper grande y subtotal en vivo.

**Ninguno de los dos está acoplado a ventas más que por la carpeta.** Extraerlos
es mover archivos y parametrizar el shell.

### 2.9 Los precios ya se congelan al crear el pedido

`ItemPedido.precioUnitario` es snapshot (`schema.prisma:637`) y
`cliente.service.ts:189` lo copia de `pco.precio`. La lista de precios por
usuario (`lista1..lista6`, `schema.prisma:442`) se resuelve en el catálogo
(`catalogo.service.ts:15`), no en el pedido. El editor de mostrador debe
respetar esto: al agregar un producto, congela el precio de la lista que
corresponde al cliente.

### 2.10 Lo que NO hay que tocar

- **Domicilio.** `modoEntrega = DOMICILIO` va `bodega → pago → envío`. No entra
  a mostrador (D6). Su camino actual queda intacto.
- **`PAID → SHIPPED → COMPLETED`.** La máquina ya lo soporta y
  `marcarEnviado` valida `shippingDireccion`. Sin cambios.
- **`marcarComoPagado`.** Su gate (`admin.service.ts:131-150`) exige
  `PENDING_PAID`, o cualquier estado no terminal para el agente **si el pedido
  ya fue encolado**. Con D3 el pedido está en `PENDING_PAID` cuando el agente
  reporta el cobro, así que el gate sigue siendo correcto sin tocarlo.
- **La reposición.** Se reusa, no se reescribe.
- **El aviso de llegada.** Se reusa, no se reescribe.

### 2.11 BUG VIVO: el pedido se crea con la lista de precios equivocada

**Esto no lo causa el cambio de flujo — ya está roto hoy.** Lo encontré
verificando el punto 3 de las decisiones, y es lo más grave del documento porque
toca dinero.

El catálogo sí respeta la lista de precios del cliente:
`catalogo.service.ts:297` (`obtenerColumnaLista`) resuelve la lista por tienda
(`UsuarioTienda.listaPrecioCodigo`) con fallback a la del usuario
(`Usuario.listaPrecioCodigo`), y `resolverColumnaLista` (línea 13) mapea `'2'` →
`lista2`, etc. El cliente ve el precio correcto en pantalla.

Pero **al crear el pedido, ese precio se tira a la basura**:

```ts
// cliente.service.ts:189
precioUnitario: pco.precio,   // ← pco.precio es SIEMPRE lista1
```

`pco.precio` es la columna `precio` de `PrecioCO` (`schema.prisma:437`), que el
propio schema documenta como **sinónimo de `lista1`** (línea 441). El mismo bug
está en el otro sitio que agrega productos:

```ts
// propuesta.service.ts:774 — cuando ventas agrega un producto a la propuesta
precioUnitario: pco.precio,   // ← mismo bug
```

**Impacto:** un cliente con `listaPrecioCodigo = '3'` ve el precio de `lista3` en
el catálogo, pero su pedido se persiste con el precio de `lista1`. Se le cobra
una lista que no es la suya. Y como `ItemPedido.precioUnitario` es snapshot
(§2.9), el error queda congelado en el pedido y viaja así al ERP.

**Verificado:** `cliente.service.ts` no menciona `listaPrecio` en ninguna parte
(grep vacío). Los únicos consumidores de `obtenerColumnaLista` son las tres
lecturas del catálogo.

**Por qué importa para este plan:** el editor POS de mostrador (Fase 4) agrega
productos. Si se construye copiando el patrón actual, **hereda el bug**. Hay que
extraer un helper compartido y usarlo en los tres sitios.

---

## 3. Arquitectura objetivo

### 3.1 El estado nuevo

```prisma
enum EstadoPedido {
  PENDING_REVIEW
  REVIEWING
  WAITING_CUSTOMER_APPROVAL
  EN_ASESORIA
  EN_MOSTRADOR            // ← NUEVO: listo, esperando que mostrador lo muestre y lo libere
  PENDING_PAID
  PAID
  SHIPPED
  COMPLETED
  CANCELLED
}
```

`EN_MOSTRADOR` significa: **bodega ya verificó físicamente los productos y el
pedido está apartado, esperando que el cliente lo revise en tienda.** Es el
"pedido retenido" del negocio, ahora explícito en el modelo.

### 3.2 La máquina de estados nueva

```
PENDING_REVIEW ──▶ REVIEWING ──▶ EN_MOSTRADOR ──▶ PENDING_PAID ──▶ PAID ──▶ COMPLETED
       │               │  │            │                              │
       │               │  │            ├──▶ REVIEWING (ajustar)       └──▶ SHIPPED ──▶ COMPLETED
       │               │  │            └──▶ CANCELLED (cancelar)
       │               │  │
       │               │  └──▶ PENDING_PAID   (solo DOMICILIO)
       │               │
       │               └──▶ WAITING_CUSTOMER_APPROVAL ──▶ EN_MOSTRADOR
       │                                  │
       │                                  ├──▶ REVIEWING
       │                                  ├──▶ EN_ASESORIA ──▶ EN_MOSTRADOR
       │                                  └──▶ CANCELLED
       └──▶ CANCELLED
```

Tabla `TRANSICIONES` objetivo:

```ts
PENDING_REVIEW:            [REVIEWING, CANCELLED]
REVIEWING:                 [WAITING_CUSTOMER_APPROVAL, EN_MOSTRADOR, PENDING_PAID, CANCELLED]
WAITING_CUSTOMER_APPROVAL: [EN_MOSTRADOR, REVIEWING, EN_ASESORIA, CANCELLED]
EN_ASESORIA:               [WAITING_CUSTOMER_APPROVAL, REVIEWING, EN_MOSTRADOR, CANCELLED]
EN_MOSTRADOR:              [PENDING_PAID, REVIEWING, CANCELLED]
PENDING_PAID:              [PAID, CANCELLED]
PAID:                      [SHIPPED, COMPLETED, CANCELLED]
SHIPPED:                   [COMPLETED, CANCELLED]
COMPLETED:                 []
CANCELLED:                 []
```

Notas sobre arcos que no son obvios:

- **`REVIEWING → EN_MOSTRADOR`** es la transición normal de bodega para pedidos
  de tienda.
- **`REVIEWING → PENDING_PAID`** se conserva **solo para `DOMICILIO`**. Bodega
  confirma y el pedido salta mostrador (D6).
- **`EN_MOSTRADOR → REVIEWING`** es "ajustar": el cliente quiere cambios, el
  pedido vuelve a la cola de bodega **sin asignar** para re-surtir lo nuevo.
  Requiere `asignacion: 'limpiar'` y `reloj: 'reanudar'`.
- **`EN_MOSTRADOR → CANCELLED`** es "cancelar": cancela y crea la reposición en
  la misma transacción, vía `efectos`.
- **`WAITING_CUSTOMER_APPROVAL → EN_MOSTRADOR`** reemplaza al
  `→ PENDING_PAID` actual en `aprobarPropuestaBodega`. El cliente aprobó, pero
  todavía tiene que ver el pedido antes de pagar.
- **`EN_ASESORIA → EN_MOSTRADOR`** es el mismo caso para la contrapropuesta de
  ventas que no dejó items pendientes.

`CambiarEstadoOpts` no necesita campos nuevos. El guard que ya exige
`opts.asignacion` explícito al ir a `REVIEWING` (línea 199) sigue aplicando y es
justo lo que protege el arco "ajustar".

### 3.3 El momento de Firebird, movido

| Transición | Hoy | Nuevo |
|------------|-----|-------|
| `REVIEWING → PENDING_PAID` (domicilio) | `encolarFirebird: true` | **sin cambio** |
| `REVIEWING → EN_MOSTRADOR` | — | `encolarFirebird: false` |
| `WAITING_CUSTOMER_APPROVAL → EN_MOSTRADOR` | era `→ PENDING_PAID` con `true` | **`false`** |
| `EN_MOSTRADOR → PENDING_PAID` (liberar) | — | **`encolarFirebird: true`** ← aquí entra al ERP |

`confirmarSurtido` queda con una bifurcación por modo de entrega:

```ts
const vaAMostrador = pedido.modoEntrega !== ModoEntrega.DOMICILIO;
nuevoEstado: vaAMostrador ? EstadoPedido.EN_MOSTRADOR : EstadoPedido.PENDING_PAID,
encolarFirebird: !vaAMostrador,
```

**Consecuencia operativa:** el folio de VFP se genera cuando mostrador libera,
no cuando bodega termina. El cliente no ve folio de ERP hasta que confirma su
pedido — que es exactamente lo que se quiere, porque antes de eso el pedido
todavía puede cambiar.

**Caso borde — pedidos en vuelo al desplegar.** Un pedido que ya está en
`PENDING_PAID` cuando se despliega ya tiene su fila en `PedidoPendienteEnvio`.
Sigue su camino a `PAID` normalmente. El cambio solo afecta transiciones
nuevas, así que **no hace falta migración de datos**.

### 3.4 El gate de llegada (D5)

Regla de visibilidad en la cola de mostrador:

```
canalOrigen = KIOSKO                              → visible siempre
canalOrigen = WEB  AND llegada activa             → visible
canalOrigen = WEB  AND sin llegada                → oculto
```

"Llegada activa" = `llegadaAnunciadaAt IS NOT NULL AND llegadaDescartadaAt IS NULL`
— el mismo predicado que ya usa `mostrador.service.ts:85`.

La distinción kiosko/web importa: un pedido de kiosko se hizo **en la tienda**,
así que el cliente está ahí por definición. Solo los pedidos web necesitan el
aviso.

### 3.5 Quién hace qué

| Rol | Antes | Ahora |
|-----|-------|-------|
| Bodega | surte → pago | surte → **mostrador** (o pago, si domicilio) |
| VENTAS | contrapropone → pago | contrapropone → **mostrador** |
| **MOSTRADOR** | entrega pedidos pagados | **muestra, libera, ajusta, cancela** + entrega al final |
| Cajero | llama pedidos kiosko en `PENDING_PAID` | igual, pero **también web** |
| Cliente | paga y recoge | **ve, aprueba, paga y recoge** |

### 3.6 El editor compartido (D9)

Tres piezas, todas en `src/components/pedidos/`:

```
ProductoPicker.tsx        ← BuscarProductoModal, movido y generalizado
ItemEditorRow.tsx         ← FilaItemEditor, extraída de PropuestaSheet
EditorProductosSheet.tsx  ← el shell compartido, con prop `modo`
```

`EditorProductosSheet` recibe un `modo`:

```ts
type ModoEditor = 'propuesta' | 'mostrador';
```

- `'propuesta'` (ventas): el resultado se manda al cliente como propuesta de
  chat y el pedido va a `WAITING_CUSTOMER_APPROVAL`. **Comportamiento actual,
  sin cambios.**
- `'mostrador'`: el resultado se aplica al pedido y el pedido vuelve a
  `REVIEWING` para que bodega surta lo nuevo.

El shell mantiene el estado (`quitados`, `cantidades`, `agregados`, `nota`), el
cálculo del total y el gate de `hayCambios`. Lo único que cambia entre modos es
el título, el copy, la etiqueta del botón y qué hace el padre con el payload.
`PropuestaSheet` pasa a ser un wrapper delgado sobre el shell compartido, así
que **ventas no cambia de comportamiento ni de aspecto**.

Diseño: mismo lenguaje visual que ya existe (Sheet lateral derecho, filas con
imagen 48px, stepper `−/+` grande, subtotal en `font-mono tabular-nums`, tokens
`success`/`warning`/`error`). Objetivo tablet: touch targets ≥ 44 px, CTAs
`h-12`. El `ProductoPicker` ya cumple todo esto; solo se mueve.

### 3.7 El badge de reingreso a bodega (D18)

**El problema.** Un pedido puede volver a la cola de bodega por **tres** caminos
distintos, y hoy los tres se ven idénticos en el monitor:

| # | Camino | Quién cambió | Qué tiene que hacer bodega |
|---|--------|--------------|---------------------------|
| 1 | `REVIEWING → REVIEWING` (liberar) | El bodeguero anterior lo soltó | Retomarlo tal cual |
| 2 | `EN_MOSTRADOR → REVIEWING` (ajustar) | Mostrador, con el cliente presente | Surtir los productos nuevos |
| 3 | `WAITING_CUSTOMER_APPROVAL → REVIEWING` (aprobar propuesta de ventas) | El cliente aprobó una contrapropuesta | Surtir lo que el asesor propuso |

Hoy los tres caen en el mismo predicado `esLiberado`
(`monitor.service.ts:226`: `estado === REVIEWING && asignadoAId === null`), así
que el bodeguero no sabe si es un pedido nuevo, uno que alguien soltó, o uno que
volvió con cambios.

**Por qué importa.** El caso 2 y el 3 requieren trabajo real: hay items nuevos en
`PENDIENTE` que nadie ha verificado contra el anaquel. El caso 1 no requiere
nada nuevo. Si el bodeguero no distingue, o re-surtirá un pedido completo por
error, o tomará un pedido con cambios creyendo que ya está listo.

**El discriminador ya existe en los datos.** Verificado:

- `ItemPedido.original = false` **solo** lo setea `propuesta.service.ts:781`
  (cuando ventas agrega un producto). Los items del pedido original son
  `original: true` (`cliente.service.ts:196`).
- Los items que crea el ajuste de mostrador (Fase 4) también serán
  `original: false`.
- `HistorialPedido` ya registra el estado anterior en cada transición, así que el
  camino exacto es reconstruible.

**El diseño propuesto.** Reemplazar el booleano `esLiberado` por un campo
`motivoReingreso` en `MonitorPedidoDto`:

```ts
motivoReingreso:
  | 'LIBERADO'            // caso 1: otro bodeguero lo soltó
  | 'AJUSTE_MOSTRADOR'    // caso 2: el cliente cambió algo en mostrador
  | 'PROPUESTA_VENTAS'    // caso 3: el cliente aprobó una contrapropuesta
  | null;                 // pedido nuevo, nunca salió de bodega
```

Cómo se deriva (en `monitor.service.ts`, sin columnas nuevas):

1. Si el pedido tiene algún item con `original: false` **y** su último
   `HistorialPedido` viene de `EN_MOSTRADOR` → `AJUSTE_MOSTRADOR`.
2. Si tiene items `original: false` y viene de `WAITING_CUSTOMER_APPROVAL` →
   `PROPUESTA_VENTAS`.
3. Si viene de `REVIEWING` → `LIBERADO`.
4. Si nunca salió → `null`.

**Cuántos items nuevos trae** es la información que el bodeguero necesita para
priorizar. Exponer `itemsNuevos: number` (conteo de `original: false &&
!cancelada`) junto al badge.

**En el frontend:** `esLiberado` se conserva por compatibilidad durante la
transición, y el badge nuevo se pinta encima con copy e icono distintos:

| Motivo | Copy | Color |
|--------|------|-------|
| `LIBERADO` | "Liberado" | `muted` (como hoy) |
| `AJUSTE_MOSTRADOR` | "Cambios del cliente · N nuevos" | `warning` |
| `PROPUESTA_VENTAS` | "Propuesta aprobada · N nuevos" | `info` |

**Esto también arregla un hueco del caso 3 que ya existe hoy:** la propuesta de
ventas aprobada devuelve el pedido a `REVIEWING` con items nuevos y el bodeguero
no tiene forma de saberlo salvo abriendo el historial.

---

## 4. Hallazgos de la auditoría

### 4.1 Bugs que el cambio introduce si no se atienden

| # | Hallazgo | Dónde | Impacto |
|---|----------|-------|---------|
| H1 | `encolarFirebird` en `confirmarSurtido` mete el pedido al ERP antes de que el cliente lo confirme | `surtido.service.ts:329` | Ajustes y cancelaciones de mostrador dejarían el ERP desincronizado. **Es el bug que D3 evita.** |
| H2 | El cajero rechaza pedidos web | `cajero.service.ts:86-88` | Un pedido web liberado por mostrador nunca podría pagarse. |
| H3 | El monitor de cajero filtra `KIOSKO` hardcodeado | `cajero-monitor.service.ts:76,124` | El pedido web liberado no aparecería en la TV de ventanillas. |
| H4 | `marcarComoPagado` exige `PENDING_PAID` | `admin.service.ts:131` | Correcto con D3. **Si se dejara el encolado en bodega, un pedido en `EN_MOSTRADOR` cobrado en VFP no podría marcarse pagado** (nunca se encoló). Refuerza D3. |
| H5 | `aprobacion de propuesta de ventas sin items pendientes` va directo a `PENDING_PAID` | `propuesta.service.ts:416` | Salta mostrador. Debe ir a `EN_MOSTRADOR`. |
| H6 | El reloj de atención de bodega no sabe volver de mostrador | `core/atencion.util.ts` | "Ajustar" debe `reanudar`, no `pausar`. Si se pausa, el pedido vuelve a bodega con el reloj congelado y la urgencia miente. |

### 4.2 El barrido de estados

**Corregido tras auditoría adversarial.** La versión anterior de esta sección
tenía errores: listaba archivos que no rompen el build y omitía mapas que sí.

**Rompen la compilación (Records exhaustivos) — 8 en total**

| # | Archivo | Qué es |
|---|---------|--------|
| 1 | `pedidos/core/pedido-state.service.ts:46` | `TRANSICIONES` |
| 2 | `mail/estado-labels.ts:8` | `ESTADO_PEDIDO_LABELS` |
| 3 | `kiosko/kiosko-llegada.service.ts:473` | `labelParaEstado` |
| 4 | `lib/types/index.ts:188` | `ESTADO_PEDIDO_LABEL` |
| 5 | `lib/utils/estadoColor.ts:23` | `ESTADO_VISUAL` |
| 6 | `components/bodega/PedidoPreviewModal.tsx:46` | `estadoVisual` ← **omitido antes** |
| 7 | `(customer)/pedidos/page.tsx:58` | `estadoInfo` |
| 8 | `(warehouse)/bodega/pedidos/[id]/page.tsx:62` | mapa de labels/colores |

**No rompen el build pero hay que actualizarlos (corrección, no compilación)**

| Archivo | Qué es | Por qué |
|---------|--------|---------|
| `kiosko/kiosko-llegada.service.ts:487` | `mensajeParaEstado` | Es cadena de `if` con fallback, **no** un Record. Compila sin la entrada, pero el cliente recibiría el copy genérico. |
| `(customer)/pedidos/page.tsx:101` | `ordenEstados` (array) | El timeline del cliente se calcula con `indexOf`; un estado fuera del array deja **todo el timeline en gris** (ver §4.4). |
| `admin/pedidos/page.tsx:20` | `ordenEstados` (array) | Orden de columnas del kanban. |
| `admin/page.tsx:35` | `ESTADOS_PENDIENTES_BODEGA` (array) | Decide si `EN_MOSTRADOR` cuenta como pendiente de bodega. **No debe.** |
| `pedidos/core/pedido-state.service.ts:564` | `notifTipoParaEstado` | Tiene `default: return null`. Compila sin la entrada y el comportamiento (no notificar) es el deseado. Solo tocar si se decide notificar (§9). |

**Si se agrega el rol `MOSTRADOR_MONITOR` — mapas de rol que rompen**

| Archivo | Qué es |
|---------|--------|
| `lib/hooks/useProtectedRoute.ts:152,161,191` | `ROLES_MOSTRADOR` + unión de roles + hook de ruta |
| `lib/utils/rolColor.ts:45,76` | color del rol + lista ordenada |
| `lib/constants/paths.ts` | unión de rutas + `RUTAS_PROTEGIDAS` + `getDashboardPath` |
| `Navbar` (×3) + `UserMenu` | navegación por rol |

**No hay nada que cambiar en** (verificado, para no gastar esfuerzo):
`realtime/realtime.service.ts` (emisor genérico sin catálogo de eventos),
`admin.service.marcarComoPagado` (el gate sigue siendo correcto con D3),
`pedido-pago.handler.ts` (solo hay que verificar que el arco `CANCELLED` se
declare — es prueba, no código).

**Cómo debe verse `EN_MOSTRADOR` en cada superficie:**

| Superficie | Label | Color | Copy al cliente |
|------------|-------|-------|-----------------|
| Email | "Listo en tienda · revísalo" | — | — |
| Cliente (lista) | "Listo para revisar en tienda" | `info` | "Pasa a mostrador a revisar tu pedido." |
| Cliente (timeline) | "En mostrador" | `info` | — |
| Admin | "En mostrador" | `info` | — |
| Bodega | no aparece (ya no es tarea de bodega) | — | — |
| Mostrador | "Por revisar con el cliente" | `warning` | — |

### 4.3 Lo que NO hace falta cambiar (verificado, para no gastar esfuerzo)

- **`PedidoAccessService`.** MOSTRADOR ya cae en la rama "mismo tienda"
  (`pedido-access.service.ts:117-131`). Sin cambios.
- **`ReposicionService`.** Se reusa entero.
- **`KioskoLlegadaService`.** El gate de llegada no necesita código nuevo: el
  predicado ya existe y la llegada ya es ortogonal al estado. Solo hay que
  agregar `EN_MOSTRADOR` a los dos mapas de labels.
- **`marcarComoPagado`.** Correcto tal cual con D3.
- **`ESTADOS_OCUPAN_SLOT_BODEGA`.** Sigue siendo `[REVIEWING]`. `EN_MOSTRADOR`
  no ocupa slot de bodega (el pedido ya salió de bodega).
- **El flujo de domicilio.** Intacto.
- **`marcarEnviado` / `PAID → SHIPPED`.** Intacto.

### 4.4 Bugs de runtime que el compilador NO delata

Estos son los peligrosos: TypeScript no los ve y solo aparecen en producción.
Los encontró la auditoría adversarial.

**B1 — El timeline del cliente se pinta entero en gris**

`(customer)/pedidos/[id]/page.tsx:315` calcula la posición del paso actual con
`tl.indexOf(pedido.estado)`. Si el estado no está en el array, `indexOf` devuelve
`-1` y `pasoAlcanzado(i, estado, -1)` es `false` para **todos** los pasos: el
cliente ve el timeline completo en gris, como si nada hubiera pasado. Además
`PedidoFinalAprobado` no se renderiza.

*Arreglo:* agregar `EN_MOSTRADOR` a `ordenEstados` (que alimenta el timeline) y
manejar el caso `-1` con un fallback explícito en vez de confiar en el array.

**B2 — El anti-spam de llegada mata el realtime para siempre**

`kiosko-llegada.service.ts:171-172` incrementa `llegadaAnunciadaCount` y deja de
emitir realtime cuando supera `MAX_AVISOS_POR_PEDIDO = 5`. El contador **nunca
se reinicia**. Hoy es un adorno; con D5 la llegada es **el gate que hace aparecer
el pedido en mostrador**. Un cliente que avisa 6 veces deja su pedido invisible
en la TV para siempre.

*Arreglo:* resetear el contador cuando el pedido cambia de estado (o cuando
`llegadaDescartadaAt` se limpia), o contar por ventana de tiempo en vez de
acumulado. **Es obligatorio para que D5 funcione.**

**B3 — El guard del QR de llegada es evadible**

`kiosko-llegada.controller.ts:130`:

```ts
if (user.rol === RolUsuario.CLIENTE && user.userId !== undefined) {
```

Si `user.userId` llega `undefined`, la condición completa es `false` y **se salta
la validación de dueño**: un CLIENTE autenticado podría obtener el QR firmado de
cualquier pedido. Ese QR es la credencial para anunciar llegada.

*Arreglo:* `if (user.rol === RolUsuario.CLIENTE)` sin la segunda condición, y
lanzar si `userId` falta.

**B4 — El bridge realtime del mostrador es código muerto**

`(counter)/mostrador/page.tsx:65` lee `window.__kioskoSocket`, pero **nadie lo
asigna nunca** (verificado por grep: la única aparición es esa lectura). Con
`NEXT_PUBLIC_REALTIME_ENABLED=true` el polling de 5 s se apaga, así que un aviso
de llegada **no aparece** hasta refrescar a mano — justo el caso de uso central
del flujo nuevo.

*Arreglo:* reemplazar el bridge por `useRealtimeEvents` (el hook real que usan
los otros monitores). **El patrón "que ya funciona" que este plan citaba como
reusable no existe.**

**B5 — No hay forma de que el cliente WEB avise su llegada**

`POST /cliente/pedidos/:id/anunciar-llegada` existe en el backend
(`cliente.controller.ts:60`) pero **no tiene ningún caller en el frontend**
(grep vacío). El único camino cableado es la tablet del kiosko.

Con D5, un pedido web **no aparece en mostrador hasta que el cliente avisa**.
Sin UI para avisar, D5 es inalcanzable para el canal web: el pedido quedaría
invisible para siempre.

*Arreglo:* construir la UI de "avisar llegada" en el detalle del pedido del
cliente (botón + confirmación). **Es un requisito de la Fase 2, no un extra.**

### 4.5 Inconsistencias del sistema actual que el cambio expone

- **`cliente.service.cancelarPedido:370`** transiciona a `CANCELLED` **sin crear
  reposición**, a diferencia de los caminos de propuesta
  (`propuesta.service.ts:482,637`). La cancelación desde mostrador debe crearla
  explícitamente (ya está en el plan). Vale la pena arreglar también la del
  cliente, porque deja mercancía apartada sin lista de reposición.
- **`aprobarPropuestaBodega` y `aprobarPropuestaVentas` no leen `modoEntrega`**
  (verificado: `propuesta.service.ts:289-330` solo carga `items`). Si se les
  cambia el destino a `EN_MOSTRADOR` sin bifurcar, **un pedido a domicilio con
  faltante aterriza en mostrador y queda atorado** — nadie lo recoge en tienda.
  Es el riesgo R12.
- **Doble transición en `aprobarPropuestaVentas`** (`WAITING_CUSTOMER_APPROVAL →
  REVIEWING` y luego `REVIEWING → EN_MOSTRADOR`): entre las dos, el pedido está
  en `REVIEWING` sin asignar y un bodeguero puede tomarlo desde el monitor. El
  propio código lo admite (`propuesta.service.ts:409-411`). Con el flujo nuevo
  conviene colapsarlo en una sola transición.
- **`bodega.service.liberarPedido` y `tomarGrupo`** escriben `estado = REVIEWING`
  con `updateMany` directo (`bodega.service.ts:286,834`), saltándose
  `TRANSICIONES` y sin emitir `pedido.estado` ni `monitor.invalidado`. Deuda
  preexistente; se vuelve visible cuando el flujo nuevo depende de esos eventos
  para refrescar la TV de mostrador.
- **`VentasChatPanel` usa `usePedidoSurtir`** (`GET /bodega/pedidos/:id/surtir`,
  `@Roles(BODEGA, ADMIN)` a nivel de clase) → un VENTAS recibe **403** y el chat
  del panel lateral está roto hoy. Está en el camino que este plan toca.

---

## 5. Plan de ejecución por fases

Cada fase compila, se despliega y se prueba sola. El orden importa: la Fase 1 es
el cimiento y las demás se apoyan en ella.

---

### Fase 0 (referencia) — El precio por lista

**Objetivo:** el pedido se persiste con el precio de la lista que le toca al
cliente. Es independiente del cambio de flujo y **se puede desplegar solo**.

**Por qué primero:** toca dinero, ya está roto, y la Fase 4 iba a heredar el bug.

**0.1 Extraer el helper de resolución de lista**

Hoy la lógica vive privada en `catalogo.service.ts` (`obtenerColumnaLista`,
línea 297, y `resolverColumnaLista`, línea 13). Moverla a
`src/modules/pedidos/core/precio-lista.util.ts` (o un `PreciosService`
compartido) para que el catálogo y los pedidos usen **la misma** resolución.

La resolución tiene dos niveles y hay que conservar los dos:

```
UsuarioTienda.listaPrecioCodigo (por tienda, activa)   ← preferida
  └─ fallback → Usuario.listaPrecioCodigo (global)
       └─ fallback → 'lista1'
```

**0.2 Resolver el precio al crear el pedido**

`cliente.service.ts:170-200` — hoy trae los `PrecioCO` y usa `pco.precio`. Debe:

1. Resolver la columna de lista del usuario para esa tienda.
2. Seleccionar esa columna en el `findMany` de `preciosCO`.
3. Usar ese valor como `precioUnitario` y base del `subtotal`.

**0.3 Resolver el precio al agregar producto en una propuesta**

`propuesta.service.ts:774` — mismo tratamiento. El pedido tiene `usuarioId`, así
que la lista se resuelve desde el dueño del pedido, no desde quien propone (el
asesor no tiene lista de precios de cliente).

**0.4 Guard de regresión**

Test que cree un pedido con un usuario de `listaPrecioCodigo = '3'` y verifique
que `ItemPedido.precioUnitario` es `lista3`, no `lista1`. Y otro con usuario sin
lista (fallback a `lista1`).

**Criterio de aceptación de la Fase 0**

1. Un cliente con lista 3 recibe un pedido con precios de lista 3.
2. Un cliente sin lista recibe precios de lista 1 (sin regresión).
3. La lista por tienda (`UsuarioTienda`) gana sobre la global.
4. El total del pedido coincide con la suma de los subtotales.
5. `npm run build` y `npm test` pasan.

---

### Fase 1 (referencia) — El estado y la máquina de estados

**Objetivo:** el flujo nuevo existe en el backend, de punta a punta, sin
frontend nuevo. Se puede probar con curl/Swagger.

**1.1 Schema y migración**

- Agregar `EN_MOSTRADOR` a `enum EstadoPedido` en `prisma/schema.prisma`.
- Migración `prisma migrate dev --name pedido_en_mostrador`.
  - `ALTER TYPE "EstadoPedido" ADD VALUE 'EN_MOSTRADOR'` — Postgres lo soporta
    sin reescribir la tabla. **No lleva `BEFORE`/`AFTER`**: el orden del enum no
    importa aquí (nada ordena por el enum).
  - **Nota:** `ALTER TYPE … ADD VALUE` no puede correr dentro de una transacción
    en versiones viejas de Postgres. Prisma lo maneja, pero hay que revisar el
    SQL generado antes de aplicarlo.

**1.2 La tabla de transiciones**

- Actualizar `TRANSICIONES` en `pedido-state.service.ts` según §3.2.
- Actualizar el comentario de cabecera del archivo (líneas 23-45) para describir
  el flujo nuevo — ese comentario es la documentación de la máquina de estados.

**1.3 Bodega: el destino nuevo**

- `surtido.service.ts:314-344` — `confirmarSurtido` bifurca por `modoEntrega` con
  el helper `destinoTrasSurtido` (§1.4). **Verificado:** el método ya carga el
  pedido completo (`findUnique({ include: { items: true } })`, línea 240), así
  que `modoEntrega` está disponible sin query extra.
  - `DOMICILIO` → `PENDING_PAID`, `encolarFirebird: true` (como hoy).
  - resto → `EN_MOSTRADOR`, `encolarFirebird: false`.
- El guard de "propuesta aceptada y no consumida" (línea 296) **se queda**: un
  faltante sigue necesitando autorización del cliente antes de que bodega
  cierre.
- `reloj: 'detener'` se mantiene en ambos casos: el pedido ya no es tarea de
  bodega.

**1.4 Propuesta: el destino nuevo**

**CUIDADO — la bifurcación por `modoEntrega` también va aquí.** Verificado:
`aprobarPropuestaBodega` (`propuesta.service.ts:289-330`) carga el pedido con
`include: { items: true }` y **no lee `modoEntrega`**. Si se cambia el destino a
`EN_MOSTRADOR` sin bifurcar, **un pedido a domicilio con faltante aterriza en
mostrador y queda atorado** — nadie lo recoge en tienda. Es el riesgo R12 y es
fácil de pasar por alto porque la bifurcación de `confirmarSurtido` vive en otro
archivo.

La regla debe ser **una sola función** compartida:

```ts
// core/destino-post-surtido.util.ts
export function destinoTrasSurtido(
  modoEntrega: ModoEntrega,
): { estado: EstadoPedido; encolarFirebird: boolean } {
  return modoEntrega === ModoEntrega.DOMICILIO
    ? { estado: EstadoPedido.PENDING_PAID, encolarFirebird: true }
    : { estado: EstadoPedido.EN_MOSTRADOR, encolarFirebird: false };
}
```

Y usarla en **los tres** sitios: `confirmarSurtido`, `aprobarPropuestaBodega` y
`aprobarPropuestaVentas` (rama sin pendientes). Así no puede divergir.

Detalle por método:

- `aprobarPropuestaBodega` (línea 289) → `destinoTrasSurtido(pedido.modoEntrega)`.
  Requiere **agregar `modoEntrega` al select** del `findUnique` (hoy solo trae
  `items`).
- `aprobarPropuestaVentas` rama "sin items pendientes" (línea 416) → mismo
  helper. Requiere el mismo ajuste de select.
- `aprobarPropuestaVentas` rama "con items pendientes" (línea 375) sigue yendo a
  `REVIEWING` con `asignacion: 'limpiar'`, `reloj: 'reanudar'`. Sin cambios: el
  pedido tiene que volver a bodega a surtir lo nuevo, sin importar el modo.
- **Colapsar la doble transición** (§4.5): hoy
  `WAITING_CUSTOMER_APPROVAL → REVIEWING` y luego `REVIEWING → EN_MOSTRADOR`,
  con una ventana en la que un bodeguero puede tomar el pedido. Resolver en una
  sola transición cuando no quedan pendientes.

**1.5 Mostrador: las tres acciones**

Tres métodos nuevos en `mostrador/mostrador.service.ts`, todos delegando en
`pedidoState.cambiarEstado`:

```ts
// EN_MOSTRADOR → PENDING_PAID. Aquí entra el pedido al ERP.
async liberar(pedidoId, usuario) {
  // valida estado === EN_MOSTRADOR
  return this.pedidoState.cambiarEstado(pedidoId, {
    nuevoEstado: EstadoPedido.PENDING_PAID,
    observacion: `Liberado a pago por ${usuario.nombre}`,
  }, usuario, {
    encolarFirebird: true,     // ← el momento de Firebird (D3)
    invalidarMonitor: true,    // ← que la TV de cajero y la de mostrador refresquen
  });
}

// EN_MOSTRADOR → REVIEWING. El cliente quiere cambios; bodega re-surte.
async ajustar(pedidoId, usuario, nota) {
  // valida estado === EN_MOSTRADOR
  // Fase 1: solo manda de vuelta con una nota. Fase 4 agrega la edición real.
  return this.pedidoState.cambiarEstado(pedidoId, {
    nuevoEstado: EstadoPedido.REVIEWING,
    observacion: `Ajuste solicitado en mostrador: ${nota}`,
  }, usuario, {
    asignacion: 'limpiar',     // vuelve a la cola, sin dueño
    reloj: 'reanudar',         // H6: el reloj de bodega arranca de nuevo
    invalidarMonitor: true,
  });
}

// EN_MOSTRADOR → CANCELLED + reposición, atómico.
async cancelar(pedidoId, usuario, motivo) {
  // valida estado === EN_MOSTRADOR
  return this.pedidoState.cambiarEstado(pedidoId, {
    nuevoEstado: EstadoPedido.CANCELLED,
    observacion: `Cancelado en mostrador: ${motivo}`,
  }, usuario, {
    efectos: (tx) => this.reposicion.crearDesdePedido(tx, pedidoId, motivo),
    invalidarMonitor: true,
  });
}
```

`MostradorService` necesita inyectar `ReposicionService`. Ya está exportado por
`PedidosModule` (línea ~100), así que `MostradorModule` solo tiene que importarlo.

**1.6 Endpoints**

En `mostrador/mostrador.controller.ts`, con `@Roles(MOSTRADOR, ADMIN)`:

| Método | Ruta | Qué hace |
|--------|------|----------|
| `POST` | `/pedidos/mostrador/:id/liberar` | `EN_MOSTRADOR → PENDING_PAID` |
| `POST` | `/pedidos/mostrador/:id/ajustar` | `EN_MOSTRADOR → REVIEWING` (body: `{ nota }`) |
| `POST` | `/pedidos/mostrador/:id/cancelar` | `EN_MOSTRADOR → CANCELLED` + reposición (body: `{ motivo }`) |

DTO nuevo `dto/accion-mostrador.dto.ts` con `nota` / `motivo` validados por
`class-validator`.

**1.7 El barrido de labels**

Actualizar todo §4.2. Es mecánico pero **obligatorio**: sin esto no compila.

**1.8 Tests**

- `pedido-state.service.spec.ts` (crear si no existe): cada arco nuevo de
  `TRANSICIONES` permitido, y los viejos que ya no lo están, rechazados.
- `mostrador.service.spec.ts` (crear): `liberar` encola a Firebird;
  `ajustar` limpia asignación y reanuda reloj; `cancelar` crea reposición.
- Verificar que `encolarFirebird` **no** se dispara en `REVIEWING → EN_MOSTRADOR`.

**Criterio de aceptación de la Fase 1**

1. Un pedido de tienda que bodega confirma queda en `EN_MOSTRADOR` y **no**
   tiene fila en `PedidoPendienteEnvio`.
2. Mostrador lo libera → queda en `PENDING_PAID` **con** fila en
   `PedidoPendienteEnvio`.
3. Un pedido a domicilio sigue yendo `REVIEWING → PENDING_PAID` con encolado
   inmediato.
4. Cancelar desde mostrador deja el pedido en `CANCELLED` con su
   `PedidoReposicion` en `PENDIENTE`.
5. `npm run build` pasa.

---

### Fase 1 — El estado y la máquina de estados — ✅ COMPLETADA (2026-09-25)

**Objetivo:** el flujo nuevo existe en el backend, de punta a punta, sin
frontend nuevo. Se puede probar con curl/Swagger.

**Lo que se implementó:**

- `EN_MOSTRADOR` en `enum EstadoPedido` + migración
  `20260925000000_pedido_en_mostrador` (`ALTER TYPE ... ADD VALUE`, al final del
  enum para no reescribir la columna).
- `TRANSICIONES` actualizada con los arcos nuevos y los comentarios que
  documentan el flujo.
- `destinoTrasSurtido(modoEntrega)` en `core/destino-post-surtido.util.ts` — el
  helper único que usan los **tres** caminos (surtido, propuesta de bodega,
  propuesta de ventas). Es la mitigación del riesgo R12.
- `confirmarSurtido` bifurca por `modoEntrega`; `aprobarPropuestaBodega` y la
  rama sin pendientes de `aprobarPropuestaVentas` usan el mismo helper. Los dos
  últimos ahora cargan `modoEntrega` (antes no lo leían).
- `MostradorService`: `obtenerCola` (con el gate de llegada de D5), `liberar`
  (encola a Firebird — el momento del ERP), `ajustar` y `cancelar` (con
  reposición atómica vía `efectos`).
- Endpoints `GET /pedidos/mostrador/cola` y `POST :id/{liberar,ajustar,cancelar}`
  con `@Roles(MOSTRADOR, ADMIN)`. La ruta fija `cola` va antes de `:id`.
- Labels: `mail/estado-labels.ts`, `kiosko-llegada.service.ts` (`labelParaEstado`
  y `mensajeParaEstado`).

**Verificación:**

- 22 tests nuevos (máquina de estados + helper de destino), 111 pasan en total.
- `npm run build` limpio; DI verificada arrancando la app real.
- **Prueba end-to-end contra la BD**: kiosko → `EN_MOSTRADOR` sin encolar,
  domicilio → `PENDING_PAID` con encolado; la cola de mostrador muestra el
  kiosko, excluye el domicilio, excluye el web sin aviso y muestra el web con
  aviso.

**Notas de entorno (importante para desplegar):**

- La BD local se creó con `db push`, **no tiene `_prisma_migrations`**. Correr
  `prisma migrate dev` querría resetear la base. El enum se aplicó a mano con
  `ALTER TYPE` y la migración quedó en el repo para producción
  (`prisma migrate deploy`).
- El `migrate diff` reportó un drift preexistente
  (`kiosko_pairings.updated_at DROP DEFAULT`) que **no** es de este cambio; la
  migración nueva no lo incluye.

---

### Fase 2 (referencia) — El monitor y la consola de mostrador

**Objetivo:** mostrador tiene TV y consola, y puede operar el flujo completo.

**2.1 Rol nuevo `MOSTRADOR_MONITOR` (D11)**

Decidido: la TV tiene rol propio. La TV solo mira; no puede liberar, ajustar ni
cancelar. Esto es más limpio y evita que alguien opere desde la pantalla de
pared.

**Costo real (verificado por grep) — hay que tocar 10 archivos de frontend más
el backend:**

| Capa | Archivo | Qué |
|------|---------|-----|
| Backend | `prisma/schema.prisma` | `MOSTRADOR_MONITOR` en `enum RolUsuario` |
| Backend | `propuesta.service.ts:65` | `DECISIONES_POR_ORIGEN: Record<RolUsuario, …>` (TypeScript obliga) |
| Backend | `prisma/seed.ts` | Usuario de TV para la tienda demo |
| Frontend | `lib/hooks/useProtectedRoute.ts:152,161,191` | `ROLES_MOSTRADOR` + unión + hook de ruta |
| Frontend | `lib/utils/rolColor.ts:45,76` | color del rol + lista ordenada |
| Frontend | `lib/constants/paths.ts` | unión de rutas + `RUTAS_PROTEGIDAS` + `getDashboardPath` |
| Frontend | `Navbar` (×3) + `UserMenu` | navegación por rol |
| Frontend | `lib/types/index.ts` | unión `UserRole` |

`PedidoAccessService` **no necesita cambios** (verificado): `validar()` solo tiene
ramas para ADMIN y CLIENTE; todo lo demás cae en el check de tienda
(`pedido-access.service.ts:117-131`).

**2.2 Snapshot del monitor**

Service nuevo `mostrador/mostrador-monitor.service.ts`, espejo de
`cajero-monitor.service.ts` pero agrupado por **estado de la cola**, no por
ventanilla:

```ts
{
  timestamp, tiendaId, tiendaNombre,
  // Cola de trabajo: lo que hay que mostrar/liberar
  cola: [
    { id, numeroPedido, clienteNombre, canalOrigen, itemsCount, total,
      minutosEnCola, nivelUrgencia,
      llegadaAnunciadaAt, esperandoDesdeMin,   // badge EN TIENDA
      esLlegada: boolean }
  ],
  // Pedidos ya liberados y pagados, esperando entrega
  listosParaEntregar: [ … ],
  contadores: { enCola, enTienda, criticos, listosParaEntregar }
}
```

Filtro de la cola (§3.4):

```ts
where: {
  tiendaId,
  estado: EstadoPedido.EN_MOSTRADOR,
  OR: [
    { canalOrigen: CanalOrigen.KIOSKO },
    { canalOrigen: CanalOrigen.WEB,
      llegadaAnunciadaAt: { not: null },
      llegadaDescartadaAt: null },
  ],
}
orderBy: [
  { llegadaAnunciadaAt: { sort: 'asc', nulls: 'last' } },  // los que esperan primero
  { fechaPedido: 'asc' },
]
```

Reusar `minutosEntre` + `calcularUrgencia` de `core/urgencia.util.ts` y los
umbrales `UMBRALES_TIENDA = [4, 7, 10]` que ya usa el monitor de cajero.

**2.3 Endpoint del monitor**

`GET /pedidos/mostrador/monitor` con `@Roles(MOSTRADOR_MONITOR, ADMIN)`.
**Cuidado con el orden de rutas en NestJS:** `monitor` es ruta fija y tiene que
ir **antes** de `:id`, o el `RolesGuard` rechaza al rol de TV con 403. El
mismo problema que ya documenta `pedidos.module.ts` para bodega y cajero.

**2.4 Cola de la consola**

Extender `obtenerPedidosListos` o agregar `obtenerCola`:

| Endpoint | Estados | Para qué |
|----------|---------|----------|
| `GET /pedidos/mostrador/cola` | `EN_MOSTRADOR` (con gate de llegada) | mostrar / liberar / ajustar / cancelar |
| `GET /pedidos/mostrador/listos` | `PAID`, `SHIPPED` | entrega final (ya existe) |

Mantener `listos` como está evita romper la pantalla de entrega actual.

**2.5 Eventos realtime**

Nuevo evento `pedido.llamado-mostrador` (espejo de `pedido.llamado` del cajero),
emitido cuando el operador manda a llamar a un cliente. Payload:

```ts
{ id, numeroPedido, clienteNombre, mostradorNombre, operadorNombre }
```

Y reusar `monitor.invalidado` (ya existe) para que la TV refresque.

**2.6 Frontend: la TV**

`src/app/mostrador-monitor/page.tsx` + `layout.tsx`, calcado de
`cajero-monitor/page.tsx`:

- `useMostradorMonitorRoute()` (patrón de `useCajeroMonitorRoute`).
- `useMonitorMostradorData()` en `useMonitorData.ts` con su
  `MONITOR_MOSTRADOR_QUERY_KEY`.
- Reusar tal cual: `MonitorTopBar` (con `subtitulo="TV Mostrador"`),
  `MonitorSkeleton`, `MonitorEmpty`, `useMonitorDrift`, `useMonitorMute`.
- Componentes nuevos en `components/mostrador/`: `MonitorMostradorGrid`,
  `MonitorMostradorCola`, `MonitorMostradorAlert` (alerta grande cuando se
  llama a alguien — espejo de `MonitorCajeroAlert`).
- Sonido: reusar el patrón de `useMonitorCajeroSounds` (diff de snapshot).
- **Realtime: usar `useRealtimeEvents`, NO el bridge `window.__kioskoSocket`.**
  Ese bridge nunca se asigna (bug B4) y con realtime ON el polling se apaga, así
  que la TV no se enteraría de nada.

**2.7 Frontend: la consola**

`src/app/(counter)/mostrador/page.tsx` pasa a tener dos pestañas o dos
secciones:

- **Por revisar** (`EN_MOSTRADOR`): la cola nueva, con badge "EN TIENDA · X min"
  en los que avisaron llegada, y tres CTAs por pedido.
- **Por entregar** (`PAID|SHIPPED`): lo que ya existe hoy, sin cambios.

`src/app/(counter)/mostrador/[id]/page.tsx` gana las tres acciones cuando el
pedido está en `EN_MOSTRADOR`: **Liberar a pago**, **Ajustar**, **Cancelar**.
Cuando está en `PAID|SHIPPED` se queda como está (checklist + entregar).

Hooks nuevos en `usePedidosMostrador.ts`: `useColaMostrador`,
`useLiberarPedido`, `useAjustarPedido`, `useCancelarPedido`. API en
`pedidosMostradorApi`.

**2.8 La UI de llegada del cliente web (REQUISITO, no extra)**

Sin esto, D5 no funciona para pedidos web: el pedido nunca aparecería en la cola
y quedaría invisible para siempre (bug B5).

- `POST /cliente/pedidos/:id/anunciar-llegada` **ya existe** en el backend
  (`cliente.controller.ts:60`, service en `cliente.service.ts:383`). No hay que
  construirlo.
- Falta el **frontend**: un botón "Ya llegué a la tienda" en
  `(customer)/pedidos/[id]/page.tsx`, visible cuando el pedido está en un estado
  donde tiene sentido (no terminal, `modoEntrega` de recoger).
- Falta el **cliente de API** en `lib/api/` (no existe hoy).
- El copy debe explicar que el pedido aparecerá en mostrador al avisar.

**2.9 El aviso al cliente: el monitor ES el canal (D16)**

**Resuelto — no hace falta email ni QR.** El negocio lo definió así: el monitor
de mostrador funciona **estilo banco**. Todos los pedidos pendientes de llamar
están en cola visible; el operador manda a llamar al siguiente conforme al orden
de la cola; y cuando el cliente **ve su pedido siendo llamado en la pantalla**,
ya sabe que tiene que pasar a que lo revisen.

Esto elimina la dependencia circular que la auditoría había detectado: el email
con el QR se dispara en el ACK de Firebird (`sync-agent.service.ts:405`), que con
D3 ocurre **después** de la liberación de mostrador — es decir, después de la
llegada que el QR debía habilitar. Con D16 el QR deja de ser necesario para el
flujo: el aviso es visual, en la pantalla de la tienda.

**Consecuencias de diseño:**

- **No se agrega `TipoNotificacion` nuevo** ni plantilla de email al entrar a
  `EN_MOSTRADOR`. `notifTipoParaEstado` (`pedido-state.service.ts:564`) se queda
  como está (devuelve `null` para `EN_MOSTRADOR`).
- **El evento `pedido.llamado-mostrador` (§2.5) pasa a ser crítico, no
  cosmético.** Es lo que hace que el cliente sepa que le toca. La TV tiene que
  ser visible desde la tienda y la alerta tiene que ser grande.
- **La alerta de la TV debe incluir el nombre o folio visible** para que el
  cliente se identifique. Es el mismo patrón de `MonitorCajeroAlert`, que ya
  muestra folio + número de ventanilla.
- **El QR sigue existiendo** para quien lo tenga (llega en el email de "listo
  para pagar" post-pago), pero ya no es el camino principal para anunciar
  llegada. El folio `numeroPedido` y el botón de la app (§2.8) son suficientes.

**2.10 El bug B2 es bloqueante**

El anti-spam de llegada (B2, §4.4) debe arreglarse **en esta fase**: si el
contador no se reinicia, un cliente que avisa 6 veces deja su pedido invisible en
la TV para siempre, y la llegada es justo el gate de D5.

**Criterio de aceptación de la Fase 2**

1. La TV de mostrador muestra la cola y la alerta al llamar.
2. Un pedido de kiosko aparece en la cola apenas bodega lo confirma.
3. Un pedido web **no** aparece hasta que el cliente avisa llegada; al avisar
   (desde la UI nueva o por folio en el kiosko), aparece con badge y suena el
   chime.
4. Un cliente que avisa 6+ veces sigue apareciendo (B2 arreglado).
5. Liberar / ajustar / cancelar funcionan desde la consola y la TV refresca.
6. `npm run build` pasa en ambos repos.

---

### Fase 2 — El monitor y la consola de mostrador — ✅ COMPLETADA (2026-09-25)

**Objetivo:** mostrador tiene TV y consola, y puede operar el flujo completo.

**Lo que se implementó:**

- Rol `MOSTRADOR_MONITOR` (decisión D11) + migración
  `20260925010000_rol_mostrador_monitor`. Seed con
  `mostrador.tv.mexicali@puntotextil.com`.
- `MostradorMonitorService` + `GET /pedidos/mostrador/monitor` (solo lectura,
  rol de TV). Cola lineal con el gate de llegada de D5.
- `MostradorService.llamar` + `POST /pedidos/mostrador/:id/llamar` — NO cambia
  el estado, emite `pedido.llamado-mostrador`. Es el canal de aviso del flujo
  (decisión D16).
- Frontend TV: `/mostrador-monitor` con `MonitorMostradorCola` (lista lineal,
  el siguiente a llamar destacado) y `MonitorMostradorAlert` (overlay tipo
  banco con el folio en `text-7xl`).
- Frontend consola: `/mostrador` con dos pestañas (Por revisar / Por entregar),
  `MostradorAccionesPedido` en el detalle (llamar, liberar, ajustar, cancelar).
- Los ~10 archivos de rol del frontend actualizados (types, rolColor, paths,
  useProtectedRoute, Navbar, UserMenu).

**Bugs del plan arreglados en esta fase:**

- **B1** (timeline del cliente en gris): `EN_MOSTRADOR` agregado al timeline +
  fallback explícito para `indexOf === -1`.
- **B4** (bridge `window.__kioskoSocket` muerto): reemplazado por
  `useRealtimeEvents` en la consola; el bridge se eliminó.
- **B5** (sin UI de llegada web): botón "Ya llegué a la tienda" en el detalle
  del pedido del cliente + `useAnunciarLlegada` + `pedidosClienteApi.anunciarLlegada`.

**Verificación:**

- 7 tests nuevos del gate de D5 (49 en total de las fases 0-2), 118 pasan.
- `npm run build` limpio en ambos repos; `/mostrador-monitor` en las rutas.
- **Prueba end-to-end contra la BD**: el snapshot muestra el kiosko y el web con
  aviso, excluye el web sin aviso, ordena el avisado primero, y el DTO no trae
  `nivelUrgencia`.

**Pendiente de la Fase 3 (bloqueante para desplegar):** el cajero todavía
filtra `KIOSKO` en cinco lugares, así que un pedido web liberado por mostrador
se quedaría atorado en `PENDING_PAID` sin que nadie lo vea.

---

### Fase 3 (referencia) — El pago (cajero)

**Objetivo:** el cajero ve los pedidos web liberados por mostrador, no solo los
de kiosko.

**3.1 Quitar el candado de kiosko — son CINCO puntos, no uno**

La versión anterior de este plan citaba solo el guard. Verificado por grep, el
filtro `KIOSKO` está en cinco lugares:

| # | Archivo | Línea | Qué hace |
|---|---------|-------|----------|
| 1 | `cajero.service.ts` | 86-88 | **Guard**: rechaza con 400 todo pedido no-KIOSKO |
| 2 | `cajero.service.ts` | 234 | `llamarSiguiente`: filtra `canalOrigen: KIOSKO` |
| 3 | `cajero.service.ts` | 41-45 | `obtenerColaVentanilla`: default `canal = 'KIOSKO'` |
| 4 | `cajero-monitor.service.ts` | 76 | Pedidos por ventanilla: filtra `KIOSKO` |
| 5 | `cajero-monitor.service.ts` | 124 | Cola sin asignar: filtra `KIOSKO` |

**Si solo se quita el guard (1), "Llamar siguiente" (2) nunca tomará un pedido
web: devolverá 404.** Es el error más fácil de cometer.

**3.2 Los tres defaults de canal, en sincronía**

El filtro de canal tiene un default en tres capas. Hay que cambiar **los tres** o
el frontend seguirá escondiendo los pedidos web aunque el backend ya los acepte:

| Capa | Archivo | Default actual |
|------|---------|----------------|
| Service | `cajero.service.ts:39` | `'KIOSKO'` |
| Controller | `cajero.controller.ts:59` | `'KIOSKO'` |
| Frontend | `(cashier)/cajero/page.tsx:86` | `canalFiltro = 'KIOSKO'` |

**Y el orden importa:** si se cambia el frontend **sin** relajar el backend, la
consola muestra pedidos web cuyo botón "Tomar" lanza 400 (el guard de §3.1). Los
dos cambios van en el mismo despliegue.

El filtro de canal **deja de ser un gate de seguridad** y pasa a ser una
comodidad de UI. Vale la pena conservarlo (la cajera puede querer ver solo los de
kiosko), pero el default debe mostrar todo.

**3.3 El monitor de cajero**

- Quitar `canalOrigen: CanalOrigen.KIOSKO` de `cajero-monitor.service.ts:76` y
  `:124`.
- **Excluir los pedidos a domicilio**: un pedido a domicilio en `PENDING_PAID`
  no debe aparecer en ventanillas (el cliente no va a la tienda a pagar). Agregar
  `modoEntrega: { not: ModoEntrega.DOMICILIO }` a ambos `where`. Hoy no hace
  falta porque el filtro de KIOSKO ya los excluye de facto (un domicilio es WEB),
  pero al quitar ese filtro hay que ponerlo explícito.
- Considerar mostrar el canal en la tarjeta de la ventanilla (kiosko vs web) para
  que la cajera sepa de dónde viene el cliente.

**3.4 Frontend del cajero**

- `cajero-monitor/page.tsx` y `components/cajero/*`: si muestran el canal,
  ajustar. El resto del monitor no cambia.
- `(cashier)/cajero/page.tsx`: cambiar el default de `canalFiltro` (§3.2).

**3.5 Quitar los relojes de urgencia de cajero y mostrador (D13)**

Decidido: **los relojes de urgencia solo viven en bodega.** El cajero y el
mostrador no deben tener urgencia ni tiempo de espera.

**Por qué tiene sentido:** en bodega el reloj mide trabajo pendiente de un
empleado (cuánto lleva un pedido sin que el bodeguero lo tome), y ahí sí importa
priorizar. En cajero y mostrador el pedido espera al **cliente**, no al revés: un
pedido esperando en caja no es un problema del cajero. Marcar como "crítico" un
pedido cuyo cliente aún no llega es ruido, no señal.

**Qué quitar (verificado por grep):**

| Capa | Archivo | Qué |
|------|---------|-----|
| Backend | `cajero-monitor.service.ts:4` | import de `calcularUrgencia` |
| Backend | `cajero-monitor.service.ts:10` | const `UMBRALES_TIENDA` |
| Backend | `cajero-monitor.service.ts:98,142` | `nivelUrgencia` en los dos mapeos |
| Backend | `cajero-monitor.service.ts:158` | `alertasCriticas` (filtra `minutosEnCola >= 10`) |
| Backend | `cajero-monitor.controller.ts:1` | si el DTO expone el campo |
| Frontend | `lib/types/index.ts` | `nivelUrgencia` en `MonitorPedidoCajero` |
| Frontend | `MonitorTopBar` | prop `alertasCriticas` (el cajero la pasa) |
| Frontend | `cajero-monitor/page.tsx:108` | `alertasCriticas={data.contadores.alertasCriticas}` |

**Qué NO quitar:**

- **`minutosEnCola`** se conserva: es dato útil ("lleva 12 min en cola") aunque
  no se pinte como urgencia. Si el negocio tampoco lo quiere, se quita después.
- **`urgencia.util.ts`** (`minutosEntre` + `calcularUrgencia`) se conserva: lo
  usa `monitor.service.ts` de bodega, que es el único que debe tener urgencia.
- **`MonitorTVCard` / `MonitorTeamStrip`** (componentes de bodega) no se tocan.
  El cajero **no los usa** — verificado: `MonitorCajeroVentanilla` y
  `MonitorCajeroGrid` no importan `MonitorTVCard`.
- **El monitor de mostrador nuevo no debe nacer con urgencia.** Si se copia de
  `cajero-monitor.service.ts` (que hoy la tiene), hay que quitarle el cálculo
  antes de escribirlo.

**Nota de coherencia:** el comentario de `MonitorCajeroGrid` (`TurnoSiguiente`)
ya dice *"El 'tiempo de espera' no aplica en TV bancaria (no se muestra)"*. O
sea: la TV ya dejó de **mostrar** el tiempo, pero el backend sigue
**calculándolo** y `alertasCriticas` sigue contando. Esta fase termina de
limpiarlo.

**Criterio de aceptación de la Fase 3**

1. Un pedido web liberado por mostrador aparece en la cola del cajero.
2. "Llamar siguiente" puede tomar un pedido web.
3. La TV de ventanillas muestra pedidos de ambos canales.
4. Un pedido a domicilio **no** aparece en el cajero (va por envío).
5. **La TV de cajero no muestra ni calcula urgencia** (el snapshot ya no trae
   `nivelUrgencia` ni `alertasCriticas`).
6. **El monitor de bodega sigue mostrando urgencia** (sin regresión).

---

### Fase 3 — El pago (cajero) — ✅ COMPLETADA (2026-09-25)

**Objetivo:** el cajero ve los pedidos web liberados por mostrador, no solo los
de kiosko.

**Lo que se implementó — los cinco puntos del candado:**

| # | Archivo | Cambio |
|---|---------|--------|
| 1 | `cajero.service.ts` guard | Eliminado el rechazo por canal; el gate real es el ESTADO |
| 2 | `cajero.service.ts` `llamarSiguiente` | Quitado el filtro `KIOSKO` |
| 3 | `cajero.service.ts` `obtenerColaVentanilla` | Default `'KIOSKO'` → `'TODOS'` |
| 4 | `cajero-monitor.service.ts` por ventanilla | Quitado el filtro `KIOSKO` |
| 5 | `cajero-monitor.service.ts` cola sin asignar | Quitado el filtro `KIOSKO` |

**Y los tres defaults de canal, en sincronía:** service, controller y
`(cashier)/cajero/page.tsx`.

**Exclusión explícita de domicilio:** al quitar el filtro de `KIOSKO`, los
pedidos a domicilio dejaban de estar excluidos de facto (un domicilio es WEB).
Se agregó `modoEntrega: { not: DOMICILIO }` a los tres `where` del cajero
(cola, `llamarSiguiente`, monitor ×2) y un guard en `tomarPedidoCajeroInterno`.

**Relojes de urgencia eliminados del cajero (decisión D13):** `calcularUrgencia`,
`UMBRALES_TIENDA`, `nivelUrgencia` (×2) y `alertasCriticas`. Se conservó
`minutosEnCola` como dato informativo y `urgencia.util.ts` (lo usa bodega).
`MonitorTopBar.alertasCriticas` pasó a opcional.

**Verificación:**

- 5 tests nuevos del monitor de cajero (54 en total de las fases 0-3), 123 pasan.
- `npm run build` limpio en ambos repos.
- **Prueba end-to-end con los servicios REALES**: antes de liberar no hay fila en
  `PedidoPendienteEnvio`; después de `liberar` sí (`externalId 1000000015`).
  Cancelar desde mostrador crea la reposición con el motivo.
- **Prueba del monitor**: el kiosko y el web aparecen en la cola del cajero, el
  domicilio no; los contadores ya no traen `alertasCriticas`.
- **Sin regresión en bodega**: conserva sus 6 usos de urgencia; el cajero tiene 0.

**Las fases 0-3 están listas. El flujo nuevo es desplegable.**

---

### Fase 4 (referencia) — El editor POS compartido (D2, D9)

**Objetivo:** mostrador puede agregar, quitar y cambiar cantidades, y ventas usa
el mismo componente.

**4.1 Extraer las piezas compartidas**

```
src/components/pedidos/ProductoPicker.tsx      ← desde ventas/BuscarProductoModal.tsx
src/components/pedidos/ItemEditorRow.tsx       ← desde PropuestaSheet.tsx:320
src/components/pedidos/EditorProductosSheet.tsx ← shell nuevo
```

- `ProductoPicker`: mover tal cual. Ya es genérico (dos modos, búsqueda,
  variantes, stepper). Solo cambia el import path.
- `ItemEditorRow`: extraer la función `FilaItemEditor` de `PropuestaSheet.tsx`.
  Ya recibe todo por props.
- `EditorProductosSheet`: el shell con `modo: 'propuesta' | 'mostrador'`, el
  estado (`quitados`/`cantidades`/`agregados`/`nota`), el cálculo del total y el
  gate de `hayCambios`. Es el `PropuestaSheet` actual parametrizado.

**4.2 Rewire de ventas (sin cambio de comportamiento)**

`PropuestaSheet` pasa a ser un wrapper delgado:

```tsx
export function PropuestaSheet(props) {
  return <EditorProductosSheet modo="propuesta" {...props} />;
}
```

Verificar que la pantalla de ventas se vea **idéntica** antes y después.

**4.3 El editor de mostrador**

`EditorProductosSheet modo="mostrador"`:

- Título "Ajustar pedido con el cliente", botón "Aplicar y regresar a bodega".
- Muestra los items con su estado de surtido (`disponibilidadTexto`,
  `estadoSurtidoVisual` — ya existen en `lib/utils/estadoSurtidoColor`).
- Al confirmar, el padre llama al endpoint nuevo.

**4.4 El endpoint de edición**

`POST /pedidos/mostrador/:id/ajustar` pasa a aceptar los items:

```ts
{
  nota: string,
  items: Array<{
    itemId?: number,        // existente a modificar/quitar
    tipo: 'completo' | 'parcial' | 'no-disponible' | 'agregado',
    cantidad?: number,
    productoId?: number,    // solo para 'agregado'
    precioCOId?: number,    // solo para 'agregado'
  }>
}
```

En `mostrador.service.ts`, dentro de `efectos` (misma transacción que la
transición a `REVIEWING`):

1. Aplicar `no-disponible` → `cancelada: true` en el item.
2. Aplicar `parcial` → `cantidad` nueva.
3. Aplicar `agregado` → crear `ItemPedido` con `original: false`, snapshot de
   nombres y `precioUnitario` congelado desde `PrecioCO` (§2.9).
4. Recalcular `subtotal`, `descuento`, `impuestos`, `total` del pedido.

Reusar la lógica de `propuesta.service.ts:658` (`aplicarCambiosDeBodega`) y
`:851` (`recalcularTotales`) — **extraerlas a un helper compartido** en
`core/` para no duplicar el recálculo.

**4.5 Validaciones del endpoint**

- Solo desde `EN_MOSTRADOR`.
- `precioUnitario` **nunca** se confía al cliente del API: se resuelve desde
  `PrecioCO` en el servidor. (Mismo principio que
  `propuesta.service.ts:125-130`, donde el total se recalcula.)
- El `precioCOId` debe pertenecer a la tienda del pedido.
- No permitir dejar el pedido sin items activos (espejo del guard de
  `surtido.service.ts:285`).

**4.6 UX para operación continua (tablet)**

El operador de mostrador hace esto decenas de veces al día. Requisitos:

- Sheet lateral derecho a pantalla completa en tablet, no modal centrado.
- Fila con imagen 48 px, código en `font-mono`, variante, stepper `−/+` grande y
  subtotal en vivo — ya es el diseño de `FilaItemEditor`.
- Búsqueda de producto con foco automático y filtrado client-side (ya lo hace
  `ProductoPicker`).
- Total propuesto grande y fijo en el footer, siempre visible.
- Botón de confirmar deshabilitado hasta que haya un cambio real (`hayCambios`),
  con el porqué visible — ya implementado.
- Touch targets ≥ 44 px, CTAs `h-12`.

**4.7 El badge de reingreso a bodega (D18, §3.7)**

- Reemplazar `esLiberado: boolean` por `motivoReingreso` en `MonitorPedidoDto`,
  conservando `esLiberado` durante la transición.
- Derivarlo en `monitor.service.ts` combinando `ItemPedido.original === false`
  con el último `HistorialPedido.estadoAnterior` (§3.7).
- Exponer `itemsNuevos: number` (conteo de `original: false && !cancelada`).
- Pintar el badge en el monitor de bodega con copy e icono por motivo.
- **Esto también arregla el caso 3, que ya está roto hoy**: la propuesta de
  ventas aprobada devuelve el pedido a `REVIEWING` con items nuevos y el
  bodeguero no tiene forma de saberlo salvo abriendo el historial.

**Criterio de aceptación de la Fase 4**

1. Ventas se ve y funciona **idéntico** a antes del refactor.
2. Mostrador puede agregar, quitar y cambiar cantidades y el pedido vuelve a
   `REVIEWING` con los items correctos.
3. El total recalculado coincide con la suma de los items.
4. Bodega ve el pedido ajustado en su monitor con los items nuevos.
5. Un intento de mandar `precioUnitario` falso desde el API no cambia el precio.
6. **El monitor de bodega distingue los tres motivos de reingreso** (§3.7) y
   muestra cuántos items nuevos trae cada uno.

---

### Fase 4 — El editor POS compartido (D2, D9) — ✅ COMPLETADA (2026-09-25)

**Objetivo:** mostrador puede agregar, quitar y cambiar cantidades, y ventas usa
el mismo componente.

**Componentes compartidos (extraídos, no duplicados):**

```
src/components/pedidos/ProductoPicker.tsx         ← era ventas/BuscarProductoModal
src/components/pedidos/ItemEditorRow.tsx          ← era FilaItemEditor de PropuestaSheet
src/components/pedidos/EditorProductosSheet.tsx   ← shell con `modo`
```

`PropuestaSheet` quedó como **wrapper delgado** (`<EditorProductosSheet
modo="propuesta" />`), así que ventas no cambió de comportamiento ni de
aspecto. El diff contra el original es solo el copy parametrizado y la
extracción de la fila — la lógica de estado es idéntica.

**Backend:**

- `core/totales.util.ts` — `recalcularTotalesPedido` + `contarItemsPendientes`
  extraídos de `PropuestaService` para que mostrador use **la misma** fórmula.
- `POST /pedidos/mostrador/:id/ajustar` acepta `items[]` con
  `tipo: completo | parcial | no-disponible | agregado`.
- `MostradorService.aplicarAjuste` corre dentro de `efectos` (misma transacción
  que la transición a `REVIEWING`), con validación previa fuera del tx.
- **El `precioUnitario` NUNCA se acepta del API**: se resuelve server-side desde
  `PrecioCO` con la lista del cliente (Fase 0).
- Guard: el ajuste no puede dejar el pedido sin items activos.
- `core/motivo-reingreso.ts` + `motivoReingreso`/`itemsNuevos` en el monitor de
  bodega (§3.7).

**Verificación:**

- `npm run build` limpio en ambos repos.
- **Prueba end-to-end con servicios reales**: ajuste parcial (2→3) + agregado
  funciona; `original: false` en el nuevo; subtotal 210 = suma de items; total
  205 = 210 − 10 + 5; el guard de "sin items" rechaza con mensaje claro.
- **Prueba del precio (Fase 0 conectada)**: con el cliente en lista 3 y listas
  distintas por variante, el producto agregado desde mostrador se congela en
  **300 (lista3), no 100 (lista1)**. Es la prueba de que el editor no heredó el
  bug original.

---

### Fase 5 (referencia) — El cierre y el pulido

**Objetivo:** la entrega final, la documentación y los tests.

**5.1 La entrega final (D4)**

`PAID → COMPLETED` por mostrador **ya existe** (`mostrador.service.ts:150`). Lo
que cambia es la UX: hoy la pantalla obliga a marcar cada producto en un
checklist. Con el flujo nuevo el cliente **ya revisó y aprobó** los productos en
la fase de mostrador, así que volver a verificar pieza por pieza es trabajo
duplicado.

- Simplificar `/mostrador/[id]` en estado `PAID`: confirmación ligera ("el
  cliente recogió su pedido"), sin checklist obligatorio.
- **Conservar** el checklist como opción colapsada para el caso en que el
  operador quiera re-verificar.
- El historial debe distinguir las dos fases: `HistorialPedido.observacion` ya
  lleva el texto, así que `liberar` y `entregar` quedan diferenciados.

**5.2 Documentación**

- `PLAN-MOSTRADOR-ANTES-DE-PAGO.md` (este archivo) → marcar fases completadas.
- Actualizar el comentario de cabecera de `pedido-state.service.ts` (es la
  documentación viva de la máquina de estados).
- `demo-frontend/CLAUDE.md`: la tabla de roles dice que MOSTRADOR "entrega
  pedidos en tienda" — actualizar a "muestra, libera y entrega pedidos".
- `demo-frontend/CLAUDE.md`: agregar `MOSTRADOR_MONITOR` a la tabla de roles.
- `REALTIME.md` del frontend: documentar `pedido.llamado-mostrador`.

**5.3 Tests**

- Unitarios: máquina de estados, las tres acciones de mostrador, el gate de
  llegada, el recálculo de totales.
- Integración: el camino completo
  `PENDING_REVIEW → REVIEWING → EN_MOSTRADOR → PENDING_PAID → PAID → COMPLETED`.
- Regresión: el camino de domicilio sin cambios; el camino de propuesta de
  bodega y de ventas sin cambios salvo el destino.
- Regresión: el flujo de ventas se ve idéntico (snapshot de la pantalla).

**5.4 Observabilidad**

El negocio necesita saber si hay pedidos atorados:

- Un pedido web en `EN_MOSTRADOR` sin llegada anunciada es un pedido que nadie
  va a recoger. **Agregar un contador** en el monitor de mostrador o en el panel
  admin: "pedidos listos sin cliente en tienda", con antigüedad.
- Un pedido en `EN_MOSTRADOR` con llegada avisada hace mucho es un cliente
  esperando. Ya lo cubre `esperandoDesdeMin`.

### Fase 5 — El cierre y el pulido — ✅ COMPLETADA (2026-09-25)

**5.1 La entrega final (D4)**

El checklist pieza-por-pieza pasó a ser **opcional y colapsado**. Con el flujo
nuevo el cliente ya revisó y aprobó los productos en mostrador antes de pagar,
así que re-verificar era trabajo duplicado. Se conserva plegado para el caso en
que el operador quiera re-verificar (pedido grande, duda), y si lo abre y deja
productos sin marcar, el footer avisa. El botón de confirmar ya no depende de
los checks.

**5.2 Documentación**

- `demo-frontend/CLAUDE.md`: tabla de roles con `BODEGA_MONITOR`,
  `CAJERO_MONITOR` y `MOSTRADOR_MONITOR`; sección nueva con el flujo del pedido
  y sus reglas.
- `demo-frontend/REALTIME.md`: evento `pedido.llamado-mostrador` documentado
  (payload, rooms, quién lo emite y consume) + nota del bridge muerto.
- `pedido-state.service.ts`: cabecera reescrita con el diagrama del flujo y los
  **dos invariantes** que sostienen el diseño.

**5.3 Tests**

- `flujo-completo.spec.ts` (7 tests): el camino
  `REVIEWING → EN_MOSTRADOR → PENDING_PAID → PAID → COMPLETED` con el encolado
  UNA sola vez, al final; el camino de ajuste (vuelve a bodega y regresa); el
  camino de domicilio que salta mostrador; y el invariante
  `PENDING_PAID ⟺ encolado`.
- `kiosko-llegada.service.spec.ts` (8 tests): regresión de B2 y B3.

**5.4 Observabilidad**

Contador `sinCliente` en el snapshot del monitor de mostrador: pedidos listos
que **nadie ha venido a recoger** (web en `EN_MOSTRADOR` sin aviso vigente),
con antigüedad para priorizar. Se pinta en la TV solo si hay alguno. Es la señal
para que el operador los persiga — sin esto se acumularían en silencio, porque
el gate de D5 los esconde de la cola.

**Bugs del plan arreglados en esta fase:**

- **B2** (anti-spam de llegada como tope de por vida): convertido en **límite de
  tasa** con `REINTENTO_WINDOW_MS` (10 min). Era el bug más grave que quedaba:
  con el gate de D5, un cliente que avisa 6 veces dejaba su pedido sin alerta en
  la TV para siempre. Arreglado en los dos caminos (kiosko y app).
- **B3** (guard del QR evadible): `user.userId === undefined` saltaba la
  validación de dueño, permitiendo obtener el QR firmado de cualquier pedido.
  Ahora falla cerrado.

**Verificación:**

- 15 tests nuevos (145 en total de las fases 0-5), 138 pasan.
- `npm run build` limpio en ambos repos.
- **Prueba end-to-end del contador**: el web sin aviso y el descartado aparecen
  en `sinCliente`; el web con aviso y el kiosko no; el sin-aviso no aparece en
  la cola.

### Auditoría adversarial post-implementación (2026-09-25)

Se corrió una auditoría con 44 agentes (8 dimensiones × verificación
adversarial) sobre las fases 0-4. Encontró **5 bloqueantes**, todos verificados
por lectura directa antes de arreglarlos. Todos corregidos:

| # | Bug | Impacto | Arreglo |
|---|-----|---------|---------|
| A1 | `ajustar` con `parcial` que SUBE la cantidad dejaba el item `COMPLETO` con el `cantidadSurtida` viejo | **El cliente pagaba piezas que bodega nunca apartó** | La rama `parcial` ahora pasa el item a `PENDIENTE` si la cantidad sube (vuelve a bodega); si baja, ajusta `cantidadSurtida` |
| A2 | `aprobarPropuestaBodega` podía llegar a pago con CERO items activos | **Pedido cobrado sin productos** (subtotal/total en 0) | Guard de items activos, espejo del de `confirmarSurtido` y el del ajuste |
| A3 | `tomarGrupo`/`tomarPedido` no validaban estado | Un bodeguero podía **arrancar un pedido de `EN_MOSTRADOR`** (desaparecía de la cola de mostrador) o de `PENDING_PAID` (desincronizaba el ERP) | Filtro de estado en la carga + guard en el `updateMany` + guard en `tomarPedido` |
| A4 | El aviso de llegada no invalidaba la cola de revisión | **El caso de uso central del flujo quedaba inalcanzable**: el cliente avisaba y su pedido no aparecía en la consola | `qc.invalidateQueries(['cola-mostrador'])` en el handler |
| A5 | `MOSTRADOR_MONITOR` no estaba en `ROLES_EMPLEADO` | El rol nuevo **no se podía crear desde el admin** (400) | Agregado al array |

**Refuerzo del invariante de dinero:** además del arreglo puntual de A1, se
agregó a `confirmarSurtido` una validación que rechaza cualquier item
`COMPLETO` con `cantidadSurtida < cantidad`. Es la red que atrapa **cualquier**
camino futuro que deje el item incoherente, no solo el que conocemos.

**No-bloqueantes corregidos:** el fallback del timeline pintaba TODOS los pasos
en verde para estados sin paso propio (mostraba "Entregado" en un pedido en
asesoría) — ahora avanza solo hasta la etapa real del pedido.

**No-bloqueantes — ✅ TODOS CORREGIDOS (2026-09-25):**

| # | Bug | Arreglo |
|---|-----|---------|
| N1 | `/favoritos` ignoraba la lista de precios (devolvía lista1 para todos) | Inyectado `PreciosService`; resuelve `precioBase` y las variantes con la lista del cliente. Verificado: lista 3 → 300, sin lista → fallback a lista1 |
| N2 | `MOSTRADOR_MONITOR` no podía hacer logout ni ver su perfil (403) | Agregado a los 5 `@Roles` de `auth.controller.ts` (logout, me, update-profile, change-password, heartbeat) |
| N3 | Paginación compartida entre las dos pestañas de la consola | `paginaRevision` y `paginaEntrega` separadas; la cola de revisión tiene su propia `<Pagination>` y el badge del tab usa el total real |
| N4 | El contador de anti-spam no se reiniciaba si los avisos llegaban más seguido que la ventana | Columna nueva `llegadaUltimaEmisionAt` como ancla (no `llegadaUltimoAvisoAt`, que se reescribe en cada request). Migración `20260925020000` |
| N5 | No había endpoint para descartar un aviso de llegada falso | `POST /pedidos/mostrador/:id/descartar-llegada` + botón en la consola. `llegadaDescartadaAt` ahora sí se escribe (se leía en 6 lugares sin forma de poblarla) |

**Tests:** 156 pasan (los 2 fallos son los preexistentes de `sync-agent`).

### Ajustes post-auditoría (2026-09-25, tarde)

**1. El aviso de llegada solo se acepta en `EN_MOSTRADOR`.**

Antes solo se rechazaban `COMPLETED` y `CANCELLED`, así que el cliente podía
avisar desde `PENDING_REVIEW`: su pedido quedaba marcado "EN TIENDA" **antes de
que nadie lo hubiera surtido**, y el mostrador no tenía nada que mostrarle.

`EN_MOSTRADOR` es exactamente el punto correcto: bodega terminó de verificar (o
el cliente aprobó las modificaciones de bodega/ventas). Guard aplicado en los
dos caminos (`cliente.service.anunciarLlegada` y
`kiosko-llegada.service.confirmar`), con un mensaje por estado que explica por
qué todavía no se puede. El frontend oculta la tarjeta fuera de ese estado.

**2. El re-aviso tras un descarte estaba roto.**

El guard de idempotencia de 60s no consideraba `llegadaDescartadaAt`. Si el
operador descartaba el aviso (el cliente no estaba) y el cliente volvía a
avisar dentro del minuto —lo normal, porque el descarte ocurre en cuanto no se
le ve— recibía "ya avisamos al equipo" y **su pedido no volvía a la cola**,
quedándose sin forma de re-avisar.

Ahora un aviso descartado se puede re-mandar de inmediato (el descarte invalida
el aviso anterior, no tiene sentido esperar la ventana). El frontend también
dejó de mostrar "Ya avisamos que llegaste" cuando el aviso fue descartado.

**3. Contraste de los botones verdes.**

`--accent-foreground` y `--success-foreground` pasaron de `#1c1917` (casi
negro) a `#ffffff` en ambos modos. El verde de marca (`#6ebd50`) es lo bastante
oscuro para que el texto negro se leyera mal. Arregla de una sola vez todos los
botones verdes (avisar llegada, CTAs de mostrador/cajero/bodega/ventas) y los
badges del monitor. Los iconos heredan el blanco por `currentColor`.
`--sidebar-accent-foreground` se dejó intacto: su fondo es gris claro, no verde.

**4. Protección contra doble click — 6 archivos.**

Auditoría de 20 agentes sobre ~70 botones de mutación: 6 confirmados, 3
parciales, 6 refutados. Los arreglos fueron `disabled={isPending}` (o por-fila
con `variables === id`), guards tempranos en el handler, y en el único caso que
no era un `<button>` sino un `<div role="button">` (tarjeta de ventanilla)
además `pointer-events-none`, porque un div no soporta `disabled` real.

Archivos: `ElegirVentanillaModal`, `(cashier)/cajero/page`,
`admin/usuarios/page`, `ProductoImagenesSheet`, `(customer)/confirmacion/page`,
`BodegaLoteSheet`. Los botones críticos (confirmar pedido, confirmar surtido,
confirmar entrega) **ya estaban protegidos**.

**Tests:** 172 pasan (los 2 fallos son los preexistentes de `sync-agent`).

---

## 6. Riesgos y mitigaciones

| # | Riesgo | Probabilidad | Impacto | Mitigación |
|---|--------|--------------|---------|------------|
| R1 | Un filtro de estado olvidado deja pasar un pedido a pago antes de mostrador | Media | Alto | El estado nuevo hace que el pago exija `PENDING_PAID`, y a ese estado solo se llega por liberación. Un pedido en `EN_MOSTRADOR` es invisible para el cajero por construcción. |
| R2 | El barrido de `Record<EstadoPedido>` deja algo fuera | Baja | Medio | TypeScript rompe la compilación. La lista de §4.2 está verificada por grep. |
| R3 | Pedidos en vuelo al desplegar | Baja | Bajo | El cambio solo afecta transiciones nuevas. Un pedido en `PENDING_PAID` ya está encolado y sigue a `PAID` normal. Sin migración de datos. |
| R4 | El ERP queda desincronizado si mostrador ajusta después de liberar | Baja | Alto | Con D3 el ajuste ocurre **antes** del encolado. Una vez liberado, el pedido ya no se puede ajustar (solo cancelar, que ya se sincroniza por `SWCANCEL`). |
| R5 | Pedidos web que nunca se recogen se acumulan en `EN_MOSTRADOR` | Alta | Medio | Contador de antigüedad (§5.4). Decidir con el negocio una política (¿cancelar tras N días?). **Pendiente de definir con el negocio.** |
| R6 | El refactor del editor rompe la pantalla de ventas | Media | Medio | La Fase 4 deja `PropuestaSheet` como wrapper delgado y exige verificar que la pantalla se vea idéntica. Test de regresión. |
| R7 | Doble encolado a Firebird | Baja | Alto | `PedidoPendienteEnvio.pedidoId` es `@unique`: un segundo encolado falla con P2002. Es intencional (`pedido-state.service.ts:352`). No agregar manejo que lo silencie. |
| R8 | El operador de mostrador no sabe que hay un pedido esperando | Media | Medio | La TV + el chime + el badge "EN TIENDA". Reusa el patrón que ya funciona en la consola actual. |
| R9 | Cambio de comportamiento en el flujo de domicilio | Baja | Alto | La bifurcación por `modoEntrega` está en un solo lugar (`confirmarSurtido`) y tiene test dedicado. |
| R10 | **El editor POS hereda el bug de precio por lista** | Alta si no se hace la Fase 0 | Alto (dinero) | La Fase 0 extrae el helper compartido y lo aplica en los tres sitios **antes** de construir el editor. |
| R11 | El bug de precio por lista sigue cobrando mal mientras no se despliegue la Fase 0 | **Cierta hoy** | Alto (dinero) | Es un bug vivo, no un riesgo del cambio. Desplegar la Fase 0 cuanto antes, por separado. |
| R12 | **Un pedido a domicilio con faltante aterriza en `EN_MOSTRADOR` y queda atorado** | **Alta** | Alto | Los caminos de propuesta no leen `modoEntrega` (§1.4). Mitigación: el helper único `destinoTrasSurtido` usado en los tres sitios. Es el riesgo más probable de pasar por alto. |
| R13 | El timeline del cliente se pinta entero en gris (B1) | Cierta si no se arregla | Medio | `indexOf` devuelve `-1`. El compilador no lo delata. Agregar `EN_MOSTRADOR` a `ordenEstados` + fallback explícito. |
| R14 | **El anti-spam de llegada deja el pedido invisible para siempre (B2)** | Cierta si no se arregla | **Alto** | El contador nunca se reinicia y la llegada es el gate de D5. Bloqueante para la Fase 2. |
| R15 | El guard del QR es evadible (B3) | Media | Alto (seguridad) | `userId === undefined` salta la validación de dueño. Arreglar la condición. |
| R16 | **Sin UI de llegada web, D5 es inalcanzable (B5)** | **Cierta hoy** | Alto | El endpoint existe pero no tiene caller. Es requisito de la Fase 2, no un extra. |
| R17 | El bridge realtime del mostrador es código muerto (B4) | Cierta hoy | Medio | Con realtime ON el polling se apaga y los avisos no aparecen. Usar `useRealtimeEvents`. |
| R18 | Doble transición en `aprobarPropuestaVentas` deja una ventana donde un bodeguero toma el pedido | Media | Medio | Colapsar en una sola transición (§1.4). |
| R19 | El poll del agente no filtra por estado: si se encola antes de la aprobación, Firebird cobra antes de que el cliente apruebe | Baja (con D3) | Alto | Refuerza D3: el encolado va en la liberación, no antes. |

---

## 7. Verificación

### 7.1 El camino completo, paso a paso

| # | Acción | Actor | Estado esperado | Verificar además |
|---|--------|-------|-----------------|------------------|
| 1 | Cliente pide en kiosko | Cliente | `PENDING_REVIEW` | — |
| 2 | Bodega toma y surte | Bodega | `REVIEWING` | Ocupa 1 de 4 slots |
| 3 | Bodega confirma (completo) | Bodega | `EN_MOSTRADOR` | **Sin fila en `PedidoPendienteEnvio`** |
| 4 | Aparece en la cola de mostrador | — | `EN_MOSTRADOR` | Visible sin llegada (es kiosko) |
| 5 | Mostrador llama al cliente | Mostrador | `EN_MOSTRADOR` | TV muestra alerta, suena |
| 6 | Cliente pide 2 playeras más | Cliente | `EN_MOSTRADOR` | — |
| 7 | Mostrador ajusta | Mostrador | `REVIEWING` | Sin asignar, reloj reanudado, items nuevos |
| 8 | Bodega surte lo nuevo | Bodega | `EN_MOSTRADOR` | Vuelve a la cola de mostrador |
| 9 | Cliente está de acuerdo | Cliente | `EN_MOSTRADOR` | — |
| 10 | Mostrador libera | Mostrador | `PENDING_PAID` | **Aparece fila en `PedidoPendienteEnvio`** |
| 11 | Agente baja el pedido | Sistema | `PENDING_PAID` | `externalFolio` poblado |
| 12 | Cajera llama al cliente | Cajero | `PENDING_PAID` | TV de ventanillas, `cajeroAsignadoId` |
| 13 | Cliente paga en VFP | Sistema | `PAID` | Webhook `marcar-pagado`, email |
| 14 | Mostrador entrega | Mostrador | `COMPLETED` | Email `ENTREGADO` |

### 7.2 El camino web

| # | Acción | Estado | Verificar |
|---|--------|--------|-----------|
| 1 | Cliente pide en web | `PENDING_REVIEW` | — |
| 2 | Bodega confirma | `EN_MOSTRADOR` | **No aparece en la cola de mostrador** |
| 3 | Cliente llega y avisa (botón en su app, o folio en el kiosko) | `EN_MOSTRADOR` | **Aparece** con badge EN TIENDA |
| 4 | Mostrador manda a llamar | `EN_MOSTRADOR` | **La TV muestra el folio/nombre — así se entera el cliente (D16)** |
| 5 | Mostrador libera | `PENDING_PAID` | Encolado a Firebird |

### 7.2b El camino de ajuste (el caso que motiva todo el cambio)

| # | Acción | Estado | Verificar |
|---|--------|--------|-----------|
| 1 | Cliente ve su pedido en mostrador | `EN_MOSTRADOR` | — |
| 2 | Pide 2 playeras más | `EN_MOSTRADOR` | — |
| 3 | Mostrador abre el editor y las agrega | `EN_MOSTRADOR` | Precio de **la lista del cliente** (Fase 0) |
| 4 | Mostrador confirma | `REVIEWING` | `asignacion: 'limpiar'`, `reloj: 'reanudar'` |
| 5 | El monitor de bodega lo muestra | `REVIEWING` | **Badge "Cambios del cliente · 2 nuevos"** (§3.7) |
| 6 | Bodega surte lo nuevo | `REVIEWING` | Solo los items `PENDIENTE` |
| 7 | Bodega confirma | `EN_MOSTRADOR` | Vuelve a la cola de mostrador |
| 8 | Cliente conforme, mostrador libera | `PENDING_PAID` | **Ahora sí entra a Firebird** |

### 7.3 El camino de domicilio (regresión)

| # | Acción | Estado | Verificar |
|---|--------|--------|-----------|
| 1 | Cliente pide a domicilio | `PENDING_REVIEW` | — |
| 2 | Bodega confirma | `PENDING_PAID` | **Encolado inmediato, no pasa por mostrador** |
| 3 | Paga | `PAID` | — |
| 4 | Se envía | `SHIPPED` | — |
| 5 | Se entrega | `COMPLETED` | — |

### 7.4 Los caminos de propuesta (regresión)

| Origen | Decisión | Antes | Ahora |
|--------|----------|-------|-------|
| Bodega | Aprobar | `PENDING_PAID` | **`EN_MOSTRADOR`** |
| Bodega | Rechazar | `CANCELLED` + reposición | sin cambio |
| Bodega | Pedir asesor | `EN_ASESORIA` | sin cambio |
| Ventas | Aprobar, con items pendientes | `REVIEWING` | sin cambio |
| Ventas | Aprobar, sin items pendientes | `PENDING_PAID` | **`EN_MOSTRADOR`** |
| Ventas | Rechazar | `EN_ASESORIA` | sin cambio |
| Ventas | Cancelar | `CANCELLED` + reposición | sin cambio |

### 7.5 Comandos

```bash
# Backend
cd demo-backend
npx prisma migrate dev --name pedido_en_mostrador
npm run build
npm test

# Frontend
cd demo-frontend
npm run build
npm run lint
```

---

## 8. Orden recomendado

0. **Fase 0** — el precio por lista. Es un bug vivo que toca dinero y es
   independiente del cambio de flujo. **Se despliega sola, ya.** Además la Fase 4
   depende de ella para no heredar el bug.
1. **Fase 1** — el estado y la máquina. Es el cimiento; sin esto nada más
   funciona. Se prueba con Swagger/curl, sin tocar el frontend.
2. **Fase 2** — el monitor y la consola de mostrador. Aquí el flujo se vuelve
   operable de verdad.
3. **Fase 3** — el pago. Sin esto, los pedidos web liberados se quedan atorados
   en `PENDING_PAID` sin que el cajero los vea.
4. **Fase 4** — el editor POS. Es el feature más grande y el más independiente;
   se puede posponer sin bloquear el flujo.
5. **Fase 5** — el cierre, la documentación y la observabilidad.

**Las fases 1, 2 y 3 van juntas en el mismo despliegue.** La 1 sola deja los
pedidos atorados (nadie los libera); la 1+2 sin la 3 los deja atorados en pago.
La 0 va antes que todo lo demás y por separado. La 4 y la 5 se despliegan
después.

---

## 9. Decisiones cerradas

**Todas las decisiones están tomadas.** Esta sección reemplaza a la lista de
pendientes: ya no hay preguntas abiertas.

### Del negocio (sep 2026)

| # | Pregunta | Decisión |
|---|----------|----------|
| 1 | Pedidos web que nunca se recogen | El cliente pregunta en tienda y le dicen que avise su llegada en el kiosko. No se cancela automáticamente; mostrador orienta. |
| 2 | ¿Mostrador libera sin el cliente presente? | **Sí.** Registrar en historial que se liberó sin aviso de llegada. |
| 3 | ¿El ajuste cambia precios? | **No.** El precio lo determina la lista del usuario que hizo el pedido. Ver §2.11 (bug vivo, Fase 0). |

### Técnicas (sep 2026)

| # | Pregunta | Decisión | Dónde |
|---|----------|----------|-------|
| 4 | Rol de la TV de mostrador | **`MOSTRADOR_MONITOR` dedicado** | §2.1, Fase 2 |
| 5 | Quién surte lo que mostrador agrega | **Vuelve a bodega** (`EN_MOSTRADOR → REVIEWING`) | §3.2, Fase 1 |
| 6 | Relojes de urgencia | **Solo en bodega.** Quitarlos de cajero y mostrador | Fase 3.5 |
| 7 | ¿Mostrador cancela un pedido ya liberado? | **Sí**, vía `PENDING_PAID → CANCELLED` + `SWCANCEL` | §3.2 |
| 8 | UI de llegada del cliente web | **Sí, construirla** (botón en el detalle del pedido) | §2.8, Fase 2 |
| 9 | Aviso de "pedido listo" al cliente | **El monitor ES el canal**, estilo banco. Sin email nuevo | §2.9 |
| 10 | Chat durante `EN_MOSTRADOR` | **Abierto** | Fase 2 |
| 11 | Badge de reingreso a bodega | **Sí** — `motivoReingreso` con 3 valores | §3.7, Fase 4 |

### Decisiones que quedaron sin efecto

- **Enviar el QR al entrar a `EN_MOSTRADOR`** (dependencia circular del QR): con
  la decisión 9, el monitor es el canal de aviso y el QR deja de ser necesario
  para el flujo. No se agrega `TipoNotificacion` nuevo. §2.9.
- **Columna `mostradorLiberadoAt` para medir el tiempo de espera en caja**: con
  la decisión 6, cajero y mostrador no miden urgencia, así que la columna no hace
  falta. Cero migración adicional.

### Lo que sigue requiriendo confirmación al implementar

No son decisiones de diseño, son cosas que se ajustan al ver el resultado:

- **El copy exacto** de los badges de §3.7 y de los estados en cada superficie
  (§4.2). El plan propone textos; se afinan en la implementación.
- **El umbral de "pedido viejo"** para el contador de §5.4 (pedidos listos sin
  cliente en tienda). El plan no fija un número.
- **Si `minutosEnCola` se queda** en la TV de cajero como dato informativo
  (decisión: sí, por ahora) o se quita también.

