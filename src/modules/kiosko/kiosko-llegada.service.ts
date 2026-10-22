import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  HttpException,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { KioskoService } from './kiosko.service';
import { LimiteIntentosLlegada, telefonoCoincide } from './kiosko-llegada-intentos';
import { etiquetaDelPedido, interpretarFolio } from '../pedidos/core/folio-erp.util';
import { RealtimeService } from '../realtime/realtime.service';
import { firmarLlegoQr, verificarLlegoQr } from '../pedidos/core/qr-llegada.util';
import { motivoNoAvisable, evaluarAviso } from '../pedidos/core/llegada-aviso.util';
import { clientePresenteEnTienda, whereAusente } from '../pedidos/core/presencia.util';
import { estadoPedidoLabel } from '../mail/estado-labels';
import { CanalLlegada, EstadoPedido, ModoEntrega, Prisma } from '@prisma/client';
import type { UserContext } from '../../types/pedido.types';

/**
 * F22 (oct 2026): cuántas veces el mostrador puede descartar el aviso de UN
 * pedido antes de que el botón web deje de funcionar para él. A la segunda, un
 * cliente que avisa desde su teléfono sin estar en la tienda ya no se cree: solo
 * el kiosko (QR o folio, que exigen estar frente a la tablet) o el operador
 * pueden volver a marcar la llegada.
 */
export const MAX_DESCARTES_WEB = 2;

/**
 * F22: reacción que se corre cuando un aviso NUEVO queda registrado.
 *
 * Existe porque `KioskoModule` no puede importar `PedidosModule` (sería un ciclo:
 * `PedidosModule` ya importa `KioskoModule`) y la reacción necesita la máquina de
 * estados — p. ej. mover un pedido que esperaba aprobación al área de entrega
 * cuando el cliente llega. En vez de escribir el estado a mano aquí (la regla de
 * `CLAUDE.md` es "nunca escribas `estado` directo"), el módulo dueño de la máquina
 * se registra como oyente (`PresenciaService.onModuleInit`).
 */
export interface ReaccionLlegada {
  pedidoId: number;
  tiendaId: number;
  /** Estado en el que estaba el pedido cuando llegó el cliente. */
  estado: EstadoPedido;
  canal: CanalLlegada;
  /** Quién avisó: nombre del kiosko, del operador, o "App del cliente". */
  por: string;
  /** Solo cuando avisó un operador: para que la transición quede a su nombre. */
  usuario?: UserContext;
}

/**
 * Lo que necesitan las pantallas del kiosko de un pedido: la tienda (serie del folio), las líneas (el conteo de
 * artículos) y el teléfono del usuario (segundo factor del folio tecleado, ver `resolverPorFolioTecleado`).
 */
const INCLUDE_LLEGADA = {
  tienda: { select: { nombre: true, serie: true } },
  items: { select: { id: true } },
  usuario: { select: { telefono: true } },
} satisfies Prisma.PedidoInclude;

/**
 * PR7 (kiosko-profesional): flujo "avisar llegada a tienda".
 *
 * El cliente puede haber pedido desde web/app y llegar a recoger sin
 * celular, sin batería, o sin querer abrir la app. La tablet del kiosko
 * le ofrece DOS caminos:
 *
 *  1. Escanear un QR firmado con HMAC (que le llegó en el email de
 *     "listo para pagar" o que muestra en /perfil de la app).
 *  2. Teclear su folio (PD-2026-000123) en un teclado numérico grande.
 *
 * Ambos caminos llaman a este servicio (vía el controller público). El
 * resultado es una **señal de cola**: el pedido aparece en el mostrador
 * con badge "EN TIENDA" y chime, ordenado FIFO entre los que esperan.
 *
 * Decisiones de diseño que el lector pidió:
 *  - Endpoint PÚBLICO (sin auth) porque pedir identidad para avisar
 *    llegada es destruir el caso de uso ("llegó sin celular"). La
 *    seguridad está en: kioskoId + deviceToken validados; lookup
 *    acotado a la tienda del kiosko; rate limit por IP; idempotencia
 *    por pedido; y (B3, oct 2026) un segundo factor para todo folio
 *    TECLEADO: los últimos 4 dígitos del teléfono del pedido, con un tope
 *    de intentos por folio y por kiosko (`LimiteIntentosLlegada`). El QR
 *    firmado no lo necesita: la firma es la prueba.
 *  - NO se agrega `un estado al enum. La llegada es ortogonal al
 *    ciclo de vida del pedido (puede ocurrir en EN_REVISION,
 *    PENDIENTE_PAGO, PAID, SHIPPED). En su lugar, columnas.
 *  - Idempotencia (F22): mientras el cliente YA esté presente, avisar de nuevo
 *    no hace nada (ni escribe ni suena el chime). Antes se re-emitía cada 60 s
 *    y el cliente podía hacer sonar la TV a voluntad. Solo se puede volver a
 *    avisar después de que el mostrador descartó el aviso.
 *  - Validar que el kiosko tiene deviceToken (PR2) — sin él, no se
 *    acepta el aviso.
 */
@Injectable()
export class KioskoLlegadaService {
  private readonly logger = new Logger(KioskoLlegadaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kioskoService: KioskoService,
    private readonly realtime: RealtimeService,
    private readonly config: ConfigService,
    // `@Optional()`: no es un provider (es estado de proceso, no una dependencia); Nest inyecta `undefined` y
    // aplica el valor por defecto. Los specs lo pasan con un reloj falso.
    @Optional() private readonly intentos: LimiteIntentosLlegada = new LimiteIntentosLlegada(),
  ) {}

  private getSecret(): string {
    // Validado al arranque en main.ts; no debería ser null aquí.
    return this.config.get<string>('app.kioskoQrSecret')!;
  }

  /**
   * Resuelve un QR o folio a un pedido. NO escribe nada — sirve para
   * la pantalla "¿es este tu pedido?" antes de confirmar.
   *
   * Devuelve un DTO mínimo (nombre parcial, # artículos, total,
   * estado, yaAvisado) para evitar leak de PII en pantalla compartida.
   */
  async consultar(input: {
    kioskoId: number;
    kioskoTiendaId: number;
    deviceToken: string;
    qr?: string;
    folio?: string;
    /** Últimos 4 dígitos del teléfono: obligatorios cuando se manda `folio` (ver `resolverPedido`). */
    telefono4?: string;
  }): Promise<{
    pedidoId: number;
    folioVisible: string;
    clienteNombreParcial: string;
    itemsResumen: string;
    total: number;
    estado: EstadoPedido;
    estadoLabel: string;
    yaAvisado: boolean;
  }> {
    await this.validarKiosko(input.kioskoId, input.kioskoTiendaId, input.deviceToken);
    const pedido = await this.resolverPedido(input);
    return this.toConsultarDto(pedido);
  }

  /**
   * Confirma el aviso. Setea/actualiza las columnas `llegada*`,
   * emite realtime `pedido.llegada-anunciada` al room tienda-{id} +
   * pedido-{id} (este último para que el cliente lo vea en su app).
   *
   * Idempotente (F22): si el cliente YA está presente, devuelve el mismo
   * payload con `reanudado: false` y NO escribe ni emite nada. Solo un aviso
   * nuevo (el primero, o el primero tras un descarte) emite realtime.
   */
  async confirmar(input: {
    kioskoId: number;
    kioskoTiendaId: number;
    kioskoNombre: string;
    deviceToken: string;
    qr?: string;
    folio?: string;
    telefono4?: string;
  }): Promise<{
    ok: true;
    pedidoId: number;
    folioVisible: string;
    clienteNombreParcial: string;
    estado: EstadoPedido;
    estadoLabel: string;
    mensaje: string;
    reanudado: boolean;
    esperandoDesdeMin: number;
  }> {
    await this.validarKiosko(input.kioskoId, input.kioskoTiendaId, input.deviceToken);
    const pedido = await this.resolverPedido(input);

    this.exigirAvisable(pedido);

    const canal: CanalLlegada = input.qr ? CanalLlegada.QR : CanalLlegada.FOLIO;
    const resultado = await this.registrarAviso(pedido, {
      canal,
      por: input.kioskoNombre,
      kioskoId: input.kioskoId,
    });

    return {
      ...this.toConfirmarDto(pedido),
      mensaje: !resultado.reanudado
        ? 'Ya avisamos al equipo. Te atenderemos pronto.'
        : this.mensajeParaEstado(pedido.estado),
      reanudado: resultado.reanudado,
      esperandoDesdeMin: resultado.esperandoDesdeMin,
    };
  }

  /**
   * Oct 2026: el operador de mostrador marca la llegada EN NOMBRE del cliente.
   *
   * Caso de uso que lo motiva: hay clientes que llegan a tienda y van directo
   * al mostrador, sin teléfono a la mano o sin el folio. Con el gate de D5 su
   * pedido web está OCULTO de la cola hasta que alguien avisa — así que sin
   * esta acción el operador no tenía forma de hacerlo aparecer, y el pedido
   * quedaba atorado aunque el cliente estuviera enfrente.
   *
   * Escribe `CanalLlegada.MOSTRADOR`, el valor que el enum reserva desde PR7 y
   * que hasta ahora nunca se usaba. `llegadaAnunciadaPor` guarda el nombre del
   * operador (la columna es un snapshot de texto sin FK, pensada justo para
   * esto), y se registra en el historial para poder auditar cuántas llegadas
   * las activa el personal en vez del cliente.
   *
   * NO cambia el estado del pedido: la llegada es ortogonal al ciclo de vida.
   *
   * El caller (`MostradorService.marcarLlegada`) ya validó el acceso con
   * `PedidoAccessService.cargarYValidar`, que deja pasar a MOSTRADOR para
   * pedidos de su tienda y falla cerrado si el pedido es de otra. La validación
   * NO vive aquí porque `KioskoModule` no puede importar `PedidosModule`:
   * `PedidosModule` ya importa `KioskoModule`, así que sería un ciclo.
   */
  async confirmarDesdeMostrador(pedidoId: number, usuario: UserContext) {
    const completo = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: { tienda: { select: { nombre: true, serie: true } } },
    });
    if (!completo) throw new NotFoundException('Pedido no encontrado');

    // Oct 2026: la regla del OPERADOR, no la del cliente. Antes se usaba
    // `exigirAvisable`, que solo dejaba pasar `REVISADO` — así que si el
    // cliente llegaba y su pedido todavía estaba en bodega, esperando aprobar
    // una propuesta o en caja, el operador recibía un 409 y se quedaba sin
    // salida con el cliente enfrente.
    const evaluacion = evaluarAviso(completo, 'OPERADOR');
    if (!evaluacion.puede) {
      throw new ConflictException({
        codigo: evaluacion.codigo,
        message: evaluacion.message,
      });
    }

    const resultado = await this.registrarAviso(completo, {
      canal: CanalLlegada.MOSTRADOR,
      por: usuario.nombre,
      kioskoId: null,
      usuario,
    });

    // F22: el historial y el realtime solo cuando el aviso es NUEVO. Con el
    // cliente ya presente (un pedido de kiosko, o un web con aviso vigente)
    // marcar la llegada no cambia nada, y escribir una fila por cada toque del
    // botón llenaba la auditoría de avisos que no avisaban de nada.
    if (resultado.reanudado) {
      // Mismo patrón que `MostradorService.llamar` y `.descartarLlegada`:
      // historial sin cambio de estado, para que la acción quede auditable. Se
      // anota el estado en que se marcó: se puede marcar antes de que el pedido
      // esté listo, y hace falta poder auditar cuántas llegadas se registran por
      // adelantado.
      await this.prisma.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: completo.estado,
          estadoNuevo: completo.estado,
          observacion: `Llegada marcada por ${usuario.nombre} desde mostrador`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      // La consola y la TV tienen que recomputar: el pedido acaba de entrar a la
      // cola visible (si venía de "sin aviso") o de refrescar su badge EN TIENDA.
      this.realtime.emitToTienda(completo.tiendaId, 'monitor.invalidado', {
        pedidoId,
      });
      // Oct 2026: si el pedido NO está en mostrador, las consolas que necesitan
      // enterarse son las que tienen el pedido en sus manos — bodega (hay que
      // surtirlo ya) o ventas (el asesor tiene que atender al cliente que está
      // esperando de pie). `monitor.invalidado` no lo escuchan.
      //
      // Se emite el MISMO evento de llegada que ya existe, para no inventar un
      // nombre nuevo que un typo podría dejar en silencio. El payload lleva
      // `canal` y `canalOrigen` para que cada consola distinga el caso.
      if (!evaluacion.entraACola) {
        this.realtime.emitToTienda(completo.tiendaId, 'pedido.llegada-anunciada', {
          pedidoId,
          numeroPedido: completo.numeroPedido,
          folioVisible: etiquetaDelPedido(completo, completo.tienda?.serie),
          clienteNombre: completo.clienteNombre,
          estado: completo.estado,
          canal: CanalLlegada.MOSTRADOR,
          canalOrigen: completo.canalOrigen,
          esperandoDesdeMin: resultado.esperandoDesdeMin,
          tienda: completo.tienda?.nombre,
        });
      }
    }

    this.logger.log(
      `Pedido ${pedidoId} (${completo.numeroPedido}): llegada marcada por ${usuario.nombre} desde mostrador (estado ${completo.estado}, entraACola=${evaluacion.entraACola})`,
    );

    return {
      ok: true as const,
      pedidoId,
      folioVisible: etiquetaDelPedido(completo, completo.tienda?.serie),
      reanudado: resultado.reanudado,
      esperandoDesdeMin: resultado.esperandoDesdeMin,
      /**
       * `true` si el pedido ya está en la cola del mostrador. El frontend lo usa
       * para elegir el copy: "ya está en la cola" vs. "avisamos a bodega".
       */
      entraACola: evaluacion.entraACola,
    };
  }

  /**
   * Guard ��nico de "¿este pedido ya se puede avisar en tienda?".
   *
   * Oct 2026: la regla vivía duplicada aquí y en `cliente.service.ts`, con
   * mapas de mensajes que ya habían divergido. Ahora vive en
   * `pedidos/core/llegada-aviso.util.ts` y las tres superficies (kiosko, app
   * del cliente, mostrador) comparten el mismo texto.
   */
  private exigirAvisable(pedido: { estado: EstadoPedido; modoEntrega: ModoEntrega }): void {
    const motivo = motivoNoAvisable(pedido);
    if (motivo) throw new ConflictException(motivo);
  }

  /**
   * Oyentes de "llegó un cliente" (ver `ReaccionLlegada`). Se registran al
   * arrancar; el aviso ya está guardado cuando corren, así que un fallo NO lo
   * deshace.
   */
  private readonly reacciones: Array<(r: ReaccionLlegada) => Promise<void>> = [];

  registrarReaccion(fn: (r: ReaccionLlegada) => Promise<void>): void {
    this.reacciones.push(fn);
  }

  /**
   * Escritura compartida del aviso: presencia, límite de descartes y realtime.
   *
   * Oct 2026: este bloque estaba copiado en `confirmar` y en
   * `confirmarDesdeCliente` (dos veces ~90 líneas casi idénticas), y el tercer
   * camino —mostrador— habría sido una tercera copia. Se parametrizó el canal,
   * el autor y el kiosko, que era lo único que cambiaba.
   *
   * F22 (oct 2026) — reescrita sobre una regla simple: **mientras el cliente
   * esté presente, avisar de nuevo no hace nada.**
   *
   * Antes había una ventana de 60 s, un tope de 5 avisos por 10 min y una columna
   * de "última emisión" para sostenerlos, y aun así el botón "Avisar de nuevo" de
   * la app hacía sonar el chime del mostrador cada minuto. Todo eso existía para
   * contener un re-aviso que ahora simplemente no ocurre. Un aviso nuevo solo es
   * posible cuando NO hay uno vigente: la primera vez, o después de que el
   * mostrador lo descartó (porque el cliente no estaba).
   *
   * Y un aviso nuevo REINICIA la espera (`llegadaAnunciadaAt` y `presenteDesdeAt`
   * = ahora). Antes conservaba la hora del primer aviso: el cliente que avisó
   * por error a las 10:00, fue descartado, y volvió de verdad a las 12:00,
   * heredaba el lugar de las 10:00 (se colaba delante de todos) y la consola le
   * pintaba "EN TIENDA · 120 min".
   */
  private async registrarAviso(
    pedido: {
      id: number;
      tiendaId: number;
      numeroPedido: string;
      folioErp?: string | null;
      clienteNombre: string;
      estado: EstadoPedido;
      canalOrigen: string;
      fechaPedido: Date;
      llegadaAnunciadaAt: Date | null;
      llegadaDescartadaAt: Date | null;
      llegadaDescartes: number;
      presenteDesdeAt: Date | null;
      tienda?: { nombre: string; serie?: string | null };
    },
    opts: {
      canal: CanalLlegada;
      por: string;
      kioskoId: number | null;
      usuario?: UserContext;
    },
  ): Promise<{
    /**
     * El aviso es NUEVO (se escribió y se emitió). `false` cuando el cliente ya
     * estaba presente: no pasó nada y no se hace ruido.
     *
     * Es el flag que elige el copy: con `false` el cliente ve "Ya avisamos al
     * equipo" en vez del mensaje del estado, porque no pasó nada nuevo. El
     * contrato lo fijan los specs de `kiosko-llegada.service.spec.ts`.
     */
    reanudado: boolean;
    esperandoDesdeMin: number;
  }> {
    const now = new Date();

    if (clientePresenteEnTienda(pedido)) {
      const desde = pedido.presenteDesdeAt ?? pedido.llegadaAnunciadaAt ?? pedido.fechaPedido;
      return { reanudado: false, esperandoDesdeMin: this.minutosDesde(desde, now) };
    }

    // El botón web se cierra tras `MAX_DESCARTES_WEB` descartes. El kiosko y el
    // operador NO: ahí hay alguien (o una tablet) en la tienda que lo avala.
    if (opts.canal === CanalLlegada.WEB && pedido.llegadaDescartes >= MAX_DESCARTES_WEB) {
      throw new ConflictException({
        codigo: 'AVISO_BLOQUEADO',
        message:
          'El mostrador no te encontró las veces anteriores. Para avisar tu llegada, ' +
          'pasa por el kiosko de la tienda o dile al operador de mostrador.',
      });
    }

    // Escritura con guarda atómica: solo si el pedido sigue SIN presencia. Dos
    // avisos simultáneos (la app y el kiosko, o un doble toque) leen "ausente" a
    // la vez; sin la guarda los dos escribirían y emitirían.
    const escrito = await this.prisma.pedido.updateMany({
      where: { id: pedido.id, ...whereAusente() },
      data: {
        llegadaAnunciadaAt: now,
        presenteDesdeAt: now,
        llegadaUltimoAvisoAt: now,
        llegadaUltimaEmisionAt: now,
        llegadaAnunciadaCount: { increment: 1 },
        llegadaAnunciadaCanal: opts.canal,
        llegadaAnunciadaKioskoId: opts.kioskoId,
        llegadaAnunciadaPor: opts.por,
        // Si estaba descartado, lo resucitamos (otro intento legítimo).
        llegadaDescartadaAt: null,
        llegadaDescartadaPorId: null,
      },
    });
    if (escrito.count !== 1) {
      return { reanudado: false, esperandoDesdeMin: 0 };
    }

    this.realtime.emitToTienda(pedido.tiendaId, 'pedido.llegada-anunciada', {
      pedidoId: pedido.id,
      numeroPedido: pedido.numeroPedido,
      folioVisible: etiquetaDelPedido(pedido, pedido.tienda?.serie),
      clienteNombre: pedido.clienteNombre,
      estado: pedido.estado,
      kioskoId: opts.kioskoId,
      kioskoNombre: opts.por,
      canal: opts.canal,
      llegadaAnunciadaAt: now,
      esperandoDesdeMin: 0,
      tienda: pedido.tienda?.nombre,
    });
    // También al room del pedido (para que el cliente en su app lo vea).
    this.realtime.emitToPedido(pedido.id, 'pedido.llegada-anunciada', {
      pedidoId: pedido.id,
      numeroPedido: pedido.numeroPedido,
      esperandoDesdeMin: 0,
    });

    for (const reaccion of this.reacciones) {
      try {
        await reaccion({
          pedidoId: pedido.id,
          tiendaId: pedido.tiendaId,
          estado: pedido.estado,
          canal: opts.canal,
          por: opts.por,
          usuario: opts.usuario,
        });
      } catch (err) {
        // El aviso ya quedó guardado: un fallo de la reacción no lo deshace.
        this.logger.warn(
          `Pedido ${pedido.id}: el aviso se registró pero la reacción falló (${(err as Error).message})`,
        );
      }
    }

    return { reanudado: true, esperandoDesdeMin: 0 };
  }

  /** Minutos completos transcurridos desde `desde` hasta `hasta`. */
  private minutosDesde(desde: Date, hasta: Date): number {
    return Math.max(0, Math.floor((hasta.getTime() - desde.getTime()) / 60_000));
  }

  /**
   * Genera un token QR firmado para un pedido. Lo llama el endpoint
   * autenticado (web/app) que muestra el QR en el detalle del pedido
   * y/o lo manda por email. Multiuso (ver comentario en qr-llegada.util).
   */
  async generarQrParaPedido(pedidoId: number): Promise<{ qr: string; numeroPedido: string }> {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { id: true, tiendaId: true, numeroPedido: true, usuarioId: true },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    return {
      qr: firmarLlegoQr(pedido.id, pedido.tiendaId, this.getSecret()),
      numeroPedido: pedido.numeroPedido,
    };
  }

  /**
   * PR7: avisar llegada desde la app del cliente autenticado.
   * Mismo path que el kiosko pero sin requerir X-Kiosko-Id/Token.
   * El service de cliente ya validó que el pedido es del usuario.
   */
  async confirmarDesdeCliente(pedidoId: number) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: { tienda: { select: { nombre: true, serie: true } } },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');

    const resultado = await this.registrarAviso(pedido, {
      canal: CanalLlegada.WEB,
      por: 'App del cliente',
      kioskoId: null,
    });

    return {
      ok: true as const,
      pedidoId: pedido.id,
      folioVisible: etiquetaDelPedido(pedido, pedido.tienda?.serie),
      mensaje: !resultado.reanudado
        ? 'Ya avisamos al equipo. Te atenderemos pronto.'
        : this.mensajeParaEstado(pedido.estado),
      reanudado: resultado.reanudado,
      esperandoDesdeMin: resultado.esperandoDesdeMin,
    };
  }

  /**
   * Valida que el QR/folio resuelve a un pedido. Helper privado.
   * Aplica la lógica de "pertenece a la tienda del kiosko".
   *
   * - QR firmado: la firma es la prueba, no pide nada más.
   * - Folio tecleado: exige el segundo factor (B3), ver `resolverPorFolioTecleado`.
   */
  private async resolverPedido(input: {
    kioskoId: number;
    kioskoTiendaId: number;
    qr?: string;
    folio?: string;
    telefono4?: string;
  }) {
    if (input.qr) {
      const r = verificarLlegoQr(input.qr, this.getSecret());
      if (!r.valido || !r.pedidoId) {
        throw new NotFoundException({
          codigo: 'PEDIDO_NO_ENCONTRADO',
          message: 'No encontramos ese código. Revísalo en tu recibo o correo.',
        });
      }
      if (r.tiendaId !== input.kioskoTiendaId) {
        throw new ForbiddenException({
          codigo: 'OTRA_TIENDA',
          message: 'Ese pedido es de otra tienda.',
        });
      }
      const pedido = await this.prisma.pedido.findUnique({
        where: { id: r.pedidoId },
        // `items` es necesario: `toConsultarDto` cuenta los artículos para
        // el resumen de "¿es este tu pedido?". Sin el include, el conteo
        // caía al fallback y la pantalla mostraba "? artículos".
        include: INCLUDE_LLEGADA,
      });
      if (!pedido) {
        throw new NotFoundException({
          codigo: 'PEDIDO_NO_ENCONTRADO',
          message: 'No encontramos ese código.',
        });
      }
      return pedido;
    }

    if (input.folio) {
      return this.resolverPorFolioTecleado({ ...input, folio: input.folio });
    }

    throw new BadRequestException('Se requiere qr o folio');
  }

  /**
   * Oct 2026 (B3): un folio TECLEADO identifica el pedido SOLO junto con los últimos 4 dígitos del teléfono.
   *
   * Por qué: el folio del Sistema Comercial es consecutivo y público (sale en el ticket y, sus últimos 4 dígitos,
   * en la TV de pared). Con solo el folio, cualquiera frente a la tablet podía avisar la llegada de un pedido
   * ajeno y ver su nombre, artículos y total. B2 lo dejó dicho: "sigue sin segundo factor".
   *
   * Reglas:
   *  - Vale el folio completo con serie (`HMO-0000152573`), los 10 dígitos, o sin ceros (`152573`), y el
   *    `PD-…` interno. Antes (B2) un número corto NO se rellenaba porque era el único freno a que el turno de la
   *    TV resolviera OTRO pedido; ahora, aunque lo resuelva, sin el teléfono no pasa.
   *  - NINGÚN dato sale antes de verificar, y "el folio no existe", "el teléfono no coincide" y "el pedido no
   *    tiene teléfono" dan la MISMA respuesta: si no, el mensaje sería un oráculo de qué folios existen.
   *  - Tope de fallos por folio y por kiosko (`LimiteIntentosLlegada`): pasado el tope, 429 y a mostrador.
   */
  private async resolverPorFolioTecleado(input: {
    kioskoId: number;
    kioskoTiendaId: number;
    folio: string;
    telefono4?: string;
  }) {
    const folio = input.folio.trim();
    if (folio.length < 4) {
      throw new BadRequestException('Folio demasiado corto');
    }
    if (!input.telefono4 || !/^\d{4}$/.test(input.telefono4)) {
      throw new BadRequestException({
        codigo: 'FALTA_TELEFONO',
        message: 'Escribe los últimos 4 dígitos del teléfono con el que hiciste el pedido.',
      });
    }

    const f = interpretarFolio(folio);
    // La clave del contador es el folio NORMALIZADO que teclearon, no el pedido que resolvió: "no existe" y
    // "teléfono distinto" deben contar igual. La serie no entra: solo acota, y variarla no debe reiniciar el tope.
    const clave = f ? f.folio : folio.toUpperCase();

    if (this.intentos.bloqueado(input.kioskoId, clave)) {
      this.logger.warn(
        `Kiosko ${input.kioskoId}: aviso por folio bloqueado por exceso de intentos fallidos`,
      );
      throw new HttpException(
        {
          codigo: 'DEMASIADOS_INTENTOS',
          message: 'Demasiados intentos. Pasa a mostrador y te ayudamos.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const pedido = await this.buscarPorFolio(folio, f, input.kioskoTiendaId);
    if (
      pedido &&
      telefonoCoincide(input.telefono4, pedido.clienteTelefono, pedido.usuario?.telefono)
    ) {
      this.intentos.registrarAcierto(input.kioskoId, clave);
      return pedido;
    }

    this.intentos.registrarFallo(input.kioskoId, clave);
    throw new NotFoundException({
      codigo: 'PEDIDO_NO_VERIFICADO',
      message:
        'No pudimos confirmar ese pedido. Revisa el folio y los últimos 4 dígitos del teléfono con el que pediste; ' +
        'si no lo logras, pasa a mostrador y te ayudamos.',
    });
  }

  /** Busca por número interno, por folio del ERP y, por último, por el folio que guardó la bandeja de envío. */
  private async buscarPorFolio(
    folio: string,
    f: ReturnType<typeof interpretarFolio>,
    tiendaId: number,
  ) {
    // Buscar primero por numeroPedido (PD-2026-000123 es @unique).
    let pedido = await this.prisma.pedido.findFirst({
      where: { numeroPedido: folio, tiendaId },
      include: INCLUDE_LLEGADA,
    });
    if (!pedido && f) {
      // El FOLIO del Sistema Comercial. SIEMPRE dentro de la tienda del kiosko: el mismo número existe en cada una.
      pedido = await this.prisma.pedido.findFirst({
        where: {
          folioErp: f.folio,
          tiendaId,
          ...(f.serie ? { tienda: { serie: f.serie } } : {}),
        },
        include: INCLUDE_LLEGADA,
      });
    }
    if (!pedido) {
      // Fallback: externalFolio (folio de Firebird, asignado tras el ACK del agente).
      const pendiente = await this.prisma.pedidoPendienteEnvio.findFirst({
        where: { externalFolio: folio, pedido: { tiendaId } },
        include: { pedido: { include: INCLUDE_LLEGADA } },
      });
      pedido = pendiente?.pedido ?? null;
    }
    return pedido;
  }

  private async validarKiosko(
    kioskoId: number,
    kioskoTiendaId: number,
    deviceToken: string,
  ): Promise<void> {
    const valido = await this.kioskoService.validarDeviceToken(kioskoId, deviceToken);
    if (!valido) {
      throw new UnauthorizedException('X-Kiosko-Token inválido o kiosko sin token');
    }
    // Verificar que el kiosko pertenece a la tienda del header (defensa
    // contra spoofing del header X-Tienda-Id).
    const kiosko = await this.prisma.kiosko.findUnique({
      where: { id: kioskoId },
      select: { tiendaId: true, estado: true },
    });
    if (!kiosko || kiosko.tiendaId !== kioskoTiendaId || kiosko.estado !== 'ACTIVO') {
      throw new ForbiddenException('Kiosko no válido para esta tienda');
    }
  }

  private toConsultarDto(pedido: any) {
    const total = Number(pedido.total ?? 0);
    return {
      pedidoId: pedido.id,
      folioVisible: etiquetaDelPedido(pedido, pedido.tienda?.serie),
      clienteNombreParcial: nombreParcial(pedido.clienteNombre),
      itemsResumen: `${pedido.items?.length ?? '?'} artículos`,
      total,
      estado: pedido.estado,
      estadoLabel: this.labelParaEstado(pedido.estado),
      // F22: "ya avisó" = el cliente ya está presente (para un kiosko, siempre,
      // salvo que el mostrador lo haya descartado).
      yaAvisado: clientePresenteEnTienda(pedido),
    };
  }

  private toConfirmarDto(pedido: any) {
    return {
      ok: true as const,
      pedidoId: pedido.id,
      folioVisible: etiquetaDelPedido(pedido, pedido.tienda?.serie),
      clienteNombreParcial: nombreParcial(pedido.clienteNombre),
      estado: pedido.estado,
      estadoLabel: this.labelParaEstado(pedido.estado),
    };
  }

  private labelParaEstado(estado: EstadoPedido): string {
    // Fuente única: `mail/estado-labels.ts`. Antes había un mapa local que
    // decía reutilizar las etiquetas pero en realidad las duplicaba, y ya
    // divergían (REVISADO salía "Listo en tienda" aquí y "Listo en tienda ·
    // revísalo" en el correo). El cliente veía dos vocabularios para el mismo
    // paso según dónde mirara.
    return estadoPedidoLabel(estado);
  }

  private mensajeParaEstado(estado: EstadoPedido): string {
    if (
      estado === EstadoPedido.SOLICITADO ||
      estado === EstadoPedido.EN_REVISION ||
      estado === EstadoPedido.ENVIADO
    ) {
      return 'Listo, ya avisamos al equipo. Tu pedido sigue en preparación.';
    }
    if (estado === EstadoPedido.ESPERANDO_APROBACION) {
      // F22: avisar llegada con una propuesta pendiente mueve el pedido al área
      // de entrega: el operador la resuelve con el cliente enfrente.
      return 'Ya avisamos al equipo. Pasa a mostrador: ahí resolverán contigo la propuesta de tu pedido.';
    }
    if (estado === EstadoPedido.EN_ASESORIA) {
      return 'Ya avisamos al equipo. Un asesor te atenderá.';
    }
    // F16 (sep 2026): el pedido está apartado esperando que el cliente lo
    // revise. No es un error de compilación (esta función es una cadena de
    // `if` con fallback), pero sin este caso el cliente recibiría el copy
    // genérico justo cuando más necesita saber qué sigue.
    if (estado === EstadoPedido.REVISADO) {
      return '¡Listo! Ya avisamos al equipo. Pasa a mostrador a revisar tu pedido.';
    }
    if (estado === EstadoPedido.PENDIENTE_PAGO) {
      return 'Ya avisamos al equipo. Pasa a caja a pagar.';
    }
    if (estado === EstadoPedido.PAGADO) {
      return '¡Listo, ya avisamos al equipo! Te llamaremos por tu nombre.';
    }
    return 'Listo, ya avisamos al equipo.';
  }
}

/** "Juan Pérez García" → "Juan P." Reduce PII expuesta en tablet compartida. */
function nombreParcial(nombre: string | null | undefined): string {
  if (!nombre) return '';
  const parts = nombre.trim().split(/\s+/);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1][0]}.`;
}
