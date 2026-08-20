import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ExternalRefService } from '../external-ref.service';

/**
 * PedidoDescargaHandler: arma el payload que el agente consume vía
 * GET /api/sync/agent/poll-pedidos para bajar pedidos nuevos a Firebird.
 *
 * El agente recibe:
 *   - El pedido nube con datos del cliente, totales, modo de entrega.
 *   - Para cada item: productoCodigo, cantidad, precioUnitario, subtotal,
 *     y los IDs LOCALES de Firebird para variante (PrecioCO.id local),
 *     producto (PRODUCTOS.IDPRODUCTO), corrida (CORRIDAS.IDCORRIDA) y
 *     color (COLORES.IDCOLOR) — resueltos vía ExternalRef.
 *   - Si alguna dependencia no tiene mapeo, el item se marca con
 *     `skip=true` y se omite (la sucursal lo creará después de la
 *     primera sincronización de catálogo).
 */
@Injectable()
export class PedidoDescargaHandler {
  private readonly logger = new Logger(PedidoDescargaHandler.name);

  constructor(
    private prisma: PrismaService,
    private externalRefs: ExternalRefService,
  ) {}

  /**
   * Devuelve hasta `limit` pedidos pendientes de la tienda `tiendaId`.
   * Para cada pedido, incluye items con los IDs locales ya resueltos.
   */
  async poll(tiendaIdNube: number, limit: number) {
    const pendientes = await this.prisma.pedidoPendienteEnvio.findMany({
      where: {
        estado: 'PENDIENTE',
        pedido: { tiendaId: tiendaIdNube },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: {
        pedido: {
          include: {
            items: {
              where: { cancelada: false },
              include: { precioCO: { select: { id: true, productoId: true } } },
            },
            usuario: { select: { id: true, email: true } },
          },
        },
      },
    });

    if (pendientes.length === 0) return [];

    // Necesitamos el externalId de la tienda para resolver PrecioCO local.
    const tienda = await this.prisma.tienda.findUnique({
      where: { id: tiendaIdNube },
      select: { externalId: true },
    });
    if (!tienda?.externalId) {
      this.logger.warn(`Tienda ${tiendaIdNube} sin externalId configurado`);
      return [];
    }
    const localTiendaId = tienda.externalId;

    const result = await Promise.all(
      pendientes.map(async (p) => {
        const items = await Promise.all(
          p.pedido.items.map(async (it) => {
            const pcoLocalId = it.precioCOId
              ? await this.externalRefs.findLocalId(
                  'PRECIOCO',
                  it.precioCOId,
                  'PRECIOSCO',
                  localTiendaId,
                )
              : null;

            const skip = pcoLocalId == null;

            return {
              itemId: it.id,
              productoCodigo: it.productoCodigo,
              cantidad: it.cantidad,
              precioUnitario: Number(it.precioUnitario),
              subtotal: Number(it.subtotal),
              talla: it.tallaNombre,
              corridaNombre: it.corridaNombre,
              colorNombre: it.colorNombre,
              localPrecioCOId: pcoLocalId,
              skip,
            };
          }),
        );

        return {
          pedidoId: p.pedidoId,
          externalIdPEDIDOS: p.externalIdPEDIDOS,
          numeroPedido: p.pedido.numeroPedido,
          fechaPedido: p.pedido.fechaPedido,
          clienteNombre: p.pedido.clienteNombre,
          clienteEmail: p.pedido.clienteEmail,
          clienteTelefono: p.pedido.clienteTelefono,
          shippingDireccion: p.pedido.shippingDireccion,
          shippingColonia: p.pedido.shippingColonia,
          shippingCodigoPostal: p.pedido.shippingCodigoPostal,
          shippingPaqueteria: p.pedido.shippingPaqueteria,
          notas: p.pedido.notas,
          subtotal: Number(p.pedido.subtotal),
          total: Number(p.pedido.total),
          estado: p.pedido.estado,
          modoEntrega: p.pedido.modoEntrega,
          items,
        };
      }),
    );

    return result;
  }
}
