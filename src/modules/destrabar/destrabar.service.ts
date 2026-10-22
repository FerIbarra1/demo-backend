import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EstadoPagoTransferencia,
  EstadoPedido,
  EstadoPropuesta,
  EstadoTareaErp,
  RolUsuario,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PedidoAccessService } from '../pedidos/core/pedido-access.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { ReposicionService } from '../pedidos/reposicion/reposicion.service';
import { AdminService } from '../pedidos/admin/admin.service';
import { BodegaService } from '../pedidos/bodega/bodega.service';
import { CajeroService } from '../pedidos/cajero/cajero.service';
import { PropuestaService } from '../pedidos/propuesta/propuesta.service';
import { VentasService } from '../pedidos/ventas/ventas.service';
import { MostradorService } from '../mostrador/mostrador.service';
import { ItemAjusteDto } from '../mostrador/dto/accion-mostrador.dto';
import { bolsaEnManosDeBodega } from '../pedidos/core/bolsa-en-bodega.util';
import { textoDeTarea } from '../pedidos/core/tareas-erp.util';
import { etiquetaDeMotivo } from '../pedidos/core/motivos-cancelacion-cliente';
import { TesoreriaService } from '../pagos/transferencia/tesoreria.service';
import { pagoActivoDe, pagoBloqueaCancelacion } from '../pagos/transferencia/hooks';
import { UserContext } from '../../types/pedido.types';

/**
 * Oct 2026 — DESTRABAR pedidos: lo que el gerente de una tienda (o el admin) hace cuando un pedido se atora.
 *
 * UNA puerta (`acciones` + `ejecutar`) en vez de una ruta por consola: el SERVIDOR decide qué acciones caben en este
 * pedido para este usuario (la pantalla no mapea estado→botón), cada acción exige un MOTIVO y deja su fila en la
 * bitácora (`PedidoIntervencion`: quién, con qué rol, qué y por qué). Cada acción REUTILIZA el servicio que ya existe
 * (cancelar, cobrar a mano, cerrar una transferencia, responder una propuesta, liberar, ajustar): aquí no hay una
 * segunda copia de ninguna regla de negocio.
 *
 * Lo que toca dinero o estado de un pedido que YA está en el Sistema Comercial abre una tarea para el cajero (ver
 * `core/tareas-erp.util.ts`): la nube no puede escribir en el ERP, así que lo hace una persona.
 *
 * Etapa 1: cancelar sin pago, marcar vencida una transferencia y marcar pagado a mano.
 * Etapa 2: responder la propuesta por el cliente (aprobar / rechazar), devolver a bodega desde asesoría, liberar un
 * pedido de bodega o de caja, quitar productos antes del ERP, marcar entregado y cancelar un pedido YA pagado (solo ADMIN).
 *
 * NO existe "dar gratis" (descartado por el dueño) ni reabrir un cancelado (el ERP no lo permite: `CANCELA_PEDIDOS`
 * borra las líneas). Tampoco "reasignar" a una persona concreta: liberar devuelve el pedido a la cola y lo toma quien
 * esté ahí, que es lo que ya hace el piso.
 *
 * REGLA DEL CLIENTE: el historial del pedido y el aviso de la tienda los lee el CLIENTE. Ningún texto de aquí lleva el
 * motivo (vive solo en la bitácora) y las acciones que cancelan NO mandan correo (`sinNotificar`): el cliente lo lee
 * en su pedido.
 */

export type AccionId =
  | 'APROBAR_PROPUESTA'
  | 'RECHAZAR_PROPUESTA'
  | 'DEVOLVER_A_BODEGA'
  | 'QUITAR_PRODUCTOS'
  | 'LIBERAR_BODEGA'
  | 'LIBERAR_CAJA'
  | 'CANCELAR_SIN_PAGO'
  | 'MARCAR_VENCIDA'
  | 'MARCAR_PAGADO'
  | 'MARCAR_ENTREGADO'
  | 'CANCELAR_PAGADO';

/** Las que NO hace el gerente aunque entre por esta misma puerta (decisión del dueño, 17-oct). */
const SOLO_ADMIN: AccionId[] = ['CANCELAR_PAGADO'];

/** Una línea del pedido que `QUITAR_PRODUCTOS` deja quitar o bajar. */
export interface LineaVista {
  itemId: number;
  descripcion: string;
  cantidad: number;
}

export interface AccionVista {
  id: AccionId;
  etiqueta: string;
  descripcion: string;
  tono: 'normal' | 'peligro';
  /** Qué quedará pendiente en el Sistema Comercial, si aplica (el panel lo dice ANTES de confirmar). */
  advierteErp: string | null;
  /** ¿Se le puede dejar un mensaje al cliente en su pedido? Solo en las que cancelan (ahí se lo muestra su pedido). */
  pideMensajeCliente: boolean;
  /** Qué más pide la acción además del motivo. `productos` = el panel pinta `lineas` para elegir qué quitar o bajar. */
  entrada: 'ninguna' | 'productos';
  lineas: LineaVista[] | null;
  /** `null` = se puede ejecutar. Si no, la razón (la acción se muestra apagada: el gerente entiende por qué). */
  bloqueadaPor: string | null;
}

export interface EntradaAccion {
  motivo: string;
  mensajeCliente?: string;
  /** `QUITAR_PRODUCTOS`: la cantidad con la que debe QUEDAR cada línea (0 = quitarla). */
  items?: Array<{ itemId: number; cantidad: number }>;
}

/** Estados en los que el pedido todavía no se cobró y se puede cancelar sin pasar por reembolso. */
const CANCELABLES_SIN_PAGO: EstadoPedido[] = [
  EstadoPedido.SOLICITADO,
  EstadoPedido.EN_REVISION,
  EstadoPedido.ESPERANDO_APROBACION,
  EstadoPedido.EN_ASESORIA,
  EstadoPedido.EN_DTF,
  EstadoPedido.REVISADO,
  EstadoPedido.EN_ATENCION,
  EstadoPedido.PENDIENTE_PAGO,
];

/**
 * Donde una propuesta puede estar viva y sin respuesta con el cliente ausente: esperando su aprobación, o ya en el área
 * de entrega (el cliente se fue sin que mostrador la resolviera). Los mismos tres estados que acepta
 * `PropuestaService.resolverPropuesta` cuando responde la tienda.
 */
const RESPONDIBLES_POR_LA_TIENDA: EstadoPedido[] = [
  EstadoPedido.ESPERANDO_APROBACION,
  EstadoPedido.REVISADO,
  EstadoPedido.EN_ATENCION,
];

/** Donde quitar productos tiene sentido con el cliente ausente (EN_ATENCION es el cliente enfrente del operador). */
const AJUSTABLES_POR_LA_TIENDA: EstadoPedido[] = [
  EstadoPedido.ESPERANDO_APROBACION,
  EstadoPedido.REVISADO,
];

const TEXTO_CLIENTE_CANCELAR_SIN_PAGO = 'Cancelamos tu pedido porque no recibimos el pago.';
const TEXTO_CLIENTE_CANCELAR_PAGADO = 'Cancelamos tu pedido. Te devolveremos el pago que hiciste.';
const TEXTO_CLIENTE_RECHAZAR_PROPUESTA =
  'Cancelamos tu pedido porque no respondiste a la propuesta que te enviamos.';

type PedidoBase = {
  id: number;
  estado: EstadoPedido;
  tiendaId: number;
  asignadoAId: number | null;
  cajeroAsignadoId: number | null;
  numeroPedido: string;
};

@Injectable()
export class DestrabarService {
  private readonly logger = new Logger(DestrabarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PedidoAccessService,
    private readonly state: PedidoStateService,
    private readonly reposicion: ReposicionService,
    private readonly admin: AdminService,
    private readonly tesoreria: TesoreriaService,
    private readonly propuestas: PropuestaService,
    private readonly ventas: VentasService,
    private readonly bodega: BodegaService,
    private readonly cajero: CajeroService,
    private readonly mostrador: MostradorService,
  ) {}

  /** Solo ADMIN y GERENTE destraban; el GERENTE, en su tienda (lo valida `cargarYValidar`). */
  private async cargar(pedidoId: number, user: UserContext): Promise<PedidoBase> {
    if (user.rol !== RolUsuario.ADMIN && user.rol !== RolUsuario.GERENTE) {
      throw new ForbiddenException('Solo el gerente o el administrador pueden destrabar pedidos.');
    }
    await this.access.cargarYValidar(pedidoId, user);
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        id: true,
        estado: true,
        tiendaId: true,
        asignadoAId: true,
        cajeroAsignadoId: true,
        numeroPedido: true,
      },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    return pedido;
  }

  /** Qué cabe hacer AHORA con este pedido, más su bitácora y lo que está pendiente en el Sistema Comercial. */
  async obtener(pedidoId: number, user: UserContext) {
    const pedido = await this.cargar(pedidoId, user);
    const [acciones, intervenciones, tareas, cancelacion] = await Promise.all([
      this.accionesDe(pedido, user),
      this.prisma.pedidoIntervencion.findMany({
        where: { pedidoId },
        orderBy: { id: 'desc' },
        take: 30,
        select: {
          id: true,
          tipo: true,
          motivo: true,
          actorNombre: true,
          actorRol: true,
          estadoAntes: true,
          estadoDespues: true,
          createdAt: true,
        },
      }),
      this.prisma.tareaSistemaComercial.findMany({
        where: { pedidoId, estado: EstadoTareaErp.PENDIENTE },
        orderBy: { id: 'asc' },
      }),
      // Oct 2026: por qué canceló el CLIENTE, si quiso decirlo (es opcional). Para el negocio: lo ve el gerente/admin
      // aquí y NUNCA el cliente (no va en su pedido, su historial ni su correo). `null` = no lo dio o no canceló él.
      this.prisma.pedidoCancelacionCliente.findUnique({
        where: { pedidoId },
        select: { motivo: true, detalle: true, estadoAlCancelar: true, createdAt: true },
      }),
    ]);
    return {
      pedidoId,
      estado: pedido.estado,
      acciones,
      cancelacionDelCliente: cancelacion
        ? { ...cancelacion, etiqueta: etiquetaDeMotivo(cancelacion.motivo) }
        : null,
      intervenciones,
      tareas: tareas.map((t) => ({ ...t, ...textoDeTarea(t) })),
    };
  }

  /** La propuesta sin responder (a lo más una: lo garantiza el índice único parcial) y quién la creó. */
  private propuestaPendiente(pedidoId: number) {
    return this.prisma.pedidoPropuesta.findFirst({
      where: { pedidoId, estado: EstadoPropuesta.PENDIENTE },
      select: { id: true, creadaPorRol: true },
    });
  }

  /**
   * Líneas vivas del pedido (lo que se cobra): las que `QUITAR_PRODUCTOS` puede tocar.
   *
   * `sinSurtirCompleto`: alguna línea pide más piezas de las que HAY en la bolsa (bodega no alcanzó, o una subida que
   * nadie ha verificado). Mientras eso pase, ajustar cualquier otra línea mandaría el pedido a bodega
   * (`ajusteNecesitaBodega` cuenta también las líneas sin cambio), y esta acción promete lo contrario: solo quita o baja,
   * nunca pide trabajo a bodega. Lo de la bolsa se resuelve primero con la propuesta.
   */
  private async lineasActivas(
    pedidoId: number,
  ): Promise<{ lineas: LineaVista[]; sinSurtirCompleto: boolean }> {
    const items = await this.prisma.itemPedido.findMany({
      where: { pedidoId, cancelada: false, cantidad: { gt: 0 } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        cantidad: true,
        cantidadSurtida: true,
        piezasRetiradas: true,
        productoNombre: true,
        tallaNombre: true,
        colorNombre: true,
      },
    });
    return {
      lineas: items.map((i) => ({
        itemId: i.id,
        descripcion: `${i.productoNombre} · ${i.colorNombre} · ${i.tallaNombre}`,
        cantidad: i.cantidad,
      })),
      sinSurtirCompleto: items.some(
        (i) => i.cantidad > Math.max(0, i.cantidadSurtida - i.piezasRetiradas),
      ),
    };
  }

  private async nombreDe(usuarioId: number | null): Promise<string | null> {
    if (!usuarioId) return null;
    const u = await this.prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: { nombre: true },
    });
    return u?.nombre ?? null;
  }

  private async accionesDe(pedido: PedidoBase, user: UserContext): Promise<AccionVista[]> {
    const pago = await pagoActivoDe(this.prisma, pedido.id);
    const envio = await this.prisma.pedidoPendienteEnvio.findUnique({
      where: { pedidoId: pedido.id },
      select: { estado: true },
    });
    const enErp = envio?.estado === 'PROCESADO';
    const lista: AccionVista[] = [];
    const base = {
      advierteErp: null,
      pideMensajeCliente: false,
      entrada: 'ninguna' as const,
      lineas: null,
      bloqueadaPor: null,
    };

    // ── La propuesta que el cliente nunca contestó ─────────────────────────────────────────────────────────────
    if (RESPONDIBLES_POR_LA_TIENDA.includes(pedido.estado)) {
      const propuesta = await this.propuestaPendiente(pedido.id);
      if (propuesta) {
        const deBodega = propuesta.creadaPorRol === RolUsuario.BODEGA;
        lista.push({
          ...base,
          id: 'APROBAR_PROPUESTA',
          etiqueta: 'Aprobar la propuesta por el cliente',
          descripcion: deBodega
            ? 'Acepta lo que bodega pudo surtir, en nombre del cliente que no contestó. El pedido sigue su camino con los faltantes ya ajustados.'
            : 'Acepta la propuesta del asesor, en nombre del cliente que no contestó. Se aplican los cambios y el pedido sigue su camino.',
          tono: 'normal',
        });
        lista.push({
          ...base,
          id: 'RECHAZAR_PROPUESTA',
          etiqueta: deBodega
            ? 'Rechazar la propuesta (cancela el pedido)'
            : 'Rechazar la propuesta (regresa con el asesor)',
          descripcion: deBodega
            ? 'Rechaza la propuesta en nombre del cliente: el pedido se cancela y lo que ya esté apartado pasa a la lista de reposición. Al cliente no le llega correo: lo verá en su pedido.'
            : 'Rechaza la propuesta del asesor en nombre del cliente: el pedido vuelve a asesoría para que el asesor haga otra.',
          tono: deBodega ? 'peligro' : 'normal',
          pideMensajeCliente: deBodega,
        });
      }
    }

    // ── Asesoría sin salida ────────────────────────────────────────────────────────────────────────────────────
    if (pedido.estado === EstadoPedido.EN_ASESORIA) {
      lista.push({
        ...base,
        id: 'DEVOLVER_A_BODEGA',
        etiqueta: 'Devolver a bodega',
        descripcion:
          'El asesor no va a negociar nada: el pedido regresa a bodega a surtirse tal cual, sin asignar. La propuesta que estuviera pendiente queda superada.',
        tono: 'normal',
      });
    }

    // ── Quitar o bajar productos antes de que el pedido llegue al ERP ──────────────────────────────────────────
    if (AJUSTABLES_POR_LA_TIENDA.includes(pedido.estado)) {
      const { lineas, sinSurtirCompleto } = await this.lineasActivas(pedido.id);
      if (lineas.length > 0) {
        const hayPropuesta = await this.propuestaPendiente(pedido.id);
        lista.push({
          ...base,
          id: 'QUITAR_PRODUCTOS',
          etiqueta: 'Quitar o bajar productos',
          descripcion:
            'Quita líneas o baja cantidades. No se agregan productos: eso lo acuerda el cliente. Lo que se quite pasa a la lista de reposición y la propuesta pendiente queda superada. El total se recalcula solo.',
          tono: 'normal',
          entrada: 'productos',
          lineas,
          bloqueadaPor: sinSurtirCompleto
            ? hayPropuesta
              ? 'Bodega no alcanzó a surtir completos algunos productos. Primero aprueba o rechaza la propuesta; después podrás quitar o bajar lo que haga falta.'
              : 'Bodega todavía tiene que surtir parte de este pedido: no se puede ajustar hasta que termine.'
            : null,
        });
      }
    }

    // ── Un pedido que alguien dejó tomado ──────────────────────────────────────────────────────────────────────
    if (pedido.estado === EstadoPedido.EN_REVISION && pedido.asignadoAId) {
      const quien = await this.nombreDe(pedido.asignadoAId);
      lista.push({
        ...base,
        id: 'LIBERAR_BODEGA',
        etiqueta: 'Liberar el pedido de bodega',
        descripcion: `${quien ? `Lo tiene ${quien}. ` : ''}Lo suelta y vuelve a la cola de bodega, con el tiempo que ya llevaba acumulado, para que lo tome quien esté.`,
        tono: 'normal',
      });
    }
    if (pedido.estado === EstadoPedido.PENDIENTE_PAGO && pedido.cajeroAsignadoId) {
      const quien = await this.nombreDe(pedido.cajeroAsignadoId);
      lista.push({
        ...base,
        id: 'LIBERAR_CAJA',
        etiqueta: 'Liberar el pedido de la ventanilla',
        descripcion: `${quien ? `Lo tiene ${quien}. ` : ''}Lo suelta de su ventanilla y vuelve a la fila de caja en su mismo lugar.`,
        tono: 'normal',
      });
    }

    // ── Sin pago ───────────────────────────────────────────────────────────────────────────────────────────────
    if (CANCELABLES_SIN_PAGO.includes(pedido.estado)) {
      const bloqueo = await pagoBloqueaCancelacion(this.prisma, pedido.id);
      lista.push({
        ...base,
        id: 'CANCELAR_SIN_PAGO',
        etiqueta: 'Cancelar por falta de pago',
        descripcion:
          'Cancela el pedido. La mercancía que ya esté apartada pasa a la lista de reposición. Al cliente no le llega correo: lo verá en su pedido.',
        tono: 'peligro',
        advierteErp: enErp
          ? 'El pedido ya está en el Sistema Comercial: se abrirá una tarea para que caja lo cancele allá también.'
          : null,
        pideMensajeCliente: true,
        bloqueadaPor: bloqueo
          ? bloqueo.estado === EstadoPagoTransferencia.VERIFICADO
            ? 'Ya hay una transferencia verificada: primero se resuelve ese dinero en Tesorería.'
            : 'Hay un comprobante de transferencia en revisión: puede haber dinero en camino. Primero resuélvelo en Tesorería.'
          : null,
      });
    }

    if (pago?.estado === EstadoPagoTransferencia.PENDIENTE) {
      lista.push({
        ...base,
        id: 'MARCAR_VENCIDA',
        etiqueta: 'Marcar la transferencia como vencida',
        descripcion:
          'Cierra las instrucciones de transferencia que nadie ha pagado. Caja podrá cobrar en la tienda y el cliente podrá pedir datos nuevos. Si después llega un abono, Tesorería lo verifica igual.',
        tono: 'normal',
      });
    }

    if (pedido.estado === EstadoPedido.PENDIENTE_PAGO) {
      const hayDinero =
        pago?.estado === EstadoPagoTransferencia.EN_REVISION ||
        pago?.estado === EstadoPagoTransferencia.VERIFICADO;
      lista.push({
        ...base,
        id: 'MARCAR_PAGADO',
        etiqueta: 'Marcar como pagado',
        descripcion:
          'Para un cobro que se hizo fuera de la web y que no llegó por el agente. El motivo debe decir cómo se cobró (referencia, efectivo…).',
        tono: 'normal',
        advierteErp: enErp
          ? 'Si el cobro no está en el Sistema Comercial, se abrirá una tarea para que caja lo registre allá. Si caja ya lo cobró allá, la tarea se cierra sola cuando el agente lo confirme.'
          : null,
        bloqueadaPor: hayDinero
          ? 'Hay una transferencia con comprobante: se resuelve en Tesorería para no cobrar dos veces.'
          : null,
      });
    }

    // ── Ya cobrado ─────────────────────────────────────────────────────────────────────────────────────────────
    if (pedido.estado === EstadoPedido.PAGADO || pedido.estado === EstadoPedido.ENVIADO) {
      lista.push({
        ...base,
        id: 'MARCAR_ENTREGADO',
        etiqueta: 'Marcar como entregado',
        descripcion:
          'Cierra el pedido como entregado: el cliente ya se llevó su mercancía y nadie lo marcó. No cambia nada en el Sistema Comercial y no se le manda correo.',
        tono: 'normal',
      });
    }

    if (user.rol === RolUsuario.ADMIN && pedido.estado === EstadoPedido.PAGADO) {
      lista.push({
        ...base,
        id: 'CANCELAR_PAGADO',
        etiqueta: 'Cancelar un pedido ya pagado',
        descripcion:
          'Cancela el pedido y manda a reposición lo que siga apartado. El dinero hay que devolverlo: si pagó en caja lo devuelve la tienda; si pagó por transferencia, Tesorería lo ve como "reembolso pendiente". Al cliente no le llega correo: lo verá en su pedido.',
        tono: 'peligro',
        advierteErp: enErp
          ? 'El pedido ya está cobrado en el Sistema Comercial: se abrirá una tarea para que caja anule la venta allá y devuelva el dinero.'
          : 'El pedido no llegó a quedar en el Sistema Comercial: no hay venta que anular allá, pero el dinero sí hay que devolverlo.',
        pideMensajeCliente: true,
      });
    }

    return lista;
  }

  async ejecutar(
    pedidoId: number,
    accionId: string,
    dto: EntradaAccion,
    user: UserContext,
    ip?: string | null,
  ) {
    const pedido = await this.cargar(pedidoId, user);
    const motivo = dto.motivo?.trim() ?? '';
    if (motivo.length < 3)
      throw new BadRequestException('Escribe el motivo (mínimo 3 caracteres).');

    const acciones = await this.accionesDe(pedido, user);
    const accion = acciones.find((a) => a.id === accionId);
    if (!accion) {
      // El gerente que llama directo a una acción del administrador recibe 403, no un "ya no cabe" que lo confunda.
      if (SOLO_ADMIN.includes(accionId as AccionId) && user.rol !== RolUsuario.ADMIN) {
        throw new ForbiddenException('Esta acción solo la puede hacer el administrador.');
      }
      throw new ConflictException('Esta acción ya no cabe en este pedido. Actualiza la pantalla.');
    }
    if (accion.bloqueadaPor) throw new ConflictException(accion.bloqueadaPor);

    // El cliente solo lee un mensaje de la tienda si el pedido se CANCELÓ (su pantalla lo pinta en esa tarjeta).
    const textoEstandar: Partial<Record<AccionId, string>> = {
      CANCELAR_SIN_PAGO: TEXTO_CLIENTE_CANCELAR_SIN_PAGO,
      CANCELAR_PAGADO: TEXTO_CLIENTE_CANCELAR_PAGADO,
      RECHAZAR_PROPUESTA: TEXTO_CLIENTE_RECHAZAR_PROPUESTA,
    };
    const mensajeCliente = accion.pideMensajeCliente
      ? [textoEstandar[accion.id], dto.mensajeCliente?.trim()].filter(Boolean).join(' ') || null
      : null;

    const intervencion = (
      tx: Pick<PrismaService, 'pedidoIntervencion'>,
      despues: EstadoPedido,
      detalle?: object,
    ) =>
      tx.pedidoIntervencion.create({
        data: {
          pedidoId,
          tiendaId: pedido.tiendaId,
          tipo: accion.id,
          motivo,
          mensajeCliente,
          actorId: user.userId,
          actorRol: user.rol,
          actorNombre: user.nombre,
          estadoAntes: pedido.estado,
          estadoDespues: despues,
          detalle: detalle as never,
        },
      });
    /** El estado en que quedó el pedido tras una acción que otro servicio ejecutó (la bitácora lo dice de verdad). */
    const estadoActual = async () =>
      (
        await this.prisma.pedido.findUniqueOrThrow({
          where: { id: pedidoId },
          select: { estado: true },
        })
      ).estado;

    switch (accion.id) {
      case 'APROBAR_PROPUESTA':
      case 'RECHAZAR_PROPUESTA': {
        const propuesta = await this.propuestaPendiente(pedidoId);
        if (!propuesta) {
          throw new ConflictException('La propuesta ya fue respondida. Actualiza la pantalla.');
        }
        await this.propuestas.responderPorLaTienda(
          pedidoId,
          propuesta.id,
          accion.id === 'APROBAR_PROPUESTA' ? 'APROBAR' : 'RECHAZAR',
          user,
        );
        await intervencion(this.prisma, await estadoActual(), {
          propuestaId: propuesta.id,
          origen: propuesta.creadaPorRol,
        });
        break;
      }
      case 'DEVOLVER_A_BODEGA': {
        // `observacion` propia: el historial lo lee el cliente y la nota/motivo no puede ir ahí.
        await this.ventas.devolverABodega(pedidoId, user, undefined, {
          observacion: 'Devuelto a bodega por la tienda',
        });
        await intervencion(this.prisma, EstadoPedido.EN_REVISION);
        break;
      }
      case 'QUITAR_PRODUCTOS': {
        const items = this.validarQuitar(dto.items, accion.lineas ?? []);
        const r = await this.mostrador.ajustar(pedidoId, user, 'Ajuste de la tienda', items, {
          porLaTienda: true,
        });
        await intervencion(this.prisma, await estadoActual(), {
          items: dto.items,
          vaABodega: r.vaABodega,
          piezasAReposicion: r.piezasAReposicion,
        });
        break;
      }
      case 'LIBERAR_BODEGA': {
        await this.bodega.liberarPedido(pedidoId, user);
        await intervencion(this.prisma, EstadoPedido.EN_REVISION, {
          bodegueroId: pedido.asignadoAId,
        });
        break;
      }
      case 'LIBERAR_CAJA': {
        await this.cajero.liberarPedidoCajero(pedidoId, user);
        await intervencion(this.prisma, EstadoPedido.PENDIENTE_PAGO, {
          cajeroId: pedido.cajeroAsignadoId,
        });
        break;
      }
      case 'CANCELAR_SIN_PAGO':
        // Espejo de `ClienteService.cancelarPedido` (misma reposición, mismo aviso a bodega).
        await this.cancelar(pedido, user, {
          observacion: 'Cancelado por la tienda: falta de pago',
          textoReposicion: TEXTO_CLIENTE_CANCELAR_SIN_PAGO,
          intervencion,
        });
        break;
      case 'CANCELAR_PAGADO':
        // Mismo camino. Lo que cambia: ya hay dinero (la transferencia pasa sola a REEMBOLSO_PENDIENTE dentro de
        // `cambiarEstado`) y, si el pedido está cobrado en el ERP, la tarea es ANULAR la venta (ver `tareas-erp.util`).
        await this.cancelar(pedido, user, {
          observacion: 'Cancelado por la tienda',
          textoReposicion: TEXTO_CLIENTE_CANCELAR_PAGADO,
          intervencion,
        });
        break;
      case 'MARCAR_VENCIDA': {
        const pago = await pagoActivoDe(this.prisma, pedidoId);
        if (!pago) throw new ConflictException('La transferencia ya no está abierta.');
        await this.tesoreria.vencer(pago.id, motivo, user, ip);
        await intervencion(this.prisma, pedido.estado, { pagoId: pago.id });
        break;
      }
      case 'MARCAR_PAGADO': {
        const pago = await pagoActivoDe(this.prisma, pedidoId);
        // Con una transferencia PENDIENTE (sin comprobante) el cobro manual exige `forzar` y la referencia: el motivo
        // es esa referencia. Con comprobante o dinero verificado la acción ni aparece (ver `accionesDe`).
        // `referencia` termina en el historial (que lee el cliente): va un texto neutro y el MOTIVO real queda en la
        // bitácora. La referencia solo importa aquí como "no vacía", que es lo que `forzar` exige.
        await this.admin.marcarComoPagado(
          pedidoId,
          {
            referencia: 'Cobro registrado por la tienda',
            forzar: pago?.estado === EstadoPagoTransferencia.PENDIENTE,
          },
          user,
        );
        await intervencion(this.prisma, EstadoPedido.PAGADO);
        break;
      }
      case 'MARCAR_ENTREGADO': {
        // Cerrar un pedido que el cliente ya se llevó. No pasa por `MostradorService.entregar` porque esa ruta manda el
        // correo "entregado" (falso aquí: nadie lo está entregando ahora) y firma "en mostrador por <operador>". La
        // regla (solo PAGADO/ENVIADO) la impone `TRANSICIONES`. `ENTREGADO` no se persiste en Firebird: no hay tarea.
        await this.state.cambiarEstado(
          pedidoId,
          {
            nuevoEstado: EstadoPedido.ENTREGADO,
            observacion: 'Marcado como entregado por la tienda',
          },
          user,
          {
            sinNotificar: true,
            efectos: async (tx) => {
              await intervencion(tx as never, EstadoPedido.ENTREGADO);
            },
          },
        );
        break;
      }
    }

    this.logger.log(
      `Pedido ${pedido.numeroPedido}: ${accion.id} por ${user.nombre} (${user.rol}): ${motivo}`,
    );
    return this.obtener(pedidoId, user);
  }

  /**
   * Cancelación compartida por `CANCELAR_SIN_PAGO` y `CANCELAR_PAGADO`: sin correo (`sinNotificar`), reposición y fila
   * de bitácora en la MISMA transacción. La tarea del Sistema Comercial la abre `cambiarEstado` (toda cancelación pasa
   * por ahí).
   */
  private async cancelar(
    pedido: PedidoBase,
    user: UserContext,
    o: {
      observacion: string;
      textoReposicion: string;
      intervencion: (tx: never, despues: EstadoPedido) => Promise<unknown>;
    },
  ) {
    // Un pedido ya cobrado tiene la bolsa en el área de entrega, no en manos de bodega.
    const enManosDeBodega = await bolsaEnManosDeBodega(this.prisma, {
      id: pedido.id,
      estado: pedido.estado,
      asignadoAId: pedido.asignadoAId,
    });
    await this.state.cambiarEstado(
      pedido.id,
      {
        nuevoEstado: EstadoPedido.CANCELADO,
        // OJO: el historial del pedido lo LEE EL CLIENTE en su pantalla. El motivo interno queda solo en la bitácora
        // de intervenciones; aquí va el texto neutro (decisión del dueño: el motivo nunca llega al cliente).
        observacion: o.observacion,
      },
      user,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        invalidarMonitor: true,
        sinNotificar: true,
        efectos: async (tx) => {
          await this.reposicion.crearDesdePedido(tx, pedido.id, o.textoReposicion, {
            bolsaEnManosDeBodega: enManosDeBodega,
          });
          await o.intervencion(tx as never, EstadoPedido.CANCELADO);
        },
      },
    );
  }

  /**
   * `QUITAR_PRODUCTOS`: lo que llega es la cantidad con la que debe QUEDAR cada línea. Aquí se exige que SOLO quite o
   * baje (nunca suba ni agregue: el panel no negocia con el cliente) y que no deje el pedido vacío; después se traduce
   * a las intenciones que ya entiende el ajuste de mostrador. Los precios y el total los recalcula el servidor.
   */
  private validarQuitar(pedidas: EntradaAccion['items'], lineas: LineaVista[]): ItemAjusteDto[] {
    if (!pedidas || pedidas.length === 0) {
      throw new BadRequestException('Elige qué producto quitar o a cuántas piezas bajarlo.');
    }
    const porId = new Map(lineas.map((l) => [l.itemId, l]));
    const vistos = new Set<number>();
    const items: ItemAjusteDto[] = [];
    let piezasQueQuedan = lineas.reduce((a, l) => a + l.cantidad, 0);

    for (const p of pedidas) {
      const linea = porId.get(p.itemId);
      if (!linea) {
        throw new BadRequestException(
          `El producto ${p.itemId} no es una línea activa de este pedido.`,
        );
      }
      if (vistos.has(p.itemId)) {
        throw new BadRequestException(`El producto ${linea.descripcion} viene repetido.`);
      }
      vistos.add(p.itemId);
      if (!Number.isInteger(p.cantidad) || p.cantidad < 0) {
        throw new BadRequestException('La cantidad debe ser un número entero, 0 o mayor.');
      }
      if (p.cantidad >= linea.cantidad) {
        throw new BadRequestException(
          `${linea.descripcion}: solo se puede quitar o bajar (hoy ${linea.cantidad} pieza(s)). ` +
            'Agregar o subir piezas lo acuerda el cliente.',
        );
      }
      piezasQueQuedan -= linea.cantidad - p.cantidad;
      items.push(
        p.cantidad === 0
          ? { itemId: p.itemId, tipo: 'no-disponible' }
          : { itemId: p.itemId, tipo: 'parcial', cantidad: p.cantidad },
      );
    }
    if (piezasQueQuedan <= 0) {
      throw new BadRequestException(
        'Así el pedido se quedaría sin productos. Si ya no va, cancélalo.',
      );
    }
    return items;
  }
}
