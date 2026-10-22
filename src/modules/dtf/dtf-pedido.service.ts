import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EstadoPedido, ModoEntrega, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UserContext } from '../../types/pedido.types';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { recalcularTotalesPedido } from '../pedidos/core/totales.util';
import { contarDtfPendientes } from './core/dtf-estado.util';

/**
 * Lo que el pedido hace cuando cambia un trabajo DTF (PLAN-DTF.md §5.2). El pedido solo sabe si le queda
 * DTF por imprimir; el detalle vive en el trabajo.
 */
@Injectable()
export class DtfPedidoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: PedidoStateService,
  ) {}

  /**
   * Un trabajo quedó impreso, rechazado o cancelado (o cambió su cotización): recalcula el total del
   * pedido y, si ya no queda DTF por imprimir, lo saca de `EN_DTF`:
   *   · recoger en tienda → REVISADO (la plancha: el correo "listo en tienda" sale solo);
   *   · DOMICILIO → PENDIENTE_PAGO con encolado a Firebird (no pasa por mostrador);
   *   · si no queda NADA vivo (todo rechazado/cancelado y sin prendas) → CANCELADO.
   */
  async resolver(pedidoId: number, actor: UserContext): Promise<void> {
    const r = await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({
        where: { id: pedidoId },
        include: { items: { where: { cancelada: false }, select: { id: true } } },
      });
      if (!pedido) return null;
      await recalcularTotalesPedido(tx, pedido);
      if (pedido.estado !== EstadoPedido.EN_DTF) return null;
      if ((await contarDtfPendientes(tx, pedidoId)) > 0) return null;

      const impresos = await tx.pedidoDtf.count({ where: { pedidoId, estado: 'IMPRESO' } });
      if (pedido.items.length === 0 && impresos === 0) {
        return this.state.cambiarEstado(
          pedidoId,
          {
            nuevoEstado: EstadoPedido.CANCELADO,
            observacion:
              'Todos los trabajos DTF fueron rechazados o cancelados y el pedido no tiene prendas',
          },
          actor,
          { tx, asignacion: 'limpiar', reloj: 'detener', invalidarMonitor: true },
        );
      }
      const domicilio = pedido.modoEntrega === ModoEntrega.DOMICILIO;
      return this.state.cambiarEstado(
        pedidoId,
        {
          nuevoEstado: domicilio ? EstadoPedido.PENDIENTE_PAGO : EstadoPedido.REVISADO,
          observacion: domicilio
            ? 'DTF impreso — pendiente de pago (se enviará por paquetería)'
            : 'DTF impreso — pasa al área de entrega',
        },
        actor,
        { tx, encolarFirebird: domicilio, invalidarMonitor: true },
      );
    });
    const efectos = (
      r as { efectos?: Parameters<PedidoStateService['dispararEfectosDeTransicion']>[1] } | null
    )?.efectos;
    if (efectos) this.state.dispararEfectosDeTransicion(pedidoId, efectos);
  }

  /** Reimpresión de un DTF que ya estaba en la plancha / en atención: el pedido vuelve a esperar. */
  async reabrir(pedidoId: number, actor: UserContext, motivo: string): Promise<void> {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { estado: true },
    });
    if (!pedido) return;
    if (pedido.estado !== EstadoPedido.REVISADO && pedido.estado !== EstadoPedido.EN_ATENCION)
      return;
    const r = await this.prisma.$transaction((tx) =>
      this.state.cambiarEstado(
        pedidoId,
        { nuevoEstado: EstadoPedido.EN_DTF, observacion: `Se reimprime un DTF (${motivo})` },
        actor,
        { tx, invalidarMonitor: true },
      ),
    );
    this.state.dispararEfectosDeTransicion(
      pedidoId,
      (
        r as unknown as {
          efectos: Parameters<PedidoStateService['dispararEfectosDeTransicion']>[1];
        }
      ).efectos,
    );
  }
}

/** Alta de los borradores en el pedido que se acaba de crear. Sin DI: lo llama `ClienteService` dentro de su transacción. */
export async function adjuntarBorradoresAPedido(
  tx: Prisma.TransactionClient,
  p: {
    pedidoId: number;
    usuarioId: number;
    tiendaId: number;
    trabajos: { trabajoId: number; sinArchivo?: boolean }[];
  },
): Promise<{ total: Prisma.Decimal; cantidad: number; huboSinArchivo: boolean }> {
  let total = new Prisma.Decimal(0);
  let huboSinArchivo = false;
  const ahora = new Date();
  for (const t of p.trabajos) {
    const fila = await tx.pedidoDtf.findUnique({
      where: { id: t.trabajoId },
      include: { archivos: { select: { version: true, preflightEstado: true } } },
    });
    if (!fila || fila.usuarioId !== p.usuarioId)
      throw new NotFoundException(`El trabajo DTF ${t.trabajoId} no existe`);
    if (fila.tiendaId !== p.tiendaId)
      throw new BadRequestException(`El trabajo DTF "${fila.nombre}" es de otra tienda`);
    if (fila.estado !== 'BORRADOR' || fila.pedidoId)
      throw new ConflictException(`El trabajo DTF "${fila.nombre}" ya está en un pedido`);
    const vigente = fila.archivos.find((a) => a.version === fila.versionVigente);
    const sinArchivo = !vigente;
    if (sinArchivo && !t.sinArchivo)
      throw new BadRequestException(
        `Falta el archivo de "${fila.nombre}". Súbelo o indica que lo entregarás en tienda.`,
      );
    if (vigente?.preflightEstado === 'BLOQUEADO')
      throw new BadRequestException(
        `El archivo de "${fila.nombre}" tiene errores que impiden imprimirlo. Corrígelo y súbelo de nuevo.`,
      );
    const r = await tx.pedidoDtf.updateMany({
      where: { id: fila.id, estado: 'BORRADOR', pedidoId: null },
      data: {
        pedidoId: p.pedidoId,
        estado: sinArchivo ? 'ARCHIVO_PENDIENTE' : 'RECIBIDO',
        recibidoAt: ahora,
        expiraAt: null,
      },
    });
    if (r.count !== 1)
      throw new ConflictException(`El trabajo DTF "${fila.nombre}" cambió mientras se procesaba`);
    await tx.pedidoDtfEvento.create({
      data: {
        dtfId: fila.id,
        tipo: 'AGREGADO_AL_PEDIDO',
        deEstado: 'BORRADOR',
        aEstado: sinArchivo ? 'ARCHIVO_PENDIENTE' : 'RECIBIDO',
        actorId: p.usuarioId,
        actorRol: 'CLIENTE',
      },
    });
    total = total.plus(fila.subtotal);
    huboSinArchivo = huboSinArchivo || sinArchivo;
  }
  return { total, cantidad: p.trabajos.length, huboSinArchivo };
}
