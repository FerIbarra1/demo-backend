import { Injectable } from '@nestjs/common';
import { EstadoDtf, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

export interface ActorDtf {
  id: number | null;
  rol: string | null;
  nombre: string | null;
}

/**
 * Bitácora (append-only) y avisos en vivo del DTF. Los eventos son strings sueltos y CADA pantalla debe
 * escuchar el suyo (un typo falla en silencio):
 *
 *   dtf.cola             → tienda-{id}   la cola de Impresión se refresca
 *   dtf.estado           → user-{dueño}, pedido-{id}   cambió un trabajo (detalle del pedido del cliente)
 *   dtf.archivo-recibido → user-{dueño}  el archivo llegó (la tablet que espera, el celular)
 *   dtf.preflight        → user-{dueño}  terminó la revisión automática
 *   dtf.mensaje          → user-{dueño}, tienda-{id}   hay un mensaje nuevo en el hilo
 */
@Injectable()
export class DtfEmisor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Una fila de bitácora. Va en la MISMA transacción que el cambio que describe. */
  async evento(
    db: Prisma.TransactionClient | PrismaService,
    dtfId: number,
    tipo: string,
    actor: ActorDtf | null,
    extra: { de?: EstadoDtf | null; a?: EstadoDtf | null; detalle?: Prisma.InputJsonValue } = {},
  ) {
    await db.pedidoDtfEvento.create({
      data: {
        dtfId,
        tipo,
        deEstado: extra.de ?? null,
        aEstado: extra.a ?? null,
        actorId: actor?.id ?? null,
        actorRol: actor?.rol ?? null,
        actorNombre: actor?.nombre ?? null,
        detalle: extra.detalle,
      },
    });
  }

  /** Después del commit. */
  estado(t: {
    id: number;
    usuarioId: number;
    tiendaId: number;
    pedidoId: number | null;
    estado: EstadoDtf;
  }) {
    const payload = { trabajoId: t.id, pedidoId: t.pedidoId, estado: t.estado };
    this.realtime.emitToUser(t.usuarioId, 'dtf.estado', payload);
    if (t.pedidoId) this.realtime.emitToPedido(t.pedidoId, 'dtf.estado', payload);
    this.realtime.emitToTienda(t.tiendaId, 'dtf.cola', payload);
  }

  archivoRecibido(t: { id: number; usuarioId: number }, version: number) {
    this.realtime.emitToUser(t.usuarioId, 'dtf.archivo-recibido', { trabajoId: t.id, version });
  }

  preflight(
    t: { id: number; usuarioId: number; tiendaId: number },
    version: number,
    estado: string,
  ) {
    this.realtime.emitToUser(t.usuarioId, 'dtf.preflight', {
      trabajoId: t.id,
      version,
      preflightEstado: estado,
    });
    this.realtime.emitToTienda(t.tiendaId, 'dtf.cola', { trabajoId: t.id });
  }

  mensaje(t: { id: number; usuarioId: number; tiendaId: number; pedidoId: number | null }) {
    const payload = { trabajoId: t.id, pedidoId: t.pedidoId };
    this.realtime.emitToUser(t.usuarioId, 'dtf.mensaje', payload);
    this.realtime.emitToTienda(t.tiendaId, 'dtf.mensaje', payload);
  }
}
