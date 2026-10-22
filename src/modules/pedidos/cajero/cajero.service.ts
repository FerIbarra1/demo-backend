import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { VentanillasService } from '../../ventanillas/ventanillas.service';
import { UserContext } from '../../../types/pedido.types';
import { resumenDtfPorPedido } from '../../dtf/dtf-resumen';
import {
  EstadoPedido,
  Prisma,
  RolUsuario,
  ModoEntrega,
  EstadoPagoTransferencia,
} from '@prisma/client';
import {
  ESTADOS_ACTIVOS,
  ESTADOS_NO_COBRAR,
  resumirPagoParaCaja,
} from '../../pagos/transferencia/reglas';
import {
  SELECT_ORDEN_COLA_CAJA,
  WHERE_LLAMABLE,
  esNoCobrar,
  esperandoValidacion,
  ordenarFilaDeCaja,
  whereFilaDeCaja,
} from '../core/cola-caja.util';
import { turnoCorto } from '../core/folio-erp.util';

/**
 * Servicio del dominio CAJERO.
 *
 * Responsabilidad: cola de pedidos en PENDIENTE_PAGO (kiosko y web, no domicilio),
 * asignar pedidos a la ventanilla del cajero logueado (1:1), liberar y listar
 * mis pedidos. NO dispara transiciones de estado: solo cambia la
 * asignación de ventanilla. El cobro se confirma en un sistema externo
 * (Firebird) que llama al webhook `POST /admin/pedidos/:id/marcar-pagado`.
 */
/**
 * Oct 2026: el pago por transferencia que se pinta junto a cada pedido de la cola. Vivo, o el
 * último si ya se aplicó (para que caja vea "pagado por transferencia" y no un pedido sin contexto).
 */
const PAGO_PARA_CAJA = {
  where: {
    estado: { in: [...ESTADOS_ACTIVOS, EstadoPagoTransferencia.APLICADO] },
  },
  orderBy: { id: 'desc' as const },
  take: 1,
  select: {
    id: true,
    estado: true,
    referencia: true,
    montoEsperado: true,
    verificadoAt: true,
    requiereRevision: true,
    // Para decirle a caja cuánto lleva esperando la transferencia (ver `esperaDelPago`).
    createdAt: true,
  },
} satisfies Prisma.Pedido$pagosTransferenciaArgs;

/**
 * Quita la relación cruda y deja `pagoTransferencia` con el texto para caja ya resuelto.
 *
 * Oct 2026: además dice si el cliente está "esperando validación" (la cajera lo regresó a la cola
 * hasta que se valide y la transferencia sigue sin verificar), para que la consola lo marque. El
 * servidor lo calcula: el frontend no deduce nada de `esperaValidacionDesdeAt`.
 */
function conPagoParaCaja<
  T extends {
    pagosTransferencia: Parameters<typeof resumirPagoParaCaja>[0][];
    esperaValidacionDesdeAt?: Date | null;
  },
>(pedido: T) {
  const { pagosTransferencia, ...resto } = pedido;
  return {
    ...resto,
    pagoTransferencia: resumirPagoParaCaja(pagosTransferencia[0]),
    esperandoValidacion: esperandoValidacion(pedido),
  };
}

/** Cuántas veces reintenta "Llamar siguiente" si otro cajero le gana el turno. */
const INTENTOS_LLAMAR_SIGUIENTE = 3;

@Injectable()
export class CajeroService {
  private readonly logger = new Logger(CajeroService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private pedidoState: PedidoStateService,
    private ventanillasService: VentanillasService,
  ) {}

  async obtenerColaVentanilla(
    tiendaId?: number,
    pagina = 1,
    limite = 20,
    /**
     * F16 (sep 2026): default `'TODOS'`. Antes era `'KIOSKO'` y escondía los
     * pedidos web, que con el flujo nuevo SÍ llegan a caja (mostrador los
     * libera). El filtro sigue existiendo como comodidad de UI — la cajera
     * puede querer ver solo los de kiosko — pero ya no es un gate: el gate real
     * es el ESTADO (`PENDIENTE_PAGO`), al que solo se llega por liberación de
     * mostrador (o por domicilio, que no pasa por caja).
     */
    canal: 'KIOSKO' | 'WEB' | 'TODOS' = 'TODOS',
    /**
     * Oct 2026: filtro por transferencia. `verificado` = ya llegó el dinero, falta registrarlo en
     * VFP; `en-proceso` = hay una transferencia abierta y NO se debe cobrar.
     */
    pago?: 'verificado' | 'en-proceso',
  ) {
    // La fila es la misma que ve la TV y la que recorre "Llamar siguiente" (`cola-caja.util.ts`);
    // aquí se muestra ENTERA (también las transferencias en proceso, marcadas "no cobrar"), pero en
    // el mismo orden de turno.
    // «Por registrar» (`verificado`) también trae los pedidos a DOMICILIO: no se atienden en ventanilla, pero su
    // transferencia verificada hay que registrarla en el Sistema Comercial (ver `whereFilaDeCaja`).
    const where: Prisma.PedidoWhereInput = whereFilaDeCaja(tiendaId, {
      incluirDomicilio: pago === 'verificado',
    });
    if (canal !== 'TODOS') where.canalOrigen = canal;
    if (pago === 'verificado') {
      where.pagosTransferencia = { some: { estado: EstadoPagoTransferencia.VERIFICADO } };
    } else if (pago === 'en-proceso') {
      where.pagosTransferencia = { some: { estado: { in: [...ESTADOS_NO_COBRAR] } } };
    }
    const skip = (pagina - 1) * limite;

    // El turno (verificadas primero, luego quién llegó antes a caja) no se puede expresar en un
    // `orderBy` de Prisma, y la fila de UNA tienda son decenas de pedidos, no miles: se ordenan
    // livianos en memoria, se pagina, y solo la página pide el detalle completo.
    const candidatos = await this.prisma.pedido.findMany({ where, select: SELECT_ORDEN_COLA_CAJA });
    const ordenados = ordenarFilaDeCaja(candidatos);
    const ids = ordenados.slice(skip, skip + limite).map((c) => c.id);
    const pedidos = ids.length
      ? await this.prisma.pedido.findMany({
          where: { id: { in: ids } },
          include: {
            items: true,
            tienda: true,
            usuario: { select: { nombre: true, telefono: true, email: true } },
            pagosTransferencia: PAGO_PARA_CAJA,
          },
        })
      : [];
    const porId = new Map(pedidos.map((p) => [p.id, p]));
    // El DTF no es un item pero SÍ suma al total: sin su resumen caja vería un total que no cuadra con las líneas.
    const dtfPorPedido = await resumenDtfPorPedido(this.prisma, ids);
    const ahora = Date.now();
    const data = ids.flatMap((id) => {
      const p = porId.get(id);
      if (!p) return [];
      // Minutos que lleva en la fila de caja (no desde que se hizo el pedido).
      const desde = (p.colaCajaDesdeAt ?? p.fechaPedido).getTime();
      return [
        {
          ...conPagoParaCaja(p),
          // A domicilio no hay a quién llamar ni atender: la cajera solo lo REGISTRA en el Sistema Comercial. Lo
          // decide el servidor; la consola no deduce de `modoEntrega` qué botones ofrecer.
          soloRegistrar: p.modoEntrega === ModoEntrega.DOMICILIO,
          minutosEnCola: Math.max(0, Math.floor((ahora - desde) / 60_000)),
          dtfResumen: dtfPorPedido.get(id) ?? null,
        },
      ];
    });
    return {
      data,
      meta: {
        total: ordenados.length,
        pagina,
        limite,
        totalPaginas: Math.ceil(ordenados.length / limite),
        // Cuántos puede tomar "Llamar siguiente" (todos menos lo regresado "hasta que se valide").
        // La consola habilita el botón con esto: restar "transferencias en proceso" ya no sirve,
        // porque esas SÍ se llaman en turno.
        llamables: ordenados.filter((c) => !esperandoValidacion(c)).length,
      },
    };
  }

  async tomarPedidoCajero(pedidoId: number, usuario: UserContext) {
    if (usuario.rol === RolUsuario.ADMIN) {
      const p = await this.prisma.pedido.findUnique({
        where: { id: pedidoId },
        select: { tiendaId: true },
      });
      // Sin esto un pedido inexistente le daba al ADMIN un 403 "elige una ventanilla" que no tiene nada que ver.
      if (!p) throw new NotFoundException('Pedido no encontrado');
      await this.exigirVentanillaSiEsAdmin(usuario, p.tiendaId);
    }
    return this.tomarPedidoCajeroInterno(pedidoId, usuario, true);
  }

  /**
   * Tomar un pedido —o llamar al siguiente— lo ASIGNA a quien lo toma, a SU ventanilla. Un cajero ya tiene una
   * (`EstacionGuard` lo exige); el ADMIN está exento de la estación para MIRAR y actuar, pero tomar sin
   * ventanilla dejaría el pedido asignado a un usuario invisible en la TV (solo lista a un cajero activo) y
   * en la fila (solo lista los sin asignar). F3.5 ("cubrir puesto"): el ADMIN puede tomar SI ocupa una
   * ventanilla de la tienda del pedido: aparece en la TV como un cajero más, con latido y barrido de inactividad.
   * Va en el servicio y no solo en el botón: una pantalla desfasada o un cliente de la API no pueden saltárselo.
   */
  private async exigirVentanillaSiEsAdmin(
    usuario: UserContext,
    tiendaId: number | undefined,
  ): Promise<void> {
    if (usuario.rol !== RolUsuario.ADMIN) return;
    const mia = tiendaId
      ? await this.ventanillasService.ventanillaDelCajero(usuario.userId, tiendaId)
      : null;
    if (!mia) {
      throw new ForbiddenException(
        'Elige una ventanilla de esta tienda para atender. El administrador puede cubrir un puesto, pero no tomar pedidos sin tenerlo.',
      );
    }
  }

  /**
   * Lógica común de tomar un pedido para el cajero.
   * @param emitirRealtime Si false, no emite `pedido.cajero-asignado`
   *   (lo usa `llamarSiguiente` que emite su propio evento `pedido.llamado`).
   */
  private async tomarPedidoCajeroInterno(
    pedidoId: number,
    usuario: UserContext,
    emitirRealtime: boolean,
  ) {
    const pedido = await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');

      // F16 (sep 2026): el candado de canal se eliminó. Antes rechazaba todo
      // pedido no-KIOSKO con 400, y con el flujo nuevo los pedidos web SÍ
      // llegan a caja (mostrador los libera tras mostrárselos al cliente).
      // El gate real es el ESTADO: solo `PENDIENTE_PAGO` entra al monitor de
      // ventanillas, y a ese estado solo se llega por liberación de mostrador
      // o por el camino de domicilio (que no pasa por caja).
      if (pedido.estado !== EstadoPedido.PENDIENTE_PAGO) {
        throw new BadRequestException(
          `Solo se toman pedidos en PENDIENTE_PAGO (actual: ${pedido.estado})`,
        );
      }
      // Un pedido a domicilio no se cobra en ventanilla.
      if (pedido.modoEntrega === ModoEntrega.DOMICILIO) {
        throw new BadRequestException('Los pedidos a domicilio no se cobran en ventanilla');
      }
      if (pedido.cajeroAsignadoId !== null && pedido.cajeroAsignadoId !== usuario.userId) {
        throw new ConflictException('Este pedido ya está asignado a otra ventanilla');
      }
      if (usuario.tiendaId && pedido.tiendaId !== usuario.tiendaId) {
        throw new BadRequestException('El pedido no pertenece a tu tienda');
      }

      // Oct 2026: la asignación lleva su propia guarda. Antes se leía
      // `cajeroAsignadoId` arriba y se escribía con un `update` por id: dos cajeros que
      // tomaban el mismo pedido a la vez leían `null` los dos, escribían los dos y los
      // dos recibían "éxito" — cada uno creía tener el turno y el segundo pisaba al
      // primero sin avisar. Con el estado y la asignación en el `where`, solo uno
      // escribe; el otro recibe 409. (Mismo patrón TOCTOU que `cambiarEstado`.)
      // Volver a tomar un pedido propio sigue siendo válido (refresca la hora).
      const tomado = await tx.pedido.updateMany({
        where: {
          id: pedidoId,
          estado: EstadoPedido.PENDIENTE_PAGO,
          OR: [{ cajeroAsignadoId: null }, { cajeroAsignadoId: usuario.userId }],
        },
        data: {
          cajeroAsignadoId: usuario.userId,
          cajeroAsignadoAt: new Date(),
          // Si estaba regresado "hasta que se valide", ahora lo atiende una cajera: la marca ya
          // no dice nada y, si lo regresa otra vez, se vuelve a poner.
          esperaValidacionDesdeAt: null,
        },
      });
      if (tomado.count !== 1) {
        throw new ConflictException('Este pedido ya está asignado a otra ventanilla');
      }
      const pedidoActualizado = await tx.pedido.findUniqueOrThrow({ where: { id: pedidoId } });

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: EstadoPedido.PENDIENTE_PAGO,
          estadoNuevo: EstadoPedido.PENDIENTE_PAGO,
          observacion: `Tomado para ventanilla por ${usuario.nombre}`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      return pedidoActualizado;
    });

    // Realtime DESPUÉS del commit: emitir dentro del callback manda el evento
    // antes de confirmar, y un rollback posterior dejaría a los clientes con
    // un aviso de algo que nunca pasó.
    if (emitirRealtime) {
      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.cajero-asignado', {
        id: pedidoId,
        numeroPedido: pedido.numeroPedido,
        cajeroAsignadoId: usuario.userId,
        cajeroAsignadoNombre: usuario.nombre,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.cajero-asignado', {
        id: pedidoId,
        cajeroAsignadoId: usuario.userId,
      });
    }

    return pedido;
  }

  async liberarPedidoCajero(pedidoId: number, usuario: UserContext) {
    const { actualizado, tiendaId } = await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');

      // Oct 2026 (destrabar): el GERENTE libera el pedido de una ventanilla que quedó atorada, pero solo en SU tienda
      // y solo por `DestrabarService` (con motivo y bitácora). Aquí no hay `cargarYValidar`, así que la tienda se
      // comprueba a mano: el servicio es frontera de confianza propia.
      const esGerenteDeLaTienda =
        usuario.rol === RolUsuario.GERENTE && pedido.tiendaId === usuario.tiendaId;
      const esAdmin = usuario.rol === RolUsuario.ADMIN;
      const esAsignado =
        usuario.rol === RolUsuario.CAJERO && pedido.cajeroAsignadoId === usuario.userId;

      if (!esAdmin && !esGerenteDeLaTienda && !esAsignado) {
        throw new BadRequestException(
          'Solo el cajero asignado al pedido (o un admin) puede liberarlo.',
        );
      }

      const pedidoActualizado = await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          cajeroAsignadoId: null,
          cajeroAsignadoAt: null,
        },
      });

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: pedido.estado,
          estadoNuevo: pedido.estado,
          observacion: `Liberado de ventanilla por ${usuario.nombre}`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      return { actualizado: pedidoActualizado, tiendaId: pedido.tiendaId };
    });

    // Realtime DESPUÉS del commit (mismo motivo que en `tomarPedidoCajero`).
    this.realtime.emitToTienda(tiendaId, 'pedido.cajero-liberado', {
      id: pedidoId,
      numeroPedido: actualizado.numeroPedido,
    });
    this.realtime.emitToPedido(pedidoId, 'pedido.cajero-liberado', { id: pedidoId });

    return actualizado;
  }

  /**
   * Oct 2026: "No se presentó" — el cajero llamó al cliente a su ventanilla y no llegó.
   *
   * No es `liberarPedidoCajero`: esa es para un error del CAJERO (tomó el pedido equivocado, lo
   * suelta) y conserva el lugar en la fila. Esta es para un cliente que tenía turno y no lo
   * usó, así que pasa al FINAL (`colaCajaDesdeAt = ahora`). Sin ella el cliente ausente volvía
   * a ser el primero de la fila y "Llamar siguiente" lo llamaba otra vez, y otra: la TV
   * anunciaba su folio en bucle mientras los que sí esperaban no avanzaban.
   *
   * Lo pueden hacer el cajero que lo tiene en su ventanilla y el ADMIN. La guarda va en el
   * `where` (TOCTOU): si otro movimiento lo alcanzó en medio, 409 en vez de pisarlo.
   */
  async noSePresento(pedidoId: number, usuario: UserContext) {
    const { actualizado, tiendaId } = await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');

      const esAdmin = usuario.rol === RolUsuario.ADMIN;
      const esAsignado =
        usuario.rol === RolUsuario.CAJERO && pedido.cajeroAsignadoId === usuario.userId;
      if (!esAdmin && !esAsignado) {
        throw new BadRequestException(
          'Solo el cajero asignado al pedido (o un admin) puede marcar que no se presentó.',
        );
      }
      if (pedido.estado !== EstadoPedido.PENDIENTE_PAGO || pedido.cajeroAsignadoId === null) {
        throw new BadRequestException(
          'Solo se marca "no se presentó" a un pedido que está en una ventanilla esperando pago.',
        );
      }

      const r = await tx.pedido.updateMany({
        where: {
          id: pedidoId,
          estado: EstadoPedido.PENDIENTE_PAGO,
          cajeroAsignadoId: pedido.cajeroAsignadoId,
        },
        data: {
          cajeroAsignadoId: null,
          cajeroAsignadoAt: null,
          colaCajaDesdeAt: new Date(),
          esperaValidacionDesdeAt: null,
        },
      });
      if (r.count !== 1) {
        throw new ConflictException(
          'El pedido cambió mientras se procesaba. Actualiza la pantalla.',
        );
      }

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: pedido.estado,
          estadoNuevo: pedido.estado,
          observacion: `No se presentó a la ventanilla (${usuario.nombre}): pasa al final de la fila`,
          usuarioId: usuario.userId > 0 ? usuario.userId : null,
          usuarioNombre: usuario.nombre,
        },
      });

      const actualizado = await tx.pedido.findUniqueOrThrow({ where: { id: pedidoId } });
      return { actualizado, tiendaId: pedido.tiendaId };
    });

    // Realtime DESPUÉS del commit. Es el mismo evento que "devolver a la cola": la TV y la
    // consola solo necesitan saber que el pedido salió de la ventanilla y volvió a la fila.
    this.realtime.emitToTienda(tiendaId, 'pedido.cajero-liberado', {
      id: pedidoId,
      numeroPedido: actualizado.numeroPedido,
    });
    this.realtime.emitToPedido(pedidoId, 'pedido.cajero-liberado', { id: pedidoId });

    return actualizado;
  }

  /**
   * Oct 2026 (16-oct): "Regresar a la cola hasta que se valide". A la ventanilla llegó un cliente
   * con una transferencia SIN validar. La cajera no puede cobrarle en caja (doble pago) y tiene dos
   * salidas: esperarlo ahí (no hace nada: se queda en su ventanilla) o esta, que lo suelta
   * conservando su lugar en la fila y deja una marca para que "Llamar siguiente" no lo vuelva a
   * llamar mientras la transferencia siga sin verificar.
   *
   * No es `liberarPedidoCajero`: ese lo deja primero y "Llamar siguiente" lo llamaría al instante,
   * y otra vez. Tampoco `noSePresento`: el cliente SÍ llegó, así que no pierde su lugar. Sin tope
   * de tiempo ni cronómetro (decisión del dueño): la cajera decide cuándo.
   *
   * Solo cabe con una transferencia sin validar (`puedeEsperarValidacion` en "mis pedidos" lo dice;
   * aquí se vuelve a comprobar). La guarda va en el `where` (TOCTOU).
   */
  async esperarValidacion(pedidoId: number, usuario: UserContext) {
    const { actualizado, tiendaId } = await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({
        where: { id: pedidoId },
        include: {
          pagosTransferencia: {
            where: { estado: { in: [...ESTADOS_NO_COBRAR] } },
            select: { id: true, estado: true },
            take: 1,
          },
        },
      });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');

      const esAdmin = usuario.rol === RolUsuario.ADMIN;
      const esAsignado =
        usuario.rol === RolUsuario.CAJERO && pedido.cajeroAsignadoId === usuario.userId;
      if (!esAdmin && !esAsignado) {
        throw new ForbiddenException(
          'Solo el cajero asignado al pedido (o un admin) puede regresarlo a la cola.',
        );
      }
      if (pedido.estado !== EstadoPedido.PENDIENTE_PAGO || pedido.cajeroAsignadoId === null) {
        throw new BadRequestException(
          'Solo se regresa "hasta que se valide" un pedido que está en una ventanilla esperando pago.',
        );
      }
      if (!esNoCobrar(pedido)) {
        throw new BadRequestException(
          'Este pedido no tiene una transferencia sin validar. Si ya se validó, regístrala en el Sistema Comercial; ' +
            'si va a pagar en caja, cóbralo o usa "Devolver a la cola".',
        );
      }

      const r = await tx.pedido.updateMany({
        where: {
          id: pedidoId,
          estado: EstadoPedido.PENDIENTE_PAGO,
          cajeroAsignadoId: pedido.cajeroAsignadoId,
        },
        // `colaCajaDesdeAt` NO se toca: conserva su lugar (a diferencia de "No se presentó").
        data: {
          cajeroAsignadoId: null,
          cajeroAsignadoAt: null,
          esperaValidacionDesdeAt: new Date(),
        },
      });
      if (r.count !== 1) {
        throw new ConflictException(
          'El pedido cambió mientras se procesaba. Actualiza la pantalla.',
        );
      }

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: pedido.estado,
          estadoNuevo: pedido.estado,
          observacion: `Regresado a la cola hasta que se valide la transferencia (${usuario.nombre}): conserva su lugar`,
          usuarioId: usuario.userId > 0 ? usuario.userId : null,
          usuarioNombre: usuario.nombre,
        },
      });

      const actualizado = await tx.pedido.findUniqueOrThrow({ where: { id: pedidoId } });
      return { actualizado, tiendaId: pedido.tiendaId };
    });

    // Realtime DESPUÉS del commit. Es el mismo evento que "devolver a la cola": la TV y las
    // consolas solo necesitan saber que el pedido salió de la ventanilla y volvió a la fila.
    this.realtime.emitToTienda(tiendaId, 'pedido.cajero-liberado', {
      id: pedidoId,
      numeroPedido: actualizado.numeroPedido,
    });
    this.realtime.emitToPedido(pedidoId, 'pedido.cajero-liberado', { id: pedidoId });

    return actualizado;
  }

  async obtenerMisPedidosCajero(usuarioId: number, tiendaId?: number) {
    const where: Prisma.PedidoWhereInput = {
      cajeroAsignadoId: usuarioId,
      estado: EstadoPedido.PENDIENTE_PAGO,
    };
    if (tiendaId) where.tiendaId = tiendaId;

    const pedidos = await this.prisma.pedido.findMany({
      where,
      include: {
        items: true,
        tienda: true,
        usuario: { select: { nombre: true, telefono: true, email: true } },
        pagosTransferencia: PAGO_PARA_CAJA,
      },
      orderBy: { cajeroAsignadoAt: 'asc' },
    });
    // El servidor decide qué botones caben: "Regresar a la cola hasta que se valide" solo con una
    // transferencia sin validar (`esperarValidacion` lo vuelve a exigir).
    const dtfPorPedido = await resumenDtfPorPedido(
      this.prisma,
      pedidos.map((p) => p.id),
    );
    return pedidos.map((p) => ({
      ...conPagoParaCaja(p),
      puedeEsperarValidacion: esNoCobrar(p),
      dtfResumen: dtfPorPedido.get(p.id) ?? null,
    }));
  }

  /**
   * F11 (ago 2026): "Llamar siguiente" — el cajero presiona el botón, toma el
   * primer pedido en PENDIENTE_PAGO sin asignar (FIFO por fechaPedido) y se lo
   * asigna a su ventanilla.
   *
   * F16 (sep 2026): ya NO filtra por canal. Antes solo tomaba pedidos KIOSKO,
   * así que con el flujo nuevo "Llamar siguiente" habría devuelto 404 aunque
   * hubiera pedidos web esperando en la cola — el bug más fácil de cometer al
   * quitar el candado de canal (habría que quitarlo también aquí).
   *
   * Precondiciones:
   *  - El cajero debe tener una ventanilla elegida. Si no, 400.
   *  - Si no hay pedidos en cola, 404 (la cajera verá "No hay turnos").
   *
   * Realtime: emite `pedido.llamado` con el folio + número de ventanilla a
   * `tienda-{id}` para que el TV muestre la alerta bancaria.
   */
  async llamarSiguiente(usuario: UserContext, tiendaId: number | undefined = usuario.tiendaId) {
    // F3.5: la tienda llega resuelta (`@TiendaConsola()`): la del cajero, o la que el ADMIN opera. El ADMIN
    // necesita una ventanilla EN ELLA (se comprueba abajo, igual que para un cajero).
    if (!tiendaId) {
      throw new BadRequestException('Tu usuario no tiene tienda asignada');
    }

    // 1) Verificar que el cajero tiene ventanilla.
    const ventanilla = await this.ventanillasService.ventanillaDelCajero(usuario.userId, tiendaId);
    if (!ventanilla) {
      throw new BadRequestException(
        'Debes elegir una ventanilla antes de llamar al siguiente turno',
      );
    }

    // 2) Buscar el primer pedido sin asignar (FIFO) y tomarlo. Sin filtro de canal: los
    // pedidos web liberados por mostrador también se cobran aquí.
    //
    // Oct 2026: buscar y tomar no son atómicos. Dos cajeros que presionaban "Llamar
    // siguiente" a la vez elegían el MISMO pedido; ahora la toma lleva guarda y el que
    // pierde la carrera (409) vuelve a buscar — el pedido que le ganaron ya no está sin
    // asignar, así que le toca el siguiente de la fila.
    let pedido: Awaited<ReturnType<CajeroService['tomarPedidoCajeroInterno']>> | null = null;
    for (let intento = 0; intento < INTENTOS_LLAMAR_SIGUIENTE && !pedido; intento++) {
      // Oct 2026: la MISMA fila y el MISMO orden que ve la TV (`cola-caja.util.ts`): por llegada a
      // caja, las transferencias verificadas primero. Las transferencias sin verificar SÍ se llaman
      // en su turno (16-oct): ese cliente puede necesitar ayuda para transferir. Solo se salta lo que
      // la cajera regresó "hasta que se valide" (`esperarValidacion`), o lo volvería a llamar al
      // instante, y otra vez.
      const candidatos = await this.prisma.pedido.findMany({
        where: { ...whereFilaDeCaja(tiendaId), ...WHERE_LLAMABLE },
        select: SELECT_ORDEN_COLA_CAJA,
      });
      const [siguiente] = ordenarFilaDeCaja(candidatos);
      if (!siguiente) {
        throw new NotFoundException('No hay turnos siguientes en la cola');
      }

      // 3) Asignar al cajero (sin emitir `pedido.cajero-asignado` — la alerta
      // bancaria la emitimos nosotros para no duplicar sonidos).
      try {
        pedido = await this.tomarPedidoCajeroInterno(siguiente.id, usuario, false);
      } catch (err) {
        if (!(err instanceof ConflictException)) throw err;
        // Otro cajero lo tomó en este instante: siguiente intento.
      }
    }
    if (!pedido) {
      throw new ConflictException('Otro cajero tomó el turno al mismo tiempo. Inténtalo de nuevo.');
    }

    // 4) Realtime: alerta bancaria para el TV + sonido.
    this.realtime.emitToTienda(tiendaId, 'pedido.cajero-asignado', {
      id: pedido.id,
      numeroPedido: pedido.numeroPedido,
      turno: turnoCorto(pedido.folioErp),
      cajeroAsignadoId: usuario.userId,
      cajeroAsignadoNombre: usuario.nombre,
    });
    this.realtime.emitToTienda(tiendaId, 'pedido.llamado', {
      id: pedido.id,
      numeroPedido: pedido.numeroPedido,
      turno: turnoCorto(pedido.folioErp),
      ventanillaId: ventanilla.id,
      ventanillaNumero: ventanilla.numero,
      cajeroId: usuario.userId,
      cajeroNombre: usuario.nombre,
    });

    this.logger.log(
      `Cajero ${usuario.userId} llamó turno ${pedido.numeroPedido} a ventanilla ${ventanilla.numero}`,
    );

    return {
      pedidoId: pedido.id,
      numeroPedido: pedido.numeroPedido,
      // Con estas dos el servidor decora la respuesta con su `folio` (el toast de la cajera lo usa).
      tiendaId: pedido.tiendaId,
      folioErp: pedido.folioErp,
      ventanillaId: ventanilla.id,
      ventanillaNumero: ventanilla.numero,
    };
  }
}
