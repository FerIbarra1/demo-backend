import { Injectable, Logger } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Helper de emisión. Se inyecta en PedidosService, SurtidoService, etc.
 * para notificar al frontend sin acoplar esos servicios al gateway.
 *
 * Helpers:
 *   emitToTienda(tiendaId, evento, payload)
 *   emitToPedido(pedidoId, evento, payload)
 *   emitToUser(userId, evento, payload)
 *
 * Resiliencia (outbox): cada evento se persiste en `realtime_event_outbox`
 * ANTES de emitir en vivo, con `emitidoAt = now`. Si el proceso muere entre
 * el persist y el emit, la fila queda con `emitidoAt = null` y el worker
 * (RealtimeOutboxWorker) la re-emite al arrancar. Así un servidor que se cae
 * por segundos/minutos no pierde eventos (pedidos que no salen en bodega).
 *
 * Si el gateway aún no está listo (ej. durante el bootstrap), se loguea
 * warning y se omite — el polling cubre el gap.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly prisma: PrismaService,
  ) {}

  private get server() {
    return this.gateway.server;
  }

  private safeEmit(room: string, evento: string, payload: unknown) {
    if (!this.server) {
      this.logger.debug(`Realtime: server no listo, omitiendo '${evento}' a ${room}`);
      return;
    }
    this.server.to(room).emit(evento, payload);
  }

  /**
   * Persiste el evento en el outbox con `emitidoAt = now` (ya emitido en vivo).
   * Fire-and-forget: no bloquea el flujo del pedido. Si falla la escritura,
   * solo se loguea — el emit en vivo sigue ocurriendo.
   */
  private persistir(room: string, evento: string, payload: unknown) {
    setImmediate(() => {
      this.prisma.realtimeEventOutbox
        .create({
          data: { room, evento, payload: payload as object, emitidoAt: new Date() },
        })
        .catch((err) => {
          this.logger.error(
            `Realtime: no se pudo persistir evento '${evento}' a ${room}: ${err.message}`,
          );
        });
    });
  }

  emitToTienda(tiendaId: number, evento: string, payload: unknown) {
    const room = `tienda-${tiendaId}`;
    this.persistir(room, evento, payload);
    this.safeEmit(room, evento, payload);
  }

  emitToPedido(pedidoId: number, evento: string, payload: unknown) {
    const room = `pedido-${pedidoId}`;
    this.persistir(room, evento, payload);
    this.safeEmit(room, evento, payload);
  }

  emitToUser(userId: number, evento: string, payload: unknown) {
    const room = `user-${userId}`;
    this.persistir(room, evento, payload);
    this.safeEmit(room, evento, payload);
  }

  /**
   * Emisión directa a un room arbitrario. Lo usa RealtimeOutboxWorker para
   * re-emitir eventos huérfanos (emitidoAt = null) tras una caída. NO persiste
   * (el evento ya está en el outbox).
   */
  emitToRoom(room: string, evento: string, payload: unknown) {
    this.safeEmit(room, evento, payload);
  }
}
