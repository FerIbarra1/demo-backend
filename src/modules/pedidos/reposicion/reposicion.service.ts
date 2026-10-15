import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { UserContext } from '../../../types/pedido.types';
import { EstadoReposicion, Prisma } from '@prisma/client';
import { piezasEnLaBolsa } from '../core/ajuste-cantidad.util';

/**
 * F13 (sep 2026): lista de reposición de bodega.
 *
 * Cuando el cliente RECHAZA una propuesta (o cancela durante la asesoría), el
 * pedido se cancela y los productos que bodega ya había apartado tienen que
 * volver físicamente al anaquel.
 *
 * IMPORTANTE: esto NO es un contador de inventario. El modelo B2B no maneja
 * stock (el modelo `Stock` se eliminó en el refactor B2B — ver el comentario
 * sobre `PrecioCO` en el schema). Es una lista de trabajo con confirmación
 * humana: bodega ve qué reponer y marca cuando ya volvió al anaquel.
 *
 * 1:1 con Pedido. Solo se crea al cancelar por rechazo del cliente; una
 * cancelación que viene de Firebird (SWCANCEL) no la crea, porque en ese caso
 * el ERP ya sabe que el pedido murió.
 *
 * Y SOLO DE LO QUE YA SALIÓ DE LAS MANOS DE BODEGA (oct 2026). Si el pedido se
 * cancela mientras bodega lo tiene (sin surtir o a medias), el bodeguero lo trae
 * en las manos, recibe el aviso de cancelación (`pedido.cancelado-en-bodega`) y
 * lo regresa al anaquel él mismo: no hay lista. Ver `bolsaEnManosDeBodega`.
 *
 * LA REPOSICIÓN ES SOLO DE PEDIDOS CANCELADOS O RECHAZADOS (oct 2026). Un AJUSTE
 * (de mostrador o de ventas) NO genera reposición: el pedido sigue vivo y las
 * piezas que salen las saca el bodeguero de la bolsa del área de entrega y las
 * regresa al anaquel él mismo, con el checklist de retiro, mientras hace el
 * ajuste. F17 hacía lo contrario (`crearDesdeAjuste`): además de sacarlas, las
 * listaba en reposición, así que el bodeguero las acomodaba y la lista le
 * pedía acomodarlas otra vez. El método se eliminó; no lo recrees.
 */
@Injectable()
export class ReposicionService {
  private readonly logger = new Logger(ReposicionService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
  ) {}

  /**
   * Crea la entrada de reposición para un pedido cancelado. Se llama DENTRO
   * de la transacción que cancela el pedido, para que cancelación y lista sean
   * atómicas.
   *
   * Idempotente: si ya existe una entrada para el pedido, no hace nada (un
   * segundo rechazo no debería duplicar la lista).
   *
   * Solo entran las piezas que HAY en la bolsa del área de entrega
   * (`cantidadSurtida − piezasRetiradas`). Quedan fuera:
   *
   *   - lo que nadie ha surtido (`cantidadSurtida: 0`): no hay nada que devolver.
   *     Antes el código caía a `cantidad` (lo PEDIDO) y un pedido cancelado en
   *     SOLICITADO mandaba a bodega a "reponer" mercancía que jamás salió del
   *     anaquel;
   *   - lo que un ajuste anterior ya sacó: el bodeguero lo regresó él mismo.
   *
   * `opts.bolsaEnManosDeBodega`: el pedido se cancela mientras bodega lo tiene
   * (ver `bolsaEnManosDeBodega`). No hay nada que listar — el bodeguero lo trae en
   * las manos y lo regresa solo — pero la fila SE CREA igual, ya resuelta
   * (`REPUESTO`, sin piezas): `motivo` no es solo del piso, `NotificationsService`
   * lo lee como `motivoCancelacion` para el correo de cancelación, así que omitir
   * la fila le quitaría al cliente la razón. Resuelta, no aparece en la lista
   * pendiente ni en el contador.
   */
  async crearDesdePedido(
    tx: Prisma.TransactionClient,
    pedidoId: number,
    motivo?: string,
    opts: { bolsaEnManosDeBodega?: boolean } = {},
  ): Promise<void> {
    const existente = await tx.pedidoReposicion.findUnique({
      where: { pedidoId },
      select: { id: true },
    });
    if (existente) return;

    // Snapshot de los items que bodega había apartado. Se guarda como JSON
    // para que la lista no cambie aunque el pedido se modifique después.
    //
    // F18 (oct 2026): se incluyen TAMBIÉN los cancelados que sí tenían piezas
    // apartadas. Antes se filtraba `cancelada: false`, así que los items que
    // bodega marcó `NO_DISPONIBLE` al cerrar el surtido **nunca entraban a la
    // lista** — esa mercancía no volvía al anaquel por ningún camino.
    const items = opts.bolsaEnManosDeBodega
      ? []
      : await tx.itemPedido.findMany({
          where: { pedidoId, cantidadSurtida: { gt: 0 } },
          select: {
            id: true,
            productoNombre: true,
            productoCodigo: true,
            corridaNombre: true,
            tallaNombre: true,
            colorNombre: true,
            cantidad: true,
            cantidadSurtida: true,
            piezasRetiradas: true,
            estadoSurtido: true,
          },
          orderBy: { id: 'asc' },
        });

    // `cantidad` se NORMALIZA a lo que de verdad está en la bolsa, que es lo
    // único que puede volver al anaquel.
    //
    // F21 (oct 2026): antes guardaba el item crudo, así que un pedido colapsado
    // (20 pedidas, 10 apartadas) le pedía a bodega reponer 20 piezas de las que
    // solo salieron 10.
    //
    // Oct 2026 (ajustes): además se DESCUENTA lo que el bodeguero ya sacó en un
    // ajuste anterior (`piezasRetiradas`). Esas piezas ya las regresó él al
    // anaquel; sin descontarlas, un pedido ajustado que luego se cancela las
    // listaba otra vez — el mismo "ya lo acomodé y me vuelve a salir", ahora por
    // la puerta de la cancelación. Una línea que se quitó en un ajuste y cuyas
    // piezas ya se sacaron queda en 0 y no entra a la lista.
    const aReponer = items
      .map(({ piezasRetiradas, ...i }) => ({
        ...i,
        cantidad: piezasEnLaBolsa({ ...i, piezasRetiradas }),
      }))
      .filter((i) => i.cantidad > 0);

    // Sin nada que devolver la fila nace resuelta: ver el comentario del método.
    const hayQueReponer = aReponer.length > 0;
    await tx.pedidoReposicion.create({
      data: {
        pedidoId,
        estado: hayQueReponer ? EstadoReposicion.PENDIENTE : EstadoReposicion.REPUESTO,
        repuestoAt: hayQueReponer ? null : new Date(),
        items: aReponer as unknown as Prisma.InputJsonValue,
        motivo: motivo ?? null,
      },
    });

    this.logger.log(
      hayQueReponer
        ? `Pedido ${pedidoId}: entrada de reposición creada (${aReponer.length} item(s))`
        : `Pedido ${pedidoId}: nada que reponer (${
            opts.bolsaEnManosDeBodega ? 'bodega lo tiene en las manos' : 'sin piezas en la bolsa'
          })`,
    );
  }

  /**
   * Lista de reposición pendiente de la tienda. La consume la tablet de
   * bodega para saber qué mercancía tiene que volver al anaquel.
   */
  async listarPendientes(tiendaId: number, pagina = 1, limite = 20) {
    const skip = (pagina - 1) * limite;
    const where: Prisma.PedidoReposicionWhereInput = {
      estado: EstadoReposicion.PENDIENTE,
      pedido: { tiendaId },
    };
    const [reposiciones, total] = await Promise.all([
      this.prisma.pedidoReposicion.findMany({
        where,
        include: {
          pedido: {
            select: {
              id: true,
              numeroPedido: true,
              clienteNombre: true,
              fechaPedido: true,
            },
          },
        },
        orderBy: { creadaAt: 'asc' },
        skip,
        take: limite,
      }),
      this.prisma.pedidoReposicion.count({ where }),
    ]);

    return {
      data: reposiciones,
      meta: { total, pagina, limite, totalPaginas: Math.ceil(total / limite) },
    };
  }

  /**
   * Bodega confirma que la mercancía volvió al anaquel.
   */
  async confirmarRepuesto(pedidoId: number, usuario: UserContext) {
    const reposicion = await this.prisma.pedidoReposicion.findUnique({
      where: { pedidoId },
      include: { pedido: { select: { tiendaId: true } } },
    });
    if (!reposicion) {
      throw new NotFoundException('No hay reposición pendiente para este pedido');
    }
    if (reposicion.estado === EstadoReposicion.REPUESTO) {
      throw new BadRequestException('Esta reposición ya fue confirmada');
    }
    // Defensa en profundidad: el pedido debe ser de la tienda del bodeguero.
    if (usuario.tiendaId && reposicion.pedido.tiendaId !== usuario.tiendaId) {
      throw new BadRequestException('El pedido pertenece a otra tienda');
    }

    const actualizada = await this.prisma.pedidoReposicion.update({
      where: { pedidoId },
      data: {
        estado: EstadoReposicion.REPUESTO,
        repuestoAt: new Date(),
        repuestoPorId: usuario.userId,
      },
    });

    this.realtime.emitToTienda(reposicion.pedido.tiendaId, 'reposicion.repuesta', {
      pedidoId,
    });

    this.logger.log(`Pedido ${pedidoId}: reposición confirmada por ${usuario.nombre}`);

    return actualizada;
  }

  /**
   * Cuántas reposiciones pendientes tiene la tienda (para el badge de la UI).
   */
  async contarPendientes(tiendaId: number): Promise<number> {
    return this.prisma.pedidoReposicion.count({
      where: {
        estado: EstadoReposicion.PENDIENTE,
        pedido: { tiendaId },
      },
    });
  }
}
