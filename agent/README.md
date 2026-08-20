# playerytees-sync-agent

Servicio local (Windows / Linux) que sincroniza la BD Firebird central
(`DATOSINV.FDB`, sistema legacy Visual FoxPro) con el backend NestJS en
la nube de PlayeryTees.

## Requisitos

**En el servidor donde corre Firebird (donde va el agente):**
- Windows Server 2016+ (o Windows 10/11 para tu PC de pruebas).
- **Node.js 20 LTS** instalado y en `PATH` del sistema. Descarga:
  https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi (~35 MB).
  Marcar "Add to PATH" durante el install.
- **Firebird Client** (`fbclient.dll`) en `PATH` o `FIREBIRD_HOME`.
  Como el servidor ya corre el sistema VFP, esta DLL ya está ahí.
- Acceso de red a la BD Firebird (default `127.0.0.1:3050`).
- Acceso HTTPS al backend nube (`api.playerytees.com` o tu IP).

**No requiere:**
- No necesita `.exe` pre-compilado (lo genera `node-windows` al instalar).
- No necesita Visual Studio ni toolchain C++ en el servidor destino
  (los binarios nativos vienen pre-compilados para Node 20 + Win32-x64
  vía `prebuild-install`).

## Instalación rápida

### 1. Compilar

```bash
cd agent
pnpm install --prod
pnpm run build
```

Esto produce `dist/index.js`.

### 2. Configurar

Copiar `agent.config.example.json` → `agent.config.json` y rellenar:

```json
{
  "cloud": {
    "baseUrl": "https://api.playerytees.com",
    "agentKey": "<valor de AGENT_API_KEY en la nube>",
    "sucursalIds": [1, 2, 3],
    "timeoutMs": 30000
  },
  "firebird": {
    "host": "127.0.0.1",
    "port": 3050,
    "database": "C:\\Datos\\TIENDA.FDB",
    "user": "SYSDBA",
    "password": "<password>",
    "charset": "ISO8859_1",
    "poolSize": 4,
    "tiendaMap": {
      "1": 101,
      "2": 102,
      "3": 103
    }
  },
  "sync": {
    "pollIntervalMs": 5000,
    "backoffMinMs": 5000,
    "backoffMaxMs": 60000,
    "batchSize": 200,
    "queueRetentionDays": 7,
    "expirationHours": 24
  }
}
```

> `cloud.agentKey` debe coincidir con la variable `AGENT_API_KEY` del
> backend en la nube (`/Users/fernandoibarra/Documents/Development/Playerytees/demo-backend/.env.example`).
>
> `firebird.tiendaMap` mapea cada `Tienda.id` de la nube → `IDTIENDA` local
> en Firebird.

### 3. Probar manualmente

```bash
node dist/index.js
```

Debe loguear `firebird: pool listo` y `nube: heartbeat OK` en pocos
segundos. Ctrl+C lo apaga limpio.

### 4. Instalar como servicio Windows

Abrir **cmd como Administrador**:

```bash
cd agent
pnpm run install-service
```

Esto registra el servicio en `services.msc` con auto-arranque.

Para desinstalar:

```bash
pnpm run uninstall-service
```

### 5. Empaquetar para desplegar en otro servidor

```bash
pnpm run package
```

Produce `dist-bin/playerytees-sync-agent-v<version>-<fecha>.zip`
(~25 MB) con todo lo necesario: `dist/`, `node_modules/`,
`agent.config.example.json`, `install.bat`, `uninstall.bat`.

**Por qué NO usamos `.exe`** (decisión de arquitectura):
- Compilar Node 20 para Windows desde macOS requiere toolchain
  cross-compile (clang, headers, GNU make) y horas de compilación.
- En la práctica, `node-windows` ya genera un `wrapper.exe` nativo
  en el servidor Windows al instalar el servicio. Es el mismo
  resultado: un servicio nativo, auto-arranque, restart on crash.
- La dependencia extra (Node 20 LTS) son 35 MB y un `.msi` de 1 min.

**Requisito en el servidor Windows**: Node.js 20 LTS instalado y
en `PATH` del **sistema** (no solo del usuario actual). El instalador
MSI lo agrega automáticamente si marcas "Add to PATH".

## Estructura

```
agent/
├── src/
│   ├── index.ts             # entrypoint (loop principal)
│   ├── config.ts            # carga agent.config.json
│   ├── logger.ts            # pino
│   ├── firebird-client.ts   # pool de conexiones + transacciones
│   ├── cloud-client.ts      # HTTP a la nube con backoff
│   ├── checkpoint-store.ts  # SQLite local (checkpoint + outbox)
│   ├── tienda-resolver.ts   # deduce IDTIENDA por evento BANDEJA_SYNC
│   ├── up-processor.ts      # BANDEJA_SYNC -> nube
│   ├── down-processor.ts    # pedidos nube -> GRABAR_PEDIDOS
│   └── install/
│       ├── install-windows-service.ts    # node-windows install
│       └── uninstall-windows-service.ts  # node-windows uninstall
├── scripts/
│   └── package.js           # genera zip para despliegue
├── agent.config.example.json
├── package.json
├── tsconfig.json
└── README.md
```

## Cómo funciona

Ver `/Users/fernandoibarra/.claude/plans/idempotent-floating-ritchie.md`.

Resumen:

1. **Cada 5s** ejecuta un ciclo:
   - **UP**: lee `BANDEJA_SYNC WHERE ID > checkpoint` (top 200), arma
     eventos y los sube vía `POST /api/sync/agent/upload`.
   - **DOWN**: `GET /api/sync/agent/poll-pedidos`, baja cada pedido
     nuevo vía `GRABAR_PEDIDOS` + `GRABAR_MOVPED`, y confirma con
     `POST /api/sync/agent/pedidos-ack`.

2. **Resiliencia**:
   - Si la nube está caída, los uploads se encolan en SQLite local
     (outbox) y se reintentan con backoff.
   - Si Firebird está caído, el agente reintenta cada `backoffMinMs`
     sin tirar el servicio.
   - Si el agente crashea, al reiniciar carga el checkpoint de SQLite
     y reanuda desde donde quedó.

3. **Auditoría**: cada acción se loguea vía pino. Los errores van al
   EventLog de Windows (cuando corre como servicio). Los eventos
   importantes también quedan en `sync_event_log` en la nube.
