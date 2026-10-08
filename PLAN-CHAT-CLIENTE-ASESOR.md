# Plan: el chat cliente ↔ asesor de ventas

> Auditoría de las 4 superficies del chat (cliente, detalle de ventas, panel
> flotante de ventas, admin) y plan para dejarlo en una sola pieza.
>
> Estado: **propuesta, sin ejecutar.** Nada de este documento está aplicado.

---

## 0. Las tres decisiones que gobiernan el plan

Tomadas por el usuario antes de escribir esto:

1. **Unificar en una sola pieza.** Un `<ChatPedido>` compartido (burbuja +
   scroll + composer) para todas las superficies. Se borra lo duplicado.
2. **El "visto" se maneja en los dos lados.** Ticks correctos para el cliente
   *y* para el asesor, y los **no leídos** visibles en las listas (`/pedidos`
   del cliente y la cola de `/ventas`). El usuario acepta un ajuste de BD si
   hace falta.
3. **El panel flotante de `/ventas` se elimina.** El FAB con tabs de hasta 50
   pedidos. El asesor contesta desde el detalle del pedido.

La decisión 3 es la que más simplifica el trabajo: el panel era la superficie
con la burbuja duplicada, el scroll roto y sin ticks. Al borrarlo, la
"unificación" de la decisión 1 se reduce a extraer el scroll y el composer, no
a reescribir la burbuja.

---

## 1. Estado de partida (verificado, no asumido)

### 1.1 Las 4 superficies

| Superficie | Archivo | Burbuja | Scroll | Ticks | Composer |
|---|---|---|---|---|---|
| Cliente | `(customer)/pedidos/[id]/page.tsx:750-860` | `MensajeChat` | `useChatListScroll` + FAB | sí | propio |
| Detalle ventas | `(ventas)/ventas/pedidos/[id]/page.tsx:336-471` | `MensajeChat` | `useChatListScroll` + FAB | sí | propio |
| Panel ventas | `components/ventas/VentasChatPanel.tsx` + `ChatPanelContent.tsx` | **copia** (`MessageBubble`) | **inline, otra lógica** | **no** | propio |
| Admin | `admin/pedidos/[id]/page.tsx:145-152` | `MensajeChat` | **ninguno** | **no** | no (lectura) |

### 1.2 Lo que ya existe y funciona (no tocar)

- **`MensajeChat`** (`components/common/MensajeChat.tsx`) es la burbuja buena:
  ticks, chip de propuesta, animación de entrada con `prefers-reduced-motion`.
- **El modelo de watermarks en BD** (`prisma/schema.prisma:671-673`):
  `clienteUltimoMensajeEntregadoId`, `clienteUltimoMensajeLeidoId`,
  `tiendaUltimoMensajeLeidoId`. Documentado en el schema con el porqué de
  comparar por `id` y no por timestamp.
- **`POST /pedidos/:id/mensajes/leido`** (`messages.service.ts:432-510`):
  idempotente, con guard `OR` para evitar el race read-modify-write, clampea
  ids bogus, emite `mensaje.leido` a los dos lados.
- **`useChatLectura`** (bump con debounce 500ms) y **`TicsMensaje`**.
- **`PropuestasPanel`** con `propuestaEnFoco`: abre el tab correcto, resalta y
  scrollea a la propuesta concreta.
- **`ChipPropuestaAdjunta`**: el chat anuncia la propuesta, no la pinta.

### 1.3 La deuda

| Pieza | Dónde | Qué pasa |
|---|---|---|
| Burbuja duplicada | `ChatPanelContent.tsx:246-323` | `MessageBubble` + `RespuestaResumenCard` son copias de `MensajeChat` |
| Scroll duplicado | `ChatPanelContent.tsx:95-130` | Otra implementación, otro umbral, otra forma de encontrar el viewport |
| Composer triplicado | 3 archivos | 3 alineaciones distintas del botón |
| Parseo legacy | `MensajeChat.tsx:93-102`, `ChatPanelContent.tsx:261-267` | `@@PROPUESTA@@`/`@@RESPUESTA@@` |
| Props muertas | varias | `headerSlot`, `ocultarPorColision`, `alturaScroll` como string mágico |
| Sin tests | — | 0 specs del chat en frontend; `messages.service.ts` sin spec |

---

## 2. Los 4 problemas reportados, con causa raíz

### 2.1 "A veces hace scroll al último mensaje, a veces no"

Son **tres bugs distintos** según la superficie. Por eso el síntoma es
intermitente: cada superficie falla por su propia razón.

**(a) El panel mide "estoy cerca del fondo" DESPUÉS de que el DOM creció.**
`ChatPanelContent.tsx:102-108` evalúa el umbral de 80px dentro del
`requestAnimationFrame`, cuando el mensaje nuevo ya está insertado. Si el
mensaje mide más de 80px (una propuesta con chip + texto), la distancia ya
superó el umbral y **no scrollea nunca**. Con mensajes cortos funciona. Ese es
el "a veces".

**(b) `useChatListScroll` puede quedarse sin listener.**
El listener se engancha en un `useEffect(..., [])` sobre `ref.current`
(`useChatListScroll.ts:31-48`). En la página del cliente el chat vive dentro de
`{mostrarChat && <Card>}` (`page.tsx:755`) y `mostrarChat` es `false` hasta que
llega el primer mensaje. En el primer commit `ref.current` es `null` → el efecto
sale temprano y **nunca se vuelve a intentar**. Consecuencias:

- `cercaDelFondoRef` se queda en `true` para siempre → te arrastra al fondo
  aunque estés leyendo historial.
- `noLeidosRef` nunca incrementa (solo pasa en el `else`) → **el FAB "ir al
  fondo" no aparece nunca**.

Es un `ref` que se adjunta después del efecto: el patrón correcto es un
*callback ref*, no un `useEffect` con `[]`.

**(c) Nadie escucha cambios de tamaño del contenido.** No hay `ResizeObserver`
en ningún lado. Cualquier cosa que crezca después del scroll —una imagen con
`loading="lazy"`, el chip de propuesta, la animación de entrada— deja la
posición a medio camino. Es el "respeta el scroll donde lo dejaste".

**(d) Ruido:** en las dos páginas hay un `useEffect(() => scrollChat.tick(),
[mensajes, scrollChat])` (`page.tsx:425-427`, `ventas/.../page.tsx:378-380`)
que solo fuerza un re-render de más. El hook ya tiene su propio efecto de deps.

### 2.2 "El input y el botón no están del mismo tamaño / se desacomoda al escribir"

Los tres composers usan `flex items-stretch gap-2` pero con reglas distintas:

| Superficie | Botón | Alto efectivo | Alineación |
|---|---|---|---|
| Cliente (`page.tsx:844`) | `size="icon"` + `self-end shrink-0` | 48px | abajo |
| Panel (`ChatPanelContent.tsx:219`) | `size="icon"` + `h-10 w-10 self-end` | 40px | abajo |
| Detalle ventas (`ventas/.../page.tsx:464`) | `<Button>` sin `size` | 48px | **arriba** |

Y el `Textarea` base trae `min-h-16` (64px) que cada caller pisa con
`min-h-[40px]`… pero además tiene `field-sizing-content`, así que **crece solo**
hasta `max-h-32` (128px). O sea: el botón mide 40, 48 o 48 según dónde estés, el
textarea arranca en 40 y crece a 128, y la alineación es abajo-abajo-arriba. Eso
es el desacomodo.

### 2.3 "Las palomitas azules del visto — creo que no está implementado"

**Están invertidas.** `estadoMensaje` (`useChatLectura.ts:151-153`) compara
contra la marca del **propio** lado:

```ts
const watermark = miLado === 'cliente'
  ? pedido.clienteUltimoMensajeLeidoId   // ← la bumpea el CLIENTE
  : pedido.tiendaUltimoMensajeLeidoId;   // ← la bumpea la TIENDA
```

Pero cada lado bumpea su watermark con el **id más alto de toda la lista,
incluidos sus propios mensajes** (`ventas/.../page.tsx:365-371`). Entonces, en
cuanto el asesor manda un mensaje, `m.id <= watermark` → **✓✓ azul inmediato,
aunque el cliente no lo haya abierto**. Lo mismo del lado del cliente.

El "visto" siempre está en azul para tus propios mensajes: **no comunica nada**.
Por eso parece no implementado — funcionalmente lo está.

Mismo problema con `'entregado'` (✓✓ gris): se alimenta de
`clienteUltimoMensajeEntregadoId`, que también bumpea el propio cliente al
recibir el eco. El lado equivocado otra vez.

**El arreglo es de una línea** (comparar contra el lado contrario). Lo que sí
necesita diseño es lo de §4.

### 2.4 "Al enviar una propuesta debería llevarme a verla, pero scrollea el chat"

`PropuestasPanel.tsx:147-170` ya usa `window.scrollTo` (no `scrollIntoView`) —
el comentario explica que antes sí scrolleaba el chat. Pero quedó un **race**:

```ts
const frame1 = requestAnimationFrame(() => {
  frame2 = requestAnimationFrame(() => { window.scrollTo(...) });
});
onFocoConsumido?.();   // ← limpia propuestaEnFoco en el padre, SÍNCRONO
return () => { cancelAnimationFrame(frame1); ... };  // ← el cleanup mata el scroll
```

`onFocoConsumido()` dispara un `setState` en el padre → `propuestaEnFoco` pasa a
`null` → cambian las deps → React corre el cleanup **antes** de que el RAF
dispare → `cancelAnimationFrame` cancela el scroll. Depende de cuándo React
procese el `setState`, así que es una carrera: a veces scrollea, a veces no. Y
como el chat tiene su propio auto-scroll, lo que se percibe es "scrolleó el
chat".

**Nota:** `PropuestasPanel.tsx` y `ChipPropuestaAdjunta.tsx` están **sin
commitear** (`??` en `git status`). Parte de esto puede ser trabajo en vuelo.

---

## 3. Código de más

- **Burbuja duplicada**: `MessageBubble` (`ChatPanelContent.tsx:246-323`) vs
  `MensajeChat`. Y `RespuestaResumenCard` vs `RespuestaCard` — dos renderers del
  mismo formato legacy.
- **Parseo legacy** `@@PROPUESTA@@`/`@@RESPUESTA@@` vivo en las dos burbujas
  (~120 líneas). El modelo nuevo es `adjunto` en JSON. **Solo se borra si §8.1
  confirma que no hay mensajes viejos en la BD.**
- **Props muertas**: `headerSlot` (`ChatPanelContent.tsx:62`, nadie lo pasa),
  `ocultarPorColision` (`VentasChatPanel.tsx:54`, siempre `false`),
  `productosById` documentado en el JSDoc de `ChatPanelContent:43` pero no es
  prop.
- **`useChatLectura.ts:95-104`**: el `useEffect` de `onMensajeRecibido` solo
  devuelve un cleanup — no hace nada. Indirección muerta; el padre lo llama en
  un efecto aparte.
- **`alturaScroll` es un string mágico**: `'flex-1'` se compara por igualdad para
  elegir clases (`ChatPanelContent.tsx:155,175`).
- **Backend inconsistente**: `crearConAdjunto` deja a **BODEGA** escribir en el
  chat (`messages.service.ts:270`), pero `crear` lo prohíbe explícitamente
  (`:69`). `CLAUDE.md` dice que desde F13 bodega no lee ni escribe. Es un permiso
  que quedó de F14 y que F17 ya hizo innecesario (el servidor arma la propuesta
  de bodega solo).
- **Comentario fantasma**: `ventas/.../page.tsx:418` dice `{/* F15: indicador
  "escribiendo…" del cliente. */}` y debajo solo hay un `.map()`. **No existe
  ningún typing indicator** en frontend ni backend. El comentario miente.

---

## 4. El modelo de leído / no leído (el corazón del plan)

Hoy hay **dos mecanismos que no se hablan**:

1. **Los watermarks en BD** (§1.2) — correctos en su forma, mal comparados.
2. **Un contador en `localStorage`** (`stores/notificacionesCliente.ts`) que
   incrementa con cada `mensaje.creado` y se limpia al abrir el pedido.

El contador local es la fuente del "no leído" en `/pedidos`, y es frágil: es
por dispositivo, se pierde al limpiar el navegador, y si el cliente no tenía la
app abierta no cuenta nada. La cola de `/ventas` **no tiene badge de no leídos
en absoluto**.

### 4.1 La regla correcta

Un watermark es "el id más alto que **este lado** vio". Para MI mensaje `m`:

```
entregado  ⟺  watermark_entregado_del_OTRO_lado >= m.id
leído      ⟺  watermark_leido_del_OTRO_lado    >= m.id
```

| Autor de `m` | ¿Leído? | ¿Entregado? |
|---|---|---|
| Asesor | `clienteUltimoMensajeLeidoId >= m.id` | `clienteUltimoMensajeEntregadoId >= m.id` |
| Cliente | `tiendaUltimoMensajeLeidoId >= m.id` | *(no existe)* |

Bumpear con el id más alto de toda la lista sigue siendo correcto — el
watermark es "lo más alto que vi", y la comparación es cruzada. **No hace falta
cambiar cómo se bumpea, solo contra qué se compara.**

### 4.2 La decisión de BD

Hay **una asimetría real**: existe `clienteUltimoMensajeEntregadoId` pero no su
equivalente de tienda. Dos caminos:

**Opción A — dos estados (recomendada).** `✓ enviado` / `✓✓ azul leído`. Sin
migración. Simétrico, y el "entregado" no aporta en un chat 1:1 donde el otro
lado es un asesor en una tablet que está siempre en línea. Se **elimina** el
estado `'entregado'` del frontend y se deja la columna `clienteUltimoMensajeEntregadoId`
en BD (no se borra: es dato histórico y borrar una columna es irreversible).

**Opción B — tres estados.** Agregar `tiendaUltimoMensajeEntregadoId` (migración)
y que el lado tienda lo bumpee al recibir el eco del socket. Más fiel a
WhatsApp, más piezas móviles, y el valor marginal es distinguir "el socket no
llegó" de "llegó y no lo abrió" — que en este contexto casi nunca cambia una
decisión.

**Recomiendo A.** Si producto pide el ✓✓ gris después, B es aditivo y no rompe
nada.

### 4.3 Los no leídos en las listas

Se **derivan del backend**, no de `localStorage`. Para el cliente:

```sql
SELECT p.id, COUNT(m.id) AS no_leidos
FROM pedidos p
LEFT JOIN pedidos_mensajes m
  ON m.pedido_id = p.id
 AND m.id > COALESCE(p.cliente_ultimo_mensaje_leido_id, 0)
 AND m.autor_rol <> 'CLIENTE'
 AND m.visible_para_cliente = true
WHERE p.usuario_id = $1
GROUP BY p.id
```

Y para la cola de ventas, el espejo: `m.autor_rol = 'CLIENTE'` y
`m.id > COALESCE(p.tienda_ultimo_mensaje_leido_id, 0)`.

**Por qué SQL crudo y no Prisma:** el umbral es una columna del padre, y
Prisma no puede referenciar la fila padre desde un `_count` filtrado. Las
alternativas son N+1 o traer todos los mensajes. Una subconsulta correlacionada
es un round-trip y el índice `@@index([pedidoId, createdAt])` ya existe
(`schema.prisma:873`).

Con esto se **borra** `stores/notificacionesCliente.ts` (el contador `noLeidos`;
`pendientesAprobacion` ya se deriva del backend desde F18 y también se puede
podar). El badge se refresca invalidando la lista en `mensaje.creado` — que en
la cola de ventas ya pasa, y en `/pedidos` hay que agregar.

**Efecto colateral bueno:** el badge deja de ser por dispositivo. Hoy, si abres
el pedido en el celular, la laptop sigue mostrando el badge.

---

## 5. Arquitectura objetivo

### 5.1 Una sola pieza

```
components/chat/
├── ChatPedido.tsx        ← NUEVO: header + scroll + FAB + composer
├── MensajeChat.tsx       ← se queda (burbuja única)
├── TicsMensaje.tsx       ← se queda
├── BotonIrAlFondo.tsx    ← se queda
└── useChatScroll.ts      ← NUEVO: reemplaza useChatListScroll

lib/hooks/
├── useChatLectura.ts     ← se queda, arreglado
└── useChatListScroll.ts  ← SE BORRA
```

`<ChatPedido>` recibe `pedidoId`, `items`, `miLado`, `miUserId`, `pedidoLectura`,
`puedeEscribir`, `onIrAPropuesta`. Las dos páginas lo montan y dejan de tener su
propio composer y su propio scroll.

**Admin** monta `<ChatPedido puedeEscribir={false}>` — gana scroll y ticks
gratis. (Hoy no tiene ninguno de los dos.)

### 5.2 El scroll, correcto

El algoritmo que resuelve (a), (b) y (c) de §2.1:

```
- Callback ref (no useEffect con []): el listener se engancha cuando el nodo
  existe de verdad, aunque monte tarde.
- Medir la distancia al fondo ANTES de que el DOM crezca: se guarda en el
  listener de scroll (que ya es el momento correcto) y NUNCA se recalcula
  después de insertar.
- useLayoutEffect, no useEffect: el scroll ocurre antes del paint, así no se ve
  el salto.
- ResizeObserver sobre el contenido: si el usuario estaba pegado al fondo y el
  contenido creció (imagen lazy, chip, animación), re-scroll.
- En mount con contenido ya cargado: salto instantáneo al fondo, sin smooth.
- El FAB aparece solo si el usuario subió Y llegaron mensajes nuevos.
```

### 5.3 El composer, uno solo

```
<div className="flex items-end gap-2">
  <Textarea className="flex-1 resize-none min-h-[44px] max-h-32" />
  <Button size="icon-sm" className="shrink-0" />   ← 40px, items-end
</div>
```

`items-end` (no `items-stretch`) alinea el botón al fondo del textarea cuando
crece. El botón es `icon-sm` (40px) en las tres superficies. Un solo sitio.

---

## 6. Animaciones: qué queda y qué se va

| Animación | Dónde | Veredicto |
|---|---|---|
| Entrada de burbuja (spring + fade) | `MensajeChat.tsx:167-201` | **Se queda, pero se arregla** (ver abajo) |
| `animate-propuesta-foco` (1.6s) | `globals.css:534-541` | Se queda |
| `BotonIrAlFondo` (spring + AnimatePresence) | `BotonIrAlFondo.tsx` | Se queda |
| Tabs del panel (`active:scale-95`) | `VentasChatPanel.tsx:268` | Se va con el panel |
| **Typing indicator** | **no existe** | Se borra el comentario que lo menciona |

**El problema de la animación de entrada:** `BubbleEntrada` usa
`layout="position"` **en todas** las burbujas (`MensajeChat.tsx:183`). Eso hace
que framer-motion mida y anime cada burbuja en cada cambio de la lista. Con 50
mensajes eso es caro, y **pelea con el auto-scroll**: la animación de layout
mueve las cosas mientras nosotros seteamos `scrollTop`, y el resultado es una
posición a medio camino. Es un contribuyente real al §2.1(c).

Arreglo: quitar `layout="position"` de las burbujas y animar **solo la última**
(la recién llegada). Las demás ya están pintadas; no tienen por qué re-animarse.

El `useReducedMotion` de `MensajeChat.tsx:178` está bien y se conserva.

---

## 7. Plan de ejecución por fases

Cada fase deja el repo compilando y verde.

### Fase 0 — Pre-flight (verificar, no asumir)

- [ ] **¿Hay mensajes legacy en la BD?** Esto decide si el parseo `@@PROPUESTA@@`
      se puede borrar:
      ```sql
      SELECT COUNT(*) FROM pedidos_mensajes
      WHERE contenido LIKE '%@@PROPUESTA@@%' OR contenido LIKE '%@@RESPUESTA@@%';
      ```
      Si es 0 → se borra el parseo. Si no → se conserva y se marca como deuda.
- [ ] Correr `npm test` en backend (39 suites) y `npm run lint` en los dos repos
      **antes** de tocar nada (el lint usa `--fix` y formatea: hay que
      fotografiarlo antes).
- [ ] Confirmar el estado de `PropuestasPanel.tsx` / `ChipPropuestaAdjunta.tsx`
      (sin commitear): commitear o descartar antes de empezar, para que el diff
      sea legible.

### Fase 1 — Borrar el panel flotante

- [ ] Borrar `components/ventas/VentasChatPanel.tsx` y
      `components/ventas/ChatPanelContent.tsx`.
- [ ] Quitar `<VentasChatPanel>` de `(ventas)/ventas/page.tsx:173` y sus imports.
- [ ] Limpiar el JSDoc huérfano de `onAbrirChat` en `BodegaSurtidoSheet.tsx:88-91`.
- [ ] `grep -rn "ChatPanelContent\|VentasChatPanel"` → 0 resultados.

**Gana:** se va la burbuja duplicada, el scroll roto y el composer de 40px, de
un golpe. La cola de `/ventas` gana espacio vertical.

### Fase 2 — Los ticks correctos

- [ ] `estadoMensaje` (`useChatLectura.ts:140-163`): comparar contra el
      watermark del **lado contrario**.
- [ ] Eliminar el estado `'entregado'` de `EstadoMensaje` y de `TicsMensaje`
      (Opción A de §4.2). Dejar la columna en BD.
- [ ] Borrar el `useEffect` no-op de `useChatLectura.ts:95-104`.
- [ ] Verificar el caso "el asesor manda y el cliente no ha abierto": debe
      quedar en ✓, no en ✓✓.

### Fase 3 — No leídos en las listas

- [ ] Backend: agregar `mensajesNoLeidos` a `obtenerMisPedidos`
      (`cliente.service.ts:294`) y a `obtenerCola` (`ventas.service.ts:74`) con
      la subconsulta de §4.3.
- [ ] Frontend `/pedidos`: el badge lee `p.mensajesNoLeidos`, no el store.
- [ ] Frontend `/ventas`: badge nuevo en la tarjeta de la cola.
- [ ] Invalidar `qk.misPedidos` en `mensaje.creado` (en `/pedidos` hoy solo se
      invalida en `pedido.estado`).
- [ ] Borrar el contador `noLeidos` de `stores/notificacionesCliente.ts`.

### Fase 4 — Un solo chat

- [ ] `useChatScroll`: reescribir con callback ref + `useLayoutEffect` +
      `ResizeObserver` (§5.2). Borrar `useChatListScroll.ts`.
- [ ] `ChatPedido`: extraer de la página del cliente, con el composer de §5.3.
- [ ] Montarlo en cliente, detalle de ventas y admin (lectura).
- [ ] Quitar los dos `useEffect(() => scrollChat.tick(), ...)` redundantes.

### Fase 5 — Animaciones

- [ ] Quitar `layout="position"` de `BubbleEntrada`; animar solo la última.
- [ ] Borrar el comentario fantasma de typing (`ventas/.../page.tsx:418`).

### Fase 6 — El race del scroll a la propuesta

- [ ] `PropuestasPanel.tsx:147-170`: no llamar `onFocoConsumido()` antes del
      RAF. Consumirlo **dentro** del segundo frame, después del `scrollTo`.
- [ ] Probar: chip de una propuesta del historial (tab "anteriores") y de la
      vigente.

### Fase 7 — Limpieza

- [ ] Borrar el parseo legacy (si Fase 0 lo autoriza) y los dos renderers de
      `@@RESPUESTA@@`.
- [ ] Quitar `headerSlot`, `ocultarPorColision`, `alturaScroll`-string.
- [ ] `crearConAdjunto`: sacar a BODEGA de la lista de roles que escriben
      (`messages.service.ts:270`), o documentar por qué se queda.
- [ ] Tests: un spec de `messages.service.marcarLeido` (idempotencia, clamp,
      no decremento) y uno del conteo de no leídos.

---

## 8. Verificación

- [ ] `npm test` backend (39 suites / 411 tests) verde.
- [ ] `npm run lint` en los dos repos.
- [ ] Manual, en las 3 superficies que quedan:
  - Abrir un pedido con 30+ mensajes → aterriza al fondo, sin salto visible.
  - Subir a leer historial → llega un mensaje → **no** te arrastra, el FAB
    aparece con contador.
  - Tap al FAB → baja y el contador se limpia.
  - Mandar un mensaje con texto largo → el botón queda alineado al fondo.
  - Escribir 5 líneas → el textarea crece, el botón sigue al fondo.
  - Asesor manda → el cliente **no** abrió → ✓ (no ✓✓).
  - Cliente abre → ✓✓ azul en la pantalla del asesor.
  - Chip de propuesta del historial → scrollea la **página**, no el chat.
  - `/pedidos` y `/ventas` muestran el badge de no leídos correcto.

---

## 9. Lo que NO hay que tocar

- `MensajeChat` como burbuja única (solo se le quita el `layout`).
- El modelo de watermarks en BD y `marcarLeido` — el backend está bien.
- `TicsMensaje`, `BotonIrAlFondo`, `ChipPropuestaAdjunta`.
- `PropuestasPanel` (salvo el race de §7-Fase 6).
- La separación propuesta / chat: la propuesta es una decisión de dinero y vive
  en su sección. Eso ya está bien resuelto.
- El email de "primera respuesta del asesor" (`MensajeBodegueroEnviado`).

---

## 10. Riesgos

| Riesgo | Mitigación |
|---|---|
| Borrar el parseo legacy con mensajes viejos en BD | Fase 0 lo verifica con SQL antes |
| El conteo de no leídos con SQL crudo se desvía del ORM | Un spec que compare contra el conteo en memoria |
| Borrar el panel deja al asesor sin acceso rápido | El detalle ya tiene el chat completo; la cola gana badge de no leídos |
| `PropuestasPanel` sin commitear | Commitear o descartar antes de empezar (Fase 0) |
