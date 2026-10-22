import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ActividadWorkers } from '../../common/actividad-workers';
import { VentanillasService } from '../ventanillas/ventanillas.service';
import { MostradoresService } from '../mostradores/mostradores.service';
import { BodegaPresenciaService } from './bodega-presencia.service';

/**
 * Oct 2026: suelta las estaciones (ventanillas de caja y mostradores) cuyo operador lleva más de
 * 15 min sin señales de vida, y devuelve a la fila/cola a quien atendían. Con los bodegueros hace
 * lo mismo: quien lleva 15 min sin latido sale de la TV y sus pedidos regresan a la cola.
 *
 * Quien cierra la pestaña sin cerrar sesión (o se queda sin red) dejaba su estación "ocupada" para
 * siempre: la TV la mostraba abierta, nadie más podía tomarla y sus clientes seguían asignados a
 * alguien que ya no estaba. Mismo patrón que `SinRecogerWorker` (un `setInterval`, sin
 * `@nestjs/schedule`); el barrido es idempotente: cada liberación pasa por `liberar`, que no hace
 * nada si la estación ya no es de ese operador.
 */
@Injectable()
export class EstacionesWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EstacionesWorker.name);
  private timer?: NodeJS.Timeout;

  /** Cada cuánto se barre. El latido es cada 5 min y el plazo de inactividad, 15. */
  private static readonly TICK_MS = 5 * 60 * 1000;

  constructor(
    private readonly ventanillas: VentanillasService,
    private readonly mostradores: MostradoresService,
    private readonly bodegueros: BodegaPresenciaService,
    // N3: la pantalla de salud ve cuándo corrió por última vez. Opcional: sin él funciona igual.
    @Optional() private readonly actividad?: ActividadWorkers,
  ) {}

  onModuleInit() {
    this.actividad?.declarar('estaciones', EstacionesWorker.TICK_MS);
    this.timer = setInterval(() => void this.barrer(), EstacionesWorker.TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async barrer() {
    try {
      const v = await this.ventanillas.liberarInactivas();
      const m = await this.mostradores.liberarInactivos();
      const b = await this.bodegueros.salirInactivos();
      if (v + m + b > 0) {
        this.logger.log(
          `Sin actividad: ${v} ventanilla(s) y ${m} mostrador(es) liberados, ${b} bodeguero(s) fuera`,
        );
      }
      this.actividad?.corrio('estaciones');
    } catch (err) {
      this.logger.error(`Barrido de estaciones falló: ${(err as Error).message}`);
      this.actividad?.fallo('estaciones', (err as Error).message);
    }
  }
}
