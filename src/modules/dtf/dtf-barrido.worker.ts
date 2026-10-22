import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ActividadWorkers } from '../../common/actividad-workers';
import { PrismaService } from '../../prisma/prisma.service';
import { DtfStorageService } from './storage/dtf-storage.service';

/**
 * Barrido de borradores abandonados (el carrito DTF vive en el servidor). Mismo patrón que
 * `SinRecogerWorker`: un `setInterval`, sin `@nestjs/schedule`. Idempotente.
 */
@Injectable()
export class DtfBarridoWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DtfBarridoWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: DtfStorageService,
    // N3: la pantalla de salud ve cuándo corrió por última vez. Opcional: sin él funciona igual.
    @Optional() private readonly actividad?: ActividadWorkers,
  ) {}

  onModuleInit() {
    this.actividad?.declarar('dtf-barrido', 30 * 60_000);
    this.timer = setInterval(
      () =>
        void this.barrer()
          .then(() => this.actividad?.corrio('dtf-barrido'))
          .catch((e) => {
            this.logger.error(`Barrido DTF falló: ${e.message}`);
            this.actividad?.fallo('dtf-barrido', e.message);
          }),
      30 * 60_000,
    );
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async barrer() {
    const vencidos = await this.prisma.pedidoDtf.findMany({
      where: { estado: 'BORRADOR', pedidoId: null, expiraAt: { lt: new Date() } },
      include: { archivos: true },
      take: 100,
    });
    for (const t of vencidos) {
      for (const a of t.archivos) {
        await this.storage.eliminar(a.archivoKey);
        if (a.previewKey) await this.storage.eliminar(a.previewKey);
      }
      await this.prisma.pedidoDtf.delete({ where: { id: t.id } });
    }
    if (vencidos.length) this.logger.log(`Borradores DTF vencidos eliminados: ${vencidos.length}`);
  }
}
