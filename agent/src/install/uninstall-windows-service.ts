import { Service } from 'node-windows';

/**
 * Desinstala el servicio `playerytees-sync-agent` del SCM de Windows.
 *
 * Idéntico al install, pero llama `uninstall()` en lugar de `install()`.
 * También requiere cmd de administrador.
 *
 * Si el servicio no existe, node-windows emite un warning pero no
 * falla el script (exit 0). Útil para idempotencia en re-despliegues.
 */

if (process.platform !== 'win32') {
  // eslint-disable-next-line no-console
  console.error('ERROR: este desinstalador solo funciona en Windows.');
  process.exit(1);
}

const svc = new Service({
  name: 'playerytees-sync-agent',
  description: 'Sincronizacion bidireccional Firebird (DATOSINV.FDB) <-> PlayeryTees Cloud',
  script: process.env.AGENT_BIN ?? '',
});

svc.on('uninstall', () => {
  // eslint-disable-next-line no-console
  console.log('Servicio playerytees-sync-agent DESINSTALADO.');
});

svc.on('error', (err: any) => {
  // eslint-disable-next-line no-console
  console.error('Error desinstalando servicio:', err);
});

// `uninstall` detiene el servicio si está corriendo y luego lo
// elimina del SCM. Si no existe, emite 'error' con código
// "service does not exist" — lo ignoramos.
svc.uninstall();