import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../imagenes/storage.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoAccessService } from './pedido-access.service';
import { asignadoANombre } from './pedido-mapper';
import { pausarReloj, reanudarReloj } from './atencion.util';
import { ESTADOS_BOLSA_APARTADA } from './presencia.util';
import { OFFSET_ID_PEDIDO_NUBE } from './id-pedido-externo.util';
import {
  CambioPago,
  emitirCambioDePago,
  emitirTransferenciaAlPasarAPago,
  resolverPagoAlCancelarse,
} from '../../pagos/transferencia/hooks';
import { CambiarEstadoDto } from '../admin/dto/cambiar-estado.dto';
import { UserContext } from '../../../types/pedido.types';
import { EstadoPedido, TipoNotificacion, Prisma, RolUsuario } from '@prisma/client';

/**
 * Máquina de estados B2B. Cada estado declara a qué otros puede transicionar.
 * El cliente sólo puede cancelar antes de PAID.
 *
 * Flujo de pago (jun 2026): la tienda cobra en un sistema externo (Visual FoxPro +
 * Firebird). El backend sólo registra cuándo se cobró vía webhook autenticado
 * (`POST /admin/pedidos/:id/marcar-pagado`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FLUJO COMPLETO (F16 sep 2026 · F17 oct 2026)
 * ─────────────────────��───────────────────────────────────────────────────
 *
 * F17: los estados se llaman como los llama el NEGOCIO. Antes el enum decía
 * PENDING_REVIEW / EN_MOSTRADOR y el piso decía "solicitado" y "la plancha";
 * cuando código y pantalla dicen distinto, cada conversación necesita una
 * traducción mental y los bugs se esconden ahí.
 *
 * F20 (oct 2026): el vocabulario de piso terminó de alinearse — lo que el
 * negocio llama "el área de entrega" (el pedido ya surtido, listo para
 * mostrarlo al cliente o mandarlo a domicilio) es lo que el código llama
 * `REVISADO`. El enum NO cambia: renombrar un valor del enum no toca la
 * sincronización con Firebird, pero sí obligaría a migrar la BD sin ganar nada.
 * Lo que cambió es el nombre de las cosas que lo rodean: `obtenerAjustesEntrega`,
 * la ruta `ajustes-entrega`, `TarjetaAjustesEntrega`.
 */
const TRANSICIONES: Record<EstadoPedido, EstadoPedido[]> = {
  [EstadoPedido.SOLICITADO]: [EstadoPedido.EN_REVISION, EstadoPedido.CANCELADO],
  [EstadoPedido.EN_REVISION]: [
    // EN_REVISION → ESPERANDO_APROBACION: lo dispara PropuestaService
    // cuando bodega envía una propuesta (hay faltantes).
    EstadoPedido.ESPERANDO_APROBACION,
    // F16: EN_REVISION → REVISADO es la transición normal de bodega para
    // pedidos que se recogen en tienda (KIOSKO / RECOGER_TIENDA).
    EstadoPedido.REVISADO,
    // EN_REVISION → PENDIENTE_PAGO: se CONSERVA, pero sólo para DOMICILIO. Un
    // pedido a domicilio no pasa por mostrador (el cliente no está en tienda).
    // También lo dispara SurtidoService.confirmarSurtido cuando la bodega
    // cierra el surtido SIN faltantes.
    EstadoPedido.PENDIENTE_PAGO,
    EstadoPedido.CANCELADO,
  ],
  // F13: el cliente decide sobre una propuesta. El destino depende del origen
  // de la propuesta y de la decisión — ver el comentario de arriba.
  // F16: el destino de "aprobó y no queda nada por surtir" pasó de
  // PENDIENTE_PAGO a REVISADO para pedidos de tienda.
  [EstadoPedido.ESPERANDO_APROBACION]: [
    EstadoPedido.REVISADO,
    EstadoPedido.PENDIENTE_PAGO,
    EstadoPedido.EN_REVISION,
    EstadoPedido.EN_ASESORIA,
    EstadoPedido.CANCELADO,
  ],
  // F13: el pedido está en manos del asesor de ventas de la tienda. Sale de
  // aquí cuando el vendedor manda una contrapropuesta (→ WAITING_CUSTOMER_
  // APPROVAL), cuando determina que el pedido original estaba bien y lo
  // devuelve a bodega (→ EN_REVISION), o cuando se cancela.
  // F16: también puede ir a REVISADO si la contrapropuesta no dejó items
  // pendientes y el pedido se recoge en tienda.
  [EstadoPedido.EN_ASESORIA]: [
    EstadoPedido.ESPERANDO_APROBACION,
    EstadoPedido.EN_REVISION,
    EstadoPedido.REVISADO,
    EstadoPedido.CANCELADO,
  ],
  // F16/F17: EL ÁREA DE ENTREGA. El pedido está apartado en la mesa esperando
  // al cliente. Las cinco salidas son:
  //   → EN_ATENCION   llamar (el operador lo manda a llamar por la TV).
  //   → PENDIENTE_PAGO enviar a pagar (AQUÍ se encola a Firebird: el ERP sólo
  //                   ve pedidos que el cliente ya confirmó).
  //   → EN_REVISION   ajustar (el cliente pidió cambios; bodega re-surte).
  //                   Requiere opts.asignacion explícito por el guard de
  //                   `cambiarEstado` — el caller NO es un bodeguero.
  //   → ESPERANDO_APROBACION  F18: el cliente NO está y el pedido quedó
  //                   incompleto, así que tiene que decidir en su app.
  //                   También es el destino cuando el operador devuelve un
  //                   pedido al área de entrega sin resolver el faltante.
  //   → CANCELADO     cancelar (crea la lista de reposición en la misma tx).
  [EstadoPedido.REVISADO]: [
    EstadoPedido.EN_ATENCION,
    EstadoPedido.PENDIENTE_PAGO,
    EstadoPedido.EN_REVISION,
    EstadoPedido.ESPERANDO_APROBACION,
    EstadoPedido.CANCELADO,
  ],
  // F17: el operador llamó al cliente y lo está atendiendo (el recuento con
  // ��l enfrente). Salidas:
  //   → REVISADO      deshacer la llamada (el cliente no llegó o se equivocó
  //                   el folio). Antes esto sólo limpiaba `llamadoAt`.
  //   → EN_REVISION   ajustar durante el recuento.
  //   → PENDIENTE_PAGO enviar a pagar (el camino feliz).
  //   → CANCELADO.
  [EstadoPedido.EN_ATENCION]: [
    EstadoPedido.REVISADO,
    EstadoPedido.EN_REVISION,
    EstadoPedido.PENDIENTE_PAGO,
    EstadoPedido.CANCELADO,
  ],
  [EstadoPedido.PENDIENTE_PAGO]: [EstadoPedido.PAGADO, EstadoPedido.CANCELADO],
  // PAID → SHIPPED sólo aplica a pedidos a domicilio (con shippingDireccion).
  // Kiosko y web recoger en tienda saltan directo a COMPLETED vía el módulo
  // Mostrador. La validación de shippingDireccion ocurre en `marcarEnviado`.
  [EstadoPedido.PAGADO]: [EstadoPedido.ENVIADO, EstadoPedido.ENTREGADO, EstadoPedido.CANCELADO],
  [EstadoPedido.ENVIADO]: [EstadoPedido.ENTREGADO, EstadoPedido.CANCELADO],
  [EstadoPedido.ENTREGADO]: [],
  [EstadoPedido.CANCELADO]: [],
};

/**
 * F13 (sep 2026): opciones de `cambiarEstado`.
 *
 * Existen porque el flujo nuevo tiene arcos que NO se comportan como el
 * original. El caso crítico es `asignacion`: el default histórico asignaba el
 * pedido a quien transicionaba, lo cual es correcto cuando un bodeguero toma
 * un pedido pero es un landmine cuando el CLIENTE aprueba una propuesta y el
 * pedido vuelve a EN_REVISION — quedaría asignado a un cliente, invisible en el
 * monitor de bodega y bloqueado para todos los bodegueros.
 */
export interface CambiarEstadoOpts {
  /**
   * Qué hacer con `asignadoAId`/`asignadoAt`:
   *   - 'caller'   → asignar a quien transiciona (comportamiento histórico).
   *                  Es lo correcto cuando un bodeguero TOMA un pedido.
   *   - 'limpiar'  → dejar sin asignar (el pedido vuelve a la cola).
   *   - 'mantener' → no tocar la asignación actual.
   *
   * REQUERIDO cuando el destino es EN_REVISION: no hay default seguro, porque
   * 'caller' con un caller que no es bodeguero corrompe la asignación.
   */
  asignacion?: 'caller' | 'limpiar' | 'mantener';
  /**
   * Qué hacer con el reloj de atención del bodeguero:
   *   - 'pausar'   → congelar el acumulado (la pelota es del cliente/ventas).
   *   - 'reanudar' → arrancar un turno nuevo acumulando el tiempo previo.
   *   - 'detener'  → congelar y marcar que ya no es tarea de bodega.
   *   - 'mantener' → no tocar (default).
   */
  reloj?: 'pausar' | 'reanudar' | 'detener' | 'mantener';
  /**
   * Si true, encola el pedido a Firebird DENTRO de la misma transacción.
   * Obligatorio para toda transición a PENDIENTE_PAGO: un pedido en ese estado
   * sin fila en `PedidoPendienteEnvio` es invisible para el agente, nunca
   * recibe folio y se queda atascado para siempre.
   */
  encolarFirebird?: boolean;
  /**
   * Efectos adicionales a ejecutar DENTRO de la transacción, después de
   * escribir el estado. Se usa para aplicar cambios de items (propuesta
   * aceptada) de forma atómica con la transición.
   */
  efectos?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** Emitir `monitor.invalidado` a la tienda (para que los monitores refresquen). */
  invalidarMonitor?: boolean;
  /**
   * Transacción del caller. Si viene, la transición corre DENTRO de ella en
   * vez de abrir la suya, para que el cambio de estado y las escrituras del
   * caller sean atómicos. Lo usa `MessagesService.crearConAdjunto` para crear
   * la propuesta, transicionar y crear el mensaje como una sola unidad.
   */
  tx?: Prisma.TransactionClient;
  /**
   * Oct 2026: permite llamar a `cambiarEstado` con el estado que el pedido YA
   * tiene, ejecutando los `efectos` sin escribir estado ni historial.
   *
   * El caso que lo motivó: el operador de mostrador resuelve la propuesta de un
   * pedido que ya está en `REVISADO` (el cliente está enfrente y bodega reportó
   * faltantes). `aprobarPropuestaBodega` calcula su destino con
   * `destinoTrasSurtido`, que para pedidos de tienda devuelve `REVISADO` — el
   * mismo estado. Sin esta opción, `cambiarEstado` lanzaba
   * "Transición no permitida: REVISADO → REVISADO" y el operador se quedaba sin
   * salida: la propuesta seguía viva y `enviarAPagar` bloqueado.
   *
   * NO se agregó `REVISADO` a `TRANSICIONES[REVISADO]` a propósito: eso dejaría
   * que cualquier caller "transicione" al mismo estado y ensucie el historial
   * con filas que no describen ningún cambio. Aquí la intención es explícita y
   * el caller se compromete a escribir su propia fila de historial si quiere
   * dejar rastro.
   */
  permitirMismoEstado?: boolean;
  /**
   * F22 (oct 2026): no mandar el correo que esta transición normalmente dispara.
   *
   * Para las transiciones que el operador hace con el cliente ENFRENTE (traerlo
   * desde asesoría) o por la llegada del cliente (la propuesta pendiente pasa al
   * área de entrega): decirle por correo "tu pedido ya está listo en tienda" a
   * alguien que está de pie en el mostrador es ruido.
   */
  sinNotificar?: boolean;
}

/**
 * Fuente única de verdad de la máquina de estados de un pedido.
 *
 * Lo consumen:
 *   - `cliente/cliente.service.ts` — `generarNumeroPedido` al crear.
 *   - `bodega/bodega.service.ts` — `cambiarEstado` al tomar / marcar enviado.
 *   - `bodega/surtido.service.ts` — `cambiarEstado` al confirmar surtido.
 *   - `cajero/cajero.service.ts` — no (sus acciones son asignaciones, no transiciones).
 *   - `admin/admin.service.ts` — `cambiarEstado` al marcar como pagado.
 *   - `messages/messages.service.ts` — no.
 *   - `mostrador/mostrador.service.ts` — `cambiarEstado` al entregar.
 *
 * Si cambia la máquina de estados, los side-effects (historial, realtime,
 * notificación) se actualizan en un solo archivo.
 */
@Injectable()
export class PedidoStateService {
  private readonly logger = new Logger(PedidoStateService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
    private access: PedidoAccessService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Cambia el estado de un pedido validando la transición, registrando historial
   * y ejecutando side-effects (timestamps, encolado a Firebird, etc.).
   *
   * Público para que módulos hermanos (mostrador, ventas, paquetería futura)
   * puedan orquestar transiciones sin reimplementar la lógica de historial/
   * realtime/notificación. **No llamar directamente desde controllers** — usar
   * los wrappers de dominio (`marcarEnviado`, `entregarEnMostrador`, etc.) que
   * aplican las validaciones de acceso correspondientes.
   *
   * F13: las `opts` existen porque el flujo nuevo tiene arcos que no se
   * comportan como el original (ver `CambiarEstadoOpts`). Antes de F13 este
   * método SIEMPRE asignaba el pedido al caller al ir a EN_REVISION, lo cual es
   * correcto para un bodeguero que toma un pedido pero corrompe la asignación
   * cuando el caller es el cliente aprobando una propuesta.
   */
  async cambiarEstado(
    pedidoId: number,
    dto: CambiarEstadoDto,
    usuario: UserContext,
    opts: CambiarEstadoOpts = {},
  ) {
    await this.access.cargarYValidar(pedidoId, usuario);

    // Si el caller ya abrió una transacción, la transición se ejecuta DENTRO
    // de ella. Es lo que permite que un cambio de estado y otra escritura
    // (ej. crear la propuesta y el mensaje de chat que la muestra) sean
    // atómicos: o quedan los dos, o no queda ninguno.
    //
    // En ese caso los efectos externos (realtime, notificación) NO se disparan
    // aquí: los dispara el caller dueño de la transacción, después de
    // confirmarla. Si los emitiéramos ahora, saldrían antes del commit.
    if (opts.tx) {
      // Con tx del caller se devuelve TAMBIÉN los efectos: la transacción aún no
      // confirmó, así que no se pueden disparar aquí. El caller está obligado a
      // llamar a `dispararEfectosDeTransicion` después de su commit.
      return this.ejecutarCambio(opts.tx, pedidoId, dto, usuario, opts);
    }

    const { pedido, efectos } = await this.prisma.$transaction((tx) =>
      this.ejecutarCambio(tx, pedidoId, dto, usuario, opts),
    );
    this.dispararEfectos(pedidoId, efectos);
    return pedido;
  }

  /**
   * Emite el realtime y la notificación de una transacción ya confirmada.
   *
   * Vive fuera de `ejecutarCambio` a propósito: emitir dentro del callback de
   * `$transaction` es emitir antes del commit, así que un rollback posterior
   * dejaba a los clientes con un evento de un cambio que nunca ocurrió.
   *
   * Oct 2026 — PÚBLICO, y no es un detalle de estilo: cuando el caller pasa
   * `opts.tx`, `cambiarEstado` NO puede disparar los efectos (la transacción
   * todavía no confirmó), así que se los devuelve para que los dispare él. Ese
   * contrato vivía solo en un comentario, y `MessagesService.crearConAdjunto`
   * —el único caller que usa `tx`— nunca lo cumplió: la contrapropuesta del
   * asesor transicionaba el pedido a ESPERANDO_APROBACION y **el cliente jamás
   * recibía el correo**, porque el `REVISION_PROPUESTA` que la máquina de
   * estados habría disparado se quedaba en el objeto de retorno.
   *
   * Un caller que use `opts.tx` está obligado a llamar a esto después de su
   * commit. El parámetro es lo que devuelve `cambiarEstado` en esa rama.
   */
  dispararEfectosDeTransicion(
    pedidoId: number,
    efectos: {
      tiendaId: number;
      estadoAnterior: EstadoPedido;
      estadoNuevo: EstadoPedido;
      invalidarMonitor: boolean;
      notifTipo: TipoNotificacion | null;
      sinCambioDeEstado?: boolean;
      bodegueroAsignadoId?: number | null;
      numeroPedido?: string;
      pago?: CambioPago | null;
    },
  ): void {
    this.dispararEfectos(pedidoId, efectos);
  }

  private dispararEfectos(
    pedidoId: number,
    e: {
      tiendaId: number;
      estadoAnterior: EstadoPedido;
      estadoNuevo: EstadoPedido;
      invalidarMonitor: boolean;
      notifTipo: TipoNotificacion | null;
      /**
       * Oct 2026: true cuando el pedido YA estaba en `estadoNuevo` y solo se
       * aplicaron los `efectos` (`opts.permitirMismoEstado`). El emisor lo usa
       * para NO anunciar un cambio de estado que no ocurrió.
       */
      sinCambioDeEstado?: boolean;
      /**
       * Oct 2026: el bodeguero que tenía el pedido en el momento de la
       * transición (la asignación ya se limpió en la BD, así que se captura de
       * la lectura previa). Solo importa si el pedido se cancela en bodega.
       */
      bodegueroAsignadoId?: number | null;
      numeroPedido?: string;
      /** Oct 2026: el pago por transferencia que la cancelación movió (si había uno). */
      pago?: CambioPago | null;
    },
  ): void {
    // Sin cambio real de estado no se emite `pedido.estado`: los clientes
    // recargarían y verían el mismo estado, y peor, un cliente que escucha ese
    // evento para avanzar su UI creería que hubo un avance.
    if (!e.sinCambioDeEstado) {
      this.realtime.emitToTienda(e.tiendaId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior: e.estadoAnterior,
        estadoNuevo: e.estadoNuevo,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior: e.estadoAnterior,
        estadoNuevo: e.estadoNuevo,
      });
    }
    // Oct 2026: el pedido se canceló MIENTRAS un bodeguero lo surtía. Él lo trae
    // en las manos, así que no hay lista de reposición (ver
    // `bolsaEnManosDeBodega`): lo que necesita es ENTERARSE para dejar de surtir y
    // regresar al anaquel lo que tiene. Va solo a ese bodeguero (`user-{id}`), no
    // a toda la tienda: al resto del turno un aviso así sería ruido.
    if (
      !e.sinCambioDeEstado &&
      e.estadoNuevo === EstadoPedido.CANCELADO &&
      e.estadoAnterior === EstadoPedido.EN_REVISION &&
      e.bodegueroAsignadoId != null
    ) {
      this.realtime.emitToUser(e.bodegueroAsignadoId, 'pedido.cancelado-en-bodega', {
        pedidoId,
        numeroPedido: e.numeroPedido ?? null,
      });
    }

    // Oct 2026: la cancelación movió un pago por transferencia (cancelado sin dinero, reembolso
    // pendiente o comprobante por aclarar): las pantallas de Tesorería y de la tienda lo ven.
    if (e.pago) emitirCambioDePago(this.realtime, e.pago);

    // F13: los monitores (bodega/cajeros) no reaccionan a `pedido.estado`;
    // necesitan este evento para recomputar slots y colas.
    if (e.invalidarMonitor) {
      this.realtime.emitToTienda(e.tiendaId, 'monitor.invalidado', { pedidoId });
    }

    if (e.notifTipo) {
      void this.prisma.pedido
        .findUnique({ where: { id: pedidoId } })
        .then((pedidoCompleto) => {
          if (!pedidoCompleto) return;
          return this.notifications.enviar(pedidoCompleto, e.notifTipo!);
        })
        .catch((err) =>
          this.logger.error(`Error enviando notificación ${e.notifTipo}: ${err.message}`),
        );
    }
  }

  /**
   * Cuerpo de la transición. Extraído de `cambiarEstado` para que un caller
   * pueda componerlo dentro de su propia transacción vía `opts.tx`.
   */
  private async ejecutarCambio(
    tx: Prisma.TransactionClient,
    pedidoId: number,
    dto: CambiarEstadoDto,
    usuario: UserContext,
    opts: CambiarEstadoOpts,
  ) {
    {
      const pedido = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');

      const estadoAnterior = pedido.estado;
      const estadoNuevo = dto.nuevoEstado;

      // Oct 2026: `permitirMismoEstado` deja pasar el caso "el destino es el
      // estado que el pedido ya tiene". No es una transición: no se escribe
      // estado, no se escribe historial de transición y no se notifica al
      // cliente. Solo corren los `efectos` (aplicar los items de la propuesta
      // que el operador acaba de resolver). Ver `CambiarEstadoOpts`.
      const esMismoEstado = estadoAnterior === estadoNuevo;
      const saltarTransicion = esMismoEstado && opts.permitirMismoEstado === true;

      if (!saltarTransicion) {
        const permitidas = TRANSICIONES[estadoAnterior];
        if (!permitidas.includes(estadoNuevo)) {
          throw new BadRequestException(
            `Transición no permitida: ${estadoAnterior} → ${estadoNuevo}`,
          );
        }
      }

      // F13: ir a EN_REVISION sin decir qué hacer con la asignación es un bug
      // latente (el pedido podría quedar asignado a un cliente). Exigimos
      // que el caller sea explícito.
      if (estadoNuevo === EstadoPedido.EN_REVISION && !opts.asignacion) {
        throw new BadRequestException(
          'Transición a EN_REVISION requiere opts.asignacion explícito ' +
            "('caller' si un bodeguero lo toma, 'limpiar' si vuelve a la cola, " +
            "'mantener' si se conserva la asignación actual).",
        );
      }

      // INVARIANTE: `PENDIENTE_PAGO ⟺ fila en PedidoPendienteEnvio`.
      //
      // Un pedido en PENDIENTE_PAGO sin fila en la cola del ERP es invisible al
      // agente, nunca recibe folio y se queda atascado para siempre. El
      // comentario de `encolarFirebird` ya lo declaraba obligatorio, pero nada
      // lo verificaba: un caller futuro que lo omitiera producía exactamente
      // ese estado irrecuperable, en silencio.
      //
      // Se comprueba aquí y no en cada caller para que ninguna transición
      // nueva pueda olvidarlo. Si el pedido YA tiene fila (p. ej. la creó una
      // transición anterior) no hace falta volver a encolar.
      if (estadoNuevo === EstadoPedido.PENDIENTE_PAGO && !opts.encolarFirebird) {
        const yaEncolado = await tx.pedidoPendienteEnvio.findFirst({
          where: { pedidoId },
          select: { id: true },
        });
        if (!yaEncolado) {
          throw new BadRequestException(
            'Transición a PENDIENTE_PAGO requiere opts.encolarFirebird: un pedido ' +
              'en ese estado sin fila en la cola del ERP es invisible al agente ' +
              'y se queda atascado para siempre.',
          );
        }
      }

      // F22: el correo "ya está listo en tienda" es del PRIMER paso a `REVISADO`.
      //
      // Antes salía cada vez que el pedido entraba ahí: al devolver a la cola un
      // llamado equivocado, al traerlo desde asesoría y al volver de cada ajuste de
      // mostrador. El cliente que está de pie en la tienda recibía "tu pedido ya
      // está listo" tres veces. Se mira el historial ANTES de escribir la fila de
      // esta transición, o siempre habría una.
      const yaEstuvoEnRevisado =
        estadoNuevo === EstadoPedido.REVISADO && !saltarTransicion
          ? (await tx.historialPedido.count({
              where: { pedidoId, estadoNuevo: EstadoPedido.REVISADO },
            })) > 0
          : false;

      const ahora = new Date();
      const datos: Prisma.PedidoUpdateManyMutationInput & Prisma.PedidoUncheckedUpdateManyInput = {
        // En el camino de "mismo estado" no se reescribe `estado`: sería un
        // no-op que ensucia el `updatedAt` y hace creer que hubo un cambio.
        ...(saltarTransicion ? {} : { estado: estadoNuevo }),
        ...this.cambiosDeAsignacion(opts.asignacion, usuario, ahora),
        ...this.cambiosDeReloj(opts.reloj, pedido, ahora),
        // F17: `llamadoAt` (auditoría de la llamada) solo tiene sentido
        // mientras el folio está anunciado en la TV, es decir en
        // REVISADO/EN_ATENCION. Al salir (a pago, a bodega o a cancelado) el
        // panel "Atendiendo" debe vaciarse solo — si no, un folio ya cobrado
        // seguiría anunciado como "te toca". Se limpia aquí y no en cada
        // caller para que ninguna transición futura pueda olvidarlo.
        //
        // Oct 2026 — el caso `EN_ATENCION → REVISADO`: el operador resuelve la
        // propuesta del cliente que tiene enfrente y el pedido vuelve a la
        // cola. El destino SÍ es REVISADO, así que la regla de arriba no
        // aplicaba y el `llamadoAt` sobrevivía: el pedido volvía a la lista de
        // espera pero la TV lo seguía mostrando como "atendido". Salir de
        // EN_ATENCION significa que la llamada terminó, sin importar a dónde
        // se vaya.
        //
        // F22: con `llamadoAt` se limpian también QUIÉN llamó y a QUÉ mostrador —
        // son la misma señal ("este folio está anunciado") y no pueden
        // sobrevivir separadas.
        //
        // Oct 2026 — y el caso contrario, `EN_ATENCION → EN_ATENCION`
        // (`permitirMismoEstado`): el operador resuelve una propuesta o un ajuste
        // CON el cliente enfrente y la llamada sigue en pie. No hubo transición,
        // así que no hay nada que "terminar": limpiar aquí le quitaba al cliente
        // el "te toca" de la TV en mitad del recuento.
        ...(!saltarTransicion &&
        (estadoNuevo !== EstadoPedido.REVISADO || estadoAnterior === EstadoPedido.EN_ATENCION)
          ? { llamadoAt: null, llamadoPorId: null, llamadoMostradorId: null }
          : {}),
        // F22: la antigüedad de la ESPERA. Arranca cuando la bolsa queda apartada
        // (entra a REVISADO / ESPERANDO_APROBACION / EN_ATENCION desde fuera de
        // ese grupo) y se limpia al salir. Moverse DENTRO del grupo (llamar,
        // devolver a la cola, resolver una propuesta) no la reinicia: lo que
        // importa es cuánto lleva la bolsa esperando, no la última acción.
        ...(saltarTransicion ? {} : this.cambiosDeEspera(estadoAnterior, estadoNuevo, ahora)),
        // Oct 2026: el LUGAR en la fila de caja. Arranca al entrar a PENDIENTE_PAGO y se limpia al
        // salir; "devolver a la cola" (caja) no pasa por aquí, así que conserva el lugar.
        ...(saltarTransicion
          ? {}
          : estadoNuevo === EstadoPedido.PENDIENTE_PAGO
            ? { colaCajaDesdeAt: ahora }
            : estadoAnterior === EstadoPedido.PENDIENTE_PAGO
              ? // Y la marca de "regresado hasta que se valide" (solo significa algo en la fila).
                { colaCajaDesdeAt: null, esperaValidacionDesdeAt: null }
              : {}),
      };

      // El guard de estado se conserva incluso en el camino de "mismo estado": si el
      // pedido cambió mientras se procesaba, hay que abortar igual (TOCTOU). Lo que
      // se omite en ese camino es ESCRIBIR el estado, no la comprobación.
      const where = { id: pedidoId, estado: estadoAnterior };
      // Oct 2026: en el camino de "mismo estado" `datos` puede quedar VACÍO (sin
      // asignación, sin reloj, sin llamada que limpiar). Prisma no emite un UPDATE
      // con `data: {}` y `updateMany` devuelve `count: 0`, así que el guard de abajo
      // lanzaba un falso "el pedido cambió" justo cuando NADA cambió. Nadie lo había
      // visto porque el único caller (`aprobarPropuestaBodega`) siempre pasa
      // `asignacion` y `reloj`, o sea que `datos` nunca estaba vacío; lo destapó el
      // ajuste de mostrador que se resuelve en el lugar, que no toca ninguno.
      // Sin nada que escribir, la comprobación es un conteo.
      const coincide =
        Object.keys(datos).length === 0
          ? (await tx.pedido.count({ where })) === 1
          : (await tx.pedido.updateMany({ where, data: datos })).count === 1;
      if (!coincide) {
        throw new ConflictException(
          'El pedido cambió mientras se procesaba. Actualiza la pantalla e inténtalo de nuevo.',
        );
      }

      // Efectos de dominio (ej. aplicar los items de una propuesta aceptada)
      // en la MISMA transacción que la transición: si fallan, no queda un
      // pedido en PENDIENTE_PAGO con items a medio aplicar.
      if (opts.efectos) {
        await opts.efectos(tx);
      }

      // F13: un pedido en PENDIENTE_PAGO sin fila en la cola de Firebird es
      // invisible para el agente y se queda atascado para siempre. Se encola
      // aquí, dentro de la tx, para que estado y cola sean atómicos.
      if (opts.encolarFirebird) {
        await this.encolarEnvioAFirebird(tx, pedidoId);
      }

      // Oct 2026 (pagos por transferencia): un pedido que se cancela no puede dejar un pago
      // colgado. Va DENTRO de la transacción: si fallara, quedaría un pedido cancelado con una
      // transferencia (y quizá dinero) sin que nadie sepa qué hacer. Cancelan el cliente, mostrador,
      // las propuestas y el agente (`SWCANCEL`), y todos pasan por aquí.
      const pagoAfectado =
        !saltarTransicion && estadoNuevo === EstadoPedido.CANCELADO
          ? await resolverPagoAlCancelarse(tx, pedidoId, {
              id: usuario.userId || null,
              rol: usuario.rol,
              nombre: usuario.nombre,
            })
          : null;

      // Oct 2026: el cliente que eligió transferencia al hacer su pedido recibe sus datos al
      // llegar a PENDIENTE_PAGO (ver `emitirTransferenciaAlPasarAPago`). También DENTRO de la
      // transacción: o hay pedido en pago CON su transferencia, o no hay cambio.
      const pagoEmitido =
        !saltarTransicion && estadoNuevo === EstadoPedido.PENDIENTE_PAGO
          ? await emitirTransferenciaAlPasarAPago(tx, pedidoId, {
              id: usuario.userId || null,
              rol: usuario.rol,
              nombre: usuario.nombre,
            })
          : null;

      const pedidoActualizado = await tx.pedido.findUnique({
        where: { id: pedidoId },
      });
      if (!pedidoActualizado) {
        throw new NotFoundException('Pedido no encontrado');
      }

      // En el camino de "mismo estado" NO se escribe historial de transición:
      // no hubo transición. El caller que lo necesite (para dejar constancia de
      // que el operador resolvió el faltante) escribe su propia fila — así el
      // texto puede decir QUÉ pasó y no un genérico "X → X".
      if (!saltarTransicion) {
        await tx.historialPedido.create({
          data: {
            pedidoId,
            estadoAnterior,
            estadoNuevo,
            observacion: dto.observacion || `Cambio de estado por ${usuario.nombre}`,
            usuarioId: usuario.userId,
            usuarioNombre: usuario.nombre,
          },
        });

        this.logger.log(
          `Pedido ${pedidoId}: ${estadoAnterior} → ${estadoNuevo} (por ${usuario.nombre})`,
        );
      } else {
        this.logger.log(
          `Pedido ${pedidoId}: efectos aplicados sin cambio de estado ` +
            `(sigue en ${estadoNuevo}, por ${usuario.nombre})`,
        );
      }

      // Los efectos externos (realtime y notificación) se DEVUELVEN en vez de
      // emitirse aquí. Emitir dentro del callback de `$transaction` significa
      // emitir ANTES del commit: si la transacción hace rollback después (por
      // el encolado, por el historial, o por un `efectos` que falle), los
      // clientes ya recibieron un evento de un cambio que nunca ocurrió.
      //
      // El caller los dispara cuando la transacción ya confirmó.
      //
      // En el camino de "mismo estado" la notificación va en null a propósito:
      // el pedido ya estaba en ese estado, así que su correo ya se mandó en su
      // momento. Reenviarlo sería un duplicado (p. ej. un segundo "ya está listo
      // en tienda" cada vez que el operador resuelve un faltante).
      let notifTipo =
        saltarTransicion || opts.sinNotificar ? null : this.notifTipoParaEstado(estadoNuevo);
      if (notifTipo === TipoNotificacion.LISTO_EN_TIENDA && yaEstuvoEnRevisado) notifTipo = null;

      return {
        pedido: pedidoActualizado,
        efectos: {
          tiendaId: pedido.tiendaId,
          estadoAnterior,
          estadoNuevo,
          invalidarMonitor: opts.invalidarMonitor ?? false,
          notifTipo,
          // El caller lo usa para no emitir `pedido.estado` cuando no hubo
          // cambio: los clientes verían un evento que no describe nada.
          sinCambioDeEstado: saltarTransicion,
          // Lectura PREVIA al update: la asignación ya se limpió en la BD.
          bodegueroAsignadoId: pedido.asignadoAId,
          numeroPedido: pedido.numeroPedido,
          pago: pagoAfectado ?? pagoEmitido,
        },
      };
    }
  }

  /**
   * F13: traduce `opts.asignacion` a los campos de asignación a escribir.
   * Ver `CambiarEstadoOpts.asignacion` para la semántica de cada modo.
   */
  private cambiosDeAsignacion(
    modo: CambiarEstadoOpts['asignacion'],
    usuario: UserContext,
    ahora: Date,
  ): {
    asignadoAId?: number | null;
    asignadoAt?: Date | null;
  } {
    switch (modo) {
      case 'caller':
        return { asignadoAId: usuario.userId, asignadoAt: ahora };
      case 'limpiar':
        return { asignadoAId: null, asignadoAt: null };
      case 'mantener':
      case undefined:
        return {};
    }
  }

  /**
   * F22: la antigüedad de la espera del cliente (`esperaClienteDesdeAt`).
   * Ver el comentario en `ejecutarCambio`.
   */
  private cambiosDeEspera(
    anterior: EstadoPedido,
    nuevo: EstadoPedido,
    ahora: Date,
  ): {
    esperaClienteDesdeAt?: Date | null;
    recordatorioRecogerAt?: Date | null;
    interesConfirmadoCount?: number;
  } {
    const estabaApartada = ESTADOS_BOLSA_APARTADA.includes(anterior);
    const quedaApartada = ESTADOS_BOLSA_APARTADA.includes(nuevo);
    if (!estabaApartada && quedaApartada) {
      return {
        esperaClienteDesdeAt: ahora,
        recordatorioRecogerAt: null,
        interesConfirmadoCount: 0,
      };
    }
    if (estabaApartada && !quedaApartada) {
      return { esperaClienteDesdeAt: null, recordatorioRecogerAt: null };
    }
    return {};
  }

  /**
   * F13: traduce `opts.reloj` a los campos del reloj de atención.
   *
   * 'pausar' y 'detener' escriben lo mismo (`pausarReloj` congela el acumulado
   * y limpia `bodegaTurnoDesdeAt`); la diferencia es semántica para el caller:
   * 'pausar' = la pelota es de otro y volverá a bodega; 'detener' = ya no es
   * tarea de bodega nunca más (el reloj queda congelado).
   */
  private cambiosDeReloj(
    modo: CambiarEstadoOpts['reloj'],
    pedido: { tiempoAtencionBodegaMs: number; bodegaTurnoDesdeAt: Date | null },
    ahora: Date,
  ): {
    tiempoAtencionBodegaMs?: number;
    bodegaTurnoDesdeAt?: Date | null;
  } {
    const reloj = {
      tiempoAtencionBodegaMs: pedido.tiempoAtencionBodegaMs,
      bodegaTurnoDesdeAt: pedido.bodegaTurnoDesdeAt,
    };
    switch (modo) {
      case 'pausar':
      case 'detener':
        return pausarReloj(reloj, ahora);
      case 'reanudar':
        return reanudarReloj(reloj, ahora);
      case 'mantener':
      case undefined:
        return {};
    }
  }

  /**
   * F13: encola el pedido para descarga a Firebird.
   *
   * Se llama DENTRO de la transacción que pone el pedido en PENDIENTE_PAGO, para
   * que estado y cola sean atómicos. `pedidoId` es @unique en
   * `PedidoPendienteEnvio`, así que un encolado duplicado falla con P2002 —
   * eso es intencional: significa que hay un camino que llega a PENDIENTE_PAGO
   * dos veces, y queremos enterarnos en vez de duplicar el pedido en el ERP.
   *
   * El agente lo baja vía poll-pedidos y GRABAR_PEDIDOS genera el folio local
   * (VFP), que se guarda en externalFolio en el ACK (doble folio: la web
   * mantiene su numeroPedido, VFP el suyo).
   *
   * externalIdPEDIDOS determinista (1B + pedidoId): aunque el SQLite del
   * agente se pierda, GRABAR_PEDIDOS recibe siempre el mismo ID y la SP lo
   * trata como UPDATE (idempotente).
   */
  async encolarEnvioAFirebird(tx: Prisma.TransactionClient, pedidoId: number): Promise<void> {
    await tx.pedidoPendienteEnvio.create({
      data: {
        pedidoId,
        estado: 'PENDIENTE',
        // Offset 1B (`OFFSET_ID_PEDIDO_NUBE`): los IDs Firebird típicos son <10M, así
        // que 1B+id nube evita colisión con IDs locales reales. El handler de pagos
        // reconoce este rango (`id-pedido-externo.util.ts`).
        externalIdPEDIDOS: OFFSET_ID_PEDIDO_NUBE + pedidoId,
      },
    });
  }

  /**
   * Transición de estado disparada por un sistema externo (agente Firebird),
   * sin guards de rol humano.
   *
   * Delega en `cambiarEstado` con un usuario SISTEMA en vez de reimplementar
   * la transición. Antes era una segunda implementación de ~70 líneas que ya
   * había divergido: no soportaba `invalidarMonitor`, no limpiaba `llamadoAt`
   * al salir de REVISADO, y no aplicaba `reloj` ni `asignacion`. Con una
   * sola implementación, cualquier arreglo futuro a la máquina (como el guard
   * de `encolarFirebird`) vale también para el camino del agente.
   *
   * El rol ADMIN es el que usa el sistema a propósito: `PedidoAccessService`
   * exime a ADMIN de la validación de tienda, que es justo lo que un proceso
   * de confianza necesita. No hay escalada de privilegios: el caller de este
   * método es el agente autenticado por `ApiKeyGuard`.
   *
   * `saltarSiIgual` conserva el comportamiento anterior: si el pedido ya está
   * en ese estado, no hay transición que hacer y no se escribe historial.
   */
  async cambiarEstadoPorSistema(
    pedidoId: number,
    nuevoEstado: EstadoPedido,
    opts: { observacion?: string; usuarioNombre?: string } = {},
  ) {
    const actual = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { estado: true },
    });
    if (!actual) throw new NotFoundException('Pedido no encontrado');
    if (actual.estado === nuevoEstado) return;

    const nombre = opts.usuarioNombre ?? 'SISTEMA';
    return this.cambiarEstado(
      pedidoId,
      {
        nuevoEstado,
        observacion: opts.observacion || `Cambio de estado por ${nombre}`,
      },
      { userId: 0, nombre, rol: RolUsuario.ADMIN },
    );
  }

  /**
   * Genera el siguiente número de pedido con el formato `PD-YYYY-NNNNNN`.
   * Se calcula a partir del último pedido del año en curso (no usa secuencia
   * de BD para mantenerlo portable entre migraciones).
   */
  async generarNumeroPedido(): Promise<string> {
    const year = new Date().getFullYear();
    const ultimo = await this.prisma.pedido.findFirst({
      where: { numeroPedido: { startsWith: `PD-${year}-` } },
      orderBy: { id: 'desc' },
    });
    let n = 1;
    if (ultimo) {
      const partes = ultimo.numeroPedido.split('-');
      const u = parseInt(partes[2], 10);
      if (!isNaN(u)) n = u + 1;
    }
    return `PD-${year}-${n.toString().padStart(6, '0')}`;
  }

  /**
   * Devuelve el detalle completo de un pedido con items, mensajes, historial y
   * asignado. Si llega `usuario`, valida acceso (no-admin debe pertenecer a la
   * tienda o ser el dueño).
   *
   * Lo consumen: cliente (su pedido), bodega (cualquier pedido de su tienda),
   * cajero, admin y mostrador.
   */
  async obtenerDetalle(pedidoId: number, usuario?: UserContext) {
    if (usuario) {
      await this.access.cargarYValidar(pedidoId, usuario);
    }
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: {
        items: {
          include: {
            producto: {
              select: {
                imagenPrincipal: true,
                imagenesProducto: { select: { url: true, colorId: true } },
              },
            },
            // F8 oct 2026: el hex del color se expone para que la UI del
            // bodeguero muestre el chip de color en cada item del surtido.
            // Antes sólo viajaba colorId; el cliente sólo veía el nombre.
            precioCO: {
              select: {
                colorId: true,
                color: { select: { hex: true } },
              },
            },
          },
        },
        tienda: true,
        usuario: { select: { id: true, nombre: true, email: true, telefono: true } },
        // F4 (jul 2026): incluimos el bodeguero asignado para que la UI pueda
        // mostrar "asignado a {nombre}" en badges y deshabilitar CTAs cuando
        // el pedido está siendo surtido por otro bodeguero. Permitido en
        // EN_REVISION sin asignar (devuelve null).
        asignadoA: { select: { id: true, nombre: true, apellido: true } },
        // F22: quién llamó al cliente y desde qué mostrador. El segundo operador que
        // abre un pedido ya llamado ve "Lo atiende Ana · Mostrador 2" y no pisa a su
        // compañera. Solo tiene valor en EN_ATENCION (la máquina lo limpia al salir).
        llamadoPor: { select: { id: true, nombre: true, apellido: true } },
        llamadoMostrador: { select: { id: true, numero: true } },
        historial: { orderBy: { createdAt: 'asc' } },
        // F14: incluir el autor para poder aplanar `autorNombre` (el admin
        // renderiza las burbujas del chat y antes salían sin nombre).
        mensajes: {
          orderBy: { createdAt: 'asc' },
          include: { autor: { select: { id: true, nombre: true, rol: true } } },
        },
        // F12: propuestas de ajuste (historial de negociación).
        propuestas: {
          orderBy: { enviadaAt: 'asc' },
          include: {
            creadaPor: { select: { id: true, nombre: true, apellido: true } },
            forzadaPor: { select: { id: true, nombre: true, apellido: true } },
          },
        },
        // QR: el folio VFP (externalFolio) se expone para que el frontend
        // muestre el QR y el folio visible. Solo existe tras el ACK del agente.
        pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
      },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
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
    (pedido as any).asignadoANombre = asignadoANombre((pedido as any).asignadoA);
    // F22: mismo shape plano que usa la cola de mostrador (`conAtencion`).
    const llamadoPor = (pedido as any).llamadoPor;
    (pedido as any).atendidoPorNombre = llamadoPor
      ? `${llamadoPor.nombre}${llamadoPor.apellido ? ' ' + llamadoPor.apellido : ''}`
      : null;
    (pedido as any).mostradorNumero = (pedido as any).llamadoMostrador?.numero ?? null;
    // F14: aplanar el nombre del autor de cada mensaje (mismo shape que
    // `MessagesService.listar` y que el payload de `mensaje.creado`).
    (pedido as any).mensajes = (pedido as any).mensajes.map((m: any) => ({
      ...m,
      autorNombre: m.autor?.nombre ?? null,
    }));
    return pedido;
  }

  private notifTipoParaEstado(estado: EstadoPedido): TipoNotificacion | null {
    switch (estado) {
      case EstadoPedido.ESPERANDO_APROBACION:
        return TipoNotificacion.REVISION_PROPUESTA;
      // F13: EN_ASESORIA no notifica aquí: el email ASESOR_SOLICITADO lo
      // dispara PropuestaService (que conoce la nota del cliente y el origen
      // de la propuesta), no la máquina de estados genérica.
      case EstadoPedido.EN_ASESORIA:
        return null;
      // F16: el pedido quedó apartado en tienda esperando que el cliente lo
      // revise. Exige que se presente físicamente, así que sí se notifica.
      case EstadoPedido.REVISADO:
        return TipoNotificacion.LISTO_EN_TIENDA;
      // PENDIENTE_PAGO no notifica al cliente: el cambio lo ve por realtime/refresh
      // cuando bodega confirma el surtido o el cliente acepta la propuesta.
      case EstadoPedido.PAGADO:
        return TipoNotificacion.PAGO_CONFIRMADO;
      case EstadoPedido.ENVIADO:
        return TipoNotificacion.ENVIADO;
      case EstadoPedido.ENTREGADO:
        return TipoNotificacion.ENTREGADO;
      case EstadoPedido.CANCELADO:
        return TipoNotificacion.CANCELADO;
      default:
        return null;
    }
  }
}
