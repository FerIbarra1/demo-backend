# Auditoría de textos — 19 de octubre de 2026

Qué se leyó, qué estaba mal, qué se corrigió y qué queda por decidir. Complementa a `AUDITORIA-2026-10.md` (esa es de código; esta es de lo que **lee la gente**).

## Alcance y método

| Superficie | Cuánto | Cómo |
|---|---|---|
| Frontend (todos los `.tsx`) | **2 570 textos** | Extraídos con el compilador de TypeScript: texto JSX, atributos (`placeholder`, `title`, `label`…), toasts y literales de texto. Se leyeron completos los del cliente (web, kiosko, pago, cuenta, catálogo, home) y se revisaron por patrones los del personal. |
| Correos | **20 plantillas + 20 asuntos** | Renderizados a texto plano, tal como los lee el cliente. |
| Errores del backend | **515 mensajes** de `throw new …Exception` | Extraídos con el compilador; leídos los que un cliente puede provocar. |
| Toasts | **205 llamadas en 49 archivos** | Patrones de redacción (no el diseño visual, que se audita aparte). |
| Páginas legales (`privacidad`, `cookies`, `terminos`) | 224 textos | **No auditadas**: necesitan revisión legal, no de redacción. |

Lo visual de los toasts (oscuros, `richColors`, sin `ThemeProvider`) queda para la auditoría de estilo completa.

## Lo más importante

1. **Se mostraban reseñas inventadas.** La vista rápida de cada producto pintaba 4 estrellas y «(4.8) · 128 reseñas» escritos a mano en el código. Era el mismo dato para *todos* los productos. **Corregido** (se quitó).
2. **El mismo estado se llamaba distinto en cada pantalla**, y la barra de pasos tenía cuatro defectos de diseño (ver §1). **Rediseñada.**
3. **Un pedido a domicilio no tiene camino de pago definido** (ver §6). Eso es una decisión de producto, no de redacción: **necesito tu respuesta.**
4. **Textos que decían algo falso**: «te propondremos una sustitución» (las sustituciones se eliminaron), «Tu folio» sobre un número que no es el folio, «Pasa a caja a pagar… ya revisaste tu pedido en mostrador» a quien pidió envío a domicilio. **Corregidos.**

---

## 1. El seguimiento del pedido (el «semáforo»)

### Qué estaba mal

La barra pintaba el estado interno casi tal cual: `Recibido · En revisión · Revísalo en tienda · Te están atendiendo · Pago · Entregado`.

| # | Defecto | Efecto |
|---|---|---|
| 1 | El paso **actual** se pintaba igual de verde que los ya hechos | «Pago» salía en verde con el pedido **sin pagar** |
| 2 | Un pedido a **domicilio** veía «Revísalo en tienda» y «Te están atendiendo» | Pasos que nunca ocurren, marcados como logrados |
| 3 | Un mismo estado con **tres nombres** | `REVISADO` era «Revísalo en tienda» (barra), «Listo en tienda · revísalo» (etiqueta y correo) y una frase más (lista) |
| 4 | «Revisado» y «Te están atendiendo» eran **dos pasos** de lo que para el cliente es **uno**: su pedido ya está en la tienda | Barra larga, sin información nueva |
| 5 | Dos voces mezcladas en una sola tabla | «Esperando **tu** aprobación» y «**Te** estamos atendiendo» salían tal cual en las tablas de admin y mostrador |
| 6 | La lista decía «Pasa a la ventanilla indicada en la TV» a **todo** pedido por pagar | Falso para transferencia y para domicilio |

### Cómo lo hacen los sistemas maduros (Amazon, Apple, Uber Eats, Domino's)

- **Pocos hitos** (5–6), con nombres del *cliente*, no del piso.
- **Tres situaciones visibles y distintas**: hecho (verde + palomita), actual (resaltado, *no* verde: aún no termina), pendiente (atenuado). Nunca solo por color.
- Una frase de **qué está pasando ahora** y otra de **qué sigue**, en vez de dejar que la barra lo explique sola.
- **Recorrido distinto** por tipo de entrega.
- Las **excepciones no son pasos**: son el mismo hito con otro color (terracota si el cliente tiene que decidir).
- El hito de pago **cambia de texto** en lugar de agregar otro.

### Lo que se implementó

`demo-frontend/src/lib/utils/seguimiento.ts` (módulo puro, 55 pruebas). Una sola fuente del texto; la barra, la lista de «Mis pedidos», el filtro y el historial leen de ahí.

**Recoger en tienda (web y kiosko)**

| Estado interno | Barra | Titular | Qué sigue |
|---|---|---|---|
| `SOLICITADO` | **Recibido●** | Recibimos tu pedido | En breve nuestro equipo empezará a prepararlo. |
| `EN_REVISION` | Recibido✔ **Preparando●** | Estamos preparando tu pedido | Reunimos y revisamos tus piezas. Te avisamos en cuanto esté listo. |
| `ESPERANDO_APROBACION` | Recibido✔ **Tu decisión⚠** | Necesitamos tu decisión | Hay cambios en tu pedido. Revisa la propuesta y confirma o pide ajustes. |
| `REVISADO` | …✔ **Listo en tienda●** | Tu pedido está listo en tienda | Pasa a mostrador a revisarlo con nosotros antes de pagar. |
| `EN_ATENCION` | …✔ **En atención●** *(mismo hito)* | Te están atendiendo en mostrador | Revisa tus piezas con quien te atiende. Después pasas a pagar. |
| `PENDIENTE_PAGO` | Revisado✔ **Pendiente de pago●** | Pendiente de pago | *(lo dice la tarjeta «Pasa a caja a pagar»)* |
| `PAGADO` | **Pagado✔** · **Por recoger●** | Pago recibido | *(la tarjeta dice «Pasa por tu pedido»)* |
| `ENTREGADO` | todo ✔ | Pedido entregado | Gracias por tu compra. |

**A domicilio:** `Recibido · Preparando · Pago · Envío · Entrega` — sin pasos de tienda. `PAGADO` → «Preparando envío»; `ENVIADO` → «En camino» + «Va con Estafeta».

**Tu idea del pago, tal cual:** un solo hito. `Pago` (pendiente) → **`Pendiente de pago`** (actual, *no* verde) → **`Pagado`** (verde con palomita).

**Por qué «Revisado» y «Te están atendiendo» ahora son un solo hito (`Listo en tienda`):** para el cliente son un momento — su pedido ya está en la tienda y él pasa a mostrador. Lo que cambia entre uno y otro es el *detalle* (esperar turno / ya te atienden), no el hito. El texto del hito sí cambia a «En atención» cuando lo llaman.

**Se mantuvo separado del personal.** `ESTADO_PEDIDO_LABEL` (consolas) conserva los nombres del negocio (Solicitado, En revisión…) pero ya en voz neutra. El cliente, el kiosko y el historial del cliente usan `ETIQUETA_ESTADO` (Recibido, En preparación…). El servidor (`mail/estado-labels.ts`) y el frontend fijan **la misma tabla** con pruebas.

---

## 2. Vocabulario canónico (decisiones aplicadas)

| Concepto | Se dice | No se dice | Dónde estaba mal |
|---|---|---|---|
| Dónde se paga | **caja**; «ventanilla N» es la ventana concreta que anuncia la pantalla | «ventanilla» como lugar | `SiguientePasoCard` (kiosko «ventanilla», web «caja»), lista («la ventanilla indicada en la TV») |
| Qué ve el cliente de su número | **Pedido en línea** `PD-…` y **folio** | «Sistema Comercial», «VFP», `#id` | ver auditoría anterior; correos |
| El equipo | **nuestro equipo / la tienda** | «bodega», «el administrador» | confirmación, confirmar, carrito, kiosko, cancelar pedido |
| Un correo | **correo** | «email» (mezclado) | `tu@email.com`, «recibiste por email» |
| Plural | **1 producto / 3 productos** (`conteo()`) | `producto(s)` (43 apariciones) | carrito, confirmar, lista |
| Puntos suspensivos | **…** (80 usos) | `...` (27 usos) | login, registro, kiosko, catálogo |

---

## 3. Hallazgos por superficie

Estado: ✅ corregido hoy · ⏳ pendiente (la decisión es tuya) · 📝 recomendación

### Catálogo y producto
- ✅ Reseñas «(4.8) · 128 reseñas» y 4 estrellas fijas — `ProductQuickView`.
- ✅ Descripción inventada «Camiseta de alta calidad con diseño exclusivo…» que salía en **todo** producto sin descripción (y en la otra vista, sin acentos: «diseno», «ocasion») — ahora no se pinta nada si no hay descripción real.
- ✅ «Catalogo», «Compartir este codigo…», «Tambien te puede gustar» sin acento.
- ⏳ «**Captura** cuántas piezas quieres de cada talla» / «Captura las cantidades»: «capturar» es jerga de quien teclea en el sistema; al cliente: «Elige cuántas piezas de cada talla».
- ⏳ `NavbarSearchOverlay`: sugerencias de búsqueda para BODEGA escritas a mano («Pedido #1234», «Producto XYZ»). Son marcadores, no sugerencias.

### Carrito → confirmar → gracias
- ✅ **«Gracias»** no mostraba el número del pedido y daba las mismas instrucciones a quien pidió domicilio. Ahora recibe `?pedido=PD-…&entrega=domicilio`.
- ✅ «Te propondremos una **sustitución**» (ya no existen) → «te enviamos una propuesta para que decidas».
- ✅ «Dejar que el **administrador** decida» → «Que la tienda elija la paquetería».
- ✅ «El total final lo confirma **bodega**…» (×4) → «se confirma al revisar tu pedido».
- ✅ `Seguir Comprando`, `Ver Mis Pedidos` (Title Case) en esa pantalla; `Enviando...`.
- ⏳ «Resumen del pedido» / «Resumen de tu cuenta» / «Resumen» (carrito) — tres «Resumen» en el mismo flujo.

### Mis pedidos y detalle del pedido
- ✅ Frases por estado de la lista (decían «Bodega revisará…», «ventanilla indicada en la TV» a todo pedido por pagar).
- ✅ «…y **bodega será notificada**» al cancelar (el cliente no necesita saberlo).
- ✅ Buscador: «Buscar por folio o número de pedido».
- ⏳ Chat con el asesor: **tres** instrucciones de Enter (título, descripción y placeholder) y dos encabezados casi iguales («Chat con tu asesor» / «Conversación con tu asesor de ventas sobre este pedido»).
- ⏳ `puedeCancelar` de la lista ofrece cancelar en 4 estados; el servidor permite 7. No es de redacción: la pantalla mapea estado→acción, contra la regla del proyecto.

### Propuestas
- ✅ «Este mensaje se **adjuntara**» → «adjuntará». «depende de que **bodega** confirme» → «confirmemos».
- ✅ Verificado y **sin cambio**: el nombre depende de quién mira («Propuesta de tu asesor» / «de la tienda» al cliente; «de bodega» solo en mostrador).
- 📝 Tres nombres para lo mismo («propuesta», «ajuste», «cambios propuestos») entre pantalla, asunto y título del correo.

### Kiosko
- ✅ «**Tu folio**» encabezaba el `PD-…`, que no es el folio (el folio no existe hasta surtir). → «Tu número de pedido».
- ✅ «Pedido efectuado, gracias :)» → «¡Listo! Recibimos tu pedido». «**Bodega** ya está preparando» → «Ya estamos preparando».
- ✅ «Elige cómo identificar**nos** tu pedido» (error gramatical). «por email» → «por correo».
- ✅ «No encontramos ese **folio**» cuando el dato era un código QR.
- ✅ Pantalla de kiosko apagado: «cuando el **administrador** lo habilite» (además era falso si el kiosko hay que vincularlo de nuevo).
- ⏳ «**Identidad Digital**» / «Tu Identidad Digital» / «Acceso Kiosko»: jerga y Title Case. Propuesta: «Tu código de acceso».
- ✅ Los dos métodos de aviso (QR / folio) ya dicen lo mismo de dónde está el folio («en tu ticket o en tu correo»).
- ⏳ Ninguna pantalla anticipa que además del folio se piden los **últimos 4 dígitos del teléfono**; el cliente lo descubre en el paso siguiente.

### Correos (20)
- ✅ Todo correo rotulaba «**Folio:** PD-2026-…» cuando aún no hay folio. Ahora «Pedido:» hasta que existe y «Folio:» después.
- ✅ «Tu pedido ya está en la **cola de bodega**» → «ya lo está preparando». El «Te avisaremos… cuando esté listo para revisar en tienda» ahora tiene variante de **domicilio**.
- ✅ «Tu pedido va a domicilio: **ya puedes completar el pago**… salga **a camino**» prometía un pago sin forma de hacerlo (ver §6).
- ✅ Asunto de «listo para pagar» con folio crudo; correo del chat con el `PD-…` (auditoría anterior).
- ⏳ `PedidoCancelado`: «Motivo: Cancelado por el cliente» cuando lo canceló el propio cliente.
- ⏳ «¡Bienvenido a **PTM**!» (sigla que el cliente no conoce).
- 📝 Los tipos `PROPUESTA_VENTAS` y `REVISION_RECHAZADA` siguen muertos (documentado en `CLAUDE.md`).

### Errores del servidor que lee el cliente
- ✅ «El email ya está registrado» → «Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.»
- ✅ «**Debe** seleccionar una tienda…» (usted) → «Elige una tienda para hacer tu pedido.»
- ✅ «…(estado: ACEPTADA)» / «…en estado EN_DTF» (nombres internos) — auditoría anterior.
- ⏳ **Mezcla de voz**: tutear en unos mensajes y «usted»/impersonal en otros; «Sólo» (con tilde) en `messages.service` frente a «Solo» en el resto.
- ⏳ Mensajes técnicos que un cliente de kiosko podría ver: «Kiosk token inválido o expirado» (en inglés), «Token no es de **kiosco**» (¿kiosko?), «Para pedidos de kiosko se requiere un kiosko activo (header X-Kiosko-Id)», «La clave de idempotencia ya está en uso».
- ⏳ En el panel: «Se registran en la web o vienen de **Firebird**» (la regla del proyecto es «Sistema Comercial»).
- ✅ Buen modelo a seguir: los errores de **DTF** (`dtf-trabajo.service`) ya están en español claro y con tuteo («Ponle un nombre a tu diseño…»).

### Cuenta y acceso
- ⏳ Registro: «Confirmar contraseña» como etiqueta **y** como placeholder.
- ⏳ `unauthorized`: «Acceso Denegado», «Volver al Inicio», «Iniciar Sesión» (Title Case).
- 📝 «Mínimo 6 caracteres» para contraseña es poco para el dato que guarda (dirección, teléfono, historial).

### Home y marca
- ⏳ **Contenido duplicado**: `BrandStory` y `VideoSection` repiten casi palabra por palabra «Punto Textil Mayoreo es un negocio mayorista mexicano dedicado a playeras…» y «Te acompañamos desde el primer contacto…»; «Conocer nuestra historia» ×2 y «Ver Catálogo» ×3 en la misma página.
- ⏳ «sucursal» (selector de tienda, correo de bienvenida) frente a «tienda» en todo lo demás.

### Pantallas públicas (TV de pared)
- ⏳ `MonitorMostradorCola`: «Cuando **bodega** termine de surtir, aparecerán aquí» y «Pide al **admin** que cree algunos en Tiendas → Mostradores» — visibles a clientes si la tienda no está configurada.
- ✅ Verificado y **correcto**: «A pagar → Pasa a CAJA», «Te toca → pasa a MOSTRADOR» (una palabra por lugar).

### Consolas del personal
- 📝 El personal escribe en voz impersonal y consistente; los hallazgos aquí son de estilo (Title Case en `Panel de Caja`, `Monitor de Bodega`, `TV Ventanillas`).
- ⏳ «Pide al admin…» vs «Contacta al administrador…» (dos nombres para la misma persona).

---

## 4. Estilo (mecánico, bajo riesgo — para la auditoría visual)

| Patrón | Cuántos | Recomendación |
|---|---|---|
| **Title Case** en español («Seguir Comprando», «Precio: Menor a Mayor», «Historial de Pedidos», «Total Gastado», «Seleccionar Ubicación», «Más Nuevos») | ≥ 14 | El español usa mayúscula inicial de oración. |
| Mensajes de falla: «Error al…» / «No se pudo…» / «No pudimos…» | 40 / 51 / 8 | Una sola forma. Recomiendo **«No se pudo…»** (neutral) y **«No pudimos…»** solo cuando hay un siguiente paso para el cliente. |
| Exclamaciones y emoticones | `:)` en kiosko (✅ quitado) | Sin emoticones en una tienda B2B. |
| Mojibake en un comentario de `types/index.ts` («tel��fono») | 1 | Solo se ve en el código. |

---

## 5. Cómo se evita que vuelva

- `demo-frontend/scripts/test-textos-cliente.ts` — recorre con el compilador **534 textos en 47 archivos del cliente** y falla si reaparece: reseñas, «sustitución», «bodega», «administrador», «Sistema Comercial/Firebird/VFP/ERP», `#id`, `(s)`, `...`, palabras sin acento, `Pedido #`. Se comprobó que muerde (inyectando texto malo dispara 6 reglas).
- `demo-frontend/scripts/test-seguimiento.ts` — 55 casos del recorrido (recoger/domicilio/DTF/cancelado/excepciones) y que ningún texto del seguimiento use jerga.
- `demo-backend/src/modules/mail/estado-labels.spec.ts` y `correos.spec.ts` — tabla de estados y reglas de los correos.
- `historial-cliente.util.spec.ts` — el historial del cliente no lleva `#id` ni nombres de procesos.

## 6. Lo que necesito de ti

1. **¿Cómo paga un cliente a domicilio?** Hoy: no pasa por caja (`cola-caja.util`), la transferencia está bloqueada «mientras se rediseña el flujo de envíos» (`pagos/transferencia/reglas.ts`), y el correo «listo para pagar» no le da instrucciones. El pedido queda en `PENDIENTE_PAGO` sin que el cliente sepa qué hacer. El seguimiento dice solo lo que es cierto («sale a envío en cuanto se confirme el pago») hasta que decidas el mecanismo.
2. **¿Qué parte del registro operativo debe ver el cliente en su historial?** (pendiente de la auditoría anterior).
3. **Title Case, «Identidad Digital», duplicados de la home, «sucursal»/«tienda»**: son decisiones de marca. Dime cuáles aplico y las hago de una vez junto con la auditoría visual.

---

## 7. Segunda ronda (19-oct-2026, tarde): lo que quedaba pendiente

Respuestas del dueño: **(1)** a domicilio solo se paga por transferencia; **(2)** aplicar todo lo pendiente y corregir lo que se encontrara; **(3)** decidir yo qué ve el cliente de su historial.

### 1. Domicilio: solo transferencia — ✅ implementado (no era solo de texto)
Quitar el bloqueo habría reabierto el hallazgo H1 (un domicilio verificado nunca llegaba a `PAGADO`). Se resolvió completo: método forzado y **pedido rechazado si la tienda no tiene cuenta bancaria** (sin caja de respaldo); instrucciones automáticas al pasar a pago; «**Por registrar**» de caja trae los domicilios verificados (`soloRegistrar`); sin «pagar en tienda» ni «recoger» en mensajes y correos de domicilio. Detalle en `CLAUDE.md` y `PLAN-PAGOS-TRANSFERENCIA.md` §18. **Abiertos:** el costo de envío no está en el total, y un domicilio sin pagar no caduca.

### 3. El historial del cliente — ✅ recomendación aplicada
**Solo los hitos de su pedido, con una frase fija en su voz, sin quién lo hizo y sin los movimientos del piso.** Es la forma que usan Amazon o Uber Eats: el cliente lee «Recibimos tu pedido → Tu pedido quedó listo en tienda → Recibimos tu pago», no el registro operativo. Por construcción ningún texto libre del personal (nombres, ids, jerga) puede llegar a esa pantalla. El personal y el admin siguen viendo el historial completo.

### 2. Lo pendiente de la auditoría — ✅ aplicado
- **Mayúsculas de título → de oración** (~40 textos: «Iniciar sesión», «Más nuevos», «Mis favoritos», «Panel de caja», «Ventas totales»…).
- **«Identidad Digital» → «Acceso con QR»** / **«Tu código de acceso»**; «Acceso Kiosko» → «Acceso al kiosko».
- **Home sin contenido duplicado**: `VideoSection` ya no repite el texto de `BrandStory` ni su botón.
- **«Sucursal» → «Tienda»** (selector de tienda, navbar, kiosko).
- **«Captura/capturar» → «Elige/Indica»** (selector de tallas).
- **«Error al…» → «No se pudo…»** (43 mensajes), **«email» → «correo»**, «Sólo» → «Solo» (105 apariciones), **«PTM»** → nombre completo en los asuntos.
- **Chat con el asesor**: una sola indicación de Enter, no tres.
- **Registro**: placeholder «Repite tu contraseña».
- **TV públicas**: ya no hablan de «bodega» ni le piden nada al «admin».
- **Kiosko y servidor**: mensajes técnicos («Kiosk token inválido», «header X-Kiosko-Id», «kiosco») en español claro; «Firebird» → «Sistema Comercial» en el panel.
- **Correo de cancelado**: si lo canceló el propio cliente ya no dice «Motivo: Cancelado por el cliente».
- **Sugerencias de búsqueda inventadas** («Pedido #1234», «Producto XYZ») eliminadas.
- Tres comentarios del código con caracteres dañados reparados.

### Que sigue pendiente (no es de redacción)
- `puedeCancelar` de «Mis pedidos» lo mapea la pantalla (4 estados) y el servidor permite 7: debería mandarlo el servidor.
- Contraseña de solo 6 caracteres como mínimo.
- Costo de envío fuera del total y caducidad de un domicilio sin pagar.
- Páginas legales (privacidad, cookies, términos): requieren revisión legal.
