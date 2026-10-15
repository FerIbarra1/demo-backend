import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SinRecogerService } from './sin-recoger.service';

/**
 * F22 (oct 2026): corre el barrido de pedidos sin recoger cada pocos minutos.
 *
 * Mismo patrón que `KioskoAlertasWorker` (un `setInterval`, sin dependencia de
 * cron): el repo no usa `@nestjs/schedule` y para un barrido cada 15 minutos no
 * justifica agregarla. Los plazos son de HORAS, así que la precisión de minutos
 * sobra.
 *
 * Todo lo que importa vive en `SinRecogerService.barrer`, que es idempotente
 * (cada paso reclama su fila con una escritura condicional): si el proceso se
 * reinicia o hay dos instancias, no se duplica ningún correo.
 */
@Injectable()
export class SinRecogerWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SinRecogerWorker.name);
  private timer?: NodeJS.Timeout;

  /** Cada cuánto se barre. */
  private static readonly TICK_MS = 15 * 60 * 1000;

  constructor(private readonly sinRecoger: SinRecogerService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.sinRecoger.barrer().catch((err) => {
        this.logger.error(`Barrido de pedidos sin recoger falló: ${err.message}`);
      });
    }, SinRecogerWorker.TICK_MS);
    // No retener el proceso vivo solo por este temporizador.
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
