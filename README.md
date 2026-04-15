# Tienda de Camisetas - Backend

Backend completo para tienda de camisetas con gestión de pedidos, stock multi-tienda y flujo de trabajo por roles.

## Tecnologías

- **NestJS 11** - Framework Node.js
- **Prisma 7** - ORM para base de datos
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
│   └── pedidos/        # Gestión de pedidos (5 roles)
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
- **API**: http://localhost:3000/api/v1
- **Documentación**: http://localhost:3000/api/docs

## Usuarios de Prueba

| Rol | Email | Contraseña |
|-----|-------|------------|
| Admin | admin@tienda.com | password123 |
| Bodega | bodega@tienda.com | password123 |
| Cajero | cajero@tienda.com | password123 |
| Mostrador | mostrador@tienda.com | password123 |
| Cliente | cliente@demo.com | password123 |

## Flujo de Pedidos

```
┌─────────────┐    ┌─────────────┐    ┌──────────────┐    ┌───────────┐
│  PENDIENTE  │───▶│ EN_BODEGA   │───▶│LISTO_ENTREGA │───▶│ ENTREGADO │
└─────────────┘    └─────────────┘    └──────────────┘    └───────────┘
      │
      │ (pago en tienda) ▲
      └──────────────────┘
```

### Estados y Roles

| Estado | Rol Responsable | Acción |
|--------|-----------------|--------|
| **PENDIENTE** | Cliente | Crea pedido |
| | Bodega | Recibe y verifica stock |
| **EN_BODEGA** | Bodega | Prepara y empaqueta |
| | Cajero | Verifica pago (transferencia) |
| **LISTO_PARA_ENTREGA** | Mostrador | Entrega a cliente |
| **ENTREGADO** | - | Pedido completado |

## Endpoints Principales

### Autenticación
- `POST /api/v1/auth/register` - Registrar usuario
- `POST /api/v1/auth/login` - Iniciar sesión
- `GET /api/v1/auth/me` - Perfil del usuario

### Catálogo (Público)
- `GET /api/v1/catalogo?tiendaId=1` - Ver productos
- `GET /api/v1/catalogo/tienda/1/producto/1` - Detalle producto
- `POST /api/v1/catalogo/verificar-stock` - Verificar disponibilidad

### Pedidos - Cliente
- `POST /api/v1/pedidos/cliente` - Crear pedido
- `GET /api/v1/pedidos/cliente/mis-pedidos` - Mis pedidos

### Pedidos - Bodega
- `GET /api/v1/pedidos/bodega/pendientes` - Ver pendientes
- `POST /api/v1/pedidos/bodega/:id/en-bodega` - Marcar recibido
- `POST /api/v1/pedidos/bodega/:id/listo` - Marcar listo

### Pedidos - Cajero
- `GET /api/v1/pedidos/cajero/pendientes-pago` - Ver pendientes
- `POST /api/v1/pedidos/cajero/:id/verificar-pago` - Verificar transferencia

### Pedidos - Mostrador
- `GET /api/v1/pedidos/mostrador/listos` - Ver listos
- `POST /api/v1/pedidos/mostrador/:id/entregar` - Entregar pedido

### Admin
- `GET /api/v1/pedidos/admin` - Todos los pedidos
- `GET /api/v1/pedidos/admin/:id/historial` - Historial de cambios

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
- **PrecioCO** - Precios específicos por talla/color (con SKU y stock)
- **Pedido** - Pedidos de clientes
- **ItemPedido** - Líneas de pedido
- **HistorialPedido** - Auditoría de cambios de estado

## Seguridad

- JWT con refresh tokens
- Guards por rol (CLIENTE, BODEGA, CAJERO, MOSTRADOR, ADMIN)
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
