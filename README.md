# Tienda de Camisetas - Backend

Backend de la tienda de camisetas: catálogo, pedidos con flujo bodega → mostrador → pago, kiosko de tablet y sincronización con el ERP local (Visual FoxPro + Firebird).

> **La referencia viva es [`CLAUDE.md`](./CLAUDE.md)** (estados, invariantes, reglas de la máquina de estados). Este README solo da lo mínimo para levantar el proyecto: el flujo y los endpoints cambiaban tan seguido que lo que se copiaba aquí quedaba obsoleto. Para los endpoints, la fuente es Swagger.

## Tecnologías

- **NestJS 11** - Framework Node.js
- **Prisma 6** - ORM para base de datos
- **PostgreSQL 18** - Base de datos
- **Redis 7** - Cache y sesiones
- **JWT** - Autenticación
- **Swagger** - Documentación API

## Estructura del Proyecto

```
src/
├── modules/
│   ├── auth/           # Autenticación JWT
│   ├── tiendas/        # Gestión de sucursales
│   ├── catalogo/       # Catálogo de productos
│   ├── pedidos/        # Gestión de pedidos (5 roles)
│   ├── usuarios/       # Empleados y clientes (panel ADMIN)
│   ├── imagenes/       # Imágenes de producto (S3 + fallback local)
│   ├── favoritos/      # Favoritos del cliente
│   ├── kiosko/         # Kioskos físicos de autoservicio
│   ├── mostrador/      # Ventas en mostrador
│   ├── ventanillas/    # Ventanillas de cajero
│   ├── notifications/  # Notificaciones y correos transaccionales
│   ├── mail/           # Plantillas de correo (React Email)
│   ├── realtime/       # WebSockets (Socket.IO)
│   └── sync/           # Sincronización con Firebird (agente externo)
├── common/
│   ├── decorators/     # Decoradores personalizados
│   ├── guards/         # Guards de auth y roles
│   └── ...
├── prisma/
│   ├── schema.prisma   # Modelo de datos
│   └── seed.ts         # Datos de prueba
└── docker-compose.yml  # PostgreSQL + Redis
```

## Inicio Rápido

### 1. Levantar Base de Datos

```bash
# Levantar PostgreSQL y Redis
docker-compose up -d

# Verificar que están corriendo
docker-compose ps
```

### 2. Instalar Dependencias

```bash
npm install
```

### 3. Configurar Variables de Entorno

```bash
# El archivo .env ya está configurado
# Verifica que DATABASE_URL apunte a localhost:5432
```

### 4. Migrar Base de Datos

```bash
# Generar cliente Prisma
npx prisma generate

# Crear migraciones
npx prisma migrate dev --name init

# Cargar datos de prueba
npx prisma db seed
```

### 5. Iniciar Servidor

```bash
# Desarrollo con hot-reload
npm run start:dev

# Producción
npm run build
npm run start:prod
```

El servidor estará disponible en:
- **API**: http://localhost:3000/api
- **Documentación**: http://localhost:3000/api/docs

## Usuarios de Prueba

| Rol | Email | Contraseña |
|-----|-------|------------|
| Admin | admin@puntotextil.com | 123456 |
| Bodega | bodega@puntotextil.com | 123456 |
| Cajero | cajero@puntotextil.com | 123456 |
| Mostrador | mostrador@puntotextil.com | 123456 |
| Ventas | ventas@puntotextil.com | 123456 |
| Tesorería | tesoreria@puntotextil.com | 123456 |
| Cliente | cliente@puntotextil.com | 123456 |

> Datos creados por `pnpm prisma:seed`. Actualiza el catálogo y los usuarios por su clave
> natural (no toca las imágenes de S3 ni el logo de los correos), pero **sí borra los datos
> transaccionales**: pedidos, kioskos y su rastro. Solo córrelo contra una base de datos local.

## Flujo de Pedidos

```
SOLICITADO → EN_REVISION → REVISADO → EN_ATENCION → PENDIENTE_PAGO → PAGADO → ENTREGADO
 (cliente)    (bodega)     (plancha)   (mostrador)       (caja)       (VFP)
```

El pedido pasa por **mostrador antes de pagar** y **entra al ERP (Firebird) al pasar a
`PENDIENTE_PAGO`**. El cobro se registra en VFP; el agente de sincronización lo sube y
solo entonces el pedido pasa a `PAGADO`. Domicilio: `PAGADO → ENVIADO → ENTREGADO`.

El detalle completo —las 3 invariantes, los destinos tras el surtido, el ciclo de ajuste y
las reglas para tocar la máquina de estados— está en [`CLAUDE.md`](./CLAUDE.md). La
sincronización con Firebird está en [`SINCRONIZACION-EXPLICACION.md`](./SINCRONIZACION-EXPLICACION.md).

### Roles

| Rol | Qué hace |
|-----|----------|
| `CLIENTE` | Crea y sigue sus pedidos; responde propuestas; avisa su llegada |
| `BODEGA` | Surte los pedidos (cierra el surtido en un solo paso) |
| `VENTAS` | Asesor: atiende los pedidos escalados y arma contrapropuestas |
| `MOSTRADOR` | Revisa con el cliente, ajusta, manda a pagar, cancela y entrega |
| `CAJERO` | Ventanilla **de una tienda**: atiende la cola de `PENDIENTE_PAGO`. **No cobra ni aprueba pagos**: el cobro es de VFP |
| `TESORERIA` | Multi-tienda (sin tienda asignada): verifica que las transferencias de todas las tiendas llegaron al banco. **No cobra ni marca pagado**: el cobro sigue siendo de VFP. Ver [`PLAN-PAGOS-TRANSFERENCIA.md`](./PLAN-PAGOS-TRANSFERENCIA.md) |
| `BODEGA_MONITOR` · `CAJERO_MONITOR` · `MOSTRADOR_MONITOR` | TV de pared, solo lectura |
| `ADMIN` | Gestión completa |

## Endpoints

La lista completa y actualizada está en Swagger: **http://localhost:3000/api/docs**.
Prefijos principales: `auth/`, `catalogo/`, `cliente/pedidos/`, `bodega/pedidos/`,
`ventas/pedidos/`, `pedidos/mostrador/`, `cajero/pedidos/`, `pedidos/consulta/`,
`admin/*`, `kiosko/`, `sync/agent/` (el agente de Firebird, con `X-Agent-Key`).

## Comandos Útiles

```bash
# Docker
docker-compose up -d      # Levantar servicios
docker-compose down       # Detener servicios
docker-compose logs -f    # Ver logs

# Prisma
npx prisma studio         # Interfaz visual de BD
npx prisma migrate dev    # Nueva migración
npx prisma db seed        # Recargar datos de prueba

# Desarrollo
npm run start:dev         # Modo desarrollo
npm run build             # Compilar
npm run test              # Ejecutar tests
```

## Modelo de Datos

### Entidades Principales

- **Tienda** - Sucursales de la tienda
- **Producto** - Productos base
- **Corrida** - Definiciones de tallas
- **Color** - Colores disponibles
- **PrecioCO** - Variante (talla/color/corrida) de un producto en una tienda, con su precio. El backend **no maneja inventario**: no hay modelo de stock
- **Pedido** - Pedidos de clientes
- **ItemPedido** - Líneas de pedido
- **HistorialPedido** - Auditoría de cambios de estado
- **PedidoPendienteEnvio** - Cola de pedidos hacia Firebird (la lee el agente)
- **PedidoPropuesta** / **PedidoMensaje** - Propuestas de ajuste y chat con el asesor

## Seguridad

- JWT con refresh tokens
- Guards por rol (ver la tabla de roles); ADMIN pasa siempre. Un endpoint sin `@Roles` queda abierto a cualquier rol autenticado: siempre declarar `@Roles` o `@Public`
- Validación de tienda en headers para clientes
- Protección contra inyección SQL (Prisma)
- Helmet para headers de seguridad

## Desarrollo

### Crear un Nuevo Módulo

```bash
nest generate module modules/nombre
nest generate service modules/nombre
nest generate controller modules/nombre
```

### Agregar un Campo a la BD

1. Editar `prisma/schema.prisma`
2. Ejecutar `npx prisma migrate dev --name nombre_cambio`
3. Ejecutar `npx prisma generate`

## Licencia

MIT
