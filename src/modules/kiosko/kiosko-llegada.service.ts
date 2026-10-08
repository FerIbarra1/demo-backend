import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { KioskoService } from './kiosko.service';
import { RealtimeService } from '../realtime/realtime.service';
import { firmarLlegoQr, verificarLlegoQr, tokenEsDeTienda } from '../pedidos/core/qr-llegada.util';
import { motivoNoAvisable, evaluarAviso } from '../pedidos/core/llegada-aviso.util';
import { estadoPedidoLabel } from '../mail/estado-labels';
import { CanalLlegada, EstadoPedido, ModoEntrega, Prisma } from '@prisma/client';
import type { UserContext } from '../../types/pedido.types';

const THROTTLE_WINDOW_MS = 60_000;
/**
 * F16 (sep 2026): tope de avisos que emiten realtime SIN esperar la ventana de
 * reintento. Pasado el tope, el aviso sigue funcionando pero solo re-emite cada
 * `REINTENTO_WINDOW_MS`.
 */
const MAX_AVISOS_POR_PEDIDO = 5;
/**
 * F16: ventana tras la cual un pedido que agotó el tope puede volver a emitir.
 *
 * Antes el tope era de POR VIDA: `llegadaAnunciadaCount` se incrementaba y
 * nunca se reiniciaba, así que tras 5 avisos el pedido dejaba de emitir
 * realtime PARA SIEMPRE. Era un adorno cuando la llegada solo pintaba un badge;
 * con el gate de D5 (un pedido web NO aparece en mostrador hasta que el cliente
 * avisa) el bug se vuelve real: si el operador descarta el aviso y el cliente
 * vuelve a avisar, el pedido reaparece en la cola por el polling pero SIN la
 * alerta en la TV — el operador no se entera de que hay alguien esperando.
 *
 * Convertirlo en límite de tasa (en vez de tope de por vida) arregla el caso
 * sin necesidad de una columna nueva: `llegadaUltimoAvisoAt` ya existe.
 */
const REINTENTO_WINDOW_MS = 10 * 60_000;

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
 *    por pedido; segundo factor (últimos 4 del teléfono) recomendado
 *    en producción pero fuera de este MVP.
 *  - NO se agrega `un estado al enum. La llegada es ortogonal al
 *    ciclo de vida del pedido (puede ocurrir en EN_REVISION,
 *    PENDIENTE_PAGO, PAID, SHIPPED). En su lugar, columnas.
 *  - Idempotencia: avisar 2 veces en <60s devuelve el mismo payload
 *    sin re-emit realtime (no spam en mostrador).
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
   * Idempotente: si el último aviso fue hace <60s, devuelve el mismo
   * payload con `reanudado: false`. Si pasaron >60s, actualiza
   * ultimoAvisoAt + count + emite realtime.
   */
  async confirmar(input: {
    kioskoId: number;
    kioskoTiendaId: number;
    kioskoNombre: string;
    deviceToken: string;
    qr?: string;
    folio?: string;
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
      include: { tienda: { select: { nombre: true } } },
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
    });

    // Mismo patrón que `MostradorService.llamar` y `.descartarLlegada`:
    // historial sin cambio de estado, para que la acción quede auditable. Se
    // anota el estado en que se marcó: con la regla nueva se puede marcar antes
    // de que el pedido esté listo, y hace falta poder auditar cuántas llegadas
    // se registran por adelantado.
    await this.prisma.historialPedido.create({
      data: {
        pedidoId,
        estadoAnterior: completo.estado,
        estadoNuevo: completo.estado,
        observacion: `Llegada marcada por ${usuario.nombre} desde mostrador (pedido en ${completo.estado})`,
        usuarioId: usuario.userId,
        usuarioNombre: usuario.nombre,
      },
    });

    // La consola y la TV tienen que recomputar: el pedido acaba de entrar a la
    // cola visible (si venía de "sin aviso") o de refrescar su badge EN TIENDA.
    //
    // Solo cuando el aviso se re-emitió. Si el guard de idempotencia lo
    // suprimió, el estado no cambió y no hay nada que recomputar — invalidar
    // sería un refetch gratis en cada toque repetido del botón.
    if (resultado.reanudado) {
      this.realtime.emitToTienda(completo.tiendaId, 'monitor.invalidado', {
        pedidoId,
      });
      // Oct 2026: si el pedido NO est�� en mostrador, las consolas que necesitan
      // enterarse son las que tienen el pedido en sus manos — bodega (hay que
      // surtirlo ya) o ventas (el asesor tiene que atender al cliente que está
      // esperando de pie). `monitor.invalidado` no lo escuchan.
      //
      // Se emite el MISMO evento de llegada que ya existe, para no inventar un
      // nombre nuevo que un typo podría dejar en silencio. El payload lleva
      // `canal` y `canalOrigen` para que cada consola distinga el caso: un
      // pedido de KIOSKO ya estaba en tienda por definición, uno de WEB con
      // llegada es el evento que importa.
      if (!evaluacion.entraACola) {
        this.realtime.emitToTienda(completo.tiendaId, 'pedido.llegada-anunciada', {
          pedidoId,
          numeroPedido: completo.numeroPedido,
          folioVisible: completo.numeroPedido,
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
      folioVisible: completo.numeroPedido,
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
   * Escritura compartida del aviso: idempotencia, límite de tasa, columnas
   * `llegada*` y emisión de realtime.
   *
   * Oct 2026: este bloque estaba copiado en `confirmar` y en
   * `confirmarDesdeCliente` (dos veces ~90 líneas casi idénticas), y el tercer
   * camino —mostrador— habría sido una tercera copia. Se parametrizó el canal,
   * el autor y el kiosko, que era lo único que cambiaba.
   */
  private async registrarAviso(
    pedido: {
      id: number;
      tiendaId: number;
      numeroPedido: string;
      clienteNombre: string;
      estado: EstadoPedido;
      llegadaAnunciadaAt: Date | null;
      llegadaUltimoAvisoAt: Date | null;
      llegadaAnunciadaCount: number;
      llegadaUltimaEmisionAt: Date | null;
      llegadaDescartadaAt: Date | null;
      tienda?: { nombre: string };
    },
    opts: { canal: CanalLlegada; por: string; kioskoId: number | null },
  ): Promise<{
    /**
     * El aviso se RE-EMITIÓ. `false` cuando el guard de idempotencia de 60s lo
     * suprimió porque era el mismo aviso otra vez (sin descarte de por medio).
     *
     * Es el flag que elige el copy: con `false` el cliente ve "Ya avisamos al
     * equipo" en vez del mensaje del estado, porque no pasó nada nuevo. El
     * contrato lo fijan los specs de `kiosko-llegada.service.spec.ts`.
     */
    reanudado: boolean;
    esperandoDesdeMin: number;
  }> {
    const now = new Date();

    // Idempotencia: si avisó hace <60s, no re-emitimos (no spam en mostrador).
    // F16: un aviso DESCARTADO por el operador se puede volver a mandar de
    // inmediato — el descarte lo hizo porque el cliente no estaba, así que
    // hacerlo esperar la ventana lo dejaría sin forma de re-avisar.
    const ultimo = pedido.llegadaUltimoAvisoAt;
    const isFresh = ultimo !== null && now.getTime() - ultimo.getTime() < THROTTLE_WINDOW_MS;
    const descartado = pedido.llegadaDescartadaAt !== null;
    if (pedido.llegadaAnunciadaAt && isFresh && !descartado) {
      return {
        reanudado: false,
        esperandoDesdeMin: this.minutosDesde(pedido.llegadaAnunciadaAt, now),
      };
    }

    // F16: el tope es un LÍMITE DE TASA, no un tope de por vida. Pasado
    // `REINTENTO_WINDOW_MS` desde la última EMISIÓN, el contador se reinicia y
    // el pedido vuelve a emitir. Sin esto, un cliente que avisa 6 veces deja su
    // pedido sin alerta en la TV para siempre (bug B2 del plan).
    //
    // El ancla es `llegadaUltimaEmisionAt`, NO `llegadaUltimoAvisoAt`: este
    // último se reescribe en cada request, así que un cliente que insistía más
    // seguido que la ventana nunca la cumplía y su pedido quedaba sin alerta
    // indefinidamente.
    const agotoTope = pedido.llegadaAnunciadaCount >= MAX_AVISOS_POR_PEDIDO;
    const ultimaEmision = pedido.llegadaUltimaEmisionAt;
    const pasoLaVentana =
      ultimaEmision === null || now.getTime() - ultimaEmision.getTime() >= REINTENTO_WINDOW_MS;
    const nuevoCount = agotoTope && pasoLaVentana ? 1 : pedido.llegadaAnunciadaCount + 1;
    const debeEmitir = nuevoCount <= MAX_AVISOS_POR_PEDIDO;

    const actualizado = await this.prisma.pedido.update({
      where: { id: pedido.id },
      data: {
        llegadaAnunciadaAt: pedido.llegadaAnunciadaAt ?? now,
        llegadaUltimoAvisoAt: now,
        llegadaAnunciadaCount: nuevoCount,
        // Solo se mueve el ancla cuando REALMENTE se emite: si el aviso se
        // suprime, la ventana tiene que seguir corriendo desde la última
        // emisión real.
        ...(debeEmitir ? { llegadaUltimaEmisionAt: now } : {}),
        llegadaAnunciadaCanal: opts.canal,
        llegadaAnunciadaKioskoId: opts.kioskoId,
        llegadaAnunciadaPor: opts.por,
        // Si estaba descartado, lo resucitamos (otro intento legítimo).
        llegadaDescartadaAt: null,
        llegadaDescartadaPorId: null,
      },
    });

    const esperandoDesdeMin = this.minutosDesde(actualizado.llegadaAnunciadaAt ?? now, now);

    if (debeEmitir) {
      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.llegada-anunciada', {
        pedidoId: pedido.id,
        numeroPedido: pedido.numeroPedido,
        folioVisible: pedido.numeroPedido,
        clienteNombre: pedido.clienteNombre,
        estado: pedido.estado,
        kioskoId: opts.kioskoId,
        kioskoNombre: opts.por,
        canal: opts.canal,
        llegadaAnunciadaAt: actualizado.llegadaAnunciadaAt,
        esperandoDesdeMin,
        tienda: pedido.tienda?.nombre,
      });
      // También al room del pedido (para que el cliente en su app lo vea).
      this.realtime.emitToPedido(pedido.id, 'pedido.llegada-anunciada', {
        pedidoId: pedido.id,
        numeroPedido: pedido.numeroPedido,
        esperandoDesdeMin,
      });
    }

    return {
      reanudado: true,
      esperandoDesdeMin,
    };
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
      include: { tienda: { select: { nombre: true } } },
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
      folioVisible: pedido.numeroPedido,
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
   */
  private async resolverPedido(input: { kioskoTiendaId: number; qr?: string; folio?: string }) {
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
        include: {
          tienda: { select: { nombre: true } },
          items: { select: { id: true } },
        },
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
      const folio = input.folio.trim();
      if (folio.length < 4) {
        throw new BadRequestException('Folio demasiado corto');
      }
      // Buscar primero por numeroPedido (PD-2026-000123 es @unique).
      let pedido = await this.prisma.pedido.findFirst({
        where: {
          numeroPedido: folio,
          tiendaId: input.kioskoTiendaId,
        },
        include: {
          tienda: { select: { nombre: true } },
          items: { select: { id: true } },
        },
      });
      if (!pedido) {
        // Fallback: externalFolio (folio de Firebird, asignado tras
        // el ACK del agente). El índice parcial se creó en esta misma
        // migración.
        const pendiente = await this.prisma.pedidoPendienteEnvio.findFirst({
          where: { externalFolio: folio, pedido: { tiendaId: input.kioskoTiendaId } },
          include: {
            pedido: {
              include: {
                tienda: { select: { nombre: true } },
                items: { select: { id: true } },
              },
            },
          },
        });
        pedido = pendiente?.pedido ?? null;
      }
      if (!pedido) {
        throw new NotFoundException({
          codigo: 'PEDIDO_NO_ENCONTRADO',
          message: 'No encontramos ese folio. Revísalo en tu recibo o correo.',
        });
      }
      return pedido;
    }

    throw new BadRequestException('Se requiere qr o folio');
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
      folioVisible: pedido.numeroPedido,
      clienteNombreParcial: nombreParcial(pedido.clienteNombre),
      itemsResumen: `${pedido.items?.length ?? '?'} artículos`,
      total,
      estado: pedido.estado,
      estadoLabel: this.labelParaEstado(pedido.estado),
      yaAvisado: Boolean(pedido.llegadaAnunciadaAt),
    };
  }

  private toConfirmarDto(pedido: any) {
    return {
      ok: true as const,
      pedidoId: pedido.id,
      folioVisible: pedido.numeroPedido,
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
      return 'Ya avisamos al equipo. Tienes una propuesta pendiente de aprobar.';
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
