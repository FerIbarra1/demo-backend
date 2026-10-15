import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../imagenes/storage.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { contarMensajesNoLeidos } from '../core/mensajes-no-leidos.util';
import { UserContext } from '../../../types/pedido.types';
import { EstadoPedido, EstadoPropuesta, Prisma } from '@prisma/client';

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
 * Lo que NO hace: casi ninguna transición por su cuenta. Las transiciones
 * viven en `PedidoStateService` / `PropuestaService`. La única excepción es
 * `devolverABodega` (oct 2026), que existe porque el asesor no tenía NINGUNA
 * salida cuando revisaba el pedido y concluía que no había nada que negociar.
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

export const FILTROS_COLA: FiltroCola[] = ['todos', 'atender', 'esperando', 'respondidos'];

/** Predicado de "el cliente ya me respondió una propuesta". */
const RESPONDIO_PROPUESTA_VENTAS: Prisma.PedidoWhereInput = {
  propuestas: { some: { creadaPorRol: 'VENTAS', estado: 'RECHAZADA' } },
};

/** Predicado de "le mandé una propuesta y espero su respuesta". */
const ESPERANDO_CLIENTE: Prisma.PedidoWhereInput = {
  estado: EstadoPedido.ESPERANDO_APROBACION,
  propuestas: { some: { creadaPorRol: 'VENTAS', estado: 'PENDIENTE' } },
};

@Injectable()
export class VentasService {
  private readonly logger = new Logger(VentasService.name);

  constructor(
    private prisma: PrismaService,
    private readonly storage: StorageService,
    /**
     * Oct 2026: para `devolverABodega`. Es la única transición que dispara este
     * service; el resto de la máquina de estados la orquestan `PropuestaService`
     * y `PedidoStateService`.
     */
    private readonly state: PedidoStateService,
  ) {}

  /**
   * Cola de pedidos escalados a asesoría en la tienda del vendedor.
   *
   * Incluye tanto EN_ASESORIA (recién escalados, sin propuesta enviada) como
   * ESPERANDO_APROBACION con propuesta de VENTAS pendiente (el vendedor
   * ya propuso y espera al cliente) — así el vendedor ve en una sola lista
   * todo lo que tiene entre manos, con un flag que distingue cada caso.
   */
  async obtenerCola(tiendaId: number, pagina = 1, limite = 20, filtro: FiltroCola = 'todos') {
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
                OR: [{ estado: EstadoPedido.EN_ASESORIA }, ESPERANDO_CLIENTE],
              }),
    };

    const [pedidos, total, cTodos, cAtender, cEsperando, cRespondidos] = await Promise.all([
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
          // Oct 2026: aquí se traía `mensajes: { take: 1 }` para previsualizar
          // la conversación en la tarjeta de la cola. Se eliminó: el frontend
          // nunca lo pintó (0 referencias a `mensajes` en `ventas/page.tsx`), y
          // desde que el texto del cliente es el primer mensaje del chat, el
          // asesor lo lee en el detalle. Era un join por pedido para nada.
        },
        // Oct 2026: los pedidos cuyo cliente YA ESTÁ EN TIENDA van primero.
        //
        // El caso: el cliente llega sin ticket y sin folio, el de mostrador
        // registra su llegada, y su pedido está en la cola de ventas (pidió un
        // asesor, o hay una propuesta esperando). Sin esta clave el vendedor no
        // se enteraba de que había alguien esperando de pie — el mismo hueco que
        // ya se cerró en la cola de bodega.
        //
        // `llegadaDescartadaAt` va primero para que un aviso DESMENTIDO (el
        // operador lo marcó y luego resultó que el cliente no estaba) no siga
        // colando al pedido al frente: `llegadaAnunciadaAt` no se limpia nunca.
        orderBy: [
          { llegadaDescartadaAt: { sort: 'asc', nulls: 'first' } },
          { llegadaAnunciadaAt: { sort: 'asc', nulls: 'last' } },
          // En 'esperando' el pedido lleva ahí desde que se envió la
          // propuesta, no desde que el cliente pidió asesor; ordenar por
          // asesorSolicitadoAt dejaría arriba los más viejos por la razón
          // equivocada. El id es un proxy de "propuesta más reciente".
          filtro === 'esperando' ? { id: 'desc' } : { asesorSolicitadoAt: 'asc' },
        ],
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
    // Oct 2026: cuántos mensajes del CLIENTE esperan respuesta en cada pedido.
    // Sin esto el asesor no sabía qué conversaciones tenían algo nuevo sin
    // abrirlas una por una. Derivado del watermark, igual que en la lista del
    // cliente (`core/mensajes-no-leidos.util.ts`).
    const noLeidos = await contarMensajesNoLeidos(
      this.prisma,
      pedidos.map((p) => p.id),
      'tienda',
    );
    return {
      data: pedidos.map((p) => ({
        ...p,
        total: Number(p.total),
        mensajesNoLeidos: noLeidos.get(p.id) ?? 0,
        // Cuánto lleva esperando el cliente desde que pidió asesor.
        minutosEsperando: p.asesorSolicitadoAt
          ? Math.max(0, Math.floor((ahora.getTime() - p.asesorSolicitadoAt.getTime()) / 60000))
          : 0,
        // Distingue "recién escalado, no he propuesto" de "ya propuse, espero
        // respuesta del cliente".
        esperandoCliente: p.estado === EstadoPedido.ESPERANDO_APROBACION,
        // Oct 2026: minutos desde que el cliente avisó que está en tienda.
        // `null` si no hay aviso vigente. Es lo que pinta el badge "Llegó a
        // tienda · N min" — sin este campo el vendedor no distingue al cliente
        // que está esperando de pie del que sigue en su casa.
        esperandoDesdeMin:
          p.llegadaAnunciadaAt && !p.llegadaDescartadaAt
            ? Math.max(0, Math.floor((ahora.getTime() - p.llegadaAnunciadaAt.getTime()) / 60_000))
            : null,
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

  /**
   * Oct 2026: el asesor devuelve el pedido a bodega.
   *
   * El caso que lo motiva: el cliente pidió un asesor desde una propuesta de
   * bodega, el asesor lo revisa y concluye que **no había nada que negociar** —
   * el pedido original estaba bien y el faltante se resuelve surtiendo. Sin esta
   * acción el pedido se quedaba en `EN_ASESORIA` para siempre: `TRANSICIONES`
   * ya contemplaba `EN_ASESORIA → EN_REVISION`, pero ningún endpoint la
   * disparaba (el asesor solo podía mandar una contrapropuesta o nada).
   *
   * `asignacion: 'limpiar'` es explícito y obligatorio: el caller es el ASESOR,
   * no un bodeguero. Con 'caller' el pedido quedaría asignado al vendedor,
   * invisible en el monitor de bodega y bloqueado para todos los bodegueros.
   *
   * `reloj: 'reanudar'` porque la pelota vuelve a bodega: el tiempo de atención
   * se reanuda acumulando lo previo, igual que cuando el cliente aprueba una
   * contrapropuesta.
   */
  async devolverABodega(pedidoId: number, usuario: UserContext, nota?: string) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { id: true, estado: true, tiendaId: true, numeroPedido: true },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    if (usuario.tiendaId && pedido.tiendaId !== usuario.tiendaId) {
      throw new BadRequestException('El pedido pertenece a otra tienda');
    }
    if (pedido.estado !== EstadoPedido.EN_ASESORIA) {
      throw new BadRequestException(
        `Solo se puede devolver a bodega un pedido en asesoría (actual: ${pedido.estado})`,
      );
    }

    const sufijoNota = nota ? ` — ${nota}` : '';

    await this.state.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.EN_REVISION,
        observacion: `Devuelto a bodega por el asesor ${usuario.nombre}${sufijoNota}`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'reanudar',
        invalidarMonitor: true,
        /**
         * F21 (oct 2026): la propuesta viva queda SUPERADA.
         *
         * El asesor revisó con el cliente y decidió que el pedido original
         * estaba bien: la contrapropuesta que hubiera mandado ya no aplica. Si
         * se deja `PENDIENTE`, bodega choca contra el índice único parcial
         * (`pedidos_propuestas_pendiente_unica_idx`) al cerrar el surtido
         * siguiente — el `create` revienta con P2002 y el bodeguero lee un 409
         * que no entiende. Y `enviarAPagar` queda bloqueado para siempre por su
         * guard de propuesta pendiente.
         *
         * Es el MISMO tratamiento que ya hace `MostradorService.ajustar` cuando
         * el cliente cambia de opinión en tienda. Faltaba en este camino.
         */
        efectos: async (tx) => {
          await tx.pedidoPropuesta.updateMany({
            where: { pedidoId, estado: EstadoPropuesta.PENDIENTE },
            data: {
              estado: EstadoPropuesta.SUPERADA,
              respondidaAt: new Date(),
              notaCliente: nota ?? null,
            },
          });
        },
      },
    );

    this.logger.log(
      `Pedido ${pedidoId} (${pedido.numeroPedido}): devuelto a bodega por el asesor ${usuario.nombre}`,
    );

    return { ok: true, pedidoId, estado: EstadoPedido.EN_REVISION };
  }
}
