# Plan definitivo: imágenes a S3 + logo editable + limpieza de basura

Estado: **✅ COMPLETADO (2026-09-22)**. Las 7 fases están aplicadas y verificadas
contra infraestructura real.

| Fase | Qué | Estado |
|---|---|---|
| 0 | Bucket S3 + IAM + policy | ✅ |
| 1 | Endurecer el pipeline (multer, magic bytes, timeouts, helmet) | ✅ |
| 2 | Abstracción de storage + contrato de keys | ✅ |
| 3 | Migración de las 75 filas a S3 | ✅ |
| 4 | Logo editable desde el admin | ✅ |
| 5 | Frontend (remotePatterns, limpieza) | ✅ |
| 6 | Limpieza de código muerto | ✅ |
| 7 | Operación (lifecycle, reconciliación, CI) | ✅ |

**Verificación final:** backend y frontend compilan, 54 tests pasan, el catálogo
sirve 80 URLs de S3 con 0 rutas legacy, el logo del correo sale de S3, el borrado
funciona, y el CI detecta drift (probado con caso positivo y negativo).

Reemplaza la propuesta anterior tras completar la auditoría (7 áreas + verificación
adversarial) y la auditoría de código muerto (5 áreas + 128 verificaciones).

---

## 1. Decisiones confirmadas

| Decisión | Elección |
|---|---|
| Acceso al bucket | **Público (solo `GetObject`)** — URLs estables para `<img>`, correos y SEO |
| Servido | **Bucket directo** (`https://bucket.s3.region.amazonaws.com`), **sin CDN por ahora** |
| Imágenes estáticas actuales | **Migrar las 91 a S3 y limpiar `public/products`** |
| Proveedores | **S3-compatible configurable** (AWS hoy; R2/MinIO después cambiando envs) |
| Logo en correos | **URL pública en S3**, editable desde el admin |
| Código muerto | **Eliminar todo lo confirmado** — no dejar basura |

### Por qué bucket directo y no CDN

Un CDN (CloudFront) añade una capa, un certificado y una invalidación que hoy no
se justifican: el catálogo completo pesa **8.19 MB** y el costo base real es
**~$0.01/mes**. El riesgo no es el catálogo, son los **vectores de amplificación**
(§4.3). Con bucket directo se mide primero; si el egress crece, migrar a CDN/R2 es
**cambiar una env** gracias a §3.1 — no reescribir la base de datos.

---

## 2. Estado de partida (verificado, no asumido)

| Hecho | Evidencia |
|---|---|
| `src/modules/imagenes/` ya funciona: subir, borrar, marcar principal, tope 4/color | `imagenes.service.ts`, `imagenes.controller.ts` |
| `storage.service.ts` ya usa `@aws-sdk/client-s3` con fallback a disco | `storage.service.ts:43-49` |
| La BD tiene **75 filas** en `productos_imagenes` con rutas **relativas** `/products/*.webp` | consulta a `tienda_db` |
| Hay **91 `.webp` (8.19 MB)** en `demo-frontend/public/products/` | `du -sh` |
| De esos 91: 75 los usa el seed, 2 los usa `CategoryTiles.tsx`, **14 son huérfanos** | `comm` seed vs disco + grep en `src/` |
| El backend devuelve rutas relativas hoy | `GET /api/catalogo` → `imagenPrincipal: "/products/C0200-caribe-1.webp"` |
| El logo del correo sale de `FRONTEND_URL + /Logo.png` (73 KB en `public/`) | `app.config.ts:46-48` |

---

## 3. Arquitectura objetivo

### 3.1 Decisión clave: la BD guarda **keys**, no URLs

Este es el punto que más bugs inyecta si se hace mal.

| | Guardar URL absoluta | **Guardar key relativa** ✅ |
|---|---|---|
| Dev sin AWS | La URL apunta a un bucket inexistente → todo roto | `productos/1/color-3/abc.webp` resuelve a `/files/...` local |
| Cambiar de proveedor | Reescribir **toda** la BD | Cambia una env, cero migración de datos |
| Migrar a CDN | Igual: reescritura masiva | Cambia `AWS_S3_PUBLIC_URL` |
| Complejidad | Baja | Media (una capa de resolución) |

Se guarda la **key** y se resuelve a URL pública en el borde de la API. Esto además
unifica el problema de las 91 rutas relativas: `/products/x.webp` y
`productos/1/x.webp` son ambas "keys" y se resuelven con la misma función.

### 3.2 Estructura de keys

```
productos/{productoId}/{general|color-{colorId}}/{uuid}.{ext}
branding/logo/{uuid}.{ext}
```

- `uuid` en vez de `Date.now()+random`: sin colisiones, key inmutable.
- `Cache-Control: immutable` es seguro porque la key **nunca se reescribe**;
  subir una foto nueva crea una key nueva (cache-bust automático).
- **Nunca** derivar la key del nombre del color ("Marrón", "Verde Neón" traen
  acentos y espacios).

### 3.3 Resolución de URL — un solo lugar

```
key  →  [StorageService.urlPublica(key)]  →  URL
```

- Con S3: `{AWS_S3_PUBLIC_URL}/{key}`
- Sin S3 (dev): `/files/{key}` (servido por el backend)

Hoy **6 servicios copian** la lógica "imagen del color → fallback"
(`surtido.service.ts:76`, `cliente.service.ts:303`, `pedido-state.service.ts:499`,
`ventas.service.ts:189`, `catalogo.service.ts:364`, `notifications.service.ts:82`).
Se reemplazan por **un helper** `resolverImagen()`. Eso arregla B4 de paso.

#### ⚠️ El bug más caro y más fácil de inyectar (hallazgo CRÍTICO)

`urlPublica()` hoy concatena sin normalizar (`storage.service.ts:108-120`). Si se
despliega el resolver **antes** de migrar los datos, el resultado es:

```
https://bucket.s3...//products/C0200-caribe-1.webp   ← doble slash → 404
```

**El 100% del catálogo se rompe**, y el orden de despliegue entre Fase 2 y Fase 3
lo decide quien opera. Mitigación obligatoria:

1. **Contrato explícito**: `ProductoImagen.url` guarda SIEMPRE una key de storage
   (sin leading slash).
2. `urlPublica(key)` **normaliza** (`key.replace(/^\/+/, '')`).
3. **Detección de legacy**: si el valor empieza con `/products/`, resolverlo contra
   el origen del frontend — así el catálogo sigue vivo entre Fase 2 y Fase 3.
4. `keyDeUrl(url)` simétrico, usado en `eliminarImagen` en vez del
   `url.includes(this.bucket)` actual.
5. **Test unitario** que cubra: key limpia, `/products/x.webp`, URL absoluta de
   bucket, URL de CDN.

#### Las 3 fuentes que hay que reescribir a la vez

El catálogo lee `Producto.imagenPrincipal` **y** `Producto.imagenes[]` **y**
`ProductoImagen.url`. Si se migra solo una, el resto sigue devolviendo
`/products/...` → imágenes rotas en producción **sin error de build**.

Consumidores que devuelven estos campos crudos (inventario completo):
`catalogo.service.ts:182-184,281-283`, `favoritos.service.ts:118-119`,
`cliente.service.ts:336`, `surtido.service.ts:134`, `ventas.service.ts:218`,
`pedido-state.service.ts:547`, **`imagenes.service.ts` (el propio panel admin)**.

Los dos últimos son fáciles de olvidar: `favoritos.service.ts` los expone a la API
y `imagenes.service.ts` los devuelve al panel admin — que mostraría **keys** en vez
de imágenes tras migrar.

La migración debe ser **una transacción única** sobre las tres columnas, y
verificarse después con: *ningún valor en esas columnas empieza con `/products/`*.

### 3.4 Logo editable

No existe ninguna tabla de configuración hoy. Se crea:

```prisma
model ConfiguracionSitio {
  id        Int      @id @default(autoincrement())
  clave     String   @unique @db.VarChar(50)   // 'logo'
  valor     String   @db.VarChar(500)          // key de S3
  updatedAt DateTime @updatedAt @map("updated_at")
  @@map("configuracion_sitio")
}
```

Singleton por `clave`. Con **fallback a la env actual**, así el correo nunca queda
sin logo si la tabla está vacía.

**Importante — dónde se lee el logo realmente:** no es `mail.service.ts`. Se lee en
`notifications.service.ts:58,235` vía `config.get('app.mail.logoUrl')`, evaluado
**por request**. Eso es lo que hace fácil sacarlo de BD.

**Lo que NO hay que hacer:** cachear el logo en `registerAs`. `app.config.ts` es
**síncrono** (`registerAs('app', () => ({...}))`), así que no puede consultar la BD
al arrancar — y si se cachea ahí, cambiar el logo desde el admin **no se refleja**
hasta reiniciar. La lectura por request es la correcta.

---

## 4. Hallazgos de la auditoría

La auditoría corrió 7 análisis en paralelo y **135 verificaciones adversariales**
(3 lentes por hallazgo grave: código / impacto / alternativa). Los verificadores
**confirmaron todos los mecanismos** pero degradaron severidades infladas. La
columna "Sev. real" es la calibrada.

### 4.1 Bugs que YA existen hoy (independientes de S3)

| # | Hallazgo | Evidencia | Sev. real |
|---|---|---|---|
| B1 | **Thumbnails de correo rotos**: se pasa `imagenPrincipal` crudo como `imagenUrl`; con rutas relativas Gmail no las resuelve | `notifications.service.ts:82,262` → `ItemList.tsx:148` | Media |
| B2 | **Fallback local inservible en navegador**: `helmet()` aplica `Cross-Origin-Resource-Policy: same-origin` + CSP `img-src 'self'`; `/files/*` no carga desde el frontend (3001 ≠ 3000) | `main.ts:31,50` | Media |
| B3 | **`imagenPrincipal` es `VarChar(255)`** pero `ProductoImagen.url` es `VarChar(500)`. Hoy no desborda (~100-140 chars), pero es inconsistente | `schema.prisma:283` vs `:311` | Baja |
| B4 | **`imagen` del color no determinista**: 5 selects sin `orderBy` eligen una foto arbitraria | `surtido.service.ts:76`, `cliente.service.ts:303`, `pedido-state.service.ts:499`, `ventas.service.ts:189`, `catalogo.service.ts:364` | Baja |
| B5 | **`public/products` tiene 14 huérfanos** (~1 MB) versionados en git | `public/products/` | Baja |

### 4.2 Defectos del pipeline S3 (se vuelven reales al activarlo)

| # | Hallazgo | Evidencia | Sev. real |
|---|---|---|---|
| S1 | **Multer sin límite**: `FileInterceptor('file')` sin `limits` → memoryStorage bufferiza el archivo **completo** en RAM antes de validar los 5 MB | `imagenes.controller.ts:48` | Media |
| S2 | **Guard de borrado por substring**: `url.includes(this.bucket)` decide si borrar de S3. Con `AWS_S3_PUBLIC_URL` = CDN, **nunca borra** → huérfanos | `storage.service.ts:73` | Media |
| S3 | **Sin timeouts en `S3Client`**: un S3 colgado cuelga el request del admin indefinidamente (**reproducido: >100 s sin abortar**) | `storage.service.ts:43-49` | Media |
| S4 | **Objetos huérfanos**: sube a S3 **antes** del insert en BD; borra en BD **antes** de S3. Sin compensación | `imagenes.service.ts:140-152,168-169` | Baja |
| S5 | **`AWS_S3_BUCKET` vacío + credenciales** activa S3 con bucket `''` | `storage.service.ts:43-49` | Media |
| S6 | **Sin rate limit propio** en el endpoint de subida (solo el global 100/60s) | `imagenes.controller.ts:40-55` | Media |
| S7 | **Tope de 4 es count-then-insert** sin constraint (carrera) | `imagenes.service.ts:127-152` | Baja |
| S8 | **Sin validación de contenido real**: solo mira `file.mimetype` declarado. No es XSS (la allowlist rechaza SVG/HTML), pero deja pasar archivos corruptos | `imagenes.service.ts:214-225` | Baja |
| S9 | **`esPrincipal` sin constraint**: puede quedar con 0 o 2 principales | `imagenes.service.ts:149-151` | Baja |

### 4.3 Costos y amplificación

| # | Hallazgo | Sev. real |
|---|---|---|
| C1 | **`remotePatterns` acepta cualquier bucket S3** (`*.s3.*.amazonaws.com`) → `/_next/image` es un **proxy abierto** | Media |
| C2 | **`remotePatterns` no cubre R2/CDN/dominio propio** (probado: AWS pasa, R2 y dominio propio fallan) | Media |
| C3 | **Sin CDN**: egress directo a precio S3 ($0.09/GB) y sin techo | Media |
| C4 | **`next/image` re-fetchea el original** desde S3 en cada cache miss (TTL 4 h) y genera varias variantes | Media |
| C5 | **Sin lifecycle/IAM/Budgets** en el repo | Media |
| C6 | **Costo base real: ~$0.01/mes.** El riesgo son los vectores de amplificación, no el catálogo | Informativo |

### 4.4 Hallazgos de la fase de completitud (corrigen supuestos del plan)

La fase final de la auditoría buscó específicamente **lo que faltaba**. Encontró
5 cosas que el plan anterior daba por resueltas y **no lo estaban**:

| # | Hallazgo | Impacto |
|---|---|---|
| N1 | **El JSON de propuestas NO lleva `productoId`** — verificado en BD: 18 propuestas, **0 con `productoId`**, 1 con `productoImagen` (`/products/C0200-blanco-1.webp`). El path BODEGA (`propuesta.controller.ts:65-83`) descarta silenciosamente `productoImagen`/`productoId`: el DTO `PropuestaAdjuntaItemDto` no los declara | La mitigación "el JSON ya lleva productoId, se re-resuelve" **era falsa**. Esa propuesta histórica mostrará imagen rota y no hay con qué re-resolverla |
| N2 | **Borrar `public/products` rompe la portada** — 2 de los 4 tiles de `CategoryTiles.tsx:15,21` usan `polo-1-blanco.webp` y `manga-larga-1-azul.webp`, que **no están en el seed** (son huérfanos) | La home pierde 2 de 4 imágenes. Hay que subirlos a S3 explícitamente antes de borrar el directorio |
| N3 | **`AWS_S3_ENDPOINT` y `AWS_S3_FORCE_PATH_STYLE` están en `.env.example` pero el código NUNCA los lee** | El soporte R2/MinIO que el plan promete **no existe todavía**: hay que implementarlo (Fase 2) |
| N4 | **`uploads/` no está en `.gitignore`** | Las imágenes locales subidas por el admin se commitean. Y el borrado local (`url.split('/files/').pop()`) es vulnerable a path traversal |
| N5 | **El squash de migraciones borró 7 migraciones aplicadas sin script de baseline** | `migrate deploy` fallará en cualquier entorno ya desplegado. Local y Neon están resueltos; falta documentar el procedimiento |

Otros hallazgos menores pero reales: eliminar una imagen **no renumera `orden`**
(el siguiente upload puede colisionar); no hay **job de reconciliación** de
huérfanos S3; no hay **healthcheck de S3** al arrancar; los correos usan la
`imagenPrincipal` del producto en vez de la imagen del color del ítem.

### 4.5 Lo que NO es problema (verificado, para no gastar esfuerzo)

- **El sync de Firebird no pisa imágenes** — `catalog.handler.ts:92-105` solo
  actualiza `nombre`/`activo`. Re-sincronizar no borra lo que suba el admin.
- **`absoluteImageUrl` del frontend es idempotente** — funciona igual con URL
  absoluta S3 y con ruta relativa. `og:image` y JSON-LD seguirán correctos.
- **No hay caché de plantillas de correo** — cambiar el logo surte efecto en el
  siguiente envío.
- **El borrado "de objetos ajenos" no es alcanzable** — no hay endpoint que acepte
  una URL arbitraria; el peor caso es un no-op.

---

## 5. Limpieza de código muerto

Auditoría de 5 áreas con **128 verificaciones adversariales**. Resultado:
**43 muertos unánimes**, **14 falsos positivos rescatados**, **7 mixtos resueltos
a mano** (§5.4).

### 5.1 Backend

| Qué | Dónde | Acción |
|---|---|---|
| Función `relojCorreEn` (0 refs; sus 3 hermanas sí se usan) | `core/atencion.util.ts:64` | Borrar función + el import `EstadoPedido` que queda huérfano |
| 13 imports muertos | `catalogo.controller.ts`, `app.module.ts`, `jwt-auth.guard.ts`, `storage.service.ts`, `kiosko.controller.ts`, `ResetPassword.tsx`, `mostrador.service.ts`, `sync-agent.controller.ts`, `usuarios.service.ts`, `ventanillas-cajero.controller.ts` | Borrar uno a uno; `tsc --noEmit` después |
| `rankedIds` calculado y nunca usado | `bodega.service.ts:451` | Borrar |
| `imgWrap` (estilo calculado sin usar) | `mail/templates/ItemList.tsx` | Borrar |
| Args sin usar en `messages.service.ts` | `messages.service.ts` | Borrar |
| Script de debug `s3hang.tmp.js` (884 B, untracked) | raíz del backend | Borrar |
| `.next/trace` + `.next/trace-build` **trackeados en git** (trazas de Next.js dentro de un repo NestJS) | `.next/` | `git rm --cached` + añadir `.next` al `.gitignore` |
| `agent/dist-bin/` = **55 MB** de build regenerable | `agent/dist-bin/` | Borrar del disco (ya gitignoreado; regenerable con `cd agent && npm run package`) |
| `.DS_Store` (3 archivos) | raíz, `agent/`, `agent/dist-bin/` | Borrar (ya gitignoreados) |
| `ANALISIS-TECNICO.md` — describe módulos "vacíos" que ya existen y endpoints `/api/v1` inexistentes | raíz | Borrar (ver §5.4) |
| `README.md` — describe módulos `stock`/`reportes` y `/api/v1` que ya no existen | raíz | Actualizar (no borrar) |
| Script `test:e2e` roto — apunta a `./test/jest-e2e.json` que **no existe** (nunca existió) | `package.json` | Borrar script |
| devDeps sin uso: `supertest`, `@types/supertest`, `@nestjs/testing`, `ts-loader`, `source-map-support` | `package.json` | Borrar (reinstalables con `pnpm add -D` si algún día se escriben tests e2e) |
| 2 scripts SQL de Firebird **contradictorios** (dos archivos `02_` con el mismo propósito; solo uno está en el INSTALL) | `firebird/02_triggers_sync_sin_asumir.sql`, `firebird/03_drop_trg_movped.sql` | Borrar — riesgo MEDIO si alguien ejecuta el equivocado sobre la BD de producción |

### 5.2 Frontend

| Qué | Dónde | Acción |
|---|---|---|
| Directorio `landing/` completo (4 archivos, 0 imports — la home real usa `home/`) | `src/components/landing/` | Borrar |
| `hero-2.jpg`, `hero-3.jpg` (solo los usaba el Carousel huérfano) | `public/images/` | Borrar |
| 4 componentes huérfanos | `bodega/SugerenciaBadge.tsx`, `chat/IndicadorEscribiendo.tsx`, `monitor/MonitorHeader.tsx`, `monitor/MonitorClockProvider.tsx` | Borrar |
| `ChatPorItem` (solo lo menciona un comentario) | `ventas/ChatPorItem.tsx` | Borrar |
| Exports muertos dentro de archivos vivos: `AuthGate`/`useAuthGateState`, `UserButton`, `SkeletonPage`/`SkeletonTable`/`SkeletonGrid`, `StoreLocationGuard`, `validateArray`, `normalizePedido`, `buildProductosById`, `itemListJsonLd`, `fetchFiltros`, `handleApiError`, `useRefreshToken`, `useEnviarPropuestaVentas`, `useForzarPropuesta`, `serializarRespuesta`, `decisionLabel`, `esRespuesta`, `ladoChatDe`, `MODO_ENTREGA_LABEL` | varios | Borrar el export, conservar el archivo |
| Tipos muertos: `DecisionItem`, `PedidoSimilar`, `MonitorContadores`, `MonitorBodegueroPedidoSlot`, `ESTADO_SURTIDO_LABEL` | `lib/types/index.ts` | Borrar |
| **14 `.webp` huérfanos** (~1 MB) | `public/products/` | Borrar (**NO** borrar `polo-1-blanco.webp` ni `manga-larga-1-azul.webp`: los usa `CategoryTiles.tsx`) |
| **15 PNG de iconos huérfanos** | `public/icons/` | Borrar (**NO** borrar `icon-512x512.png`: lo usa `page.tsx:23`) |
| 9 `.svg` de iconos **trackeados en git pero borrados del disco** | `public/icons/` | `git rm` para limpiar el índice |
| 5 SVG boilerplate de create-next-app | `public/{next,vercel,file,globe,window}.svg` | Borrar |
| `browserconfig.xml` (0 refs; sin `<link rel="msapplication-config">`) | `public/` | Borrar + sus 4 iconos exclusivos (`icon-70x70`, `150x150`, `310x150`, `310x310`) |
| `next-pwa.d.ts` — declara un paquete ausente de `package.json` y de `node_modules` | raíz | Borrar |
| `package-lock.json` **stale** (el proyecto usa pnpm: hay `node_modules/.pnpm` y `pnpm-lock.yaml` sincronizado) | raíz | `git rm` |
| 3 docs obsoletos | `DOCUMENTACION-FRONTEND.md`, `PLAN.md`, `SEGUIMIENTO.md` | Borrar (ver §5.4) |

### 5.3 Rescatados — NO borrar (falsos positivos verificados)

`src/modules/pedidos/reposicion/` y `src/modules/pedidos/ventas/` **están vivos**
(cableados en `pedidos.module.ts`, consumidos por `propuesta.service.ts` y por el
frontend). Lo que falta es `git add`, no borrarlos. También vivos:
`prisma/sql/` (documentación intencional), `agent/`, `firebird/`, `dist/`,
`alerta-ventanilla`, `dotenv-missing-dep`, `gitignore-dead-rules`, `types-dead`,
`minor-unused-args`, `settings-local-stale-perms`, `readme-stale`,
`firebird-02/03` (los canónicos), `dist-build-output`,
`claude-scheduled-tasks-lock`, `authbootstrap-comment`.

### 5.4 Los 7 casos mixtos — resueltos

| Caso | Veredicto | Razón |
|---|---|---|
| `supertest` + `@types/supertest` | **Borrar** | 0 imports; `test/` nunca existió. Solo los citan plantillas de `.claude/` (tooling, no runtime). Reinstalables |
| `jest-e2e-config-missing` | **Borrar script** | Está roto: `npx jest --config ./test/jest-e2e.json` falla |
| `item-list-jsonld` | **Borrar** | 1 definición, 0 llamadas. El consumidor natural (`catalogo/page.tsx`) es `'use client'` y no importa `@/lib/seo` |
| `package-lock.json` | **Borrar** | Obsoleto de `create-next-app`; 6 deps fantasma; pnpm es el gestor real |
| `docs-obsoletos-4` | **Borrar + arreglar memoria** | Una memoria activa (`project-kiosko-evolucion.md:12`) cita `ANALISIS-TECNICO.md` → hay que actualizarla al borrarlo |
| `orphan-icons-15` | **Borrar 15** | Verificado archivo por archivo en `src/` + `manifest.json` + `browserconfig.xml`. `icon-144x144-rounded.png` **sí** se usa (no está en la lista) |
| `backend-nestjs-testing` | **Borrar** | 0 specs usan `TestingModule`; los 3 existentes instancian clases directo |

---

## 6. Plan de ejecución por fases

Cada fase es desplegable y reversible por separado.

### Fase 0 — AWS (tú, en consola) — ver §7

Sin esto nada funciona.

### Fase 1 — Endurecer el pipeline (sin AWS)

Arregla bugs que **ya existen**, con el fallback local. **No requiere AWS.**

- `imagenes.controller.ts`: `FileInterceptor` con `limits: { fileSize: 5MB, files: 1 }` (S1).
- `@Throttle` propio en el endpoint de subida, ej. 20/min (S6).
- `storage.service.ts`: `S3Client` con `requestTimeout`, `connectionTimeout`, `maxAttempts` (S3).
- `storage.service.ts`: guard de borrado por **prefijo de base pública**, no substring (S2).
- `main.ts`: excluir `/files/` de CORP/CSP de helmet (B2).
- `imagenes.service.ts`: borrado compensatorio si falla el insert (S4).
- Validación de contenido por **magic bytes** (S8).
- `uploads/` al `.gitignore` + sanear el path traversal del borrado local (N4).
- Guardia `NODE_ENV !== production` en el seed (§8).
- Renumerar `orden` al eliminar una imagen.

### Fase 2 — Abstracción de storage + keys — ✅ COMPLETADA

- `StorageService` con **`key` como contrato**: `urlPublica(key)`, `keyDeUrl(url)`,
  `resolverImagen()`, `resolverImagenes()`, `resolverImagenesPorColor()`.
- **Normalización de leading slash** + **detección del prefijo legacy `/products/`**:
  el bug crítico del doble slash (§3.3) está cubierto con test.
- **Soporte de `AWS_S3_ENDPOINT` + `AWS_S3_FORCE_PATH_STYLE`** implementado (N3).
- Guardia: credenciales + `AWS_S3_BUCKET` vacío → **error al arrancar** (S5).
- `ImagenesModule` marcado `@Global` (mismo patrón que `PrismaModule`): los 7
  consumidores inyectan `StorageService` sin cablear cada módulo.
- Resolver aplicado en los **7 consumidores**: `catalogo.service.ts` (3 puntos),
  `favoritos.service.ts`, `imagenes.service.ts` (panel admin),
  `cliente/surtido/ventas/pedido-state.service.ts` (`productoImagen`),
  `notifications.service.ts` (2 puntos — arregla B1).
- `uuid` en la generación de keys (§3.2).
- **Healthcheck de S3 al arrancar** (`verificarConexion()` en `main.ts`): un bucket
  mal configurado se ve en los logs del deploy, no en la primera subida del admin.

**Verificado end-to-end contra el servidor real:** subida → key en BD
(`productos/1/general/<uuid>.png`) → resuelta a `/files/...` (200) → borrado por key
elimina el archivo. Las 75 rutas legacy del seed quedan **intactas** (el catálogo no
se rompe entre esta fase y la migración). 33 tests pasan.

**Detalle del modo local:** `uploads/` replica la estructura de S3
(`uploads/productos/1/general/...`) para que la key haga round-trip con `/files/<key>`.

### Fase 3 — Migración de datos — ✅ COMPLETADA (2026-09-22)

`scripts/migrar-imagenes-s3.ts` (comando `pnpm migrar:imagenes`). `--dry-run` es el
default; `--apply` escribe; `--limite=N` para pruebas parciales.

**Resultado:** 75/75 filas migradas, 7.12 MB. Las **tres** fuentes quedaron en cero
legacy (`productos_imagenes.url`, `productos.imagen_principal`,
`productos.imagenes[]`).

**Verificado:**
- Las **75 imágenes** cargan desde S3 con HTTP 200 y `Content-Type: image/webp`.
- El catálogo devuelve 80 URLs de S3 y **0 rutas legacy**.
- El panel admin devuelve URLs de S3 (no keys).
- `next/image` optimiza desde S3: 114 KB → 16 KB vía `/_next/image`.
- `tsc` + `nest build` en verde, 33 tests pasan.

**Notas de implementación:**
- El script lee los `.webp` del repo del frontend vía `FRONTEND_PUBLIC_DIR`
  (default `../demo-frontend/public`).
- Actualiza fila + campos legacy en **una transacción**: si se actualizara solo la
  fila, `imagenPrincipal`/`imagenes` seguirían apuntando a rutas inexistentes.
- Aborta si falta algún archivo, para no dejar el catálogo a medias.
- Respaldo previo: `pg_dump -t productos_imagenes -t productos --data-only`.
- **Los `.webp` NO se borraron del frontend**: eso es la Fase 5, tras confirmar.

### Fase 3 (referencia) — Detalle del diseño

Script `scripts/migrar-imagenes-s3.ts`:

1. Lee las 75 filas + los 3 campos legacy.
2. Sube cada `.webp` desde `demo-frontend/public/products/` a
   `productos/{id}/color-{colorId}/{uuid}.webp`.
   **Nota:** los 91 `.webp` viven en el repo del **frontend**, así que el script del
   backend necesita una ruta cruzada (env `FRONTEND_PUBLIC_DIR` o `--source-dir`).
3. Sube también los **2 tiles huérfanos** de `CategoryTiles` (`polo-1-blanco.webp`,
   `manga-larga-1-azul.webp`) — si no, la portada pierde 2 de 4 imágenes (N2).
4. Actualiza **las 3 fuentes en una transacción**: `ProductoImagen.url`,
   `Producto.imagenPrincipal`, `Producto.imagenes[]`.
5. **Idempotente**: si la key ya existe, salta (re-ejecutable).
6. `--dry-run` por defecto; `--apply` para escribir.
7. **Verificación post-migración**: query que confirme que ningún valor de esas
   columnas empieza con `/products/`.

Luego: `ALTER TABLE productos ALTER COLUMN imagen_principal TYPE VARCHAR(500)` (B3) —
si no, la escritura de los campos legacy falla **después** de que la subida a S3 ya
ocurrió, dejando objeto huérfano y campos desincronizados.

### Fase 3b — Política para las propuestas históricas (N1)

El JSON de `PedidoPropuesta.items` **no lleva `productoId`** (0/18 verificado). Dos
opciones:

- **Re-resolver al leer**: `itemId → ItemPedido.productoId → imagen actual`. Más
  trabajo, pero las propuestas viejas siguen mostrando imagen.
- **Aceptar placeholder** en las propuestas anteriores a la migración.

En cualquier caso, **persistir `productoId` en el JSON nuevo**: hoy el path BODEGA
(`propuesta.controller.ts:65-83`) lo descarta silenciosamente porque
`PropuestaAdjuntaItemDto` no lo declara.

### Fase 4 — Logo editable — ✅ COMPLETADA (2026-09-22)

- Migración `20260922223807_add_configuracion_sitio`: tabla `configuracion_sitio`
  (`clave` único, `valor` VarChar(500)). El valor guarda una **key** de storage,
  no una URL.
- Módulo `configuracion/` (`@Global`): `GET/POST/DELETE /admin/configuracion/logo`
  (rol ADMIN).
- Los **5 puntos de lectura** del logo ahora pasan por
  `ConfiguracionService.obtenerLogoUrl()`: `notifications.service.ts` (×2),
  `auth.service.ts` (×2), `messages.service.ts` (×1). Cero lecturas directas de
  `app.mail.logoUrl` fuera del propio servicio (que lo usa como fallback).
- **Lectura por request, no cacheada**: si se cacheara en `registerAs`, cambiar el
  logo desde el admin no surtiría efecto hasta reiniciar (el bug que el plan
  advertía).
- Key con **uuid** (`branding/logo/<uuid>.png`): subir un logo nuevo crea una key
  nueva, así el `Cache-Control: immutable` no impide ver el cambio.

**Verificado end-to-end contra S3 real:** subida (200 público), reemplazo (borra
el anterior), eliminación (vuelve al fallback), magic bytes (rechaza SVG
disfrazado), límite de 2 MB (413), ruta protegida (401 sin token). 10 tests pasan.

**Requiere IAM:** la política del usuario necesita un tercer bloque para
`arn:aws:s3:::BUCKET/branding/*` (además de `productos/*` y `tmp/*`).

### Fase 4 (referencia) — Detalle original

- Migración Prisma para `configuracion_sitio`.
- Endpoints `GET/POST/DELETE /admin/configuracion/logo` (rol ADMIN).
- `notifications.service.ts:58,235` lee el logo de BD con fallback a env —
  **por request, NO cacheado en `registerAs`** (§3.4).
- Validación específica del logo (dimensiones, aspect ratio, formatos).
- El logo debe ser **público**: una URL prefirmada se rompe porque los correos se
  abren días después.

### Fase 5 — Frontend — ✅ COMPLETADA (2026-09-22)

- **`remotePatterns` restringido** (arregla C1): se eliminaron los wildcards
  `*.s3.amazonaws.com` y `*.s3.*.amazonaws.com`. Ahora solo se permite el host
  exacto vía `NEXT_PUBLIC_S3_HOST`. **Verificado:** el bucket propio optimiza
  (200) y un bucket ajeno se **rechaza (400)** — el proxy abierto está cerrado.
- **`.env.example` del frontend creado** (no existía) con `NEXT_PUBLIC_S3_HOST`
  documentada (arregla C2).
- **`CategoryTiles.tsx`**: sus 4 imágenes ahora son URLs de S3. Dos venían del
  seed (migradas con UUID) y dos eran huérfanas que **nunca estuvieron en la BD**;
  se subieron a `productos/tiles/` antes de borrar el directorio.
- **`public/products/` eliminado** (77 archivos, 7.4 MB) con respaldo previo en
  `/tmp/products-backup`. Cero referencias restantes.
- **`seed.ts` corregido**: `getImagenUrl()` ahora devuelve una **key**
  (`productos/seed/<archivo>`) en vez de `/products/<archivo>`. Antes, re-ejecutar
  el seed re-inyectaba rutas que ya no existen.

**Verificado:** `next build` sin warnings, `tsc` en verde (ambos repos), 33 tests
pasan, las 5 páginas principales responden 200, y el HTML de la home sirve los 4
tiles desde S3 con **cero rutas `/products/`**.

> ⚠️ **Pendiente operativo:** el backend en el puerto 3000 se arrancó ANTES de
> configurar las credenciales AWS, así que sigue en modo disco local y devuelve
> `/files/...`. Hay que reiniciarlo para que resuelva a S3.

### Fase 5 (referencia) — Detalle original

- `next.config.ts`: **reemplazar los wildcards** por el host exacto del bucket (C1)
  + `NEXT_PUBLIC_IMAGE_DOMAINS` documentada (C2).
- UI de subida del logo en el admin.
- Crear `.env.example` del frontend (no existe).
- Borrar `public/products` y los 14 huérfanos (B5) — tras confirmar la migración.
- `onError` en los `<img>` planos.

### Fase 6 — Limpieza de código muerto (§5) — ✅ COMPLETADA

Independiente de S3. Verificado: `nest build` + `tsc --noEmit` (ambos repos) en
verde, `next build` sin warnings, y las páginas principales responden 200.

**Backend:** `relojCorreEn` + su import huérfano; 13 imports muertos; `rankedIds`;
`imgWrap`; `catch (err)` sin uso; 2 args `_evento`; `.next/trace*` fuera de git;
`s3hang.tmp.js`; `agent/dist-bin/` (55 MB); 3 `.DS_Store`; `ANALISIS-TECNICO.md`;
script `test:e2e` roto; 5 devDeps (`supertest`, `@types/supertest`,
`@nestjs/testing`, `ts-loader`, `source-map-support`);
`firebird/02_triggers_sync_sin_asumir.sql` (superseded); `README.md` corregido
(prefijo `/api`, usuarios reales, módulos reales).

**Frontend:** `landing/` (4 archivos); 5 componentes huérfanos; `AuthGate.tsx`;
`hero-2/3.jpg`; 14 `.webp` + 15 PNG + 5 SVG + `browserconfig.xml`; 9 SVG fuera del
índice de git; `package-lock.json` stale; `next-pwa.d.ts`; 3 docs obsoletos;
17 exports/funciones/tipos muertos.

**Hallazgos que evitaron borrados incorrectos:**
- `ChatPorItem` tenía 1 referencia: un **comentario desactualizado**, no un import.
- `SkeletonGrid` parecía muerto pero `SkeletonCard` (mismo archivo) se usa en 4 sitios.
- `MonitorContadores` / `MonitorBodegueroPedidoSlot` / `PedidoSimilar` se usan
  **dentro** de sus tipos padre, que sí están vivos.
- `LadoChat` se usa internamente aunque `ladoChatDe` no.
- `ROLES_EMPLEADO` se usa dentro de su propio archivo; solo el import sobraba.
- `password`/`_` en destructuring es el patrón para omitir un campo: se ajustó la
  regla de eslint con `ignoreRestSiblings` en vez de borrar código vivo.
- `useEnviarPropuestaVentas` / `useForzarPropuesta` se conservan: el rol VENTAS
  está vivo y su API existe.
- `03_drop_trg_movped.sql` se conserva: su rollback apunta a un bloque real.

### Fase 7 — Operación — ✅ COMPLETADA (2026-09-22)

**Job de reconciliación** (`scripts/reconciliar-imagenes-s3.ts`, comando
`pnpm reconciliar:imagenes`). Reporta las dos inconsistencias que el pipeline
puede dejar de forma silenciosa:
1. **Huérfanos en S3** — objetos sin fila (cuestan dinero).
2. **Filas rotas** — filas cuya key no existe (muestran imagen rota).

`--dry-run` por defecto; `--borrar` elimina huérfanos (nunca toca filas de BD).
Requiere `s3:ListBucket`, que la política del backend **no** tiene a propósito:
el script explica cómo obtener el permiso temporalmente en vez de volcar un
error de AWS.

**CI con `migrate deploy`** (`.github/workflows/ci.yml`): aplica la cadena
completa sobre un Postgres efímero y luego corre `migrate diff --exit-code` para
detectar drift (schema editado sin migración).

**Verificado con prueba positiva y negativa:**
- Cadena de migraciones sobre BD vacía → aplica limpio.
- Sin drift → `exit 0`, "No difference detected".
- Con drift inyectado a propósito → `exit 2`, `[+] Added tables - drift_test`.
- BD real intacta (75 filas, 3 migraciones aplicadas).

**Lifecycle y Budgets:** requieren la consola de AWS (la política del backend no
puede leer ni escribir la configuración del bucket — correcto por mínimo
privilegio). Ver §7.4 para las 2 reglas del versionado.

### Fase 7 (referencia) — Detalle original

- Lifecycle rules (§7.3), Budgets (§7.4).
- **Job de reconciliación de huérfanos** S3 (hoy no existe): sube a S3 antes del
  insert y borra en BD antes de S3, sin compensación en ninguno de los dos órdenes.
- **Documentar el baseline de migraciones** (N5): el squash borró 7 migraciones
  aplicadas y no hay script/doc del procedimiento. Local y Neon están resueltos,
  pero cualquier entorno ya desplegado fallará con `migrate deploy`.
- CI que corra `prisma migrate deploy` contra una BD efímera (detecta drift).

---

## 7. Guía AWS paso a paso

### 7.1 Bucket creado (✅ 2026-09-22)

| Dato | Valor |
|---|---|
| Nombre | `ptm-tienda-imagenes-921810471247-us-west-2-an` |
| Región | `us-west-2` (Oregon) |
| Espacio de nombres | Regional de la cuenta (el nombre queda reservado a la cuenta) |
| Cuenta | `921810471247` |

Configuración aplicada: uso general · ACL deshabilitadas · Bloqueo de acceso público
con las 2 casillas de **política desactivadas** y las 2 de ACL activadas · versionado
habilitado · SSE-S3 · Object Lock desactivado.

> ⚠️ **Corrección a la versión anterior de este plan.** Decía "deja los 4 bloqueos
> activados". **Eso es falso y rompe el objetivo**: con `BlockPublicPolicy` activo S3
> **rechaza guardar** la bucket policy pública (403), y con `RestrictPublicBuckets`
> activo la policy se guarda pero **no surte efecto** (403 a todo internet). Las dos
> casillas de **política** deben estar desactivadas, en el bucket **y** a nivel de
> cuenta (S3 aplica la combinación más restrictiva).

> ⚠️ **El versionado no es gratis en el sentido operativo.** Con versionado, un
> `DeleteObject` **no borra**: inserta un *delete marker*. La imagen desaparece del
> GET (404, lo que el admin espera) pero los bytes siguen almacenados como versión
> noncurrent **y se siguen facturando**. Sin una regla de ciclo de vida el bucket
> crece de forma monótona. Ver §7.4.

**Nota sobre el nombre:** el sufijo `-921810471247-us-west-2-an` es automático del
espacio de nombres regional. Expone el ID de cuenta en cada URL pública (catálogo,
correos, `og:image`). No es un secreto para AWS, y desaparece cuando se ponga
CloudFront con dominio propio.

### 7.2 Bucket policy (lectura pública solo de objetos)

En el bucket → **Permissions → Bucket policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LecturaPublicaDeObjetos",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::ptm-tienda-imagenes-921810471247-us-west-2-an/*"
    }
  ]
}
```

**Nunca** añadas `s3:ListBucket` público: permitiría enumerar todo el contenido.

### 7.3 Usuario IAM (mínimo privilegio)

**IAM → Users → Create user** (sin acceso a consola). Luego **Create policy** con
este JSON y asígnala:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ImagenesDeProducto",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::ptm-tienda-imagenes-921810471247-us-west-2-an/productos/*"
    },
    {
      "Sid": "HealthcheckDelArranque",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::ptm-tienda-imagenes-921810471247-us-west-2-an/tmp/*"
    }
  ]
}
```

**El bloque `tmp/*` no es opcional**: `StorageService.verificarConexion()` escribe
`tmp/healthcheck` al arrancar. Sin ese permiso el log reporta un falso
"S3 RECHAZA la escritura" aunque las subidas funcionen.

No hacen falta: `s3:ListBucket` (el backend nunca lista), `s3:GetObject` (la lectura
es pública), `s3:PutObjectAcl` (las ACL están deshabilitadas) ni `kms:*` (el cifrado
es SSE-S3, no KMS). **Sin root.**

Luego **Access keys → Create access key → Application running outside AWS**.
Copia las dos claves **directamente a tu `.env`** (ver §7.7) — no las pegues en el chat.

### 7.4 Lifecycle rules

Bucket → **Management → Lifecycle rules**. Con el versionado habilitado, estas
reglas **no son opcionales**: sin ellas el bucket crece de forma monótona, porque
cada borrado deja una versión noncurrent + un delete marker que se siguen
facturando.

| Regla | Acción | Por qué |
|---|---|---|
| `AbortIncompleteMultipartUpload` | 1 día | Higiene: multipart a medias nunca se completa |
| Objetos bajo `tmp/` | Expirar a los 7 días | El healthcheck se autoborra, pero por si falla |
| **Versiones noncurrent** | **Expirar a los 30 días** | Sin esto, cada borrado factura para siempre |
| **Delete markers huérfanos** | **Eliminar** | Un delete marker sin versiones previas es basura |

**Nada de transiciones a IA/Glacier.** Standard-IA factura mínimo 128 KB por objeto
y exige 30 días de permanencia: con 8 MB de catálogo el ahorro es nulo y las
peticiones de transición costarían más que lo ahorrado.

**Consecuencia operativa que hay que asumir:** borrar una imagen desde el panel admin
es un **soft delete**. La imagen desaparece del catálogo (404, lo que el admin espera)
pero los bytes siguen en el bucket hasta que la regla de noncurrent los expire. Es el
precio de tener red de seguridad contra borrados accidentales.
| Transición a STANDARD_IA | 90 días (opcional; catálogo pequeño) |

### 7.5 Alarmas de costo (tu requisito de evitar cuentas altas)

1. **AWS Budgets** → Create budget → **Zero-spend / Monthly cost budget** con
   umbral **$5/mes** (el real es ~$0.01 → detecta anomalías temprano).
2. **CloudWatch Billing Alarm** → >$10.
3. **CloudWatch alarm** sobre `BucketSizeBytes` si crece >500 MB.

### 7.6 El punto clave del egress

`next/image` **re-fetchea el original desde S3** en cada cache miss y genera varias
variantes por imagen. Sin CDN, cada visita puede costar egress a precio S3.

**Recomendación**: empezar con bucket directo (como elegiste) y **medir**. Si el
egress crece, la salida es CloudFront + OAC o Cloudflare R2 (egress $0) — y gracias
a §3.1, migrar es **cambiar una env**, no reescribir la BD.

### 7.7 Envs (ya están en `.env.example`)

```bash
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_S3_BUCKET=ptm-tienda-imagenes
AWS_S3_PUBLIC_URL=          # vacío = se construye desde bucket+region
AWS_S3_ENDPOINT=            # vacío = AWS
AWS_S3_FORCE_PATH_STYLE=false
```

Si dejas `AWS_S3_PUBLIC_URL` vacío, el backend construye
`https://{bucket}.s3.{region}.amazonaws.com`. Ponlo explícito si algún día pones CDN.

### 7.8 Presigned URLs: por qué NO

Analizado y descartado para este caso: el backend ya usa multipart + memoryStorage,
el volumen es bajo (admin-only), y presigned añade complejidad (CORS del bucket,
validación post-subida) sin beneficio. Sí conviene si algún día se suben muchos
archivos en paralelo.

---

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| **Desplegar el resolver antes de migrar → 404 en todo el catálogo** | `urlPublica()` normaliza + detecta el prefijo legacy (§3.3). Test unitario obligatorio |
| Migración a medias → imágenes rotas | Transacción única sobre las **3** columnas + `--dry-run` + respaldo de BD antes + query de verificación |
| Propuestas históricas con URL congelada en JSON | ⚠️ **El JSON NO lleva `productoId`** (verificado: 0/18). Decidir política: re-resolver por `itemId → ItemPedido.productoId` al leer, o aceptar placeholder. Y persistir `productoId` en el JSON **nuevo** (hoy se descarta en el path BODEGA) |
| Borrar `public/products` rompe la portada | Subir a S3 los 2 tiles huérfanos (`polo-1-blanco`, `manga-larga-1-azul`) **antes** de borrar el directorio |
| El seed re-inyecta rutas relativas | El seed pasa a usar el helper de resolución (Fase 2). **Ojo**: el seed no tiene DI de Nest |
| Re-ejecutar el seed borra imágenes del admin | **No tiene guardia `NODE_ENV` hoy** (verificado). Añadirla antes de tocar nada |
| `uploads/` se commitea | Añadir `uploads/` al `.gitignore` + sanear el path traversal del borrado local |
| Cambiar el logo no se refleja (cache inmutable) | Key con uuid: subir un logo nuevo crea key nueva → cache-bust automático |
| `remotePatterns` demasiado abiertos | Fase 5 los restringe al host exacto |
| Borrar código muerto rompe algo | Build + `tsc --noEmit` tras cada fase; los 14 rescatados (§5.3) no se tocan |

---

## 9. Verificación

- `prisma migrate status` → up to date en local y Neon (ya logrado).
- Script de migración en `--dry-run` → reporta 75 filas, 0 errores.
- `curl /api/catalogo` → URLs absolutas de S3.
- Correo de prueba en MailHog → thumbnail y logo cargan.
- `next build` → sin warnings de `remotePatterns`.
- `npx nest build` + `npx tsc --noEmit` → exit 0 tras la limpieza.
- Navegador: catálogo, detalle, admin, correo.

---

## 10. Orden recomendado

**Ahora mismo, sin esperar AWS:**
1. **Fase 6** (limpieza de código muerto) — independiente de todo.
2. **Fase 1** (endurecer el pipeline) — sin AWS.

**Cuando tengas el bucket:**
3. Fase 2 → 3 → 4 → 5 → 7.
