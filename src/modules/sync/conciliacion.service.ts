import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EstadoPedido, EstadoTareaErp, Prisma, TipoTareaErp } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { cerrarTareasConfirmadasPorEl } from '../pedidos/core/tareas-erp.util';
import { PedidoPagoHandler } from './handlers/pedido-pago.handler';
import type { ConciliacionDto } from './dto/conciliacion.dto';
import { conciliar, Hallazgo, TIPOS_CURADOS, TipoHallazgo } from './conciliacion.util';

/** Los pedidos cancelados dejan de verificarse pasado este tiempo (para no revisarlos para siempre). */
const DIAS_CANCELADOS = 30;

/**
 * Oct 2026 — la CONCILIACIÓN ACTIVA (destrabar, etapa 3). El agente pregunta qué pedidos de una tienda conviene
 * verificar, lee su estado real en `PEDIDOS` (Firebird) y lo devuelve; aquí se compara (`conciliar`, regla pura), se
 * corrige lo que el trigger habría corregido y se deja registro de lo demás.
 *
 * Qué se corrige SOLO: el cobro y la cancelación del Sistema Comercial que la nube no supo, y SOLO por el mismo
 * `PedidoPagoHandler` que usa el evento del trigger (misma transición, mismo correo, mismo historial, mismas tareas).
 * Eso no es una regla nueva: es lo que habría pasado si el evento no se hubiera perdido. Todo lo que toca dinero y no
 * tiene una respuesta obvia (un cobro en un pedido cancelado, un cobro desmarcado, un total distinto) NO se toca:
 * queda como hallazgo abierto en la salud del sistema, hasta que la siguiente comparación ya no lo encuentra.
 */
@Injectable()
export class ConciliacionService {
  private readonly logger = new Logger(ConciliacionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pedidoPago: PedidoPagoHandler,
  ) {}

  private async tiendaDe(externalId: number) {
    const tienda = await this.prisma.tienda.findUnique({
      where: { externalId },
      select: { id: true, externalId: true },
    });
    if (!tienda) throw new NotFoundException(`No hay tienda con externalId ${externalId}`);
    return tienda;
  }

  /**
   * Los pedidos de la tienda que ya viven en el Sistema Comercial (fila de envío PROCESADA con su `IDPEDIDO`) y cuyo
   * estado puede diverger: los que esperan pago o están pagados/enviados, los cancelados recientes, y los que tienen una
   * tarea o un hallazgo abierto (para poder cerrarlos). Paginado por `pedidoId` (`despues`).
   */
  async pendientes(tiendaExternalId: number, limit: number, despues: number) {
    const tienda = await this.tiendaDe(tiendaExternalId);
    const hace = new Date(Date.now() - DIAS_CANCELADOS * 24 * 3_600_000);
    const filas = await this.prisma.pedidoPendienteEnvio.findMany({
      where: {
        estado: 'PROCESADO',
        externalIdPEDIDOS: { not: null },
        pedido: {
          tiendaId: tienda.id,
          id: { gt: despues },
          OR: [
            {
              estado: {
                in: [EstadoPedido.PENDIENTE_PAGO, EstadoPedido.PAGADO, EstadoPedido.ENVIADO],
              },
            },
            {
              estado: EstadoPedido.CANCELADO,
              historial: {
                some: { estadoNuevo: EstadoPedido.CANCELADO, createdAt: { gte: hace } },
              },
            },
            { tareasErp: { some: { estado: EstadoTareaErp.PENDIENTE } } },
            { hallazgosErp: { some: { resueltoAt: null } } },
          ],
        },
      },
      orderBy: { pedidoId: 'asc' },
      take: limit + 1,
      select: { pedidoId: true, externalIdPEDIDOS: true },
    });
    const hayMas = filas.length > limit;
    const pagina = hayMas ? filas.slice(0, limit) : filas;
    return {
      tiendaId: tiendaExternalId,
      pedidos: pagina.map((f) => ({
        pedidoId: f.pedidoId,
        externalIdPEDIDOS: f.externalIdPEDIDOS as number,
      })),
      siguiente: hayMas ? pagina[pagina.length - 1].pedidoId : null,
    };
  }

  async aplicar(dto: ConciliacionDto) {
    const tienda = await this.tiendaDe(dto.tiendaId);
    const resumen = {
      revisados: 0,
      desconocidos: 0,
      curados: 0,
      hallazgosAbiertos: 0,
      tareasCerradas: 0,
    };

    for (const item of dto.pedidos) {
      const fila = await this.prisma.pedidoPendienteEnvio.findFirst({
        where: {
          estado: 'PROCESADO',
          externalIdPEDIDOS: item.externalIdPEDIDOS,
          pedido: { tiendaId: tienda.id },
        },
        select: {
          pedido: {
            select: {
              id: true,
              estado: true,
              total: true,
              numeroPedido: true,
              tareasErp: {
                where: { estado: EstadoTareaErp.PENDIENTE },
                select: { tipo: true },
              },
            },
          },
        },
      });
      // Un `IDPEDIDO` que la nube no reconoce (o de otra tienda) no es asunto de esta tienda.
      if (!fila) {
        resumen.desconocidos++;
        continue;
      }
      resumen.revisados++;
      const pedido = fila.pedido;

      const veredicto = conciliar(
        {
          existe: item.existe,
          swcancel: item.swcancel,
          finalizada: item.finalizada,
          total: item.total ?? null,
        },
        {
          estado: pedido.estado,
          total: Number(pedido.total.toString()),
          tareasAbiertas: pedido.tareasErp.map((t) => t.tipo),
        },
      );

      let hallazgos: Hallazgo[] = veredicto.hallazgos;

      // 1. Lo que el trigger habría avisado y no avisó: se aplica por el handler de siempre.
      let curado = false;
      if (veredicto.aplicar) {
        const r = await this.pedidoPago.procesar({
          eventId: `CONCILIACION:${pedido.id}:${Date.now()}`,
          bandejaId: 0,
          tipo: 'PAGO',
          operacion: 'U',
          entidad: 'PEDIDOS',
          localId: item.externalIdPEDIDOS,
          localTiendaId: tienda.externalId ?? undefined,
          datos: {
            SWCANCEL: veredicto.aplicar === 'CANCELACION',
            FINALIZADA: veredicto.aplicar === 'COBRO',
            IDFACTURA: item.idfactura ?? undefined,
            TTOTAL: item.total ?? undefined,
          },
        });
        if (r.ok) {
          curado = true;
          resumen.curados++;
          this.logger.warn(
            `Conciliación: pedido ${pedido.numeroPedido} (${veredicto.aplicar}) ya estaba así en el Sistema ` +
              `Comercial y la nube no lo sabía; se aplicó solo`,
          );
        } else {
          // El handler se negó (p. ej. una transición que la máquina de estados no permite): no se fuerza.
          this.logger.error(
            `Conciliación: no se pudo aplicar ${veredicto.aplicar} al pedido ${pedido.numeroPedido}: ${r.mensaje}`,
          );
          hallazgos = hallazgos
            .filter((h) => !TIPOS_CURADOS.includes(h.tipo))
            .concat({
              tipo: 'ESTADO_DISTINTO',
              detalle: { aplicar: veredicto.aplicar, motivo: r.mensaje },
            });
        }
      }

      // 2. Tareas que el Sistema Comercial ya cumplió.
      for (const tipo of veredicto.cerrarTareas) {
        resumen.tareasCerradas += await cerrarTareasConfirmadasPorEl(this.prisma, pedido.id, tipo);
      }

      // 3. Hallazgos: abrir/refrescar los que siguen, cerrar los que ya no se encuentran.
      resumen.hallazgosAbiertos += await this.registrar(tienda.id, pedido.id, hallazgos, curado);
    }

    await this.prisma.syncCheckpoint.upsert({
      where: { tiendaId: tienda.id },
      update: {
        ultimaConciliacionAt: new Date(),
        ultimaConciliacionRevisados: resumen.revisados,
      },
      create: {
        tiendaId: tienda.id,
        ultimaConciliacionAt: new Date(),
        ultimaConciliacionRevisados: resumen.revisados,
      },
    });
    return resumen;
  }

  /**
   * Deja los hallazgos del pedido al día. Devuelve cuántos quedan ABIERTOS.
   *  - Los que la nube corrigió sola (`curado`) nacen ya resueltos: son constancia, no trabajo pendiente.
   *  - Una fila abierta que sigue detectándose refresca `ultimaVezAt` y su detalle; una que ya no, se cierra.
   */
  private async registrar(
    tiendaId: number,
    pedidoId: number,
    hallazgos: Hallazgo[],
    curado: boolean,
  ): Promise<number> {
    const ahora = new Date();
    const abiertos = await this.prisma.conciliacionHallazgo.findMany({
      where: { pedidoId, resueltoAt: null },
      select: { id: true, tipo: true },
    });
    const vigentes = new Set<string>();
    let quedanAbiertos = 0;

    for (const h of hallazgos) {
      const esCurado = curado && (TIPOS_CURADOS as readonly TipoHallazgo[]).includes(h.tipo);
      if (esCurado) {
        await this.prisma.conciliacionHallazgo.create({
          data: {
            tiendaId,
            pedidoId,
            tipo: h.tipo,
            detalle: h.detalle as Prisma.InputJsonValue,
            curado: true,
            resueltoAt: ahora,
          },
        });
        continue;
      }
      vigentes.add(h.tipo);
      quedanAbiertos++;
      const existente = abiertos.find((a) => a.tipo === h.tipo);
      if (existente) {
        await this.prisma.conciliacionHallazgo.update({
          where: { id: existente.id },
          data: { ultimaVezAt: ahora, detalle: h.detalle as Prisma.InputJsonValue },
        });
      } else {
        try {
          await this.prisma.conciliacionHallazgo.create({
            data: { tiendaId, pedidoId, tipo: h.tipo, detalle: h.detalle as Prisma.InputJsonValue },
          });
        } catch (err) {
          // Dos comparaciones a la vez: el índice único parcial dejó pasar solo a una. La otra ya lo abrió.
          if ((err as { code?: string }).code !== 'P2002') throw err;
        }
      }
    }

    const aCerrar = abiertos.filter((a) => !vigentes.has(a.tipo)).map((a) => a.id);
    if (aCerrar.length > 0) {
      await this.prisma.conciliacionHallazgo.updateMany({
        where: { id: { in: aCerrar }, resueltoAt: null },
        data: { resueltoAt: ahora },
      });
    }
    return quedanAbiertos;
  }
}
