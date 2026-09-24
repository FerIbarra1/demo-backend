import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoAccessService } from '../core/pedido-access.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { ReposicionService } from '../reposicion/reposicion.service';
import { destinoTrasSurtido } from '../core/destino-post-surtido.util';
import { recalcularTotalesPedido } from '../core/totales.util';
import { aplicarCambiosFisicos } from '../core/aplicar-cambios-surtido.util';
import { PreciosService } from '../../precios/precios.service';
import { precioDeLista, ColumnaLista } from '../../precios/precio-lista.util';
import { UserContext } from '../../../types/pedido.types';
import {
  EstadoPedido,
  EstadoPropuesta,
  EstadoSurtido,
  RolUsuario,
  Prisma,
} from '@prisma/client';
import {
  CrearPropuestaDto,
  ResponderPropuestaDto,
  DecisionPropuesta,
} from './dto/propuesta.dto';

/**
 * F12/F13 (sep 2026): flujo de propuesta/contrapropuesta entre el negocio y
 * el cliente.
 *
 * Hay DOS orígenes de propuesta, y las decisiones legales del cliente
 * dependen del origen:
 *
 *   BODEGA  — el bodeguero verificó existencia y reporta hay todo / hay menos
 *             / no hay. Decisiones: APROBAR | RECHAZAR | CONTACTAR_ASESOR.
 *   VENTAS  — el asesor de ventas negoció por chat y propone productos,
 *             cantidades o variantes distintas. Decisiones:
 *             APROBAR | RECHAZAR | CANCELAR_PEDIDO.
 *
 * Qué pasa con cada decisión:
 *   APROBAR (bodega)  → aplica los cambios y va DIRECTO a PENDING_PAID.
 *                       Bodega ya verificó físicamente lo que propuso.
 *   APROBAR (ventas)  → aplica los cambios y vuelve a REVIEWING SIN ASIGNAR,
 *                       porque el vendedor propuso productos que nadie
 *                       verificó en el anaquel.
 *   RECHAZAR (bodega) → CANCELLED + lista de reposición.
 *   RECHAZAR (ventas) → vuelve a EN_ASESORIA para re-negociar (el chat sigue).
 *   CONTACTAR_ASESOR  → la propuesta de bodega queda SUPERADA y el pedido pasa
 *                       a EN_ASESORIA (cola del asesor de la tienda).
 *   CANCELAR_PEDIDO   → CANCELLED + lista de reposición.
 *
 * La propuesta se ATA AL PEDIDO, no al autor: si el bodeguero la libera a la
 * cola, la propuesta persiste y la respuesta del cliente se aplica al pedido
 * sin importar quién esté asignado.
 */
@Injectable()
export class PropuestaService {
  private readonly logger = new Logger(PropuestaService.name);

  /**
   * F13: qué decisiones puede tomar el cliente según quién propuso. Se
   * valida server-side porque el frontend no es de confianza — un cliente
   * podría mandar `CANCELAR_PEDIDO` sobre una propuesta de bodega, o
   * `CONTACTAR_ASESOR` sobre una de ventas (que ya está en asesoría).
   */
  private static readonly DECISIONES_POR_ORIGEN: Record<RolUsuario, DecisionPropuesta[]> = {
    [RolUsuario.BODEGA]: ['APROBAR', 'RECHAZAR', 'CONTACTAR_ASESOR'],
    [RolUsuario.VENTAS]: ['APROBAR', 'RECHAZAR', 'CANCELAR_PEDIDO'],
    // El resto de roles no crean propuestas; el mapa se completa para que
    // TypeScript exija revisarlo si se agrega un rol nuevo.
    [RolUsuario.CLIENTE]: [],
    [RolUsuario.BODEGA_MONITOR]: [],
    [RolUsuario.CAJERO]: [],
    [RolUsuario.CAJERO_MONITOR]: [],
    [RolUsuario.MOSTRADOR]: [],
    // F16: la TV del mostrador solo lee; no propone ni decide nada.
    [RolUsuario.MOSTRADOR_MONITOR]: [],
    [RolUsuario.ADMIN]: ['APROBAR', 'RECHAZAR', 'CONTACTAR_ASESOR', 'CANCELAR_PEDIDO'],
  };

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private access: PedidoAccessService,
    private state: PedidoStateService,
    private reposicion: ReposicionService,
    private precios: PreciosService,
  ) {}

  /**
   * Envía una propuesta al cliente.
   *
   * - BODEGA: requiere estar asignado al pedido y que esté en REVIEWING.
   * - VENTAS: requiere que el pedido esté en EN_ASESORIA (o ya en
   *   WAITING_CUSTOMER_APPROVAL re-negociando).
   *
   * El pedido pasa a WAITING_CUSTOMER_APPROVAL y el reloj de atención se
   * DETIENE (el pedido sale de bodega; antes se pausaba pero seguía asignado).
   * `asignadoAId` se limpia para liberar el slot del bodeguero.
   *
   * Si ya existe una propuesta PENDIENTE, se rechaza. Además de este chequeo,
   * hay un índice único parcial en BD que cierra la carrera entre dos envíos
   * concurrentes (ahora posibles: BODEGA y VENTAS pueden proponer).
   */
  async enviarPropuesta(
    pedidoId: number,
    dto: CrearPropuestaDto,
    usuario: UserContext,
  ) {
    const esVentas = usuario.rol === RolUsuario.VENTAS;
    const esBodega = usuario.rol === RolUsuario.BODEGA;

    if (!esVentas && !esBodega && usuario.rol !== RolUsuario.ADMIN) {
      throw new BadRequestException(
        'Sólo bodega o el asesor de ventas pueden enviar propuestas.',
      );
    }

    await this.access.cargarYValidar(pedidoId, usuario, {
      // El bodeguero solo propone sobre pedidos que él tiene asignados.
      // El vendedor atiende la cola de su tienda, sin asignación 1:1.
      requiereAsignacionBodega: esBodega,
    });

    if (dto.items.length === 0) {
      throw new BadRequestException('La propuesta debe tener al menos un item.');
    }

    // F16 (sep 2026): si la propuesta viene de BODEGA, ningún item del pedido
    // puede seguir PENDIENTE. Sin este guard, una propuesta puede llegar al
    // cliente sin que bodega haya marcado cada item, y al aprobarla el pedido
    // avanza con `cantidadSurtida: 0` en items que nadie verificó (mismo
    // escenario que el bug original del 400, pero al revés).
    //
    // El frontend (`BodegaSurtidoSheet`) ya bloquea el botón, pero la API es
    // frontera de confianza.
    if (esBodega) {
      const itemsPedido = await this.prisma.itemPedido.findMany({
        where: { pedidoId, cancelada: false },
        select: { id: true, estadoSurtido: true },
      });
      const idsEnPropuesta = new Set(
        dto.items
          .filter((i) => i.itemId > 0)
          .map((i) => i.itemId),
      );
      // Contamos items del pedido que bodega no marcó y que la propuesta
      // tampoco menciona — esos son los PENDIENTE que quedarían sin surtir.
      const idsPendientesSinCubrir = itemsPedido
        .filter(
          (i) =>
            i.estadoSurtido === EstadoSurtido.PENDIENTE &&
            !idsEnPropuesta.has(i.id),
        )
        .map((i) => i.id);
      if (idsPendientesSinCubrir.length > 0) {
        throw new BadRequestException(
          `Hay ${idsPendientesSinCubrir.length} item(s) sin marcar. Márcalos (Hay todo / Hay menos / No hay) antes de enviar la propuesta.`,
        );
      }
    }

    // F13: el total NUNCA se confía al cliente del API. Ahora que ventas
    // propone productos con precios, un vendedor podría mandar `total: 0` y el
    // cliente aprobaría un número distinto al que se le cobra. Se recalcula
    // desde los items.
    const totalCalculado = dto.items.reduce(
      (acc, it) => acc + (it.subtotalNuevo ?? it.subtotal),
      0,
    );

    const pedido = await this.prisma.pedido.findUnique({ where: { id: pedidoId } });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');

    const estadosPermitidos: EstadoPedido[] = esVentas
      ? [EstadoPedido.EN_ASESORIA, EstadoPedido.WAITING_CUSTOMER_APPROVAL]
      : [EstadoPedido.REVIEWING];
    if (!estadosPermitidos.includes(pedido.estado)) {
      throw new BadRequestException(
        `No se puede enviar una propuesta desde el estado ${pedido.estado}.`,
      );
    }

    const pendiente = await this.prisma.pedidoPropuesta.findFirst({
      where: { pedidoId, estado: EstadoPropuesta.PENDIENTE },
      select: { id: true },
    });
    if (pendiente) {
      throw new ConflictException(
        'Ya existe una propuesta pendiente de respuesta del cliente. Espera a que responda.',
      );
    }

    const propuesta = await this.prisma.pedidoPropuesta.create({
      data: {
        pedidoId,
        estado: EstadoPropuesta.PENDIENTE,
        items: dto.items as unknown as Prisma.InputJsonValue,
        total: new Prisma.Decimal(totalCalculado),
        nota: dto.nota ?? null,
        creadaPorId: usuario.userId,
        creadaPorRol: usuario.rol,
      },
    });

    // Transicionar a WAITING_CUSTOMER_APPROVAL. El reloj se DETIENE y el
    // pedido se libera: el bodeguero ya no puede accionar nada.
    await this.state.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
        observacion: esVentas
          ? `Propuesta del asesor de ventas enviada al cliente (${dto.items.length} item(s))`
          : `Propuesta de bodega enviada al cliente (${dto.items.length} item(s))`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        invalidarMonitor: true,
      },
    );

    // Aviso al cliente por realtime (el email lo manda la máquina de estados
    // al entrar a WAITING_CUSTOMER_APPROVAL).
    this.realtime.emitToUser(pedido.usuarioId, 'propuesta.enviada', {
      pedidoId,
      propuestaId: propuesta.id,
      origen: usuario.rol,
    });

    this.logger.log(
      `Pedido ${pedidoId}: propuesta #${propuesta.id} de ${usuario.rol} enviada → WAITING_CUSTOMER_APPROVAL`,
    );

    return propuesta;
  }

  /**
   * El cliente responde a una propuesta. La decisión debe ser legal para el
   * ORIGEN de la propuesta (ver `DECISIONES_POR_ORIGEN`).
   *
   * Sólo el cliente dueño del pedido puede responder.
   */
  async responderPropuesta(
    pedidoId: number,
    propuestaId: number,
    dto: ResponderPropuestaDto,
    usuario: UserContext,
  ) {
    await this.access.cargarYValidar(pedidoId, usuario);

    const propuesta = await this.prisma.pedidoPropuesta.findFirst({
      where: { id: propuestaId, pedidoId },
    });
    if (!propuesta) throw new NotFoundException('Propuesta no encontrada');
    if (propuesta.estado !== EstadoPropuesta.PENDIENTE) {
      throw new ConflictException(
        `Esta propuesta ya fue respondida (estado: ${propuesta.estado})`,
      );
    }

    const pedido = await this.prisma.pedido.findUnique({ where: { id: pedidoId } });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    if (pedido.estado !== EstadoPedido.WAITING_CUSTOMER_APPROVAL) {
      throw new BadRequestException(
        `El pedido no está esperando aprobación (actual: ${pedido.estado})`,
      );
    }

    // F13: validar que la decisión sea legal para el origen de la propuesta.
    const legales = PropuestaService.DECISIONES_POR_ORIGEN[propuesta.creadaPorRol];
    if (!legales.includes(dto.decision)) {
      throw new BadRequestException(
        `La decisión ${dto.decision} no aplica a una propuesta de ${propuesta.creadaPorRol}. ` +
          `Opciones válidas: ${legales.join(', ')}.`,
      );
    }

    const ahora = new Date();
    const esDeBodega = propuesta.creadaPorRol === RolUsuario.BODEGA;

    const resultado = await (async () => {
      switch (dto.decision) {
        case 'APROBAR':
          return esDeBodega
            ? this.aprobarPropuestaBodega(pedido, propuesta, dto, usuario, ahora)
            : this.aprobarPropuestaVentas(pedido, propuesta, dto, usuario, ahora);

        case 'RECHAZAR':
          return esDeBodega
            ? this.rechazarPropuestaBodega(pedido, propuesta, dto, usuario, ahora)
            : this.rechazarPropuestaVentas(pedido, propuesta, dto, usuario, ahora);

        case 'CONTACTAR_ASESOR':
          return this.contactarAsesor(pedido, propuesta, dto, usuario, ahora);

        case 'CANCELAR_PEDIDO':
          return this.cancelarPorPropuesta(pedido, propuesta, dto, usuario, ahora);
      }
    })();

    // F14: avisar al asesor (y a la tienda) que el cliente ya respondió. Sin
    // esto el asesor no se entera hasta que recargue a mano, y en el caso de
    // "Quiero ajustes" queda esperando una respuesta que ya llegó.
    const estadoFinal = await this.prisma.pedidoPropuesta.findUnique({
      where: { id: propuestaId },
      select: { estado: true },
    });
    const payload = {
      pedidoId,
      propuestaId,
      decision: dto.decision,
      estado: estadoFinal?.estado ?? null,
    };
    this.realtime.emitToPedido(pedidoId, 'propuesta.respondida', payload);
    this.realtime.emitToTienda(pedido.tiendaId, 'propuesta.respondida', payload);

    return resultado;
  }

  /**
   * Cliente APROBÓ una propuesta de BODEGA: aplica los cambios y va DIRECTO a
   * PENDING_PAID. El bodeguero ya verificó físicamente lo que propuso, así que
   * no hay nada que confirmar después.
   */
  private async aprobarPropuestaBodega(
    pedido: { id: number; tiendaId: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
    propuesta: { id: number },
    dto: { nota?: string },
    usuario: UserContext,
    ahora: Date,
  ) {
    const pedidoCompleto = await this.prisma.pedido.findUnique({
      where: { id: pedido.id },
      include: { items: true },
    });
    if (!pedidoCompleto) throw new NotFoundException('Pedido no encontrado');

    const itemsConFaltante = pedidoCompleto.items.filter(
      (i) =>
        !i.cancelada &&
        (i.estadoSurtido === 'PARCIAL' || i.estadoSurtido === 'NO_DISPONIBLE'),
    );

    // F16 (sep 2026): red de seguridad — si por una carrera quedaron items
    // PENDIENTE (la UI los bloquea, pero la API es frontera de confianza),
    // cancelarlos y volver a REVIEWING en vez de avanzar a pago/mostrador.
    // Sin esto, un item PENDIENTE llegaría al ERP con `cantidadSurtida: 0`,
    // rompiendo el invariante "lo que se cobra es lo que se surtió".
    //
    // Mismo patrón que `aprobarPropuestaVentas`: cuando la aplicación de la
    // propuesta descubre un faltante residual, el pedido vuelve a bodega con
    // el reloj reanudado para mantener la urgencia.
    const itemsPendientesResidual = pedidoCompleto.items.filter(
      (i) => !i.cancelada && i.estadoSurtido === EstadoSurtido.PENDIENTE,
    );
    if (itemsPendientesResidual.length > 0) {
      // Cancelar los items PENDIENTE para que no queden como "fantasma" en
      // el ERP. Es el mismo tratamiento que `aplicarCambiosFisicos` da a
      // NO_DISPONIBLE.
      await this.prisma.$transaction(async (tx) => {
        for (const it of itemsPendientesResidual) {
          await tx.itemPedido.update({
            where: { id: it.id },
            data: {
              cancelada: true,
              estadoSurtido: 'NO_DISPONIBLE',
              cantidadSurtida: 0,
            },
          });
        }
        // Si tras cancelar no queda ningún item activo, fallar como hacen
        // los otros dos caminos (espejo del guard de `aplicarCambiosDeBodega`
        // y `aplicarPropuestaDeVentas`).
        const activos = await tx.itemPedido.count({
          where: { pedidoId: pedido.id, cancelada: false },
        });
        if (activos === 0) {
          throw new BadRequestException(
            'No puedes aprobar esta propuesta: dejaría el pedido sin productos. ' +
              'Cancela el pedido en vez de aprobarlo.',
          );
        }
        await tx.pedidoPropuesta.update({
          where: { id: propuesta.id },
          data: {
            estado: EstadoPropuesta.ACEPTADA,
            respondidaAt: ahora,
            notaCliente: dto.nota ?? null,
            consumidaAt: ahora,
          },
        });
      });

      // Transición alternativa: vuelve a bodega con reloj reanudado.
      await this.state.cambiarEstado(
        pedido.id,
        {
          nuevoEstado: EstadoPedido.REVIEWING,
          observacion: `Propuesta #${propuesta.id} aprobada pero quedaban ${itemsPendientesResidual.length} item(s) PENDIENTE — vuelve a bodega`,
        },
        usuario,
        {
          asignacion: 'limpiar',
          reloj: 'reanudar',
          invalidarMonitor: true,
        },
      );

      this.logger.log(
        `Pedido ${pedido.id}: propuesta #${propuesta.id} aprobada pero ${itemsPendientesResidual.length} item(s) PENDIENTE → REVIEWING`,
      );

      return {
        mensaje: `Propuesta aprobada. ${itemsPendientesResidual.length} item(s) quedaron pendientes — bodega debe volver a surtirlos.`,
        estado: EstadoPedido.REVIEWING,
        propuestaId: propuesta.id,
      };
    }

    // F16 (sep 2026): el destino depende del modo de entrega. Un pedido a
    // domicilio NO pasa por mostrador (el cliente no está en tienda): va
    // directo a pago con encolado inmediato a Firebird. Uno de tienda se
    // aparta en EN_MOSTRADOR y entra al ERP cuando mostrador lo libere.
    const destino = destinoTrasSurtido(pedidoCompleto.modoEntrega);

    let cambios: string[] = [];
    await this.state.cambiarEstado(
      pedido.id,
      {
        nuevoEstado: destino.estado,
        observacion:
          destino.estado === EstadoPedido.EN_MOSTRADOR
            ? `Cliente aprobó la propuesta #${propuesta.id} de bodega — pasa a mostrador`
            : `Cliente aprobó la propuesta #${propuesta.id} de bodega — pendiente de pago`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        encolarFirebird: destino.encolarFirebird,
        invalidarMonitor: true,
        efectos: async (tx) => {
          await tx.pedidoPropuesta.update({
            where: { id: propuesta.id },
            data: {
              estado: EstadoPropuesta.ACEPTADA,
              respondidaAt: ahora,
              notaCliente: dto.nota ?? null,
              consumidaAt: ahora,
            },
          });
          cambios = await this.aplicarCambiosDeBodega(tx, pedido, itemsConFaltante);
        },
      },
    );

    this.logger.log(
      `Pedido ${pedido.id}: cliente aprobó propuesta #${propuesta.id} de bodega → ${destino.estado}`,
    );

    return {
      mensaje:
        destino.estado === EstadoPedido.EN_MOSTRADOR
          ? 'Propuesta aprobada. Pasa a mostrador a revisar tu pedido.'
          : 'Propuesta aprobada. Tu pedido pasa a pago.',
      estado: destino.estado,
      propuestaId: propuesta.id,
      cambiosAplicados: cambios.length,
    };
  }

  /**
   * Cliente APROBÓ una propuesta de VENTAS: aplica los cambios y devuelve el
   * pedido a bodega SIN ASIGNAR, porque el vendedor propuso productos que
   * nadie verificó en el anaquel.
   *
   * Optimización: si al aplicar no queda ningún item PENDIENTE de surtir, va
   * directo a PENDING_PAID (no tiene sentido rebotar por bodega).
   */
  private async aprobarPropuestaVentas(
    pedido: { id: number; tiendaId: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
    propuesta: { id: number; items: Prisma.JsonValue },
    dto: { nota?: string },
    usuario: UserContext,
    ahora: Date,
  ) {
    const pedidoCompleto = await this.prisma.pedido.findUnique({
      where: { id: pedido.id },
      include: { items: true },
    });
    if (!pedidoCompleto) throw new NotFoundException('Pedido no encontrado');

    // Fase 0 (sep 2026): la lista de precios del CLIENTE que hizo el pedido.
    // Se resuelve aquí, fuera de la transacción, porque `PreciosService` usa
    // `prisma` (no el `tx`) y los items que el asesor agregue tienen que
    // congelarse con esa lista.
    const columnaLista = await this.precios.columnaParaPedido(pedidoCompleto);

    let quedanPendientes = false;
    let cambios: string[] = [];

    await this.state.cambiarEstado(
      pedido.id,
      {
        nuevoEstado: EstadoPedido.REVIEWING,
        observacion: `Cliente aprobó la propuesta #${propuesta.id} del asesor de ventas — vuelve a bodega a surtir`,
      },
      usuario,
      {
        // CRÍTICO: el caller es el CLIENTE. Con 'caller' el pedido quedaría
        // asignado a él, invisible en el monitor y bloqueado para todo
        // bodeguero. Debe volver a la cola sin asignar.
        asignacion: 'limpiar',
        // La pelota vuelve a bodega: el reloj se reanuda acumulando lo previo.
        reloj: 'reanudar',
        invalidarMonitor: true,
        efectos: async (tx) => {
          await tx.pedidoPropuesta.update({
            where: { id: propuesta.id },
            data: {
              estado: EstadoPropuesta.ACEPTADA,
              respondidaAt: ahora,
              notaCliente: dto.nota ?? null,
              consumidaAt: ahora,
            },
          });
          const r = await this.aplicarPropuestaDeVentas(
            tx,
            pedido,
            propuesta.items as unknown as ItemPropuestaJson[],
            pedidoCompleto.items,
            columnaLista,
          );
          cambios = r.cambios;
          quedanPendientes = r.quedanPendientes;
        },
      },
    );

    // Si no quedó nada por surtir, no hay razón para que bodega lo revise:
    // pasa a mostrador (o directo a pago si es a domicilio). Se hace en una
    // segunda transición porque el encolado a Firebird solo aplica al llegar
    // a PENDING_PAID.
    if (!quedanPendientes) {
      // F16: mismo helper que los otros dos caminos — no puede divergir.
      const destino = destinoTrasSurtido(pedidoCompleto.modoEntrega);
      await this.state.cambiarEstado(
        pedido.id,
        {
          nuevoEstado: destino.estado,
          observacion:
            destino.estado === EstadoPedido.EN_MOSTRADOR
              ? 'Propuesta de ventas aplicada sin items pendientes de surtir — pasa a mostrador'
              : 'Propuesta de ventas aplicada sin items pendientes de surtir — pendiente de pago',
        },
        usuario,
        {
          asignacion: 'limpiar',
          reloj: 'detener',
          encolarFirebird: destino.encolarFirebird,
          invalidarMonitor: true,
        },
      );
      this.logger.log(
        `Pedido ${pedido.id}: propuesta #${propuesta.id} de ventas aplicada sin pendientes → ${destino.estado}`,
      );
      return {
        mensaje:
          destino.estado === EstadoPedido.EN_MOSTRADOR
            ? 'Propuesta aprobada. Pasa a mostrador a revisar tu pedido.'
            : 'Propuesta aprobada. Tu pedido pasa a pago.',
        estado: destino.estado,
        propuestaId: propuesta.id,
        cambiosAplicados: cambios.length,
      };
    }

    this.logger.log(
      `Pedido ${pedido.id}: cliente aprobó propuesta #${propuesta.id} de ventas → REVIEWING (bodega surte)`,
    );

    return {
      mensaje: 'Propuesta aprobada. Bodega surtirá los productos nuevos.',
      estado: EstadoPedido.REVIEWING,
      propuestaId: propuesta.id,
      cambiosAplicados: cambios.length,
    };
  }

  /**
   * Cliente RECHAZÓ una propuesta de BODEGA: el pedido se cancela y sus
   * productos entran a la lista de reposición de bodega.
   */
  private async rechazarPropuestaBodega(
    pedido: { id: number; tiendaId: number },
    propuesta: { id: number },
    dto: { nota?: string },
    usuario: UserContext,
    ahora: Date,
  ) {
    await this.state.cambiarEstado(
      pedido.id,
      {
        nuevoEstado: EstadoPedido.CANCELLED,
        observacion: `Cliente rechazó la propuesta #${propuesta.id} de bodega${dto.nota ? `: ${dto.nota}` : ''}`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        invalidarMonitor: true,
        efectos: async (tx) => {
          await tx.pedidoPropuesta.update({
            where: { id: propuesta.id },
            data: {
              estado: EstadoPropuesta.RECHAZADA,
              respondidaAt: ahora,
              notaCliente: dto.nota ?? null,
            },
          });
          await this.reposicion.crearDesdePedido(tx, pedido.id, dto.nota);
        },
      },
    );

    this.logger.log(
      `Pedido ${pedido.id}: cliente rechazó propuesta #${propuesta.id} de bodega → CANCELLED + reposición`,
    );

    return {
      mensaje: 'Propuesta rechazada. Tu pedido fue cancelado.',
      estado: EstadoPedido.CANCELLED,
      propuestaId: propuesta.id,
    };
  }

  /**
   * Cliente RECHAZÓ una propuesta de VENTAS: el pedido vuelve a EN_ASESORIA
   * para que el asesor re-negocie. El chat sigue vivo.
   */
  private async rechazarPropuestaVentas(
    pedido: { id: number; tiendaId: number },
    propuesta: { id: number },
    dto: { nota?: string },
    usuario: UserContext,
    ahora: Date,
  ) {
    await this.state.cambiarEstado(
      pedido.id,
      {
        nuevoEstado: EstadoPedido.EN_ASESORIA,
        observacion: `Cliente rechazó la propuesta #${propuesta.id} del asesor — sigue en asesoría${dto.nota ? `: ${dto.nota}` : ''}`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        invalidarMonitor: true,
        efectos: async (tx) => {
          await tx.pedidoPropuesta.update({
            where: { id: propuesta.id },
            data: {
              estado: EstadoPropuesta.RECHAZADA,
              respondidaAt: ahora,
              notaCliente: dto.nota ?? null,
            },
          });
        },
      },
    );

    this.logger.log(
      `Pedido ${pedido.id}: cliente rechazó propuesta #${propuesta.id} de ventas → EN_ASESORIA`,
    );

    return {
      mensaje: 'Propuesta rechazada. El asesor te contactará con otras opciones.',
      estado: EstadoPedido.EN_ASESORIA,
      propuestaId: propuesta.id,
    };
  }

  /**
   * Cliente pidió un asesor de ventas desde una propuesta de BODEGA: la
   * propuesta queda SUPERADA (sin efecto) y el pedido entra a la cola del
   * asesor de la tienda.
   */
  private async contactarAsesor(
    pedido: { id: number; tiendaId: number; usuarioId: number },
    propuesta: { id: number },
    dto: { nota?: string },
    usuario: UserContext,
    ahora: Date,
  ) {
    await this.state.cambiarEstado(
      pedido.id,
      {
        nuevoEstado: EstadoPedido.EN_ASESORIA,
        observacion: `Cliente pidió asesor de ventas${dto.nota ? `: ${dto.nota}` : ''}`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        invalidarMonitor: true,
        efectos: async (tx) => {
          // La propuesta de bodega queda sin efecto: el cliente ya no decide
          // sobre ella, va a negociar con el asesor.
          await tx.pedidoPropuesta.update({
            where: { id: propuesta.id },
            data: {
              estado: EstadoPropuesta.SUPERADA,
              respondidaAt: ahora,
              notaCliente: dto.nota ?? null,
            },
          });
          await tx.pedido.update({
            where: { id: pedido.id },
            data: {
              asesorSolicitadoAt: ahora,
              asesorSolicitudNota: dto.nota ?? null,
            },
          });
        },
      },
    );

    // Avisar al equipo de ventas de la tienda por realtime (la cola se
    // refresca sola; el evento es para que suene/avise si están conectados).
    this.realtime.emitToTienda(pedido.tiendaId, 'asesor.solicitado', {
      pedidoId: pedido.id,
    });

    this.logger.log(
      `Pedido ${pedido.id}: cliente pidió asesor → EN_ASESORIA (propuesta #${propuesta.id} SUPERADA)`,
    );

    return {
      mensaje: 'Un asesor de ventas te contactará en breve.',
      estado: EstadoPedido.EN_ASESORIA,
      propuestaId: propuesta.id,
    };
  }

  /**
   * Cliente CANCELÓ el pedido desde una propuesta de VENTAS: se cancela y sus
   * productos entran a la lista de reposición.
   */
  private async cancelarPorPropuesta(
    pedido: { id: number; tiendaId: number },
    propuesta: { id: number },
    dto: { nota?: string },
    usuario: UserContext,
    ahora: Date,
  ) {
    await this.state.cambiarEstado(
      pedido.id,
      {
        nuevoEstado: EstadoPedido.CANCELLED,
        observacion: `Cliente canceló el pedido durante la asesoría${dto.nota ? `: ${dto.nota}` : ''}`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        invalidarMonitor: true,
        efectos: async (tx) => {
          await tx.pedidoPropuesta.update({
            where: { id: propuesta.id },
            data: {
              estado: EstadoPropuesta.RECHAZADA,
              respondidaAt: ahora,
              notaCliente: dto.nota ?? null,
            },
          });
          await this.reposicion.crearDesdePedido(tx, pedido.id, dto.nota);
        },
      },
    );

    this.logger.log(
      `Pedido ${pedido.id}: cliente canceló desde propuesta #${propuesta.id} de ventas → CANCELLED + reposición`,
    );

    return {
      mensaje: 'Pedido cancelado.',
      estado: EstadoPedido.CANCELLED,
      propuestaId: propuesta.id,
    };
  }

  /**
   * Aplica los cambios de una propuesta de BODEGA: cancela NO_DISPONIBLES y
   * ajusta PARCIALES. Delega en el helper compartido `aplicarCambiosFisicos`
   * — antes era una copia divergente de `SurtidoService.aplicarCambiosSurtido`
   * que produjo los bugs A–D.
   */
  private async aplicarCambiosDeBodega(
    tx: Prisma.TransactionClient,
    pedido: { id: number; tiendaId: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
    itemsConFaltante: Array<{
      id: number;
      cantidad: number;
      cantidadSurtida: number;
      estadoSurtido: 'PENDIENTE' | 'PARCIAL' | 'COMPLETO' | 'NO_DISPONIBLE';
      motivoSurtido: string | null;
    }>,
  ): Promise<string[]> {
    const cambios = await aplicarCambiosFisicos(tx, pedido, itemsConFaltante);

    // F16: guard espejo del de `confirmarSurtido` y del de
    // `aplicarPropuestaDeVentas` (que es el tercer lugar donde se necesitaba).
    // Sin esto, una propuesta con todos los items NO_DISPONIBLE dejaba el
    // pedido sin productos y avanzaba a pago con subtotal: 0.
    const activos = await tx.itemPedido.count({
      where: { pedidoId: pedido.id, cancelada: false },
    });
    if (activos === 0) {
      throw new BadRequestException(
        'No puedes aprobar esta propuesta: dejaría el pedido sin productos. ' +
          'Cancela el pedido en vez de aprobarlo.',
      );
    }

    await recalcularTotalesPedido(tx, pedido);
    return cambios;
  }

  /**
   * Aplica una propuesta de VENTAS sobre los items del pedido. La propuesta es
   * un BORRADOR: nada tocó `ItemPedido` hasta este momento.
   *
   * Reglas:
   *   - 'completo'      → no toca nada (el bodeguero ya lo verificó).
   *   - 'parcial'       → ajusta la cantidad del item existente.
   *   - 'no-disponible' → cancela el item.
   *   - 'cambio'        → cancela el original y crea uno nuevo (PENDIENTE).
   *   - 'agregado'      → crea una línea nueva (PENDIENTE).
   *
   * Los items que la propuesta no menciona conservan el `estadoSurtido` que el
   * bodeguero ya había verificado.
   *
   * Devuelve `quedanPendientes`: true si algún item quedó por surtir, lo que
   * determina si el pedido vuelve a bodega o va directo a pago.
   */
  private async aplicarPropuestaDeVentas(
    tx: Prisma.TransactionClient,
    pedido: { id: number; tiendaId: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
    items: ItemPropuestaJson[],
    itemsActuales: Array<{ id: number; precioUnitario: Prisma.Decimal }>,
    /**
     * Fase 0 (sep 2026): columna de lista de precios DEL CLIENTE que hizo el
     * pedido. Se resuelve en el caller (que tiene `prisma` fuera de la tx) y
     * se pasa aquí porque los productos que el asesor agrega deben congelarse
     * con la lista del cliente, no con `pco.precio` (siempre lista1) ni con la
     * lista del asesor (que no tiene una).
     */
    columnaLista: ColumnaLista,
  ): Promise<{ cambios: string[]; quedanPendientes: boolean }> {
    const cambios: string[] = [];
    const idsActuales = new Set(itemsActuales.map((i) => i.id));

    for (const it of items) {
      // 'completo' significa "el asesor no tocó este item". Normalmente no hay
      // nada que hacer: bodega ya lo verificó y el cliente lo dejó igual.
      //
      // PERO si bodega lo había marcado con faltante, "completo" es falso: el
      // cliente aprobó LO QUE BODEGA ENCONTRÓ, así que hay que liquidar el item
      // igual que `aplicarCambiosSurtido` (PARCIAL → ajustar cantidad,
      // NO_DISPONIBLE → cancelar). Sin esto el item se queda en faltante y la
      // siguiente confirmación de bodega vuelve a dar 400.
      if (it.tipo === 'completo') {
        if (!idsActuales.has(it.itemId)) continue;
        const item = await tx.itemPedido.findUnique({
          where: { id: it.itemId },
          select: {
            precioUnitario: true,
            cantidadSurtida: true,
            estadoSurtido: true,
            cancelada: true,
          },
        });
        if (!item || item.cancelada) continue;

        // PARCIAL con 0 piezas es, en los hechos, un no disponible.
        const seCancela =
          item.estadoSurtido === 'NO_DISPONIBLE' ||
          (item.estadoSurtido === 'PARCIAL' && item.cantidadSurtida === 0);
        if (seCancela) {
          await tx.itemPedido.update({
            where: { id: it.itemId },
            data: {
              cancelada: true,
              estadoSurtido: 'NO_DISPONIBLE',
              cantidadSurtida: 0,
            },
          });
          cambios.push(`Item #${it.itemId} quitado del pedido (no disponible)`);
          continue;
        }

        if (item.estadoSurtido === 'PARCIAL') {
          await tx.itemPedido.update({
            where: { id: it.itemId },
            data: {
              cantidad: item.cantidadSurtida,
              subtotal: new Prisma.Decimal(item.precioUnitario).mul(
                item.cantidadSurtida,
              ),
              estadoSurtido: 'COMPLETO',
            },
          });
          cambios.push(
            `Item #${it.itemId} ajustado a ${item.cantidadSurtida} piezas (lo que hay)`,
          );
        }
        continue;
      }

      // Items nuevos: 'agregado' (tempId negativo) o 'cambio' (reemplaza uno).
      const esNuevo = it.tipo === 'agregado' || it.tipo === 'cambio';
      if (esNuevo) {
        if (!it.precioCOId) {
          throw new BadRequestException(
            `El item "${it.producto}" (${it.tipo}) requiere precioCOId para poder aplicarse.`,
          );
        }
        const pco = await tx.precioCO.findUnique({
          where: { id: it.precioCOId },
          include: { producto: true, talla: true, color: true, corrida: true },
        });
        if (!pco) {
          throw new NotFoundException(`PrecioCO ${it.precioCOId} no existe`);
        }
        if (pco.tiendaId !== pedido.tiendaId) {
          throw new BadRequestException(
            `El producto "${it.producto}" pertenece a otra tienda.`,
          );
        }

        // Si es un cambio, cancelar el item original.
        //
        // Se limpia también su estado de surtido: un item cancelado que
        // conserva `PARCIAL`/`NO_DISPONIBLE` reaparece como "faltante" en la
        // siguiente confirmación de bodega y bloquea el pedido para siempre
        // (mismo tratamiento que la rama `no-disponible` de más abajo).
        if (it.tipo === 'cambio' && idsActuales.has(it.itemId)) {
          await tx.itemPedido.update({
            where: { id: it.itemId },
            data: {
              cancelada: true,
              estadoSurtido: 'NO_DISPONIBLE',
              cantidadSurtida: 0,
            },
          });
        }

        const cantidad = Math.max(1, it.cantidadNueva ?? it.cantidad);
        // Fase 0: el precio del producto agregado sale de la lista del cliente
        // que hizo el pedido, no de `pco.precio` (lista1).
        const precioUnitario = precioDeLista(pco, columnaLista);
        await tx.itemPedido.create({
          data: {
            pedidoId: pedido.id,
            productoId: pco.productoId,
            precioCOId: pco.id,
            cantidad,
            cantidadOriginal: cantidad,
            precioUnitario,
            subtotal: precioUnitario.mul(cantidad),
            productoNombre: pco.producto.nombre,
            productoCodigo: pco.producto.codigo,
            corridaNombre: pco.corrida.nombre,
            tallaNombre: pco.talla.nombre,
            colorNombre: pco.color.nombre,
            original: false,
            cancelada: false,
            // PENDIENTE: nadie ha verificado que este producto exista en el
            // anaquel. Por eso el pedido vuelve a bodega.
            estadoSurtido: 'PENDIENTE',
            cantidadSurtida: 0,
          },
        });
        cambios.push(
          it.tipo === 'cambio'
            ? `Item #${it.itemId} cambiado por "${pco.producto.nombre}"`
            : `Producto "${pco.producto.nombre}" agregado (${cantidad} pzas)`,
        );
        continue;
      }

      // Items existentes que la propuesta modifica.
      if (!idsActuales.has(it.itemId)) continue;

      if (it.tipo === 'no-disponible') {
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: { cancelada: true, estadoSurtido: 'NO_DISPONIBLE', cantidadSurtida: 0 },
        });
        cambios.push(`Item #${it.itemId} quitado del pedido`);
        continue;
      }

      if (it.tipo === 'parcial') {
        const nuevaCantidad = Math.max(0, it.cantidadNueva ?? it.cantidad);
        // Se relee del `tx` (no de `itemsActuales`) porque hace falta
        // `cantidadSurtida`, que el caller no carga — y porque dentro de la
        // transacción el valor es el fresco.
        const actual = await tx.itemPedido.findUnique({
          where: { id: it.itemId },
          select: { precioUnitario: true, cantidadSurtida: true },
        });
        if (!actual) continue;
        if (nuevaCantidad === 0) {
          await tx.itemPedido.update({
            where: { id: it.itemId },
            data: { cancelada: true, estadoSurtido: 'NO_DISPONIBLE', cantidadSurtida: 0 },
          });
          cambios.push(`Item #${it.itemId} quitado del pedido`);
          continue;
        }
        // La cantidad ajustada tiene que quedar COHERENTE con lo que bodega
        // verificó físicamente. Si el asesor SUBE por encima de lo apartado
        // (bodega tiene 3, propone 5), esas piezas nuevas nadie las verificó:
        // el item vuelve a bodega en PENDIENTE. Si BAJA, lo apartado se ajusta
        // y el sobrante regresa al anaquel.
        //
        // Espejo de `MostradorService.aplicarAjuste` y del guard de
        // incoherencia de `confirmarSurtido` ("lo que se cobra es lo que se
        // surtió").
        const subeLaCantidad = nuevaCantidad > actual.cantidadSurtida;
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: {
            cantidad: nuevaCantidad,
            subtotal: new Prisma.Decimal(actual.precioUnitario).mul(nuevaCantidad),
            ...(subeLaCantidad
              ? {
                  // Hay piezas nuevas que nadie verificó: bodega re-surte.
                  estadoSurtido: 'PENDIENTE',
                  cantidadSurtida: 0,
                }
              : {
                  // Todo lo pedido ya estaba apartado; el sobrante vuelve.
                  estadoSurtido: 'COMPLETO',
                  cantidadSurtida: nuevaCantidad,
                }),
          },
        });
        cambios.push(
          `Item #${it.itemId} ajustado a ${nuevaCantidad} piezas` +
            (subeLaCantidad ? ' (vuelve a bodega a surtir)' : ''),
        );
      }
    }

    await this.recalcularTotales(tx, pedido);

    // F16: guard espejo del de `aplicarCambiosDeBodega`. Sin esto, una
    // propuesta con todos los items no-disponible y sin agregados dejaba el
    // pedido sin productos y avanzaba a pago con subtotal: 0.
    const activos = await tx.itemPedido.count({
      where: { pedidoId: pedido.id, cancelada: false },
    });
    if (activos === 0) {
      throw new BadRequestException(
        'No puedes aprobar esta propuesta: dejaría el pedido sin productos. ' +
          'Cancela el pedido en vez de aprobarlo.',
      );
    }

    // F16: cuenta items no cancelados que NO están en COMPLETO. Si bodega
    // marcó algo como PARCIAL/NO_DISPONIBLE y la propuesta no lo menciona
    // (un asesor que solo editó otros items), el pedido NO puede avanzar
    // — el guard de `confirmarSurtido` nunca se ejecuta en este camino y el
    // invariante "lo que se cobra es lo que se surtió" se rompería. El
    // pedido vuelve a REVIEWING para que bodega lo cierre.
    const pendientesRestantes = await tx.itemPedido.count({
      where: {
        pedidoId: pedido.id,
        cancelada: false,
        estadoSurtido: { not: EstadoSurtido.COMPLETO },
      },
    });

    return { cambios, quedanPendientes: pendientesRestantes > 0 };
  }

  /**
   * Recalcula subtotal y total del pedido desde sus items activos, respetando
   * descuento e impuestos.
   */
  /**
   * F16 (sep 2026): el recálculo se movió a `core/totales.util.ts` para que el
   * ajuste tipo POS de mostrador use la MISMA fórmula. Se conserva este
   * wrapper privado solo para no tocar los call sites.
   */
  private async recalcularTotales(
    tx: Prisma.TransactionClient,
    pedido: { id: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
  ): Promise<void> {
    await recalcularTotalesPedido(tx, pedido);
  }

  /**
   * Admin fuerza la aprobación de una propuesta sin respuesta del cliente
   * (caso excepcional: cliente no responde). Registra auditoría.
   */
  async forzarAprobacion(
    pedidoId: number,
    propuestaId: number,
    usuario: UserContext,
  ) {
    if (usuario.rol !== RolUsuario.ADMIN) {
      throw new BadRequestException('Sólo un admin puede forzar la aprobación.');
    }

    const propuesta = await this.prisma.pedidoPropuesta.findFirst({
      where: { id: propuestaId, pedidoId },
    });
    if (!propuesta) throw new NotFoundException('Propuesta no encontrada');
    if (propuesta.estado !== EstadoPropuesta.PENDIENTE) {
      throw new ConflictException('La propuesta ya fue respondida.');
    }

    const pedido = await this.prisma.pedido.findUnique({ where: { id: pedidoId } });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    if (pedido.estado !== EstadoPedido.WAITING_CUSTOMER_APPROVAL) {
      throw new BadRequestException(
        `El pedido no está esperando aprobación (actual: ${pedido.estado})`,
      );
    }

    const ahora = new Date();
    const esDeBodega = propuesta.creadaPorRol === RolUsuario.BODEGA;

    // Se reutiliza la misma lógica que la aprobación del cliente, marcando
    // quién la forzó para que quede en auditoría.
    await this.prisma.pedidoPropuesta.update({
      where: { id: propuestaId },
      data: { forzadaPorId: usuario.userId, forzadaAt: ahora },
    });

    const resultado = esDeBodega
      ? await this.aprobarPropuestaBodega(pedido, propuesta, {}, usuario, ahora)
      : await this.aprobarPropuestaVentas(pedido, propuesta, {}, usuario, ahora);

    this.logger.log(
      `Pedido ${pedidoId}: aprobación forzada por admin ${usuario.nombre} (propuesta #${propuestaId})`,
    );

    return {
      ...resultado,
      mensaje: `Aprobación forzada. ${resultado.mensaje}`,
    };
  }

  /**
   * Lista las propuestas de un pedido (para el historial y la UI).
   */
  async listarPropuestas(pedidoId: number, usuario: UserContext) {
    await this.access.cargarYValidar(pedidoId, usuario);
    return this.prisma.pedidoPropuesta.findMany({
      where: { pedidoId },
      orderBy: { enviadaAt: 'asc' },
      include: {
        creadaPor: { select: { id: true, nombre: true, apellido: true } },
        forzadaPor: { select: { id: true, nombre: true, apellido: true } },
      },
    });
  }
}

/**
 * Shape del JSON de `PedidoPropuesta.items` (mismo que el frontend
 * `lib/propuesta.ts`). Se declara aquí porque el backend lo lee al aplicar
 * una propuesta de ventas — antes este JSON se guardaba pero nunca se leía.
 */
export interface ItemPropuestaJson {
  itemId: number;
  tipo: 'completo' | 'cambio' | 'no-disponible' | 'parcial' | 'agregado';
  producto: string;
  variante: string;
  productoImagen?: string | null;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
  productoOriginal?: string;
  varianteOriginal?: string;
  cantidadOriginal?: number;
  productoNuevo?: string;
  varianteNueva?: string;
  cantidadNueva?: number;
  precioUnitarioNuevo?: number;
  subtotalNuevo?: number;
  tempId?: number;
  productoId?: number;
  precioCOId?: number;
}
