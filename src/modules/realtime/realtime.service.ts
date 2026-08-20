import { Injectable, Logger } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Helper de emisión. Se inyecta en PedidosService, SurtidoService, etc.
 * para notificar al frontend sin acoplar esos servicios al gateway.
 *
 * Helpers:
 *   emitToTienda(tiendaId, evento, payload)
 *   emitToPedido(pedidoId, evento, payload)
 *   emitToUser(userId, evento, payload)
 *   emitToAllAdmins(evento, payload)
 *
 * Si el gateway aún no está listo (ej. durante el bootstrap), se loguea
 * warning y se omite — el polling cubre el gap.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(private readonly gateway: RealtimeGateway) {}

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

  emitToTienda(tiendaId: number, evento: string, payload: unknown) {
    this.safeEmit(`tienda-${tiendaId}`, evento, payload);
  }

  emitToPedido(pedidoId: number, evento: string, payload: unknown) {
    this.safeEmit(`pedido-${pedidoId}`, evento, payload);
  }

  emitToUser(userId: number, evento: string, payload: unknown) {
    this.safeEmit(`user-${userId}`, evento, payload);
  }

  emitToAllAdmins(evento: string, payload: unknown) {
    this.safeEmit('admin:all', evento, payload);
  }
}
