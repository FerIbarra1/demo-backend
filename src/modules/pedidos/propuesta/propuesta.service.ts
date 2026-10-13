import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PedidoAccessService } from '../core/pedido-access.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { ReposicionService } from '../reposicion/reposicion.service';
import { destinoTrasSurtido } from '../core/destino-post-surtido.util';
import { recalcularTotalesPedido } from '../core/totales.util';
import { aplicarPropuestaDeVentas } from '../core/aplicar-propuesta-ventas.util';
import { aplicarCambiosFisicos } from '../core/aplicar-cambios-surtido.util';
import { PreciosService } from '../../precios/precios.service';
import { precioDeLista, ColumnaLista, COLUMNA_MAYOREO } from '../../precios/precio-lista.util';
import { UserContext } from '../../../types/pedido.types';
import {
  EstadoPedido,
  EstadoPropuesta,
  EstadoSurtido,
  RolUsuario,
  Prisma,
  Pedido,
  PedidoPropuesta,
  TipoNotificacion,
} from '@prisma/client';
import {
  CrearPropuestaDto,
  ResponderPropuestaDto,
  DecisionPropuesta,
  type ItemPropuestaJson,
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
 *   APROBAR (bodega)  → aplica los cambios y va DIRECTO a PENDIENTE_PAGO.
 *                       Bodega ya verificó físicamente lo que propuso.
 *   APROBAR (ventas)  → aplica los cambios y vuelve a EN_REVISION SIN ASIGNAR,
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
    // Oct 2026: MOSTRADOR NO aparece aquí, y es a propósito. Este mapa se indexa
    // por `propuesta.creadaPorRol` — quién CREÓ la propuesta (BODEGA o VENTAS),
    // no quién responde. El mostrador nunca crea propuestas, así que una entrada
    // suya sería inerte. La restricción de qué puede decidir el operador vive en
    // `DECISIONES_PERMITIDAS_AL_OPERADOR`, más abajo.
    [RolUsuario.MOSTRADOR]: [],
    // F16: la TV del mostrador solo lee; no propone ni decide nada.
    [RolUsuario.MOSTRADOR_MONITOR]: [],
    [RolUsuario.ADMIN]: ['APROBAR', 'RECHAZAR', 'CONTACTAR_ASESOR', 'CANCELAR_PEDIDO'],
  };

  /**
   * Oct 2026: el techo de lo que el OPERADOR de mostrador puede decidir en
   * nombre del cliente que tiene enfrente.
   *
   * Es un límite distinto del de `DECISIONES_POR_ORIGEN` (que dice qué puede
   * decidir el CLIENTE según quién creó la propuesta). Este dice qué de eso
   * puede decidir el personal. Los dos se aplican.
   *
   * Fuera quedan `CANCELAR_PEDIDO` (decisión de dinero con su propio flujo,
   * motivo obligatorio y lista de reposición) y `CONTACTAR_ASESOR` (trabajo de
   * ventas).
   */
  private static readonly DECISIONES_PERMITIDAS_AL_OPERADOR: DecisionPropuesta[] = [
    'APROBAR',
    'RECHAZAR',
  ];

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private access: PedidoAccessService,
    private state: PedidoStateService,
    private reposicion: ReposicionService,
    private precios: PreciosService,
    /**
     * Oct 2026: los correos del ciclo de propuesta. Antes vivían implícitos en
     * comentarios que decían "lo dispara PropuestaService" — pero aquí no había
     * ninguna llamada, así que el cliente que pedía un asesor nunca recibía
     * confirmación, y la contrapropuesta del asesor llegaba solo por el chat.
     *
     * `NotificationsModule` ya lo exporta y `PedidoStateService` —en el mismo
     * `pedidos.module.ts`— ya lo inyecta, así que no hay ciclo nuevo.
     */
    private notifications: NotificationsService,
  ) {}

  /**
   * Envía una propuesta al cliente.
   *
   * - BODEGA: requiere estar asignado al pedido y que esté en EN_REVISION.
   * - VENTAS: requiere que el pedido esté en EN_ASESORIA (o ya en
   *   ESPERANDO_APROBACION re-negociando).
   *
   * El pedido pasa a ESPERANDO_APROBACION y el reloj de atención se
   * DETIENE (el pedido sale de bodega; antes se pausaba pero seguía asignado).
   * `asignadoAId` se limpia para liberar el slot del bodeguero.
   *
   * Si ya existe una propuesta PENDIENTE, se rechaza. Además de este chequeo,
   * hay un índice único parcial en BD que cierra la carrera entre dos envíos
   * concurrentes (ahora posibles: BODEGA y VENTAS pueden proponer).
   *
   * Oct 2026 — el retorno depende de si se pasó `txExterna`:
   *   - sin tx: la `PedidoPropuesta` (los efectos ya se dispararon aquí).
   *   - con tx: `{ propuesta, efectos }`, porque los efectos NO se pueden
   *     disparar hasta que el caller confirme su transacción. El caller está
   *     obligado a llamar a `PedidoStateService.dispararEfectosDeTransicion`.
   */
  async enviarPropuesta(
    pedidoId: number,
    dto: CrearPropuestaDto,
    usuario: UserContext,
    txExterna: Prisma.TransactionClient,
  ): Promise<{
    propuesta: PedidoPropuesta;
    efectos: Parameters<PedidoStateService['dispararEfectosDeTransicion']>[1];
  }>;
  async enviarPropuesta(
    pedidoId: number,
    dto: CrearPropuestaDto,
    usuario: UserContext,
    txExterna?: undefined,
  ): Promise<PedidoPropuesta>;
  async enviarPropuesta(
    pedidoId: number,
    dto: CrearPropuestaDto,
    usuario: UserContext,
    /**
     * Transacción del caller. Si viene, la propuesta, la transición y las
     * escrituras del caller quedan en la misma transacción. Lo usa
     * `MessagesService.crearConAdjunto`, que necesita que la propuesta y el
     * mensaje de chat que la muestra sean atómicos: antes la propuesta se
     * confirmaba por su cuenta y el mensaje se creaba fuera, así que un fallo
     * del segundo dejaba al cliente con una propuesta viva que no podía ver.
     */
    txExterna?: Prisma.TransactionClient,
  ): Promise<PedidoPropuesta | { propuesta: PedidoPropuesta; efectos: unknown }> {
    const esVentas = usuario.rol === RolUsuario.VENTAS;
    const esBodega = usuario.rol === RolUsuario.BODEGA;

    if (!esVentas && !esBodega && usuario.rol !== RolUsuario.ADMIN) {
      throw new BadRequestException('Sólo bodega o el asesor de ventas pueden enviar propuestas.');
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
      const idsEnPropuesta = new Set(dto.items.filter((i) => i.itemId > 0).map((i) => i.itemId));
      // Contamos items del pedido que bodega no marcó y que la propuesta
      // tampoco menciona — esos son los PENDIENTE que quedarían sin surtir.
      const idsPendientesSinCubrir = itemsPedido
        .filter((i) => i.estadoSurtido === EstadoSurtido.PENDIENTE && !idsEnPropuesta.has(i.id))
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
      ? [EstadoPedido.EN_ASESORIA, EstadoPedido.ESPERANDO_APROBACION]
      : [EstadoPedido.EN_REVISION];
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

    // Sin tx externa abrimos la nuestra: la propuesta y la transición a
    // WAITING_CUSTOMER_APPROVAL deben ser atómicas. Antes la propuesta se
    // creaba suelta y, si la transición fallaba, quedaba una propuesta
    // PENDIENTE que bloqueaba el siguiente envío por el índice único parcial.
    // Los efectos de la transición (realtime + correo al cliente). Cuando la
    // transición corre dentro de una tx del caller (`txExterna`), el caller es
    // quien debe dispararlos tras su commit — ver `dispararEfectosDeTransicion`.
    let efectosTransicion: Parameters<PedidoStateService['dispararEfectosDeTransicion']>[1] | null =
      null;

    const crearYTransicionar = async (tx: Prisma.TransactionClient) => {
      const propuesta = await tx.pedidoPropuesta.create({
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

      // Transicionar a ESPERANDO_APROBACION. El reloj se DETIENE y el
      // pedido se libera: el bodeguero ya no puede accionar nada.
      //
      // `cambiarEstado` devuelve los efectos y NO los dispara cuando corre
      // dentro de una tx: la transacción todavía no confirmó. El caller los
      // emite cuando confirma — abajo, o en `MessagesService.crearConAdjunto`.
      const { efectos } = (await this.state.cambiarEstado(
        pedidoId,
        {
          nuevoEstado: EstadoPedido.ESPERANDO_APROBACION,
          observacion: esVentas
            ? `Propuesta del asesor de ventas enviada al cliente (${dto.items.length} item(s))`
            : `Propuesta de bodega enviada al cliente (${dto.items.length} item(s))`,
        },
        usuario,
        {
          asignacion: 'limpiar',
          reloj: 'detener',
          invalidarMonitor: true,
          tx,
        },
      )) as { efectos: Parameters<PedidoStateService['dispararEfectosDeTransicion']>[1] };
      efectosTransicion = efectos;

      return propuesta;
    };

    const propuesta = txExterna
      ? await crearYTransicionar(txExterna)
      : await this.prisma.$transaction(crearYTransicionar);

    // Oct 2026: el correo al cliente.
    //
    // `REVISION_PROPUESTA` lo deduce todo del pedido y de la propuesta PENDIENTE
    // más reciente (incluido el origen bodega/ventas), así que sirve para las
    // dos ramas. Antes esto solo funcionaba si la transición corría por su
    // cuenta: `MessagesService.crearConAdjunto` pasa su propia tx, y en esa
    // rama los efectos se quedaban sin disparar — el cliente recibía la
    // contrapropuesta en el chat pero NUNCA el correo.
    //
    // Con tx externa los dispara el caller (que es quien sabe cuándo
    // confirmó); aquí solo se atiende la rama sin tx.
    if (!txExterna && efectosTransicion) {
      this.state.dispararEfectosDeTransicion(pedidoId, efectosTransicion);
    }

    // Aviso al cliente por realtime (el email lo manda la máquina de estados
    // al entrar a ESPERANDO_APROBACION).
    this.realtime.emitToUser(pedido.usuarioId, 'propuesta.enviada', {
      pedidoId,
      propuestaId: propuesta.id,
      origen: usuario.rol,
    });

    this.logger.log(
      `Pedido ${pedidoId}: propuesta #${propuesta.id} de ${usuario.rol} enviada → ESPERANDO_APROBACION`,
    );

    // Con tx externa se devuelven los efectos para que el caller los dispare
    // tras su commit (ver `MessagesService.crearConAdjunto`). Sin tx ya se
    // dispararon arriba.
    return txExterna ? { propuesta, efectos: efectosTransicion } : propuesta;
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
    return this.resolverPropuesta(pedidoId, propuestaId, dto, usuario);
  }

  /**
   * Oct 2026: el operador de mostrador responde EN NOMBRE del cliente.
   *
   * El caso: el cliente llega a tienda sin ticket y sin folio, y su pedido está
   * esperando que apruebe una propuesta (bodega le avisó que faltaban productos,
   * por ejemplo). Antes se quedaba atorado hasta que el cliente abriera la app —
   * con el cliente enfrente.
   *
   * Reusa `resolverPropuesta` entero: la validación de acceso, de estado y de
   * decisiones legales por origen es la misma. Lo único que cambia es el mapa
   * de decisiones legales (`DECISIONES_POR_ORIGEN[MOSTRADOR]`, que solo permite
   * APROBAR y RECHAZAR) y que queda registrado quién respondió.
   *
   * El caller (`MostradorService.responderPropuesta`) valida el acceso con
   * `PedidoAccessService.cargarYValidar` igual que el camino del cliente.
   */
  async responderPropuestaDesdeMostrador(
    pedidoId: number,
    propuestaId: number,
    dto: ResponderPropuestaDto,
    usuario: UserContext,
  ) {
    return this.resolverPropuesta(pedidoId, propuestaId, dto, usuario, {
      enNombreDelCliente: true,
    });
  }

  /**
   * El cuerpo compartido por los dos caminos (cliente y operador).
   *
   * `opts.enNombreDelCliente` solo cambia la AUDITORÍA: deja dicho en el
   * historial que la respuesta la dio el personal y no el cliente. Importa
   * porque la propuesta es una negociación de dinero — si después alguien
   * reclama "yo nunca aprobé eso", tiene que poder verse quién lo hizo.
   */
  private async resolverPropuesta(
    pedidoId: number,
    propuestaId: number,
    dto: ResponderPropuestaDto,
    usuario: UserContext,
    opts: { enNombreDelCliente?: boolean } = {},
  ) {
    await this.access.cargarYValidar(pedidoId, usuario);

    const propuesta = await this.prisma.pedidoPropuesta.findFirst({
      where: { id: propuestaId, pedidoId },
    });
    if (!propuesta) throw new NotFoundException('Propuesta no encontrada');
    if (propuesta.estado !== EstadoPropuesta.PENDIENTE) {
      throw new ConflictException(`Esta propuesta ya fue respondida (estado: ${propuesta.estado})`);
    }

    const pedido = await this.prisma.pedido.findUnique({ where: { id: pedidoId } });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');

    // F18 (oct 2026): se aceptan DOS estados, no uno.
    //
    //   ESPERANDO_APROBACION — el camino normal: el cliente no estaba en tienda
    //                          cuando bodega cerró el surtido incompleto.
    //   REVISADO             — el pedido ya está en el área de entrega. Pasa de
    //                          dos formas: (a) el cliente llegó DESPUÉS de que
    //                          bodega lo marcara incompleto; o (b) el operador lo
    //                          devolvió ahí sin resolver el faltante.
    //
    // Sin el segundo estado la propuesta quedaba **irrespondible**: nacía
    // PENDIENTE en un pedido que este guard rechazaba, así que ni el cliente ni
    // el operador podían decidirla — y quedaba zombi para siempre, bloqueando
    // futuras propuestas por el índice único parcial.
    //
    // Oct 2026: REVISADO y EN_ATENCION son SOLO para el operador. Cuando el
    // pedido está en el área de entrega (o el operador ya llamó al cliente) es
    // porque el cliente está físicamente en la tienda, y la decisión la toma el
    // operador enfrente (ver `enNombreDelCliente`). Si el cliente pudiera
    // responder desde su teléfono al mismo tiempo, los dos competirían por una
    // decisión de dinero y el segundo en llegar se comería un
    // `ConflictException` sin entender por qué.
    //
    // `EN_ATENCION` entra porque `llamar` (REVISADO → EN_ATENCION) NO comprueba
    // propuestas: el operador puede llamar al cliente con una propuesta viva y
    // el pedido aterriza en un estado del que, sin esta línea, no había salida —
    // la propuesta quedaba irresoluble y `enviarAPagar` bloqueado por su guard.
    const estadosRespondibles: EstadoPedido[] = opts.enNombreDelCliente
      ? [EstadoPedido.ESPERANDO_APROBACION, EstadoPedido.REVISADO, EstadoPedido.EN_ATENCION]
      : [EstadoPedido.ESPERANDO_APROBACION];
    if (!estadosRespondibles.includes(pedido.estado)) {
      throw new BadRequestException(
        pedido.estado === EstadoPedido.REVISADO || pedido.estado === EstadoPedido.EN_ATENCION
          ? 'Tu pedido está en el área de entrega: el personal de mostrador resolverá ' +
              'los faltantes contigo ahí mismo.'
          : `El pedido no está esperando aprobación (actual: ${pedido.estado})`,
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

    // Oct 2026: cuando responde el OPERADOR en nombre del cliente, hay un techo
    // adicional. No todo lo que el cliente puede decidir debería poder decidirlo
    // el personal desde el mostrador:
    //   - CANCELAR_PEDIDO crea una lista de reposición y es una decisión de
    //     dinero. Tiene su propio flujo (`POST /pedidos/mostrador/:id/cancelar`)
    //     con motivo obligatorio y auditoría; alcanzarla por aquí la dejaría sin
    //     ese registro.
    //   - CONTACTAR_ASESOR manda el pedido a la cola de ventas. Para eso está
    //     ventas, y el operador no negocia con el cliente enfrente.
    if (
      opts.enNombreDelCliente &&
      !PropuestaService.DECISIONES_PERMITIDAS_AL_OPERADOR.includes(dto.decision)
    ) {
      throw new BadRequestException(
        `Desde mostrador solo se puede ${PropuestaService.DECISIONES_PERMITIDAS_AL_OPERADOR.join(
          ' o ',
        )} una propuesta. Para ${dto.decision}, usa la acción correspondiente del pedido.`,
      );
    }

    const ahora = new Date();
    const esDeBodega = propuesta.creadaPorRol === RolUsuario.BODEGA;

    // Oct 2026: cuando responde el operador, hay que dejar rastro. La propuesta
    // es una negociación de dinero: si el cliente después reclama "yo nunca
    // aprobé eso", tiene que poder verse quién lo hizo y cuándo. `PedidoPropuesta`
    // solo guarda `respondidaAt` y `notaCliente` (no hay `respondidaPorId`), así
    // que el rastro va al historial del pedido — que es donde ya vive la
    // auditoría de las acciones de mostrador (`marcarLlegada`, `llamar`,
    // `descartarLlegada`).
    if (opts.enNombreDelCliente) {
      await this.prisma.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: pedido.estado,
          estadoNuevo: pedido.estado,
          observacion:
            `Propuesta #${propuestaId} respondida (${dto.decision}) por ` +
            `${usuario.nombre} en nombre del cliente, desde mostrador`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });
    }

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
   * PENDIENTE_PAGO. El bodeguero ya verificó físicamente lo que propuso, así que
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
      (i) => !i.cancelada && (i.estadoSurtido === 'PARCIAL' || i.estadoSurtido === 'NO_DISPONIBLE'),
    );

    // F16 (sep 2026): red de seguridad — si por una carrera quedaron items
    // PENDIENTE (la UI los bloquea, pero la API es frontera de confianza),
    // cancelarlos y volver a EN_REVISION en vez de avanzar a pago/mostrador.
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

        // Los items recién cancelados seguían contando en `subtotal`/`total`:
        // el pedido viajaba al ERP cobrando mercancía que nadie va a surtir.
        // Se recalcula aquí dentro del tx (y de paso re-evalúa la promo de
        // volumen, que depende del conteo de piezas).
        //
        // Se usa `pedidoCompleto` (el `findUnique` de arriba) y no el `pedido`
        // del parámetro: ese llega con el shape mínimo que necesitan las
        // transiciones y no garantiza traer `descuento`/`impuestos`.
        await recalcularTotalesPedido(tx, pedidoCompleto);
      });

      // Transición alternativa: vuelve a bodega con reloj reanudado.
      await this.state.cambiarEstado(
        pedido.id,
        {
          nuevoEstado: EstadoPedido.EN_REVISION,
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
        `Pedido ${pedido.id}: propuesta #${propuesta.id} aprobada pero ${itemsPendientesResidual.length} item(s) PENDIENTE → EN_REVISION`,
      );

      return {
        mensaje: `Propuesta aprobada. ${itemsPendientesResidual.length} item(s) quedaron pendientes — bodega debe volver a surtirlos.`,
        estado: EstadoPedido.EN_REVISION,
        propuestaId: propuesta.id,
      };
    }

    // F16 (sep 2026): el destino depende del modo de entrega. Un pedido a
    // domicilio NO pasa por mostrador (el cliente no está en tienda): va
    // directo a pago con encolado inmediato a Firebird. Uno de tienda se
    // aparta en REVISADO y entra al ERP cuando mostrador lo libere.
    const destino = destinoTrasSurtido(pedidoCompleto.modoEntrega);

    // Oct 2026: el caso "el destino es el estado actual".
    //
    // Cuando el cliente está en tienda, bodega cierra el surtido incompleto y
    // manda el pedido a REVISADO con la propuesta viva. El operador la resuelve
    // enfrente, y `destinoTrasSurtido` devuelve REVISADO otra vez — el mismo
    // estado. Sin `permitirMismoEstado`, `cambiarEstado` lanzaba
    // "Transición no permitida: REVISADO → REVISADO" y el operador se quedaba
    // sin salida: la propuesta seguía viva y `enviarAPagar` bloqueado.
    //
    // No es una transición: solo hay que consumar la propuesta (aplicar los
    // cambios físicos y marcarla aceptada). El pedido ya está donde debe estar.
    const yaEstaEnDestino = pedidoCompleto.estado === destino.estado;

    let cambios: string[] = [];
    await this.state.cambiarEstado(
      pedido.id,
      {
        nuevoEstado: destino.estado,
        observacion:
          destino.estado === EstadoPedido.REVISADO
            ? `Cliente aprobó la propuesta #${propuesta.id} de bodega — pasa a mostrador`
            : `Cliente aprobó la propuesta #${propuesta.id} de bodega — pendiente de pago`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        encolarFirebird: destino.encolarFirebird,
        invalidarMonitor: true,
        // Ver el comentario de `yaEstaEnDestino`.
        permitirMismoEstado: true,
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

          // `cambiarEstado` NO escribe historial cuando el estado no cambió (no
          // hubo transición que registrar). Pero aquí SÍ pasó algo que hay que
          // poder auditar: alguien resolvió una propuesta de dinero. Se escribe
          // la fila a mano, con el texto que dice qué ocurrió de verdad.
          //
          // Es el mismo patrón que usa `resolverPropuesta` para la auditoría del
          // operador (ver el `historialPedido.create` de más arriba).
          if (yaEstaEnDestino) {
            await tx.historialPedido.create({
              data: {
                pedidoId: pedido.id,
                estadoAnterior: destino.estado,
                estadoNuevo: destino.estado,
                observacion:
                  `Propuesta #${propuesta.id} de bodega aprobada por ${usuario.nombre}` +
                  ` — ${cambios.length} ajuste(s) aplicado(s) en el área de entrega`,
                usuarioId: usuario.userId,
                usuarioNombre: usuario.nombre,
              },
            });
          }
        },
      },
    );

    this.logger.log(
      `Pedido ${pedido.id}: cliente aprobó propuesta #${propuesta.id} de bodega → ${destino.estado}`,
    );

    return {
      mensaje:
        destino.estado === EstadoPedido.REVISADO
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
   * directo a PENDIENTE_PAGO (no tiene sentido rebotar por bodega).
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
    let huboRetiro = false;
    let cambios: string[] = [];

    await this.state.cambiarEstado(
      pedido.id,
      {
        nuevoEstado: EstadoPedido.EN_REVISION,
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
          huboRetiro = r.huboRetiro;
        },
      },
    );

    /**
     * F19 (oct 2026): si hubo que SACAR mercancía de la bolsa, el pedido vuelve
     * a bodega aunque no quede nada por surtir.
     *
     * El caso que lo motiva: el asesor quita un producto que bodega había
     * surtido completo. `quedanPendientes` da false — no hay nada que surtir —
     * así que el pedido iba directo a mostrador con la prenda de más todavía
     * dentro de la bolsa. Bodega nunca se enteraba, porque el checklist de
     * retiro vive en su tarjeta de ajustes de la plancha y esa tarjeta se
     * alimenta de `obtenerAjustesPlancha`, que sólo lista pedidos en
     * `EN_REVISION`.
     *
     * Mandarlo a bodega es lo que dispara ese checklist (`items: { some: {
     * cancelada: true } }` ya lo levanta solo). Es el mismo criterio que el
     * ajuste de mostrador: la bolsa y el sistema tienen que decir lo mismo.
     */
    if (!quedanPendientes && !huboRetiro) {
      // F16: mismo helper que los otros dos caminos — no puede divergir.
      const destino = destinoTrasSurtido(pedidoCompleto.modoEntrega);
      await this.state.cambiarEstado(
        pedido.id,
        {
          nuevoEstado: destino.estado,
          observacion:
            destino.estado === EstadoPedido.REVISADO
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
          destino.estado === EstadoPedido.REVISADO
            ? 'Propuesta aprobada. Pasa a mostrador a revisar tu pedido.'
            : 'Propuesta aprobada. Tu pedido pasa a pago.',
        estado: destino.estado,
        propuestaId: propuesta.id,
        cambiosAplicados: cambios.length,
      };
    }

    this.logger.log(
      `Pedido ${pedido.id}: cliente aprobó propuesta #${propuesta.id} de ventas → EN_REVISION (` +
        (quedanPendientes ? 'bodega surte' : 'bodega retira de la bolsa') +
        ')',
    );

    return {
      // F19: el mensaje tiene que decir QUÉ va a hacer bodega. Decir "surtirá
      // los productos nuevos" cuando no queda nada por surtir y lo que toca es
      // SACAR mercancía de la bolsa deja al bodeguero buscando trabajo que no
      // existe.
      mensaje: quedanPendientes
        ? 'Propuesta aprobada. Bodega surtirá los productos nuevos.'
        : 'Propuesta aprobada. Bodega retirará de la bolsa lo que ya no va.',
      estado: EstadoPedido.EN_REVISION,
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
        nuevoEstado: EstadoPedido.CANCELADO,
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
      estado: EstadoPedido.CANCELADO,
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
   *
   * Oct 2026 — el mensaje que abre el chat es lo que ESCRIBIÓ el cliente.
   *
   * Antes era un texto fijo de sistema ("Solicitaste hablar con un asesor de
   * ventas. Te atenderá por aquí en breve.") y lo que el cliente había escrito
   * en el input viajaba como `nota` a `PedidoPropuesta.notaCliente` y a
   * `Pedido.asesorSolicitudNota` — fuera del chat. El asesor veía "Dice: …" en
   * la cola, pero la conversación arrancaba con una frase que no decía nada de
   * lo que el cliente quería, así que tenía que preguntar todo de nuevo.
   *
   * Ahora el texto del cliente ES el primer mensaje del chat (sigue siendo
   * `autorRol: CLIENTE`, así que se pinta como burbuja suya) y las dos columnas
   * intermedias desaparecieron: el dato vive en un solo sitio, donde se lee.
   *
   * `nota` es obligatoria para esta decisión — la valida `ResponderPropuestaDto`.
   */
  private async contactarAsesor(
    // `Pedido` completo (no el shape mínimo de las otras ramas) porque aquí sí
    // se manda correo, y `NotificationsService.enviar` necesita el pedido entero
    // para armar la plantilla (clienteEmail, folio, total, tienda).
    pedido: Pedido,
    propuesta: { id: number },
    dto: { nota?: string },
    usuario: UserContext,
    ahora: Date,
  ) {
    // El mensaje del cliente se crea dentro de la transacción pero se emite
    // DESPUÉS del commit (ver abajo): por eso se captura aquí.
    //
    // Va en un contenedor y no en una `let` suelta porque TypeScript no rastrea
    // las asignaciones que ocurren dentro de un closure: con `let`, el `if` de
    // abajo estrecharía el tipo a `never` y el acceso a sus campos no compilaría.
    //
    // `yaEnAsesoria` se calcula ANTES de `cambiarEstado` para decidir si se
    // emite `asesor.solicitado`. Se mantiene como referencia dentro de los
    // efectos.
    const capturado: {
      mensajeCliente: MensajeSistemaCreado | null;
      yaEnAsesoria: boolean;
    } = {
      mensajeCliente: null,
      yaEnAsesoria: pedido.asesorSolicitadoAt !== null,
    };

    // El texto que el cliente escribió. El DTO ya lo exige, pero el service es
    // una frontera de confianza propia (lo llaman también los tests y el camino
    // del operador): sin texto no hay nada que mandar al chat, y el asesor
    // abriría la conversación a ciegas.
    const textoCliente = dto.nota?.trim();
    if (!textoCliente) {
      throw new BadRequestException(
        'Cuéntanos qué cambios quieres en tu pedido para que el asesor pueda hacer el ajuste.',
      );
    }

    await this.state.cambiarEstado(
      pedido.id,
      {
        nuevoEstado: EstadoPedido.EN_ASESORIA,
        observacion: `Cliente pidió asesor de ventas: ${textoCliente}`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        invalidarMonitor: true,
        efectos: async (tx) => {
          // La propuesta de bodega queda sin efecto: el cliente ya no decide
          // sobre ella, va a negociar con el asesor.
          //
          // `notaCliente` NO se llena: el texto del cliente ya vive en el
          // mensaje del chat, que es donde el asesor lo lee. Duplicarlo en la
          // propuesta SUPERADA solo crearía dos copias que pueden divergir.
          await tx.pedidoPropuesta.update({
            where: { id: propuesta.id },
            data: {
              estado: EstadoPropuesta.SUPERADA,
              respondidaAt: ahora,
            },
          });

          // `asesorSolicitadoAt` se pone solo la PRIMERA vez (la cola de ventas
          // prioriza por antigüedad, así que un ajuste posterior no debe
          // reordenarla). Se reusa `capturado.yaEnAsesoria`, calculada antes de
          // `cambiarEstado`, para no sombrearla con una local.
          await tx.pedido.update({
            where: { id: pedido.id },
            data: {
              asesorSolicitadoAt: pedido.asesorSolicitadoAt ?? ahora,
            },
          });

          capturado.mensajeCliente = await tx.pedidoMensaje.create({
            data: {
              pedidoId: pedido.id,
              itemId: null,
              autorId: usuario.userId,
              autorRol: RolUsuario.CLIENTE,
              contenido: textoCliente,
              visibleParaCliente: true,
            },
            include: { autor: { select: { id: true, nombre: true, rol: true } } },
          });
        },
      },
    );

    // `asesor.solicitado` se emite SOLO la primera vez — en ajustes siguientes
    // el asesor ya estaba trabajando en el pedido y la cola no necesita sonar
    // (es el mismo chat, mismo pedido, mismo asesor).
    if (!capturado.yaEnAsesoria) {
      this.realtime.emitToTienda(pedido.tiendaId, 'asesor.solicitado', {
        pedidoId: pedido.id,
      });
    }

    // Oct 2026: y el mensaje del cliente al chat, por el mismo canal que
    // cualquier otro mensaje. Sin esto el cliente con la app abierta no veía
    // aparecer su propio mensaje hasta que el polling de 15s lo trajera — y la
    // promesa de "el chat se abre de inmediato" no se cumplía en tiempo real.
    //
    // Va DESPUÉS del commit, como todos los efectos externos: emitirlo dentro de
    // la transacción anunciaría un mensaje que un rollback podría deshacer.
    const mensajeCliente = capturado.mensajeCliente;
    if (mensajeCliente) {
      const payloadMensaje = {
        id: mensajeCliente.id,
        pedidoId: pedido.id,
        itemId: null,
        autorId: mensajeCliente.autorId,
        autorNombre: mensajeCliente.autor.nombre,
        autorRol: mensajeCliente.autorRol,
        contenido: mensajeCliente.contenido,
        visibleParaCliente: true,
        createdAt: mensajeCliente.createdAt.toISOString(),
        adjunto: null,
      };
      this.realtime.emitToPedido(pedido.id, 'mensaje.creado', payloadMensaje);
      this.realtime.emitToUser(pedido.usuarioId, 'mensaje.creado', payloadMensaje);
    }

    // Oct 2026: el correo de confirmación al cliente.
    //
    // El comentario de `notifTipoParaEstado` decía que este correo lo disparaba
    // `PropuestaService` — pero aquí no había ninguna llamada, así que el
    // cliente que pedía un asesor no recibía NADA. El template y el subject ya
    // existían y estaban cableados en `NotificationsService`; solo faltaba el
    // disparo.
    //
    // Va DESPUÉS del commit (mismo principio que los efectos de la máquina de
    // estados): si la transacción hubiera hecho rollback, el cliente habría
    // recibido un correo de algo que no pasó.
    void this.notifications
      .enviar(pedido, TipoNotificacion.ASESOR_SOLICITADO)
      .catch((err) =>
        this.logger.error(`Falló email ASESOR_SOLICITADO (pedido ${pedido.id}): ${err.message}`),
      );

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
        nuevoEstado: EstadoPedido.CANCELADO,
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
      estado: EstadoPedido.CANCELADO,
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
   * Aplica una propuesta de VENTAS sobre los items del pedido.
   *
   * El cuerpo vive en `core/aplicar-propuesta-ventas.util.ts`: es dominio puro
   * de items (no toca estados, realtime ni el ciclo de la propuesta) y
   * mantenerlo aquí era lo que hacía de este servicio un archivo de 1213
   * líneas con siete responsabilidades.
   */
  private async aplicarPropuestaDeVentas(
    tx: Prisma.TransactionClient,
    pedido: { id: number; tiendaId: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
    items: ItemPropuestaJson[],
    itemsActuales: Array<{ id: number; precioUnitario: Prisma.Decimal }>,
    columnaLista: ColumnaLista,
  ) {
    return aplicarPropuestaDeVentas(tx, pedido, items, itemsActuales, columnaLista);
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
  async forzarAprobacion(pedidoId: number, propuestaId: number, usuario: UserContext) {
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
    if (pedido.estado !== EstadoPedido.ESPERANDO_APROBACION) {
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
 * Shape mínimo del mensaje que `contactarAsesor` crea dentro de su transacción
 * y emite por realtime después del commit. Se declara aquí para que TypeScript
 * no infiera `never` en la variable capturada por el closure.
 */
interface MensajeSistemaCreado {
  id: number;
  autorId: number;
  autorRol: RolUsuario;
  contenido: string;
  createdAt: Date;
  autor: { nombre: string };
}

// Oct 2026: aquí vivía una COPIA de `ItemPropuestaJson`. El comentario decía que
// el tipo se había movido a `dto/propuesta.dto.ts`, pero la copia se quedó — y
// las dos versiones ya habían empezado a divergir (a esta le faltaba
// `productoCodigo`). Ahora se importa del DTO, que es el único lugar donde vive.
