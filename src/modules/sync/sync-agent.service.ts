import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CatalogHandler } from './handlers/catalog.handler';
import { ClienteHandler } from './handlers/cliente.handler';
import { PedidoPagoHandler } from './handlers/pedido-pago.handler';
import { PedidoDescargaHandler } from './handlers/pedido-descarga.handler';
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
  ) {}

  // ============================================================
  // Heartbeat
  // ============================================================

  async heartbeat(tiendaId: number, dto: HeartbeatDto) {
    await this.upsertCheckpoint(tiendaId, {
      ultimoHeartbeatAt: new Date(),
      agentVersion: dto.agentVersion,
    });

    await this.log({
      tiendaId,
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
  }> {
    let procesados = 0;
    let errores = 0;

    for (const evento of dto.eventos) {
      let resultado: { ok: boolean; mensaje?: string };
      try {
        resultado = await this.dispatch(evento);
      } catch (err) {
        resultado = { ok: false, mensaje: (err as Error).message };
      }

      await this.log({
        tiendaId: dto.tiendaId,
        direccion: 'UP',
        tipo: this.tipoParaEntidad(evento.entidad),
        referencia: `${evento.entidad}:${evento.localId}`,
        exitoso: resultado.ok,
        mensaje: resultado.mensaje,
        payloadSize: JSON.stringify(evento.datos).length,
      });

      if (resultado.ok) {
        procesados++;
      } else {
        errores++;
      }
    }

    // Avanzar checkpoint sólo si al menos un evento se procesó (o si
    // el batch vino vacío para confirmar watermark sin datos).
    const checkpointAvanzado = errores === 0;
    if (checkpointAvanzado) {
      await this.upsertCheckpoint(dto.tiendaId, {
        ultimoBANDEJAId: BigInt(dto.hastaBANDEJAId),
      });
    } else {
      await this.upsertCheckpoint(dto.tiendaId, {
        lastError: `Batch con ${errores} errores`,
        lastErrorAt: new Date(),
      });
    }

    return { procesados, errores, checkpointAvanzado };
  }

  private async dispatch(evento: { tipo: string; entidad: string; operacion: string; localId: number; localTiendaId?: number; datos: Record<string, unknown> }) {
    if (evento.tipo === 'CATALOGO') {
      return this.catalog.procesar(evento as any);
    }
    if (evento.tipo === 'CLIENTE') {
      return this.cliente.procesar(evento as any);
    }
    if (evento.tipo === 'PEDIDO' || evento.tipo === 'PAGO') {
      return this.pedidoPago.procesar(evento as any);
    }
    return { ok: true, mensaje: `Tipo ${evento.tipo} sin handler` };
  }

  private tipoParaEntidad(entidad: string): string {
    if (entidad.startsWith('CLIENT')) return 'CLIENTE';
    if (entidad === 'PEDIDOS' || entidad === 'MOVPED') return 'PAGO';
    return 'CATALOGO';
  }

  // ============================================================
  // Poll pedidos (nube→local)
  // ============================================================

  async pollPedidos(tiendaIdNube: number, limit: number) {
    return this.pedidoDescarga.poll(tiendaIdNube, limit);
  }

  // ============================================================
  // Ack pedidos
  // ============================================================

  async procesarPedidosAck(dto: PedidosAckDto): Promise<{ actualizados: number; errores: number }> {
    let actualizados = 0;
    let errores = 0;

    for (const ack of dto.acks) {
      try {
        if (ack.exito) {
          await this.prisma.pedidoPendienteEnvio.update({
            where: { pedidoId: ack.pedidoId },
            data: {
              estado: 'PROCESADO',
              processedAt: new Date(),
              externalIdPEDIDOS: ack.externalIdPEDIDOS,
              externalFolio: ack.externalFolio,
              ultimoError: null,
              ultimoIntentoAt: new Date(),
            },
          });
          // Mantener ExternalRef(PEDIDO) para mapear futuros callbacks.
          if (ack.externalIdPEDIDOS) {
            const pedido = await this.prisma.pedido.findUnique({
              where: { id: ack.pedidoId },
              select: { tiendaId: true },
            });
            if (pedido) {
              const tienda = await this.prisma.tienda.findUnique({
                where: { id: pedido.tiendaId },
                select: { externalId: true },
              });
              if (tienda?.externalId) {
                await this.prisma.externalRef.upsert({
                  where: {
                    systemEntity_systemId_localEntity_localTiendaId: {
                      systemEntity: 'PEDIDO',
                      systemId: ack.pedidoId,
                      localEntity: 'PEDIDOS',
                      localTiendaId: tienda.externalId,
                    },
                  },
                  update: { localId: ack.externalIdPEDIDOS, syncedAt: new Date() },
                  create: {
                    systemEntity: 'PEDIDO',
                    systemId: ack.pedidoId,
                    localEntity: 'PEDIDOS',
                    localId: ack.externalIdPEDIDOS,
                    localTiendaId: tienda.externalId,
                  },
                });
              }
            }
          }
        } else {
          await this.prisma.pedidoPendienteEnvio.update({
            where: { pedidoId: ack.pedidoId },
            data: {
              estado: 'ERROR',
              intentos: { increment: 1 },
              ultimoError: (ack.error ?? '').slice(0, 2000),
              ultimoIntentoAt: new Date(),
            },
          });
          errores++;
        }
        actualizados++;
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
    await this.prisma.syncCheckpoint.upsert({
      where: { tiendaId },
      update: data,
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
   * con más de `hoursWithoutProcess` horas sin progreso. Llamar desde
   * un cron externo o invocarlo manualmente para testing.
   */
  async expirarPedidosViejos(hoursWithoutProcess = 24): Promise<number> {
    const cutoff = new Date(Date.now() - hoursWithoutProcess * 60 * 60 * 1000);
    const result = await this.prisma.pedidoPendienteEnvio.updateMany({
      where: { estado: 'PENDIENTE', createdAt: { lt: cutoff } },
      data: { estado: 'EXPIRADO' },
    });
    return result.count;
  }
}
