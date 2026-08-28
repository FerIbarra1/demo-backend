import { loadConfig, AgentConfig } from './config';
import { createLogger } from './logger';
import { FirebirdClient } from './firebird-client';
import { CloudClient } from './cloud-client';
import { LocalStore } from './checkpoint-store';
import { TiendaResolver } from './tienda-resolver';
import { UpProcessor } from './up-processor';
import { DownProcessor } from './down-processor';

/**
 * Entry point del agente.
 *
 * Diseño: dos loops independientes se ejecutan en serie en cada tick:
 *   - up-processor: BANDEJA_SYNC -> nube
 *   - down-processor: nube pedidos -> GRABAR_PEDIDOS Firebird
 *
 * Esto simplifica la lógica y hace el flujo determinista. Si el volumen
 * es muy alto se puede mover cada loop a un worker_threads o child
 * process, pero para >10 tiendas con miles de eventos/día el orden
 * secuencial es suficiente.
 *
 * Manejo de errores graves (AuthError, DB unreachable) → cierra el
 * servicio para que Windows lo reinicie (configurado en install/.
 */

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  log.info({ name: cfg.service.name }, 'agente arrancando');

  const firebird = new FirebirdClient(cfg.firebird);
  const cloud = new CloudClient(cfg.cloud, log);
  const store = new LocalStore(cfg);
  const tiendaResolver = new TiendaResolver(firebird);
  const up = new UpProcessor(cfg, firebird, cloud, store, tiendaResolver, log);
  const down = new DownProcessor(cfg, firebird, cloud, store, log);

  // Init Firebird pool.
  try {
    await firebird.init();
    log.info({ pool: cfg.firebird.poolSize }, 'firebird: pool listo');
  } catch (err) {
    log.fatal({ err: (err as Error).message }, 'firebird: no se pudo conectar — abortando');
    process.exit(1);
  }

  // Validar conectividad con la nube (1 heartbeat) con la primera tienda
  // activa de Firebird.
  try {
    const rows = await firebird.query<{ IDTIENDA: number }>(
      `SELECT FIRST 1 IDTIENDA FROM TIENDAS WHERE ACTIVO = 'S' ORDER BY IDTIENDA`,
    );
    const tiendaId = rows[0]?.IDTIENDA;
    if (tiendaId == null) {
      log.warn({}, 'no hay tiendas activas en Firebird — heartbeat inicial omitido');
    } else {
      await cloud.heartbeat(tiendaId, '1.0.0', process.env.COMPUTERNAME);
      log.info({ tiendaId }, 'nube: heartbeat OK');
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'nube: heartbeat fallo inicial, continuamos');
  }

  // Loop principal.
  let lastPurge = 0;
  let running = true;
  const shutdown = async () => {
    log.info({}, 'apagando agente');
    running = false;
    await firebird.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (running) {
    try {
      const { procesados } = await up.runOnce();
      const { descargados, errores } = await down.runOnce();
      if (procesados > 0 || descargados > 0 || errores > 0) {
        log.info({ procesados, descargados, errores }, 'ciclo completo');
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'ciclo con error');
      if ((err as any).name === 'AuthError') {
        log.fatal({}, 'auth rejected — abortando servicio');
        await firebird.close();
        store.close();
        process.exit(2);
      }
    }

    // Housekeeping diario.
    if (Date.now() - lastPurge > 24 * 60 * 60 * 1000) {
      try {
        const purged = store.purgeOldOutbox(cfg.sync.queueRetentionDays);
        if (purged > 0) log.info({ purged }, 'housekeeping: outbox purgados');
        lastPurge = Date.now();
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'housekeeping fallo');
      }
    }

    await new Promise((r) => setTimeout(r, cfg.sync.pollIntervalMs));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', err);
  process.exit(1);
});
