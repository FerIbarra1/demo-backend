# PLAN — Estaciones de trabajo: elegir ventanilla / mostrador, modo observador y TV de mostrador por puestos

Oct 2026. Estado: **implementado y verificado** — ver §10; §9 (ajustes del dueño) **reemplaza** a lo que diga el resto del
documento cuando se contradigan. §11 son los escenarios nuevos del dueño, también hechos.

## 0. Qué se pide

1. **Caja:** al iniciar sesión NO se asigna una ventanilla sola. El cajero **elige** cuál; ve las ocupadas; y puede
   entrar como **observador ("fantasma")**: ve todo, pero no puede atender.
2. **Mostrador:** hoy, si la tienda no tiene mostradores configurados, trabaja "genérico" (como antes). Debe trabajar **igual
   que caja**: elegir su mostrador al entrar, observador sin mostrador, y la **TV de mostrador funciona como la de caja**
   (una tarjeta por mostrador + la cola).
3. **Seed / BD:** Mexicali con mostradores igual que con ventanillas; ninguna estación pre-asignada.
4. **Escenarios límite** (el modal que no se puede cerrar, "liberar y seguir atendiendo sin ventanilla", etc.): todos
   contemplados, con la regla en el SERVIDOR (la pantalla solo la refleja).

## 1. Diagnóstico (verificado en el código, no supuesto)

| # | Hallazgo | Dónde | Consecuencia |
|---|---|---|---|
| D1 | El seed **asigna la ventanilla 1 al cajero demo** (`cajeroId: usuarioCajero.id`) | `prisma/seed.ts` ~542 | "Inicias sesión y ya tienes caja". Además, hasta oct-2026 cerrar sesión **no soltaba** la ventanilla (ya corregido en `AuthService.logout` del frontend). |
| D2 | El modal de elegir ventanilla **no se puede cerrar**: `showCloseButton={false}`, sin `onOpenChange`, y `modalCerrado` nunca se pone en `true` | `ElegirVentanillaModal.tsx`, `cajero/page.tsx` | Si lo abres por error (para ver o para liberar) quedas atrapado: o eliges, o liberas. |
| D3 | **"Atender" (`POST cajero/pedidos/:id/tomar`) no exige ventanilla.** Tampoco `liberar` ni `no-se-presento`. Solo `llamar-siguiente` la exige | `cajero.service.ts` | Con "Liberar ventanilla" (o antes de elegir) se puede seguir atendiendo: el pedido queda asignado a un cajero **sin ventanilla** → desaparece de la TV (solo lista a un cajero con ventanilla activa) **y** de la fila (solo lista los sin asignar). |
| D4 | La TV de caja considera "abierta" a una ventanilla si el cajero tiene `lastLogin` o latido en las últimas **12 h** | `cajero-monitor.service.ts` | Un cajero que se fue sin cerrar sesión deja su ventanilla "Esperando cliente" medio día, y nadie más puede tomarla. |
| D5 | Mostrador: `resolverParaLlamar` devuelve `null` si la tienda **no tiene mostradores** (modo genérico), y el modal de mostrador **se puede cerrar** (`selectorDescartado`); solo **llamar** exige mostrador | `mostradores.service.ts`, `mostrador/page.tsx` | Un operador sin mostrador puede enviar a pagar, ajustar, cancelar, entregar. La TV dice "Pasa a mostrador" sin número. |
| D6 | Mexicali tiene **3 ventanillas y 0 mostradores** en la BD de dev (y en el seed) | BD / seed | Por eso hoy mostrador trabaja genérico. |
| D7 | La TV de mostrador es una **lista de "Atendiendo"** (un folio grande + el resto en chico con "Mostrador N"), no una tarjeta por puesto | `MonitorMostradorCola.tsx` | No se ve qué mostradores están abiertos ni quién atiende a quién. |
| D8 | Soltar el mostrador (`MostradoresService.liberar`) **no regresa** al cliente que el operador tenía llamado (`EN_ATENCION`) | `mostradores.service.ts` | El folio queda anunciado en la TV en un mostrador sin nadie. (Caja ya lo resuelve: `VentanillasService.liberar` devuelve a la fila lo asignado.) |

## 2. ¿Qué sale en cada TV cuando mostrador manda a pagar? (versión vigente, ver §9)

- **TV de mostrador:** el folio **sale** (solo vive mientras está `REVISADO` / `EN_ATENCION`). Durante 5 s aparece un aviso
  **genérico**: "A pagar → pasa a CAJA". **No dice cómo paga** (caja o transferencia): es una pantalla que ve todo el mundo.
- **TV de caja:** **todos** los pedidos de tienda en `PENDIENTE_PAGO` aparecen **de inmediato** en "Turnos siguientes", paguen
  en caja o por transferencia, validada o no. Domicilio nunca.
- Lo que NO se muestra en ninguna TV: método de pago, estado de la transferencia, nombres, montos. Solo folios y números.

## 3. Principio de diseño

**La estación (ventanilla / mostrador) es la que autoriza a ACTUAR; sin estación se puede MIRAR.** La regla vive en el
servidor: un cliente de la API (o una pantalla desfasada) no puede saltársela. El "modo observador" no es un estado
del servidor: es simplemente *no tener estación* + una preferencia de la pantalla (para no volver a abrir el selector).

- **ADMIN queda exento** (soporte y pruebas; hoy ya pasa sin tienda en varias reglas).
- **Observador** = `sessionStorage` por pestaña: al iniciar otra sesión vuelve a preguntar.

## 4. Diseño

### 4.1 Backend — caja
- `CajeroService.exigirVentanilla(usuario)`: 403 `"Elige una ventanilla para atender"` salvo ADMIN. Se aplica a **todas** las
  acciones que cambian algo: `tomar`, `llamar-siguiente` (ya), `liberar`, `no-se-presento`, y las de forma de pago de la
  consola de caja (`enviar-datos`, `cambiar-a-tienda`). Lecturas (cola, mis pedidos, detalle, búsqueda) siguen abiertas.
- `VentanillasService.elegir`: si la ventanilla está ocupada por **otra** persona → 409 con quién y desde cuándo; se agrega
  **tomar el control** (ver §6-Q1) con guarda atómica y evento `ventanilla.liberada` para que la sesión anterior se entere.
- `VentanillasService.listarPorTienda` devuelve por ventanilla: ocupante, **última actividad** (latido) e `inactiva` (calculado).
- Evento realtime: si te quitan la ventanilla, tu consola pasa a observador con un aviso ("Perdiste la ventanilla 2").

### 4.2 Backend — mostrador (espejo de caja)
- `MostradoresService.exigirMostrador(usuario)` (ADMIN exento) en **todas** las acciones del operador que cambian algo:
  `llamar`, `llamar-siguiente`, `devolver-a-cola`, `no-se-presento`, `enviar-a-pagar`, `ajustar`, `cancelar`, `entregar`,
  `traer-a-entrega`, `cancelar-vencidos`. (`marcar-llegada` / `descartar-llegada` también: es operar el pedido.)
- **Se elimina el modo genérico**: `resolverParaLlamar` ya no devuelve `null`; sin mostradores configurados → 409 "Esta tienda
  no tiene mostradores: pide al admin que los cree".
- `MostradoresService.liberar` regresa a `REVISADO` (conservando su lugar: `presenteDesdeAt` no se toca, igual que
  "devolver a la cola") a los pedidos `EN_ATENCION` llamados desde ese mostrador, por la máquina de estados.
- **TV de mostrador — snapshot por puestos** (espejo de `CajeroMonitorService`): `mostradores[]` con `{ numero, operadorNombre,
  abierto, atendiendo: [folios] }` + `cola[]` (REVISADO presentes). Un `EN_ATENCION` sin mostrador válido (datos viejos) se
  muestra en una fila "Sin mostrador" para que no desaparezca.
- `abierto` = operador con latido reciente (ver §6-Q3), no "se logueó en las últimas 12 h".

### 4.3 Frontend — consolas
- **Selector al entrar** (caja y mostrador, mismo componente `ElegirEstacionModal`): tarjetas con número, estado
  (**Libre** / **Tuya** / **Ocupada por Ana · hace 3 min** / **Ocupada, sin actividad**), y dos salidas siempre visibles:
  **"Entrar como observador"** y, si ya tienes estación, **"Cancelar"** (y la `X` / `Esc`).
- Reglas del modal: (a) con estación o en observador **siempre se puede cerrar**; (b) sin estación y sin haber elegido modo, se
  abre solo al entrar pero **tiene salida** (observador) — nunca queda atrapado; (c) tras **Liberar** → no se reabre solo: pasas a
  observador con el aviso "Sin ventanilla: solo lectura"; (d) "Liberar" con clientes en tu ventanilla pide confirmación
  ("N clientes regresarán a la fila").
- **Modo observador** (banner fijo + acciones deshabilitadas con tooltip): oculta/inhabilita Atender, Llamar siguiente, Devolver,
  No se presentó, Forma de pago; en mostrador: Llamar, Enviar a pagar, Ajustar, Cancelar, Entregar. Listas, búsqueda y detalle
  siguen visibles. Es un reflejo de lo que el servidor ya rechaza.
- Cierre de sesión de `MOSTRADOR` también suelta el mostrador (hoy solo `CAJERO` suelta la ventanilla).

### 4.4 TV de mostrador (como la de caja)
- Izquierda: una tarjeta por **mostrador** (número grande, operador, folio atendiendo, **"Cerrado"** si no hay operador) —
  mismo lenguaje visual que las ventanillas. Derecha: **"Pedidos en cola"** con "+N más".
- Aviso grande "Te toca → MOSTRADOR 2" y aviso "A pagar" se conservan. Sonido: solo "te toca".
- `AnimatePresence` y cola de avisos ya existen; se reutilizan.

### 4.5 Seed y datos
- Seed: **ninguna estación pre-asignada** (ventanilla 1 del cajero demo → `cajeroId: null`); **3 mostradores en Mexicali**
  (como las 3 ventanillas) y 2 en Monterrey; `upsert` idempotente.
- BD de dev (sin re-sembrar, para no borrar datos): crear los 3 mostradores de Mexicali **con el endpoint de admin**
  (`POST admin/mostradores/1`, `{cantidad:3}`) y soltar cualquier estación ocupada.

## 5. Escenarios (todos con prueba)

| Escenario | Resultado esperado |
|---|---|
| Entro sin estación | Se abre el selector; **puedo cerrarlo** (observador) o elegir. |
| Lo abrí por error con estación | `X` / `Esc` / "Cancelar" lo cierran sin cambiar nada. |
| Elijo una libre | Soy el titular; la TV la muestra abierta con mi nombre. |
| Elijo una ocupada | No se puede (409) — salvo "tomar el control" si está inactiva (§6-Q1). |
| Dos eligen la misma a la vez | Uno gana, el otro 409 (guarda atómica, ya existe). |
| **Libero y trato de atender** | Pantalla: botones inhabilitados. **Servidor: 403** aunque llamen a la API. |
| Libero con clientes en mi ventanilla | Confirmación; regresan a la fila conservando su lugar (ya existe). |
| Mostrador sin estación intenta enviar a pagar / cancelar | 403. |
| Tienda sin mostradores | Operador solo mira; mensaje "pide al admin crear mostradores". |
| Alguien me quita la estación (tomó el control / admin) | Mi consola pasa a observador con aviso, sin perder lo que estaba leyendo. |
| Cierro la pestaña sin cerrar sesión | Tras N min sin latido la TV la muestra **Cerrada** y (si §6-Q3) se libera sola devolviendo a la fila. |
| Recargo la página en observador | Sigo en observador (sessionStorage), no vuelve a preguntar. |
| Cierro sesión | Se suelta la estación (caja ya; **mostrador se agrega**). |
| ADMIN | Exento: actúa sin estación. |

## 6. Decisiones (RESPONDIDAS el 16-oct: Q1 = cualquiera puede tomar el control, con confirmación y aunque el ocupante esté
activo; Q2 = todas las acciones que cambian un pedido; Q3 = auto-liberar a los 15 min)

- **Q1 — Ventanilla/mostrador ocupado por una sesión abandonada:** ¿se puede tomar el control? **Recomendado:** sí, **solo si el
  ocupante lleva más de 15 min sin latido**, con confirmación; el servidor lo valida. (Alternativas: solo el admin la libera;
  o cualquiera con confirmación, aunque esté activo.)
- **Q2 — Alcance de "requiere mostrador":** **Recomendado:** todas las acciones que cambian un pedido (§4.2). (Alternativa: solo
  llamar y las del cliente llamado.)
- **Q3 — Inactividad:** ¿liberar la estación **sola** tras N min sin latido y devolver a la fila lo que tenía? **Recomendado:** sí,
  15 min (el latido es cada 5). Sin esto, una estación abandonada bloquea hasta que alguien la libere.

## 7. Fases (cada una termina con pruebas verdes y verificación visual con Playwright)

1. **Servidor:** `exigirVentanilla` / `exigirMostrador`, fin del modo genérico, `liberar` de mostrador regresa a la fila,
   latido/`inactiva`, tomar el control. *Pruebas:* unitarias + Postgres (carreras, 403 por acción, ADMIN exento).
2. **Seed + datos de dev:** sin pre-asignaciones, mostradores de Mexicali/Monterrey, crear los de dev por el endpoint admin.
3. **Consolas:** `ElegirEstacionModal` común, observador, banners, deshabilitados, confirmación al liberar, logout de mostrador,
   evento "perdiste la estación". *Verificación:* escenarios de §5 en el navegador.
4. **TV de mostrador por puestos** (snapshot + tarjetas + "Cerrado"). *Verificación:* 1920×1080 con datos reales.
5. **Barrido de inactividad** (si Q3 = sí) en el scheduler existente.
6. Documentar en los dos `CLAUDE.md` y en memoria.

## 8. Riesgos

- Quitar el modo genérico **rompe** a una tienda sin mostradores: hay que crearlos antes de desplegar (lo cubre el seed y el
  paso de dev).
- `exigirVentanilla` en `liberar`/`no-se-presento` cambia el contrato de la API: el frontend viejo mostrará el 403 como toast.
- El barrido de inactividad toca pedidos en `EN_ATENCION` / `PENDIENTE_PAGO` en segundo plano: debe ir por la máquina de
  estados y con historial, nunca por `updateMany` de estado.

## 9. Ajustes del dueño (16-oct-2026, después de la primera entrega) — VIGENTES

1. **La TV de mostrador no revela el método de pago.** El aviso "A pagar" es el mismo para todos: **"A pagar → pasa a CAJA"**.
   - Quitar `destinoPago` del evento `pedido.enviado-a-pagar` (va a la sala de la tienda: lo recibe la TV pública). Debe llevar
     solo `{ id, numeroPedido }`.
   - `destinoPago` puede seguir en la **respuesta HTTP** al operador (su toast es privado), pero no en nada que llegue a una TV.
   - Frontend: `MonitorMostradorPagoAviso` ya no tiene variante "Transfiere"; `AvisoPago` pierde `destinoPago`. Actualizar los
     tests de `mostrador-llamar-y-presencia.spec.ts` ("el aviso lleva solo el folio") y las secciones de los dos `CLAUDE.md`.
2. **La TV de caja SÍ muestra a los de transferencia, de inmediato** (esto REVIERTE lo hecho el 16-oct: hoy `WHERE_COBRABLE`
   los oculta en la TV y `llamarSiguiente` los salta). Cambios: la TV usa `whereFilaDeCaja` sin `WHERE_COBRABLE`; la
   prioridad de las **verificadas** al frente se conserva (decisión anterior).
3. **Qué pasa cuando una transferencia sin validar llega a la ventanilla.** *(RESUELTO el 16-oct: ver §10. Sin tope de
   tiempo, sin aviso al cliente y "Llamar siguiente" las llama por orden de llegada.)* Si llega a caja y aún no está validada, el cajero
   tiene dos salidas: **(a) esperarla ahí** (se queda en su ventanilla, con aviso "sin validar — no cobrar"), o **(b) regresarla
   a la cola hasta que se valide**, conservando su lugar.
   - **Recomendación (a confirmar en la sesión nueva):**
     - "Llamar siguiente" **sí** llama en turno a las no validadas (están en la TV y el cliente espera ser llamado; saltarlas
       dejaría a un cliente viendo su folio "primero" sin que lo llamen nunca).
     - Acción nueva en la consola: **"Regresar a la cola hasta que se valide"** (`POST cajero/pedidos/:id/esperar-validacion`):
       suelta de la ventanilla **sin** cambiar `colaCajaDesdeAt` y lo marca para que "Llamar siguiente" **no lo vuelva a
       llamar** mientras la transferencia siga sin verificar (si no, bucle: lo llamaría otra vez de inmediato — el mismo problema
       que ya se resolvió con "No se presentó").
     - Al **verificarse** en Tesorería: vuelve a ser llamable y, por la regla de prioridad, pasa al frente; si está en una
       ventanilla esperando, la consola de esa cajera lo avisa (`pago.estado` ya llega a la tienda) y habilita cobrar/registrar.
     - En la TV se queda en su lugar de la cola (sin distintivo: no se revela nada).
   - Preguntas abiertas: ¿"esperar ahí" tiene tope de tiempo?; ¿el cliente ve en su app "te llamarán cuando se valide"?
4. **Endurecimiento (recomendado):** los endpoints que alimentan las TV (`/pedidos/mostrador/monitor`, `/cajero/pedidos/monitor`,
   `/bodega/pedidos/monitor`) devuelven hoy datos que la pantalla pública no muestra (nombres, totales, canal). Aunque la
   pantalla solo pinte el folio, el payload viaja al navegador de la pared. Reducir las TV públicas (mostrador y caja) a
   **folio + números**; bodega (operativa) puede conservar lo que usa.

## 10. Estado de implementación (cierre de la sesión del 16-oct, segunda parte)

**TODO lo de §9 y la lista de pendientes está hecho, probado y verificado en el navegador.** Backend 93 suites / 1414 pruebas
verdes; frontend compila, lint sin errores y `npm run test:monitores` (31 checks).

**Hecho en esta parte**
- §9.1 — el evento `pedido.enviado-a-pagar` lleva solo `{id, numeroPedido}`; el aviso de la TV es "A pagar → pasa a CAJA" para
  todos; `destinoPago` queda solo en la respuesta HTTP (toast de la operadora).
- §9.2 — la TV de caja muestra a los de transferencia de inmediato, sin distintivo, en su lugar de llegada.
- §9.3 — "Regresar a la cola hasta que se valide" (`POST cajero/pedidos/:id/esperar-validacion`, columna
  `pedidos.espera_validacion_desde_at`, migración `20261020120000_espera_validacion_caja`, YA aplicada a la BD de dev). Respuestas
  del dueño a las preguntas abiertas: **sin tope de tiempo y sin cronómetro**; **el cliente no ve aviso en su app** (solo TV y
  caja); **"Llamar siguiente" llama en turno a las no validadas, por orden de llegada, con la misma importancia** (el grupo "al
  final de la lista" desapareció de `ordenarFilaDeCaja`; `WHERE_COBRABLE` → `WHERE_LLAMABLE`).
- §9.4 — las TV públicas (mostrador y caja) reciben solo folio + números; el snapshot de mostrador perdió `listosParaEntregar`,
  `sinCliente` y la lista de "sin recoger". La TV de bodega no se tocó (es operativa).
- Consola de mostrador con `ElegirEstacionModal`, observador, acciones inhabilitadas sin mostrador (`MostradorAccionesPedido`,
  `BotonMarcarLlegada`, "sin aviso", detalle) y `mostrador.perdido`; `ElegirMostradorModal.tsx` borrado.
  `GET mostrador/puesto` trae `clientesEnCurso`.
- Cerrar sesión como `MOSTRADOR` suelta el mostrador.
- TV de mostrador por puestos (`MonitorMostradorCola` + `MonitorEstacionCard`, compartida con la TV de caja).

**Bugs que SOLO se vieron en el navegador** (y están corregidos): `useMiVentanilla` devolvía `""` y el selector de ventanilla no
se abría solo; el observador sobrevivía al cierre de sesión en la misma pestaña (la siguiente persona no veía el selector); el
modal decía "¿Liberar **la** mostrador?".

**Verificación (Playwright, tienda aislada "Verif Estaciones", ya borrada):** los 14 escenarios de §5 — selector al entrar y
salida como observador (caja y mostrador); cerrar con Esc / Cancelar / X; elegir libre; ocupada → 409 con quién; carrera de dos
a la vez (uno 201, otro 409, en caja y en mostrador); 403 del servidor en las 5 acciones de caja y las 12 de mostrador sin
estación; liberar con clientes (confirmación "N cliente(s)", conservan exactamente su `colaCajaDesdeAt`); tienda sin
mostradores; "me quitan la estación" (toast + observador sin perder la lista); barrido de inactividad (estaciones y pedidos
liberados solos); recarga en observador; cierre de sesión (suelta la estación y olvida el observador); ADMIN exento. Además las
TV a 1920×1080: aviso "TE TOCA → MOSTRADOR 1", tarjeta con folio, "Cerrado", aviso "A pagar → CAJA" idéntico para efectivo y
transferencia, y la TV de caja con la transferencia sin validar en su lugar.

**Pendiente:** nada de esta lista. Los escenarios nuevos del dueño (§11) también están hechos.

## 11. Escenarios nuevos del dueño (16-oct) — HECHO (tercera parte de la sesión del 16-oct)

El dueño planteó clientes que no encajan en "el cliente hace todo desde su teléfono": **llegan sin teléfono, sin acordarse del folio,
los manda su patrón (no son quien transfiere), no tienen internet o no saben subir el comprobante.** Sus respuestas: **orden estricto de
llegada** (sin prioridad para las verificadas), **comprobante solo por CAJERO**, y **campo "Recogió"** con el lugar a criterio del
equipo. Todo construido, probado (backend 94 suites / 1435 pruebas) y verificado en el navegador salvo la subida real (ver abajo).

| Situación | Resultado |
|---|---|
| Llega sin folio ni teléfono | El buscador (lupa, atajo `/`) es UN modal: campo + escáner QR + resultados con alto fijo; al elegir, el MISMO modal pasa al detalle (flecha para volver). Busca por folio, folio VFP, nombre, correo y teléfono. Mostrador lo usa también (se quitó su buscador propio). |
| Va a transferir otra persona / no tiene los datos | "Datos para transferir" en la tarjeta de caja: banco, beneficiario, CLABE, monto exacto, referencia, concepto, con "Copiar" — para mostrar o dictar. |
| No sabe subir el comprobante / no tiene internet | La cajera lo sube en su nombre (`POST pedidos/:id/pago-transferencia/comprobantes`, solo `CAJERO`): "Tomar foto" o "Elegir archivo", vista previa y confirmación. **No verifica**: pasa a revisión y Tesorería lo resuelve. Queda anotado quién lo subió; Tesorería lo ve "por la tienda (Ana)". |
| Espera a que Tesorería valide | Esperar en la ventanilla o "Regresar a la cola hasta que se valide" (§9.3). |
| Recoge un tercero (el mandadero) | `Pedido.recogioNombre` (migración `20261020130000`): el operador lo captura al confirmar la entrega ("El titular" / "Otra persona" + nombre). Se guarda solo si NO es el titular. Dónde se ve: **historial**, **detalle del pedido** (fila "Recogió", todos los roles y el cliente) y **correo "entregado"** ("Lo recogió: …; si no la reconoces, avísanos"). |
| Orden de la fila | Solo la llegada a caja. Desapareció `tienePrioridadDeCaja`; una verificada ya no pasa adelante ni una sin verificar va al final. |

**Verificación en el navegador:** "Recogió" completo (diálogo con validación de 3 letras, BD, historial, detalle "Cliente" e
"Historial" desde el buscador; "jose perez" = titular → no se guarda); buscador en modal (atajo `/`, resultados, detalle en el mismo
modal con flecha, datos para transferir con CLABE y monto exacto); selector de archivo con vista previa y envío. **La subida real
no se pudo completar en dev**: el servidor respondió 503 "No podemos recibir comprobantes en este momento" — es el cierre "falla
cerrado" de `ComprobanteStorageService` (el bucket de dev no pasa la prueba de privacidad; pendiente de AWS desde antes), no algo de
este cambio. El camino de éxito está cubierto por las pruebas de PostgreSQL (cajera sube → `EN_REVISION`, `subidoPorId`, evento
`porTienda`, vista de caja y de Tesorería, idempotencia, tope de 3, MOSTRADOR 403, otra tienda rechazada) y por
`rutas-con-estacion.spec.ts` (todo POST de caja/mostrador/pago-tienda exige estación).

**Pendiente:** probar la subida real cuando el bucket de comprobantes quede privado (o con `storage-privado/` local sin credenciales de S3).
