import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { formatearFolio, guardarFolioDelPedido } from '../../pedidos/core/folio-erp.util';
import type { FoliosAckDto } from '../dto/folios-ack.dto';

/** Cuánto tiene el agente para contestar una solicitud antes de que otro ciclo pueda tomarla. */
const LEASE_MS = 60_000;
/** Espera tras un error del agente (Firebird caído, bloqueo) antes de ofrecer la solicitud otra vez. */
const REINTENTO_MS = 30_000;

/**
 * FolioReservaHandler (oct 2026, parte B): el canal por el que la nube le pide al agente un FOLIO del Sistema
 * Comercial para un pedido. La nube no puede llamar al agente (vive detrás de la red de Navojoa y solo hace conexiones
 * de salida), así que deja la solicitud en `PedidoFolioSolicitud` y el agente la recoge en su ciclo:
 *
 *   GET  sync/agent/poll-folios  → `poll`: reparte las solicitudes con un lease (mismo patrón que poll-pedidos).
 *   POST sync/agent/folios-ack   → `ack`:  el agente reservó el consecutivo en Firebird y dice cuál fue.
 *
 * Lo único que hace el agente es TOMAR UN NÚMERO (`UPDATE CONSECUTIVOS … RETURNING`, la misma sentencia que usa
 * `GRABAR_PEDIDOS` con `IDPEDIDO = 0`); el pedido NO se escribe en el ERP hasta que mostrador lo manda a pagar.
 * Un folio reservado de un pedido que luego se cancela deja un hueco en la numeración: aceptado por el dueño.
 *
 * El lease solo decide QUIÉN reserva (para no gastar dos números por el mismo pedido); no se exige al contestar. Un ACK
 * con un folio ya reservado se acepta aunque su lease haya vencido: tirarlo gastaría un número más sin ningún beneficio,
 * y el índice único `(tienda, folio)` ya impide asignarlo a dos pedidos.
 */
@Injectable()
export class FolioReservaHandler {
  private readonly logger = new Logger(FolioReservaHandler.name);

  constructor(
    private prisma: PrismaService,
    // RealtimeModule es global. Opcional para que los specs del handler no lo necesiten.
    private realtime?: RealtimeService,
  ) {}

  /** Reparte hasta `limit` solicitudes de la tienda al agente. */
  async poll(tiendaIdNube: number, limit: number, agentId: string) {
    const ahora = new Date();
    const leaseUntil = new Date(ahora.getTime() + LEASE_MS);
    const libre = [
      { estado: 'PENDIENTE', nextAttemptAt: { lte: ahora } },
      { estado: 'PROCESSING', leaseUntil: { lt: ahora } },
    ];

    return this.prisma.$transaction(async (tx) => {
      const candidatas = await tx.pedidoFolioSolicitud.findMany({
        where: {
          tiendaId: tiendaIdNube,
          OR: libre,
          // Un pedido cancelado antes de que el agente llegara no gasta número, y uno que ya recibió su folio por otro
          // camino (el respaldo de `GRABAR_PEDIDOS`) tampoco lo necesita.
          pedido: { estado: { not: 'CANCELADO' }, folioErp: null },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: { id: true, pedidoId: true, pedido: { select: { numeroPedido: true } } },
      });

      const tomadas: Array<{
        pedidoId: number;
        numeroPedido: string;
        leaseToken: string;
        leaseUntil: Date;
      }> = [];
      for (const c of candidatas) {
        const leaseToken = randomUUID();
        const { count } = await tx.pedidoFolioSolicitud.updateMany({
          where: { id: c.id, OR: libre },
          data: {
            estado: 'PROCESSING',
            claimedBy: agentId,
            leaseToken,
            leaseUntil,
            intentos: { increment: 1 },
          },
        });
        if (count === 1) {
          tomadas.push({
            pedidoId: c.pedidoId,
            numeroPedido: c.pedido.numeroPedido,
            leaseToken,
            leaseUntil,
          });
        }
      }
      return tomadas;
    });
  }

  /** Procesa las respuestas del agente. Cada una es independiente: un error no tira a las demás. */
  async ack(
    tiendaIdNube: number,
    dto: FoliosAckDto,
  ): Promise<{ actualizados: number; errores: number }> {
    let actualizados = 0;
    let errores = 0;

    for (const ack of dto.acks) {
      try {
        const solicitud = await this.prisma.pedidoFolioSolicitud.findUnique({
          where: { pedidoId: ack.pedidoId },
          select: {
            tiendaId: true,
            pedido: {
              select: {
                id: true,
                tiendaId: true,
                folioErp: true,
                tienda: { select: { serie: true } },
              },
            },
          },
        });
        if (!solicitud) {
          // Sin solicitud, pero el pedido YA tiene ese folio (lo grabó el respaldo de GRABAR_PEDIDOS, que no pasa por la
          // cola): es un ACK repetido, no un error. Rechazarlo hacía que el agente lo reenviara para siempre.
          const pedido = await this.prisma.pedido.findUnique({
            where: { id: ack.pedidoId },
            select: { tiendaId: true, folioErp: true },
          });
          if (
            ack.exito &&
            pedido &&
            pedido.tiendaId === tiendaIdNube &&
            pedido.folioErp &&
            pedido.folioErp === ack.folio
          ) {
            actualizados++;
            continue;
          }
        }
        if (!solicitud || solicitud.tiendaId !== tiendaIdNube) {
          throw new Error(
            `El pedido ${ack.pedidoId} no tiene solicitud de folio en la tienda ${tiendaIdNube}`,
          );
        }

        if (!ack.exito) {
          await this.prisma.pedidoFolioSolicitud.updateMany({
            where: { pedidoId: ack.pedidoId, estado: { not: 'ASIGNADO' } },
            data: {
              estado: 'PENDIENTE',
              nextAttemptAt: new Date(Date.now() + REINTENTO_MS),
              claimedBy: null,
              leaseToken: null,
              leaseUntil: null,
              ultimoError: (ack.error ?? 'El agente no pudo reservar el folio').slice(0, 2000),
            },
          });
          errores++;
          continue;
        }

        if (!ack.folio) throw new Error(`ACK exitoso del pedido ${ack.pedidoId} sin folio`);
        const pedido = solicitud.pedido;
        const resultado = await this.prisma.$transaction((tx) =>
          guardarFolioDelPedido(tx, pedido, ack.folio!, { elErpManda: false }),
        );

        switch (resultado) {
          case 'ASIGNADO':
            this.avisarFolioAsignado(pedido.id, pedido.tiendaId, ack.folio, pedido.tienda.serie);
            actualizados++;
            break;
          case 'YA_TENIA_ESE':
            actualizados++;
            break;
          case 'YA_TENIA_OTRO':
            // La nube se adelantó (el respaldo de GRABAR_PEDIDOS ya le dio otro): el reservado es un hueco.
            this.logger.warn(
              `Folio ${ack.folio} reservado para el pedido ${ack.pedidoId}, que ya tiene ${pedido.folioErp}: queda como hueco`,
            );
            actualizados++;
            break;
          case 'FOLIO_EN_USO':
            // Otro pedido de la tienda ya usa ese número: el consecutivo del ERP retrocedió (¿se restauró un respaldo?).
            // Rojo en el log y error al agente: NO se asigna.
            this.logger.error(
              `Folio ${ack.folio} de la tienda ${tiendaIdNube} YA lo tiene otro pedido: el consecutivo del ERP está desfasado`,
            );
            throw new Error(`El folio ${ack.folio} ya está asignado a otro pedido de la tienda`);
          case 'CONFLICTO':
            throw new Error(`El pedido ${ack.pedidoId} cambió mientras se guardaba su folio`);
        }
      } catch (err) {
        errores++;
        this.logger.error(
          `Error en folios-ack del pedido ${ack.pedidoId}: ${(err as Error).message}`,
        );
      }
    }
    return { actualizados, errores };
  }

  /**
   * Las pantallas que muestran el pedido (bodega, mostrador, caja, consulta, y el propio cliente) se actualizan solas.
   * DESPUÉS del commit: un evento de un folio que no se guardó dejaría una pantalla con un número que no existe.
   *
   * Asignar el folio NO cambia el estado, así que `pedido.estado` no llega: el frontend escucha este evento en un solo
   * lugar (`RealtimeProvider`) y refresca todo lo que nombra pedidos. Antes solo la página de bodega lo escuchaba; el
   * comentario de aquí decía que el cliente y mostrador también y no era cierto: seguían mostrando el `PD-…` hasta que
   * algo más los refrescaba.
   *
   * `monitor.invalidado` es para las TV de pared: su "turno" son los últimos 4 dígitos del folio y, mientras no hay
   * folio, la cola del `PD-…`. Sin el aviso, un pedido que ya estaba en la pantalla se quedaba con el turno viejo, que
   * no coincide con el del ticket que el cliente trae en la mano.
   */
  avisarFolioAsignado(pedidoId: number, tiendaId: number, folio: string, serie: string | null) {
    if (!this.realtime) return;
    const payload = { id: pedidoId, folio, serie, etiqueta: formatearFolio(serie, folio) };
    this.realtime.emitToTienda(tiendaId, 'pedido.folio-asignado', payload);
    this.realtime.emitToPedido(pedidoId, 'pedido.folio-asignado', payload);
    this.realtime.emitToTienda(tiendaId, 'monitor.invalidado', { pedidoId });
  }
}
