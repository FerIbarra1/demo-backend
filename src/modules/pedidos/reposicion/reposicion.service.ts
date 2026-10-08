import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { UserContext } from '../../../types/pedido.types';
import { EstadoReposicion, Prisma } from '@prisma/client';

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
   */
  async crearDesdePedido(
    tx: Prisma.TransactionClient,
    pedidoId: number,
    motivo?: string,
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
    //
    // `cantidad` se normaliza a lo que de verdad salió del anaquel
    // (`cantidadSurtida`), igual que en `crearDesdeAjuste`.
    const items = await tx.itemPedido.findMany({
      where: {
        pedidoId,
        // Activos, o cancelados con piezas apartadas (esas también vuelven).
        OR: [{ cancelada: false }, { cancelada: true, cantidadSurtida: { gt: 0 } }],
      },
      select: {
        id: true,
        productoNombre: true,
        productoCodigo: true,
        corridaNombre: true,
        tallaNombre: true,
        colorNombre: true,
        cantidad: true,
        cantidadSurtida: true,
        estadoSurtido: true,
      },
      orderBy: { id: 'asc' },
    });

    await tx.pedidoReposicion.create({
      data: {
        pedidoId,
        estado: EstadoReposicion.PENDIENTE,
        items: items as unknown as Prisma.InputJsonValue,
        motivo: motivo ?? null,
      },
    });

    this.logger.log(`Pedido ${pedidoId}: entrada de reposición creada (${items.length} item(s))`);
  }

  /**
   * F17 (oct 2026): reposición de lo que un AJUSTE retiró del pedido.
   *
   * A diferencia de `crearDesdePedido` (que corre al CANCELAR y snapshotea
   * TODOS los items activos porque el pedido entero muere), aquí el pedido
   * sigue vivo: solo salieron algunas prendas. El snapshot es únicamente de
   * esas — las que el ajuste canceló y que están físicamente en la bolsa de la
   * plancha.
   *
   * Sin esto, un ajuste que quita 5 prendas no generaba ninguna lista: la
   * mercancía se quedaba apartada sin que nadie la devolviera al anaquel.
   *
   * Idempotente por pedido (mismo `pedidoId` @unique que `crearDesdePedido`).
   * Si el pedido YA tiene una reposición (p. ej. de una cancelación anterior),
   * se AGREGAN los items nuevos al JSON en vez de descartarlos: el pedido puede
   * acumular retiros de varios ajustes.
   */
  async crearDesdeAjuste(
    tx: Prisma.TransactionClient,
    pedidoId: number,
    motivo?: string,
    /**
     * F17: las piezas que había en la bolsa al momento de retirar cada item,
     * capturadas ANTES de que el ajuste pusiera `cantidadSurtida: 0`.
     *
     * Hace falta pasarlas porque el ajuste borra ese campo al cancelar, así que
     * releerlo aquí devolvería 0 y la lista saldría vacía (bug encontrado en la
     * prueba end-to-end). Si no se pasa, se cae al `cantidadSurtida` del item,
     * que sirve para items cancelados por otros caminos.
     */
    piezasPorItem?: Map<number, number>,
  ): Promise<void> {
    // Los items retirados: cancelados y con algo que devolver al anaquel.
    const retirados = await tx.itemPedido.findMany({
      where: { pedidoId, cancelada: true },
      select: {
        id: true,
        productoNombre: true,
        productoCodigo: true,
        corridaNombre: true,
        tallaNombre: true,
        colorNombre: true,
        cantidad: true,
        cantidadSurtida: true,
        estadoSurtido: true,
      },
      orderBy: { id: 'asc' },
    });

    // La cantidad a reponer es lo que SALIÓ de la bolsa, no lo que el cliente
    // había pedido. Se prefiere el valor capturado antes del ajuste; si no
    // viene, el `cantidadSurtida` del item.
    const aReponer = retirados
      .map((i) => ({
        ...i,
        cantidad: piezasPorItem?.get(i.id) ?? i.cantidadSurtida,
      }))
      .filter((i) => i.cantidad > 0);
    if (aReponer.length === 0) return;

    const existente = await tx.pedidoReposicion.findUnique({
      where: { pedidoId },
      select: { id: true, items: true },
    });

    if (!existente) {
      await tx.pedidoReposicion.create({
        data: {
          pedidoId,
          estado: EstadoReposicion.PENDIENTE,
          items: aReponer as unknown as Prisma.InputJsonValue,
          motivo: motivo ?? 'Ajuste del pedido',
        },
      });
      this.logger.log(
        `Pedido ${pedidoId}: reposición por ajuste creada (${aReponer.length} item(s))`,
      );
      return;
    }

    // Ya había una lista. Si sigue PENDIENTE, se le suman los retiros nuevos
    // (sin duplicar los que ya estaban). Si ya se confirmó como REPUESTO, se
    // reabre: hay mercancía nueva que volver a acomodar.
    const previos = Array.isArray(existente.items) ? (existente.items as any[]) : [];
    const idsPrevios = new Set(previos.map((p) => p.id));
    const nuevos = aReponer.filter((i) => !idsPrevios.has(i.id));
    if (nuevos.length === 0) return;

    await tx.pedidoReposicion.update({
      where: { pedidoId },
      data: {
        items: [...previos, ...nuevos] as unknown as Prisma.InputJsonValue,
        estado: EstadoReposicion.PENDIENTE,
        repuestoAt: null,
        repuestoPorId: null,
      },
    });

    this.logger.log(
      `Pedido ${pedidoId}: ${nuevos.length} item(s) agregados a la reposición existente`,
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
