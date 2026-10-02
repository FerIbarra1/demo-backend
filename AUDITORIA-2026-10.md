# Auditoría Playerytees — frontend + backend

> **Fecha**: 2 oct 2026
> **Alcance**: `demo-frontend/src` (288 archivos) y `demo-backend/src` (28 suites)
> **Estado base**: `tsc --noEmit` limpio en ambos · `eslint` limpio en backend ·
> 280/282 tests del backend pasando
>
> **Cómo leer esto**: los 6 hallazgos críticos están verificados leyendo el código
> fuente línea por línea. El inventario de duplicación y los hallazgos medios vienen
> de análisis paralelos; los contrasté donde el impacto era alto, pero los de menor
> impacto pueden tener algún falso positivo. Cada hallazgo lo indica.

---

## Resumen

| | |
|---|---|
| Bugs críticos verificados | 6 |
| Hallazgos medios | 9 |
| Candidatos a componente compartido | 11 |
| Cosas que NO hay que tocar | 5 |

**Conclusión corta**: el proyecto está sano. El diseño de sesión/redirecciones y la
máquina de estados del backend son de primera. Lo pendiente es precisión, no rescate.

**Sobre tu pregunta central**: la duplicación real no está donde parecía. Mostrador y
cajero comparten *palabras* ("llamar", "liberar"), no implementaciones — son acciones
genuinamente distintas y fusionarlas sería el error. Lo que sí está duplicado
literalmente es el andamiaje: estados vacíos, bloques de error, badges y tarjetas.

---

## 01 — Bugs críticos

### 1.1 El webhook del ERP y el agente de sync no pueden autenticarse
`verificado`

`admin.controller.ts:65` y `sync-agent.controller.ts:32` declaran
`@UseGuards(ApiKeyGuard)` + `@ApiKeyAuth()` para aceptar el header `X-Agent-Key`.
Pero `@ApiKeyAuth()` sólo escribe la metadata `isApiKeyAuth` — nunca `isPublic`, que
es lo único que `JwtAuthGuard` consulta para eximir una ruta.

Los guards globales (`app.module.ts:72`) corren **antes** que los de controller. Así
que `JwtAuthGuard` exige un JWT válido y lanza 401 antes de que `ApiKeyGuard` llegue
a evaluarse.

**Impacto**: el agente Firebird no puede marcar pedidos como pagados, y el agente de
sync no puede subir eventos. Son los dos caminos de integración externa del sistema.

**Arreglo**: añadir `@Public()` a los endpoints con `@ApiKeyAuth()` —
`ApiKeyGuard` ya valida la key por su cuenta. Verificar en runtime con una llamada
real antes de dar por cerrado.

### 1.2 Los mensajes de error del backend nunca llegan al usuario
`verificado`

El interceptor de axios siempre rechaza con un objeto plano
`{ statusCode, message, error, codigo }` (`axios.ts:276`). Pero `getErrorMessage`
(`utils.ts:15`) comprueba `e instanceof AxiosError` y luego `e instanceof Error`. Un
objeto plano no es ninguna de las dos, así que cae siempre al fallback.

El propio código ya documenta el problema en `transport-error.ts:66`. Existe el helper
correcto (`mensajeDeError`) y se usa en 14 sitios; el roto se usa en **44**.

**Impacto**: 44 flujos muestran un toast genérico en vez del mensaje real. El usuario
nunca ve "el límite de 4 pedidos simultáneos" ni ninguna otra regla de negocio que el
backend sí está explicando.

### 1.3 Propuesta y mensaje no se crean de forma atómica
`verificado`

`messages.service.ts:252` documenta: "se crea la `PedidoPropuesta` y el
`PedidoMensaje` en la misma transacción". No ocurre. `enviarPropuesta`
(`propuesta.service.ts:213`) abre y confirma su **propia** transacción, y luego el
`pedidoMensaje.create` (`messages.service.ts:333`) corre fuera de cualquier
transacción.

**Impacto**: si el segundo create falla, queda una propuesta viva sin el mensaje de
chat que la muestra. El cliente tiene una propuesta pendiente que no puede ver ni
responder — exactamente el bug que el comentario dice haber resuelto.

### 1.4 Un fallo de base de datos se traga el correo al cliente
`verificado`

`messages.service.ts:186` envuelve el `create` del flag anti-duplicado en un
`catch {}` que asume P2002 ("otro hilo ya creó el flag"). No comprueba `err.code`.

El patrón correcto ya existe en el repo, a tres archivos de distancia:
`cliente.service.ts:281` hace `if (err.code !== 'P2002') throw err;`.

**Impacto**: si la BD falla o hay timeout, el método retorna en silencio y el cliente
nunca recibe el correo "tu asesor te contactó". Sin log de error, sin rastro.

### 1.5 Un cliente puede suscribirse a los pedidos de otro cliente
`verificado`

`realtime.gateway.ts:185` autoriza el ingreso al room `pedido-{id}` con
`esDeSuTienda`: basta que el `tiendaId` del JWT coincida con el del pedido. Pero un
usuario `CLIENTE` también lleva `tiendaId` en el token (`jwt.strategy.ts:42`).

`PedidoAccessService.validar` sí distingue al cliente correctamente; el gateway
reimplementó la regla por su cuenta y le quedó más permisiva. Es la tercera copia de
las reglas de acceso del sistema.

**Impacto**: un cliente puede unirse al room de un pedido ajeno de su tienda y recibir
en vivo los mensajes de chat, los cambios de surtido y las transiciones de estado de
ese pedido.

### 1.6 El cliente no ve avanzar su propio pedido
`verificado`

`usePedidosCliente.ts:57` (`useMiPedido`) no tiene `refetchInterval`. Los handlers
realtime de `(customer)/pedidos/[id]/page.tsx:288` cubren `mensaje.creado`,
`propuesta.enviada` y `propuesta.respondida` — pero **no** `pedido.estado`.

**Impacto**: el cliente que se queda mirando su pedido no ve el paso a "Pagado",
"Enviado" ni "Entregado". Tiene que recargar a mano. En un flujo cuyo objetivo
declarado es que el cliente siga su pedido, es el hueco más visible.

---

## 02 — Hallazgos medios

### 2.1 Cinco etiquetas de estado dicen una cosa en la app y otra en el correo
`verificado`

`lib/types/index.ts:195` y `mail/estado-labels.ts:8` son dos mapas mantenidos a mano.
El comentario del frontend dice que EN_MOSTRADOR usa "el mismo texto que el backend" —
y sí, esa coincide. Las otras cinco ya divergieron:

| Estado | Frontend | Backend / correo |
|---|---|---|
| PENDING_REVIEW | Pendiente de revisión | Recibido · en cola de revisión |
| REVIEWING | En revisión | En revisión por bodega |
| WAITING_CUSTOMER_APPROVAL | Esperando tu aprobación | Propuesta pendiente de tu aprobación |
| PAID | Pagado | Pago confirmado |
| SHIPPED | Enviado | Enviado · en camino |

Hay un tercer vocabulario en `kiosko-llegada.service.ts:583`.

### 2.2 Cuatro copias de "¿quién puede operar este pedido en bodega?"
`verificado`

El bloque `esMioComoBodega / enRevisionLibre / enRevisionDeOtro / puedeTomar /
puedeIrASurtir` está copiado en `bodega/page.tsx:455`,
`bodega/pedidos/[id]/page.tsx:155`, `PedidoPreviewModal.tsx:216` y
`BodegaSurtidoSheet.tsx:331` — idéntico salvo el nombre de la variable del usuario.

**Impacto**: si cambia la regla de quién puede surtir, hay cuatro ediciones y tres
oportunidades de olvidar una.

### 2.3 Dos mapas de estado locales que ya se contradicen
`verificado`

`bodega/pedidos/[id]/page.tsx:62` y `PedidoPreviewModal.tsx:47` definen cada uno su
propio `estadoVisual` con las mismas 10 claves. Ya divergieron en 5 iconos:
`PENDING_REVIEW` es `Clock` en uno y `PackageCheck` en el otro; `EN_MOSTRADOR` es
`Store` contra `PackageCheck`.

Ambos conviven con el `estadoVisual` real de `lib/utils/estadoColor.ts`, que sí es la
fuente única de color. Los locales sólo añaden icono y descripción — pero con el mismo
nombre, lo que hace creer que son el mismo módulo.

### 2.4 Cuatro escrituras de estado se saltan la máquina de estados
`verificado`

`PedidoStateService` es una máquina de estados real y bien diseñada, con
`TRANSICIONES` declaradas y 24 call sites que la respetan. Pero cuatro lugares
escriben `estado` directo: `bodega.service.ts:305` (liberar), `bodega.service.ts:875`
(tomar grupo), `admin.service.ts:176` (marcar pagado), más `cambiarEstadoPorSistema`
(`pedido-state.service.ts:466`), que es una segunda implementación de ~70 líneas que
ya divergió: no soporta `invalidarMonitor` ni limpia `llamadoAt`.

Además, el propio archivo declara que `encolarFirebird` es "obligatorio" al pasar a
`PENDING_PAID` — y no lo valida. Un caller futuro que lo olvide deja el pedido
invisible al ERP para siempre.

### 2.5 El payload de realtime miente sobre el estado anterior
`verificado`

`admin.service.ts:217` emite `estadoAnterior: PENDING_PAID` como literal, aunque el
agente externo puede llegar desde cualquier estado no terminal. El historial en BD sí
guarda el estado real.

**Impacto acotado**: el frontend consume `estadoAnterior` del *historial*, no del
payload de realtime. Es una inconsistencia latente, no un bug visible hoy.

### 2.6 La cola de "surtir juntos" no se refresca al tomar o liberar
`por confirmar`

`useSurtirJuntos` (`usePedidosBodega.ts:170`) quedó reemplazado por
`useSurtirJuntosCola`, pero tres mutaciones siguen invalidando su key muerta
`['surtir-juntos-bodega']` en vez de la viva `['surtir-juntos-cola-bodega']`.

**Impacto**: con realtime apagado, la cola que el bodeguero ve no se refresca al
tomar, liberar o agrupar hasta el siguiente poll de 15 s.

### 2.7 Dos tipos con el mismo nombre y valores distintos
`por confirmar`

`DecisionPropuesta` existe dos veces: `lib/propuesta.ts:26` con
`'aprobar' | 'rechazar' | …` en minúsculas, y `api/pedidos.ts:829` con
`'APROBAR' | 'RECHAZAR' | …` en mayúsculas. Uno es legacy y otro es el vigente, pero
comparten nombre.

Igual con `PropuestaItem` / `ItemPropuesta` y `Ventanilla` / `VentanillaAdmin` — este
último obliga a un `as ItemPropuesta` que existe sólo por la duplicación.

### 2.8 Errores de red convertidos en "no hay nada aquí"
`por confirmar`

`kiosko/welcome/page.tsx:112` hace `.catch(() => null)` sobre
`obtenerActivoPorTienda`. Un fallo de red se convierte en "esta tienda no tiene kiosko
activo" — un mensaje que manda al operador a buscar el problema en el lugar
equivocado.

### 2.9 Cuatro formas de leer el mensaje de un error
`verificado`

Conviven `getErrorMessage` (roto, 44 usos), `mensajeDeError` (correcto, 14 usos), y
dos copias locales de `mensajeDeError` en `admin/kioskos/page.tsx:51` y
`ProductoImagenesSheet.tsx:34`. Se arregla junto con 1.2.

---

## 03 — Candidatos a componente compartido

### Sí — extraer

| # | Qué | Por qué |
|---|---|---|
| 1 | `EmptyState` y `ErrorState` inline | Los componentes ya existen en `components/common/` y su docstring dice "había seis bloques inline distintos". Mostrador todavía tiene 4 copias sin migrar, y cajero una de ErrorState. **Cero riesgo.** |
| 2 | Badge "EN TIENDA · N min" | Duplicado literal, 9 líneas, dos veces en el mismo archivo (`mostrador/page.tsx:469` y `:793`). |
| 3 | Botón "El cliente está aquí" | Mismo handler, mismo copy, mismo icono; sólo cambia el estilo. `mostrador/page.tsx:589` y `MostradorAccionesPedido.tsx:261`. |
| 4 | Tarjeta de pedido del mostrador | `ColaRevision` y `PedidoListItem` son ~85% idénticas, en el mismo archivo. Se unifican con una prop de variante. |
| 5 | Permisos de bodega | 4 copias idénticas. Extraer a `lib/utils/transicionesPedido.ts` elimina 40 líneas y el riesgo de divergencia. |
| 6 | Mapas `estadoVisual` locales | Fusionar los dos en `estadoColor.ts`, junto al color que ya vive ahí. Ya divergieron en 5 iconos. |
| 7 | `ConfirmDialog` | 4 diálogos con la misma estructura y distinto copy (entregar, cancelar, liberar, eliminar). No existe ninguno en `common/`. |
| 8 | Fábrica de polling | `status === 'connected' ? false : N` aparece 15 veces en 6 hooks. Ya existe el precedente `useMonitorPolling`. |
| 9 | `canalLabel()` | El util existe, su docstring pide usarlo, y quedan 8 ternarios crudos `=== 'KIOSKO' ? 'Kiosko' : 'Web'`. |
| 10 | `formatFechaHora()` | `new Date(x).toLocaleString('es-MX')` está inline 15+ veces. `date.ts` no lo tiene. |
| 11 | `RoleShell` y layout de monitor | 4 shells de rol y 3 layouts de TV idénticos salvo el texto. Parametrizar. |

### No — dejarlo como está

- **Las tres acciones "liberar"**. Mostrador libera a pago (entra al ERP,
  irreversible); cajero deshace una asignación de ventanilla; bodega devuelve a la
  cola. Mismo verbo, tres semánticas. El sufijo `Mostrador` en el nombre del hook es
  correcto.
- **`MostradorAccionesPedido` vs. las filas del cajero**. No comparten acciones:
  mostrador tiene llamar/liberar/ajustar/cancelar/descartar/marcar-llegada; cajero
  tiene tomar/liberar-ventanilla. Son consolas distintas y deben verse distintas.
- **`ListToolbar` en bodega y cajero**. Lo evitan a propósito y está documentado en
  `bodega/page.tsx:324`. Es una decisión, no un olvido.
- **Los monitores de TV**. Quedan fuera del patrón a propósito: pantallas de pared,
  sin buscador ni paginación, con paleta fría de alto contraste propia.
- **La tarjeta de ventas**. Estructuralmente distinta (items truncados, nota del
  cliente) y el archivo lo justifica.

> **El patrón que ya funciona bien**: `PropuestaSheet` es un wrapper de 21 líneas
> sobre `EditorProductosSheet` con `modo="propuesta"`. Ese es el patrón correcto para
> los casos de arriba: un componente parametrizado, no dos copias.

---

## 04 — Plan por fases

### Fase 1 — Bugs críticos, sin tocar arquitectura
Los seis hallazgos de la sección 01. Arreglos quirúrgicos: un `@Public()`, un helper
unificado, un `err.code`, una transacción, un predicado de acceso, un handler de
realtime.
*Riesgo bajo · verificable con la suite existente*

### Fase 2 — Limpieza sin cambio de comportamiento
Migrar los `EmptyState`/`ErrorState` inline, unificar los dos mapas `estadoVisual`,
los 8 ternarios de canal, los 4 shells de rol, la fábrica de polling y las queryKeys
centralizadas. Nada de esto cambia lo que el usuario ve.
*Riesgo bajo · sin cambio visual*

### Fase 3 — Componentes compartidos de consola
Tarjeta de pedido unificada, badge EN TIENDA, botón marcar llegada, `ConfirmDialog`, y
el módulo de transiciones de pedido. Aquí sí cambia el render.
*Riesgo medio · cambia UI visible*

### Fase 4 — Dividir los servicios gigantes
`propuesta.service.ts` (1225 líneas, 7 responsabilidades) y `mostrador.service.ts`
(1000 líneas, 3 servicios en uno). Extraer la mutación de items (~300 líneas) y el
pricing a módulos propios.
*Riesgo alto · toca el corazón del dominio*

### Fase 5 — Endurecer la máquina de estados
Eliminar las 4 escrituras directas de `estado`, unificar `cambiarEstadoPorSistema`,
añadir el guard de `encolarFirebird`, y sacar los efectos de realtime fuera de la
transacción. Requiere tests de invariantes nuevos antes de tocar nada.
*Riesgo alto · requiere red de tests primero*

---

## 05 — Lo que ya está sano

- **El diseño de sesión y redirecciones es de primera.** `docs/AUTH-REDIRECTS.md`
  documenta el principio "un hecho = un escritor" y el loop de BroadcastChannel que
  rompía el login. El código lo cumple: los stores mutan y no deciden, los receptores
  cross-tab usan setters puros, el interceptor nunca navega, y un fallo de transporte
  nunca desloguea. Es la parte más madura del proyecto.
- **La máquina de estados del backend está bien diseñada.** `TRANSICIONES`
  declarativas, invariantes documentadas (`PENDING_PAID ⟺ fila en
  PedidoPendienteEnvio`), y 24 call sites que la respetan. Los problemas son los
  cuatro bypasses, no el diseño.
- **El trabajo sin commitear es bueno.** `llegada-aviso.util.ts` y `escaneo.util.ts`
  eliminan duplicación real con documentación clara del porqué. El refactor de
  `registrarAviso` en kiosko extrae un bloque que estaba copiado dos veces. Conviene
  commitearlo antes de empezar nada más.
- **El refactor de unificación ya está bien encaminado.** `components/common/` ya
  tiene PageHeader, EmptyState, ErrorState, FilterChips, ListToolbar, Pagination,
  StatCard y SearchInputWithScanner, con docstrings que explican qué reemplazan. Falta
  terminar de migrar, no diseñar de nuevo.
- **Hay red de tests.** 28 suites, 282 tests, 280 pasando. Cubren las invariantes del
  flujo completo, el encolado a Firebird, el dinero y la idempotencia de llegada.

---

## Apéndice — Estado de la suite

**2 tests fallan** en `sync-agent.service.spec.ts`:

- `does not execute a processed event twice` — espera `{procesados, errores,
  checkpointAvanzado}`, recibe además `deadLetters: 0`.
- `moves a repeatedly failing event to dead letter after the fifth attempt` — espera
  `{procesados: 0, errores: 1, checkpointAvanzado: false}`, recibe `{procesados: 0,
  errores: 0, checkpointAvanzado: true, deadLetters: 1}`.

Son **deriva de test/implementación**: el servicio empezó a devolver `deadLetters` y a
contar distinto, y el test no se actualizó. No es un bug de producción, pero conviene
arreglarlo para que la suite vuelva a verde y sirva de red.

**Frontend**: 4 errores de lint (`react-hooks/set-state-in-effect` en los monitores y
sus hooks de transición) y 109 warnings, casi todos imports sin usar.
