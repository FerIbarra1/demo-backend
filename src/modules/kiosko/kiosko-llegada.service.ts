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
import {
  firmarLlegoQr,
  verificarLlegoQr,
  tokenEsDeTienda,
} from '../pedidos/core/qr-llegada.util';
import { estadoPedidoLabel } from '../mail/estado-labels';
import { CanalLlegada, EstadoPedido, ModoEntrega, Prisma } from '@prisma/client';

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
 *    ciclo de vida del pedido (puede ocurrir en REVIEWING,
 *    PENDING_PAID, PAID, SHIPPED). En su lugar, columnas.
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

    // Validaciones de estado y modo de entrega.
    //
    // F16 (sep 2026): el aviso solo se acepta cuando el pedido YA ESTÁ LISTO
    // para revisarse en tienda (`EN_MOSTRADOR`). Ese estado es exactamente el
    // punto en que bodega terminó de verificar, o el cliente aprobó las
    // modificaciones que bodega o ventas propusieron.
    //
    // Antes solo se rechazaban COMPLETED y CANCELLED, así que el cliente podía
    // avisar desde PENDING_REVIEW y su pedido quedaba marcado "EN TIENDA" antes
    // de que nadie lo hubiera surtido.
    if (pedido.estado !== EstadoPedido.EN_MOSTRADOR) {
      const codigo =
        pedido.estado === EstadoPedido.COMPLETED
          ? 'YA_ENTREGADO'
          : pedido.estado === EstadoPedido.CANCELLED
            ? 'CANCELADO'
            : 'AUN_NO_ESTA_LISTO';
      const mensajes: Partial<Record<EstadoPedido, string>> = {
        [EstadoPedido.COMPLETED]: 'Ese pedido ya fue entregado.',
        [EstadoPedido.CANCELLED]:
          'Ese pedido está cancelado. Pasa al mostrador para revisarlo.',
        [EstadoPedido.PENDING_REVIEW]:
          'Tu pedido todavía está en cola de revisión. Te avisamos cuando esté listo.',
        [EstadoPedido.REVIEWING]:
          'Bodega está preparando tu pedido. Podrás avisar tu llegada cuando esté listo.',
        [EstadoPedido.WAITING_CUSTOMER_APPROVAL]:
          'Tienes una propuesta pendiente de aprobar. Tu pedido estará listo cuando la respondas.',
        [EstadoPedido.EN_ASESORIA]:
          'Un asesor está viendo tu pedido. Podrás avisar tu llegada cuando esté listo.',
        [EstadoPedido.PENDING_PAID]:
          'Tu pedido ya pasó a caja. Pasa a la ventanilla que te indiquen para pagar.',
        [EstadoPedido.PAID]:
          'Tu pedido ya está pagado. Acércate al mostrador con tu folio y te lo entregamos.',
        [EstadoPedido.SHIPPED]: 'Tu pedido ya fue enviado.',
      };
      throw new ConflictException({
        codigo,
        message:
          mensajes[pedido.estado] ??
          'Tu pedido todavía no está listo para revisarse en tienda.',
      });
    }
    if (
      pedido.modoEntrega !== ModoEntrega.RECOGER_TIENDA &&
      pedido.modoEntrega !== ModoEntrega.KIOSKO
    ) {
      throw new ConflictException({
        codigo: 'ES_A_DOMICILIO',
        message: 'Ese pedido es a domicilio, no se recoge en tienda.',
      });
    }

    // Idempotencia: si avisó hace <60s, devolvemos sin re-emit.
    // F16: un aviso DESCARTADO por el operador se puede volver a mandar de
    // inmediato (ver el comentario en `confirmarDesdeCliente`).
    const now = new Date();
    const ultimo = pedido.llegadaUltimoAvisoAt;
    const isFresh = ultimo && now.getTime() - ultimo.getTime() < THROTTLE_WINDOW_MS;
    const descartado = pedido.llegadaDescartadaAt !== null;
    if (pedido.llegadaAnunciadaAt && isFresh && !descartado) {
      const esperandoDesdeMin = Math.max(
        0,
        Math.floor((now.getTime() - pedido.llegadaAnunciadaAt.getTime()) / 60_000),
      );
      return {
        ...this.toConfirmarDto(pedido),
        mensaje: 'Ya avisamos al equipo. Te atenderemos pronto.',
        reanudado: false,
        esperandoDesdeMin,
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
      ultimaEmision === null ||
      now.getTime() - ultimaEmision.getTime() >= REINTENTO_WINDOW_MS;
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
        llegadaAnunciadaCanal: CanalLlegada.QR, // se sobreescribe abajo según método
        llegadaAnunciadaKioskoId: input.kioskoId,
        llegadaAnunciadaPor: input.kioskoNombre,
        // Si estaba descartado, lo resucitamos (otro intento legítimo).
        llegadaDescartadaAt: null,
        llegadaDescartadaPorId: null,
      },
      include: { tienda: { select: { nombre: true } } },
    });

    // Sobreescribir el canal con el método real.
    const canal: CanalLlegada = input.qr ? CanalLlegada.QR : CanalLlegada.FOLIO;
    await this.prisma.pedido.update({
      where: { id: pedido.id },
      data: { llegadaAnunciadaCanal: canal },
    });

    if (debeEmitir) {
      const esperandoDesdeMin = Math.max(
        0,
        Math.floor((now.getTime() - (actualizado.llegadaAnunciadaAt?.getTime() ?? now.getTime())) / 60_000),
      );
      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.llegada-anunciada', {
        pedidoId: pedido.id,
        numeroPedido: pedido.numeroPedido,
        folioVisible: pedido.numeroPedido,
        clienteNombre: pedido.clienteNombre,
        estado: pedido.estado,
        kioskoId: input.kioskoId,
        kioskoNombre: input.kioskoNombre,
        canal,
        llegadaAnunciadaAt: actualizado.llegadaAnunciadaAt,
        esperandoDesdeMin,
        tienda: pedido.tienda.nombre,
      });
      // También al room del pedido (para que el cliente en su app lo vea).
      this.realtime.emitToPedido(pedido.id, 'pedido.llegada-anunciada', {
        pedidoId: pedido.id,
        numeroPedido: pedido.numeroPedido,
        esperandoDesdeMin,
      });
    }

    const esperandoDesdeMin = Math.max(
      0,
      Math.floor((now.getTime() - (actualizado.llegadaAnunciadaAt?.getTime() ?? now.getTime())) / 60_000),
    );
    return {
      ...this.toConfirmarDto(pedido),
      mensaje: this.mensajeParaEstado(pedido.estado),
      reanudado: Boolean(pedido.llegadaAnunciadaAt),
      esperandoDesdeMin,
    };
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

    const now = new Date();
    const isFresh =
      pedido.llegadaUltimoAvisoAt &&
      now.getTime() - pedido.llegadaUltimoAvisoAt.getTime() < THROTTLE_WINDOW_MS;

    // F16 (sep 2026): un aviso DESCARTADO se puede volver a mandar de inmediato.
    //
    // El descarte lo hace el operador cuando el cliente no está (o se fue), así
    // que invalida el aviso anterior: no tiene sentido hacerlo esperar la
    // ventana de 60s. Sin esta excepción, si el operador descartaba dentro de
    // ese minuto —lo normal, porque descarta en cuanto no ve al cliente— el
    // cliente recibía "ya avisamos al equipo" y su pedido NO volvía a la cola,
    // quedándose sin forma de re-avisar.
    const descartado = pedido.llegadaDescartadaAt !== null;

    if (pedido.llegadaAnunciadaAt && isFresh && !descartado) {
      const esperandoDesdeMin = Math.max(
        0,
        Math.floor((now.getTime() - pedido.llegadaAnunciadaAt.getTime()) / 60_000),
      );
      return {
        ok: true as const,
        pedidoId: pedido.id,
        folioVisible: pedido.numeroPedido,
        mensaje: 'Ya avisamos al equipo. Te atenderemos pronto.',
        reanudado: false,
        esperandoDesdeMin,
      };
    }

    // F16: mismo límite de tasa que el camino del kiosko (ver el comentario en
    // `confirmar`). Sin esto, un cliente que avisa 6 veces desde su app deja su
    // pedido sin alerta en la TV para siempre. El ancla es la última EMISIÓN,
    // no el último aviso.
    const agotoTope = pedido.llegadaAnunciadaCount >= MAX_AVISOS_POR_PEDIDO;
    const ultimaEmision = pedido.llegadaUltimaEmisionAt;
    const pasoLaVentana =
      ultimaEmision === null ||
      now.getTime() - ultimaEmision.getTime() >= REINTENTO_WINDOW_MS;
    const nuevoCount = agotoTope && pasoLaVentana ? 1 : pedido.llegadaAnunciadaCount + 1;
    const debeEmitir = nuevoCount <= MAX_AVISOS_POR_PEDIDO;
    await this.prisma.pedido.update({
      where: { id: pedidoId },
      data: {
        llegadaAnunciadaAt: pedido.llegadaAnunciadaAt ?? now,
        llegadaUltimoAvisoAt: now,
        llegadaAnunciadaCount: nuevoCount,
        ...(debeEmitir ? { llegadaUltimaEmisionAt: now } : {}),
        llegadaAnunciadaCanal: CanalLlegada.WEB,
        llegadaAnunciadaKioskoId: null,
        llegadaAnunciadaPor: 'App del cliente',
        llegadaDescartadaAt: null,
        llegadaDescartadaPorId: null,
      },
    });

    if (debeEmitir) {
      const esperandoDesdeMin = Math.max(
        0,
        Math.floor((now.getTime() - (pedido.llegadaAnunciadaAt?.getTime() ?? now.getTime())) / 60_000),
      );
      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.llegada-anunciada', {
        pedidoId: pedido.id,
        numeroPedido: pedido.numeroPedido,
        clienteNombre: pedido.clienteNombre,
        estado: pedido.estado,
        kioskoId: null,
        kioskoNombre: 'App del cliente',
        canal: CanalLlegada.WEB,
        llegadaAnunciadaAt: pedido.llegadaAnunciadaAt ?? now,
        esperandoDesdeMin,
        tienda: pedido.tienda.nombre,
      });
      this.realtime.emitToPedido(pedido.id, 'pedido.llegada-anunciada', {
        pedidoId: pedido.id,
        numeroPedido: pedido.numeroPedido,
        esperandoDesdeMin,
      });
    }

    const esperandoDesdeMin = Math.max(
      0,
      Math.floor((now.getTime() - (pedido.llegadaAnunciadaAt?.getTime() ?? now.getTime())) / 60_000),
    );
    return {
      ok: true as const,
      pedidoId: pedido.id,
      folioVisible: pedido.numeroPedido,
      mensaje: this.mensajeParaEstado(pedido.estado),
      reanudado: Boolean(pedido.llegadaAnunciadaAt),
      esperandoDesdeMin,
    };
  }

  /**
   * Valida que el QR/folio resuelve a un pedido. Helper privado.
   * Aplica la lógica de "pertenece a la tienda del kiosko".
   */
  private async resolverPedido(input: {
    kioskoTiendaId: number;
    qr?: string;
    folio?: string;
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
    // divergían (EN_MOSTRADOR salía "Listo en tienda" aquí y "Listo en tienda ·
    // revísalo" en el correo). El cliente veía dos vocabularios para el mismo
    // paso según dónde mirara.
    return estadoPedidoLabel(estado);
  }

  private mensajeParaEstado(estado: EstadoPedido): string {
    if (
      estado === EstadoPedido.PENDING_REVIEW ||
      estado === EstadoPedido.REVIEWING ||
      estado === EstadoPedido.SHIPPED
    ) {
      return 'Listo, ya avisamos al equipo. Tu pedido sigue en preparación.';
    }
    if (estado === EstadoPedido.WAITING_CUSTOMER_APPROVAL) {
      return 'Ya avisamos al equipo. Tienes una propuesta pendiente de aprobar.';
    }
    if (estado === EstadoPedido.EN_ASESORIA) {
      return 'Ya avisamos al equipo. Un asesor te atenderá.';
    }
    // F16 (sep 2026): el pedido está apartado esperando que el cliente lo
    // revise. No es un error de compilación (esta función es una cadena de
    // `if` con fallback), pero sin este caso el cliente recibiría el copy
    // genérico justo cuando más necesita saber qué sigue.
    if (estado === EstadoPedido.EN_MOSTRADOR) {
      return '¡Listo! Ya avisamos al equipo. Pasa a mostrador a revisar tu pedido.';
    }
    if (estado === EstadoPedido.PENDING_PAID) {
      return 'Ya avisamos al equipo. Pasa a caja a pagar.';
    }
    if (estado === EstadoPedido.PAID) {
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