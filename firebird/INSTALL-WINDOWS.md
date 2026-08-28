# Guía de instalación — Agente Firebird en Windows

> Documento de setup paso a paso para levantar el agente de sincronización
> en una PC Windows que tiene la BD Firebird local (DATOSINV.FDB).

## Requisitos previos

| Componente | Versión | Notas |
|---|---|---|
| Windows | 10/11 o Server 2019+ | 64-bit preferido |
| Node.js | 20 LTS o 22 LTS | https://nodejs.org/ |
| pnpm | 9.x o 10.x | `npm install -g pnpm` |
| Firebird Server | **3.0** o 4.0 | El script está escrito para FB 3.0+ usando `CREATE OR ALTER TRIGGER` (compatible desde FB 1.5) y `NEXT VALUE FOR` (compatible desde FB 2.0) |
| Acceso SYSDBA | requerido | Para isql y gbak |
| Red a la nube | saliente HTTPS 443 | El agente es cliente, no servidor |

---

## 1. Preparar el directorio del agente

```cmd
mkdir C:\Agentes\playerytees
cd C:\Agentes\playerytees
```

## 2. Compilar el agente desde el repo

Desde tu Mac/Linux (donde tienes el repo):

```bash
cd /Users/fernandoibarra/Documents/Development/Playerytees/demo-backend/agent
npm install
npm run build
```

Esto genera `dist/` con el código compilado. Empaquétalo:

```bash
# Mac/Linux
cd /Users/fernandoibarra/Documents/Development/Playerytees/demo-backend
tar -czf agente-playerytees.tar.gz agent/dist agent/package.json agent/agent.config.example.json agent/install
```

Copia `agente-playerytees.tar.gz` a la PC Windows (USB, SCP, red local).

## 3. Descomprimir en Windows

```cmd
cd C:\Agentes\playerytees
tar -xzf agente-playerytees.tar.gz
ren agent\dist\* .
move agent\package.json .
move agent\agent.config.example.json .
```

(O extraer manteniendo la estructura si prefieres.) El layout final:

```
C:\Agentes\playerytees\
├── index.js              # entry point compilado
├── config.js             # config compilado
├── firebird-client.js    # etc
├── ... (todos los .js)
├── package.json
├── agent.config.json     # a crear en paso 5
└── agent-data\           # se crea automáticamente al arrancar
```

## 4. Instalar dependencias de producción

```cmd
cd C:\Agentes\playerytees
npm install --production
```

> Si `node-firebird` falla al instalar, asegúrate de tener Visual Studio
> Build Tools (C++ compiler). En general `npm install` lo baja solo.

## 5. Crear el archivo `agent.config.json`

Copia `agent.config.example.json` y edítalo:

```cmd
copy agent.config.example.json agent.config.json
notepad agent.config.json
```

```json
{
  "cloud": {
    "baseUrl": "http://localhost:3000/api",
    "agentKey": "tu-clave-secreta-aqui",
    "sucursalIds": [],
    "timeoutMs": 30000
  },
  "firebird": {
    "host": "localhost",
    "port": 3050,
    "database": "C:\\Datos\\DATOSINV.FDB",
    "user": "SYSDBA",
    "password": "masterkey",
    "charset": "ISO8859_1",
    "poolSize": 4
  },
  "pedidos": {
    "vendedorId": 1,
    "usuarioId": 1,
    "lista": "1"
  },
  "sync": {
    "pollIntervalMs": 5000,
    "backoffMinMs": 5000,
    "backoffMaxMs": 60000,
    "batchSize": 200,
    "checkpointBatch": 100,
    "queueRetentionDays": 7,
    "expirationHours": 24,
    "logLevel": "info"
  },
  "service": {
    "name": "playerytees-agent-mxl",
    "description": "Agente Mexicali (MZL-001)"
  }
}
```

**Ajusta**:

- `cloud.baseUrl`: si tu backend corre en otra máquina, cámbialo.
- `cloud.agentKey`: copia el valor de `AGENT_API_KEY` que configuraste en `.env` del backend.
- `firebird.database`: ruta completa a tu FDB, con doble backslash en JSON.
- `firebird.user/password`: típicamente `SYSDBA` / `masterkey` (o el que uses).
- `firebird.charset`: `ISO8859_1` si tu BD es WIN1252/ISO8859_1, `UTF8` si es UTF-8.
- `pedidos.vendedorId` / `pedidos.usuarioId`: el ID de VENDEDOR y USUARIO que se asigna a cada pedido nuevo (GRABAR_PEDIDOS lo requiere). Pon un ID válido de las tablas VENDEDORES y USUARIOS de tu FDB.
- `pedidos.lista`: '1' a '6' según la lista de precios default para los pedidos que se descarguen.

## 6. Aplicar los triggers Firebird

### Backup primero

```cmd
"C:\Program Files\Firebird\Firebird_3_0\bin\gbak.exe" -b -user SYSDBA -password masterkey ^
  localhost:C:\Datos\DATOSINV.FDB ^
  C:\Backups\DATOSINV_YYYYMMDD_HHMMSS.fbk
```

(Sustituye `Firebird_3_0` por tu versión si es diferente, ej. `Firebird_4_0`.)

### Aplicar el script

```cmd
"C:\Program Files\Firebird\Firebird_3_0\bin\isql.exe" -user SYSDBA -password masterkey ^
  localhost:C:\Datos\DATOSINV.FDB ^
  -i "C:\Agentes\playerytees\sqls\02_sync_fixes_prefijo_folio.sql"
```

(Copia el archivo desde `demo-backend\firebird\02_sync_fixes_prefijo_folio.sql` del repo.)

**Compatibilidad verificada**: el script usa `CREATE OR ALTER TRIGGER` (disponible
desde Firebird 1.5) y `NEXT VALUE FOR` (disponible desde FB 2.0). Funciona en
FB 3.0 y FB 4.0 sin cambios.

El script es **idempotente**: lo puedes correr múltiples veces sin error. Si ya
existen los triggers (por una corrida previa), los reemplaza con la misma
definición. La columna PREFIJO solo se agrega si no existe.

Lo que agrega:
- Columna `TIENDAS.PREFIJO VARCHAR(5)` (auto-pobla con las primeras 3 letras del nombre).
- Trigger `TRG_TIENDAS_SYNC` (sincroniza creación/edición/desactivación de tiendas).
- Trigger `TRG_PEDIDOS_SYNC` (sincroniza cambios de estado en pedidos: pago, cancelación).
- Trigger `TRG_MOVPED_SYNC` (sincroniza ajustes del bodeguero en items de pedido).
- Trigger `TRG_USUARIOS_SYNC` (sincroniza empleados de tienda).

Los 14 triggers originales de tu FDB (CLIENTES, PRODUCTOS, PRECIOS, etc.) NO se tocan.

### Verificar

```cmd
"C:\Program Files\Firebird\Firebird_3_0\bin\isql.exe" -user SYSDBA -password masterkey ^
  localhost:C:\Datos\DATOSINV.FDB
```

En el prompt de isql:

```sql
SELECT TRIM(RDB$TRIGGER_NAME) FROM RDB$TRIGGERS
 WHERE RDB$TRIGGER_NAME LIKE 'TRG_%_SYNC'
 ORDER BY RDB$TRIGGER_NAME;
```

Deben aparecer 18 triggers:
CLIENTES, CLIENTESCXC, CLITIEN, CLITIENCXC, COLORES, CONFTIENDAS, CORRIDAS,
CORRIDASREN, LINEAS, MOVPED, PEDIDOS, PRECIOS, PRECIOSCO, PRODUCTOS, SUBLINEAS,
TIENDAS, USUARIOS, USUARIOSTIENDAS, VENDEDORES.

```sql
SELECT IDTIENDA, NOMBRE, PREFIJO FROM TIENDAS ORDER BY IDTIENDA;
```

Las tiendas activas deben tener un PREFIJO de 3 chars. Ajústalo manualmente
si el auto-fill basado en las primeras letras del nombre no es correcto:

```sql
UPDATE TIENDAS SET PREFIJO = 'MXL' WHERE IDTIENDA = 1;
UPDATE TIENDAS SET PREFIJO = 'HMO' WHERE IDTIENDA = 2;
-- etc.
```

Salir de isql con `QUIT;` o `EXIT;`.

## 7. Configurar el backend (Mac/Linux donde corre el Docker)

En `demo-backend/.env`:

```bash
AGENT_API_KEY=tu-clave-secreta-aqui   # mismo valor que en agent.config.json
DATABASE_URL=postgresql://tienda_user:tienda_password@localhost:5432/tienda_db?schema=public
```

Las tablas `sync_checkpoints` y `pedidos_pendientes_envio` ya están creadas
por las migraciones. No hay nada más que hacer del lado del backend.

## 8. Levantar backend + frontend (Mac/Linux)

Terminal 1 — backend:

```bash
cd /Users/fernandoibarra/Documents/Development/Playerytees/demo-backend
npm run start:dev
```

Espera a ver: `Nest application successfully started`. Swagger en
http://localhost:3000/api/docs.

Terminal 2 — frontend:

```bash
cd /Users/fernandoibarra/Documents/Development/Playerytees/demo-frontend
npm run dev
```

Frontend en http://localhost:3000 (o el puerto que indique Vite).

## 9. Arrancar el agente (Windows)

```cmd
cd C:\Agentes\playerytees
node index.js
```

Deberías ver logs como:

```
{"name":"playerytees-agent-mxl","level":"info","msg":"agente arrancando"}
{"pool":4,"level":"info","msg":"firebird: pool listo"}
{"tiendaId":1,"level":"info","msg":"nube: heartbeat OK"}
{"eventos":1234,"level":"info","msg":"up: bootstrap de catálogo completado"}
{"tiendaId":1,"hastaId":5678,"ok":200,"err":0,"level":"info","msg":"up: batch subido OK"}
```

Si ves errores de "Auth rejected" o "Connection refused":

- **Auth rejected**: el `agentKey` en `agent.config.json` no coincide con
  `AGENT_API_KEY` en `.env` del backend.
- **Connection refused**: el backend no está corriendo o el `baseUrl` está mal.

## 10. Instalar el agente como servicio de Windows (opcional pero recomendado)

El repo incluye scripts de instalación nativa:

```cmd
cd C:\Agentes\playerytees
# Como Administrador (click derecho → "Ejecutar como administrador")
install.bat
```

Este script usa `node-windows` para registrar el agente como servicio que:
- Arranca automáticamente al iniciar Windows.
- Se reinicia automáticamente si crashea.
- Escribe logs al Visor de Eventos de Windows.

Para desinstalar:

```cmd
uninstall.bat
```

Verificar el servicio:

```cmd
sc query playerytees-sync-agent
```

Arrancar/parar manualmente:

```cmd
sc start playerytees-sync-agent
sc stop playerytees-sync-agent
```

Si `install.bat` falla por dependencias, ejecutar primero:

```cmd
cd C:\Agentes\playerytees
npm install node-windows --save
install.bat
```

## 11. Verificación end-to-end

Después de todo arriba:

1. **Frontend**: ve a http://localhost:3000, crea una cuenta cliente o usa
   `seed@demo.com` / `password123` (depende de tu seed).

2. **Catálogo**: navega el catálogo. Debe mostrar productos con sus imágenes.

3. **Hacer un pedido**: agrega items al carrito, completa checkout.
   En la BD Postgres deberías ver el `Pedido` con `estado=PENDING_REVIEW`.
   En el log del agente verás un batch subiendo `BANDEJA_SYNC` events de TIENDAS
   (no del pedido todavía, porque el sync up es Firebird→nube).

4. **Sincronización down**: el agente debe hacer polling cada 5s y bajar
   el pedido a Firebird vía `GRABAR_PEDIDOS`. Verás:
   ```
   {"pedidoId":123,"tiendaId":1,"externalIdPEDIDOS":1000000123,"folio":"WEB-ABC123","items":2,"level":"info","msg":"down: pedido bajado a Firebird"}
   ```
   Y en la BD Firebird:
   ```sql
   SELECT IDPEDIDO, FOLIO FROM PEDIDOS ORDER BY IDPEDIDO DESC ROWS 5;
   ```
   Debe aparecer el IDPEDIDO devuelto (1000000123) y el FOLIO real que VFP asignó.

5. **Cambio en catálogo Firebird**: edita el nombre de un producto en VFP.
   El trigger `TRG_PRODUCTOS_SYNC` inserta en `BANDEJA_SYNC`. El agente
   lo sube. En 5-10s deberías ver el cambio reflejado en el catálogo web.

6. **Heartbeat**: el agente debe mandar heartbeats cada 5s. En el backend
   puedes consultar:
   ```sql
   SELECT tienda_id, ultimo_heartbeat_at, agent_version
     FROM sync_checkpoints
    ORDER BY tienda_id;
   ```

---

## Troubleshooting

| Problema | Causa probable | Solución |
|---|---|---|
| `Cannot find module 'better-sqlite3'` | No corriste `npm install` | `npm install --production` en el directorio del agente |
| `Error: PASSWORD` al conectar a Firebird | Password incorrecto | Verifica `firebird.password` en agent.config.json |
| `Error: String truncation` al escribir BANDEJA_SYNC | Algún campo del registro excede el límite | Edita el trigger correspondiente para usar SUBSTRING o VARCHAR más grande |
| `Auth rejected (401)` | API key incorrecta | Compara `cloud.agentKey` con `AGENT_API_KEY` del backend |
| `ECONNREFUSED 127.0.0.1:3000` | Backend no corriendo o URL mal | Verifica que el backend esté en `localhost:3000` y que `baseUrl` sea correcta |
| El agente arranca pero no procesa eventos | No hay tiendas activas en Firebird | Verifica `SELECT * FROM TIENDAS WHERE ACTIVO = 'S'` |
| `node-gyp` errors al instalar | Falta Visual Studio Build Tools | Instala VS Build Tools con C++ workload |

---

## Logs y monitoreo

- **Logs del agente**: `stdout` (el instalador como servicio los redirige a
  `C:\Agentes\playerytees\logs\agent.log`).
- **Logs del backend**: donde NestJS los imprima (consola por default).
- **Auditoría en BD**: tabla `sync_event_log` registra cada upload/ack/error.
- **Métricas básicas**: `SELECT tipo, exitoso, COUNT(*) FROM sync_event_log GROUP BY tipo, exitoso;`

---

## Próximos pasos después de validar

Cuando todo esté verde end-to-end:

1. Aplicar la **Opción C** (folio con prefijo) — ya documentada en el plan.
2. Agregar **tests** `*.spec.ts` para los handlers críticos.
3. Configurar **monitoreo**: Prometheus + Grafana o al menos alertas por
   `lastError` en `sync_checkpoints`.
4. Hardening de seguridad: rotación de X-Agent-Key, mTLS opcional, IP allowlist.
