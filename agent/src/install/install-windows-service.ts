import { Service } from 'node-windows';
import * as path from 'path';

/**
 * Instala el agente como servicio nativo de Windows.
 *
 * Cómo funciona node-windows:
 *   - Crea un `wrapper.exe` (binario C++ pequeño que envuelve node.exe)
 *     en el mismo directorio que el script.
 *   - Registra ese wrapper como servicio en el SCM (Service Control
 *     Manager) con `sc create`.
 *   - El servicio arranca con Windows, reinicia automáticamente si
 *     muere (configurable), y loguea a Windows Event Viewer.
 *
 * Requisitos:
 *   - Windows (este script aborta en otros OS).
 *   - Node 20 LTS instalado y en PATH del SYSTEM (no solo del usuario).
 *   - Ejecutar este script en un cmd **como Administrador**.
 *   - El path debe ser estable: si lo mueves, hay que re-instalar.
 *
 * Despliegue típico (ver agent/README.md):
 *   1. Copiar agent/dist/ + agent/node_modules/ + agent.config.json
 *      a C:\Servicios\playerytees-sync-agent\ en el servidor Firebird.
 *   2. cd C:\Servicios\playerytees-sync-agent
 *   3. node dist\install\install-windows-service.js
 *   4. Aparece en services.msc como "playerytees-sync-agent".
 *
 * Desinstalar: node dist\install\uninstall-windows-service.js
 */

if (process.platform !== 'win32') {
  // eslint-disable-next-line no-console
  console.error('ERROR: este instalador solo funciona en Windows.');
  console.error('En Linux usa systemd con scripts/agent.service.');
  process.exit(1);
}

// Path al entrypoint. Por defecto apunta al index.js compilado junto a
// este install/. Si lo moviste, exporta AGENT_BIN=/ruta/al/index.js.
const SCRIPT_PATH = process.env.AGENT_BIN
  ?? path.join(__dirname, '..', 'index.js');

const svc = new Service({
  name: 'playerytees-sync-agent',
  description: 'Sincronizacion bidireccional Firebird (DATOSINV.FDB) <-> PlayeryTees Cloud',
  script: SCRIPT_PATH,
  env: [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'SERVICE_MODE', value: '1' },
    // SERVICE_MODE=1 evita que pino use pretty output.
  ],
});

svc.on('install', () => {
  // eslint-disable-next-line no-console
  console.log('Servicio instalado. Iniciando...');
  svc.start();
});

svc.on('start', () => {
  // eslint-disable-next-line no-console
  console.log('Servicio playerytees-sync-agent INICIADO.');
});

svc.on('error', (err: any) => {
  // eslint-disable-next-line no-console
  console.error('Error instalando servicio:', err);
});

svc.install();
