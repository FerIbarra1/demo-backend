import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from './realtime.service';

/**
 * RealtimeOutboxWorker: re-emite eventos realtime que quedaron sin emitir
 * tras una caída del proceso.
 *
 * Cada evento se persiste en `realtime_event_outbox` con `emitidoAt = now`
 * (ya emitido en vivo). Si el proceso muere entre el persist y el emit, la
 * fila queda con `emitidoAt = null`. Este worker, cada segundo, toma esos
 * huérfanos (últimos 5 min) y los re-emite al room, marcándolos como emitidos.
 *
 * También limpia eventos viejos (>1h) para que la tabla no crezca sin límite.
 */
@Injectable()
export class RealtimeOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeOutboxWorker.name);
  private timer?: NodeJS.Timeout;

  // Ventana de re-emisión: solo eventos recientes (el outbox es efímero).
  private static readonly VENTANA_REEMITIR_MS = 5 * 60 * 1000;
  // Retención: borrar lo más viejo que 1h.
  private static readonly RETENCION_MS = 60 * 60 * 1000;
  private static readonly TICK_MS = 1_000;
  private static readonly LOTE = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.error(`Realtime outbox tick falló: ${err.message}`);
      });
    }, RealtimeOutboxWorker.TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const now = new Date();
    const limiteReemitir = new Date(now.getTime() - RealtimeOutboxWorker.VENTANA_REEMITIR_MS);

    const pendientes = await this.prisma.realtimeEventOutbox.findMany({
      where: { emitidoAt: null, createdAt: { gte: limiteReemitir } },
      orderBy: { createdAt: 'asc' },
      take: RealtimeOutboxWorker.LOTE,
      select: { id: true, room: true, evento: true, payload: true },
    });

    for (const ev of pendientes) {
      this.realtime.emitToRoom(ev.room, ev.evento, ev.payload);
      // Idempotente: solo marca si sigue null (evita doble-emit si dos ticks
      // se solapan o si el evento se emitió en vivo mientras tanto).
      await this.prisma.realtimeEventOutbox.updateMany({
        where: { id: ev.id, emitidoAt: null },
        data: { emitidoAt: now },
      });
    }

    if (pendientes.length > 0) {
      this.logger.log(`Realtime outbox: re-emitidos ${pendientes.length} eventos huérfanos`);
    }

    // Limpieza de eventos viejos.
    const limiteRetencion = new Date(now.getTime() - RealtimeOutboxWorker.RETENCION_MS);
    await this.prisma.realtimeEventOutbox.deleteMany({
      where: { createdAt: { lt: limiteRetencion } },
    });
  }
}
