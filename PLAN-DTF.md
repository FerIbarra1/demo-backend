# PLAN — Impresión DTF (rol Impresión)

> 16-oct-2026. **v1 — con las decisiones del dueño y el análisis del esquema del ERP**
> (`DATOSINV_METADATOS.sql`). **Nada de esto está implementado.** Sale de leer el backend y el frontend
> completos, el WhatsApp del encargado de DTF, la hoja de Excel del 02/10 y los metadatos de Firebird.
>
> Marcas: **[SUPUESTO]** = lo decidí por default y hay que confirmarlo (§16). **[VERIFICAR]** = no se
> puede saber leyendo este repo (vive en el ERP, en AWS o en la cabeza del negocio). **[DECIDIR]** =
> bifurcación de diseño con costo real: va con mi recomendación.

---

## 0. Resumen

1. Hoy el DTF es 100 % manual: el cliente manda un PDF/PNG por correo → alguien lo revisa a ojo →
   le pone el "plano blanco" → imprime → lo anota en un Excel (nombre, descripción, metros, hora).
   El backend **no sabe nada de DTF**; la página `/dtf` del frontend es un placeholder con precios
   inventados ($45 / $80 / rollo $1,950) cuando el real es **$220/m (Textil) y $600/m (UV)**.
2. **Principio rector: el archivo es el producto.** El cliente sube su PDF/PNG, el sistema lo mide, lo
   cotiza y lo pre-revisa antes de que llegue a una persona. Los metros salen del archivo, no de lo que
   el cliente teclee.
3. **DTF NO puede ser un `ItemPedido`** aunque se venda "como un producto" (§2, §3-D1): `cantidad` es
   `Int`, cada línea exige variante talla/color/corrida, la promo de volumen cuenta piezas, bodega /
   propuestas / reposición recorren `items`, y el ERP rechaza (de hecho *atora*) un pedido con una línea
   sin variante local. Lo de "producto" es la **cara** (tarjeta en el catálogo, renglón en el carrito y en
   el ticket); por debajo es una tabla propia.
4. **Arquitectura propuesta:** un **carril paralelo** (`PedidoDtf`, con su propia máquina de estados)
   colgado del `Pedido` + **un estado nuevo `EN_DTF`** en el pedido (la pieza más delicada, §3-D3) + una
   sola función que decide si el pedido ya es presentable en mostrador. El pedido mixto
   (prendas + DTF) sigue siendo **un** pedido, un ticket, un pago.
5. **Rol nuevo `IMPRESION`** (el encargado): revisa archivos, pide correcciones, imprime, marca listo.
   ADMIN supervisa. Se llama así porque es la palabra del negocio ("Impresión (57 cm de ancho)").
6. **Archivos:** almacenamiento **privado**, versionados, subida directa a S3 (los archivos de 57 × 250 cm
   a 300 DPI pesan decenas o cientos de MB; los topes de subida actuales son de 5–8 MB), revisión automática
   **asíncrona**. La revisión automática **avisa, no decide**: "que lo manden no significa que esté bien" —
   la última palabra es del encargado.
7. **Kiosko:** nunca USB en la tablet (hardware bloqueado + riesgo de virus). La tablet muestra un **QR →
   el cliente sube el archivo desde su celular → la tablet se entera en vivo**. Si trae USB, el personal lo
   sube desde una PC aparte en nombre del cliente (mismo patrón que "caja sube el comprobante").
8. **Dinero:** el total del pedido incluye el DTF; `PAGADO` sigue naciendo **solo de VFP**. El esquema de Firebird
   confirma que el DTF **cabe en el pedido del ERP** como una línea con cantidad decimal y sin corrida/color/talla
   (§2 H20–H22); falta el código del producto y que VFP acepte la línea (§16-A). Sin eso un pedido solo-DTF no
   genera folio, y para eso está el respaldo del Caso B.
9. La hoja del Excel muestra que **la regla de cobro cambia el ingreso hasta un 21 %** (§8.3). El esquema no
   dice cómo se redondea el metro hoy; la consulta 3 de §16-A lo contesta con ventas reales. Default de la demo: medio metro.
   Y el ERP ya distingue **clientes a crédito** (`CLIENTESCXC`): de ahí sale, en Fase 2, "a unos se les imprime y pagan
   después; a otros, primero" sin captura manual.
10. ≈50 escenarios de falla cubiertos en §11. Fases en §17: el núcleo (Fase 1) ya entrega valor sin
    automatismos; la revisión automática, el kiosko por QR y "Mis diseños" vienen después.

## 0.1 Decisiones del dueño (16-oct) y qué cambió en el plan

| Tema | Decisión | Efecto en el plan |
|---|---|---|
| Estado `EN_DTF` | **Aprobado.** | D3 deja de ser "recomendado" y pasa a decidido. |
| Cobro en el Sistema Comercial | **Sí se cobra el DTF ahí hoy.** Se analizó el esquema de Firebird (H20–H26). | El **Caso A** (DTF como renglón del pedido en el ERP) es **viable**: el ERP admite decimales y líneas sin corrida/color/talla. Falta saber el **código del producto** (consulta SQL en §16-A). |
| Cuándo se paga | **Forma estándar por ahora**, se afina con retro. | D15: se imprime y se cobra al recoger/entregar (igual que las prendas). El ERP ya distingue **clientes a crédito** (`CLIENTESCXC`): ahí vive la regla futura "a unos se les imprime y pagan después; a otros, primero". |
| Tiendas | No todas imprimen DTF; el ADMIN elige **qué tiendas** y **qué tecnologías** (Textil, UV o ambas; quizá máquinas distintas). | D16: modelo `TiendaDtf` (tienda × tecnología) + pantalla en el admin. |
| Equipo | **Una o varias personas por tienda**; el puesto no tiene nombre. | D6: rol `IMPRESION` (nombre = el área, como `BODEGA`/`CAJERO`), varias personas por tienda. |
| Pedido mixto | "Piensa como empresa": **decidido por mí**. | D2: esperan juntos, un ticket, con avisos por etapa y la válvula "separar el DTF" (Fase 2). |
| Entrega | **También por paquetería**, junto con productos. | D11: el domicilio **entra a la v1** (`EN_DTF → PENDIENTE_PAGO`). |
| Alcance de producto | **Solo film impreso**; no se estampa. | Fuera de alcance: estampado en prenda. |
| Ideas (§15) | **Todas aceptadas** para incorporarse. | §15 y §17 las ubican por fase. |
| Demo | **Mañana (17-oct)** se presenta al cliente. | Corte de demo en §17. |

**Lo que NO cambia:** el flujo de prendas (bodega → plancha → mostrador → pago → entrega), `PAGADO` solo
desde VFP, las invariantes 1–3 del `CLAUDE.md`, las TV (ninguna ve `EN_DTF`), el agente de Firebird (salvo
la proyección del DTF si el ERP lo permite).

---

## 1. Cómo opera el DTF hoy

### 1.1 Reglas del negocio (del WhatsApp del encargado, 02/10)

| | DTF Textil | DTF UV |
|---|---|---|
| Precio | **$220 / metro lineal** | **$600 / metro lineal** |
| Ancho de impresión | 57 cm | 57 cm |
| Se imprime desde | **medio metro** | **20 cm** |
| Archivo | 57 cm de ancho × **50 cm de alto mínimo**; si pasa de **250 cm** de alto, otro archivo | igual |
| Formato / calidad | PDF · **300 DPI** · **CMYK** · **sin fondo** · **sin píxeles transparentes** (la máquina los imprime en blanco) · tamaño real | igual |
| Nombre | "poner su nombre en el archivo" | igual |
| Entrada | correo `psventasobregon@hotmail.com` | igual |

> "Es el mismo proceso en DTF UV y Textil." — Manuel

### 1.2 El proceso de hoy

```
cliente prepara PDF/PNG ─► lo manda por correo ─► encargado REVISA:
   · ¿tiene fondo?  · ¿medidas en cm?  · ¿mide lo mínimo?  · ¿la letra es muy chica (se pierde)?
   "que lo manden no significa que esté bien" ──► si algo está mal, se AVISA al cliente (canal: [VERIFICAR])
        │ todo bien
        ▼
   se le pone el PLANO BLANCO (capa de tinta blanca, en el RIP) ─► IMPRESIÓN ─► se anota en la hoja
   (FECHA · NOMBRE · DESCRIPCIÓN · MTS · HORA de entrega)  ─► el cliente recoge a la hora prometida
```

### 1.3 Lo que dice la hoja del 02/10

19 renglones, **15 clientes distintos**, **22.9 m** en total (el total cuadra con la suma). Lo que se lee:

- **Las 3 filas rosas miden 0.2 m** (LOGOS, MASCAREÑO, NOMBRES) = el mínimo del UV. **[VERIFICAR]** que rosa = UV.
  Entonces: Textil 22.3 m, UV 0.6 m.
- **Un cliente manda varios archivos** (Francisco Corral ×3, Alonso Castro ×3). La **descripción** es el asa
  para distinguirlos ("CÁNCER DE MAMA", "LOGOS", "NOMBRES") → en el sistema el *nombre del diseño* es obligatorio.
- **Los diseños se repiten** ("CÁNCER", "CÁNCER DE MAMA", "LOGOS" ×2): "reordenar un diseño ya aprobado"
  ahorraría revisión (§15).
- **La HORA no sigue el orden de la lista** (12:00, 12:40, 12:30, 12:10…): es una promesa que la persona
  calcula a ojo según la cola. El sistema puede sugerirla (§8.4).
- **Tamaño típico:** 0.5–1 m; el más grande 4.5 m. Sin trabajos de >250 cm ese día.

---

## 2. Qué hay hoy en el proyecto (verificado) y por qué condiciona el diseño

| # | Hallazgo (dónde) | Consecuencia para DTF |
|---|---|---|
| H1 | No hay nada de DTF en el backend (`grep` en `src/`, `prisma/`, docs, agente). En el frontend solo `app/dtf/page.tsx` (placeholder "Próximamente", presentaciones con precios de referencia que no son los reales). | Se construye desde cero. La página actual se **reemplaza**. |
| H2 | `ItemPedido.cantidad` es `Int`; toda línea lleva `precioCOId`, corrida, talla, color (`schema.prisma`). | No se puede vender 0.6 m ni "57 × 62 cm". |
| H3 | `aplicarPromoVolumen` suma `cantidad` de **todos** los items para el umbral de 12 piezas (`core/promo-volumen.util.ts`). | DTF dentro de `items` dispararía o falsearía la promo de prendas. |
| H4 | Bodega, propuestas (`calculadora-ajuste`), reposición, similitud, surtido por lote, ajuste de mostrador recorren `items`. | Un renglón DTF ahí rompe el surtido y la reposición ("ve a buscar 1.2 piezas"). |
| H5 | `PedidoDescargaHandler.poll()` marca `skip` a un item sin `PrecioCO`/producto/corrida/color **locales**; con cualquier skip el pedido va a `RETRY` y a los 5 intentos a `ERROR` (`sync/handlers/pedido-descarga.handler.ts`). El agente llama `GRABAR_MOVPED(código CHAR(16), producto, corrida, color, talla, cantidad, precio)` (`agent/src/down-processor.ts`). | El ERP exige variante por línea. Un DTF **sin producto mapeado en el ERP** atora el pedido entero. Si **sí** hay producto, hay que ver si `CANTIDAD` acepta decimales **[VERIFICAR]**. |
| H6 | `ClienteService.crearPedido`: `items` es `@ArrayMinSize(1)` (`cliente/dto/create-pedido.dto.ts`). El pedido nace `SOLICITADO`. | Un pedido solo-DTF hoy es imposible, y si naciera `SOLICITADO` caería en la cola de bodega. |
| H7 | La cola, el monitor y el surtido de bodega filtran `estado in [SOLICITADO, EN_REVISION]` **sin mirar los items** (`bodega.service.ts`, `monitor.service.ts`). | Un pedido sin prendas en `SOLICITADO` aparecería vacío en bodega y en su TV. |
| H8 | `recalcularTotalesPedido` es "el ÚNICO punto" donde se calcula subtotal/total; lo llaman los 4 caminos que mutan items (`core/totales.util.ts`). | Un solo lugar para sumar el DTF al total. |
| H9 | `destinoTrasSurtido` / `destinoTrasSurtidoIncompleto` deciden a dónde va el pedido al cerrar bodega; las usan los 3 cierres (`core/destino-post-surtido.util.ts`). | Un solo lugar para decir "aún hay DTF pendiente → `EN_DTF`". |
| H10 | La máquina de estados es la fuente única (`TRANSICIONES`); hay 3 `Record<EstadoPedido,…>` exhaustivos que no compilan si falta un valor (`TRANSICIONES`, `RESPONSABLES` en `escaneo.util.ts`, `ESTADO_PEDIDO_LABELS` en `mail/estado-labels.ts`) y 1 parcial (`MENSAJES_TERMINALES` en `llegada-aviso.util.ts`) y **34 archivos** referencian `EstadoPedido.*`. | Agregar un estado es viable y el compilador ayuda, pero toca mucho: va con suite completa antes y después. |
| H11 | Hay un patrón de almacenamiento **privado** con prueba de que el prefijo no sea público (`pagos/transferencia/comprobante-storage.service.ts`): valida tipo por **firma binaria** (`validar-comprobante.util.ts`), sha256 idempotente, endpoint autorizado, `ServerSideEncryption`. Pero **bufferiza en RAM, tope 8 MB**. | Reusar el patrón y la validación; **no** el buffer en RAM (un PDF de DTF pesa 10–100× más). |
| H12 | No hay `sharp`, `pdf-lib`, `pdfjs` ni cola de trabajos (`package.json`). Los workers son `setInterval` in-process (`*.worker.ts`); Redis solo sirve al adapter de Socket.IO. | La revisión automática necesita dependencia nueva y un worker con lease en Postgres (como `PedidoPendienteEnvio`). Depende de **dónde corre** el backend **[VERIFICAR]** (¿Docker? ¿PaaS?). |
| H13 | Chat: solo `CLIENTE`, `VENTAS` y `ADMIN` escriben (`messages.service.ts`); aparece en pantalla solo en `EN_ASESORIA` o si ya hay mensajes. `PedidoMensaje.itemId` ya ancla un mensaje a una línea. | "Hablar con el diseñador" cabe **reutilizando** el chat con un ancla `dtfId` y agregando el rol. |
| H14 | **Agregar un rol toca ~8 archivos del backend y ~10 del frontend** (huella de `TESORERIA`) y existe `common/roles-contrato.spec.ts` que falla hasta que el rol quede nombrado en cada lista. | Costo conocido y con red de seguridad. |
| H15 | Kiosko: la tablet **tiene cámara** y escanea el QR personal del cliente (`/kiosko/scan`, `html5-qrcode`); y la tablet **muestra un QR** que el celular escanea (`KioskSuccessScreen`, `qrcode.react`). El kiosko exige login (B2B). El kiosko **bloquea `/dtf`** (`KIOSKO_BLOQUEADAS` en `constants/paths.ts`). | El puente tablet ↔ celular por QR ya existe en ambos sentidos. Hay que **abrir** una ruta de DTF para el kiosko. |
| H16 | **El guard de inactividad del kiosko cierra la sesión a 1:30** (60 s + 30 s; el código manda, no la nota de memoria que decía 3 min) (`lib/hooks/useKioskIdleGuard.ts`). | Un cliente que sube su archivo desde el celular **no toca la tablet**: la sesión se cerraría a media subida. Hay que **pausar** el guard mientras haya una subida/QR abierto. |
| H17 | El carrito vive en `localStorage` y solo guarda `precioCOId + cantidad` (`lib/stores/cart.ts`). | Un archivo no cabe ahí: el DTF del carrito es un **borrador en el servidor** (`PedidoDtf` en `BORRADOR`) y el carrito solo guarda su id. |
| H18 | Los precios del catálogo vienen del ERP en 6 listas por cliente (`Precio`/`PrecioCO`, `Usuario.listaPrecioCodigo`). | Si el ERP tiene el producto DTF, **el precio y la lista del cliente vienen gratis**; si no, tarifa manual en el panel. |
| H20 | **Cantidades decimales:** `MOVPED.CANTIDAD NUMERIC(12,2)`, igual en `FAMOVIM` y `MOVINV` (`DATOSINV_METADATOS.sql`). | 0.6 m o 1.25 m caben en el pedido del ERP. |
| H21 | **`GRABAR_MOVPED` no valida variante:** solo hace `UPDATE OR INSERT` con producto/corrida/color/talla/cantidad/precio; `IDCORRIDA`, `IDCOLOR` y `TALLA` son **nulables** en `MOVPED` y `FAMOVIM`. | Una línea DTF sin variante **es posible** en el ERP. El obstáculo es **nuestro** `poll()` (H5), que exige ids locales de variante: hay que darle un camino para líneas DTF. |
| H22 | `PRODUCTOS` ya modela servicios y medidas: `MANEJAEXISTENCIA` (false = no lleva inventario), `BASCULA`, `UNIDAD`/`UNIDADV`/`FACTOR`, `CLAVEUNIDAD` y `CLAVEPRODSERV` (claves SAT). Los precios van en `PRECIOS` (producto × tienda × **6 listas**); `PRECIOSCO` exige corrida. | "DTF por metro" vive como **producto-servicio con `PRECIOS`** y sin `PRECIOSCO`. El precio por tienda **y por lista del cliente** ya existe en la nube (`Precio.lista1..6`). |
| H23 | La sincronización importa **todo** `PRODUCTOS`/`PRECIOS` (upsert por `codigo`; `procesarPrecio` solo pide producto + tienda), pero `procesarPrecioCO` exige corrida+color+talla y **`ProductoTienda` solo lo crea el seed** (`catalog.handler.ts`, `prisma/seed.ts:728`). | El producto DTF llega a la nube como `Producto` + `Precio` **sin aparecer en el catálogo de prendas** y sin cambiar la sincronización de catálogo. |
| H24 | `PEDIDOS.NOTAS VARCHAR(2000)`; `MOVPED` **no tiene columna de notas** (`FAMOVIM.NOTAS` sí, pero se llena en VFP). | El resumen de cada DTF ("DTF TEXTIL · CÁNCER DE MAMA · 57×120 · 1.5 m") viaja en `PEDIDOS.NOTAS` para que caja lo vea. |
| H25 | **Crédito:** `CLIENTESCXC` (`DIAS`, `LIMITE`, `SUSPENDIDO`, `PERMITEUNA`), `FACTURAS.CREDCON` (crédito/contado), `PAGOS`/`TIPOSPAGO`. El agente ya sube `CLIENTESCXC` y `ClienteHandler` lo guarda como usuario (`ExternalRef.localEntity = 'CLIENTESCXC'`) pero **descarta `DIAS`/`LIMITE`**. | La política de pago por cliente se puede **derivar del ERP** (Fase 2) sin capturar nada a mano. |
| H26 | **El archivo trae solo estructura, no datos.** No dice cuál es el producto DTF, su código, su línea ni si hoy se redondea el metro. | Una consulta de 3 líneas en el ERP lo resuelve (§16-A, "Para el ERP"). |
| H19 | Tiendas en el seed: Mexicali, Ciudad Obregón, Hermosillo, Monterrey. El correo del DTF es `…obregon@…`. | ¿Todas imprimen DTF o solo una? (Q4) Define si el DTF es por tienda o con logística entre tiendas. |

---

## 3. Decisiones de diseño

### D1 — DTF es un carril propio (`PedidoDtf`), no un `ItemPedido` **[DECIDIR → recomendado]**
Por H2–H5. La cara de "producto" (catálogo, carrito, ticket, detalle) se arma en la API/UI; el almacenamiento
es propio. Es el mismo criterio con el que los pagos por transferencia se hicieron un subsistema paralelo en
vez de agregar estados.
*Descartado:* meter el DTF como producto del ERP con `cantidad` en centímetros o decímetros (un hack que
contamina bodega, promo y reposición) y *"servicio" como ItemPedido sin variante* (rompe H5).

### D2 — Un pedido por compra: el mixto es UN pedido y espera junto **[DECIDIDO, pensado como empresa]**
Un ticket, un pago, un folio, una entrega. Por qué es la mejor opción para el negocio:
1. El cliente de mayoreo pide playeras **y** transfers para estamparlas *juntas*: entregar una mitad no le sirve y
   lo manda dos veces a la tienda.
2. **Un cobro = una nota en el Sistema Comercial.** Partir el pedido son dos facturas para el mismo cliente.
3. Evita prendas "secuestradas" en la plancha por un cliente que no regresa: el aviso llega **por etapas**
   ("tus prendas ya están; tu DTF estará listo ≈ 3:40 pm") en lugar de dejarlo a ciegas.
4. **Válvula de escape (Fase 2):** si el cliente quiere llevarse lo que ya está, mostrador **separa el DTF a su
   propio pedido** (nuevo pedido solo-DTF, con el total ajustado). No se construye en la v1 porque duplica cobros
   y hay que probarlo con el cliente.
Se puede cambiar después de la demo: la regla vive en una sola función (D13).

### D3 — Estado nuevo `EN_DTF` en el pedido **[DECIDIR → recomendado]**
"El pedido espera a que su DTF esté impreso". Es el criterio de la casa: **la invisibilidad se logra con
un estado, no con un filtro que alguien olvide** (ver el comentario de `REVISADO` en `schema.prisma`).

| Opción | Cómo | Veredicto |
|---|---|---|
| **A. `EN_DTF`** | El pedido solo-DTF **nace** en `EN_DTF`; el mixto pasa a `EN_DTF` cuando bodega cierra si hay DTF pendiente; sale a `REVISADO` cuando el último DTF queda impreso. | **Recomendada.** Ninguna consulta de bodega lo ve (H7). Toca `TRANSICIONES`, 3 `Record`, `destinoTrasSurtido*` y los mapas del frontend (H10). |
| B. Solo-DTF nace en `REVISADO` + gate | Sin estado nuevo. | **No.** Mostrador lo vería "en la plancha" sin estarlo y saldría el correo "tu pedido está listo en tienda" con el archivo en revisión. |
| C. Solo-DTF nace `SOLICITADO` + `tipo=SOLO_DTF` + filtros | Sin estado nuevo. | **No.** Exige agregar el filtro en ≥6 consultas de bodega; un olvido = pedido fantasma en la TV. |

Flujo:

```
solo-DTF:  [creación] ─► EN_DTF ───────────────────────────────► REVISADO ─► … (igual que hoy)
mixto:     SOLICITADO ─► EN_REVISION ─► (bodega cierra) ─┬─ ¿DTF pendiente? ─► EN_DTF ─► REVISADO
                                                         └─ no ─────────────► REVISADO (o el destino de siempre)
domicilio: EN_DTF ─► PENDIENTE_PAGO (+ encolado a Firebird) ─► PAGADO ─► ENVIADO ─► ENTREGADO   (D11)
reimpresión (defecto hallado después):  REVISADO / EN_ATENCION ─► EN_DTF
cancelar:  EN_DTF ─► CANCELADO (reglas de §11-C)
```

El mixto con propuesta de bodega pendiente (`ESPERANDO_APROBACION` / `EN_ASESORIA`) **no cambia**: cuando el
cliente decide, el destino lo calcula `destinoTrasSurtido*`, que ahora recibe `dtfPendiente` y devuelve `EN_DTF`
en lugar de `REVISADO`.

### D4 — El archivo define los metros **[SUPUESTO]**
El PDF trae su tamaño de página; el sistema lo mide y cotiza (`57 × 62 cm → …`). El cliente no teclea metros:
no hay "dije 1 m y mi archivo mide 1.4". Un renglón = un archivo = un trabajo (como en la hoja).

### D5 — Precio: del ERP (fuente A) con tarifa manual de respaldo **[CONFIRMADO en el esquema; falta el código del producto]**
Dos fuentes, una sola API de cotización: **(A)** `DtfTipo.productoId` → `Producto`/`Precio` ya sincronizados
(H22–H23): precio **por tienda y por lista del cliente** (`Usuario.listaPrecioCodigo`), el mismo mecanismo que las
prendas, así el precio nunca se mantiene en dos sistemas; **(B)** `DtfTipo.precioMetro` editable por ADMIN, para
la demo o si el ERP aún no tiene el producto. El precio y la regla de cobro se **congelan** en el trabajo al
crearlo (mismo criterio que `precioUnitario`). Que el ERP tenga lista 1..6 también resuelve "precio distinto por
cliente" y "descuento por volumen de metros" sin código nuevo: sería la lista 2 del producto DTF.

### D6 — Rol `IMPRESION`, con tienda, **varias personas por tienda** **[DECIDIDO]**
El puesto no tiene nombre; el rol se llama como **el área** (`BODEGA`, `CAJERO`, `MOSTRADOR`, `TESORERIA`) y es la
palabra que el negocio ya usa ("Impresión (57 cm de ancho)"). No `DTF` (es el producto, no la función) ni
`DISENO` (la persona revisa e imprime; no diseña). Cada usuario `IMPRESION` pertenece a **una tienda** (la del
JWT); en una tienda puede haber varios y se reparten la cola con `tomar` atómico (la misma guarda que bodega: dos
personas no revisan el mismo trabajo). Vistas: **Cola** (de todos) y **Mis trabajos**. Si algún día revisar y
operar la impresora son personas distintas, se separa en `DISENO` + `IMPRESION` sin tocar el modelo (los permisos
viven por acción, §6). Su etiqueta en pantalla: "Impresión DTF".

### D7 — Archivos privados, versionados, subida directa a S3 **[DECIDIR → recomendado]**
Streaming/multipart **directo a un bucket privado** con URLs prefirmadas (el API nunca ve los bytes). Sin S3
(dev) cae a disco `storage-privado/` por streaming. Cada reemplazo es una **versión** nueva; nunca se pisa.
Detalle y seguridad en §7.

### D8 — La revisión automática avisa, no decide **[SUPUESTO]**
Resultado por regla: ✔ / ⚠ (aviso) / ✖ (bloquea). Solo bloquea lo **objetivo y barato** (formato, 1 página,
cifrado/JS, ancho, alto máximo, tamaño). Fondo, DPI, color y letra chica **avisan** y la decide una persona.
Si el análisis falla o tarda, el trabajo **no se bloquea**: pasa a revisión manual con la marca "no concluyente".

### D9 — Kiosko: QR → celular; USB solo asistido **[SUPUESTO → Q21, Q22]**
Ver §10.

### D10 — "Hablar con el diseñador" reutiliza el chat **[DECIDIR]**
Un chat por pedido (ya existe, con marcas de leído); los mensajes se **anclan** a un trabajo (`dtfId`, como
`itemId`) y `IMPRESION` puede escribir. *Costo:* tocar `messages.service.ts` y la regla "el chat solo aparece
en asesoría o con mensajes". *Alternativa:* un hilo propio por trabajo (más código, mismos problemas de
leído/no leído). Recomiendo reutilizar.

### D11 — Recoger en tienda **y paquetería** **[DECIDIDO: el domicilio entra a la v1]**
Un pedido con DTF puede ser `DOMICILIO` (solo DTF o junto con prendas). No requiere estados nuevos: cuando el
último DTF queda impreso, `destinoTrasSurtido(DOMICILIO)` manda el pedido a `PENDIENTE_PAGO` **con encolado a
Firebird**, igual que hoy lo hace bodega, y de ahí `PAGADO → ENVIADO → ENTREGADO` (`marcarEnviado` no cambia). Para el
envío el DTF viaja enrollado en tubo o bolsa: es un dato de empaque, no de sistema. Dos cuidados:
(1) el pago por **transferencia sigue bloqueado en domicilio** (decisión del plan de pagos, §18) y los envíos se van a
rediseñar por completo, así que el DTF **no agrega acoplamiento** al flujo de envío: solo respeta su destino;
(2) con domicilio la **política de pago** importa más (D15): el cobro ocurre **antes de enviar**, que es el orden natural.

### D12 — Un DTF impreso no se repone ni se cancela solo **[DECIDIR → Q2]**
Una prenda no recogida vuelve al anaquel; una impresión a nombre del cliente **no se puede revender**. Por eso
(a) el barrido de "sin recoger" **no cancela** pedidos con DTF impreso, (b) cancelar después de `EN_IMPRESION`
es de ADMIN con motivo, (c) la política de cobro es la estándar de D15 hasta que el cliente dé retro.

### D13 — El gate se calcula, no se guarda
"¿Hay DTF pendiente?" es una consulta (`PedidoDtf` del pedido en estados no terminales/no impresos), no un
contador desnormalizado en `Pedido` que pueda desincronizarse. Quien decide el destino la calcula y se la pasa a
`destinoTrasSurtido*` (que hoy es una función pura).

### D14 — La "hoja del día" es una vista, no una tabla
Fecha · Nombre · Descripción · Mts · Hora, más total por tecnología, generada de `PedidoDtf` y descargable en
CSV con **las mismas columnas del Excel**. Facilita la adopción: la hoja de hoy sale sola.

---

### D15 — Política de pago: estándar hoy, con interruptor **[DECIDIDO como estándar de la demo]**
**Estándar:** se imprime y se cobra al recoger/entregar — es **lo que ya hace el flujo de prendas** (el cobro es el paso
5 y nace de VFP) y lo que muestra la hoja del 02/10 (hora de entrega, el cliente pasa). Cero cambios al orden de estados.
El riesgo real (un DTF impreso no se puede revender) se cubre con D12 y con el **interruptor** que queda preparado:
- `DtfTipo.pagoAntes` (global, apagado por defecto): el DTF aprobado **no pasa a `EN_IMPRESION`** hasta que el pedido
  esté cobrado; el pedido sigue su camino (`PENDIENTE_PAGO → PAGADO`) y el candado se mueve de "salir de `EN_DTF`" a
  "imprimir". Se activa por tipo cuando el cliente decida.
- **Fase 2 — automático por cliente con datos del ERP (H25):** guardar `CLIENTESCXC.DIAS/LIMITE/SUSPENDIDO` y decidir:
  cliente **a crédito vigente** → se imprime y paga después; **de contado** → paga primero. Sin captura manual y con una
  regla que el negocio ya aplica en VFP. *Esto es lo que se enseña al cliente como "cómo lo vamos puliendo".*

### D16 — Tiendas y tecnologías configurables por el ADMIN **[DECIDIDO]**
No todas las tiendas imprimen. El ADMIN abre `/admin/dtf` y, por **tienda**, enciende **DTF Textil**, **DTF UV** o
ambas (si son máquinas distintas, cada una lleva su nombre y su velocidad). Es el modelo `TiendaDtf` (tienda ×
tecnología): `activo`, nombre de la máquina, `velocidadMetrosHora`, hora de corte y cupo diario. Efectos:
- Una tienda **sin** DTF no ve la tarjeta en el catálogo ni en el kiosko; el servidor responde 409 si alguien lo fuerza.
- El pedido y el DTF son de **la misma tienda** (la del carrito): no hay logística entre tiendas en la v1. Si el cliente
  quiere DTF y su tienda no imprime, el configurador le propone **cambiar de tienda** (el carrito ya es de una sola tienda).
- El precio sale del `PRECIOS` de **esa tienda** en el ERP (H22): coherente con el modelo por tienda.
- Un usuario `IMPRESION` solo ve los trabajos de **su** tienda.

---

## 4. Modelo de datos (borrador — Prisma, nombres tentativos)

```prisma
enum TecnologiaDtf { TEXTIL  UV }

enum EstadoDtf {
  BORRADOR            // en el carrito, sin pedido (expira)
  ARCHIVO_PENDIENTE   // el pedido existe pero el archivo llega después (USB / correo / WhatsApp, asistido)
  RECIBIDO            // archivo subido, en la cola de revisión
  EN_REVISION         // una persona de Impresión lo tomó
  NECESITA_CORRECCION // se pidió otra versión; la pelota es del cliente
  APROBADO            // listo para imprimir (plano blanco aplicado)
  EN_IMPRESION
  IMPRESO             // listo en mostrador (terminal del trabajo; la entrega es del pedido)
  RECHAZADO           // no se puede hacer (terminal)
  CANCELADO           // lo quitó el cliente / un operador antes de imprimir (terminal)
  EXPIRADO            // borrador abandonado (terminal)
}

enum EstadoPreflight { PENDIENTE  OK  CON_AVISOS  BLOQUEADO  NO_CONCLUYENTE }

// Catálogo de tarifas y reglas. Editable por ADMIN (NO ConfiguracionSitio: son datos estructurados con
// historia, como las cuentas bancarias — D11 del plan de pagos).
model DtfTipo {
  id               Int           @id @default(autoincrement())
  tecnologia       TecnologiaDtf
  nombre           String        @db.VarChar(60)          // "DTF Textil"
  productoId       Int?          @map("producto_id")      // fuente A: producto del ERP (si existe)
  precioMetro      Decimal?      @db.Decimal(10, 2)       // fuente B: tarifa manual
  anchoUtilCm      Decimal       @db.Decimal(6, 1)        // 57.0
  minimoCm         Decimal       @db.Decimal(6, 1)        // 50 / 20
  maxAlturaCm      Decimal       @db.Decimal(6, 1)        // 250
  pasoCobroCm      Int                                    // 100 = metro completo · 50 = medio · 1 = exacto  [Q3]
  dpiMinimo        Int           @default(300)
  pagoAntes        Boolean       @default(false)          // D15: exigir pago antes de imprimir
  activo           Boolean       @default(true)
  // …textos de ayuda, plantillas descargables
}

// D16: qué tiendas ofrecen qué tecnología (y con qué máquina). El ADMIN lo enciende en /admin/dtf.
model TiendaDtf {
  id                  Int      @id @default(autoincrement())
  tiendaId            Int      @map("tienda_id")
  tipoId              Int      @map("tipo_id")           // Textil o UV
  activo              Boolean  @default(true)
  maquina             String?  @db.VarChar(60)           // "Epson F2270 · Obregón" (libre)
  velocidadMetrosHora Decimal? @db.Decimal(6, 2)         // para la hora estimada (§8.4)
  horaCorte           String?  @db.VarChar(5)            // "15:00": lo que llega después sale mañana
  cupoMetrosDia       Decimal? @db.Decimal(8, 2)         // opcional
  fueraDeServicio     Boolean  @default(false)           // la impresora está parada (C3)
  @@unique([tiendaId, tipoId])
}

model PedidoDtf {
  id              Int       @id @default(autoincrement())
  pedidoId        Int?      @map("pedido_id")        // null mientras es BORRADOR
  usuarioId       Int       @map("usuario_id")       // dueño (también del borrador)
  tiendaId        Int       @map("tienda_id")        // tienda que lo imprime
  tipoId          Int       @map("tipo_id")
  estado          EstadoDtf @default(BORRADOR)
  nombre          String    @db.VarChar(80)          // "CÁNCER DE MAMA" — obligatorio (la "descripción" de la hoja)
  copias          Int       @default(1)              // [SUPUESTO] 1; ver Q16
  // medidas MEDIDAS del archivo vigente (snapshot) y cobro
  anchoCm         Decimal?  @db.Decimal(6, 1)
  altoCm          Decimal?  @db.Decimal(7, 1)
  metrosCobrados  Decimal?  @db.Decimal(8, 2)        // f(altoCm, pasoCobroCm, minimoCm) × copias
  precioMetro     Decimal   @db.Decimal(10, 2)       // congelado
  subtotal        Decimal   @db.Decimal(12, 2)       // congelado
  // flujo
  versionVigente  Int       @default(0)
  asignadoAId     Int?      @map("asignado_a_id")    // quién lo revisa/imprime (guarda atómica, como bodega)
  correccionMotivos Json?                            // códigos + nota del último "pedir corrección"
  planoBlancoAt   DateTime?                          // opcional (Q13)
  horaEstimadaAt  DateTime?                          // sugerida por el sistema, editable
  ordenCola       Int?                               // reordenar urgentes (Q19)
  aprobadoAt      DateTime?
  impresoAt       DateTime?
  expiraAt        DateTime?                          // borradores
  aceptoRiesgo    Boolean   @default(false)          // el cliente siguió pese a un aviso (p. ej. 150 dpi)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([tiendaId, estado])                        // la cola (la tecnología se filtra por tipoId)
  @@index([pedidoId])
  @@index([usuarioId, estado])
}

model PedidoDtfArchivo {                              // una fila por VERSIÓN; nunca se pisa
  id              Int      @id @default(autoincrement())
  dtfId           Int
  version         Int
  archivoKey      String   @db.VarChar(255)          // storage PRIVADO; la BD guarda KEY, nunca URL
  previewKey      String?  @db.VarChar(255)          // miniatura/preview generada (Fase 2)
  nombreOriginal  String   @db.VarChar(200)
  mime            String   @db.VarChar(40)           // por firma binaria, no el que declara el cliente
  bytes           BigInt
  sha256          String   @db.VarChar(64)
  canal           String   @db.VarChar(20)           // WEB | CELULAR_QR | ASISTIDO
  subidoPorId     Int?                               // null = subida por token de celular
  preflightEstado EstadoPreflight @default(PENDIENTE)
  preflight       Json?                              // resultado por regla
  createdAt       DateTime @default(now())
  @@unique([dtfId, version])
  @@index([sha256])                                  // detectar "ya subiste este archivo"
}

model PedidoDtfEvento { /* append-only: tipo, de/a estado, actor, rol, detalle Json, createdAt */ }
// + PedidoMensaje.dtfId Int?   (ancla del chat, D10)
```

Notas:
- Los **índices parciales** que Prisma no declara (p. ej. "un solo archivo vigente por trabajo", "un solo
  trabajo por clave de idempotencia") van en la migración SQL, como en pagos.
- Migración **aditiva**: `ALTER TYPE … ADD VALUE` para `EstadoPedido` (`EN_DTF`), `RolUsuario` (`IMPRESION`) y
  `TipoNotificacion` (`DTF_*`); mismo patrón que `20260924000000_tipo_notificacion_listo_tienda`.

---

## 5. Máquinas de estado

### 5.1 El trabajo (`PedidoDtf`)

```
BORRADOR ─(se agrega al pedido)─► RECIBIDO ─(tomar)─► EN_REVISION ─┬─(aprobar)────────► APROBADO ─► EN_IMPRESION ─► IMPRESO
   │  sin pedido: expira              ▲                  │          │                                    │  ▲
   └─► EXPIRADO                       │                  │          └─(pedir corrección)► NECESITA_CORRECCION
                                      │                  │                                     │
ARCHIVO_PENDIENTE ─(se adjunta)───────┤                  └─(rechazar)─► RECHAZADO               │ cliente sube nueva versión
                                      └─────────────────────────────────────────────────────────┘ (vuelve a RECIBIDO,
                                                                                                    conserva su lugar)
EN_IMPRESION ─(falla)─► reimpresión: vuelve a EN_IMPRESION con motivo y merma anotada
IMPRESO ─(defecto hallado al entregar)─► EN_IMPRESION   (y el pedido REVISADO/EN_ATENCION → EN_DTF)
cualquier estado previo a EN_IMPRESION ─(cliente / mostrador)─► CANCELADO
```

Reglas: transiciones declaradas en **un** `TRANSICIONES_DTF` con el mismo servicio de cambio que escribe
**historial + realtime + correo en un solo sitio**; efectos **después del commit** (misma regla de oro del
`CLAUDE.md`); `tomar` con **guarda atómica** (`updateMany` con `asignadoAId: null` y estado en cola, 409 si
pierdes); subir versión con guarda de `versionVigente` (una revisión de la v1 no puede aprobar la v2).
El servidor manda las **banderas de acción** (`acciones.*`); el frontend no mapea estado→botón.

### 5.2 Cambios en el pedido

| Pieza | Cambio |
|---|---|
| `TRANSICIONES` | `+ EN_DTF`; `EN_REVISION/ESPERANDO_APROBACION/EN_ASESORIA → EN_DTF`; `EN_DTF → REVISADO / CANCELADO`; `REVISADO/EN_ATENCION → EN_DTF` (reimpresión). Domicilio: `EN_DTF → PENDIENTE_PAGO` con encolado a Firebird (D11). |
| `destinoTrasSurtido*` | Recibe `dtfPendiente`; si es `true` y el destino sería `REVISADO` **o** `PENDIENTE_PAGO` (domicilio) → `EN_DTF`. |
| Cierre del último DTF (domicilio) | `EN_DTF → PENDIENTE_PAGO` con `encolarFirebird: true` (la máquina ya lo exige: invariante 2 del `CLAUDE.md`). |
| Cierre del último DTF | Si el pedido está en `EN_DTF` y no queda nada pendiente → `REVISADO` por `cambiarEstado` (efectos: correo "listo en tienda", `esperaClienteDesdeAt`, TV). |
| Gate | Una guarda en `cambiarEstado`: no se sale de `REVISADO` hacia `EN_ATENCION`/`PENDIENTE_PAGO` con DTF pendiente (defensa en profundidad; no debería ocurrir porque el estado ya lo impide). |
| `recalcularTotalesPedido` | Suma `PedidoDtf.subtotal` de los trabajos vivos (H8). |
| `crearPedido` | Acepta `dtf[]` además de `items[]`; exige ≥1 de los dos; adjunta borradores **en la misma transacción** con guarda (`estado: BORRADOR, pedidoId: null, usuarioId`). Solo-DTF → `EN_DTF`. |
| `escaneo.util` | `EN_DTF` → responsable `IMPRESION`, "Impresión DTF", "preparando el DTF". |
| `estado-labels` (correos), `llegada-aviso` | Etiqueta y mensaje de `EN_DTF`. |
| Frontend | `estadoColor.ts`, `estadoDescripcion.ts`, `constants/paths.ts`, shells y menús por rol. |

---

## 6. Roles y permisos

| Acción | CLIENTE | IMPRESION | MOSTRADOR | CAJERO | VENTAS | ADMIN |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Crear borrador, subir archivo/versión, cancelar (antes de imprimir) | ✔ (suyo) | — | — | — | — | ✔ |
| Subir/adjuntar archivo **en nombre del cliente** (USB, correo, WhatsApp) | — | ✔ | ✔ [Q22] | — | — | ✔ |
| Ver cola, tomar, revisar, aprobar, pedir corrección, rechazar | — | ✔ (su tienda) | — | — | — | ✔ |
| Imprimir / marcar impreso / reimprimir / reordenar cola / hora estimada | — | ✔ | — | — | — | ✔ |
| Descargar el archivo original | ✔ (suyo) | ✔ | — | — | — | ✔ (auditado) |
| Chatear en el trabajo | ✔ | ✔ | — | — | ✔ (asesoría) | ✔ |
| Ver estado del DTF dentro del pedido (progreso, qué falta) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Cancelar un DTF ya impreso | — | — | — | — | — | solo con motivo |
| Tarifas, límites, textos, reportes | — | lectura | — | — | — | ✔ |

- **Tienda sale del JWT** (`user.tiendaId`), nunca de un header (misma regla de `PedidoAccessService`).
- **Los archivos son propiedad intelectual del cliente:** solo salen por un endpoint autorizado (dueño,
  Impresión de la tienda, ADMIN), descarga con JWT como blob y **bitácora de cada descarga** (patrón de comprobantes).
- **Checklist de "rol nuevo" (H14)** — `IMPRESION`: `schema.prisma` + migración · `usuarios.dto.ts`
  (`ROLES_EMPLEADO`) · `auth.controller.ts` (`logout`, `me`, `update-profile`, `change-password`,
  `heartbeat`) · `JwtStrategy`/`realtime.gateway.ts` (rooms) · `propuesta.service.ts` y `messages` (decidir
  explícito) · seed + README · frontend `constants/paths.ts`, `useProtectedRoute`, `Navbar`/`UserMenu`,
  `rolColor`, `EmpleadoFormDialog`, `admin/usuarios`, `lib/types`, `lib/api/usuarios`, un `ImpresionShell` ·
  **ampliar `roles-contrato.spec.ts`**: `IMPRESION` no entra a las consolas de otros roles (como `TESORERIA`).

---

## 7. Archivos: subida, almacenamiento, seguridad y revisión

### 7.1 Subida

```
navegador ──(1) POST /dtf/borradores/:id/archivo/iniciar──► API  (valida dueño, tipo, tamaño declarado, cuota)
          ◄── URLs prefirmadas (S3 multipart, partes de ~16 MB, reanudable) ──
navegador ──(2) PUT partes ─────────────────────────────────► bucket PRIVADO   (el API no ve los bytes)
navegador ──(3) POST …/archivo/completar ───────────────────► API: cierra el multipart, lee cabecera, valida
                                                               FIRMA (PDF/PNG), registra PedidoDtfArchivo v(n+1),
                                                               encola el preflight; responde ya con lo barato
worker ──(4) preflight asíncrono ──► actualiza el trabajo ──► realtime `dtf.preflight` al cliente (y al kiosko)
```

- **Por qué directo a S3 y no por el API:** 57 × 250 cm a 300 DPI son ~6,700 × 29,500 px; un PDF puede pesar
  cientos de MB. Los topes actuales son de 5–8 MB y el API bufferiza en RAM. Detrás de un proxy (Cloudflare/PaaS) los
  límites de cuerpo y de tiempo también muerden. **[VERIFICAR: dónde corre el backend, tamaño típico de archivo (Q10).]**
- Requiere **CORS** del bucket para el origen del frontend y permisos `s3:PutObject`/multipart sobre el prefijo
  `dtf/` + regla de ciclo de vida que **aborta multiparts huérfanos**.
- **Sin S3 (dev):** el mismo contrato, pero el API **hace streaming a disco** (`storage-privado/`), sin buffer.
- **Reanudable y con progreso** (el cliente está en el celular, con datos): se reintenta por parte.
- **Tope configurable** (`DTF_MAX_BYTES`, default **[SUPUESTO] 300 MB**) y **cuota de borradores abiertos** por cliente.

### 7.2 Almacenamiento y descarga

Bucket **privado** (o prefijo `dtf/` con la **misma prueba de privacidad** que `ComprobanteStorageService`,
que falla cerrado si el prefijo es legible sin credenciales), `ServerSideEncryption: AES256`, la BD guarda la
**key**. Descarga solo por endpoint autorizado, `Content-Disposition: attachment` + `X-Content-Type-Options:
nosniff`. Al descargar para el RIP el archivo se **nombra solo**: `FOLIO_CLIENTE_DISEÑO_1.20m.pdf` — con eso
desaparece el requisito de "poner su nombre en el archivo".

### 7.3 Seguridad de archivos (incluye el miedo al virus del USB)

| Riesgo | Control |
|---|---|
| Archivo que no es lo que dice (`.html`/`.svg` renombrado) | Tipo por **firma binaria**, no por `mimetype`; solo **PDF y PNG** [Q9]. |
| PDF con JavaScript, `Launch`, archivos embebidos, cifrado | Se **detectan y bloquean** al subir; se leen solo los diccionarios necesarios. |
| Un PDF/PNG malicioso que explote el analizador | El análisis corre **fuera del proceso del API**, con **timeout y tope de memoria**; si falla → `NO_CONCLUYENTE`, nunca bloquea ni tumba el servidor. |
| El encargado abre el PDF original de un desconocido | Revisa sobre la **vista previa generada**; el original solo se descarga para el RIP. |
| Malware genérico | Fase 3: escaneo (ClamAV en contenedor o antivirus del bucket) **[VERIFICAR hosting]**. |
| **USB** | **Nunca** en la tablet ni en el servidor. Si el cliente trae USB, el personal lo conecta a **una PC de recepción aparte** (con antivirus, sin acceso a la red interna ni al RIP) y sube el archivo por el sistema. El virus del USB nunca toca el kiosko. |
| Subida pública desde el celular (sin login) | Token **capability**: firmado, de **un solo borrador**, expira en 10–15 min, solo `iniciar/completar`, rate-limit por IP; no lista ni descarga nada. |
| Adivinar URLs de otros clientes | No hay URLs públicas ni prefirmadas de **lectura**; todo pasa por el endpoint autorizado (IDOR cubierto como en `PedidoAccessService`). |

### 7.4 Revisión automática (preflight)

Por tecnología (límites salen de `DtfTipo`, no hardcodeados). **Fase** = cuándo se construye.

| Regla | Qué mide | Severidad | Fase |
|---|---|---|---|
| Formato real | firma binaria PDF/PNG | ✖ bloquea | 1 |
| 1 página, sin cifrado/JS/embebidos | estructura del PDF | ✖ | 1 |
| Tamaño de archivo | bytes | ✖ | 1 |
| **Ancho = 57 cm** (±0.5) | `MediaBox` del PDF; px ÷ dpi del PNG | ✖ (o ⚠ "se centra" [Q9]) | 1 |
| **Alto ≥ mínimo** | idem | ⚠ "se cobrará el mínimo" | 1 |
| **Alto ≤ 250 cm** | idem | ✖ "divídelo en varios archivos" | 1 |
| Metros y cotización | f(alto, `pasoCobroCm`) | informativo | 1 |
| PNG sin dpi en metadatos | pHYs | ⚠ "asumimos 300 dpi" | 1 |
| **Fondo** (opaco / blanco sólido) | rasterizar a baja resolución y mirar bordes/esquinas, canal alfa | ⚠ fuerte | 2 |
| **Resolución efectiva** | px de la imagen ÷ tamaño colocado | ⚠ <300 · ✖ <150 [Q11] | 2 |
| **Modo de color** | espacio de color de las imágenes | ⚠ RGB [Q11] | 2 |
| **Semitransparencias** (halos blancos) | alfa parcial | ⚠ | 2 |
| **Texto/líneas muy finos** | tamaño de fuente y grosor de trazo | ⚠ [Q11: umbrales] | 2 |
| Espacio vacío (se cobra película sin tinta) | caja del contenido vs. artboard | ℹ "podrías ahorrar $X" [decisión comercial] | 3 |

Motor: **(Fase 1)** `pdf-lib` para metadatos y `sharp` para PNG, ambos instalables por npm sin binarios del
sistema. **(Fase 2)** rasterizar/analizar con `poppler-utils` (`pdfinfo`, `pdfimages -list` da los ppi
efectivos, `pdftoppm`) si el hosting permite Docker; si no, `pdfjs-dist` + `@napi-rs/canvas`.
**[VERIFICAR hosting]** antes de elegir. El preview para la consola se genera a resolución baja (≈2000 px del
lado largo) — nunca a 300 DPI completos.

---

## 8. Precio, cotización y hora estimada

### 8.1 Fórmula (parámetros por tipo, no hardcodeados)

```
alturaCm         = lo medido del archivo
cmCobrados       = max( minimoCm,  ceil(alturaCm / pasoCobroCm) × pasoCobroCm )
metrosCobrados   = (cmCobrados / 100) × copias
subtotal         = metrosCobrados × precioMetro(lista del cliente)
```

`pasoCobroCm`: **100** = metro completo · **50** = medio metro · **1** = exacto. **Default de la demo [SUPUESTO]:
Textil = 50 cm (medio metro), mínimo 50 cm; UV = 20 cm, mínimo 20 cm.** Con medio metro **0.5 → 0.5 m, 0.6 → 1.0 m,
2.6 → 3.0 m**: concuerda con "se imprime a partir de medio metro" **y** con "se cobra el metro aunque hagas 0.6".
Se corrige desde el panel si el negocio lo cobra distinto (Q3).

### 8.2 Ejemplos (Textil, mínimo 50 cm)

| Archivo | Exacto | Medio metro | Metro completo |
|---|---|---|---|
| 57 × 50 cm | 0.50 m = $110 | 0.50 m = $110 | **1.00 m = $220** |
| 57 × 62 cm | 0.62 m = $136 | 1.00 m = $220 | 1.00 m = $220 |
| 57 × 120 cm | 1.20 m = $264 | 1.50 m = $330 | 2.00 m = $440 |

### 8.3 Lo que dice la hoja del 02/10 (15 clientes, 19 trabajos)

| Regla de cobro | Metros Textil | $ Textil | vs. exacto |
|---|---|---|---|
| Exacto | 22.3 m | $4,906 | — |
| Medio metro | 23.5 m | $5,170 | +5 % |
| **Metro completo** | **27.0 m** | **$5,940** | **+21 %** |

**Default de la demo = medio metro** (fila 2): 23.5 m / $5,170 para esa hoja. UV (3 trabajos de 0.2 m): **$360** si es exacto; **$1,800** si se cobrara metro completo por trabajo — por
eso el UV casi seguro *no* se cobra por metro completo. **Conclusión:** la regla no es un detalle: mueve el
ingreso y el diseño de la etiqueta de precio. Lo configuramos (`pasoCobroCm` por tipo) y se decide con el
cliente (Q3).

### 8.4 Hora estimada de entrega
`hora = ahora + (metros por delante en la cola de esa tecnología) ÷ velocidadMetrosHora + holgura`. Reemplaza la
columna HORA a mano: el cliente ve "listo hoy ≈ 2:40 pm" al aprobarse; Impresión puede **ajustarla** (queda
registrado quién y por qué) y el sistema la recalcula al reordenar o al fallar una impresión. Requiere
velocidades reales (Q17) y, opcionalmente, **hora de corte** y **cupo diario** (si ya hay >X m hoy: "saldrá mañana").

---

## 9. Integración con pedido, ERP y pago

1. **Total del pedido** = prendas + DTF (`recalcularTotalesPedido`, H8). El monto de una transferencia, la fila
   de caja y el total que ve el cliente ya salen de ahí.
2. **Total firme en `PENDIENTE_PAGO`** (D1 del plan de pagos) se conserva **por construcción**: el DTF debe
   estar resuelto (impreso, cancelado o rechazado) antes de salir de `EN_DTF`, así que el total no cambia
   después de mandar a pagar.
3. **Propuestas (bodega/ventas):** `calcularAjuste` calcula solo prendas. Con DTF, el "total propuesto" debe
   **sumar el DTF como constante** y la tarjeta lo muestra como línea sin cambios; si no, el cliente ve un total
   distinto del que se le cobra y `invariantes-dinero.spec` / `calculadora-ajuste.spec` fallan. *Es el costo oculto
   más fácil de olvidar.*
4. **ERP (Firebird) — Caso A confirmado viable** (H20–H24; falta el código del producto):
   - `poll()` agrega **un renglón por trabajo vivo** al `items[]` del payload, con `productoCodigo`,
     `localProductoId` (vía `ExternalRef('PRODUCTO','PRODUCTOS')` del `DtfTipo.productoId`), `localCorridaId: 0`,
     `localColorId: 0`, `talla: ''`, `cantidad` = **metros cobrados** (decimal), `precioUnitario` = precio por metro y
     `skip: false`. Hoy **todo item sin `PrecioCO` marca el pedido en `RETRY→ERROR`** (H5): se le da a las líneas DTF un
     camino propio, sin relajar la regla de las prendas.
   - El agente (`down-processor.ts`) ya llama `GRABAR_MOVPED` con esos mismos argumentos; solo hay que probar que no
     truene con `IDCORRIDA/IDCOLOR = 0` y `TALLA = ''` (H21: el SP no valida). **[VERIFICAR con el programador de VFP]** que
     la conversión PEDIDO → factura acepte una línea sin corrida/color.
   - El `total` del payload **sí incluye** el DTF (coincide con Σ de renglones: no se dispara la alerta de `TTOTAL` cambiado)
     y `PEDIDOS.NOTAS` recibe el resumen de cada DTF (H24) para que caja sepa qué está cobrando.
   - Un pedido **solo-DTF** ya tiene líneas → genera **folio** y entra a la cola de caja como cualquier otro.
   - **Caso B (respaldo)** si el producto aún no existe o VFP no acepta la línea: el payload manda solo prendas y caja ve
     "Captura en el Sistema Comercial: DTF Textil 1.0 m × $220" (el patrón del aviso de transferencia); un pedido
     solo-DTF necesitaría vía manual. **Para la demo basta el Caso B** (no toca el agente ni el ERP).
   - En ambos casos: `PAGADO` sigue naciendo **solo** de `FINALIZADA` de VFP.
5. **Promo de volumen:** no cuenta DTF (no está en `items`). Un descuento por metros (p. ej. 10 m+) sale de la
   **lista 2 del producto DTF** en el ERP (D5), no de la promo de prendas.
6. **Transferencias:** la instrucción se emite en `PENDIENTE_PAGO` con el total (ya incluye DTF).
7. **Sin recoger:** `EN_DTF` no participa del barrido (no hay bolsa en el área de entrega todavía). Al pasar a
   `REVISADO` empieza `esperaClienteDesdeAt` como hoy; con DTF impreso el barrido **solo recuerda**, no cancela (D12).

**Archivos que se tocan (mapa):** `schema.prisma` + 2 migraciones · `core/pedido-state.service.ts` ·
`core/destino-post-surtido.util.ts` · `core/totales.util.ts` · `core/escaneo.util.ts` · `core/llegada-aviso.util.ts` ·
`mail/estado-labels.ts` · `cliente/cliente.service.ts` + DTO · `bodega/surtido.service.ts`,
`propuesta/propuesta.service.ts` (los 3 cierres) · `propuesta/calculadora-ajuste.util.ts` ·
`messages/messages.service.ts` · `sync/handlers/pedido-descarga.handler.ts` (+ agente, Caso A) · `sync/handlers/cliente.handler.ts` (crédito, Fase 2) ·
`notifications/` + `mail/` · `realtime/` · `usuarios/`, `auth/` (rol) · módulo nuevo `dtf/`.

---

## 10. Kiosko: cómo entra un archivo

**No se acepta USB en la tablet**: la tablet está bloqueada (el personal no navega ajustes), un USB es el vector de
virus más común y el navegador del kiosko no debe tener un explorador de archivos abierto. Lo que sí hay:

```
 TABLET (sesión del cliente)                          CELULAR del cliente
 ───────────────────────────                          ───────────────────
 Catálogo ► [Impresión DTF] ► Tipo (Textil / UV)
 "Sube tu archivo": 3 opciones
   ① Desde mi celular ──► POST …/enlace-subida ──► token capability (10 min, 1 borrador)
        muestra QR grande ◄── escanea con la cámara ──► abre /dtf/subir?t=… (SIN login)
        "Esperando tu archivo…"                         elige PDF/PNG (galería, Archivos, WhatsApp, Drive)
                                                        barra de progreso (S3 directo)  ──► "Listo, regresa a la tablet"
   ◄── realtime `dtf.archivo-recibido` / `dtf.preflight` (room user-{cliente}) ──
   la tablet avanza sola: vista previa + semáforo de revisión + cotización
   ② Traigo USB / computadora ► "Entrégalo en mostrador, lo subimos por ti"
        crea el trabajo en ARCHIVO_PENDIENTE; el pedido se hace igual y Impresión/Mostrador adjunta el archivo
   ③ Ya lo mandé por correo/WhatsApp ► igual que ②
```

- **Inactividad (H16):** mientras haya un QR abierto o una subida en curso el guard **se pausa** (con tope de
  10 min y aviso propio); si el cliente se va, el borrador expira. Sin esto, la sesión muere a mitad de subida.
- **Sin internet en la tienda:** la subida usa los datos del celular; la tablet necesita su socket o polling
  (`usePollingRealtime` ya existe).
- **Ruta del kiosko:** hoy `/dtf` está en `KIOSKO_BLOQUEADAS` (es marketing). Se separa: la landing sigue
  bloqueada; el **configurador** (`/dtf/nuevo`) se abre para el kiosko, accesible desde una tarjeta del catálogo.
- El mismo puente "escanea con tu celular" sirve **en la web de escritorio** (cliente en su computadora, el
  archivo en el celular) — un solo flujo, no dos.
- El kiosko ya exige login: el pedido DTF queda del cliente; trazabilidad `kioskoId`/`canalOrigen` igual que hoy.

---

## 11. Escenarios

> El servidor decide qué botón cabe (`acciones.*`); cada fila dice **qué pasa** y **dónde vive la regla**.

### A. El archivo

| # | Situación | Qué pasa | Dónde |
|---|---|---|---|
| A1 | Lo mandó **con fondo blanco/de color** por error | ⚠ en la revisión automática (Fase 2); si pasa, Impresión pide corrección con motivo "fondo". El cliente sube v2; vuelve a RECIBIDO **sin perder su lugar**. | preflight + `pedir-correccion` |
| A2 | Semitransparencias / sombras (halos blancos) | ⚠ al cliente con explicación visual (fondo oscuro en la vista previa); decide Impresión. | preflight, preview con fondos |
| A3 | Ancho ≠ 57 cm, alto < mínimo, alto > 250 cm | Se **bloquea al subir** con el motivo exacto ("mide 61 cm de ancho; debe medir 57") y "divídelo" si >250. Alto < mínimo: ⚠ "se cobra el mínimo". | preflight (Fase 1) |
| A4 | Resolución baja | ⚠ "se verá pixelado"; el cliente puede seguir marcando "entiendo el riesgo" (`aceptoRiesgo`); Impresión aún puede pedir corrección. | preflight (Fase 2) |
| A5 | Letra o líneas muy finas | ⚠ heurística (Fase 2); la decisión final es de Impresión ("la letra chica se desaparece"). | preflight + revisión |
| A6 | RGB en lugar de CMYK | ⚠ "los colores pueden variar"; no bloquea. **[Q11]** | preflight |
| A7 | Archivo corrupto / protegido / varias páginas | ✖ al subir, mensaje claro. | validación al completar |
| A8 | Archivo gigante o red lenta | Multipart reanudable con progreso; tope y mensaje claro. | §7.1 |
| A9 | **Mandó el archivo equivocado** | Hasta antes de `EN_IMPRESION` el cliente **reemplaza** (nueva versión) o cancela. Después, no. | `puedeSubirVersion` |
| A10 | Subió **el mismo archivo** otra vez | Por `sha256`: "ya lo subiste en el pedido X" → reutilizar el aprobado (salta revisión). | §15 |
| A11 | **No se puede hacer** (contenido que no imprimen, imposible) | `RECHAZADO` con motivo y explicación; el pedido sigue sin él y el total baja; si era lo único, el pedido se cancela con motivo. Avisa por correo. | `rechazar` + `recalcularTotalesPedido` |
| A12 | Marcas registradas / derechos de autor | Política del negocio **[Q14]**; Impresión puede rechazar con motivo "contenido"; queda auditado. | `rechazar` |
| A13 | Cliente sube v2 **mientras** Impresión revisa v1 | Guarda de `versionVigente`: la revisión de v1 ya no puede aprobar v2; vuelve a RECIBIDO. | §5.1 |

### B. Cliente y comunicación

| # | Situación | Qué pasa |
|---|---|---|
| B1 | Quiere **hablar con el diseñador** para saber qué falló | Chat anclado al trabajo (D10) + motivos predefinidos visibles. Mensajes con aviso por correo. |
| B2 | No responde a la corrección | Recordatorio (24 h [SUPUESTO]); aparece en "Esperando al cliente"; Impresión o Mostrador pueden **quitar ese DTF y seguir** con lo demás (RECHAZADO/CANCELADO con motivo). |
| B3 | Quiere cambiar tipo (Textil↔UV) o copias | Hasta `APROBADO`: se re-cotiza y se avisa el nuevo total. Después, no. |
| B4 | Cancela el DTF antes de imprimir | `CANCELADO`; el total baja; si era lo único, el pedido se cancela. |
| B5 | Cancela **ya impreso** | No: lo decide ADMIN con motivo (D12, Q2). |
| B6 | Llega a tienda y no recoge el DTF impreso | Se queda `IMPRESO`; recordatorio; **no hay reposición** ni cancelación automática (D12). |
| B7 | Cliente recurrente quiere repetir un diseño | "Mis diseños": reordena con un toque; si fue aprobado, **salta la revisión** (§15). |

### C. Operación de la impresión

| # | Situación | Qué pasa |
|---|---|---|
| C1 | Dos personas abren el mismo trabajo | `tomar` con guarda atómica: la segunda recibe 409 con el nombre de quien lo tiene. |
| C2 | **Falla la impresión** (banding, atasco, película dañada) | `reimprimir` con motivo: vuelve a `EN_IMPRESION`, se anota **merma**, se recalcula la hora y se avisa al cliente si cambió. No se cobra doble. |
| C3 | La impresora está fuera de servicio | Banner en `/dtf` y en el configurador ("hoy no recibimos DTF" / "saldrá mañana") + la hora estimada se extiende. Bandera del ADMIN/Impresión. |
| C4 | Pasó la hora de corte / se llenó el cupo | Aviso en el configurador: "saldrá mañana". **[Q17]** |
| C5 | Cliente urgente / VIP | Impresión **reordena** la cola con motivo (queda en bitácora) y se recalculan las horas. **[Q19]** |
| C6 | Pedido con Textil **y** UV | Dos trabajos con colas distintas; el pedido sale de `EN_DTF` cuando **ambos** están impresos. |
| C7 | **Mixto**: las prendas están listas y el DTF no | El pedido espera en `EN_DTF`; mostrador ve "falta DTF (2 de 3 listos)". Si el cliente está en tienda y quiere llevarse las prendas: **"Separar el DTF"** (Fase 2, D2): el DTF pasa a su propio pedido solo-DTF y el total se ajusta. Mientras tanto el cliente recibe el aviso por etapas. |
| C8 | Mixto con propuesta de bodega pendiente | La propuesta sigue su camino; al resolverse, el destino lo decide `destinoTrasSurtido*` (→ `EN_DTF` si el DTF no está). |
| C9 | **Defecto hallado al entregar** | `Reabrir por defecto`: el trabajo → `EN_IMPRESION`; el pedido `REVISADO/EN_ATENCION → EN_DTF`; queda en el historial. |
| C10 | Se imprimen varios clientes en un rollo | El lote se marca "Impresos" de un golpe (`lote/impreso`). **[Q16]** |

### D. Dinero

| # | Situación | Qué pasa |
|---|---|---|
| D1 | ¿Metro completo o exacto? | `pasoCobroCm` por tipo (§8); default de la demo = medio metro. |
| D2 | Precio distinto por cliente / volumen | Lista del cliente (1..6) del producto DTF en el ERP (D5): sin código nuevo. |
| D3 | DTF rechazado o cancelado con transferencia ya emitida | Imposible por construcción: las instrucciones salen en `PENDIENTE_PAGO` y el DTF ya está resuelto. |
| D4 | Cobrar antes de imprimir | Estándar: **no** (se cobra al recoger, D15). Interruptor `pagoAntes` por tipo; Fase 2: automático según crédito del cliente en el ERP. |
| D5 | Reembolso de DTF impreso | No aplica por defecto; ADMIN con motivo (D12). |
| D6 | El Sistema Comercial aún no tiene el producto DTF / VFP no acepta la línea | Caso B de §9: aviso a caja; solo-DTF sin folio → vía manual. |

### E. Kiosko y entrega

| # | Situación | Qué pasa |
|---|---|---|
| E1 | **Cliente con USB** | No en la tablet. Opción ②: lo sube el personal desde la PC de recepción; trabajo `ARCHIVO_PENDIENTE`. |
| E2 | Archivo en el celular | Opción ①: QR → página de subida del celular. |
| E3 | Archivo en Drive/Dropbox/WeTransfer | Lo baja al celular y lo sube (no se aceptan enlaces externos: no se pueden validar). |
| E4 | La tablet se queda inactiva durante la subida | El guard se pausa con tope de 10 min (H16). |
| E5 | Dos clientes, dos tablets | Un token por borrador; expira; un solo uso por archivo. |
| E6 | El cliente se va a medio flujo | El borrador expira (`expiraAt`) y el worker limpia (incluye multiparts huérfanos). |
| E7 | Cliente sin cuenta | Igual que hoy: el kiosko exige login; el registro ya existe en la tablet. |
| E8 | Quiere **enviarlo por paquetería** (con o sin prendas) | Permitido (D11): `EN_DTF → PENDIENTE_PAGO` al quedar impreso, luego `PAGADO → ENVIADO`. Transferencia sigue bloqueada en domicilio. |

### F. Sistema

| # | Situación | Qué pasa |
|---|---|---|
| F1 | Falla S3 / bucket no privado | **Falla cerrado**: 503 con mensaje; el borrador no se pierde. |
| F2 | El preflight se cuelga o el PDF es raro | `NO_CONCLUYENTE`: pasa a revisión manual, nunca bloquea ni tumba el API. |
| F3 | Archivo con virus / PDF malicioso | §7.3: firma, sin ejecución en el API, análisis aislado, descarga como adjunto. |
| F4 | Retención | Original por N meses **[Q15]** (S3 lifecycle: IA → borrar); se conserva miniatura y metadatos. |
| F5 | Dos pestañas, doble clic | Idempotencia: `sha256` + guardas atómicas (mismo patrón que comprobantes). |
| F6 | El agente/Firebird caído | Sin cambio: `PedidoPendienteEnvio` ya reintenta; el DTF no agrega dependencia del agente salvo Caso A. |
| F7 | Evento realtime que nadie escucha | Lista de eventos nuevos en §12 y **a cada pantalla se le registra el suyo** (regla de las TV). |

---

## 12. Notificaciones y realtime

**Correos** (nuevos `TipoNotificacion.DTF_*`; plantilla React Email por variante; `correos.spec.ts` renderiza cada
caso y falla si algo se repite; **un dato, un lugar**; vocabulario "Sistema Comercial", nunca "VFP"):

| Tipo | Cuándo | Contenido |
|---|---|---|
| `DTF_RECIBIDO` | se adjunta el archivo | "Recibimos tu archivo; lo revisamos" + medidas y total |
| `DTF_NECESITA_CORRECCION` | pedir corrección | motivos en lenguaje claro + botón "Subir nueva versión" |
| `DTF_APROBADO` | aprobar | "Quedó aprobado" + **hora estimada** |
| `DTF_RECHAZADO` | rechazar | motivo y cómo sigue el pedido |
| (existente) `LISTO_EN_TIENDA` | el pedido sale de `EN_DTF` a `REVISADO` | "Tu pedido está listo en tienda" |

El `PEDIDO_RECIBIDO` existente debe **listar también los DTF** (nombre, medidas, total).

**Realtime** (strings sueltos; **cada pantalla escucha los suyos**): `dtf.estado` (tienda + pedido + user),
`dtf.cola` (invalida la cola de Impresión), `dtf.archivo-recibido` y `dtf.preflight` (room `user-{cliente}`: la
tablet y el celular), `dtf.hora` (cambió la hora estimada), `dtf.mensaje` (vía chat). Eventos del pedido ya
existentes (`pedido.estado`) cubren `EN_DTF`.

**Worker** (`setInterval`, patrón `SinRecogerWorker`; sin `@nestjs/schedule`): preflight (claim con *lease* en
Postgres), expiración de borradores, recordatorios de corrección, limpieza de multiparts.

---

## 13. API (borrador)

**Cliente** — `GET /dtf/tipos` (tarifas y reglas vigentes de la tienda; público para la landing) ·
`POST /dtf/borradores` · `POST /dtf/borradores/:id/archivo/{iniciar,completar}` · `GET /dtf/borradores/:id`
(estado + preflight + cotización + banderas) · `DELETE /dtf/borradores/:id` · `POST …/enlace-subida` (QR) ·
público con token: `POST /dtf/subida-movil/:token/{iniciar,completar}` · en el pedido: `dtf[]` con `acciones.*`,
`POST /cliente/pedidos/:id/dtf/:dtfId/{version,cancelar}` · `GET /dtf/:id/archivo/:version` (blob) ·
`GET /dtf/mis-disenos`, `POST …/reordenar`.

**Impresión (`IMPRESION`, ADMIN)** — `GET /impresion/{cola,resumen,hoja,hoja.csv}` · `GET /impresion/:id` ·
`POST /impresion/:id/{tomar,soltar,aprobar,pedir-correccion,rechazar,imprimir,impreso,reimprimir,archivo}` ·
`POST /impresion/lote/impreso` · `PATCH /impresion/:id/hora-estimada` · `PATCH /impresion/cola/orden`.

**Admin** — `GET/PUT /admin/dtf/tipos` · `GET /admin/dtf/reportes` (metros/día, rechazos por motivo, tiempos de revisión).

Todo con DTO (`class-validator`), `@Roles`, tienda del JWT, y el spec de contrato que impide endpoints sin `@Roles`.

---

## 14. Frontend y UX

> Al implementar se usan las skills de diseño (`impeccable` / `ui-ux-pro-max` / `frontend-design`) y se verifica
> con Playwright en el navegador y a 1920×1080 para las pantallas de pared, como se hizo con las TV y Tesorería.
> Lo siguiente son **intenciones y estructura**, no el diseño final.

### 14.1 Superficies

| Superficie | Qué es | Reusa |
|---|---|---|
| `/dtf` (pública) | **Rediseño**: precios reales y editables, requisitos en un vistazo, **plantillas descargables** (57 × N cm), cotizador en vivo, FAQ, CTA "Subir mi archivo". Reemplaza el placeholder. | `buildMetadata`, tokens del tema |
| `/dtf/nuevo` (cliente y **kiosko**) | **Configurador** en 3 pasos: tipo → archivo → confirmar. Vista previa con fondos (claro / oscuro / color de playera), semáforo de revisión, cotización. | `CantidadInput` no aplica; `MarcoQr` para el QR |
| Catálogo (web y kiosko) | Tarjeta fija **"Impresión DTF · desde $220/m"** que abre el configurador. | `catalogo/page.tsx` |
| Carrito / `confirmar` | Renglón DTF distinto del de prendas (miniatura del diseño, medidas, metros, precio, estado de la revisión). La promo de 12 piezas **no** cuenta el DTF. | `NavbarCartSheet`, `agruparCarrito` |
| Detalle del pedido (cliente) | Sección **Impresión DTF**: por trabajo, una línea de tiempo (Recibido → Revisión → Aprobado → Imprimiendo → Listo) y las acciones que el servidor permita ("Subir nueva versión", "Cancelar este DTF", chat). | `AvisoPedido`, `SiguientePasoCard` |
| **Consola `/impresion`** | Cola del encargado (ver 14.3) | `PageHeader`, `StatCard compact`, `FilterChips`, `ListToolbar`, `EmptyState`, `ErrorState`, `ImpresionShell` (sobre `RolShell`), `BuscadorPedidos` |
| `/impresion/[id]` | **Pantalla de revisión** (ver 14.3) | `ConfirmDialog`, `copiarTexto` |
| Mostrador | En la tarjeta y el detalle: "DTF: 2 de 3 listos"; en el pedido en `EN_DTF`, solo lectura. | `TarjetaPedidoMostrador` |
| Caja | Líneas DTF en el pedido; en el Caso B, el aviso de captura manual. | `PagoCajaAviso` (patrón) |
| Admin | `/admin/dtf`: tarifas y reglas por tipo, textos, motivos de corrección, horarios, reportes. Alta de usuarios `IMPRESION`. | `AdminShell` |
| Kiosko | Pantalla del QR + subida del celular (`/dtf/subir`, sin login). | `KioskSuccessScreen` (QR), `usePollingRealtime` |

### 14.2 Principios de UX (de la casa)

- **El servidor manda las banderas**; la pantalla no mapea estado→botón.
- **Cada dato, una vez** (como la fila de caja): el semáforo dice lo que falla, no se repite en un chip y en un párrafo.
- **Lenguaje del negocio**: "Necesita corrección", "Plano blanco", "Listo en mostrador". Para el cliente, texto redactado por el
  servidor, nunca el código de estado. Nada de jerga ("preflight", "multipart") en pantalla.
- **El kiosko es táctil, con prisa y de pie**: un paso por pantalla, botones grandes, un solo camino principal (QR) y una salida
  clara para el que trae USB.
- **Tokens semánticos** (`--success/--warning/--info/--error`), nunca hex crudo; la consola de impresión usa el patrón de las
  consolas (no paleta de TV).

### 14.3 Wireframes

**Configurador (web / kiosko)**

```
┌─ Impresión DTF ────────────────────────────────────────────────────────┐
│  ① Tipo        ② Archivo        ③ Confirmar                            │
│  [● DTF Textil  $220/m]        [○ DTF UV  $600/m]                      │
│   mín. 50 cm · ancho 57 cm      mín. 20 cm · ancho 57 cm               │
│  ┌────────────────────────────┐   Revisión automática                  │
│  │                            │   ✔ PDF · 1 página                     │
│  │      vista previa          │   ✔ Ancho 57.0 cm                      │
│  │   [Claro | Oscuro | Playera]│  ⚠ 210 dpi (recomendado 300)           │
│  │                            │   ✔ Sin fondo                          │
│  └────────────────────────────┘   ✔ Mide 57 × 62 cm → se cobra 1.00 m  │
│  Nombre del diseño: [ Cáncer de mama            ]                      │
│  Este trabajo: $220.00                         [ Agregar al pedido ]   │
└────────────────────────────────────────────────────────────────────────┘
```

**Pantalla de revisión (`/impresion/[id]`)**

```
┌ #0412 · Alonso Castro · "TAMALES" · DTF Textil · 1.00 m · 3er pedido DTF ──────────┐
│ ┌── Vista previa (zoom, arrastrar, regla en cm) ──┐  Revisión automática           │
│ │  fondo: [□ claro] [■ oscuro] [▒ playera]        │  ✔ Medidas 57 × 100 cm         │
│ │                                                  │  ⚠ Posible fondo blanco        │
│ │                                                  │  ✔ 300 dpi                     │
│ └──────────────────────────────────────────────────┘  ⚠ Texto mínimo ≈ 4 pt        │
│ Versiones: v1 (corrección: fondo) → v2 (actual)     "Diseño ya aprobado antes ✔"    │
│ [Descargar original]   Plano blanco ☐                                  💬 Chat (2) │
│ [ Aprobar ]   [ Pedir corrección ▾ ]   [ Rechazar ]                                 │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**Consola (`/impresion`)**

```
Impresión DTF                                    [Hoja del día]   [🔍 Buscar]
Hoy: 22.9 m · Textil 22.3 · UV 0.6        (Todos) (Textil) (UV)
[Por revisar 4] [Esperando al cliente 2] [Por imprimir 5] [Imprimiendo 1] [Listos 8]
┃ #0412  AREL OCOBACHI · A0 · Textil · 0.6 m · llegó 11:42                 ⚠ 1   [Revisar]
┃ #0415  ZULEYMA NOLASCO · CANCER · Textil · 0.5 m · llegó 11:50                  [Revisar]
┃ #0419  FRANCISCO CORRAL · LOGOS · UV · 0.2 m · hora est. 3:30                   [Revisar]
```

**Kiosko — subir desde el celular**

```
              Sube tu archivo desde tu celular
   ┌────────────┐    1  Abre la cámara de tu celular
   │            │    2  Escanea este código
   │     QR     │    3  Elige tu archivo (PDF o PNG)
   │            │
   └────────────┘    Esperando tu archivo…  ◌          (válido 10 min)
   ───────────────────────────────────────────────────────────────────
   ¿Traes una USB o lo tienes en tu computadora?   →  Te ayudamos en mostrador
```

---

## 15. Ideas para el cliente — **aceptadas por el dueño el 16-oct** (se incorporan por fase)

| Idea | Valor para el cliente | Esfuerzo | Fase |
|---|---|---|---|
| **Revisión automática instantánea** (semáforo antes de pagar) | Menos idas y vueltas; el encargado revisa solo lo dudoso | M–L | 2 |
| **Vista previa con fondo claro / oscuro / color de playera** | Ven ellos mismos el fondo blanco y la letra chica | S–M | 2 |
| **Hora estimada automática** | Sustituye la columna HORA; el cliente sabe cuándo pasar | M | 2 |
| **"Mis diseños"**: repetir un diseño aprobado con un toque, **sin revisión** | Los que repiten (Francisco, Alonso) ahorran tiempo; menos carga de revisión | M | 2 |
| **Hoja del día automática** (las columnas de su Excel) + CSV | Cero cambio de hábito al empezar | S | 1 |
| **Nombre automático de archivo** para el RIP | Se acaba "pon tu nombre en el archivo" | S | 1 |
| **QR → celular** en el kiosko (y en la web de escritorio) | Resuelve USB/archivo en el celular | M | 2 |
| **Plantillas descargables** (PDF/AI/PSD/Canva 57 × N cm) y mini guía | Archivos bien hechos desde el origen | S (+contenido) | 1 |
| **TV de impresión** + aviso "tu DTF está listo" | Mismo lenguaje de las otras TV | M | 3 |
| **Ahorro sugerido** ("tu archivo tiene 60 % vacío → podrías ahorrar $X") | Confianza; decisión comercial del dueño (reduce ticket) | S–M | 3 |
| **Reportes** (metros/día, clientes, motivos de rechazo, tiempo de revisión) | Capacidad y calidad | M | 3 |
| **Carpeta caliente al RIP**: el agente baja los aprobados con su nombre estándar a la carpeta que vigila el RIP | Cero descargas manuales **[VERIFICAR el RIP]** | M | 4 |
| **Constructor de hojas** (acomodar varios logos en el lienzo de 57 cm, en el navegador) | Estilo "gang sheet builder"; sube ticket promedio | XL | 4 |
| **Recepción por WhatsApp** (WhatsApp Business) | Donde ya mandan todo | L (+costo) | 4 |
| **Anticipo / pago previo** al aprobar | Protege contra DTF no recogido | M | según Q2 |

---

## 16. Preguntas abiertas (para el cliente)

### A. Las 8 bloqueantes — estado al 16-oct

| # | Tema | Estado |
|---|---|---|
| **Q1** | Cobro en el Sistema Comercial | ✔ **Sí se cobra ahí.** Esquema analizado: decimales OK, línea sin variante OK (H20–H22). **Falta:** el código/precio del producto DTF (consulta de abajo) y confirmar con el programador de VFP que la conversión a factura acepta la línea. |
| **Q2** | Cuándo se paga | ✔ **Estándar** (D15): al recoger/entregar; interruptor `pagoAntes` y regla por crédito del ERP en Fase 2. |
| **Q3** | Cómo se cobra el metro | ◐ **Listas/precio por cliente: resuelto** (ERP, D5). **Redondeo: no está en el esquema.** Default medio metro (§8.1), configurable. *Se afina con retro.* |
| **Q4** | Dónde se imprime | ✔ Configurable por tienda y tecnología en el admin (D16). Pendiente de saber si Textil y UV son máquinas distintas (hoy se modela una por tecnología por tienda). |
| **Q5** | Equipo | ✔ Rol `IMPRESION`, varias personas por tienda (D6). |
| **Q6** | Pedido mixto | ✔ Esperan juntos, un ticket; "separar el DTF" en Fase 2 (D2). |
| **Q7** | Entrega | ✔ Tienda **y paquetería** (D11). |
| **Q8** | ¿Estampan? | ✔ Solo film. |

**Para el ERP (3 consultas, 2 minutos, en Firebird):**

```sql
-- 1) ¿Cuál es el producto DTF y cómo está dado de alta?
SELECT P.IDPRODUCTO, P.CODIGO, P.DESCRIP, P.UNIDAD, P.UNIDADV, P.FACTOR, P.BASCULA,
       P.MANEJAEXISTENCIA, P.CLAVEUNIDAD, P.CLAVEPRODSERV, P.IDLINEA, P.ACTIVO
FROM PRODUCTOS P
WHERE UPPER(P.DESCRIP) LIKE '%DTF%' OR UPPER(P.DESCRIP) LIKE '%IMPRES%';

-- 2) ¿Qué precios tiene por tienda y por lista?
SELECT R.IDTIENDA, R.PRECIO1, R.PRECIO2, R.PRECIO3, R.PRECIO4, R.PRECIO5, R.PRECIO6, P.DESCRIP
FROM PRECIOS R JOIN PRODUCTOS P ON P.IDPRODUCTO = R.IDPRODUCTO
WHERE UPPER(P.DESCRIP) LIKE '%DTF%';

-- 3) ¿Cómo se ha vendido? (cantidades reales y si se redondea el metro)
SELECT FIRST 40 M.IDFACTURA, M.CANTIDAD, M.PRECIO, M.IMPORTE, M.NOTAS
FROM FAMOVIM M JOIN PRODUCTOS P ON P.IDPRODUCTO = M.IDPRODUCTO
WHERE UPPER(P.DESCRIP) LIKE '%DTF%' ORDER BY M.IDFACTURA DESC;
```
(La 3 contesta Q3 con datos reales: si aparecen 0.6, 0.62 o solo 1.0 / 1.5 / 2.0.)

**Nuevas preguntas que salieron del análisis:**

| # | Pregunta | Mi supuesto |
|---|---|---|
| **N1** | ¿`CLIENTESCXC` son los clientes **a crédito** (días y límite)? ¿Qué significa `PERMITEUNA`? | Sí; `PERMITEUNA` = una sola nota abierta a la vez. |
| **N2** | **Programador de VFP:** al convertir un `PEDIDO` en factura, ¿acepta una línea sin corrida/color/talla (producto-servicio)? | Sí, como ya vende DTF por ahí. |
| **N3** | ¿Hay **un producto por tecnología** (Textil y UV) o uno solo con descripción? ¿Con línea "Servicios"? | Uno por tecnología. |
| **N4** | ¿La impresora Textil y la UV son **máquinas distintas** (cola y velocidad separadas)? | Sí, una por tecnología por tienda. |

### B. Archivos y revisión

| # | Pregunta | Mi supuesto |
|---|---|---|
| Q9 | Formatos: ¿solo PDF y PNG? ¿JPG/TIFF/AI/PSD/CDR/SVG? Si el ancho no es 57 cm, ¿lo acomodan ustedes o lo regresan? | PDF y PNG; ancho ≠ 57 se regresa. |
| Q10 | ¿Qué tan pesados son los archivos que reciben (MB)? ¿El más grande? | Hasta 300 MB. |
| Q11 | Problemas más comunes y **cuáles rechazan vs. solo avisan**: fondo, resolución (¿qué mínimo?), RGB, letra chica (¿qué tamaño?), líneas finas (¿qué grosor?). | Fondo/DPI/RGB/letra solo avisan. |
| Q12 | ¿Ustedes **corrigen** archivos (quitar fondo, acomodar) o siempre los regresan? ¿Lo cobran (diseño/retoque)? ¿Cuánto? | Siempre se regresan; sin cobro de diseño. |
| Q13 | "Plano blanco": ¿lo hace siempre la misma persona en el RIP? ¿Quieren registrarlo o basta "aprobado → impreso"? | Casilla opcional al mandar a imprimir. |
| Q14 | ¿Qué hacen con marcas registradas / derechos de autor / contenido que no imprimen? | Impresión puede rechazar con motivo. |
| Q15 | ¿Cuánto tiempo guardan los archivos? ¿Reimprimen diseños anteriores a petición? | 12 meses; "Mis diseños" sí. |
| Q16 | ¿Se imprimen varios clientes en un mismo rollo o cada archivo corre separado? ¿Piden **copias** del mismo archivo? | Cada archivo separado; copias = 1 (campo listo). |

### C. Operación diaria

| # | Pregunta | Mi supuesto |
|---|---|---|
| Q17 | En la hoja, ¿las filas rosas son **UV**? ¿La hora es la hora **prometida**? ¿Cómo la calculan? **Velocidad** de cada impresora (m/h). ¿Hora de corte? ¿Cupo máximo por día? | Rosa = UV; velocidad configurable; sin cupo. |
| Q18 | Si una impresión sale mal, ¿reimprimen sin costo? ¿Llevan registro de merma? | Sin costo; se registra. |
| Q19 | ¿Hay prioridad (urgente/VIP)? ¿Quién la decide? ¿Cobran extra? | La decide Impresión; sin cargo. |
| Q20 | ¿Qué reportes quieren ver? | Metros por día, por cliente, rechazos. |

### D. Cliente y kiosko

| # | Pregunta | Mi supuesto |
|---|---|---|
| Q21 | **Tablets:** ¿marca/modelo (iPad/Android)? ¿tienen USB? ¿WiFi estable? | Con cámara y WiFi; sin USB útil. |
| Q22 | ¿Qué proporción llega con USB / desde su celular / por WhatsApp? ¿Tendrían una **PC aparte con antivirus** para recibir USB? ¿Mostrador también puede subir archivos? | El personal sube desde una PC aparte. |
| Q23 | ¿Los clientes de DTF son mayormente de la tienda o de fuera? ¿Hay quien no tenga cuenta/correo? | Tienen cuenta (B2B). |
| Q24 | ¿Qué RIP y qué impresora usan (marca/modelo)? | Solo para la idea de carpeta caliente. |

---

## 17. Fases

### Corte para la demo (17-oct) — propuesta, se ajusta con el dueño

El camino feliz **y** los tres caminos de excepción que más impresionan al cliente, con datos de ejemplo (tienda con DTF,
tienda sin DTF, clientes, archivos de prueba bien y mal hechos):
1. **Admin:** enciende DTF Textil/UV por tienda, ve y edita tarifas y reglas (D16).
2. **Cliente (web):** `/dtf` rediseñada → configurador (sube PDF/PNG → medidas, **metros y precio automáticos**, vista previa con
   fondo claro/oscuro/playera) → agrega al pedido junto con prendas → paquetería o tienda.
3. **Impresión (`/impresion`):** cola, revisión con vista previa, **aprobar / pedir corrección / rechazar**, imprimir, listo, **hoja del día**
   y total de metros.
4. **Excepciones:** archivo con fondo → corrección → nueva versión; archivo imposible → rechazo; falla de impresión → reimpresión.
5. **Pedido mixto:** prendas listas, DTF pendiente → el pedido espera en `EN_DTF`; mostrador ve "falta DTF"; al quedar impreso pasa a la plancha.
6. **Opcionales (a confirmar):** kiosko con **QR → celular**; **revisión automática** con semáforo; **hora estimada**.
*Usa el Caso B de §9 (sin tocar el agente ni el ERP) y el precio manual (D5-B) hasta tener el código del producto.*

**Fase 0 — Línea base.** Correr la suite completa y guardar la línea base antes de tocar la máquina de estados (95 suites / 1451
tests según `CLAUDE.md`; **no la he corrido en esta sesión**). Las 8 bloqueantes ya están resueltas (§16-A).

**Fase 1 — Núcleo (valor sin automatismos)** · tamaño **L**
Modelos y migraciones · rol `IMPRESION` + spec de contrato · tarifas y límites (admin) · subida privada por streaming/multipart
(web + **asistida**) · validación **barata** (firma, 1 página, tamaño de página → metros) · cotización · carrito/checkout con DTF
(mixto y solo-DTF) · estado `EN_DTF` + `destinoTrasSurtido*` + gate + `recalcularTotalesPedido` + propuestas con constante DTF ·
**consola `/impresion`** (cola, revisión manual, aprobar / pedir corrección / rechazar, imprimir, listo) · **hoja del día + CSV** ·
detalle del pedido del cliente · correos y realtime · rediseño de `/dtf` · nombre de archivo estándar · **tiendas y tecnologías en el
admin (D16)** · **domicilio/paquetería con DTF (D11)** · línea DTF al ERP (Caso A) cuando se tenga el código del producto.
*Criterio de salida:* un pedido mixto y uno solo-DTF recorren el flujo completo con suite verde y verificado en el navegador.

**Fase 2 — Menos trabajo manual** · tamaño **L**
Revisión automática (fondo, DPI, color, semitransparencias, texto) + vista previa con fondos · **hora estimada** · **chat
anclado al trabajo** · **kiosko por QR → celular** + pausa del guard · **"Mis diseños"** · reimpresión con merma · recordatorios ·
**política de pago por crédito del ERP (D15)** · **"separar el DTF" del pedido mixto (D2)**.

**Fase 3 — Pulido** · tamaño **M** — TV de impresión · reportes · ahorro sugerido · escaneo antivirus · carpeta de retención ·
plantillas descargables y guía.

**Fase 4 — Ideas grandes (aceptadas, tamaño XL)** — constructor de hojas en el navegador · recepción por WhatsApp · carpeta caliente al RIP ·
anticipos con pago en línea.

---

## 18. Pruebas

- **Contrato:** roles (`roles-contrato.spec.ts` + `IMPRESION`); ningún endpoint sin `@Roles`; la forma del payload de `poll()` con y sin DTF;
  **ninguna consulta de bodega ve `EN_DTF`** (un spec que recorra las consultas de la cola).
- **Máquina de estados del pedido:** las nuevas transiciones, `destinoTrasSurtido*` con `dtfPendiente`, reimpresión desde `REVISADO/EN_ATENCION`,
  cancelar en `EN_DTF`; `flujo-completo.spec` con un pedido mixto y uno solo-DTF.
- **Máquina del trabajo:** todas las transiciones y las prohibidas; `tomar` concurrente; versión nueva durante una revisión.
- **Postgres reales** (patrón `*-postgres.spec.ts`; los mocks esconden bugs de `updateMany`): tomar concurrente, adjuntar borradores en
  `crearPedido` (carrera de dos pedidos con el mismo borrador), índices parciales, idempotencia por `sha256`.
- **Dinero:** la tabla de §8.2 y los 19 renglones de la hoja como casos; `calculadora-ajuste` con DTF constante; el total del pedido = Σ prendas + Σ DTF.
- **Archivos:** polyglots (`.html` como `.png`), PDF con JS/cifrado/varias páginas, 0 bytes, truncado, tope, firma correcta con extensión falsa.
- **Token de celular:** expira, un solo borrador, un solo uso, rate-limit, no sirve para leer.
- **Correos:** `correos.spec.ts` + los casos `DTF_*`.
- **Frontend:** el guard de inactividad se pausa durante la subida; cada evento nuevo está escuchado por su pantalla; el kiosko alcanza `/dtf/nuevo` y no la landing.
- **En el navegador (Playwright):** flujo completo web, kiosko con QR, consola de impresión, a 1920×1080 si hay TV.

---

## 19. Riesgos

| Riesgo | Mitigación |
|---|---|
| **`EN_DTF` en una máquina de estados madura** (34 archivos, 1451 tests) | Suite completa antes y después; el compilador marca los `Record`; spec de "bodega no ve `EN_DTF`"; una sola función de destino. |
| **VFP no acepta la línea DTF** al convertir el pedido (N2) | Caso B diseñado (caja captura a mano); el esquema dice que es viable (H20–H21) pero **no hay forma de saberlo sin el programador de VFP**. |
| **No existe el producto DTF o su precio no está por tienda** | Precio manual (D5-B) y dar de alta el producto; la consulta de §16-A lo dice en 2 minutos. |
| **Total propuesto ≠ total cobrado** en propuestas con DTF | Constante DTF en `calcularAjuste` + spec contra el aplicador real. |
| **Subidas grandes** fallan en redes móviles / detrás de proxies | Multipart reanudable directo a S3; tope y mensajes claros; probar con archivos reales (Q10). |
| **Análisis de PDF** pesado o frágil en el hosting | Fase 1 sin rasterizar; Fase 2 en proceso aislado con límites; `NO_CONCLUYENTE` no bloquea. |
| **El guard de inactividad** mata la sesión a media subida | Pausa explícita con tope y un test. |
| **Rol nuevo olvidado en una lista** | Spec de contrato (H14). |
| **Eventos realtime que nadie escucha** | Tabla de §12 y registro por pantalla (falla en silencio si no). |
| **Archivos de clientes = propiedad intelectual** | Bucket privado + prueba de privacidad + bitácora de descargas + retención definida. |
| **DTF impreso no recogido = pérdida** (no hay reposición) | D12 + Q2; recordatorios; política de cobro/anticipo. |
| **Desvío de alcance** (constructor de hojas, WhatsApp) | Fuera de Fases 1–2 explícitamente. |

---

## 20. Fuera de alcance (v1)

Estampado en prenda (se vende solo el film) · constructor de hojas, WhatsApp y carpeta caliente al RIP (Fase 4) · logística **entre**
tiendas (el DTF se imprime en la tienda del pedido) · transferencia en pedidos a domicilio (sigue bloqueada, plan de pagos §18) ·
pasarela de pago en línea (el cobro sigue en VFP) · escaneo antivirus (Fase 3).
