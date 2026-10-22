# Plan de pulido para producción (21-oct-2026)

Auditoría completa de backend + frontend antes de la presentación. Todo lo de "Evidencia" se **reprodujo** en un
stack aislado (BD desechable en `:55432`, backend en `:3010`, build de producción del front en `:3055`), no se dedujo
de leer código. Red de seguridad: `refs/backups/pre-auditoria-2026-10-21` en ambos repos.

## Estado (actualizado 21-oct-2026, noche)

| Fase | Estado | Nota |
|---|---|---|
| F1 Sesión, redirecciones y logout | **HECHA y verificada** | Arnés de navegador `scripts/e2e-auth.ts`; ver `demo-frontend/docs/AUTH-REDIRECTS.md` |
| F2 Limpieza de envs | **HECHA** | Backend: `.env.example` + `validarEntorno`; front: 3 variables; Redis eliminado; S3 unificado |
| F3 Backend: robustez | **HECHA** | Shutdown hooks, `/api/health[/ready]`, WS (CORS, corte al vencer el JWT, `joinPedido`), login con señuelo + bloqueo por cuenta, política de 8 caracteres (backend y espejo en el front), `UserThrottlerGuard` (300/min por usuario o IP), `CancelarPedidoDto` único (Swagger sin duplicados), lint en 0 |
| F4 Front: rendimiento y memoria | **HECHA** | `AudioContext`, selectores de Zustand, `exhaustive-deps`, `RealtimeProvider`, lint en 0 (antes 83 avisos) |
| F5 Verificación final | **HECHA** | Ver «Resultado de F5» abajo |
| F6 Despliegue | **Artefactos listos, sin desplegar** | Destino real: **Render (gratis) + Neon + Vercel**, sin ERP. `Dockerfile` multi-stage, `render.yaml`, `DESPLIEGUE.md` (límites de Render/Neon gratis, pasos, checklist). Alternativa VPS (compose + nginx + TLS) sin probar. Pendiente del dueño: dominio, credenciales rotadas |

Hallazgos nuevos de la pasada de F3/F5 (no estaban en la auditoría original):
- **No existe pantalla de «olvidé mi contraseña»** en el front, aunque el backend tiene `auth/forgot-password` y `auth/reset-password` (y el correo `RESET_PASSWORD`). Un cliente que olvida su clave solo puede pedirle al admin que la cambie. Decisión pendiente.
- **No se podía editar a un empleado sin escribirle una clave nueva** (`EmpleadoFormDialog`: un solo `min(6)` rechazaba el campo vacío aunque el texto dijera «déjala vacía para no cambiarla»). Arreglado junto con la política de 8.
- **Los specs `*-postgres` leen la BD de `.env` si no se les pasa `DATABASE_URL`** (`import 'dotenv/config'` + `new PrismaClient()`). Todas las corridas de esta auditoría llevaron la URL del contenedor aislado.
- **El tope de 100/min era por RUTA y por IP** (la clave de `@nestjs/throttler` incluye clase y handler), no un cubo único como decía la auditoría; igual se agotaba con varias pantallas haciendo polling tras una IP.
- **Quedan lecturas directas de `NEXT_PUBLIC_API_URL` con fallback a `localhost:3000/api`** en `lib/seo/fetchers.ts` y `RealtimeProvider.tsx`. No son alcanzables en producción: **comprobado** que un `next build` sin la variable se cae (exit 1, «NEXT_PUBLIC_API_URL no está definida…», lo lanza `axios.ts` al prerenderizar), pero conviene unificarlas.
- **`marcarComoPagado` lanzaba `Conflict` en dos cobros realmente simultáneos** (el agente reintenta, o llegan dos eventos): las dos transacciones leían el mismo estado, la segunda esperaba la fila y su `UPDATE` no escribía nada. La rama idempotente solo cubría el caso en que la segunda empezaba después del commit de la primera, así que `admin-marcar-pagado-postgres.spec` fallaba solo bajo la carga de la suite completa. Reproducido 3/3 con un test de 30 rondas y arreglado (si no escribió nada se relee y, si ya está cobrado, es idempotente).

### `/code-review` (21-oct, noche)

El primer review se acotó mal (contra el ref de respaldo, que contiene tus archivos sin trackear): reportó 10 hallazgos, **ninguno en código tocado por la auditoría**, todos en trabajo previo sin commitear. Se verificó cada uno leyendo el código:

| Hallazgo | Veredicto | Qué se hizo |
|---|---|---|
| `POST dtf/movil/:token/archivo` (pública): Multer escribe a disco ANTES de validar el token; con token inválido el temporal no se borra (anónimo → hasta 300 MB × 10/min/IP) | **Real** | `DtfMovilGuard` valida la firma ANTES de Multer (`dtf-movil.guard.ts`); `dtf-movil.http.spec.ts` (HTTP real, cuenta archivos en disco; sin el guard fallan 2 de 3) |
| `bolsaEnManosDeBodega` no contaba `EN_REVISION → EN_DTF` como cierre del surtido: un mixto devuelto por ajuste y cancelado perdía su reposición | **Real** | `EN_DTF` agregado + test con historial real (sin el arreglo falla) |
| Agente: `DownProcessor` podía grabar en el ERP un folio ABANDONADO (la nube lo rechazó N veces, p. ej. `FOLIO_EN_USO`) → folio duplicado en el Sistema Comercial | **Real** | `getFolioReservado(…, soloVigentes)`; `setFolioReservado` reemplaza solo abandonados; 3 tests nuevos (4 mutaciones muerden) |
| `vistaTrabajo` mandaba `asignadoA` (nombre del empleado) también al cliente | **Real** | Solo para `mira: 'impresion'` (ninguna pantalla del cliente lo usa); `dtf-vista.spec.ts` |
| `subirArchivo`: versión sin bloqueo → P2002 = 500 y archivo huérfano en S3/disco; `setTimeout` de 25 s sin cancelar; código muerto | **Real** | P2002 → 409, el archivo huérfano se borra, temporizador cancelado, código muerto fuera |
| Tope de Multer (300 MB) duplicado con `app.dtf.maxBytes` | **Real, menor** | Una constante `DTF_MAX_BYTES` en `app.config.ts` |
| `pnpm-workspace.yaml`: `'@prisma/client': set this to true or false` (marcador sin resolver) | **Real** (afecta una instalación limpia en el servidor) | `true` |
| Endpoints del módulo DTF con tipos literales en vez de DTOs (13: ver `dtf.controllers.ts`, `Record<string, unknown>` en admin) | **Real, NO corregido** | Pendiente: módulo sin commitear y el DTO más estricto que lo que manda el front rompería pantallas; con entrada basura de un usuario autenticado da 500, no es una brecha. Hacerlo contra `lib/api/dtf.ts` |
| `kiosko.caido` por `emitToTienda` llega también a las TV de pared (nombre y estado de la tablet) | **Real, menor, NO corregido** | Decisión tuya (19-oct: que lo reciba el gerente). Lo limpio sería un room `gerente-{tiendaId}` en el gateway |
| Agente: tras abandonar un folio, `FolioProcessor` reenvía el mismo número muerto cada ciclo | **Por diseño (B1)**, NO cambiado | «FOLIO_EN_USO no se asigna y se loguea en rojo»: reservar números nuevos en bucle quemaría un consecutivo por minuto sin converger si el consecutivo del ERP retrocedió miles. Decide tú si prefieres auto-reservar |

Además, la pasada completa de pruebas destapó una **carrera real en `marcarComoPagado`** (ver «Hallazgos nuevos»).

**Segunda revisión, con el alcance correcto** (diff árbol contra árbol: solo lo que cambió la auditoría; backend 107 archivos, front 77). Cada hallazgo se verificó leyendo el código:

| # | Hallazgo | Veredicto | Resolución |
|---|---|---|---|
| B1 | El logout por dispositivo sacaba al bodeguero de la TV y devolvía sus pedidos aunque siguiera trabajando en otro dispositivo; y el latido creía «sesión abierta» ante una familia vieja sin revocar (hasta 7 d) | **Real** (consecuencia de F1) | `haySesionViva` (refresh sin revocar y emitido hace <75 min); el logout solo saca si no queda otra, el latido usa el mismo criterio |
| B2 | Cambiar o restablecer la contraseña no cerraba las sesiones abiertas (una sesión robada sobrevivía) | **Real**, previo | Cambiar: cierra las demás y conserva la de este dispositivo; restablecer (correo o admin): cierra todas |
| B3 | Un refresh token (7 d) servía como `Authorization: Bearer` y para abrir un socket; no pasaba por `refresh_tokens` | **Real**, previo | `esTokenDeAcceso` (rechaza `jti` y `kind`) en `JwtStrategy` y en el gateway; comprobado por HTTP |
| B4 | La gracia de 10 s reabría una familia que el logout acababa de cerrar (token VIEJO) | **Real** (F1) | No se reabre una familia con algún token revocado sin `replacedBy` |
| B5 | `POST auth/register` responde 409 «ya existe una cuenta» (enumera correos) | Real, previo, **NO corregido** | Corregirlo exige verificación por correo (mismo mensaje para todos); es el patrón habitual y tiene tope de 5/min/IP |
| B6 | El reset del admin no liberaba el bloqueo por intentos (hoy es la ÚNICA vía de recuperación) | **Real** | `LoginBloqueoService` compartido; el reset del admin libera |
| B7 | El bloqueo tenía una carrera verificar→actuar: una ráfaga de N intentos pasaba todos el chequeo | **Real** | El intento se anota antes de esperar a la BD y a bcrypt: 30 simultáneos → solo 10 gastan bcrypt; un fallo de la BD no cuenta |
| B8 | `validarEntorno` no detectaba: `FRONTEND_URL` con ruta (CORS lo compara tal cual), `SMTP_PORT` ausente (caía a MailHog en silencio), `TRUST_PROXY_HOPS` vacío (NaN → 0) | **Real** | Los tres validados/normalizados (`app.config.spec.ts`). **Pendiente a F6:** `DIRECT_DATABASE_URL` (el `schema.prisma` la exige si se declara `directUrl`; con Postgres propio se borra de los dos lados) |
| B9 | Comentarios que mienten (`CORS_ORIGINS`, `DTF_STORAGE`, `AWS_S3_PUBLIC_URL`, `PAGOS_ALERTA…` como env, el «drenado» de `enableShutdownHooks`) | **Real** | Corregidos (Nest 11 cierra el HTTP DESPUÉS de los `onModuleDestroy`: no es un drenado) |
| F1 | Un login fallido vaciaba el carrito y los favoritos del visitante (`endSession`) | **Real** | `limpiarSiQuedoAMedias`; **E6** del arnés (falla sin el arreglo) |
| F2 | El autocompletado del navegador podía llenar «Nueva contraseña (opcional)» al editar un empleado y cambiársela en silencio | Plausible | `autoComplete="new-password"` (empleado, reset admin, Configuración) |
| F3 | Cookie de refresh `SameSite=None` entre dominios distintos: Safari/Chrome con cookies de terceros bloqueadas expulsan al usuario | Riesgo de topología | **F6:** front y API bajo el MISMO dominio registrable |
| F4 | `NEXT_PUBLIC_SITE_URL` sin definir en un VPS: el QR del kiosko apunta a localhost | Plausible | Aviso en el build (`next.config.ts`); en Vercel basta su URL |
| F5 | El logout de CAJERO/MOSTRADOR con el token vencido no soltaba la estación (`liberar` va con `skipAuthRefresh`) | **Real** | `tokenFrescoParaLiberar`; **E7** del arnés (falla sin el arreglo) |
| F6 | Cada hora el gateway corta el socket al vencer su JWT y el cliente reconecta e invalida la caché | Real, impacto bajo, **NO cambiado** | Una ráfaga de refetch por hora (antes: doble carga en cada visita). Si molesta: un mensaje `token.renovar` para re-autenticar sin reconectar |
| F7 | Una contraseña actual equivocada (401) disparaba un refresh+reintento inútil | **Real** | El backend responde 400 |

### Resultado de F5 (21-oct, noche)

| Comprobación | Resultado |
|---|---|
| Backend `tsc` / lint | limpio / **0 problemas** (línea base: 44 errores + 13 avisos) |
| Backend jest completo contra BD aislada | **163 suites / 2890 tests, verde dos veces seguidas** (línea base 151 / 2736) |
| Agente (`agent/`) | 74/74 (71 + 3 nuevos) |
| Front `tsc` / lint | limpio (los 3 errores de `.next/types` son rutas borradas) / **0 problemas** (línea base: 83 avisos) |
| Front `npm test` | 19/19 archivos |
| Arnés de navegador `e2e-auth.ts` (build de producción) | **57/57** (E1–E7; la línea base era 52, E6 y E7 son nuevos) |
| Login/sesión por HTTP contra el stack real | 11 + 10 comprobaciones (tiempos iguales con/sin cuenta, bloqueo, refresh como Bearer → 401, cambio de contraseña con dos dispositivos, reset del admin) |
| Arranque en producción con envs de ejemplo | aborta con exit 1 listando los 13 problemas y sin levantar nada |
| `next build` de producción sin `NEXT_PUBLIC_API_URL` | se cae con exit 1 y mensaje claro |

**Mutación** (rompo el código a propósito y compruebo que alguna prueba falla; restauro siempre): 37 en el backend (login/limitador/guard 12, política de contraseña 4, sesión 14, configuración 5, guard DTF 1, `bolsa-en-bodega` 1), 4 en el agente, 5 en el front y 2 sobre el navegador (E6/E7 fallan sin los arreglos y pasan con ellos). La carrera de `marcarComoPagado` se reprodujo 3/3 sin el arreglo y pasa 5/5 con él. Dos mutaciones al principio «sobrevivían» o no contaban (un import que rompía la compilación): se arreglaron los TESTS, no se dieron por buenas.

**Qué NO se ha probado:** un despliegue real; el agente contra el Firebird real (solo sus pruebas unitarias; la prueba de punta a punta de oct-2026 sigue vigente); el correo real (SMTP vacío en la BD aislada); S3 real; Safari/móvil.

## 0. Línea base (antes de tocar nada)

| Comprobación | Resultado |
|---|---|
| Backend `tsc --noEmit` | limpio |
| Backend jest | **151 suites / 2736 tests verdes** (129 sin BD + 22 `*-postgres` contra BD desechable) |
| Migraciones desde cero + `migrate diff` contra `schema.prisma` | las 39 aplican; **sin drift** |
| Front `tsc` | limpio en `src/` (3 errores son tipos viejos de `.next/` de rutas borradas) |
| Front `next build` (Turbopack) | OK, 61 rutas |
| Lint backend (sin `--fix`) | 44 errores (43 prettier + 1 `require`) y 13 avisos |
| Lint front | 0 errores, 83 avisos (65 `no-unused-vars`, 14 `exhaustive-deps`) |

## 1. Hallazgos

### A. Sesión y redirecciones — **lo más grave**

| # | Hallazgo | Evidencia |
|---|---|---|
| A1 | **Volver tras >1 h deja la app atorada en `/login?redirect=/admin` con "Preparando tu sesión…" para siempre.** La cookie `auth-session` lleva el `exp` del *access token* (1 h) aunque la sesión real (refresh) dura 7 d. El proxy la ve vencida → 307 a login; `/login` ve el store persistido "autenticado" y hace `push` **antes** de que termine el refresh; el proxy rebota; el refresh sí termina (87 ms) pero nada vuelve a disparar la navegación. | Traza de red de Playwright (E2-A) |
| A2 | **Se pierde el deep-link para todo rol que no sea CLIENTE.** `resolvePostAuthRedirect` descarta `?redirect=` salvo que sea el dashboard del rol. Pides `/admin/pedidos/55`, caduca la sesión, inicias sesión → `/admin`. | E2: ADMIN y GERENTE, 3 variantes, 6/6 pierden el destino |
| A3 | La caída **involuntaria** de sesión se trata como logout voluntario: el guard no propaga `?redirect=` (`fueLogout = estabaAutenticadoRef`). No hay mensaje "tu sesión caducó". | `useProtectedRoute.ts` |
| A4 | El proxy pierde el query string al construir `?redirect=` (`/pedidos?tab=x` → `/pedidos`). | `proxy.ts` |
| A5 | **Rate-limit de redirects en memoria, por IP, una sola cubeta `unknown`** sin `x-forwarded-for`. Un bucle (A1) bloquea con 503 "Too Many Redirects" a **todos**; en producción una tienda entera detrás de una IP pública se bloquea entre sí; en serverless es per-instancia (inútil); los mapas nunca se purgan (fuga). | 503 reales a CLIENTE tras los bucles de admin/gerente |
| A6 | Un empleado con cookie vencida **sí ve `/`** (el proxy la trata como anónimo y pasa). Sin guard cliente en las páginas de escaparate. ADMIN se queda en `/` por diseño. | E1 + código |
| A7 | **Todos los empleados abren `/perfil` y `/configuracion`**; `/perfil` es el QR/identidad del cliente y dispara `GET auth/kiosk-token` (solo-CLIENTE) → 403 en consola. | E1 |
| A8 | `?redirect=` se valida en **dos** funciones distintas (`isValidRedirectForRole` y `resolvePostAuthRedirect`) y ninguna rechaza caracteres de control (`/\t/evil.com`). Además hay un `localStorage['redirectAfterLogin']` que sobrevive a sesiones y causa los "destinos basura" que A2 intenta esquivar. | `redirect.ts`, `paths.ts` |
| A9 | `axios.ts` cae a `http://localhost:3001` (el propio front) si falta `NEXT_PUBLIC_API_URL`: en producción falla en silencio. | `axios.ts:31` |

### B. Cierre de sesión — el "flash" que describes

Reproducido con 300 ms de latencia en **todos** los roles de empleado (sin latencia no se ve):

- Clic → **0,5–0,8 s sin ningún cambio** (la consola sigue ahí mientras corren 1–2 llamadas de red *antes* de limpiar).
- Luego pantalla completa **"Redirigiendo…"** + toast "Sesión cerrada" + **el toast viejo "Bienvenido, …"** a la vez.
- ~300 ms después `/login`. Hay **dos navegaciones** compitiendo (`useLogout` → `router.push` y el guard → `location.replace`); el toast no sobrevive a la recarga.

Causa: `AuthService.logout` limpia el store (re-render sin sesión) y **después** navega con una recarga completa; en medio, los shells pintan su loader de "Redirigiendo…".

### C. Hidratación y `useEffect`

- 113 efectos analizados con el AST de TypeScript: **0 listeners/intervalos sin limpieza**, 5 sin deps (todos el patrón legítimo *latest-ref*), 0 setState en efecto sin deps. Higiene buena.
- **Fuga real:** `app/(counter)/mostrador/page.tsx` crea un `AudioContext` dentro de un efecto y **nunca lo cierra** (+ `setTimeout` sin guardar). Chrome limita a ~6 contextos.
- 14 avisos `exhaustive-deps`: `useMemo` con dependencias que cambian en cada render (`variantes`, `cantidadesDelColor`, `pedidos` en `ProductoDetalleClient`, `ProductQuickView`, `pedidos/page`) → cálculos de catálogo que se repiten en cada render; `ProductoImagenesSheet` y `useJoinPedido` con dep faltante.
- ~14 sitios usan `useAuthStore()` **sin selector** (re-render en cada cambio del store, incl. el refresh de token): Navbar, login, registro, `confirmar`, bodega, ventas, monitores…
- `useStoresHydrated` + `_hasHydrated` funcionan (sin errores de hidratación en consola en las 9 sesiones probadas); `suppressHydrationWarning` en `<html>/<body>` es razonable (next-themes), no está tapando nada.

### D. Realtime y memoria

- `RealtimeProvider` **reconecta el socket en cada refresh de token** (`accessToken` en las deps) y en **cada `connect`** (también el primero) hace `invalidateQueries()` de **toda** la caché → doble carga en cada visita y tormenta de refetch cada hora.
- Realtime es **opt-in** (`=== 'true'`): quien despliegue sin la variable queda en polling sin enterarse.
- Servidor WS: `cors.origin: true` en producción; el JWT se valida **solo al conectar** (un token vencido, un usuario desactivado o con otro rol siguen suscritos hasta desconectar); `joinPedido` no valida el tipo del id.
- Backend: estado en memoria acotado (series de tienda 8 filas, registro de workers); `LimiteIntentosLlegada` es en memoria por diseño (una sola instancia).
- Jest avisa "worker process has failed to exit gracefully": algún test deja timers abiertos.

### E. Backend (seguridad y operación)

- **Refresh no atómico:** `findUnique(revokedAt)` y luego `update`. Dos refresh simultáneos con el mismo token pasan ambos y **bifurcan la familia**; y sin ventana de gracia, la carrera "legítima" (dos pestañas / reintento) destruye la sesión entera.
- **Logout revoca los refresh tokens de TODOS los dispositivos** del usuario (comentado como intencional). Cerrar en la tablet cierra el portátil.
- `refreshToken` comprueba `activo` pero no `deletedAt` (JwtStrategy sí).
- Login: usuario inexistente responde **antes** de `bcrypt` (oráculo de tiempo) y la cuenta desactivada responde con **otra** excepción (confirma que el correo existe, pese al comentario). Contraseña mínima: 6.
- `main.ts` **no llama `enableShutdownHooks()`**: SIGTERM de Docker/PM2 mata el proceso sin ejecutar `onModuleDestroy` (workers, Prisma, Redis) ni drenar peticiones.
- **No hay endpoint de salud** (`/health`) para nginx/Docker/uptime.
- `clearCookie` usa `secure: true` fijo → en dev/Safari el logout no borra la cookie.
- `JwtStrategy` hace 1 consulta a BD (con `include tienda`) **por petición autenticada**: correcto para revocar roles al instante, caro con BD remota (Neon). Candidato a caché de 10–15 s.
- Swagger: `Duplicate DTO detected: "CancelarPedidoDto"` (será error en la próxima mayor de `@nestjs/swagger`).
- Env oculta: `KIOSK_TOKEN_EXPIRES_IN` se lee con `configService.get` y no está en `app.config` ni en `.env.example`.
- 97 `findMany` sin `take` (la mayoría acotadas por tienda/estado; **no se confirmó ninguna como problema**: se mide, no se asume) y 73 `await` a Prisma en bucles (casi todos dentro de transacciones por línea de pedido).

### F. Higiene del repo y bloqueantes de despliegue

- **Ambos repos tienen cientos de cambios sin commitear** (backend 278, front 236) y **10 migraciones sin trackear** (`20261021…` a `20261028…`), `src/common/folio/`, parte del agente. Un `git pull` en el servidor o Vercel **no recibiría nada de eso** y `prisma migrate deploy` dejaría la BD sin esas migraciones.
- Basura trackeada/suelta: `.playwright-mcp/*` (capturas) en el backend, `shot-cajero.mjs` trackeado en el front, `*.tmp.js` en la raíz del backend, `.claude/agents|skills|commands` de otro proyecto ("NOVA Microservicio Autos").
- No hay `Dockerfile`, compose de producción, nginx ni script de despliegue.
- El seed crea 17 cuentas con contraseña `123456`: **inaceptable en un servidor público**.

## 2. Plan por fases

Cada fase termina con: tests verdes, build, y re-ejecución del arnés de navegador (`E1/E2/E3`) cuando toca auth.

### F1 — Sesión, redirecciones y logout (frontend + 2 ajustes de backend) — HECHA

1. **La cookie `auth-session` pasa a significar "hay sesión"**, no "el access token vive": `exp` = ventana del refresh (7 d, deslizante: se reescribe en login y en cada refresh), `Max-Age` 7 d (hoy 1 d: peor que el refresh).
2. **Proxy**: decide por sesión + rol; ya no depende del access token. Conserva `pathname + search` en `?redirect=`. Sustituye el limitador por IP por un **cortacircuitos por navegador** (cookie con contador de ventana corta); al dispararse limpia cookies y manda a `/login` sin `redirect`, sin 503 colectivo.
3. **`AuthService.restoreSession()`** (single-flight): si el store dice autenticado pero el access token está vencido, refresca **antes** de navegar; solo entonces `/login` y `/registro` reenvían (una vez). Si el servidor rechaza → `clearLocalSession` y se muestra el formulario. Fallo de red → "No pudimos verificar tu sesión" con reintento, sin deslogear.
4. **Una sola función valida el destino** (`resolverDestino`): `new URL(x, origin)` mismo origen, sin caracteres de control, ≤512, no público, accesible para el rol. **`?redirect=` se respeta para todos los roles**; se elimina `localStorage['redirectAfterLogin']`.
5. **Motivo del fin de sesión explícito** (`'logout' | 'caducada'`): la caída involuntaria navega a `/login?redirect=<ruta completa>&motivo=caducada` y muestra "Tu sesión caducó. Inicia sesión para continuar."
6. **Logout con un solo dueño y sin parpadeo**: `AuthService.logout()` activa `sesionCerrandose` → overlay global **"Cerrando sesión…"** al instante (nada de "Redirigiendo…"), ejecuta las liberaciones en paralelo con tope de 3 s, revoca en servidor y hace **una** navegación dura a `/login?salida=1`. `useLogout` ya no navega. El toast "Sesión cerrada" lo muestra `/login` al llegar (sobrevive a la recarga) y se cierran los toasts previos.
7. **Request interceptor "token fresco"**: si el access token vence en <30 s, espera el refresh single-flight antes de enviar → desaparecen los 401→refresh→reintento en cascada al volver.
8. **Guard global de rutas** (`RouteGuard` en `Providers`) que aplica `paths.ts` en el cliente como red de seguridad (empleado en escaparate, cliente en consola) con una sola navegación por (ruta, rol). `/` y la landing → dashboard para **todo el personal (ADMIN incluido)**; `/catalogo` y `/producto` siguen visibles para ADMIN (vista previa). `/perfil` solo CLIENTE; `/configuracion` todos.
9. Backend: **refresh atómico** (`updateMany … where revokedAt is null`, `count===1`) **con ventana de gracia de 10 s** (un token recién rotado presentado de nuevo dentro de la ventana no destruye la familia); `refreshToken` también exige `deletedAt === null`.
10. Backend: **logout revoca la familia del refresh de ese dispositivo** (cookie), no todas; sin cookie válida cae al comportamiento actual (revoca todas) como valor seguro.
11. `API_URL` sin fallback a `localhost:3001`: error explícito en el build/arranque.

Pruebas: `scripts/test-auth-loops.ts` y `test-rate-limit.ts` se actualizan al nuevo contrato; se añade el arnés de Playwright (E1 matriz, E2 deep-link ×3 variantes ×3 roles, E3 logout con latencia) como `scripts/e2e-auth.mjs`; jest para refresh atómico/gracia/logout por familia.

### F2 — Limpieza de envs (ver §3) — HECHA

Un solo `S3Config`; bucket público + **un** bucket privado opcional (comprobantes y DTF); constantes en vez de envs para lo que no debe variar; derivar en vez de duplicar; `.env.example` mínimo; quitar `REDIS_URL` (y el adaptador Redis, `ioredis`, `@socket.io/redis-adapter`, el servicio del compose).

### F3 — Backend: robustez — HECHA

`enableShutdownHooks()`; `GET /api/health` (liveness) y `/api/health/ready` (BD); CORS de WS = orígenes del front; re-validación de sesión en WS (desconectar al vencer el JWT; el cliente reconecta con token fresco); validar el tipo de `joinPedido`; login con `bcrypt` de señuelo + respuesta única para inexistente/desactivada (el frontend ya trata `USUARIO_DESACTIVADO`: se mantiene el código solo tras credencial **correcta**); contraseña mínima 8; `clearCookie` con los mismos atributos que `cookie`; `CancelarPedidoDto` único; 44 errores de prettier y avisos de lint; timers de tests; caché corta en `JwtStrategy` **solo si la medición lo justifica**.

### F4 — Frontend: rendimiento y memoria — HECHA

Cerrar `AudioContext` y el `setTimeout` en `mostrador/page.tsx`; selectores de Zustand en los ~14 sitios; arreglar los 14 `exhaustive-deps` (memoizar `variantes` etc.); `RealtimeProvider`: `auth` como callback (no reconectar al refrescar), `invalidateQueries` solo al **re**conectar, realtime por defecto activo; quitar los 65 imports/variables sin uso; `<img>` → `next/image` donde aplique; borrar `shot-cajero.mjs`, `*.tmp.*`, `.playwright-mcp/`.

### F5 — Verificación final — HECHA

Suites completas (151 + agente + scripts del front), arnés E1–E3 de nuevo, `next build`, build del backend, prueba de arranque con `NODE_ENV=production` y envs mínimas, matriz de roles, y `/code-review` sobre el diff completo.

### F6 — Despliegue (artefactos listos; ver `DESPLIEGUE.md`)

Commits ordenados (previa confirmación tuya), `Dockerfile` multi-stage, compose de producción (api + nginx + certbot), `prisma migrate deploy` en el release, healthchecks, respaldo de BD, cookie `SameSite=Lax` **same-site** (`app.` y `api.` bajo el mismo dominio), checklist de la presentación y datos de demostración con contraseñas fuertes.

## 3. Limpieza de envs

### 3.1 Backend — las que pegaste

| Variable | Veredicto | Motivo / acción |
|---|---|---|
| `DATABASE_URL` | **Conservar** | Obligatoria |
| `DIRECT_DATABASE_URL` | **Depende de la BD** | Solo hace falta con pooler (Neon). Con Postgres propio en el VPS se elimina y se borra `directUrl` del `schema.prisma` |
| `JWT_SECRET` | **Conservar** | ≥32 caracteres en producción (el arranque aborta con `secret-key`) |
| `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | **Quitar → constantes** (`1h`, `7d`) | El front tiene `3600` y la cookie `7d` hardcodeados: cambiar la env desincroniza tres sitios en silencio |
| `NODE_ENV` | **Conservar** (lo pone la plataforma) | |
| `PORT` | **Conservar** (opcional, 3000) | Estándar de PaaS |
| `API_PREFIX` | **Quitar → `/api` fijo** | Front, nginx y Swagger lo asumen |
| `REDIS_URL` | **Quitar** | Una sola instancia: no hace falta. Se elimina el adaptador y las 2 dependencias |
| `AGENT_API_KEY` | **Conservar** | Autentica al agente Firebird (`/sync/agent/*`). El comentario del `.env.example` ("marcar-pagado") está obsoleto |
| `SMTP_HOST/PORT/USER/PASS/FROM` | **Conservar** | |
| `SMTP_SECURE` | **Quitar → derivar** (`puerto 465`) | Siempre coincide con el puerto |
| `SMTP_REPLY_TO` | **Conservar** (opcional) | Ya lo usas |
| `FRONTEND_URL` | **Conservar** | Es además el origen CORS (no hace falta `CORS_ORIGINS`) |
| `PASSWORD_RESET_EXPIRES_MIN` | **Quitar → constante (60)** | |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | **Conservar** (o rol IAM si el backend corre en AWS) | **Rotar** (§4) |
| `AWS_REGION`, `AWS_S3_BUCKET` | **Conservar** | Fuente única: hoy `AWS_S3_BUCKET` se lee con `process.env` en 9 sitios; pasa a un solo `S3Config` |
| `AWS_S3_PUBLIC_URL` | **Quitar → derivar** de bucket+región | Solo reaparecería con CloudFront/dominio propio |
| `AWS_S3_ENDPOINT`, `AWS_S3_FORCE_PATH_STYLE` | **Quitar** | R2/MinIO no se usan; sin credenciales el dev cae a disco local |
| `KIOSKO_QR_SECRET` | **Conservar** | Debe ser distinto de `JWT_SECRET` (si uno cae, el otro no) |

### 3.2 Backend — las que el código lee y no pegaste

| Variable | Veredicto |
|---|---|
| `CORS_ORIGINS` | Quitar (`FRONTEND_URL`) |
| `TRUST_PROXY_HOPS` | Quitar: por defecto `1` en producción, `0` fuera (se documenta cómo forzarlo) |
| `MAIL_LOGO_URL` | Quitar (logo subido desde el panel + derivado de S3) |
| `KIOSK_TOKEN_EXPIRES_IN` (oculta) | Quitar → constante `5m` |
| `PEDIDO_RECORDATORIO_HORAS`, `PEDIDO_VENCIDO_HORAS`, `PRESENCIA_CADUCA_HORAS`, `PAGOS_ALERTA_SIN_REGISTRAR_HORAS`, `COMPROBANTE_MAX_BYTES`, `DTF_MAX_BYTES`, `DTF_PREFLIGHT_*`, `DTF_BORRADOR_HORAS`, `DTF_SUBIDA_MOVIL_MIN` | Quitar del `.env.example`: son reglas de negocio con valor sensato, viven como constantes en **un** bloque de `app.config` |
| `PAGOS_ZONA_HORARIA` | Conservar (opcional): Mexicali y la frontera no coinciden con la hora del centro |
| `AWS_S3_COMPROBANTES_BUCKET` + `AWS_S3_DTF_BUCKET` | **Fusionar en `AWS_S3_PRIVATE_BUCKET`** (opcional; prefijos `comprobantes/` y `dtf/`). Sin él se usa el bucket público con la prueba de privacidad de hoy. En producción lo correcto es uno privado aparte (datos bancarios) |
| `DTF_STORAGE` | Quitar (sin credenciales ya es disco local) |
| `AGENT_*`, `SERVICE_MODE`, `COMPUTERNAME` | No son del backend: son del agente Windows (`agent.config.json`) |
| `FRONTEND_PUBLIC_DIR` | Solo del script de migración de imágenes (de una sola vez) |

**Backend final (obligatorias):** `DATABASE_URL` (+`DIRECT_DATABASE_URL` solo con pooler), `JWT_SECRET`, `KIOSKO_QR_SECRET`,
`AGENT_API_KEY`, `FRONTEND_URL`, `SMTP_HOST/PORT/USER/PASS/FROM`, `AWS_ACCESS_KEY_ID/SECRET/REGION/S3_BUCKET`.
**Opcionales:** `PORT`, `SMTP_REPLY_TO`, `AWS_S3_PRIVATE_BUCKET`, `PAGOS_ZONA_HORARIA`. De ~45 posibles a **14**.

### 3.3 Frontend

| Variable | Veredicto | Motivo |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | **Conservar** | La única imprescindible. Sin fallback a `localhost` |
| `NEXT_PUBLIC_SITE_URL` | **Conservar** | Canónicas, OG y QR del kiosko (cae a `VERCEL_PROJECT_PRODUCTION_URL`) |
| `NEXT_PUBLIC_S3_HOST` | **Conservar** | Host de `next/image` (se evalúa al compilar). Es la única copia en el front |
| `NEXT_PUBLIC_WS_URL` | **Quitar** | Se deriva de `NEXT_PUBLIC_API_URL` (el código ya lo hace) |
| `NEXT_PUBLIC_REALTIME_ENABLED` | **Quitar** | Realtime siempre activo; el polling es el respaldo automático |
| `NEXT_PUBLIC_IMAGE_DOMAINS` | **Quitar** | Vacía y sin uso |
| `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_VERSION` | **Quitar** | No se leen en ningún archivo |

**Frontend final: 3 variables.**

## 4. Seguridad de lo que pegaste

Las credenciales reales que pegaste en esta conversación (contraseña de aplicación de Gmail, claves de AWS, cadena de
Neon con contraseña, token de Upstash) quedaron en la transcripción. Aunque dices que las cambiarás, **rótalas antes de
usarlas en cualquier despliegue** (las de AWS y Gmail son las críticas). `JWT_SECRET="secret-key"`,
`AGENT_API_KEY="dev-agent-key…"` y `KIOSKO_QR_SECRET` de ejemplo no arrancarían en producción (o la dejarían abierta).

## 5. Decisiones y preguntas abiertas

Decididas por defecto (las apliqué según tu "acepto mis recomendaciones"; dime si alguna no):
- Todo el personal, **ADMIN incluido**, sale de `/` hacia su consola; ADMIN conserva `/catalogo` y `/producto` como vista previa.
- `/perfil` solo CLIENTE; `/configuracion` para todos (cambio de contraseña).
- Logout cierra **ese dispositivo**, no todos.
- Se elimina Redis.

Necesito de ti (bloquean F6, no F1–F5):
1. ¿Hago yo un **commit de línea base** de ambos repos (rama `pre-auditoria`) antes de mis cambios, y luego commits ordenados por fase? Hoy mis cambios se mezclan con tus ~500 sin commitear.
2. **Dónde se despliega**: ¿VPS (¿proveedor/SO?) + Docker + nginx para el backend y Vercel para el front? ¿Tienes un dominio (`puntotextilmayoreo.com`) para poner `app.` y `api.`? Con dominios distintos entre front y API la cookie de refresh es *cross-site* y Safari/Chrome la bloquean.
3. **Base de datos**: ¿Neon (pooler + directa) o Postgres propio en el VPS?
4. ¿El **agente Firebird** estará conectado en la presentación o se demuestra sin ERP?
5. Cuentas demo: ¿contraseñas fuertes por cuenta, o el seed solo en un entorno privado?


## 6. Despliegue (22-oct-2026)

Respuestas del dueño: commits por fase (hechos, ramas `pre-auditoria` y `auditoria/produccion`, sin push) · **Neon con pooler** · **sin ERP** en la presentación · cuentas demo con `123456` por ahora · destino **Render (gratis) + Vercel**.
Hallazgo del despliegue: **`nest build` no copiaba `preflight-worker.js`** (un `.js` suelto): en una imagen solo con `dist/` TODO análisis DTF fallaba con «No se encontró preflight-worker.js» (en desarrollo funcionaba por el respaldo a `src/`). Arreglado con `assets` en `nest-cli.json` y comprobado dentro de la imagen.
Sin probar: Render, Neon, Vercel, S3/SMTP reales, cuántos saltos de proxy hay en Render (`TRUST_PROXY_HOPS`), el despertar tras dormir, Safari/móvil.
