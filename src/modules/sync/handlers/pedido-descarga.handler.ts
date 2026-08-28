import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
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
  async poll(tiendaIdNube: number, limit: number, agentId: string) {
    const tienda = await this.prisma.tienda.findUnique({
      where: { id: tiendaIdNube },
      select: { externalId: true },
    });
    if (!tienda?.externalId) {
      this.logger.warn(`Tienda ${tiendaIdNube} sin externalId configurado`);
      return [];
    }

    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 60_000);
    const pendientes = await this.prisma.$transaction(async (tx) => {
      const candidatos = await tx.pedidoPendienteEnvio.findMany({
        where: {
          pedido: { tiendaId: tiendaIdNube, estado: { not: 'CANCELLED' } },
          nextAttemptAt: { lte: now },
          OR: [
            { estado: 'PENDIENTE' },
            { estado: 'RETRY' },
            { estado: 'PROCESSING', leaseUntil: { lt: now } },
            { estado: 'ERROR', leaseUntil: { lt: now } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: { id: true, pedidoId: true },
      });

      const claimed: number[] = [];
      for (const candidato of candidatos) {
        const leaseToken = randomUUID();
        const result = await tx.pedidoPendienteEnvio.updateMany({
          where: {
            id: candidato.id,
            OR: [
              { estado: 'PENDIENTE' },
              { estado: 'RETRY' },
              { estado: 'PROCESSING', leaseUntil: { lt: now } },
              { estado: 'ERROR', leaseUntil: { lt: now } },
            ],
          },
          data: {
            estado: 'PROCESSING',
            claimedBy: agentId,
            leaseToken,
            leaseUntil,
            ultimoIntentoAt: now,
          },
        });
        if (result.count === 1) claimed.push(candidato.id);
      }

      return tx.pedidoPendienteEnvio.findMany({
        where: { id: { in: claimed } },
        include: {
          pedido: {
            include: {
              items: {
                where: { cancelada: false },
                include: {
                  precioCO: {
                    select: {
                      id: true,
                      productoId: true,
                      corridaId: true,
                      colorId: true,
                    },
                  },
                },
              },
              usuario: { select: { id: true, email: true } },
            },
          },
        },
      });
    });

    if (pendientes.length === 0) return [];

    const leaseByPedido = new Map(
      pendientes.map((p) => [p.pedidoId, p.leaseToken]),
    );
    const leaseUntilByPedido = new Map(
      pendientes.map((p) => [p.pedidoId, p.leaseUntil]),
    );

    // Necesitamos el externalId de la tienda para resolver PrecioCO local.
    const localTiendaId = tienda.externalId;

    const result = await Promise.all(
      pendientes.map(async (p) => {
        const items = await Promise.all(
          p.pedido.items.map(async (it) => {
            const pco = it.precioCO;
            const [localPrecioCOId, localProductoId, localCorridaId, localColorId] =
              pco
                ? await Promise.all([
                    this.externalRefs.findLocalId(
                      'PRECIOCO',
                      pco.id,
                      'PRECIOSCO',
                      localTiendaId,
                    ),
                    this.externalRefs.findLocalId(
                      'PRODUCTO',
                      pco.productoId,
                      'PRODUCTOS',
                    ),
                    this.externalRefs.findLocalId(
                      'CORRIDA',
                      pco.corridaId,
                      'CORRIDAS',
                    ),
                    this.externalRefs.findLocalId(
                      'COLOR',
                      pco.colorId,
                      'COLORES',
                    ),
                  ])
                : [null, null, null, null];

            const skip = [
              localPrecioCOId,
              localProductoId,
              localCorridaId,
              localColorId,
            ].some((id) => id == null);

            return {
              itemId: it.id,
              productoCodigo: it.productoCodigo,
              cantidad: it.cantidad,
              precioUnitario: Number(it.precioUnitario),
              subtotal: Number(it.subtotal),
              talla: it.tallaNombre,
              corridaNombre: it.corridaNombre,
              colorNombre: it.colorNombre,
              localPrecioCOId,
              localProductoId,
              localCorridaId,
              localColorId,
              skip,
            };
          }),
        );

        // Skip si el pedido fue cancelado entre el claim y el armado del
        // payload (ventana pequeña pero posible). La entrada de cola queda
        // en estado terminal CANCELADO — el poll no la vuelve a elegir.
        if (p.pedido.estado === 'CANCELLED') {
          await this.prisma.pedidoPendienteEnvio.updateMany({
            where: {
              id: p.id,
              estado: 'PROCESSING',
              leaseToken: p.leaseToken,
            },
            data: {
              estado: 'CANCELADO',
              claimedBy: null,
              leaseToken: null,
              leaseUntil: null,
              processedAt: new Date(),
              ultimoErrorCode: 'PEDIDO_CANCELADO',
              ultimoError: 'Pedido cancelado en la nube antes de bajarse a Firebird',
            },
          });
          return null;
        }

        if (items.some((item) => item.skip)) {
          await this.prisma.pedidoPendienteEnvio.updateMany({
            where: {
              id: p.id,
              estado: 'PROCESSING',
              leaseToken: p.leaseToken,
            },
            data: {
              estado: 'RETRY',
              nextAttemptAt: new Date(Date.now() + 60_000),
              claimedBy: null,
              leaseToken: null,
              leaseUntil: null,
              ultimoErrorCode: 'MISSING_EXTERNAL_REFERENCE',
              ultimoError: 'Falta referencia local para una variante del pedido',
            },
          });
          return null;
        }

        return {
          pedidoId: p.pedidoId,
          tiendaId: tiendaIdNube,
          leaseToken: leaseByPedido.get(p.pedidoId),
          leaseUntil: leaseUntilByPedido.get(p.pedidoId),
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

    return result.filter((pedido): pedido is NonNullable<typeof pedido> => pedido !== null);
  }
}
