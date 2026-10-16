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
import { PedidoStateService } from '../core/pedido-state.service';
import { ReposicionService } from '../reposicion/reposicion.service';
import { bolsaEnManosDeBodega } from '../core/bolsa-en-bodega.util';
import { resolverModoEntrega } from '../core/delivery-mode.util';
import { avisoDeLlegadaSirve, motivoNoAvisable } from '../core/llegada-aviso.util';
import { construirItemPedido } from '../core/item-pedido.util';
import { contarMensajesNoLeidos } from '../core/mensajes-no-leidos.util';
import { PreciosService } from '../../precios/precios.service';
import {
  precioDeLista,
  precioConPromoVolumen,
  COLUMNA_MAYOREO,
} from '../../precios/precio-lista.util';
import { KioskoService } from '../../kiosko/kiosko.service';
import { KioskoLlegadaService } from '../../kiosko/kiosko-llegada.service';
import { PresenciaService } from '../core/presencia.service';
import { pagoBloqueaCancelacion } from '../../pagos/transferencia/hooks';
import { SinRecogerService } from '../core/sin-recoger.service';
import { CreatePedidoDto } from './dto/create-pedido.dto';
import { UserContext } from '../../../types/pedido.types';
import { EstadoPedido, TipoNotificacion, Prisma, CanalOrigen, ModoEntrega } from '@prisma/client';

/**
 * Servicio del dominio CLIENTE.
 *
 * Responsabilidad: crear pedidos (web + kiosko), listar/buscar mis pedidos,
 * cancelar mi pedido. Cualquier acción de cambio de estado delega a
 * `PedidoStateService` para mantener una sola fuente de verdad.
 */
@Injectable()
export class ClienteService {
  private readonly logger = new Logger(ClienteService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
    private state: PedidoStateService,
    private readonly storage: StorageService,
    private readonly kioskoService: KioskoService,
    private readonly kioskoLlegada: KioskoLlegadaService,
    private readonly precios: PreciosService,
    /**
     * F20 (oct 2026): la lista de reposición. El cliente puede cancelar su
     * pedido, y la mercancía que bodega había apartado tiene que volver al
     * anaquel — sin esto, esa cancelación no generaba trabajo para nadie.
     */
    private readonly reposicion: ReposicionService,
    /** F22: retirar el aviso de llegada propio. */
    private readonly presencia: PresenciaService,
    /** F22: "sí, aún quiero mi pedido". */
    private readonly sinRecoger: SinRecogerService,
  ) {}

  async crearPedido(
    dto: CreatePedidoDto,
    usuario: UserContext & { tiendaIdHeader?: number },
    idempotencyKey?: string,
    kioskoIdHeader?: number,
    /**
     * PR2 (kiosko-profesional): device token enviado por la tablet en
     * `X-Kiosko-Token`. Sin él, no se acepta un kioskoId del header —
     * cerrar el bug "cualquier cliente puede mentir que es kiosko".
     */
    kioskoDeviceToken?: string,
  ) {
    // Idempotencia: si llega la misma key, devolver el pedido existente
    if (idempotencyKey) {
      const existente = await this.prisma.pedido.findUnique({
        where: { idempotencyKey },
        include: { items: true },
      });
      if (existente) {
        if (existente.usuarioId !== usuario.userId) {
          throw new BadRequestException('La clave de idempotencia ya está en uso');
        }
        this.logger.log(`Idempotency hit para key ${idempotencyKey} → pedido ${existente.id}`);
        return { ...existente, mensaje: 'Pedido (idempotente)' };
      }
    }

    // B2B multi-tienda: la tienda del pedido es la que el cliente
    // seleccionó activamente (header `X-Tienda-Id` enviado por el frontend).
    // Si no viene, caemos a la tienda asignada al usuario.
    const tiendaId = usuario.tiendaIdHeader ?? usuario.tiendaId;

    if (!tiendaId) {
      throw new BadRequestException('Debe seleccionar una tienda para crear el pedido');
    }

    const tienda = await this.prisma.tienda.findFirst({
      where: { id: tiendaId, activa: true },
    });
    if (!tienda) {
      throw new BadRequestException('La tienda seleccionada no está disponible');
    }

    // Un cliente web/kiosko puede pedir en CUALQUIER tienda activa: no
    // pertenece a una tienda concreta. La membresía `usuarioTienda` (poblada
    // por Firebird) solo resuelve la lista de precios del cliente, no gatea
    // pedidos. La tienda del pedido es la que el cliente eligió (X-Tienda-Id).

    // KIOSKO: si el frontend manda X-Kiosko-Id, validamos contra BD y
    // forzamos canalOrigen=KIOSKO. Defensa en profundidad: un kiosko no
    // puede mentir sobre su origen porque validamos que exista, esté
    // ACTIVO, pertenezca a esta tienda Y que el `X-Kiosko-Token` enviado
    // coincida con el hash guardado (PR2 — antes bastaba con saber el
    // kioskoId, que es SERIAL enumerable).
    let kioskoIdFinal: number | null = null;
    let canalOrigenFinal: CanalOrigen = dto.canalOrigen ?? CanalOrigen.WEB;

    if (kioskoIdHeader) {
      const kiosko = await this.prisma.kiosko.findFirst({
        where: { id: kioskoIdHeader, tiendaId, estado: 'ACTIVO' },
      });
      if (!kiosko) {
        throw new BadRequestException('Kiosko inválido o inactivo para esta tienda');
      }
      // Validar device token (timing-safe en el service).
      const tokenValido = await this.kioskoService.validarDeviceToken(
        kioskoIdHeader,
        kioskoDeviceToken,
      );
      if (!tokenValido) {
        // Mismo mensaje genérico para "no tiene token" y "token incorrecto"
        // — no queremos leak de "existe vs token mal".
        throw new BadRequestException('Kiosko sin device token configurado o token inválido');
      }
      kioskoIdFinal = kiosko.id;
      canalOrigenFinal = CanalOrigen.KIOSKO;
    }

    // Si el cliente intenta mandar KIOSKO sin kioskoId real → reject.
    // Sólo permitimos que dto.canalOrigen diga KIOSKO si fue forzado por
    // un kioskoIdHeader válido (ya validado arriba).
    if (dto.canalOrigen === CanalOrigen.KIOSKO && !kioskoIdFinal) {
      throw new BadRequestException(
        'Para pedidos de kiosko se requiere un kiosko activo (header X-Kiosko-Id)',
      );
    }

    // F8 (jul 2026): validación centralizada del modo de entrega.
    const modoEntregaFinal = resolverModoEntrega(dto, canalOrigenFinal, kioskoIdFinal);

    // A partir de aquí, modoEntregaFinal es la fuente de verdad. Limpiamos
    // los campos de envío que no aplican para no almacenarlos.
    const envioFields = {
      shippingDireccion:
        modoEntregaFinal === ModoEntrega.DOMICILIO ? dto.shippingDireccion?.trim() || null : null,
      shippingReferencia:
        modoEntregaFinal === ModoEntrega.DOMICILIO ? dto.shippingReferencia?.trim() || null : null,
      shippingColonia:
        modoEntregaFinal === ModoEntrega.DOMICILIO ? dto.shippingColonia?.trim() || null : null,
      shippingCodigoPostal:
        modoEntregaFinal === ModoEntrega.DOMICILIO
          ? dto.shippingCodigoPostal?.trim() || null
          : null,
      shippingPaqueteria:
        modoEntregaFinal === ModoEntrega.DOMICILIO && !dto.dejarAdminDecidePaqueteria
          ? (dto.shippingPaqueteria ?? null)
          : null,
      dejarAdminDecidePaqueteria:
        modoEntregaFinal === ModoEntrega.DOMICILIO && dto.dejarAdminDecidePaqueteria === true,
    };

    const preciosCO = await this.prisma.precioCO.findMany({
      where: {
        id: { in: dto.items.map((i) => i.precioCOId) },
        tiendaId,
      },
      include: { producto: true, talla: true, color: true, corrida: true },
    });

    if (preciosCO.length !== dto.items.length) {
      throw new BadRequestException('Algunos productos no están disponibles en esta tienda');
    }

    // Fase 0 (sep 2026): el precio del item se congela desde la lista de
    // precios DEL CLIENTE, no desde `pco.precio` (que es siempre lista1).
    // Antes el catálogo mostraba la lista correcta y el pedido se guardaba con
    // lista1: el cliente veía un precio y se le cobraba otro, con el error
    // congelado en `ItemPedido.precioUnitario` y viajando así al ERP.
    const columnaLista = await this.precios.columnaParaUsuario(usuario.userId, tiendaId);

    // Promo de volumen (sep 2026): 12+ piezas → lista 2. Se congela el par
    // (base, mayoreo) en cada item para que la promo se pueda re-evaluar
    // después sin releer `PrecioCO` — ver `promo-volumen.util.ts`.
    //
    // El precio efectivo sale de `precioConPromoVolumen`, la MISMA función que
    // usa la re-evaluación y el endpoint del carrito. Es la única forma de
    // garantizar que el precio congelado sea punto fijo del recálculo: con dos
    // gates distintos (uno por columna, otro por precio) el pedido cambiaría de
    // precio solo cuando Firebird tiene una lista sin capturar.
    const totalPiezas = dto.items.reduce((acc, i) => acc + i.cantidad, 0);

    let subtotal = new Prisma.Decimal(0);
    const itemsData = dto.items.map((item) => {
      const pco = preciosCO.find((p) => p.id === item.precioCOId)!;
      // El snapshot de precios y nombres vive en `construirItemPedido`, la
      // misma función que usan mostrador y propuesta al agregar un producto.
      // Aquí SÍ se conoce el total de piezas, así que el precio efectivo ya
      // sale con la promo de volumen aplicada.
      const data = construirItemPedido(pco, item.cantidad, {
        columnaLista,
        totalPiezas,
        original: true,
        esNuevoDelPedido: true,
      });
      subtotal = subtotal.plus(data.subtotal as Prisma.Decimal);
      return data;
    });

    let pedido: any = null;
    for (let intento = 0; intento < 3 && !pedido; intento++) {
      const numeroPedido = await this.state.generarNumeroPedido();
      try {
        // El pedido vive SOLO en la nube hasta que bodega confirma el surtido
        // (confirmarSurtido → PENDIENTE_PAGO crea la entrada en pedidos_pendientes_envio).
        // Así Firebird sólo recibe pedidos con cantidades finales y no hace falta
        // re-sincronizar ajustes (trigger MOVPED eliminado).
        pedido = await this.prisma.pedido.create({
          data: {
            numeroPedido,
            usuarioId: usuario.userId,
            tiendaId,
            estado: EstadoPedido.SOLICITADO,
            canalOrigen: canalOrigenFinal,
            kioskoId: kioskoIdFinal,
            modoEntrega: modoEntregaFinal,
            // Preferencia NO vinculante (ver `Pedido.metodoPagoPreferido`). En domicilio no aplica
            // todavía: se guarda null para no prometer algo que ese flujo no puede cumplir.
            metodoPagoPreferido:
              modoEntregaFinal === ModoEntrega.DOMICILIO ? null : (dto.metodoPagoPreferido ?? null),
            // F22: un pedido de kiosko se hace con el cliente EN la tienda, así que
            // su lugar en la cola de mostrador cuenta desde ahora. (Un web empieza
            // sin lugar: lo toma cuando avisa su llegada.) Es la llave de orden de
            // la cola — antes todo web con aviso pasaba delante de cualquier kiosko.
            ...(canalOrigenFinal === CanalOrigen.KIOSKO ? { presenteDesdeAt: new Date() } : {}),
            ...envioFields,
            subtotal,
            total: subtotal,
            clienteNombre: dto.clienteNombre,
            clienteEmail: dto.clienteEmail,
            clienteTelefono: dto.clienteTelefono,
            notas: dto.notas,
            idempotencyKey,
            items: { create: itemsData },
            historial: {
              create: {
                estadoNuevo: EstadoPedido.SOLICITADO,
                observacion: kioskoIdFinal
                  ? `Pedido creado desde kiosko ${kioskoIdFinal}`
                  : 'Pedido creado por cliente',
                usuarioId: usuario.userId,
                usuarioNombre: usuario.nombre,
              },
            },
          },
          include: {
            items: true,
            tienda: true,
            kiosko: { select: { id: true, nombre: true } },
            pendienteEnvio: true,
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
        if (idempotencyKey) {
          const concurrente = await this.prisma.pedido.findUnique({
            where: { idempotencyKey },
            include: { items: true },
          });
          if (concurrente) {
            if (concurrente.usuarioId !== usuario.userId) {
              throw new BadRequestException('La clave de idempotencia ya está en uso');
            }
            pedido = concurrente;
          }
        }
      }
    }

    if (!pedido) {
      throw new ConflictException('No se pudo generar un número único de pedido');
    }

    this.logger.log(
      `Pedido ${pedido.numeroPedido} creado (SOLICITADO, canal=${pedido.canalOrigen}, kioskoId=${pedido.kioskoId ?? '-'})`,
    );

    // Realtime: notificar a la tienda (monitor + tablets de bodega).
    this.realtime.emitToTienda(pedido.tiendaId, 'pedido.creado', {
      id: pedido.id,
      numeroPedido: pedido.numeroPedido,
      canalOrigen: pedido.canalOrigen,
    });

    // Fire-and-forget: no bloqueamos la respuesta del cliente si el email tarda
    void this.notifications
      .enviar(pedido as any, TipoNotificacion.PEDIDO_RECIBIDO)
      .catch((err) =>
        this.logger.error(`Error enviando notificación PEDIDO_RECIBIDO: ${err.message}`),
      );

    return { ...pedido, mensaje: 'Pedido creado exitosamente' };
  }

  async obtenerMisPedidos(usuarioId: number, pagina = 1, limite = 10) {
    const skip = (pagina - 1) * limite;
    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where: { usuarioId },
        include: {
          items: {
            select: {
              id: true,
              productoNombre: true,
              tallaNombre: true,
              colorNombre: true,
              cantidad: true,
              precioUnitario: true,
              precioCOId: true,
              original: true,
              cancelada: true,
              sustitucionPropuestaPrecioCOId: true,
            },
          },
          tienda: { select: { id: true, nombre: true } },
          kiosko: { select: { id: true, nombre: true } },
          // F18 (oct 2026): las propuestas PENDIENTES, para que el badge de
          // "Pendiente de aprobación" se derive del BACKEND.
          //
          // Antes no se incluían, así que el badge dependía de un evento
          // realtime guardado en localStorage: si el cliente no tenía la app
          // abierta cuando bodega cerró el surtido incompleto, NUNCA veía el
          // badge — y al abrir el pedido no había nada que responder.
          propuestas: {
            where: { estado: 'PENDIENTE' },
            select: { id: true, estado: true, creadaPorRol: true },
          },
        },
        orderBy: { fechaPedido: 'desc' },
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where: { usuarioId } }),
    ]);
    // Oct 2026: el badge de "mensajes nuevos" se deriva del watermark, no de un
    // contador en localStorage del navegador. Ver `contarMensajesNoLeidos`.
    const noLeidos = await contarMensajesNoLeidos(
      this.prisma,
      pedidos.map((p) => p.id),
      'cliente',
    );
    return {
      data: pedidos.map((p) => ({ ...p, mensajesNoLeidos: noLeidos.get(p.id) ?? 0 })),
      meta: { total, pagina, limite, totalPaginas: Math.ceil(total / limite) },
    };
  }

  async obtenerMiPedido(pedidoId: number, usuarioId: number) {
    const pedido = await this.prisma.pedido.findFirst({
      where: { id: pedidoId, usuarioId },
      include: {
        items: {
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
        tienda: true,
        kiosko: { select: { id: true, nombre: true } },
        historial: { orderBy: { createdAt: 'asc' } },
        mensajes: { where: { visibleParaCliente: true }, orderBy: { createdAt: 'asc' } },
        cajeroAsignado: { select: { id: true, nombre: true, apellido: true } },
        // Oct 2026: el folio del Sistema Comercial (el del ticket y del correo) y el QR con el que el
        // cliente se identifica en caja. La pantalla ya los pintaba pero este include nunca lo
        // pedía, así que no se veían NUNCA. Solo el folio: el resto de la fila es del agente
        // (intentos, errores, leases) y no es del cliente.
        pendienteEnvio: { select: { externalFolio: true } },
        // F12: propuestas de ajuste para que el cliente vea y responda.
        propuestas: {
          orderBy: { enviadaAt: 'asc' },
          include: {
            creadaPor: { select: { id: true, nombre: true, apellido: true } },
          },
        },
      },
    });
    if (!pedido) {
      // 404 (no 403) para no filtrar existencia del pedido a clientes ajenos.
      throw new NotFoundException('Pedido no encontrado');
    }
    // Adjuntar productoImagen a cada item del pedido: la imagen del color de
    // la variante (si el producto tiene imágenes asociadas a ese color);
    // fallback a la imagen principal del producto.
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
    // Oct 2026: el servidor dice si la tarjeta "¿Ya estás en la tienda?" tiene sentido en este estado
    // (ver `avisoDeLlegadaSirve`); la pantalla no deduce a mano en qué estados mostrarla.
    return { ...pedido, puedeAvisarLlegada: avisoDeLlegadaSirve(pedido) };
  }

  /**
   * F20 (oct 2026): el cliente cancela su propio pedido.
   *
   * DOS bugs que esto arregla:
   *
   * 1. NO validaba el estado. El controller promete "sólo antes de PAID" pero
   *    el código no lo cumplía: el cliente podía cancelar un pedido ya PAGADO
   *    (y hasta ENVIADO), porque `TRANSICIONES[PAGADO]` incluye CANCELADO.
   *
   *    Ese arco existe A PROPÓSITO y NO se toca: lo usa Firebird (SWCANCEL)
   *    cuando el ERP cancela un pedido. La regla del negocio es que la web se
   *    adecúa al ERP, no al revés — así que el límite va aquí, en el camino del
   *    CLIENTE, no en la tabla de transiciones.
   *
   *    El corte es `PENDIENTE_PAGO`: hasta ahí el pedido todavía no entró a
   *    Firebird (el encolado al ERP ocurre justo al pasar a ese estado), así que
   *    cancelarlo es seguro. Desde `PAGADO` en adelante el cobro ya ocurrió en
   *    VFP y la cancelación tiene que venir del ERP.
   *
   * 2. NO creaba la lista de reposición. Mostrador y las propuestas sí la crean
   *    (`crearDesdePedido`), pero este camino no — así que la mercancía que
   *    bodega había apartado se quedaba sin que nadie la devolviera al anaquel.
   *    Es justo el trabajo que el negocio necesita que bodega vea.
   */
  async cancelarPedido(pedidoId: number, usuarioId: number, usuario: UserContext) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { estado: true, asignadoAId: true },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');

    /**
     * Estados donde el cliente todavía puede cancelar.
     *
     * `PENDIENTE_PAGO` entra: el pedido está encolado al ERP pero el cobro no
     * ha ocurrido. `PAGADO` y posteriores quedan fuera — ahí manda Firebird.
     */
    const CANCELABLES_POR_EL_CLIENTE: EstadoPedido[] = [
      EstadoPedido.SOLICITADO,
      EstadoPedido.EN_REVISION,
      EstadoPedido.REVISADO,
      EstadoPedido.EN_ATENCION,
      EstadoPedido.ESPERANDO_APROBACION,
      EstadoPedido.EN_ASESORIA,
      EstadoPedido.PENDIENTE_PAGO,
    ];

    if (!CANCELABLES_POR_EL_CLIENTE.includes(pedido.estado)) {
      throw new BadRequestException(
        pedido.estado === EstadoPedido.PAGADO ||
          pedido.estado === EstadoPedido.ENVIADO ||
          pedido.estado === EstadoPedido.ENTREGADO
          ? 'Tu pedido ya fue pagado, así que no se puede cancelar desde aquí. ' +
              'Acércate a mostrador para cualquier cambio.'
          : `No se puede cancelar un pedido en estado ${pedido.estado}.`,
      );
    }

    // Oct 2026 (pagos por transferencia): con un comprobante en revisión o dinero ya verificado,
    // cancelar deja un dinero sin dueño. Primero se resuelve el dinero (Tesorería / mostrador).
    // Si el comprobante llega justo después de esta lectura, la cancelación pasa y el hook de la
    // máquina de estados deja el pago marcado para que Tesorería lo resuelva: nunca se pierde.
    const pagoEnCurso = await pagoBloqueaCancelacion(this.prisma, pedidoId);
    if (pagoEnCurso) {
      throw new ConflictException(
        pagoEnCurso.estado === 'VERIFICADO'
          ? 'Tu transferencia ya fue verificada, así que no puedes cancelar el pedido desde aquí. Acércate a mostrador.'
          : 'Ya enviaste un comprobante de transferencia y lo estamos revisando. Espera a que lo confirmemos, o contacta a la tienda.',
      );
    }

    // Oct 2026: si bodega lo tiene en las manos (sin surtir o a medias) NO hay
    // lista de reposición: el bodeguero recibe el aviso de cancelación y regresa
    // al anaquel lo que trae. Se decide ANTES de cancelar — después la máquina de
    // estados ya limpió la asignación y movió el estado.
    const enManosDeBodega = await bolsaEnManosDeBodega(this.prisma, {
      id: pedidoId,
      estado: pedido.estado,
      asignadoAId: pedido.asignadoAId,
    });

    return this.state.cambiarEstado(
      pedidoId,
      { nuevoEstado: EstadoPedido.CANCELADO, observacion: 'Cancelado por el cliente' },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        invalidarMonitor: true,
        // La reposición va DENTRO de la transición: si el pedido se cancela
        // pero la lista falla, quedaría mercancía apartada sin nadie que la
        // devuelva. Mismo patrón que `MostradorService.cancelar`.
        efectos: async (tx) => {
          await this.reposicion.crearDesdePedido(tx, pedidoId, 'Cancelado por el cliente', {
            bolsaEnManosDeBodega: enManosDeBodega,
          });
        },
      },
    );
  }

  /**
   * F22: el cliente retira su propio aviso de llegada ("ya no estoy aquí"). El
   * pedido sale de la cola de mostrador. Ver `PresenciaService.retirarPorCliente`.
   */
  async retirarLlegada(pedidoId: number, usuarioId: number) {
    return this.presencia.retirarPorCliente(pedidoId, usuarioId);
  }

  /**
   * F22: el cliente contesta "sí, aún quiero mi pedido" al recordatorio. Ver
   * `SinRecogerService.confirmarInteres`.
   */
  async confirmarInteres(pedidoId: number, usuarioId: number) {
    return this.sinRecoger.confirmarInteres(pedidoId, usuarioId);
  }

  // PR7: el cliente avisa llegada desde la app/web autenticado. Como
  // ya validamos `usuarioId === user.userId` en el controller, el
  // service solo valida estado y modo de entrega. La lógica de
  // escritura + realtime vive en KioskoLlegadaService (mismo path
  // que kiosko) pero sin requerir X-Kiosko-Id/X-Kiosko-Token.
  async anunciarLlegada(pedidoId: number, usuarioId: number) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        id: true,
        estado: true,
        modoEntrega: true,
        tiendaId: true,
        usuarioId: true,
      },
    });
    if (!pedido || pedido.usuarioId !== usuarioId) {
      throw new NotFoundException('Pedido no encontrado');
    }
    // F22 (oct 2026): se puede avisar la llegada en CUALQUIER estado no terminal
    // de un pedido que se recoge en tienda — también antes de que bodega
    // termine. (F16 lo limitaba a `REVISADO`, y el cliente que llegaba temprano no
    // tenía cómo decirlo aunque bodega y el destino del surtido incompleto ya
    // dependían de ese dato.)
    //
    // Oct 2026: la regla y sus mensajes viven en un solo lugar
    // (`pedidos/core/llegada-aviso.util.ts`). Antes estaban duplicados aquí y
    // en `kiosko-llegada.service.ts`, y ya habían divergido: el mismo estado
    // daba dos textos distintos según por dónde avisara el cliente.
    const motivo = motivoNoAvisable(pedido);
    if (motivo) throw new BadRequestException(motivo.message);

    return this.kioskoLlegada.confirmarDesdeCliente(pedidoId);
  }
}
