# Playerytees — Backend

NestJS 11 + Prisma 6 + PostgreSQL. API de la tienda de camisetas: catálogo,
pedidos con flujo bodega → mostrador → pago, kiosko de tablet y sincronización
con el ERP (Firebird).

El frontend vive en `../demo-frontend` y tiene su propio `CLAUDE.md`.

## Comandos

```bash
npm run start:dev        # Desarrollo con watch
npm run build            # prisma generate + nest build
npm run test             # Jest (30 suites, 300 tests)
npm run lint             # ESLint con --fix

npm run prisma:migrate   # Migraciones
npm run prisma:seed      # Seed (idempotente, preserva imágenes de S3)
npm run db:up / db:down  # PostgreSQL en Docker
```

**El `lint` usa `--fix`**: formatea al correr. Si vas a revisar un diff, córrelo
antes de empezar, no después.

## Estructura

```
src/
├── common/            # Guards, decoradores, interceptores (globales)
│   ├── guards/        # jwt-auth, roles, api-key
│   └── decorators/    # @Public, @Roles, @CurrentUser, @ApiKeyAuth
├── config/app.config.ts   # Toda la config desde env (sin fallbacks peligrosos)
├── modules/
│   ├── pedidos/       # El módulo grande: ver abajo
│   ├── mostrador/     # Consola de mostrador (acciones + consultas)
│   ├── kiosko/        # Tablet: pairing, heartbeat, aviso de llegada
│   ├── realtime/      # Socket.IO + outbox de eventos
│   ├── sync/          # Agente Firebird: upload, poll, ACK
│   └── …              # auth, catalogo, precios, imagenes, mail, …
└── prisma/            # PrismaService
```

### `modules/pedidos/` en detalle

```
pedidos/
├── core/              # Compartido por todas las consolas
│   ├── pedido-state.service.ts    # LA máquina de estados
│   ├── pedido-access.service.ts   # Quién puede ver/operar qué pedido
│   ├── item-pedido.util.ts        # Alta de ItemPedido con snapshot de precios
│   ├── aplicar-propuesta-ventas.util.ts
│   ├── totales.util.ts            # Recálculo de subtotal/total
│   ├── destino-post-surtido.util.ts
│   ├── llegada-aviso.util.ts      # ¿Se puede avisar llegada?
│   ├── escaneo.util.ts            # ¿Quién tiene el pedido ahora?
│   └── …                          # urgencia, similitud, zona, promo-volumen
├── bodega/  cajero/  cliente/  ventas/  admin/  propuesta/  reposicion/
└── messages/          # Chat del pedido (con adjuntos de propuesta)
```

## La máquina de estados

`core/pedido-state.service.ts` es la **fuente única** de transiciones. Declara
`TRANSICIONES` y aplica historial, realtime y notificación en un solo sitio.

```
PENDING_REVIEW → REVIEWING → EN_MOSTRADOR → PENDING_PAID → PAID → COMPLETED
                     │            │
                     │            ├─→ REVIEWING   (el cliente pidió cambios)
                     │            └─→ CANCELLED   (+ lista de reposición)
                     └─→ PENDING_PAID  (solo DOMICILIO: salta mostrador)
```

### Dos invariantes que sostienen el diseño

1. **El ERP solo ve pedidos liberados por mostrador.** El encolado a Firebird
   ocurre al pasar a `PENDING_PAID`, no al surtir. Así un ajuste o cancelación
   nunca deja al ERP desincronizado.
2. **`PENDING_PAID` ⟺ fila en `PedidoPendienteEnvio`.** Un pedido en ese estado
   sin fila es invisible al agente, nunca recibe folio y se queda atascado para
   siempre. La máquina lo **verifica**: `cambiarEstado` exige
   `encolarFirebird: true` (o una fila preexistente) al ir a `PENDING_PAID`.

### Reglas al tocar la máquina

- **Nunca escribas `estado` directo.** Usa `cambiarEstado`. Hay dos excepciones
  deliberadas y comentadas en el código:
  - `BodegaService.tomarGrupo`: toma un lote y necesita que la guarda TOCTOU
    (`asignadoAId: null` + estado en cola) y la escritura sean la misma
    sentencia. `cambiarEstado` resuelve un pedido a la vez.
  - `AdminService.marcarComoPagado`: el agente puede llegar desde **cualquier**
    estado no-terminal (el cobro ya ocurrió en VFP), que `TRANSICIONES` no modela.
- **Ir a `REVIEWING` exige `opts.asignacion` explícito** (`'caller'` si un
  bodeguero lo toma, `'limpiar'` si vuelve a la cola, `'mantener'`).
- **Los efectos externos se disparan DESPUÉS del commit.** `ejecutarCambio`
  devuelve los efectos y el caller los emite cuando la transacción confirmó:
  emitir dentro del callback manda el evento antes del commit, y un rollback
  posterior deja a los clientes con un aviso de algo que nunca pasó.
- **`opts.tx`** permite componer la transición dentro de una transacción del
  caller (lo usa `MessagesService.crearConAdjunto` para que la propuesta y el
  mensaje de chat sean atómicos).

## Vocabulario: "liberar" significa UNA cosa

**Devolver un pedido a la cola.** Nombraba tres acciones distintas:

| Consola | Acción | Nombre en código |
|---|---|---|
| Bodega | Suelta el pedido para que otro lo tome | `liberarPedido` |
| Cajero | Suelta de tu ventanilla, vuelve a la cola | `liberarPedidoCajero` |
| Mostrador | **NO devuelve: manda a pagar** | `enviarAPagar` |

En mostrador es `enviarAPagar` de punta a punta —servicio, ruta
`POST /pedidos/mostrador/:id/enviar-a-pagar`, DTO `EnviarAPagarDto`— para que el
código y la pantalla digan lo mismo.

## Acceso a pedidos

`core/pedido-access.service.ts` es la fuente única de "¿puede este usuario ver u
operar este pedido?". Reglas:

- **ADMIN** pasa sin validar tienda (es lo que usa el sistema/agente).
- **CLIENTE** solo su propio pedido (`usuarioId`).
- **Empleados** solo pedidos de su tienda, y la tienda sale **solo del JWT**
  (`user.tiendaId`), nunca del header `X-Tienda-Id` — confiar en el header
  permitiría IDOR cross-tienda.

Al añadir un endpoint que opere un pedido, usa `cargarYValidar`. No reimplementes
la regla: el gateway de realtime ya lo hizo una vez y le quedó más permisiva.

## Realtime

- Los servicios emiten a través de `RealtimeService` (`emitToTienda`,
  `emitToPedido`, `emitToUser`), nunca del gateway directo.
- Cada evento se persiste en `realtime_event_outbox` antes de emitirse; el
  worker re-emite los huérfanos tras una caída.
- **Los nombres de evento son strings sueltos** (no hay catálogo central). Si
  añades uno, revisa que el frontend lo escuche: un typo falla en silencio.
- El gateway valida acceso con su propio predicado; `CLIENTE` solo entra a su
  propio room.

## Convenciones

- **DTOs con class-validator** en todo endpoint con body. Sin DTO = sin
  validación.
- **Transacciones**: cualquier operación multi-tabla va en `$transaction`. Un
  `catch` que se traga un error **debe** comprobar `err.code` antes de asumir
  P2002 (el patrón correcto está en `cliente.service.ts`).
- **Excepciones**: `ForbiddenException` para permisos, `ConflictException` para
  carreras, `BadRequestException` para datos inválidos. No usar `BadRequest`
  donde corresponde `Forbidden`.
- **Comentarios**: explicar el *porqué*. Cuando se corrige un bug, dejar dicho
  qué pasaba antes — es lo que evita que vuelva.
- **Los comentarios y mensajes van en español**, igual que el resto del repo.

## Tests

30 suites, 300 tests, todos verdes. Cubren las invariantes del flujo completo
(`flujo-completo.spec.ts`), la máquina de estados
(`pedido-state.service.spec.ts`), el dinero (`invariantes-dinero.spec.ts`) y la
idempotencia de llegada.

**Antes de tocar la máquina de estados o el acceso, corre la suite.** Es la red
que evita que un cambio de transición rompa el encolado al ERP.
