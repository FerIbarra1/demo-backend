import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CatalogHandler } from './handlers/catalog.handler';
import { ClienteHandler } from './handlers/cliente.handler';
import { PedidoPagoHandler } from './handlers/pedido-pago.handler';
import { PedidoDescargaHandler } from './handlers/pedido-descarga.handler';
import { NotificationsService } from '../notifications/notifications.service';
import type { UploadBatchDto } from './dto/upload-batch.dto';
import type { PedidosAckDto } from './dto/pedidos-ack.dto';
import type { HeartbeatDto } from './dto/heartbeat.dto';

/**
 * Servicio orquestador del agente de sincronización.
 *
 * Procesa los eventos que el agente sube desde Firebird (catálogo,
 * clientes, pedidos), mantiene los checkpoints por tienda, y expone la
 * cola de pedidos nuevos para que el agente los baje a Firebird.
 */
@Injectable()
export class SyncAgentService {
  private readonly logger = new Logger(SyncAgentService.name);

  constructor(
    private prisma: PrismaService,
    private catalog: CatalogHandler,
    private cliente: ClienteHandler,
    private pedidoPago: PedidoPagoHandler,
    private pedidoDescarga: PedidoDescargaHandler,
    private notifications: NotificationsService,
  ) {}

  // ============================================================
  // Heartbeat
  // ============================================================

  async heartbeat(tiendaIdExterno: number, dto: HeartbeatDto) {
    const tienda = await this.resolverTiendaPorExternalId(tiendaIdExterno);

    await this.upsertCheckpoint(tienda.id, {
      ultimoHeartbeatAt: new Date(),
      agentVersion: dto.agentVersion,
    });

    await this.log({
      tiendaId: tienda.id,
      direccion: 'UP',
      tipo: 'HEARTBEAT',
      exitoso: true,
    });

    return {
      serverTime: new Date().toISOString(),
      config: {
        pollIntervalMs: 5000,
        backoffMaxMs: 60000,
        batchSize: 200,
      },
    };
  }

  // ============================================================
  // Upload batch (local→nube)
  // ============================================================

  async procesarUpload(dto: UploadBatchDto): Promise<{
    procesados: number;
    errores: number;
    checkpointAvanzado: boolean;
    deadLetters: number;
  }> {
    // dto.tiendaId es el externalId (IDTIENDA de Firebird). Resolvemos el
    // id interno de la tienda nube para checkpoint/inbox.
    const tienda = await this.resolverTiendaPorExternalId(dto.tiendaId);
    const tiendaId = tienda.id;

    let procesados = 0;
    let errores = 0;
    let deadLetters = 0;

    for (const evento of dto.eventos) {
      const existente = await this.prisma.syncEventInbox.findUnique({
        where: { eventId: evento.eventId },
        select: { estado: true, mensaje: true, nextAttemptAt: true, intentos: true },
      });

      // En backoff (ERROR/RETRY con nextAttemptAt futuro): no reprocesar aún.
      if (
        existente &&
        existente.estado !== 'PROCESADO' &&
        existente.nextAttemptAt > new Date()
      ) {
        errores++;
        continue;
      }
      if (existente?.estado === 'PROCESADO') {
        procesados++;
        continue;
      }

      // Un PROCESANDO con nextAttemptAt vencido quedó huérfano (crash entre
      // create y update). Se reclama como ERROR para reprocesarlo. Un
      // PROCESANDO recién creado en este batch tiene nextAttemptAt ≈ now
      // (no vencido) y no entra aquí.
      const esProcesandoStale =
        existente?.estado === 'PROCESANDO' && existente.nextAttemptAt <= new Date();

      if (existente?.estado === 'ERROR' || esProcesandoStale) {
        const reclamado = await this.prisma.syncEventInbox.updateMany({
          where: { eventId: evento.eventId, estado: { in: ['ERROR', 'PROCESANDO'] } },
          data: { estado: 'PROCESANDO', mensaje: null },
        });
        if (reclamado.count !== 1) {
          errores++;
          continue;
        }
      } else {
        try {
          await this.prisma.syncEventInbox.create({
            data: {
              eventId: evento.eventId,
              tiendaId,
              bandejaId: BigInt(evento.bandejaId),
              entidad: evento.entidad,
              operacion: evento.operacion,
              localId: evento.localId,
              estado: 'PROCESANDO',
              payload: evento as any,
            },
          });
        } catch (err) {
          if ((err as { code?: string }).code === 'P2002') {
            errores++;
            continue;
          }
          throw err;
        }
      }

      let resultado: { ok: boolean; mensaje?: string };
      try {
        resultado = await this.dispatch(evento);
      } catch (err) {
        resultado = { ok: false, mensaje: (err as Error).message };
      }

      const intento = (existente?.intentos ?? 0) + 1;
      const reintentosMaximos = 5;
      const puedeReintentar = !resultado.ok && intento < reintentosMaximos;
      const esDeadLetter = !resultado.ok && !puedeReintentar;
      await this.prisma.syncEventInbox.update({
        where: { eventId: evento.eventId },
        data: {
          estado: resultado.ok
            ? 'PROCESADO'
            : puedeReintentar
              ? 'ERROR'
              : 'DEAD_LETTER',
          intentos: intento,
          nextAttemptAt: puedeReintentar
            ? new Date(Date.now() + Math.min(300_000, 30_000 * 2 ** (intento - 1)))
            : new Date(),
          ultimoErrorCode: resultado.ok ? null : 'HANDLER_ERROR',
          mensaje: resultado.mensaje,
          processedAt: resultado.ok ? new Date() : null,
        },
      });

      await this.log({
        tiendaId,
        direccion: 'UP',
        tipo: this.tipoParaEntidad(evento.entidad),
        referencia: `${evento.entidad}:${evento.localId}`,
        exitoso: resultado.ok,
        mensaje: resultado.mensaje,
        payloadSize: JSON.stringify(evento.datos).length,
      });

      if (resultado.ok) {
        procesados++;
      } else if (esDeadLetter) {
        // DEAD_LETTER es terminal: no bloquear el checkpoint de la tienda.
        // Se cuenta aparte para que el batch avance y el agente no quede
        // wedged esperando un evento que nunca se va a recuperar.
        deadLetters++;
      } else {
        errores++;
      }
    }

    // Avanzar checkpoint al último bandejaId procesado con éxito. Un
    // DEAD_LETTER terminal no bloquea el avance (se reporta aparte).
    const checkpointAvanzado = errores === 0;
    if (checkpointAvanzado) {
      await this.upsertCheckpoint(tiendaId, {
        ultimoBANDEJAId: BigInt(dto.hastaBANDEJAId),
      });
    } else {
      await this.upsertCheckpoint(tiendaId, {
        lastError: `Batch con ${errores} errores`,
        lastErrorAt: new Date(),
      });
    }

    return { procesados, errores, checkpointAvanzado, deadLetters };
  }

  async reprogramarEvento(eventId: string): Promise<{ eventId: string; estado: string }> {
    const evento = await this.prisma.syncEventInbox.findUnique({
      where: { eventId },
      select: { eventId: true, estado: true },
    });
    if (!evento) throw new NotFoundException(`Evento ${eventId} no encontrado`);
    if (evento.estado === 'PROCESADO') {
      return evento;
    }
    await this.prisma.syncEventInbox.update({
      where: { eventId },
      data: {
        estado: 'ERROR',
        nextAttemptAt: new Date(),
        intentos: 0,
        ultimoErrorCode: null,
        mensaje: null,
      },
    });
    return { eventId, estado: 'ERROR' };
  }

  private async dispatch(evento: { tipo: string; entidad: string; operacion: string; localId: number; localTiendaId?: number; datos: Record<string, unknown> }) {
    // MOVPED se ignora: el pedido llega a Firebird con cantidades finales
    // confirmadas por bodega en la web (confirmarSurtido → PENDING_PAID).
    // No hay ajustes VFP→nube que re-sincronizar.
    if (evento.entidad === 'MOVPED') {
      return { ok: true, mensaje: 'MOVPED ignorado: el pedido llega a Firebird con cantidades finales' };
    }
    if (evento.tipo === 'CATALOGO') {
      return this.catalog.procesar(evento as any);
    }
    if (evento.tipo === 'CLIENTE') {
      return this.cliente.procesar(evento as any);
    }
    if (evento.tipo === 'PEDIDO' || evento.tipo === 'PAGO') {
      return this.pedidoPago.procesar(evento as any);
    }
    return { ok: true, mensaje: `Tipo ${evento.tipo} sin handler: ignorado` };
  }

  private tipoParaEntidad(entidad: string): string {
    if (entidad.startsWith('CLIENT')) return 'CLIENTE';
    if (entidad === 'PEDIDOS') return 'PAGO';
    return 'CATALOGO';
  }

  // ============================================================
  // Poll pedidos (nube→local)
  // ============================================================

  async pollPedidos(tiendaIdExterno: number, limit: number, agentId: string) {
    const tienda = await this.resolverTiendaPorExternalId(tiendaIdExterno);
    return this.pedidoDescarga.poll(tienda.id, limit, agentId);
  }

  // ============================================================
  // Ack pedidos
  // ============================================================

  async procesarPedidosAck(dto: PedidosAckDto): Promise<{ actualizados: number; errores: number }> {
    // dto.tiendaId es el externalId (IDTIENDA de Firebird).
    const tienda = await this.resolverTiendaPorExternalId(dto.tiendaId);
    const tiendaIdNube = tienda.id;

    let actualizados = 0;
    let errores = 0;

    for (const ack of dto.acks) {
      try {
        const pedido = await this.prisma.pedido.findUnique({
          where: { id: ack.pedidoId },
          select: { tiendaId: true },
        });
        if (!pedido || pedido.tiendaId !== tiendaIdNube) {
          throw new NotFoundException(
            `Pedido ${ack.pedidoId} no pertenece a la tienda ${tiendaIdNube}`,
          );
        }

        const entrega = await this.prisma.pedidoPendienteEnvio.findUnique({
          where: { pedidoId: ack.pedidoId },
          select: {
            estado: true,
            claimedBy: true,
            leaseToken: true,
            externalIdPEDIDOS: true,
          },
        });
        if (!entrega) {
          throw new NotFoundException(
            `Cola de envío del pedido ${ack.pedidoId} no encontrada`,
          );
        }

        if (entrega.estado === 'PROCESADO') {
          if (ack.exito && entrega.externalIdPEDIDOS === ack.externalIdPEDIDOS) {
            actualizados++;
            continue;
          }
          throw new BadRequestException(`Pedido ${ack.pedidoId} ya fue procesado`);
        }

        if (
          entrega.estado !== 'PROCESSING' ||
          entrega.claimedBy !== ack.agentId ||
          entrega.leaseToken !== ack.leaseToken
        ) {
          throw new BadRequestException(
            `Lease inválido o expirado para pedido ${ack.pedidoId}`,
          );
        }

        if (ack.exito) {
          if (!ack.externalIdPEDIDOS || !tienda.externalId) {
            throw new BadRequestException(
              `ACK exitoso del pedido ${ack.pedidoId} sin externalIdPEDIDOS o tienda Firebird`,
            );
          }

          const externalIdPEDIDOS = ack.externalIdPEDIDOS;
          const localTiendaId = tienda.externalId;
          await this.prisma.$transaction(async (tx) => {
            await tx.pedidoPendienteEnvio.update({
              where: { pedidoId: ack.pedidoId },
              data: {
                estado: 'PROCESADO',
                processedAt: new Date(),
                externalIdPEDIDOS,
                externalFolio: ack.externalFolio,
                claimedBy: null,
                leaseToken: null,
                leaseUntil: null,
                ultimoError: null,
                ultimoErrorCode: null,
                ultimoIntentoAt: new Date(),
              },
            });
            await tx.externalRef.upsert({
              where: {
                systemEntity_systemId_localEntity_localTiendaId: {
                  systemEntity: 'PEDIDO',
                  systemId: ack.pedidoId,
                  localEntity: 'PEDIDOS',
                  localTiendaId,
                },
              },
              update: { localId: externalIdPEDIDOS, syncedAt: new Date() },
              create: {
                systemEntity: 'PEDIDO',
                systemId: ack.pedidoId,
                localEntity: 'PEDIDOS',
                localId: externalIdPEDIDOS,
                localTiendaId: tienda.externalId,
              },
            });
          });

          // Email "listo para pagar" con QR del folio VFP. Se dispara aquí
          // (cuando el folio ya existe), no en confirmarSurtido. Fire-and-forget.
          if (ack.externalFolio) {
            const pedido = await this.prisma.pedido.findUnique({
              where: { id: ack.pedidoId },
            });
            if (pedido?.clienteEmail) {
              setImmediate(() => {
                this.notifications
                  .enviarListoParaPagar(pedido, ack.externalFolio!)
                  .catch((err) =>
                    this.logger.error(
                      `Error email listo para pagar pedido ${ack.pedidoId}: ${(err as Error).message}`,
                    ),
                  );
              });
            }
          }
          actualizados++;
        } else {
          const nextAttemptAt = new Date(Date.now() + 30_000);
          await this.prisma.pedidoPendienteEnvio.update({
            where: { pedidoId: ack.pedidoId },
            data: {
              estado: 'RETRY',
              intentos: { increment: 1 },
              nextAttemptAt,
              claimedBy: null,
              leaseToken: null,
              leaseUntil: null,
              ultimoError: (ack.error ?? '').slice(0, 2000),
              ultimoErrorCode: 'AGENT_PROCESSING_ERROR',
              ultimoIntentoAt: new Date(),
            },
          });
          errores++;
        }
      } catch (err) {
        this.logger.error(`Error en ack pedido ${ack.pedidoId}: ${(err as Error).message}`);
        errores++;
      }
    }

    return { actualizados, errores };
  }

  // ============================================================
  // Helpers internos
  // ============================================================

  /**
   * Resuelve una tienda de la nube a partir de su `externalId` (el
   * IDTIENDA de Firebird). Es la clave natural compartida entre ambos
   * sistemas, así que el agente no necesita mapear IDs de tienda.
   */
  private async resolverTiendaPorExternalId(externalId: number): Promise<{ id: number; externalId: number }> {
    // C1: defensa contra agentes que mandan tiendaId=0 (que era el valor de
    // GLOBAL_CHECKPOINT_TIENDA en versiones anteriores). Un externalId <= 0
    // no es una tienda válida y debe rechazarse antes de consultar BD.
    if (!Number.isFinite(externalId) || externalId <= 0) {
      throw new BadRequestException(
        `X-Sucursal-Id inválido (${externalId}). Debe ser numérico positivo.`,
      );
    }
    const tienda = await this.prisma.tienda.findUnique({
      where: { externalId },
      select: { id: true, externalId: true },
    });
    if (!tienda?.externalId) {
      throw new NotFoundException(
        `Tienda con externalId=${externalId} no encontrada. Asegúrate de que el trigger TRG_TIENDAS_SYNC esté aplicado en Firebird o crea la tienda manualmente.`,
      );
    }
    return { id: tienda.id, externalId: tienda.externalId };
  }

  private async upsertCheckpoint(
    tiendaId: number,
    data: Partial<{
      ultimoBANDEJAId: bigint;
      ultimoHeartbeatAt: Date;
      agentVersion: string;
      lastError: string;
      lastErrorAt: Date;
    }>,
  ): Promise<void> {
    const checkpoint = await this.prisma.syncCheckpoint.findUnique({
      where: { tiendaId },
      select: { ultimoBANDEJAId: true },
    });
    const ultimoBANDEJAId = data.ultimoBANDEJAId;
    const update = { ...data };
    if (
      ultimoBANDEJAId !== undefined &&
      checkpoint?.ultimoBANDEJAId !== undefined &&
      ultimoBANDEJAId < checkpoint.ultimoBANDEJAId
    ) {
      delete update.ultimoBANDEJAId;
    }
    await this.prisma.syncCheckpoint.upsert({
      where: { tiendaId },
      update,
      create: { tiendaId, ...data },
    });
  }

  private async log(args: {
    tiendaId: number;
    direccion: 'UP' | 'DOWN';
    tipo: string;
    referencia?: string;
    exitoso: boolean;
    mensaje?: string;
    payloadSize?: number;
  }): Promise<void> {
    try {
      await this.prisma.syncEventLog.create({
        data: {
          tiendaId: args.tiendaId,
          direccion: args.direccion,
          tipo: args.tipo,
          referencia: args.referencia,
          exitoso: args.exitoso,
          mensaje: args.mensaje,
          payloadSize: args.payloadSize,
        },
      });
    } catch (err) {
      // No fallamos el evento sólo porque no podamos escribir el log.
      this.logger.warn(`No se pudo escribir SyncEventLog: ${(err as Error).message}`);
    }
  }

  /**
   * Job de mantenimiento: marca como EXPIRADO los pedidos pendientes
   * con más de `hoursWithoutProcess` horas sin progreso. Incluye RETRY
   * (que antes quedaba atascado para siempre) y PROCESSING con lease
   * vencido. Llamar desde un cron externo o invocarlo manualmente.
   */
  async expirarPedidosViejos(hoursWithoutProcess = 24): Promise<number> {
    const cutoff = new Date(Date.now() - hoursWithoutProcess * 60 * 60 * 1000);
    const result = await this.prisma.pedidoPendienteEnvio.updateMany({
      where: {
        OR: [
          { estado: 'PENDIENTE', createdAt: { lt: cutoff } },
          { estado: 'RETRY', createdAt: { lt: cutoff } },
          { estado: 'PROCESSING', leaseUntil: { lt: cutoff } },
        ],
      },
      data: { estado: 'EXPIRADO' },
    });
    return result.count;
  }
}
