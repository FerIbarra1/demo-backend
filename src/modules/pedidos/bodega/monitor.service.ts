import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EstadoPedido, RolUsuario, CanalOrigen } from '@prisma/client';
import {
  MonitorResponseDto,
  MonitorPedidoDto,
  MonitorBodegueroDto,
} from './dto/monitor.dto';
import { MAX_PEDIDOS_POR_BODEGUERO } from '../core/pedido-limits';
import { asignadoANombre } from '../core/pedido-mapper';

/**
 * Umbrales de antigüedad (en minutos) para asignar nivel de urgencia.
 * 0=normal · 1=aviso · 2=alerta · 3=crítico
 * Los pedidos de tienda (KIOSKO) restan 1 minuto al tiempo en cola,
 * dándoles ventaja de prioridad visual.
 *
 * Para BODEGUEROS usamos los mismos umbrales de tienda (no hay canal
 * diferenciado: un bodeguero que lleva mucho con un pedido, sin importar
 * de qué canal vino, debe aparecer como crítico).
 */
const UMBRALES_TIENDA = [4, 7, 10];
const UMBRALES_WEB = [5, 8, 11];
const UMBRALES_BODEGUERO = [4, 7, 10];
const BONO_TIENDA_MIN = 1;
const TOP_SUGERENCIAS = 3;
const UMBRAL_SUGERENCIA = 4; // al menos un match por producto, no sólo categoría + bono

/**
 * F6 (jul 2026): ventana de logueo para considerar a un bodeguero "activo"
 * en el monitor. Replica la lógica del monitor de cajeros. Un bodeguero
 * con `activo=true` en DB pero que no se ha logueado en este tiempo NO
 * aparece en el equipo, para no inflar la sensación de personal disponible.
 */
const VENTANA_LOGUEO_BODEGUERO_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class MonitorService {
  private readonly logger = new Logger(MonitorService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Devuelve la foto completa del monitor de bodega: equipo activo,
   * contadores, pedidos en tienda y web. Scope automático por tienda
   * del usuario (multi-tienda blindado).
   */
  async obtenerMonitor(tiendaId: number): Promise<MonitorResponseDto> {
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

    // 1) Equipo de bodega activo de esta tienda. F6 (jul 2026): filtramos
    // además por lastLogin reciente. F7 (jul 2026): también por
    // `ultimoHeartbeat` (ping cada 5min desde la tablet del bodeguero).
    // Un bodeguero que NO esté físicamente en su tablet desaparece del
    // monitor aunque su `lastLogin` sea reciente.
    const limiteLogueo = new Date(ahora.getTime() - VENTANA_LOGUEO_BODEGUERO_MS);
    const bodeguerosRaw = await this.prisma.usuario.findMany({
      where: {
        rol: RolUsuario.BODEGA,
        tiendaId,
        activo: true,
        OR: [
          { lastLogin: { gte: limiteLogueo } },
          { ultimoHeartbeat: { gte: limiteLogueo } },
        ],
      },
      select: {
        id: true,
        nombre: true,
        apellido: true,
        activo: true,
        lastLogin: true,
        pedidosAsignados: {
          where: { estado: EstadoPedido.REVIEWING },
          orderBy: { asignadoAt: 'desc' },
          take: MAX_PEDIDOS_POR_BODEGUERO,
          select: {
            id: true,
            numeroPedido: true,
            estado: true,
            asignadoAt: true,
          },
        },
      },
    });

    const equipo: MonitorBodegueroDto[] = bodeguerosRaw.map((b) => {
      // F6 (jul 2026): hasta MAX_PEDIDOS_POR_BODEGUERO slots. Calculamos
      // nivelUrgencia por slot usando UMBRALES_BODEGUERO. La "última
      // actividad" del bodeguero es el asignadoAt más reciente de sus
      // pedidos en curso, o su lastLogin si está libre.
      const slots = b.pedidosAsignados.map((p) => {
        const minutosEnProceso = p.asignadoAt
          ? this.minutosEntre(p.asignadoAt, ahora)
          : 0;
        return {
          id: p.id,
          numeroPedido: p.numeroPedido,
          estado: p.estado,
          asignadoAt: p.asignadoAt ? p.asignadoAt.toISOString() : ahora.toISOString(),
          minutosEnProceso,
          nivelUrgencia: this.calcularUrgencia(minutosEnProceso, UMBRALES_BODEGUERO) as
            | 0
            | 1
            | 2
            | 3,
        };
      });
      const masReciente = b.pedidosAsignados[0]?.asignadoAt ?? null;
      return {
        id: b.id,
        nombre: b.nombre,
        apellido: b.apellido,
        activo: b.activo,
        lastLogin: b.lastLogin ? b.lastLogin.toISOString() : null,
        pedidosActuales: slots,
        maxPedidos: MAX_PEDIDOS_POR_BODEGUERO,
        ultimaActividad: (masReciente ?? b.lastLogin ?? new Date(0)).toISOString(),
      };
    });

    // 2) Pedidos visibles para bodega.
    //
    // F6 (jul 2026): excluimos REVIEWING con asignado de las columnas KIOSKO/
    // WEB, porque ya aparecen en la tarjeta del bodeguero que los tomó.
    // Pero SÍ incluimos REVIEWING sin asignado (recién liberados) y los
    // marcamos con `esLiberado=true` para que destaquen visualmente.
    //
    // F11 (ago 2026): este monitor es SOLO de bodega. Sólo se listan
    // pedidos en estados accionables por bodega: PENDING_REVIEW
    // (esperando tomar), REVIEWING (asignado o recién liberado),
    // WAITING_CUSTOMER_APPROVAL (propuesta enviada al cliente) y
    // APPROVED (transitorio). PENDING_PAID / PAID / SHIPPED /
    // COMPLETED / CANCELLED son responsabilidad del monitor de cajeros
    // o de mostrador — NUNCA del de bodega. Antes aparecía WEB en
    // PENDING_PAID+ aquí, lo cual era incorrecto.
    const pedidosRaw = await this.prisma.pedido.findMany({
      where: {
        tiendaId,
        OR: [
          {
            estado: {
              in: [
                EstadoPedido.PENDING_REVIEW,
                EstadoPedido.WAITING_CUSTOMER_APPROVAL,
                EstadoPedido.APPROVED,
              ],
            },
          },
          { estado: EstadoPedido.REVIEWING, asignadoAId: null },
        ],
      },
      select: {
        id: true,
        numeroPedido: true,
        estado: true,
        canalOrigen: true,
        clienteNombre: true,
        total: true,
        fechaPedido: true,
        asignadoAt: true,
        asignadoAId: true,
        asignadoA: { select: { nombre: true, apellido: true } },
        cajeroAsignadoId: true,
        cajeroAsignadoAt: true,
        cajeroAsignado: { select: { nombre: true, apellido: true } },
        _count: { select: { items: true } },
        items: {
          where: { cancelada: false },
          select: { precioCOId: true, productoId: true },
        },
      },
      orderBy: { fechaPedido: 'asc' },
    });

    const pedidosFormateados: MonitorPedidoDto[] = pedidosRaw.map((p) => {
      // El "tiempo en cola" para el monitor:
      //   - PENDING_REVIEW  → desde fechaPedido (esperando ser tomado)
      //   - otros           → desde fechaPedido igual (cuenta total desde la creación)
      // El bono de tienda resta 1 minuto al cálculo visual.
      const minutosBase = this.minutosEntre(p.fechaPedido, ahora);
      const minutos =
        p.canalOrigen === CanalOrigen.KIOSKO
          ? Math.max(0, minutosBase - BONO_TIENDA_MIN)
          : minutosBase;
      const umbrales = p.canalOrigen === CanalOrigen.KIOSKO ? UMBRALES_TIENDA : UMBRALES_WEB;
      const nivelUrgencia = this.calcularUrgencia(minutos, umbrales);

      const nombreAsignado = asignadoANombre(p.asignadoA);

      const nombreCajeroAsignado = p.cajeroAsignado
        ? `${p.cajeroAsignado.nombre} ${p.cajeroAsignado.apellido ?? ''}`.trim()
        : null;

      return {
        id: p.id,
        numeroPedido: p.numeroPedido,
        estado: p.estado,
        canalOrigen: p.canalOrigen,
        clienteNombre: p.clienteNombre,
        total: Number(p.total),
        itemsCount: p._count.items,
        fechaPedido: p.fechaPedido.toISOString(),
        fechaAsignacion: p.asignadoAt ? p.asignadoAt.toISOString() : null,
        minutosEnCola: minutos,
        nivelUrgencia,
        asignadoAId: p.asignadoAId,
        asignadoANombre: nombreAsignado,
        cajeroAsignadoId: p.cajeroAsignadoId,
        cajeroAsignadoAt: p.cajeroAsignadoAt ? p.cajeroAsignadoAt.toISOString() : null,
        cajeroAsignadoNombre: nombreCajeroAsignado,
        sugerido: false,
        scoreSimilitud: 0,
        itemsCompartidos: 0,
        esLiberado: p.estado === EstadoPedido.REVIEWING && p.asignadoAId === null,
      };
    });

    // 2.5) Calcular sugerencias: scores por similitud de items con lo que ya
    //     se está surtiendo en la tienda.
    const soloEnCola = pedidosFormateados
      .filter((p) => p.estado === EstadoPedido.PENDING_REVIEW)
      .map((p) => {
        const raw = pedidosRaw.find((r) => r.id === p.id);
        const productoIds = Array.from(
          new Set(
            (raw?.items ?? [])
              .map((i) => i.productoId)
              .filter((v): v is number => v != null),
          ),
        );
        return { id: p.id, minutosEnCola: p.minutosEnCola, productoIds };
      });
    const { scores } = await this.calcularSugerencias(tiendaId, soloEnCola);

    // Top N = sugeridos
    const topIds = Array.from(scores.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, TOP_SUGERENCIAS)
      .map(([id]) => id);
    const sugeridosSet = new Set<number>(topIds);

    // Inyectar sugerido + score + items compartidos a los pedidos formateados
    for (const p of pedidosFormateados) {
      const data = scores.get(p.id);
      p.sugerido = sugeridosSet.has(p.id);
      p.scoreSimilitud = data?.score ?? 0;
      p.itemsCompartidos = data?.itemsCompartidos ?? 0;
    }

    // 3) Separar por canal y ordenar por edad desc (más viejos arriba)
    const pedidosTienda = pedidosFormateados
      .filter((p) => p.canalOrigen === CanalOrigen.KIOSKO)
      .sort((a, b) => b.minutosEnCola - a.minutosEnCola);
    const pedidosWeb = pedidosFormateados
      .filter((p) => p.canalOrigen === CanalOrigen.WEB)
      .sort((a, b) => b.minutosEnCola - a.minutosEnCola);

    // 4) Contadores
    const contadores = {
      pedidosEnTienda: pedidosTienda.length,
      pedidosWeb: pedidosWeb.length,
      alertasCriticas: pedidosFormateados.filter((p) => p.nivelUrgencia >= 3).length,
      bodeguerosLibres: equipo.filter((b) => b.pedidosActuales.length === 0).length,
      bodeguerosOcupados: equipo.filter((b) => b.pedidosActuales.length > 0).length,
      totalEnCola: pedidosFormateados.length,
    };

    return {
      timestamp: ahora.toISOString(),
      tiendaId: tienda.id,
      tiendaNombre: tienda.nombre,
      equipo,
      contadores,
      pedidosTienda,
      pedidosWeb,
    };
  }

  /**
   * Calcula scores de similitud entre los pedidos en cola (PENDING_REVIEW)
   * y los items que están siendo atendidos por bodegueros activos de la tienda.
   *
   *   match exacto (mismo precioCOId) ........... peso 10
   *   match por producto (mismo productoId) ..... peso 4
   *   match por categoría ...................... peso 1
   *   bono antigüedad .......................... +1 por minuto en cola
   *
   * Sólo se devuelven entradas con `itemsCompartidos > 0` y `score >= UMBRAL_SUGERENCIA`
   * (descarta sugerencias basadas sólo en categoría + antigüedad, que eran ruido).
   * El top N se aplica en el caller.
   */
  async calcularSugerencias(
    tiendaId: number,
    pedidosEnCola: Array<{ id: number; minutosEnCola: number; productoIds: number[] }>,
  ): Promise<{
    scores: Map<number, { score: number; itemsCompartidos: number }>;
  }> {
    const scores = new Map<number, { score: number; itemsCompartidos: number }>();

    // Items que ya están siendo atendidos por bodegueros activos de la tienda
    const itemsEnProceso = await this.prisma.itemPedido.findMany({
      where: {
        pedido: {
          tiendaId,
          estado: {
            in: [
              EstadoPedido.REVIEWING,
              EstadoPedido.WAITING_CUSTOMER_APPROVAL,
              EstadoPedido.APPROVED,
            ],
          },
        },
        cancelada: false,
      },
      select: {
        precioCOId: true,
        productoId: true,
      },
    });

    if (itemsEnProceso.length === 0) return { scores };
    if (pedidosEnCola.length === 0) return { scores };

    // Sets para lookup O(1)
    const precioCOIdsEnProceso = new Set<number>(
      itemsEnProceso.map((i) => i.precioCOId).filter((v): v is number => v != null),
    );
    const productoIdsEnProceso = new Set<number>(
      itemsEnProceso.map((i) => i.productoId).filter((v): v is number => v != null),
    );

    // Categorías de los productos en proceso (para el match suave por categoría)
    const productosEnProceso = await this.prisma.producto.findMany({
      where: { id: { in: Array.from(productoIdsEnProceso) } },
      select: { id: true, categoria: true },
    });
    const categoriasEnProceso = new Set<string>(
      productosEnProceso.map((p) => p.categoria).filter((c): c is string => !!c),
    );

    // Traer los items de los pedidos en cola
    const itemsEnCola = await this.prisma.itemPedido.findMany({
      where: {
        pedidoId: { in: pedidosEnCola.map((p) => p.id) },
        cancelada: false,
      },
      select: {
        pedidoId: true,
        precioCOId: true,
        productoId: true,
      },
    });

    // Categorías de los productos en cola
    const productosEnCola = await this.prisma.producto.findMany({
      where: {
        id: {
          in: Array.from(new Set(itemsEnCola.map((i) => i.productoId))),
        },
      },
      select: { id: true, categoria: true },
    });
    const categoriaPorProductoEnCola = new Map<number, string | null>();
    productosEnCola.forEach((p) => categoriaPorProductoEnCola.set(p.id, p.categoria));

    // Acumular score y contar items compartidos (los que matchean por variante
    // o por producto; categoría sola NO cuenta como compartido).
    for (const item of itemsEnCola) {
      const matchVariante =
        item.precioCOId && precioCOIdsEnProceso.has(item.precioCOId);
      const matchProducto = productoIdsEnProceso.has(item.productoId);
      if (!matchVariante && !matchProducto) {
        // ¿categoría? entonces es match suave, no cuenta como compartido
        const cat = categoriaPorProductoEnCola.get(item.productoId);
        if (cat && categoriasEnProceso.has(cat)) {
          const prev = scores.get(item.pedidoId) ?? { score: 0, itemsCompartidos: 0 };
          scores.set(item.pedidoId, { ...prev, score: prev.score + 1 });
        }
        continue;
      }
      const prev = scores.get(item.pedidoId) ?? { score: 0, itemsCompartidos: 0 };
      scores.set(item.pedidoId, {
        score: prev.score + (matchVariante ? 10 : 4),
        itemsCompartidos: prev.itemsCompartidos + 1,
      });
    }

    // Bono antigüedad (1 punto por minuto en cola) y filtro de umbral
    for (const pedido of pedidosEnCola) {
      const data = scores.get(pedido.id);
      if (!data) continue;
      const scoreFinal = data.score + pedido.minutosEnCola;
      if (scoreFinal < UMBRAL_SUGERENCIA || data.itemsCompartidos === 0) {
        scores.delete(pedido.id);
        continue;
      }
      scores.set(pedido.id, { score: scoreFinal, itemsCompartidos: data.itemsCompartidos });
    }

    return { scores };
  }

  // ---------- helpers ----------

  private minutosEntre(desde: Date, hasta: Date): number {
    return Math.floor((hasta.getTime() - desde.getTime()) / 60000);
  }

  private calcularUrgencia(minutos: number, umbrales: number[]): number {
    if (minutos >= umbrales[2]) return 3;
    if (minutos >= umbrales[1]) return 2;
    if (minutos >= umbrales[0]) return 1;
    return 0;
  }
}
