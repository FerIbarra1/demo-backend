# PLAN — El ADMIN opera cualquier consola, de cualquier tienda

> Estado (17-oct-2026): **F0, F1, F2, F3 y F3.5 HECHAS y verificadas** (backend: jest 118 suites / 2119 tests, `tsc` y lint con 0 errores; frontend: `tsc`, scripts `tsx`; Playwright
> con ADMIN y empleado; F3 probada en vivo con clientes socket.io y F3.5 por la API real y en el navegador; sin commit). **F3.5 "cubrir puesto" CERRADA: ver §13. Siguen el backlog de §14
> (N2 → N1 → N3 → N4+N5 → N6+N7) y F4 (TV).** El realtime está APAGADO en el entorno de desarrollo del frontend (`NEXT_PUBLIC_REALTIME_ENABLED`): la parte del `RealtimeProvider` de F3 no se vio en el navegador.
> **D1 y D2 decididas por el dueño** (una tienda a la vez; el admin actúa).
>
> **Lo que F2 hizo** (detalle en `demo-frontend/CLAUDE.md` § "El ADMIN opera las consolas de una tienda"): store propio de la tienda de consola + `useTiendaConsola`, chip/selector
> en la barra (color estable, ciudad como etiqueta), "Elige una tienda" en el shell, remonte al cambiar de tienda y cierre del detalle abierto, `tiendaId`/`clave` en todas las
> llamadas y keys de consola, menú del admin con Bodega/Mostrador/Caja/Ventas, y las salvaguardas §4.5: nota "Se aplica en la tienda X" en todo `ConfirmDialog` del ADMIN (+ confirmación
> propia de "Enviar a pagar"), su nombre lleva "(Administrador)" y motivo obligatorio al cancelar vencidos. (F2 dejó además al ADMIN sin tomar pedidos ni selector de estación; **F3.5 lo revirtió**: ahora cubre un puesto, §13.)
> **Hueco encontrado:** `useBodegaRoute` era el único guard sin ADMIN (lo rebotaba a /admin).
>
> **Lo que F1 encontró y cerró (no estaba en el plan):** (a) bodega sin `?tiendaId=` devolvía la cola de **todas** las tiendas mezclada para el ADMIN
> (`if (tiendaId) where.tiendaId`); (b) `buscarPedidos` ignoraba la tienda para el ADMIN (búsqueda global dentro de una consola de una tienda);
> (c) `GET mostrador/puesto/disponibles` y `cajero/ventanilla/disponibles` daban 500 al ADMIN; (d) `ventas/pedidos/:id` repetía la regla de tienda;
> (e) `BuscarPedidoDto` rechazaba `?tiendaId=` (`forbidNonWhitelisted`); (f) `ImpresionService.tienda()` era una segunda copia de la regla (ahora delega).
> Detalle y contrato en `CLAUDE.md` § "La tienda de una consola". Nace de dos cosas que quedaron pendientes al cerrar el punto (5) del DTF:
> (1) el resumen de DTF no está en la pestaña **"Sin aviso"** de mostrador, y (2) el ADMIN **no puede usar `/mostrador`** (500) ni
> `/cajero`, `/bodega`, `/ventas` de forma útil: solo `/impresion` y `/tesoreria` funcionan para él.

## 0. Objetivo

Que un ADMIN entre a **cualquier consola** (bodega, mostrador, caja, ventas, impresión, tesorería y las TV), **elija una tienda** y vea
exactamente lo que ve el empleado de esa tienda, con todo en vivo. Cambiar de tienda es un clic, no un re-login. Hoy lo hace a medias y
por accidente: cada consola resuelve la tienda a su manera.

**Criterio de éxito:** con `admin@puntotextil.com` (sin tienda en el token) se abre cada consola, se elige Mexicali u Obregón, la cola
carga sin errores, los eventos en vivo llegan, y un empleado NO puede ver otra tienda mandando `?tiendaId=`.

## 1. Estado actual (verificado en el código)

**Quién resuelve la tienda hoy**

| Endpoint | Cómo la toma | ¿Sirve para ADMIN? |
|---|---|---|
| `GET pedidos/mostrador/{cola,listos,sin-aviso}` (`mostrador.controller.ts:71,101,143`) | `ADMIN && ?tiendaId` si no, `user.tiendaId` | **Sí**, pero el front no manda `tiendaId` → 500 |
| `GET pedidos/cajero/cola` (`cajero.controller.ts:65`) | `ADMIN ? (?tiendaId ?? user.tiendaId) : user.tiendaId` | Sí (el front no lo manda) |
| `GET pedidos/bodega/cola` (`bodega.controller.ts:66`) | igual | Sí (el front no lo manda) |
| `GET impresion/*` (`dtf`) | `ADMIN` exige `?tiendaId` (400 claro si falta) | **Sí, es el modelo a copiar** |
| `GET mostrador/buscar`, `pedidos/consulta/*` (`pedido-consulta.controller.ts:70`, `mostrador.controller.ts:195`) | solo `user.tiendaId` | No |
| `bodega/{surtir-juntos,lote,ajustes-entrega,…}` (`bodega.controller.ts:82,98,113,144,158`) | solo `user.tiendaId` | No |
| `cajero/mis-pedidos` (`cajero.controller.ts:81`) | solo `user.tiendaId` | No |
| `ventas/*` (`ventas.controller.ts:61,85`) | solo `user.tiendaId` | No |
| `reposicion/*` (`reposicion.controller.ts:40,55`) | solo `user.tiendaId` | No |
| TV: `bodega-monitor`, `mostrador-monitor`, `cajero-monitor` | solo `user.tiendaId` | No (por diseño son de la tienda de la TV) |
| `ventanillas/*`, `mostradores/*` (estaciones) | solo `user.tiendaId` | No (y no debe: ver §3, D3) |
| `tesoreria/*` | sin tienda (multi-tienda por diseño) | Sí |

**Otras piezas que ya existen**
- `PedidoAccessService` y `@RequiereEstacion()` ya **dejan pasar al ADMIN** (sin validar tienda, sin estación).
- El front ya tiene `useTiendaStore.selectedTiendaId` y el interceptor manda `X-Tienda-Id`, pero el **backend de consolas lo ignora a propósito**
  (regla de oro del `CLAUDE.md`: la tienda sale SOLO del JWT; con el header habría IDOR entre tiendas).
- `useTiendaConsolaDtf()` (`lib/hooks/useImpresion.ts`) ya resuelve "ADMIN usa la tienda elegida, el empleado la de su sesión" y devuelve
  `bloqueado` si falta. Es el germen del hook general.
- El menú del admin (`AdminShell`) solo enlaza `/impresion` y `/tesoreria`; no hay acceso a bodega, mostrador, caja ni ventas.
- **Realtime:** el ADMIN entra al room `admin:all` y **no** a `tienda-{id}` (`realtime.gateway.ts:130`); `emitToTienda` solo emite a `tienda-{id}`.
  Entonces un admin mirando una tienda **no recibe sus eventos en vivo** (solo el sondeo cuando no hay socket).

## 2. Principios (no negociables)

1. **La tienda del empleado sale SOLO del JWT.** Un `?tiendaId=` de un no-ADMIN se **ignora** (no se rechaza ni se usa).
2. **El ADMIN elige; el servidor valida.** Una sola función decide, en un solo lugar, para todos los controllers (no 15 ternarios copiados).
3. **Fallar con un mensaje, no con 500.** ADMIN sin tienda elegida → `400 "Elige una tienda"`; la pantalla ya sabe pintar eso (`bloqueado`).
4. **El servidor manda, la pantalla no deduce** (igual que las banderas `acciones.*`): el front no decide permisos por rol, pide la tienda y pinta.
5. **El observador no ocupa estación**: el ADMIN mira y opera sin tomar ventanilla ni mostrador (ya es así con `@RequiereEstacion`).

## 3. Decisiones por tomar con el dueño (con recomendación)

| # | Pregunta | Recomendación |
|---|---|---|
| D1 | ¿El ADMIN ve **una tienda a la vez** o también "Todas las tiendas" juntas? | ✅ **DECIDIDA: una tienda a la vez** (las colas y las acciones son por tienda). Lo "multi-tienda" vive solo en vistas de resumen (§10), nunca mezclado en una cola. |
| D2 | ¿El ADMIN **solo mira** o también **actúa** (llamar, enviar a pagar, aprobar…)? | ✅ **DECIDIDA: actúa**, igual que hoy en `/impresion`. Las acciones ya pasan por `cargarYValidar` y el ADMIN está exento de estación. **Trae salvaguardas obligatorias (§4.5)**: poder actuar en cualquier tienda hace que el error más probable sea operar en la tienda equivocada. |
| D3 | Estaciones (ventanilla/mostrador): ¿el ADMIN las toma? | **No.** Entra en modo observador con acciones habilitadas. Las rutas `ventanillas/*` y `mostradores/*` siguen siendo del empleado. |
| D4 | ¿Dónde vive el selector? | **Un selector de tienda en la barra superior de las consolas, solo para ADMIN** (no uno por pantalla). Recuerda la última tienda en `localStorage`. |
| D5 | ¿Las TV (`*-monitor`) las ve el ADMIN? | Sí, con la tienda elegida (misma regla), pero la TV de pared sigue ligada a su usuario `*_MONITOR` y su tienda. |
| D6 | ¿Y los roles de empleado con **más de una tienda**? | Fuera de alcance (hoy un empleado = una tienda). El diseño no lo estorba: la función de resolución es el único lugar a cambiar. |

## 4. Diseño

### 4.1 Backend — una sola resolución de tienda

- `common/` → `resolverTiendaDeConsola(user, tiendaIdQuery?)`: para `ADMIN` devuelve `tiendaIdQuery` válido (entero > 0, **existente**);
  para los demás devuelve `user.tiendaId` y **descarta** el query; si queda sin tienda lanza `BadRequestException('Elige una tienda')` (empleado
  sin tienda → `ForbiddenException`, como hoy). Mismo contrato que ya tiene `ImpresionService.tienda()`.
- Un decorador/param `@TiendaConsola()` para no repetir `@Query('tiendaId')` + el ternario en cada método; documentado en Swagger.
- Aplicarlo a **toda** la tabla de §1 marcada "No" que sea de consola (no a estaciones, no a las TV de pared).
- Los servicios que hoy reciben `user.tiendaId` reciben el resultado; **no** se tocan por dentro.
- Specs: matriz **rol × (con/sin `tiendaId`) × endpoint** → ADMIN con tienda ✔, ADMIN sin tienda 400, empleado con `?tiendaId=otra` usa **la suya**
  (anti-IDOR). Un spec de contrato que recorra los controllers de consola y falle si alguno lee `user.tiendaId` directo (como `roles-contrato.spec`).

### 4.2 Backend — realtime para el ADMIN

- Opción recomendada: el ADMIN pide **mirar una tienda** por socket (`tienda.mirar` / `tienda.dejar-de-mirar`); el gateway valida `rol === ADMIN` y
  hace `client.join('tienda-{id}')` / `leave` (y se sale de la anterior al cambiar). Así recibe exactamente los eventos de esa tienda y ninguno más.
- Alternativa descartada: emitir además a `admin:all` desde `emitToTienda` (el admin recibiría los eventos de TODAS las tiendas mezclados).
- El outbox (`realtime_event_outbox`) no cambia: persiste por room.

### 4.3 Frontend

- Mover `useTiendaConsolaDtf` a `lib/hooks/useTiendaConsola.ts` y generalizarlo: `{ param, clave, bloqueado }`. **Toda** key de React Query de consola
  lleva `clave` (cambiar de tienda no debe servir caché de la anterior; mismo error que ya se corrigió en `useTiposDtf`).
- Los hooks de mostrador, caja, bodega, ventas y reposición pasan `tiendaId: param` a sus llamadas (las funciones de `lib/api/pedidos.ts` ya lo aceptan).
- `SelectorTiendaConsola` en la barra de las consolas, visible solo para `rol === 'ADMIN'`; sin tienda elegida cada pantalla muestra el `EmptyState`
  "Elige una tienda" que ya existe en `/impresion`.
- `AdminShell`: agregar **Bodega, Mostrador, Caja, Ventas** (y las TV) junto a "Consola de impresión" y "Tesorería".
- Al cambiar de tienda: avisar al socket (`tienda.mirar`) e invalidar las queries de consola.
- Las consolas dejan de asumir que el usuario tiene tienda (`user.tiendaId` en el front → `useTiendaConsola()`).

### 4.4 "Sin aviso" con DTF (lo pequeño, va primero)

- `MostradorQueryService.obtenerSinAviso`: agregar `dtfResumen` con `resumenDtfPorPedido` (una consulta por lista, como en `obtenerCola`).
- Frontend: la tarjeta de "Sin aviso" ya reutiliza `TarjetaPedidoMostrador`/su `detalle`; pintar `DtfResumenLinea` y quitar "0 producto(s)" en solo-DTF.
- Spec: ampliar `mostrador-query-cola.spec.ts` (el mock ya incluye `pedidoDtf`).

### 4.5 Salvaguardas de "el admin actúa" (parte de F1/F2, no opcionales)

1. **Siempre se ve DÓNDE se está operando:** chip fijo y de color en la barra con el nombre de la tienda ("Operando en Obregón"); cada tienda con su color
   estable para que un vistazo baste. Cambiar de tienda con un pedido abierto cierra su modal/detalle (no se queda un pedido de Mexicali bajo "Obregón").
2. **Confirmaciones con nombre de tienda** en lo que no se deshace (cancelar, enviar a pagar, marcar pagado manual, entregar, rechazar DTF): el `ConfirmDialog`
   del ADMIN incluye "en **Obregón**". El de empleado no cambia.
3. **Atribución:** todo `PedidoHistorial`/evento DTF/pago ya guarda el actor; verificar que las acciones del ADMIN lo escriben **y** que la línea dice
   "por <nombre> (Administrador)" y no se confunde con el empleado. Las acciones que hoy asumen estación (p. ej. el mostrador que llamó) deben dejar el
   operador como el admin, sin inventar un mostrador.
4. **Motivo obligatorio** (texto corto) en las acciones destructivas del ADMIN, igual que `forzar` + `referencia` en "marcar pagado manual".
5. **El admin no ocupa lugar en las colas de estación:** no cuenta como "operador en línea" en la TV ni retiene pedidos asignados (no entra a ventanilla/mostrador).

## 5. Fases (en este orden; cada una deja el sistema verde)

| Fase | Qué | Tamaño |
|---|---|---|
| **F0** | "Sin aviso" con DTF (§4.4) | XS |
| **F1** | Backend: `resolverTiendaDeConsola` + `@TiendaConsola()` + aplicarlo a mostrador, caja, bodega, ventas, reposición, consulta/buscador + specs anti-IDOR + spec de contrato. **ADMIN sin tienda deja de dar 500.** | M |
| **F2** | Frontend: hook general + selector + `AdminShell` con los accesos + `tiendaId` en las keys y llamadas de mostrador/caja/bodega/ventas | M |
| **F3** | Realtime del admin (`tienda.mirar`) + cambio de tienda en caliente | S |
| **F3.5** | El ADMIN cubre un puesto (ventanilla de caja, pedidos de bodega) y los suelta al cambiar de tienda / cerrar sesión (§11, §13) | M |
| **F4** | TV con la tienda elegida (solo vista de admin) y pulido; verificación en navegador por tienda (Mexicali ↔ Obregón) | S |
| **F5+** | Novedades de §10 (opcionales, en el orden recomendado de esa sección) | por ítem |

## 6. Pruebas y criterios de aceptación

- **Salvaguardas (§4.5):** un test de pantalla por cada acción destructiva del admin verifica que el diálogo nombra la tienda; el historial del pedido
  muestra al admin como actor; cambiar de tienda con un detalle abierto lo cierra.

- **Backend (jest):** matriz de §4.1; `mostrador-flujo-postgres`/`cajero-fila-postgres` siguen verdes; el spec de contrato de controllers.
- **Navegador (Playwright), con `admin@puntotextil.com`:** abrir las 6 consolas → "Elige una tienda" → elegir Mexicali → cargan sin errores de consola →
  cambiar a Obregón → la cola cambia y **no** quedan pedidos de Mexicali en pantalla → crear un evento en Obregón (p. ej. cliente avisa llegada) y verlo
  llegar **sin recargar** → recargar y conservar la tienda elegida.
- **Seguridad:** con el usuario `mostrador@…` (Mexicali) llamar `?tiendaId=<Obregón>` a cada endpoint → devuelve **Mexicali**.
- **Regresión:** los usuarios de empleado no ven ningún selector ni cambia su flujo.

## 7. Riesgos

- **IDOR** si algún controller se queda leyendo el query sin pasar por la función → mitigado por el spec de contrato.
- **Caché cruzada** entre tiendas en React Query → `clave` en toda key de consola; revisar `qk.*` de pedidos/bodega/mostrador/caja.
- **Eventos del socket mezclados** si el admin se queda en dos rooms → `tienda.mirar` siempre sale del room anterior.
- **Acciones del admin sin estación** que dependan de `user.tiendaId` dentro del servicio (p. ej. al liberar una ventanilla) → revisar cada acción de caja/mostrador
  con el ADMIN en la matriz de pruebas.
- **El agente de sincronización** no se toca (el ADMIN no cambia nada del flujo ERP).

- **Operar en la tienda equivocada** (el riesgo principal de D2: el admin actúa en cualquiera) → salvaguardas de §4.5: chip fijo con la tienda, confirmaciones con su nombre, motivo en lo destructivo, y cerrar el detalle abierto al cambiar de tienda.

## 8. Fuera de alcance

Empleados con varias tiendas · vista "todas las tiendas" mezcladas en las colas · permisos finos por tienda para el ADMIN · tocar `ventanillas/*` y
`mostradores/*` · reportes multi-tienda.

## 9. Por dónde empezar la próxima sesión

1. Leer `demo-frontend/CLAUDE.md` § "Mostrador y caja ven el DTF" y § "La consola de Impresión" (el modelo del selector ya está ahí).
2. Hacer **F0** (media hora): `obtenerSinAviso` + tarjeta, con su spec.
3. Escribir `resolverTiendaDeConsola` copiando el contrato de `ImpresionService.tienda()` y **primero** el spec (la matriz rol × tienda) y luego aplicarlo endpoint por endpoint.
4. Datos de prueba que ya existen: usuarios `admin@`, `mostrador@`, `cajero@`, `impresion@` (clave `123456`), tiendas Mexicali (1) y Obregón; el pedido
   PD-2026-000016 (`PENDIENTE_PAGO`, solo-DTF) y los ejemplos de DTF 11–21 — **no borrarlos**, sirven para la demo.
5. Trampas ya conocidas: el límite de logins (429) al probar muchos usuarios seguidos; el navegador de pruebas pierde los clics reales cada cierto tiempo
   (`browser_close` y volver a abrir); y si hay un modo kiosko simulado en `localStorage`, limpiarlo con la página recargada, no abierta.

## 10. Qué le falta al ADMIN y novedades recomendadas

> Análisis hecho sobre lo que existe hoy (consolas por rol, `/admin/*`, heartbeats de kioskos y bodegueros, monitores de TV, conciliación y hoja del día
> con CSV, `PedidoPendienteEnvio` hacia el ERP). **Hoy el admin puede *configurar* (tiendas, kioskos, productos, usuarios, tarifas DTF, cuentas bancarias),
> pero casi no puede *dirigir la operación del día*:** no tiene una vista de "cómo va cada tienda", no sabe qué está atorado, y no puede buscar un pedido sin
> saber de qué tienda es. Las recomendaciones están ordenadas por valor para la demo y la operación real.

| # | Novedad | Qué resuelve | Esfuerzo | Notas / lo que ya existe |
|---|---|---|:-:|---|
| N1 ✅ | **Torre de control** (HECHA, ver §14) (`/admin`, página de inicio nueva): una tarjeta por tienda con lo que importa HOY: pedidos por etapa (bodega / mostrador / caja / DTF / por entregar), el más viejo esperando, transferencias por verificar, trabajos DTF por revisar, metros del día; semáforo verde/ámbar/rojo por umbral. Clic en la tarjeta → entra a esa tienda (fija el selector). | Responde "¿cómo va cada tienda?" sin entrar a cuatro consolas. Es la **única** vista multi-tienda (respeta D1: las colas siguen siendo de una tienda). | M | Salen de los mismos contadores de los monitores de TV y de `resumen` de Impresión; falta un endpoint agregado por tienda. |
| N2 ✅ | **Búsqueda global de pedido** (HECHA, ver §14): un buscador en la barra del admin que encuentra un folio / cliente / teléfono **en cualquier tienda** y, al abrirlo, cambia el selector a la tienda del pedido. | "¿Dónde está el pedido PD-…?" sin adivinar la tienda. Hoy el buscador (`pedidos/consulta`) solo ve la tienda del token. | S | Reusa `BuscadorPedidos`; el backend admite búsqueda sin filtro de tienda solo para ADMIN y devuelve `tienda` en cada fila. |
| N3 ✅ | **Salud del sistema** (HECHA, ver §14): estado del agente del ERP (último poll/ACK), pedidos en `RETRY`/`ERROR` de `PedidoPendienteEnvio`, kioskos y TV sin latido, workers (barridos de estaciones, vencimientos). Con botón de reintento donde ya exista la acción. | Hoy un pedido atorado hacia el Sistema Comercial **no lo ve nadie** hasta que el cliente reclama; es el riesgo operativo más caro. | M | Heartbeats de kioskos/bodega ya se guardan; falta una pantalla y un endpoint de salud. |
| N4 | **Atorados**: lista de pedidos/trabajos que llevan demasiado en una etapa (umbral por etapa, editable): `SOLICITADO` sin tomar, `EN_REVISION` sin movimiento, `PENDIENTE_PAGO` sin cobrar, `ESPERANDO_APROBACION` vencida, `EN_DTF` con trabajos sin tomar, transferencia vencida. Acciones: liberar, reasignar, cancelar (con motivo). | El admin deja de enterarse de los problemas por el cliente. | M | Los umbrales de "sin recoger" ya existen (`sin-recoger.util`); generalizar. |
| N5 | **Bitácora de actividad del admin** (y de lo sensible): quién cambió tarifas DTF, precios, usuarios, cuentas bancarias; qué cancelaciones/pagos manuales hizo un admin y en qué tienda. Exportable a CSV. | Rendición de cuentas ahora que el admin actúa en todas las tiendas (D2). | M | El patrón de eventos append-only ya existe en DTF y pagos; falta uno general para configuración. |
| N6 | **Rol `GERENTE` de tienda**: opera TODAS las consolas de SU tienda (y solo esa), sin tocar configuración global. | Evita darle `ADMIN` completo a quien solo dirige una tienda; es la forma segura de repartir lo que hoy solo hace el admin. | M | La función `resolverTiendaDeConsola` (F1) ya lo permite: gerente = rol con tienda fija + permisos de todas las consolas. Hay un spec de contrato de roles que obliga a nombrarlo en cada lista. |
| N7 | **Reportes** (la ruta `/admin/reportes` existe oculta): ventas por tienda/día, tiempos por etapa (solicitado→entregado), % de pedidos con ajuste/cancelación/reposición, metros de DTF por tienda y por tecnología, rechazos de DTF por motivo, ranking de productos. Todo con CSV. | Dirigir con datos y comparar tiendas (la única otra vista multi-tienda). | L | La conciliación y la hoja del día ya enseñan el patrón de CSV (BOM, neutralizar fórmulas, zona horaria del negocio). |
| N8 | **Aplicar lo que hoy solo se guarda en DTF**: `horaCorte` y `cupoMetrosDia` por tienda (el backend las guarda y **no las aplica**) y `pagoAntes` por tipo; que la pantalla del cliente diga "saldrá mañana" cuando se pase el cupo. | Cierra una promesa del panel `/admin/dtf` que hoy no hace nada. | M | Ver `demo-frontend/CLAUDE.md` § DTF ("lo que el backend guarda pero NO aplica"). |
| N9 | **Alertas al admin** (correo o aviso en la barra): kiosko sin latido, cola de caja por encima del umbral, transferencia vencida, ERP con errores. | Pasa de "revisar" a "enterarse". | M | Se apoya en N3/N4; el módulo de correo y las notificaciones ya existen. |
| N10 | **Acceso rápido a estaciones**: ver y liberar ventanillas/mostradores de cualquier tienda (quién la ocupa, desde cuándo, cuántos clientes lleva). | Destrabar a un cajero que se fue sin cerrar. | S | Ya existen `VentanillasAdminSheet` y `MostradoresAdminSheet`; falta enlazarlos desde la consola y la torre de control. |

**Orden sugerido tras F0–F4:** **N2** (barato y lo más usado) → **N1** (la cara del producto en la demo) → **N3** (el riesgo caro) → **N4** → **N5** → **N6** →
N10 → N8 → N9 → N7. N5 y N6 conviene **antes** de entregar el sistema al cliente final, porque son las que hacen seguro que el admin actúe en todas las tiendas.

**Qué NO recomiendo:** "ver como" otro usuario (suplantación): rompe la atribución y la auditoría; con D2 el admin ya actúa con su propia identidad.
Mezclar tiendas en una sola cola (contradice D1). Mover un pedido entre tiendas (cambia stock, precios por tienda y el ERP: es un proyecto aparte).


## 11. ¿Puede el ADMIN tomar pedidos de caja y bodega? (decisión revisada, 17-oct-2026) — HECHA en F3.5, ver §13

**Veredicto: SÍ debería poder —el dueño cubre turnos y bloquearlo lo obliga a entrar con la cuenta de otro, que pierde la atribución— pero NO como un permiso suelto: cubriendo un PUESTO.**
Hoy está bloqueado (403) a propósito, porque tomar ASIGNA el pedido y todo lo que rodea a una asignación asume que quien lo tiene es un empleado con tienda:

- **Caja:** el pedido queda en la ventanilla de quien lo toma. `VentanillasService.elegir` exige `usuario.tiendaId === tiendaId` (el ADMIN no tiene) y sus controllers leen la tienda del token; sin ventanilla el pedido queda
  asignado a alguien que no sale en la TV ni en la fila. (El código ya prevé al ADMIN: `elegir` acepta CAJERO y ADMIN y el latido incluye ADMIN; falta que la tienda salga de la consola.)
- **Bodega:** `BodegaPresenciaService.salio`/`salirInactivos` y `AuthService.marcarEntrada/logout` solo atienden `rol === BODEGA`, y el monitor de TV solo lista `rol: BODEGA` de la tienda. Un pedido tomado por un ADMIN
  no se devolvería a la cola al cerrar sesión o por inactividad, y **desaparecería de la TV** (sale de las columnas y su dueño no tiene ficha).
- **Mostrador:** no hay problema: llamar no asigna (el ADMIN llama sin número).

**F3.5 — "Cubrir puesto" (la propuesta que se construyó; resultado en §13):** (1) caja: el ADMIN elige ventanilla de la tienda que opera (opt-in, nunca se abre sola), tomar/llamar exige tenerla; las estaciones toman la tienda de `@TiendaConsola()` y
`elegir` suelta cualquier puesto previo (cajeroId es único); (2) bodega: permitir `tomar`/`tomar-grupo` (con el tope de 4), extender presencia (`salio`, `salirInactivos`, logout) a ADMIN, y que el monitor liste a un ADMIN que
trae pedidos de ESA tienda; (3) al cambiar de tienda o cerrar sesión se sueltan sus puestos y pedidos (volverían a la cola, con aviso). Alternativa para quien dirige UNA tienda: el rol GERENTE (N6), que sí trae tienda.

## 12. Auditoría del admin (17-oct-2026)

Las 10 páginas de `/admin` cargan sin llamadas fallidas ni errores de consola. Encontrado y corregido: el detalle de un pedido solo-DTF decía "0 artículo(s) · no tiene productos" y no mostraba el DTF;
el `Navbar` del ADMIN en las consolas enlazaba a **/admin/reportes, que muestra DATOS DE EJEMPLO inventados** (el menú lateral ya la ocultaba); acentos ("Administración", "Menú"). `/admin/kioskos` tarda ~50 s en la primera
carga en desarrollo (compilación en frío). **Sigue abierto:** `/admin/reportes` es alcanzable por URL con cifras falsas (N7).


## 13. F3.5 "Cubrir puesto" — HECHA y verificada (17-oct-2026)

**Decisión del dueño (17-oct):** SÍ, el ADMIN cubre un puesto y toma pedidos en caja y bodega. No se reabre. La documentación de cómo quedó vive en `CLAUDE.md` (backend) § "La tienda de una consola" →
"Cubre un puesto" y en `demo-frontend/CLAUDE.md` § "El ADMIN opera las consolas de una tienda". Aquí, solo el resumen y lo que se comprobó.

### Qué quedó
- **Caja:** `elegir` acepta al ADMIN sin tienda propia; `cajeroId` es único, así que elegir en otra tienda suelta la anterior y regresa su gente a la fila (conservando el lugar); `tomarPedidoCajero` exige una
  ventanilla EN LA TIENDA DEL PEDIDO (403; 404 si no existe); `llamarSiguiente(usuario, tiendaId)` usa la tienda resuelta (400 sin ventanilla en ella). `cajero/ventanilla/*` con `@TiendaConsola()`.
- **Bodega:** sin bloqueo; `tomarGrupo` filtra por la tienda resuelta (antes tomaba de cualquiera); presencia (`salio`, `salirInactivos`, logout) y monitor de TV incluyen al ADMIN, por tienda de cada pedido.
- **`POST /estaciones/soltar`** (solo ADMIN): su ventanilla y sus pedidos de bodega, en cualquier tienda. Red de seguridad: el barrido de 15 min.
- **Frontend:** `ventanillasApi`/hooks/`useLlamarSiguiente`/`useTomarGrupo` con la tienda; selector de ventanilla OPT-IN; `puedeTomar` del ADMIN = tener ventanilla; `permisosBodega` con una sola regla para ADMIN y
  bodeguero (sin botones dobles); `BodegaSurtidoSheet` lee `puedeTomar` de ahí; "Surtir juntos" visible; `soltarPuestos()` al cambiar de tienda (con aviso) y al cerrar sesión (sin aviso: ningún toast sobrevive al ir a /login).

### Hallazgos de esta sesión (no estaban en la lista)
- `cajeroApi.llamarSiguiente` y `pedidosBodegaApi.tomarGrupo` no mandaban `tiendaId` aunque el servidor ya lo exigía: el ADMIN habría recibido 400 "Elige una tienda" justo al usar lo nuevo.
- `BodegaSurtidoSheet` recalculaba `puedeTomar` por su cuenta (`!puedeModificar && …`) y nunca se lo ofrecía al ADMIN; y con `puedeTomar` verdadero para el ADMIN en `permisosBodega`, la tarjeta y el modal de
  vista previa habrían mostrado dos botones a la vez en un EN_REVISION libre (se resolvió en la regla, no en cada pantalla).
- `tomarPedidoCajero` daba al ADMIN un 403 "elige una ventanilla" para un pedido inexistente: ahora 404.
- Al empezar la sesión, `node_modules` se había reinstalado y faltaba el cliente generado de Prisma (`prisma generate`); se regeneró (no es `npm run build`).

### Verificación
- Backend: `npx jest` **109 suites / 2022 tests verdes** (eran 107 / 1918: −1 obsoleto, +3 nuevos, + los casos de ventanilla en la matriz HTTP y el bloque del ADMIN en presencia); `tsc` limpio; `npx eslint 'src/**/*.ts' --fix` con 0 errores.
  Los specs nuevos se comprobaron con mutaciones (quitar el `tiendaId` de `tomarGrupo`, o el filtro por tienda al soltar la ventanilla anterior, los rompe).
- API real (:3000, con pedidos de prueba propios, ya borrados): 43 comprobaciones — 400/403/404/201 según el caso, estado en la BD, TV de bodega por tienda, `soltar` (y su 403 para un CAJERO), logout.
- Navegador (Playwright) como ADMIN en `/cajero` y `/bodega`: 20 comprobaciones, 0 llamadas fallidas. Capturas en el scratchpad de la sesión.
- Frontend: `tsc` limpio, eslint sin avisos en lo tocado; scripts `tsx` (`permisos-bodega` 48, `soltar-puestos` 6, `tienda-consola` 16, y los demás que existen). Los pedidos de ejemplo (PD-2026-000011 a 16) y las
  ventanillas quedaron idénticos (comparación antes/después).

### Pendiente menor (no bloquea)
- Estación de MOSTRADOR para el ADMIN (hoy llama sin número; no hace falta para tomar).
- Los toasts no sobreviven al cerrar sesión (comportamiento previo de la app, también el "Sesión cerrada").
- 7 scripts de `package.json` (`test:auth-loops`, `test:rate-limit`, `test:cantidad`, `test:lineas-pedido`, `test:piezas-en-bolsa`, `test:mostrador`, `test:presencia`) apuntan a archivos que no existen.

### Reglas de diseño que NO cambian (para no reabrir la duda)
Sin puesto no hay asignación en caja; el ADMIN nunca se abre solo el selector; al cambiar de tienda o cerrar sesión se sueltan sus puestos y pedidos; el barrido de 15 min es la red de seguridad; su nombre sigue
siendo "(Administrador)" (`nombre-actor.ts`); mostrador llama sin número.

## 14. Backlog (después de F3.5, ya cerrada), en este orden — pedido del dueño 17-oct
1. ✅ **N2 Búsqueda global — HECHA (17-oct-2026)** (`GET admin/busqueda/pedidos`, controller aparte solo-ADMIN; `BuscadorPedidosGlobal` en la barra; chip de tienda por resultado; "Ir al pedido" cambia la tienda de la consola por `cambiarTiendaConsola`, que suelta sus puestos; specs HTTP + BD; Playwright 14/14; detalle en ambos CLAUDE.md). Lo que se planeó: `MostradorQueryService.buscarPedidos(q, user, undefined)` YA busca en todas las tiendas para un ADMIN sin tienda (y `tienda: true` ya viene en el include): falta un endpoint explícito para ADMIN (p. ej. `GET admin/pedidos/buscar?q=`, sin `@TiendaConsola`), devolver `tienda` por fila, y el buscador en la barra del `AdminShell`; al abrir un resultado, fijar `useTiendaConsolaStore` a la tienda del pedido y abrirlo.
2. ✅ **N1 Torre de control — HECHA (17-oct-2026)** (`GET admin/torre-control`, `modules/admin-torre/`; sección de arriba de `/admin`; semáforo por ESPERA con umbrales en una tabla —NO medidos, ajustables—; las filas fijan la tienda y entran a la consola; backend 114 suites / 2077 tests; Playwright 13/13; detalle en ambos CLAUDE.md). Lo que se planeó: endpoint agregado por tienda reusando los contadores de los monitores (`monitor.service` de bodega, `cajero-monitor`, `mostrador-monitor`) + `resumen` de Impresión + transferencias por verificar; semáforo por umbral; clic → fija la tienda del selector.
3. ✅ **N3 Salud del sistema — HECHA (17-oct-2026)** (`GET admin/salud`; agente y bandeja por tienda, eventos de sync con su único reintento existente, kioskos, TV de bodega, outbox y barridos —estos últimos con `ActividadWorkers`, en memoria—; `/admin/salud`; umbrales NO medidos; backend 118 suites / 2119 tests; Playwright 6/6; detalle en ambos CLAUDE.md). Lo que se planeó: estado del agente del ERP (último poll/ACK, `SyncCheckpoint`), `PedidoPendienteEnvio` en RETRY/ERROR, kioskos/TV sin latido, workers; botón de reintento donde ya exista la acción.
4. **N4 Atorados + N5 Bitácora del admin**: umbrales por etapa (generalizar `sin-recoger.util`); bitácora append-only de lo sensible (patrón de eventos de DTF/pagos) con CSV.
5. **N6 Rol GERENTE + N7 Reportes reales**: al agregar un rol `roles-contrato.spec` falla hasta nombrarlo en cada lista; los reportes reemplazan `/admin/reportes` (hoy con DATOS DE EJEMPLO inventados, alcanzable por URL).

---

## Actualización 17-oct-2026 — N6 (rol GERENTE) hecho en su versión de SOLO LECTURA

El rol `GERENTE` (una tienda) existe y supervisa: torre y salud de SU tienda (`gerencia/*`) y búsqueda de pedidos. Sin Tesorería, sin
consolas, sin `/admin/*`; lo "solo ADMIN" lo garantiza el `RolesGuard` (niega por defecto) + una lista cerrada en `roles-contrato.spec`.
Sus **acciones para destrabar** (con bitácora N5 y la tarea "pendiente de reflejar en el Sistema Comercial") son la pieza siguiente. Ver
`CLAUDE.md` § "El GERENTE".

