import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EstadoPedido, CanalOrigen, Prisma } from '@prisma/client';
import { minutosEntre } from '../pedidos/core/urgencia.util';
import {
  MonitorMostradorResponseDto,
  MonitorMostradorPedidoDto,
} from './dto/monitor-mostrador.dto';

/**
 * F16 (sep 2026): monitor de mostrador (TV de la pared).
 *
 * Espejo de `CajeroMonitorService` pero con una diferencia de fondo: el cajero
 * agrupa por VENTANILLA (cada cajera tiene su slot) y el mostrador es una COLA
 * LINEAL — el operador manda a llamar al siguiente conforme al orden. Es el
 * modelo "TV bancaria" que el negocio pidió (decisión D16): el cliente ve su
 * pedido aparecer en la pantalla y sabe que le toca.
 *
 * La cola usa el mismo gate de visibilidad que la consola (decisión D5):
 *   - KIOSKO → siempre visible (el pedido se hizo en la tienda).
 *   - WEB    → solo si el cliente avisó llegada (si no, podría estar en casa).
 *
 * NO calcula urgencia (decisión D13): en mostrador el pedido espera al CLIENTE.
 * Los pedidos ya liberados y pagados aparecen en `listosParaEntregar`, que es
 * informativo — el operador los ve para saber que hay entregas pendientes.
 */
@Injectable()
export class MostradorMonitorService {
  constructor(private prisma: PrismaService) {}

  async obtenerMonitor(tiendaId: number): Promise<MonitorMostradorResponseDto> {
    if (!tiendaId) {
      throw new BadRequestException(
        'El usuario no tiene una tienda asignada. Contacta al administrador.',
      );
    }

    const tienda = await this.prisma.tienda.findUnique({
      where: { id: tiendaId },
      select: { id: true, nombre: true },
    });
    if (!tienda) {
      throw new BadRequestException(`Tienda ${tiendaId} no encontrada`);
    }

    const ahora = new Date();

    // Mismo gate de CANAL/LLEGADA que `MostradorQueryService.obtenerCola`: si
    // divergieran, la TV y la consola mostrarían colas distintas y el operador
    // llamaría a alguien que no está en la pantalla.
    //
    // F18: el ESTADO sí diverge a propósito. La TV separa la cola de espera
    // (REVISADO) del panel "Atendiendo" (EN_ATENCION) — son dos paneles
    // distintos y el cliente necesita ver esa diferencia. La consola del
    // operador, en cambio, los muestra juntos: para él son la misma lista de
    // trabajo (un pedido que ya está atendiendo sigue siendo suyo).
    const whereCola: Prisma.PedidoWhereInput = {
      tiendaId,
      estado: EstadoPedido.REVISADO,
      OR: [
        { canalOrigen: CanalOrigen.KIOSKO },
        {
          canalOrigen: CanalOrigen.WEB,
          llegadaAnunciadaAt: { not: null },
          llegadaDescartadaAt: null,
        },
      ],
    };

    // F16/F17: el panel "Atendiendo" son los pedidos que el operador ya mandó a
    // llamar. Se consultan aparte de la cola (y no con un filtro en memoria)
    // porque la cola está paginada por el orden de llamada: si se colaran ahí,
    // el cliente ya llamado seguiría viéndose en la lista de espera.
    //
    // F17: el discriminador es el ESTADO (`EN_ATENCION`), no `llamadoAt`. Antes
    // el panel era `llamadoAt IS NOT NULL` sobre REVISADO, lo que obligaba a
    // recordar el filtro en cada query y hacía indistinguibles "llamado" y "en
    // la plancha". El gate de llegada (kiosko siempre / web con aviso) se
    // conserva: un pedido web sin aviso no debe aparecer ni en "Atendiendo".
    const whereAtendiendo: Prisma.PedidoWhereInput = {
      tiendaId,
      estado: EstadoPedido.EN_ATENCION,
      OR: [
        { canalOrigen: CanalOrigen.KIOSKO },
        {
          canalOrigen: CanalOrigen.WEB,
          llegadaAnunciadaAt: { not: null },
          llegadaDescartadaAt: null,
        },
      ],
    };

    const [colaRaw, atendiendoRaw, listosParaEntregar, sinClienteRaw] = await Promise.all([
      this.prisma.pedido.findMany({
        // La cola es solo REVISADO: un pedido ya llamado está en EN_ATENCION,
        // así que el estado por sí solo lo excluye.
        where: whereCola,
        select: {
          id: true,
          numeroPedido: true,
          clienteNombre: true,
          canalOrigen: true,
          total: true,
          fechaPedido: true,
          llegadaAnunciadaAt: true,
          llegadaDescartadaAt: true,
          _count: { select: { items: true } },
        },
        // Avisados primero (FIFO por el momento del aviso), luego el resto por
        // antigüedad. Es el orden de llamada.
        orderBy: [
          { llegadaAnunciadaAt: { sort: 'asc', nulls: 'last' } },
          { fechaPedido: 'asc' },
          { id: 'asc' },
        ],
      }),
      // F16: panel "Atendiendo" — los llamados, del más reciente al más viejo
      // (el último llamado es el que está enfrente del mostrador ahora mismo).
      this.prisma.pedido.findMany({
        where: whereAtendiendo,
        select: {
          id: true,
          numeroPedido: true,
          clienteNombre: true,
          canalOrigen: true,
          total: true,
          fechaPedido: true,
          llegadaAnunciadaAt: true,
          llegadaDescartadaAt: true,
          llamadoAt: true,
          _count: { select: { items: true } },
        },
        orderBy: [{ llamadoAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.pedido.count({
        where: {
          tiendaId,
          estado: { in: [EstadoPedido.PAGADO, EstadoPedido.ENVIADO] },
        },
      }),
      // F16 (§5.4 del plan): pedidos listos que NADIE va a recoger.
      //
      // El gate de D5 esconde los pedidos web hasta que el cliente avisa
      // llegada, así que un pedido web en REVISADO sin aviso es invisible
      // en la cola — y si el cliente nunca llega, se queda ahí para siempre sin
      // que nadie lo note. Este contador es la señal para que el operador (o el
      // admin) los persiga.
      //
      // Se cuentan con antigüedad para poder priorizar: los más viejos primero.
      this.prisma.pedido.findMany({
        where: {
          tiendaId,
          estado: EstadoPedido.REVISADO,
          canalOrigen: CanalOrigen.WEB,
          OR: [{ llegadaAnunciadaAt: null }, { llegadaDescartadaAt: { not: null } }],
        },
        select: { id: true, numeroPedido: true, clienteNombre: true, fechaPedido: true },
        orderBy: { fechaPedido: 'asc' },
      }),
    ]);

    const cola: MonitorMostradorPedidoDto[] = colaRaw.map((p) => this.aDto(p, ahora));
    const atendiendo: MonitorMostradorPedidoDto[] = atendiendoRaw.map((p) => this.aDto(p, ahora));

    // F16 (§5.4): antigüedad de los pedidos que nadie va a recoger.
    const sinCliente = sinClienteRaw.map((p) => ({
      id: p.id,
      numeroPedido: p.numeroPedido,
      clienteNombre: p.clienteNombre,
      minutosEsperando: minutosEntre(p.fechaPedido, ahora),
    }));

    return {
      timestamp: ahora.toISOString(),
      tiendaId: tienda.id,
      tiendaNombre: tienda.nombre,
      cola,
      atendiendo,
      contadores: {
        enCola: cola.length,
        atendiendo: atendiendo.length,
        enTienda: cola.filter((c) => c.clienteEnTienda).length,
        listosParaEntregar,
        // F16: pedidos listos que nadie ha venido a recoger. Si este número
        // crece, hay pedidos atorados que el gate de llegada está escondiendo.
        sinCliente: sinCliente.length,
      },
      sinCliente,
    };
  }

  /**
   * Fila de la TV a partir de un pedido. La comparten la cola y el panel
   * "Atendiendo" — si divergieran, el mismo pedido se vería distinto según en
   * qué panel esté.
   */
  private aDto(
    p: {
      id: number;
      numeroPedido: string;
      clienteNombre: string;
      canalOrigen: CanalOrigen;
      total: Prisma.Decimal;
      fechaPedido: Date;
      llegadaAnunciadaAt: Date | null;
      llegadaDescartadaAt: Date | null;
      _count: { items: number };
    },
    ahora: Date,
  ): MonitorMostradorPedidoDto {
    const clienteEnTienda = Boolean(p.llegadaAnunciadaAt && !p.llegadaDescartadaAt);
    return {
      id: p.id,
      numeroPedido: p.numeroPedido,
      clienteNombre: p.clienteNombre,
      canalOrigen: p.canalOrigen,
      itemsCount: p._count.items,
      total: Number(p.total),
      fechaPedido: p.fechaPedido.toISOString(),
      minutosEnCola: minutosEntre(p.fechaPedido, ahora),
      llegadaAnunciadaAt: p.llegadaAnunciadaAt ? p.llegadaAnunciadaAt.toISOString() : null,
      esperandoDesdeMin: clienteEnTienda
        ? Math.max(0, Math.floor((ahora.getTime() - p.llegadaAnunciadaAt!.getTime()) / 60_000))
        : null,
      clienteEnTienda,
    };
  }
}
