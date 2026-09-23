import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../imagenes/storage.service';
import { EstadoPedido, Prisma } from '@prisma/client';

/**
 * F13 (sep 2026): servicio del dominio VENTAS (asesor de ventas).
 *
 * Hay UN asesor por tienda, sin asignación 1:1: ve la cola de pedidos que los
 * clientes escalaron desde una propuesta de bodega, y atiende a todos.
 *
 * Responsabilidad:
 *   - Cola de pedidos en EN_ASESORIA de su tienda.
 *   - Detalle de un pedido con contexto para negociar (items, historial de
 *     propuestas, chat).
 *   - El borrador de la contrapropuesta lo arma el frontend y lo envía por
 *     `PropuestaService.enviarPropuesta` (que ya valida el rol VENTAS).
 *
 * Lo que NO hace: no transiciona estados por su cuenta. Las transiciones
 * viven en `PedidoStateService` / `PropuestaService`.
 */
/**
 * F14 (sep 2026): filtros de la cola de asesoría.
 *
 *   todos       — todo lo que el asesor tiene entre manos.
 *   atender     — el turno es del asesor: el cliente pidió hablar con él,
 *                 o rechazó una propuesta de ventas.
 *   esperando   — el turno es del cliente: ya se le mandó una propuesta.
 *   respondidos — subconjunto de `atender`: pedidos que volvieron PORQUE el
 *                 cliente respondió (rechazó) una propuesta de ventas.
 */
export type FiltroCola = 'todos' | 'atender' | 'esperando' | 'respondidos';

export const FILTROS_COLA: FiltroCola[] = [
  'todos',
  'atender',
  'esperando',
  'respondidos',
];

/** Predicado de "el cliente ya me respondió una propuesta". */
const RESPONDIO_PROPUESTA_VENTAS: Prisma.PedidoWhereInput = {
  propuestas: { some: { creadaPorRol: 'VENTAS', estado: 'RECHAZADA' } },
};

/** Predicado de "le mandé una propuesta y espero su respuesta". */
const ESPERANDO_CLIENTE: Prisma.PedidoWhereInput = {
  estado: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
  propuestas: { some: { creadaPorRol: 'VENTAS', estado: 'PENDIENTE' } },
};

@Injectable()
export class VentasService {
  private readonly logger = new Logger(VentasService.name);

  constructor(
    private prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Cola de pedidos escalados a asesoría en la tienda del vendedor.
   *
   * Incluye tanto EN_ASESORIA (recién escalados, sin propuesta enviada) como
   * WAITING_CUSTOMER_APPROVAL con propuesta de VENTAS pendiente (el vendedor
   * ya propuso y espera al cliente) — así el vendedor ve en una sola lista
   * todo lo que tiene entre manos, con un flag que distingue cada caso.
   */
  async obtenerCola(
    tiendaId: number,
    pagina = 1,
    limite = 20,
    filtro: FiltroCola = 'todos',
  ) {
    const skip = (pagina - 1) * limite;
    const where: Prisma.PedidoWhereInput = {
      tiendaId,
      ...(filtro === 'atender'
        ? { estado: EstadoPedido.EN_ASESORIA }
        : filtro === 'esperando'
          ? ESPERANDO_CLIENTE
          : filtro === 'respondidos'
            ? { estado: EstadoPedido.EN_ASESORIA, ...RESPONDIO_PROPUESTA_VENTAS }
            : {
                OR: [
                  { estado: EstadoPedido.EN_ASESORIA },
                  ESPERANDO_CLIENTE,
                ],
              }),
    };

    const [pedidos, total, cTodos, cAtender, cEsperando, cRespondidos] =
      await Promise.all([
        this.prisma.pedido.findMany({
          where,
          include: {
            items: { where: { cancelada: false }, orderBy: { id: 'asc' } },
            tienda: { select: { id: true, nombre: true } },
            usuario: { select: { id: true, nombre: true, email: true, telefono: true } },
            // La propuesta de bodega que originó el escalado, para que el
            // vendedor vea qué fue lo que el bodeguero no encontró.
            propuestas: {
              orderBy: { enviadaAt: 'desc' },
              take: 3,
              include: {
                creadaPor: { select: { id: true, nombre: true, apellido: true } },
              },
            },
            // Últimos mensajes para previsualizar la conversación.
            mensajes: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true, contenido: true, createdAt: true, autorRol: true },
            },
          },
          // En 'esperando' el pedido lleva ahí desde que se envió la
          // propuesta, no desde que el cliente pidió asesor; ordenar por
          // asesorSolicitadoAt dejaría arriba los más viejos por la razón
          // equivocada. El id es un proxy de "propuesta más reciente".
          orderBy:
            filtro === 'esperando'
              ? { id: 'desc' }
              : { asesorSolicitadoAt: 'asc' },
          skip,
          take: limite,
        }),
        this.prisma.pedido.count({ where }),
        // Conteos por filtro para las etiquetas de los tabs.
        this.prisma.pedido.count({
          where: {
            tiendaId,
            OR: [{ estado: EstadoPedido.EN_ASESORIA }, ESPERANDO_CLIENTE],
          },
        }),
        this.prisma.pedido.count({
          where: { tiendaId, estado: EstadoPedido.EN_ASESORIA },
        }),
        this.prisma.pedido.count({ where: { tiendaId, ...ESPERANDO_CLIENTE } }),
        this.prisma.pedido.count({
          where: {
            tiendaId,
            estado: EstadoPedido.EN_ASESORIA,
            ...RESPONDIO_PROPUESTA_VENTAS,
          },
        }),
      ]);

    const ahora = new Date();
    return {
      data: pedidos.map((p) => ({
        ...p,
        total: Number(p.total),
        // Cuánto lleva esperando el cliente desde que pidió asesor.
        minutosEsperando: p.asesorSolicitadoAt
          ? Math.max(0, Math.floor((ahora.getTime() - p.asesorSolicitadoAt.getTime()) / 60000))
          : 0,
        // Distingue "recién escalado, no he propuesto" de "ya propuse, espero
        // respuesta del cliente".
        esperandoCliente: p.estado === EstadoPedido.WAITING_CUSTOMER_APPROVAL,
      })),
      meta: {
        total,
        pagina,
        limite,
        totalPaginas: Math.ceil(total / limite),
        conteos: {
          todos: cTodos,
          atender: cAtender,
          esperando: cEsperando,
          respondidos: cRespondidos,
        },
      },
    };
  }

  /**
   * Detalle del pedido para el vendedor: items con su estado de surtido,
   * historial de propuestas (bodega y ventas), y el cliente.
   *
   * No valida acceso aquí — el controller lo hace vía `PedidoAccessService`
   * (que ya autoriza a cualquier rol con tienda coincidente).
   */
  async obtenerDetalle(pedidoId: number, tiendaId?: number) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: {
        items: {
          orderBy: { id: 'asc' },
          include: {
            producto: {
              select: {
                imagenPrincipal: true,
                imagenesProducto: { select: { url: true, colorId: true } },
              },
            },
            precioCO: { select: { colorId: true } },
          },
        },
        tienda: { select: { id: true, nombre: true } },
        usuario: { select: { id: true, nombre: true, email: true, telefono: true } },
        historial: { orderBy: { createdAt: 'asc' } },
        propuestas: {
          orderBy: { enviadaAt: 'asc' },
          include: {
            creadaPor: { select: { id: true, nombre: true, apellido: true } },
          },
        },
      },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    if (tiendaId && pedido.tiendaId !== tiendaId) {
      throw new BadRequestException('El pedido pertenece a otra tienda');
    }

    // Adjuntar la imagen del color de la variante (mismo criterio que bodega).
    pedido.items = pedido.items.map((it: any) => {
      const imagenColor = it.producto?.imagenesProducto?.find(
        (img: any) => img.colorId === it.precioCO?.colorId,
      )?.url;
      return {
        ...it,
        productoImagen: this.storage.resolverImagen(
          imagenColor ?? it.producto?.imagenPrincipal ?? null,
        ),
      };
    }) as any;

    return pedido;
  }
}
