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
 * FLUJO COMPLETO (F16, sep 2026): el pedido pasa por MOSTRADOR antes de pagar
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   PENDING_REVIEW → REVIEWING → EN_MOSTRADOR → PENDING_PAID → PAID → COMPLETED
 *                        │            │
 *                        │            ├─→ REVIEWING   (el cliente pidió cambios)
 *                        │            └─→ CANCELLED   (+ lista de reposición)
 *                        │
 *                        └─→ PENDING_PAID  (solo DOMICILIO: salta mostrador)
 *
 * El negocio necesitaba que el cliente viera y aprobara los productos en tienda
 * antes de pagar, porque muchos piden más cosas o cambian algo al verlos.
 *
 * DOS INVARIANTES que sostienen el diseño:
 *
 *   1. **El ERP solo ve pedidos liberados por mostrador.** El encolado a
 *      Firebird (`encolarFirebird: true`) ocurre al pasar a PENDING_PAID, y a
 *      ese estado solo se llega liberando desde EN_MOSTRADOR (o por el camino
 *      de domicilio). Así un ajuste o cancelación en mostrador nunca deja al
 *      ERP desincronizado: el pedido todavía no existe allá.
 *
 *   2. **PENDING_PAID ⟺ fila en `PedidoPendienteEnvio`.** Un pedido en ese
 *      estado sin fila es invisible al agente, nunca recibe folio y se queda
 *      atascado para siempre. Por eso `encolarFirebird` es obligatorio ahí.
 *      La decisión vive en `destinoTrasSurtido` (core/destino-post-surtido.util)
 *      para que los tres caminos que cierran la verificación no puedan divergir.
 *
 * Los pedidos a DOMICILIO saltan mostrador: no tiene sentido mostrarle el
 * pedido a un cliente que no está en la tienda. Van REVIEWING → PENDING_PAID
 * directo, con el encolado inmediato.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * F13 (sep 2026): los arcos que salen de WAITING_CUSTOMER_APPROVAL se
 * distinguen por DESTINO, no por valores nuevos de enum:
 *
 *   → EN_MOSTRADOR   cliente APROBÓ una propuesta de BODEGA (o de VENTAS que
 *                    no dejó items pendientes). Bodega ya verificó físicamente
 *                    lo que propuso; el cliente lo revisa antes de pagar.
 *   → PENDING_PAID   el camino de DOMICILIO (no pasa por mostrador).
 *   → REVIEWING      cliente APROBÓ una propuesta de VENTAS y quedaron items
 *                    nuevos por surtir. Vuelve a bodega SIN ASIGNAR.
 *   → EN_ASESORIA    cliente pidió asesor (propuesta de bodega), o rechazó una
 *                    propuesta de VENTAS y quiere re-negociar.
 *   → CANCELLED      cliente rechazó una propuesta de BODEGA, o canceló
 *                    explícitamente.
 *
 * F16 (sep 2026): el pedido pasa por MOSTRADOR antes de pagar. El negocio
 * necesitaba que el cliente viera y aprobara los productos en tienda antes de
 * pagar, porque muchos piden más cosas o cambian algo al verlos.
 *
 *   → EN_MOSTRADOR   bodega (o ventas) terminó de verificar. El pedido está
 *                    apartado esperando que el cliente lo revise. NO está
 *                    encolado a Firebird todavía.
 *   EN_MOSTRADOR →   PENDING_PAID (liberar: AQUÍ entra al ERP),
 *                    REVIEWING (ajustar: el cliente cambió algo),
 *                    CANCELLED (cancelar + reposición).
 *
 * Los pedidos a DOMICILIO saltan mostrador: no tiene sentido mostrarle el
 * pedido a un cliente que no está en la tienda. Van REVIEWING → PENDING_PAID
 * directo, como antes.
 */
const TRANSICIONES: Record<EstadoPedido, EstadoPedido[]> = {
  [EstadoPedido.PENDING_REVIEW]: [EstadoPedido.REVIEWING, EstadoPedido.CANCELLED],
  [EstadoPedido.REVIEWING]: [
    // REVIEWING → WAITING_CUSTOMER_APPROVAL: lo dispara PropuestaService
    // cuando bodega envía una propuesta (hay faltantes).
    EstadoPedido.WAITING_CUSTOMER_APPROVAL,
    // F16: REVIEWING → EN_MOSTRADOR es la transición normal de bodega para
    // pedidos que se recogen en tienda (KIOSKO / RECOGER_TIENDA).
    EstadoPedido.EN_MOSTRADOR,
    // REVIEWING → PENDING_PAID: se CONSERVA, pero sólo para DOMICILIO. Un
    // pedido a domicilio no pasa por mostrador (el cliente no está en tienda).
    // También lo dispara SurtidoService.confirmarSurtido cuando la bodega
    // cierra el surtido SIN faltantes.
    EstadoPedido.PENDING_PAID,
    EstadoPedido.CANCELLED,
  ],
  // F13: el cliente decide sobre una propuesta. El destino depende del origen
  // de la propuesta y de la decisión — ver el comentario de arriba.
  // F16: el destino de "aprobó y no queda nada por surtir" pasó de
  // PENDING_PAID a EN_MOSTRADOR para pedidos de tienda.
  [EstadoPedido.WAITING_CUSTOMER_APPROVAL]: [
    EstadoPedido.EN_MOSTRADOR,
    EstadoPedido.PENDING_PAID,
    EstadoPedido.REVIEWING,
    EstadoPedido.EN_ASESORIA,
    EstadoPedido.CANCELLED,
  ],
  // F13: el pedido está en manos del asesor de ventas de la tienda. Sale de
  // aquí cuando el vendedor manda una contrapropuesta (→ WAITING_CUSTOMER_
  // APPROVAL), cuando determina que el pedido original estaba bien y lo
  // devuelve a bodega (→ REVIEWING), o cuando se cancela.
  // F16: también puede ir a EN_MOSTRADOR si la contrapropuesta no dejó items
  // pendientes y el pedido se recoge en tienda.
  [EstadoPedido.EN_ASESORIA]: [
    EstadoPedido.WAITING_CUSTOMER_APPROVAL,
    EstadoPedido.REVIEWING,
    EstadoPedido.EN_MOSTRADOR,
    EstadoPedido.CANCELLED,
  ],
  // F16: el pedido está apartado en mostrador esperando que el cliente lo
  // revise. Las tres salidas son las acciones del operador:
  //   → PENDING_PAID  liberar (AQUÍ se encola a Firebird: el ERP sólo ve
  //                   pedidos que el cliente ya confirmó).
  //   → REVIEWING     ajustar (el cliente pidió cambios; bodega re-surte).
  //                   Requiere opts.asignacion explícito por el guard de
  //                   `cambiarEstado` — el caller NO es un bodeguero.
  //   → CANCELLED     cancelar (crea la lista de reposición en la misma tx).
  [EstadoPedido.EN_MOSTRADOR]: [
    EstadoPedido.PENDING_PAID,
    EstadoPedido.REVIEWING,
    EstadoPedido.CANCELLED,
  ],
  [EstadoPedido.PENDING_PAID]: [EstadoPedido.PAID, EstadoPedido.CANCELLED],
  // PAID → SHIPPED sólo aplica a pedidos a domicilio (con shippingDireccion).
  // Kiosko y web recoger en tienda saltan directo a COMPLETED vía el módulo
  // Mostrador. La validación de shippingDireccion ocurre en `marcarEnviado`.
  [EstadoPedido.PAID]: [EstadoPedido.SHIPPED, EstadoPedido.COMPLETED, EstadoPedido.CANCELLED],
  [EstadoPedido.SHIPPED]: [EstadoPedido.COMPLETED, EstadoPedido.CANCELLED],
  [EstadoPedido.COMPLETED]: [],
  [EstadoPedido.CANCELLED]: [],
};

/**
 * F13 (sep 2026): opciones de `cambiarEstado`.
 *
 * Existen porque el flujo nuevo tiene arcos que NO se comportan como el
 * original. El caso crítico es `asignacion`: el default histórico asignaba el
 * pedido a quien transicionaba, lo cual es correcto cuando un bodeguero toma
 * un pedido pero es un landmine cuando el CLIENTE aprueba una propuesta y el
 * pedido vuelve a REVIEWING — quedaría asignado a un cliente, invisible en el
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
   * REQUERIDO cuando el destino es REVIEWING: no hay default seguro, porque
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
   * Obligatorio para toda transición a PENDING_PAID: un pedido en ese estado
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
   * método SIEMPRE asignaba el pedido al caller al ir a REVIEWING, lo cual es
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
      return this.ejecutarCambio(opts.tx, pedidoId, dto, usuario, opts);
    }

    const { pedido, efectos } = await this.prisma.$transaction((tx) =>
      this.ejecutarCambio(tx, pedidoId, dto, usuario, opts),
    );
    this.dispararEfectos(pedidoId, efectos);
    return pedido;
  }

  /**
   * Emite el realtime y la notificación de una transición ya confirmada.
   *
   * Vive fuera de `ejecutarCambio` a propósito: emitir dentro del callback de
   * `$transaction` es emitir antes del commit, así que un rollback posterior
   * dejaba a los clientes con un evento de un cambio que nunca ocurrió.
   */
  private dispararEfectos(
    pedidoId: number,
    e: {
      tiendaId: number;
      estadoAnterior: EstadoPedido;
      estadoNuevo: EstadoPedido;
      invalidarMonitor: boolean;
      notifTipo: TipoNotificacion | null;
    },
  ): void {
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

      const permitidas = TRANSICIONES[estadoAnterior];
      if (!permitidas.includes(estadoNuevo)) {
        throw new BadRequestException(
          `Transición no permitida: ${estadoAnterior} → ${estadoNuevo}`,
        );
      }

      // F13: ir a REVIEWING sin decir qué hacer con la asignación es un bug
      // latente (el pedido podría quedar asignado a un cliente). Exigimos
      // que el caller sea explícito.
      if (estadoNuevo === EstadoPedido.REVIEWING && !opts.asignacion) {
        throw new BadRequestException(
          'Transición a REVIEWING requiere opts.asignacion explícito ' +
            "('caller' si un bodeguero lo toma, 'limpiar' si vuelve a la cola, " +
            "'mantener' si se conserva la asignación actual).",
        );
      }

      // INVARIANTE: `PENDING_PAID ⟺ fila en PedidoPendienteEnvio`.
      //
      // Un pedido en PENDING_PAID sin fila en la cola del ERP es invisible al
      // agente, nunca recibe folio y se queda atascado para siempre. El
      // comentario de `encolarFirebird` ya lo declaraba obligatorio, pero nada
      // lo verificaba: un caller futuro que lo omitiera producía exactamente
      // ese estado irrecuperable, en silencio.
      //
      // Se comprueba aquí y no en cada caller para que ninguna transición
      // nueva pueda olvidarlo. Si el pedido YA tiene fila (p. ej. la creó una
      // transición anterior) no hace falta volver a encolar.
      if (estadoNuevo === EstadoPedido.PENDING_PAID && !opts.encolarFirebird) {
        const yaEncolado = await tx.pedidoPendienteEnvio.findFirst({
          where: { pedidoId },
          select: { id: true },
        });
        if (!yaEncolado) {
          throw new BadRequestException(
            'Transición a PENDING_PAID requiere opts.encolarFirebird: un pedido ' +
              'en ese estado sin fila en la cola del ERP es invisible al agente ' +
              'y se queda atascado para siempre.',
          );
        }
      }

      const ahora = new Date();
      const result = await tx.pedido.updateMany({
        where: { id: pedidoId, estado: estadoAnterior },
        data: {
          estado: estadoNuevo,
          ...this.cambiosDeAsignacion(opts.asignacion, usuario, ahora),
          ...this.cambiosDeReloj(opts.reloj, pedido, ahora),
          // F16: "Atendiendo" solo tiene sentido dentro de EN_MOSTRADOR. Al
          // salir (a pago, a bodega o a cancelado) el panel de la TV debe
          // vaciarse solo — si no, un folio ya cobrado seguiría anunciado como
          // "te toca". Se limpia aquí y no en cada caller para que ninguna
          // transición futura pueda olvidarlo.
          ...(estadoNuevo !== EstadoPedido.EN_MOSTRADOR ? { llamadoAt: null } : {}),
        },
      });
      if (result.count !== 1) {
        throw new ConflictException(
          'El pedido cambió mientras se procesaba. Actualiza la pantalla e inténtalo de nuevo.',
        );
      }

      // Efectos de dominio (ej. aplicar los items de una propuesta aceptada)
      // en la MISMA transacción que la transición: si fallan, no queda un
      // pedido en PENDING_PAID con items a medio aplicar.
      if (opts.efectos) {
        await opts.efectos(tx);
      }

      // F13: un pedido en PENDING_PAID sin fila en la cola de Firebird es
      // invisible para el agente y se queda atascado para siempre. Se encola
      // aquí, dentro de la tx, para que estado y cola sean atómicos.
      if (opts.encolarFirebird) {
        await this.encolarEnvioAFirebird(tx, pedidoId);
      }

      const pedidoActualizado = await tx.pedido.findUnique({
        where: { id: pedidoId },
      });
      if (!pedidoActualizado) {
        throw new NotFoundException('Pedido no encontrado');
      }

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

      // Los efectos externos (realtime y notificación) se DEVUELVEN en vez de
      // emitirse aquí. Emitir dentro del callback de `$transaction` significa
      // emitir ANTES del commit: si la transacción hace rollback después (por
      // el encolado, por el historial, o por un `efectos` que falle), los
      // clientes ya recibieron un evento de un cambio que nunca ocurrió.
      //
      // El caller los dispara cuando la transacción ya confirmó.
      const notifTipo = this.notifTipoParaEstado(estadoNuevo);

      return {
        pedido: pedidoActualizado,
        efectos: {
          tiendaId: pedido.tiendaId,
          estadoAnterior,
          estadoNuevo,
          invalidarMonitor: opts.invalidarMonitor ?? false,
          notifTipo,
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
   * Se llama DENTRO de la transacción que pone el pedido en PENDING_PAID, para
   * que estado y cola sean atómicos. `pedidoId` es @unique en
   * `PedidoPendienteEnvio`, así que un encolado duplicado falla con P2002 —
   * eso es intencional: significa que hay un camino que llega a PENDING_PAID
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
        // Offset 1B: los IDs Firebird típicos son <10M, así que 1B+id nube
        // evita colisión con IDs locales reales.
        externalIdPEDIDOS: 1_000_000_000 + pedidoId,
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
   * al salir de EN_MOSTRADOR, y no aplicaba `reloj` ni `asignacion`. Con una
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
        // REVIEWING sin asignar (devuelve null).
        asignadoA: { select: { id: true, nombre: true, apellido: true } },
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
      case EstadoPedido.WAITING_CUSTOMER_APPROVAL:
        return TipoNotificacion.REVISION_PROPUESTA;
      // F13: EN_ASESORIA no notifica aquí: el email ASESOR_SOLICITADO lo
      // dispara PropuestaService (que conoce la nota del cliente y el origen
      // de la propuesta), no la máquina de estados genérica.
      case EstadoPedido.EN_ASESORIA:
        return null;
      // F16: el pedido quedó apartado en tienda esperando que el cliente lo
      // revise. Exige que se presente físicamente, así que sí se notifica.
      case EstadoPedido.EN_MOSTRADOR:
        return TipoNotificacion.LISTO_EN_TIENDA;
      // PENDING_PAID no notifica al cliente: el cambio lo ve por realtime/refresh
      // cuando bodega confirma el surtido o el cliente acepta la propuesta.
      case EstadoPedido.PAID:
        return TipoNotificacion.PAGO_CONFIRMADO;
      case EstadoPedido.SHIPPED:
        return TipoNotificacion.ENVIADO;
      case EstadoPedido.COMPLETED:
        return TipoNotificacion.ENTREGADO;
      case EstadoPedido.CANCELLED:
        return TipoNotificacion.CANCELADO;
      default:
        return null;
    }
  }
}
