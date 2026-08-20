# Documento de Análisis Técnico — Tienda de Camisetas (Backend + Frontend)

> **Propósito**: Analizar de forma integral el estado actual del backend (`/Users/fernandoibarra/Documents/Development/Playerytees/demo-backend`) y del frontend (`/Users/fernandoibarra/Documents/Development/Playerytees/demo-frontend`) con el fin de evaluar el impacto, los riesgos y la ruta de implementación de cualquier cambio. **No se genera código en este documento**.
>
> **Alcance de la inspección**: 100% del árbol `src/` de ambos proyectos, `prisma/schema.prisma`, `prisma/seed.ts`, `package.json`, configuración (`.env`, `tsconfig`, `eslint`, `next.config.ts`, `docker-compose`), `app.module.ts`, `main.ts`, layouts, stores, hooks, servicios, y el catálogo de páginas del App Router.

---

## 1. Resumen ejecutivo

| Aspecto | Estado | Observaciones |
|---|---|---|
| **Backend** | Construido, funcional para el flujo principal | NestJS 11 + Prisma 6 + PostgreSQL 18. Tres módulos plenos (auth, tiendas, catalogo, pedidos); tres placeholders vacíos (`usuarios`, `stock`, `reportes`). |
| **Frontend** | Construido, parcialmente conectado | Next.js 16 + React 19 + TanStack Query + Zustand. App Router con grupos por rol; existe UI pero varios dashboards y reportes usan **datos mock**. |
| **Acoplamiento** | Parcialmente alineado | Los tipos del frontend reflejan casi todos los campos del backend, pero hay drift en nombres de enums (`TipoPago` frontend sólo declara 2 valores; backend tiene 4) y algunos endpoints cambian de forma entre cliente/empleado. |
| **Seguridad** | Básica pero operativa | JWT + roles con guards globales; helmet + compression + CORS por entorno; kiosk token de 5 min; refresh queue con dedup. |
| **Observabilidad** | Mínima | Sin logger global, sin filtros de excepción custom, sin métricas, sin rate limiting. Sólo `console.log` de Nest. |
| **Tests** | No implementados | `jest` configurado pero 0 archivos `*.spec.ts` en `src/`. |
| **Producción** | No endurecido | `JWT_SECRET` por defecto, `cors origin: true` en dev, falta de migraciones versionadas en CI, seed con `password123`. |

---

## 2. Arquitectura actual

### 2.1 Backend (NestJS)

```
src/
├── main.ts                    bootstrap + helmet/compression + CORS + Swagger
├── app.module.ts              ConfigModule global + JwtAuthGuard global
├── prisma/
│   ├── prisma.module.ts       @Global(), expone PrismaService
│   └── prisma.service.ts      onModuleInit / onModuleDestroy + cleanDatabase
├── config/
│   └── app.config.ts          registerAs('app', …) — puerto, JWT, apiPrefix
├── common/
│   ├── decorators/            @Public, @Roles, @CurrentUser
│   ├── guards/                JwtAuthGuard (global) + RolesGuard
│   ├── filters/               (vacío)
│   ├── interceptors/          (vacío)
│   ├── pipes/                 (vacío)
│   └── utils/                 (vacío)
└── modules/
    ├── auth/                  AuthController + AuthService + JwtStrategy
    │   ├── dto/               Login, Register, Refresh, Update, AuthResponse
    │   └── strategies/        jwt.strategy.ts (passport-jwt)
    ├── tiendas/               CRUD básico + filtros geográficos
    ├── catalogo/              Catálogo público + verificarStock
    ├── pedidos/               5 controllers segmentados por rol + service único
    ├── usuarios/              (vacío)
    ├── stock/                 (vacío)
    └── reportes/              (vacío)
```

**Patrones clave detectados**
- **Guards globales** (`APP_GUARD: JwtAuthGuard`) con opt-out vía `@Public()`.
- **Controllers segregados por rol** para `pedidos` (cliente, bodega, cajero, mostrador, admin) que **comparten el mismo `PedidosService`** — esto evita lógica duplicada pero mezcla los métodos de cada rol en un solo archivo de 775 líneas.
- **Transacciones Prisma** usadas en operaciones críticas (crear pedido, cambiar estado, entregar, cancelar). Buenas prácticas.
- **Reservas de stock** mediante `cantidadReservada` (suma al crear pedido, decrementa al entregar o cancelar).
- **Paginación** en catálogos y listados (no en endpoints de mostrador/bodega/cajero).
- **Validación** centralizada con `ValidationPipe` global (`whitelist + forbidNonWhitelisted + transform`).

### 2.2 Frontend (Next.js 16 App Router)

```
src/
├── app/                       App Router con grupos
│   ├── (auth)/login,registro
│   ├── (customer)/carrito,checkout,confirmacion,pedidos
│   ├── (warehouse)/bodega, pedidos/[id]
│   ├── (cashier)/cajero
│   ├── (counter)/mostrador
│   ├── admin/{productos,reportes,tiendas,usuarios}
│   ├── kiosko/{welcome,setup,scan}
│   ├── catalogo, producto/[id], perfil, configuracion, nosotros, unauthorized
│   └── layout.tsx (StoreGuard + Providers)
├── components/
│   ├── ui/                    shadcn/ui (button, card, sheet, sonner, etc.)
│   ├── common/                ErrorBoundary + helpers de normalización
│   ├── layout/                Providers (QueryClient, Toaster)
│   ├── premium/               Navbar, Footer, Hero, Carousel, ProductCard/QuickView, KioskQRCard, StoreLocationModal, UserMenu
│   └── product/ProductQuickView.tsx (duplicado de premium/)
├── lib/
│   ├── api/                   axios.ts + auth/catalogo/pedidos services
│   ├── hooks/                 13 archivos: useAuth, useCatalogo, useTiendas, usePedidos*
│   ├── services/              auth.service.ts (AuthService static class)
│   ├── stores/                auth (Zustand persistido), cart, kioskStore
│   ├── schemas/auth.ts        zod para login/register
│   ├── types/index.ts         User, Producto, Pedido, ApiError, helpers toNumber
│   └── utils.ts               cn() de shadcn
```

**Patrones clave detectados**
- **Cliente HTTP** centralizado en `lib/api/axios.ts` con:
  - Refresh-token queue **deduplicada** (`isRefreshing` + `failedQueue`).
  - Auto refresh **programado 2 min antes del expiry** vía `AuthService.scheduleTokenRefresh()`.
  - Transformación uniforme a `ApiError { statusCode, message, error }`.
- **Auth store con persistencia** (Zustand) + `BroadcastChannel` para sync entre pestañas.
- **Guards** en cliente vía `useProtectedRoute({ allowedRoles })` con `_hasHydrated` para evitar SSR flicker.
- **Kiosk mode** específico: `useKioskStore` + `useKioskInactivity` (timeout 2 min).
- **Datos mock** en admin: `admin/page.tsx`, `admin/reportes/page.tsx`, `admin/tiendas/page.tsx`, `admin/usuarios/page.tsx` muestran UI con valores hardcodeados.
- **Normalización de decimales**: `toNumber()` y `normalizeProducto()` aplicados en cliente porque los `Decimal` de Prisma se serializan como `string` en JSON.

### 2.3 Modelo de datos (Prisma)

| Entidad | Rol | Cardinalidades / claves |
|---|---|---|
| **Tienda** | Sucursal | 1—N con usuarios, pedidos, stocks, ProductoTienda, Precio, PrecioCO |
| **Usuario** | Cliente o empleado | opcional FK a tienda; soft-active (`activo`); rol enum |
| **Sesion** | Sesión persistida (no se usa) | modelo existe pero no consumido por código |
| **Producto** | Catálogo base | 1—N con ProductoTienda, Precio, PrecioCO, ItemPedido |
| **ProductoTienda** | Visibilidad por tienda | unique(productoId, tiendaId); soft-visible |
| **Corrida / Talla** | Jerarquía tallas | 1 corrida — N tallas |
| **Color** | Paleta | catálogo global |
| **Precio** | Precio por tienda | unique(productoId, tiendaId); vigencia opcional |
| **PrecioCO** | Precio por variante (corrida+talla+color) | **unique(productoId, tiendaId, corridaId, tallaId, colorId)**; SKU |
| **Stock** | Stock por variante | unique(precioCOId); `cantidad` + `cantidadReservada` |
| **Pedido** | Cabecera | snapshot del cliente; totales; 5 timestamps de flujo |
| **ItemPedido** | Línea de pedido | snapshot de nombres/códigos |
| **HistorialPedido** | Auditoría de cambios de estado | append-only |
| **LogActividad** | Auditoría general | JSON metadata, IP/UA |

**Observaciones**
- `Sesion` existe en el esquema pero no hay servicio que la escriba/lea. El JWT es **stateless** (sin revocación real).
- `descuento` e `impuestos` están en `Pedido` pero **siempre son 0** en el flujo actual.
- `comprobantePago`/`referenciaPago` se almacenan pero sólo como `String` (sin upload real).

---

## 3. Contrato HTTP — divergencias backend ↔ frontend

### 3.1 Endpoints en uso

| Frontend llama | Backend expone | Estado |
|---|---|---|
| `POST /auth/login` | `auth.controller.ts:28` | OK |
| `POST /auth/register` | `auth.controller.ts:20` | OK |
| `POST /auth/refresh` | `auth.controller.ts:36` | OK — backend devuelve `accessToken`+`refreshToken`+`user`; el frontend sólo lee `accessToken` y reutiliza el `refreshToken` que ya tenía en el store (no se actualiza en `updateAccessToken`). No es bug hoy porque el backend re-emite ambos con la misma identidad, pero el `refreshToken` queda "viejo" en el store. |
| `POST /auth/logout` | `auth.controller.ts:43` | OK — no-op server-side |
| `GET /auth/me` | `auth.controller.ts:55` | OK |
| `POST /auth/update-profile` | `auth.controller.ts:63` | OK |
| `POST /auth/change-password` | `auth.controller.ts:74` | OK |
| `GET /auth/kiosk-token` | `auth.controller.ts:85` | OK |
| `POST /auth/kiosk-login` | `auth.controller.ts:93` | OK |
| `GET /tiendas` | `tiendas.controller.ts:18` | OK |
| `GET /tiendas/:id` | `tiendas.controller.ts:45` | OK |
| `GET /tiendas/estados` | `tiendas.controller.ts:31` | OK |
| `GET /tiendas/ciudades?estado=` | `tiendas.controller.ts:38` | OK |
| `GET /catalogo?tiendaId=…` | `catalogo.controller.ts:13` | OK |
| `GET /catalogo/tienda/:tiendaId/producto/:id` | `catalogo.controller.ts:21` | OK |
| `GET /catalogo/filtros/:tiendaId` | `catalogo.controller.ts:31` | **Drift de shape** (ver 3.1.a) |
| `POST /catalogo/verificar-stock` | `catalogo.controller.ts:38` | OK |
| `POST /pedidos/cliente` | `pedidos-cliente.controller.ts:20` | OK |
| `GET /pedidos/cliente/mis-pedidos` | `pedidos-cliente.controller.ts:30` | OK |
| `GET /pedidos/cliente/:id` | `pedidos-cliente.controller.ts:46` | OK |
| `POST /pedidos/cliente/:id/cancelar` | `pedidos-cliente.controller.ts:55` | OK |
| `GET /pedidos/bodega/pendientes` | `pedidos-bodega.controller.ts:20` | OK |
| `GET /pedidos/bodega/:id` | `pedidos-bodega.controller.ts:69` | OK |
| `GET /pedidos/bodega/:id/verificar-stock` | `pedidos-bodega.controller.ts:32` | OK |
| `POST /pedidos/bodega/:id/en-bodega` | `pedidos-bodega.controller.ts:41` | OK |
| `POST /pedidos/bodega/:id/listo` | `pedidos-bodega.controller.ts:50` | OK |
| `POST /pedidos/bodega/:id/notas` | `pedidos-bodega.controller.ts:59` | **Drift de campo** (ver 3.1.b) |
| `GET /pedidos/cajero/pendientes-pago` | `pedidos-cajero.controller.ts:20` | OK |
| `POST /pedidos/cajero/:id/verificar-pago` | `pedidos-cajero.controller.ts:32` | OK |
| `POST /pedidos/cajero/:id/marcar-pago` | `pedidos-cajero.controller.ts:42` | OK |
| `GET /pedidos/mostrador/listos` | `pedidos-mostrador.controller.ts:19` | OK |
| `GET /pedidos/mostrador/buscar?numero=` | `pedidos-mostrador.controller.ts:31` | OK |
| `POST /pedidos/mostrador/:id/entregar` | `pedidos-mostrador.controller.ts:39` | OK |
| `GET /pedidos/admin?…` | `pedidos-admin.controller.ts:17` | **Drift de query params** (ver 3.1.c) |
| `GET /pedidos/admin/:id` | `pedidos-admin.controller.ts:41` | OK |
| `GET /pedidos/admin/:id/historial` | `pedidos-admin.controller.ts:47` | **Drift de shape** (ver 3.1.d) — y, además, **no hay consumidor en el frontend** (`getHistorial` está declarado en `lib/api/pedidos.ts:126` pero ningún componente lo llama) |

#### 3.1.a Drift en `GET /catalogo/filtros/:tiendaId`

- **Backend** (`catalogo.service.ts:220-224`) devuelve literalmente:
  ```ts
  { categorias: string[], corridas: Corrida[] (con .tallas incluidas), colores: Color[] }
  ```
- **Frontend** (`lib/api/catalogo.ts:57-64`) declara y consume:
  ```ts
  { tallas: string[], colores: { nombre, hex }[], categorias: string[] }
  ```
- **Consecuencia real**: `useFiltrosCatalogo` está exportado en `lib/hooks/useCatalogo.ts:22-28` pero **no es usado por ninguna página** (verificado con grep: 0 consumidores). Por eso la página `catalogo/page.tsx:56` define su propio array `const TALLAS = ['XS', 'S', 'M', 'L', 'XL', 'XXL']` y los colores se cargan desde otra ruta — el bug está latente, no explotado. Cuando alguien conecte `useFiltrosCatalogo` obtendrá `undefined` para `tallas` porque la respuesta sólo trae `corridas[].tallas[]`.

#### 3.1.b Drift en `POST /pedidos/bodega/:id/notas`

- **Backend** (`pedidos-bodega.controller.ts:65`) lee `dto.notasBodega` del `UpdatePedidoDto`:
  ```ts
  await this.pedidosService.actualizarNotasBodega(id, dto.notasBodega || '', user);
  ```
  `UpdatePedidoDto` declara `notas?: string` y `notasBodega?: string` (`update-pedido.dto.ts`).
- **Frontend** (`lib/api/pedidos.ts:64-66`) envía:
  ```ts
  await api.post(`/pedidos/bodega/${id}/notas`, { notas });
  ```
- **Consecuencia real**: con `forbidNonWhitelisted: true` en el `ValidationPipe` global (`main.ts:33-37`), el body `{ notas: '…' }` se filtra y `dto.notasBodega` queda `undefined` → la línea 65 cae a `''` → la nota nunca se guarda y el cliente recibe 201. **Bug silencioso en producción.**

#### 3.1.c Drift en `GET /pedidos/admin`

- **Backend** (`pedidos-admin.controller.ts:24-30` + `pedidos.service.ts:577-631`): acepta y aplica
  `tiendaId`, `estado`, `estadoPago`, `pagina`, `limite`. **No conoce** `fechaInicio` ni `fechaFin`.
- **Frontend** (`lib/api/pedidos.ts:107-119`): envía `fechaInicio`, `fechaFin`, `estado`.
- **Consecuencia real**: `fechaInicio`/`fechaFin` se mandan como query string, el backend los ignora silenciosamente, `ValidationPipe` los descarta. El listado que ve el admin **no filtra por rango de fechas**, aunque la UI lo sugiera. `pedidosAdminApi` **no es consumido por ninguna página** (verificado: el dashboard `admin/page.tsx` usa datos hardcodeados), por lo que hoy no se nota.

#### 3.1.d Drift en `GET /pedidos/admin/:id/historial`

- **Backend** (`pedidos.service.ts:655-662`): devuelve `prisma.historialPedido.findMany({...})` crudo, es decir:
  ```ts
  { id, pedidoId, estadoAnterior, estadoNuevo, observacion, usuarioId, usuarioNombre, createdAt }[]
  ```
- **Frontend** (`lib/api/pedidos.ts:126-131`): declara
  ```ts
  Promise<{ fecha: string; estado: string; usuario: string; comentario?: string }[]>
  ```
- **Consecuencia real**: si algún día se consume, el `map` consumidor verá `undefined` en `fecha`, `estado`, `usuario`, `comentario`. No hay consumidor hoy (verificado con grep).

### 3.2 Headers / convenciones

| Concern | Backend | Frontend | Estado |
|---|---|---|---|
| Prefijo API | `.env` dice `/api`, código default `/api/v1` | `NEXT_PUBLIC_API_URL=http://localhost:3000/api` | **Inconsistencia**: `.env` está pisando el default; Swagger en `/api/docs` (sin v1). Documentación menciona `/api/v1` pero la app real va a `/api`. |
| CORS dev | `origin: true` | n/a | OK |
| CORS prod | `['https://demo-frontend-pi.vercel.app']` | n/a | OK si deploy es Vercel |
| `X-Tienda-Id` | requerido para clientes en `jwt-auth.guard.ts:35-37` | lo envía en `axios.ts:56` desde `useAuthStore.selectedTiendaId` | OK |
| Decimales | `Decimal(10,2)` serializa como string | normaliza con `toNumber()` | OK |
| `expiresIn` | backend hardcodea `3600` en `auth.service.ts:230` | usado para programar refresh | Aceptable; bug latente si se cambia `JWT_EXPIRES_IN` |

### 3.3 Enums con drift

```ts
// Frontend lib/types/index.ts:74
export type TipoPago = 'EFECTIVO' | 'TRANSFERENCIA';
// Backend prisma/schema.prisma:28-33
enum TipoPago { EFECTIVO, TRANSFERENCIA, DEPOSITO, TARJETA }
```
Faltan `DEPOSITO` y `TARJETA` en el tipo del frontend. Si en el futuro el backend expone esos valores, el tipado en cliente fallará silenciosamente.

---

## 4. Reglas de negocio críticas (extractadas del código)

1. **Creación de pedido** (`pedidos.service.ts:16-143`)
   - Requiere `usuario.tiendaId`; valida tienda activa.
   - Verifica que cada `precioCOId` pertenezca a la tienda.
   - Verifica stock `cantidad - cantidadReservada >= cantidad` por cada item.
   - **Transacción atómica**: crea pedido, items, historial inicial, e incrementa `cantidadReservada` por cada item.
   - `clienteEmail` se inicializa como string vacío (no se completa del usuario).

2. **Transiciones de estado permitidas** (`pedidos.service.ts:707-713`)
   ```
   PENDIENTE       → EN_BODEGA, CANCELADO
   EN_BODEGA       → LISTO_PARA_ENTREGA, CANCELADO
   LISTO_PARA_ENTREGA → ENTREGADO
   ENTREGADO       → (terminal)
   CANCELADO       → (terminal)
   ```
   Reglas adicionales:
   - Pasar a `LISTO_PARA_ENTREGA` exige `estadoPago === VERIFICADO` o `tipoPago === EFECTIVO` (línea 331).
   - `CANCELADO` libera la reserva (decrementa `cantidadReservada`).
   - `ENTREGADO` decrementa `cantidad` y `cantidadReservada` (doble decremento correcto).

3. **Pago en efectivo** (`marcarPagadoEnTienda`, líneas 420-468)
   - Sólo aplica a `tipoPago === EFECTIVO`.
   - Verifica el pago y, si el pedido está en `EN_BODEGA`, lo avanza a `LISTO_PARA_ENTREGA` en la misma transacción.

4. **Kiosko / QR Login** (`auth.service.ts:128-211`)
   - Genera JWT de 5 min con `type: 'kiosk-login'`.
   - El kiosko escanea el QR, llama `POST /auth/kiosk-login` y recibe tokens completos.
   - No hay **revocación** del QR (cualquier persona con el token puede usarlo en 5 min).

5. **Header `X-Tienda-Id`** (`jwt-auth.guard.ts:31-43`)
   - Si el usuario es `CLIENTE` y no tiene `tiendaId` en token ni header, se rechaza con 401.
   - Si el header está presente, se inyecta a `user.tiendaId` para esa request.

---

## 5. Seguridad: postura actual y brechas

| Vector | Estado actual | Riesgo | Recomendación |
|---|---|---|---|
| `JWT_SECRET` | fallback `'default-secret'` y valor débil en `.env` (`"secret-key"`) | Crítico en prod | Forzar `JWT_SECRET` en arranque; fail-fast si no existe en `NODE_ENV=production`. |
| Refresh token | stateless, no revocable | Sesiones "zombie" hasta 7 días | Implementar `Sesion` para revocación real (modelo ya existe). |
| Passwords | bcrypt cost 10 | Aceptable | Subir a 12-14 en prod; añadir validación de fortaleza. |
| CORS | `origin: true` en dev | OK | Mantener whitelist en prod. |
| Helmet / compression | activos | OK | Añadir `hpp`, `csurf` no aplica (stateless API). |
| Rate limiting | no configurado | Suplantación de login posible | `@nestjs/throttler` en `/auth/login`, `/auth/refresh`, `/auth/register`. |
| Validación entrada | global con `forbidNonWhitelisted` | OK | Asegurar DTOs en **todos** los endpoints (hay controllers con `@Body()` sin DTO, p.ej. `verificarStock`). |
| SQL injection | Prisma parametriza | OK | — |
| XSS | API JSON | Bajo | Asegurar que frontend escapa HTML en cualquier `dangerouslySetInnerHTML`. |
| Upload de archivos | `comprobantePago: String` (ruta) sin upload | No hay uploads reales | Si se requiere comprobante: módulo `Storage` (S3/local) + validación mime. |
| Datos sensibles en logs | `logger.log` con emails y #pedido | Bajo (sin password ni token) | Redactar emails en prod si llegan a centralizar logs. |
| `enableImplicitConversion` | activo en `ValidationPipe` | Bajo | Verificar que ningún DTO convierte `string → number` cuando viene `null`/`undefined`. |

---

## 6. Entidades y áreas funcionales impactadas

Cualquier cambio debe evaluar el efecto en este mapa:

```
                       ┌──────────────┐
                       │  Tienda      │  ← precios, stock, productosTienda, usuarios, pedidos
                       └──────┬───────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   Producto              Corrida                Color
        │                     │                     │
        ├── ProductoTienda    └── Talla             └── (catalogo global)
        ├── Precio
        └── PrecioCO ────► Stock (1:1)
                ▲
                │ usado en
                │
   Pedido ──► ItemPedido ─► PrecioCO
        │
        ├── HistorialPedido
        ├── LogActividad
        │
        └── Snapshots de cliente (clienteNombre/Email/Telefono)

   Usuario ──► Sesion (no usada) ──► refresh tokens
```

**Tabla de impacto por tipo de cambio**

| Tipo de cambio | Entidades tocadas | Módulos backend | Archivos frontend |
|---|---|---|---|
| Nuevo campo en `Producto` | Producto, ProductoTienda, Precio | catalogo | `lib/types`, `lib/api/catalogo`, `components/premium/ProductCard`, `ProductQuickView` |
| Nuevo campo en `Pedido` | Pedido, ItemPedido (snapshot) | pedidos (5 controllers) | `lib/types`, `lib/api/pedidos`, `app/(customer)/pedidos`, `app/(warehouse)/bodega`, `app/(cashier)/cajero`, `app/(counter)/mostrador` |
| Cambio en máquina de estados | Pedido, HistorialPedido, Stock | pedidos.service.ts | mismas pantallas que arriba + `usePedidos*` |
| Nuevo rol | Usuario, JwtPayload, ROLES | auth, common/guards | `useAuth`, `useProtectedRoute`, `lib/types`, `lib/hooks/useProtectedRoute` |
| Nuevo método de pago | Pedido, TipoPago enum, transición a LISTO | pedidos, schema | `lib/types`, checkout, cajero |
| Stock negativo por race condition | Stock, PrecioCO | pedidos | checkout, carrito, catálogo |
| Upload de comprobante | `comprobantePago` | nuevo módulo storage | checkout, cajero |
| WebSockets pedidos | Pedido | gateway nuevo | admin/bodega/cajero dashboard en vivo |

---

## 7. Riesgos identificados

### 7.1 Riesgos críticos (afectan correctness / data)

1. **Race condition en stock**: el `crearPedido` lee `stock` fuera de la transacción y luego actualiza. Dos pedidos concurrentes pueden sobre-vender. La transacción aísla la escritura, pero la lectura del `cantidad - cantidadReservada` previa no se hace con `SELECT … FOR UPDATE`.
2. **Generación de `numeroPedido` no es atómica**: `generarNumeroPedido()` (`pedidos.service.ts:666`) hace `findFirst` + `parseInt` y luego crea. Dos inserciones concurrentes pueden generar el mismo `PD-2026-000001`, lo que rompe el `@unique` y causa 500.
3. **Cancelación parcial**: si un pedido tiene 3 items y sólo 1 debe liberarse, no se puede cancelar parcialmente. El modelo no soporta cancelaciones granulares.
4. **Borrado en cascada de PrecioCO** rompe `ItemPedido` (no hay `onDelete: Restrict`): eliminar un PrecioCO borraría líneas históricas. El snapshot de `ItemPedido` debería proteger, pero el campo `precioCOId` apunta a la variante viva.
5. **`descuento` e `impuestos` no se calculan** en ningún flujo. Los campos existen en BD y frontend pero siempre son 0. La UI los muestra, dando sensación de funcionalidad incompleta.

### 7.2 Riesgos altos (afectan operación)

6. **Sin migraciones versionadas en CI**: el repo tiene `prisma/migrations/` pero no hay workflow que ejecute `migrate deploy`. Riesgo de drift entre entornos.
7. **Seed destructivo**: `prisma/seed.ts:57-93` hace `deleteMany` de **todas** las tablas y reinicia secuencias. Si se ejecuta en prod por accidente, pérdida total de datos.
8. **Decimales serializados como string**: Prisma serializa `Decimal(10,2)` como string en JSON. La normalización en el frontend está **dispersa y duplicada**:
   - `lib/api/catalogo.ts:40-44` parsea `precioBase`/`precioOferta` en `getProductos`.
   - `lib/api/catalogo.ts:51-53` vuelve a parsearlos en `getProducto`.
   - `components/common/ErrorBoundary.tsx` exporta `normalizeProducto` y `normalizePedido` (con `toNumber` de `lib/types`).
   - `catalogo/page.tsx:134` aplica `normalizeProducto` adicionalmente.
   - `ProductCard.tsx:28-32,171` y `premium/ProductQuickView.tsx:182,301` hacen `Number(...)` ad-hoc en cada render.
   - `useMisPedidos` (consumido por `perfil/page.tsx:21` y `(customer)/pedidos/page.tsx:147`) **no normaliza** — ambos consumidores hacen `Number(p.total)` a mano. `normalizePedido` está exportado pero **nadie lo llama** (verificado con grep).
   - **Riesgo**: si Prisma cambia la serialización (p.ej. a número nativo) o se añade un nuevo consumidor que olvide la normalización, aparecen `$NaN`, comparaciones rotas o `toFixed` lanzando.
9. **CORS prod con URL hardcodeada** en `main.ts:19-22`. Cambiar de dominio requiere redeploy.
10. **`AuthService.refreshAccessToken`** en cliente: si dos tabs refrescan a la vez, la segunda llama se hace a `useAuthStore.getState()` **antes** de que la primera actualice el store. El `refreshPromise` dedup mitiga parcialmente, pero la cola en `axios.ts` puede regenerar el token múltiples veces si la promesa se rechaza y luego se reintenta.

### 7.3 Riesgos medios (afectan mantenibilidad)

11. **`pedidos.service.ts` monolítico (775 líneas)**: concentra lógica de 5 roles. Cualquier refactor toca todo.
12. **DTO `verificarStock` ausente**: `catalogo.controller.ts:41` recibe `@Body() items: { precioCOId, cantidad }[]` sin `@ValidateNested`. Risco de payloads malformados.
13. **Drift en `catalogo/filtros/:tiendaId`**: backend devuelve `{ categorias, corridas, colores }` con `corridas[].tallas[]`; frontend espera `{ tallas: string[], colores, categorias }`. La página de catálogo implementa su propio array `TALLAS` hardcodeado (`catalogo/page.tsx:56`).
14. **Filtros admin por fecha no implementados**: el cliente envía `fechaInicio/fechaFin` pero el backend los ignora silenciosamente.
15. **Mocks en admin**: `admin/page.tsx`, `admin/reportes/page.tsx` y los sub-paths `productos/tiendas/usuarios` usan datos hardcodeados. Impresión de "terminado" sin estarlo.
16. **`Sesion` declarada pero no usada**: ruido en el modelo.
17. **`prisma.service.ts:18-41 cleanDatabase`** sin protección más allá de `NODE_ENV`. Un test suite accidental con `NODE_ENV=test` podría borrar la BD.

### 7.4 Riesgos UX/operativos

18. **Kiosk inactivity 2 min** puede ser demasiado corto para personas con discapacidad o con carrito lleno.
19. **Logout sólo limpia cliente**; el backend no puede invalidar el JWT, así que el token sigue siendo válido durante 1 h (access) o 7 d (refresh).
20. **El `logout` del backend es no-op** (`auth.service.ts:109-112`): sólo loguea y devuelve un mensaje. No elimina nada en BD.

---

## 8. Plan de implementación sugerido (estratégico, no de código)

> **Fases sugeridas, no calendario**. Cada fase debe cerrar con tests + revisión + commit + verificación manual en el flujo tocado.

### Fase 0 — Higiene y observabilidad (1-2 días)
- Reemplazar `console.log` por `Logger` contextual en servicios.
- Crear `HttpExceptionFilter` global (mapea errores a `{ statusCode, message, error }` igual que el frontend espera).
- Forzar `JWT_SECRET` en arranque; valor por defecto sólo en dev.
- Endurecer `.env` con `.env.example` y **mover secretos reales a un vault**.
- Definir `API_PREFIX` canónico: decisión entre `/api` o `/api/v1`. Actualizar `.env`, `main.ts`, frontend y Swagger en consecuencia.

### Fase 1 — Consistencia de tipos y DTOs (2-3 días)
- Crear DTOs faltantes: `VerificarStockDto`, `NotasBodegaDto`, `FiltrosAdminPedidoDto`.
- Alinear `TipoPago` en el frontend con el enum del backend (añadir `DEPOSITO`, `TARJETA`).
- Alinear shape de `catalogo/filtros/:tiendaId` (decidir entre aplanar `tallas` o ajustar el frontend).
- Alinear shape de `pedidos/admin/:id/historial` y `pedidos/admin` (decidir si backend emite shape frontend o viceversa).
- Alinear la creación de `ClienteEmail` en `crearPedido` (tomarlo del `usuario.email`).
- Generar tipos automáticamente desde OpenAPI (opcional pero reduce drift a largo plazo: `openapi-typescript`).

### Fase 2 — Concurrencia y consistencia de stock (3-4 días)
- Convertir la generación de `numeroPedido` a secuencia PostgreSQL (`SELECT nextval('pedido_numero_seq')`) o usar `cuid` + índice único.
- Envolver `crearPedido` en una transacción con `SELECT … FOR UPDATE` sobre los `stock` afectados, o usar `updateMany` con guardas (`where: { id, cantidad: { gte: 0 } }`).
- Añadir test E2E que cree N pedidos concurrentes para el mismo `precioCOId` y verifique que no se sobre-vende.

### Fase 3 — Endurecimiento de seguridad (2-3 días)
- `Sesion` real: persistir `refreshToken` hasheado en `Sesion`, marcar `revokedAt`, validar en `refreshToken` service.
- `bcrypt` cost a 12 (re-seed si se hace).
- `@nestjs/throttler` en `/auth/*` y en endpoints públicos de catálogo.
- Mover validación de tienda al decorator `@CurrentTienda()` y eliminar el side-effect en `jwt-auth.guard.ts:39-42`.

### Fase 4 — Reportes y admin (3-5 días)
- Implementar módulo `reportes`: agregaciones SQL (`group by` por día/mes, top productos, ventas por tienda).
- Implementar CRUD de `usuarios` para admin (actualmente vacío).
- Implementar gestión de `stock` (módulo hoy vacío): ajustes manuales, historial de movimientos.
- Reemplazar mocks en `admin/*` y `(customer)/pedidos` por datos reales.

### Fase 5 — Pagos y uploads (3-5 días)
- Endpoint de upload de `comprobantePago` (S3 o disco local con validación mime y tamaño).
- Integración con proveedor de pagos (Stripe, Mercado Pago) o, mínimo, marcado manual con flujo ya implementado.
- Cálculo real de `descuento` (cupones) e `impuestos` (IVA configurable por tienda).

### Fase 6 — Tiempo real y notificaciones (2-3 días)
- WebSocket gateway para notificar a bodega/cajero/mostrador de cambios en pedidos.
- Emails transaccionales (compra, pago verificado, pedido listo).

### Fase 7 — PWA, offline y calidad (2-4 días)
- next-pwa está configurado pero `disable` en dev. Habilitar service worker en prod, estrategias para catálogo offline.
- IndexedDB para carrito y pedidos pendientes.
- Tests: `*.spec.ts` por servicio + e2e con `supertest` (ya disponible).

---

## 9. Decisiones que requieren tu input antes de codificar

1. **`API_PREFIX`**: ¿`/api` o `/api/v1`? El `.env` actual y la URL de Swagger sugieren `/api`, pero la documentación y el default del código dicen `/api/v1`.
2. **Cancelación parcial**: ¿el modelo de negocio lo permite? Si sí, hay que cambiar `ItemPedido` y la lógica de `cambiarEstado`.
3. **Stock negativo**: ¿queremos bloquear la venta al llegar a 0 (actual) o permitir reserva con espera?
4. **Kiosk QR**: ¿el token debe ser de un solo uso o por tiempo (5 min) sigue bien? ¿Debe estar atado a la tienda del cliente?
5. **Reportes**: ¿qué KPIs son obligatorios para V1? (ventas por día/semana/mes, top productos, ticket promedio, conversión por tienda).
6. **Pagos**: ¿se mantiene el flujo manual (cajero verifica) o se conecta con un proveedor?
7. **`Sesion` real**: ¿vale la pena el costo de persistir refresh tokens? (más código, más BD, más revocaci��n, más queries).
8. **Frontend admin**: ¿se mantiene Next.js para el back-office o se separa? La cantidad de dashboards pendientes sugiere que un admin dedicado puede ser más rápido.

---

## 10. Apéndice — Inventario rápido

### 10.1 Backend
- 1 app module, 4 módulos plenos, 3 placeholders.
- 12 controllers, 1 service monolítico de pedidos.
- 22 DTOs, 3 enums, 14 modelos Prisma, 3 migraciones en `prisma/migrations/`.
- `JWT_SECRET` débil; `DATABASE_URL` apunta a localhost (Postgres) y existe una conexión a Upstash Redis (`REDIS_URL`) que **no se está usando** en el código (sólo `ioredis` está en `package.json` como dependencia).

### 10.2 Frontend
- 1 layout raíz + 4 layouts de grupo (auth, customer, warehouse, cashier, counter, admin).
- 27 páginas / rutas.
- 5 stores Zustand (auth, cart, kiosk; y los hooks expuestos `useLocalStorage`, `useKioskInactivity`).
- 13 hooks custom.
- 22 componentes UI shadcn + 13 componentes "premium" + 3 comunes.
- PWA configurada (sólo en prod).
- Datos mock: `admin/page.tsx`, `admin/reportes/page.tsx`, `admin/productos/page.tsx`, `admin/tiendas/page.tsx`, `admin/usuarios/page.tsx`.

### 10.3 Configuración
- Backend `.env`: `API_PREFIX=/api` (inconsistente con el default del código y con la doc).
- Frontend `.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:3000/api`.
- CORS: abierto en dev, fijo a `https://demo-frontend-pi.vercel.app` en prod.
- `tsconfig` strict en backend; no inspeccionado a fondo en frontend (asumimos estándar Next).

---

**Fin del análisis.** No se escribió código de producto; este documento es la entrada para que tú decidas el alcance del próximo cambio y yo lo implemente alineado a estas observaciones.
