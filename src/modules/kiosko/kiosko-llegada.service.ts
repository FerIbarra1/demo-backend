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
import { CanalLlegada, EstadoPedido, ModoEntrega, Prisma } from '@prisma/client';

const THROTTLE_WINDOW_MS = 60_000;
const MAX_AVISOS_POR_PEDIDO = 5;

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
    if (pedido.estado === EstadoPedido.COMPLETED) {
      throw new ConflictException({
        codigo: 'YA_ENTREGADO',
        message: 'Ese pedido ya fue entregado.',
      });
    }
    if (pedido.estado === EstadoPedido.CANCELLED) {
      throw new ConflictException({
        codigo: 'CANCELADO',
        message: 'Ese pedido está cancelado. Pasa al mostrador para revisarlo.',
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
    const now = new Date();
    const ultimo = pedido.llegadaUltimoAvisoAt;
    const isFresh = ultimo && now.getTime() - ultimo.getTime() < THROTTLE_WINDOW_MS;
    if (pedido.llegadaAnunciadaAt && isFresh) {
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

    // Anti-spam: si llega a MAX, dejamos de re-emit realtime (el
    // mostrador ya sabe). Igual dejamos que se actualice el último
    // timestamp para que el cliente vea feedback.
    const nuevoCount = pedido.llegadaAnunciadaCount + 1;
    const debeEmitir = nuevoCount <= MAX_AVISOS_POR_PEDIDO;

    const actualizado = await this.prisma.pedido.update({
      where: { id: pedido.id },
      data: {
        llegadaAnunciadaAt: pedido.llegadaAnunciadaAt ?? now,
        llegadaUltimoAvisoAt: now,
        llegadaAnunciadaCount: nuevoCount,
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

    if (pedido.llegadaAnunciadaAt && isFresh) {
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

    const nuevoCount = pedido.llegadaAnunciadaCount + 1;
    const debeEmitir = nuevoCount <= MAX_AVISOS_POR_PEDIDO;
    await this.prisma.pedido.update({
      where: { id: pedidoId },
      data: {
        llegadaAnunciadaAt: pedido.llegadaAnunciadaAt ?? now,
        llegadaUltimoAvisoAt: now,
        llegadaAnunciadaCount: nuevoCount,
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
        include: { tienda: { select: { nombre: true } } },
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
        include: { tienda: { select: { nombre: true } } },
      });
      if (!pedido) {
        // Fallback: externalFolio (folio de Firebird, asignado tras
        // el ACK del agente). El índice parcial se creó en esta misma
        // migración.
        const pendiente = await this.prisma.pedidoPendienteEnvio.findFirst({
          where: { externalFolio: folio, pedido: { tiendaId: input.kioskoTiendaId } },
          include: { pedido: { include: { tienda: { select: { nombre: true } } } } },
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
    // Reusar etiquetas existentes si están en estado-labels.ts; si no,
    // fallback a un mapping mínimo para no acoplar al módulo mostrador.
    const map: Record<EstadoPedido, string> = {
      PENDING_REVIEW: 'En revisión',
      REVIEWING: 'En revisión',
      WAITING_CUSTOMER_APPROVAL: 'Propuesta pendiente',
      EN_ASESORIA: 'Con asesor',
      PENDING_PAID: 'Pendiente de pago',
      PAID: 'Pagado',
      SHIPPED: 'En preparación',
      COMPLETED: 'Entregado',
      CANCELLED: 'Cancelado',
    };
    return map[estado] ?? estado;
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