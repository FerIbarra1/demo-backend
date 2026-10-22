import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EstadoPedido, RolUsuario, CanalOrigen } from '@prisma/client';
import { MonitorResponseDto, MonitorPedidoDto, MonitorBodegueroDto } from './dto/monitor.dto';
import { MAX_PEDIDOS_POR_BODEGUERO, ESTADOS_OCUPAN_SLOT_BODEGA } from '../core/pedido-limits';
import { asignadoANombre } from '../core/pedido-mapper';
import { derivarMotivoReingreso } from '../core/motivo-reingreso';
import { clientePresenteEnTienda } from '../core/presencia.util';
import { INACTIVIDAD_ESTACION_MS } from '../core/estacion.util';
import { turnoCorto } from '../../pedidos/core/folio-erp.util';

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
const UMBRAL_SUGERENCIA = 4; // al menos un match por producto, no solo categoría + bono

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

    // 1) Equipo de bodega EN LÍNEA en esta tienda. Oct 2026: "en línea" es un estado, no una ventana
    // de 12 h desde el último login: entrar lo pone (`BodegaPresenciaService.entro`), el latido de la
    // tablet lo mantiene y cerrar sesión lo quita (con lo que traía en las manos, que regresa a la
    // cola). Se incluye también a quien aún trae pedidos aunque su latido haya caducado: el
    // barrido (cada 5 min) todavía no lo saca, y sin esto sus pedidos desaparecían de la TV (ya no
    // salen en las columnas porque "viven" en su ficha) durante esos minutos.
    const limiteLatido = new Date(ahora.getTime() - INACTIVIDAD_ESTACION_MS);
    const bodeguerosRaw = await this.prisma.usuario.findMany({
      where: {
        activo: true,
        OR: [
          {
            rol: RolUsuario.BODEGA,
            tiendaId,
            OR: [
              { ultimoHeartbeat: { gte: limiteLatido } },
              { pedidosAsignados: { some: { estado: { in: ESTADOS_OCUPAN_SLOT_BODEGA } } } },
            ],
          },
          // F3.5 ("cubrir puesto"): un ADMIN que trae pedidos de ESTA tienda sale en la TV como un bodeguero
          // más, solo mientras los trae. Sin esto sus pedidos desaparecían: ya no salen en las columnas (viven
          // en la ficha de quien los tiene) y el ADMIN no tiene ficha porque no es `rol BODEGA` con tienda.
          {
            rol: RolUsuario.ADMIN,
            pedidosAsignados: { some: { tiendaId, estado: { in: ESTADOS_OCUPAN_SLOT_BODEGA } } },
          },
        ],
      },
      select: {
        id: true,
        nombre: true,
        apellido: true,
        activo: true,
        pedidosAsignados: {
          // F12: incluir ESPERANDO_APROBACION para que el slot del
          // bodeguero muestre "esperando cliente" (el pedido sigue asignado).
          // `tiendaId`: un ADMIN puede traer pedidos de otra tienda, que no son de esta TV.
          where: { tiendaId, estado: { in: ESTADOS_OCUPAN_SLOT_BODEGA } },
          orderBy: { asignadoAt: 'desc' },
          take: MAX_PEDIDOS_POR_BODEGUERO,
          select: {
            id: true,
            numeroPedido: true,
            folioErp: true,
            estado: true,
            asignadoAt: true,
            // Oct 2026: ¿el cliente de lo que está surtiendo ya llegó? El encargado lo ve en la
            // ficha del bodeguero sin tener que cruzarlo con las columnas de abajo.
            canalOrigen: true,
            llegadaAnunciadaAt: true,
            llegadaDescartadaAt: true,
          },
        },
      },
    });

    const equipo: MonitorBodegueroDto[] = bodeguerosRaw.map((b) => {
      // F6 (jul 2026): hasta MAX_PEDIDOS_POR_BODEGUERO slots. Calculamos
      // nivelUrgencia por slot usando UMBRALES_BODEGUERO.
      const slots = b.pedidosAsignados.map((p) => {
        const minutosEnProceso = p.asignadoAt ? this.minutosEntre(p.asignadoAt, ahora) : 0;
        return {
          id: p.id,
          numeroPedido: p.numeroPedido,
          turno: turnoCorto(p.folioErp),
          estado: p.estado,
          asignadoAt: p.asignadoAt ? p.asignadoAt.toISOString() : ahora.toISOString(),
          minutosEnProceso,
          nivelUrgencia: this.calcularUrgencia(minutosEnProceso, UMBRALES_BODEGUERO) as
            | 0
            | 1
            | 2
            | 3,
          clienteEnTienda: clientePresenteEnTienda(p),
        };
      });
      return {
        id: b.id,
        nombre: b.nombre,
        apellido: b.apellido,
        activo: b.activo,
        pedidosActuales: slots,
        maxPedidos: MAX_PEDIDOS_POR_BODEGUERO,
      };
    });

    // 2) Pedidos visibles para bodega.
    //
    // F6 (jul 2026): excluimos EN_REVISION con asignado de las columnas KIOSKO/
    // WEB, porque ya aparecen en la tarjeta del bodeguero que los tomó.
    // Pero SÍ incluimos EN_REVISION sin asignado (recién liberados) y los
    // marcamos con `esLiberado=true` para que destaquen visualmente.
    //
    // F11 (ago 2026): este monitor es SOLO de bodega. Solo se listan
    // pedidos en estados accionables por bodega: SOLICITADO (esperando
    // tomar) y EN_REVISION sin asignar (recién liberado). F12: se quitaron
    // ESPERANDO_APROBACION (está asignado, no es accionable por otro
    // bodeguero — vive en el slot del bodeguero).
    // PENDIENTE_PAGO / PAID / SHIPPED / COMPLETED / CANCELLED son
    // responsabilidad del monitor de cajeros o de mostrador — NUNCA del de
    // bodega.
    const pedidosRaw = await this.prisma.pedido.findMany({
      where: {
        tiendaId,
        OR: [
          { estado: EstadoPedido.SOLICITADO },
          { estado: EstadoPedido.EN_REVISION, asignadoAId: null },
        ],
      },
      select: {
        id: true,
        numeroPedido: true,
        folioErp: true,
        estado: true,
        canalOrigen: true,
        clienteNombre: true,
        total: true,
        fechaPedido: true,
        asignadoAt: true,
        asignadoAId: true,
        asignadoA: { select: { nombre: true, apellido: true } },
        // Oct 2026: presencia del cliente (ver `clienteEnTienda` en el DTO).
        llegadaAnunciadaAt: true,
        llegadaDescartadaAt: true,
        presenteDesdeAt: true,
        cajeroAsignadoId: true,
        cajeroAsignadoAt: true,
        cajeroAsignado: { select: { nombre: true, apellido: true } },
        _count: { select: { items: true } },
        items: {
          where: { cancelada: false },
          select: { precioCOId: true, productoId: true, original: true },
        },
        // F16 (sep 2026): el último cambio de estado, para saber POR QUÉ el
        // pedido volvió a la cola de bodega (ver `motivoReingreso`).
        historial: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { estadoAnterior: true, estadoNuevo: true },
        },
      },
      orderBy: { fechaPedido: 'asc' },
    });

    const pedidosFormateados: MonitorPedidoDto[] = pedidosRaw.map((p) => {
      // El "tiempo en cola" para el monitor:
      //   - cliente AUSENTE → desde fechaPedido (cuánto lleva el pedido esperando).
      //   - cliente PRESENTE (kiosko, o web que ya avisó llegada) → desde que está esperando EN la
      //     tienda: es lo que el encargado necesita ver, y es el criterio de urgencia que ya
      //     se usa para kiosko. Un pedido web hecho hace dos horas cuyo cliente acaba de entrar
      //     no está "dos horas crítico": lleva un minuto con alguien de pie.
      // El bono de tienda resta 1 minuto al cálculo visual de los pedidos de KIOSKO.
      const clienteEnTienda = clientePresenteEnTienda(p);
      const desde = clienteEnTienda
        ? (p.presenteDesdeAt ?? p.llegadaAnunciadaAt ?? p.fechaPedido)
        : p.fechaPedido;
      const minutosBase = this.minutosEntre(desde, ahora);
      const minutos =
        p.canalOrigen === CanalOrigen.KIOSKO
          ? Math.max(0, minutosBase - BONO_TIENDA_MIN)
          : minutosBase;
      // Un cliente web ya presente se mide con los umbrales de tienda: está esperando de pie igual.
      const umbrales =
        p.canalOrigen === CanalOrigen.KIOSKO || clienteEnTienda ? UMBRALES_TIENDA : UMBRALES_WEB;
      const nivelUrgencia = this.calcularUrgencia(minutos, umbrales);

      const nombreAsignado = asignadoANombre(p.asignadoA);

      const nombreCajeroAsignado = p.cajeroAsignado
        ? `${p.cajeroAsignado.nombre} ${p.cajeroAsignado.apellido ?? ''}`.trim()
        : null;

      // F16 (sep 2026): por qué el pedido volvió a la cola de bodega.
      //
      // Un pedido llega a EN_REVISION sin asignar por TRES caminos que antes se
      // veían idénticos (todos caían en `esLiberado`), y dos de ellos traen
      // trabajo real que el bodeguero no podía distinguir:
      //
      //   LIBERADO          — otro bodeguero lo soltó. Nada nuevo que surtir.
      //   AJUSTE_MOSTRADOR  — el cliente cambió algo en tienda. Surtir lo nuevo.
      //   PROPUESTA_VENTAS  — el cliente aprobó una contrapropuesta. Surtir lo
      //                       que el asesor propuso.
      //
      // El discriminador ya existía en los datos: `ItemPedido.original = false`
      // solo lo setean los caminos que AGREGAN productos (ventas y el ajuste de
      // mostrador), y el último `HistorialPedido` dice de dónde vino.
      const itemsNuevos = p.items.filter((i) => !i.original).length;
      // F17: la derivación vive en `core/motivo-reingreso.ts` para que el
      // monitor y la cola de `/bodega` no puedan divergir.
      const motivoReingreso = derivarMotivoReingreso({
        estado: p.estado,
        asignadoAId: p.asignadoAId,
        items: p.items,
        historial: p.historial,
      });

      return {
        id: p.id,
        numeroPedido: p.numeroPedido,
        turno: turnoCorto(p.folioErp),
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
        esLiberado: p.estado === EstadoPedido.EN_REVISION && p.asignadoAId === null,
        // F16: el badge nuevo. `esLiberado` se conserva durante la transición
        // para no romper el frontend que aún lo lee.
        motivoReingreso,
        itemsNuevos,
        clienteEnTienda,
        presenteDesdeAt: clienteEnTienda
          ? (p.presenteDesdeAt ?? p.llegadaAnunciadaAt ?? p.fechaPedido).toISOString()
          : null,
      };
    });

    // 2.5) Calcular sugerencias: scores por similitud de items con lo que ya
    //     se está surtiendo en la tienda.
    const soloEnCola = pedidosFormateados
      .filter((p) => p.estado === EstadoPedido.SOLICITADO)
      .map((p) => {
        const raw = pedidosRaw.find((r) => r.id === p.id);
        const productoIds = Array.from(
          new Set(
            (raw?.items ?? []).map((i) => i.productoId).filter((v): v is number => v != null),
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

    // 3) Separar por canal. Orden: primero los que tienen al cliente EN la tienda (es el mismo
    //    criterio que la cola de la consola de bodega: el cliente de pie va antes que el que ni
    //    ha salido de casa), y dentro de cada grupo el más viejo arriba.
    // Entre los que tienen al cliente EN la tienda, el que lleva más ESPERANDO (hora exacta de su
    // llegada): comparar minutos enteros dejaba empatados a todos los que llegaron en el último
    // minuto, y el desempate caía en la fecha del pedido — no en quién llegó antes.
    const porUrgencia = (a: MonitorPedidoDto, b: MonitorPedidoDto) => {
      if (a.clienteEnTienda !== b.clienteEnTienda) return a.clienteEnTienda ? -1 : 1;
      if (a.clienteEnTienda && a.presenteDesdeAt && b.presenteDesdeAt) {
        return Date.parse(a.presenteDesdeAt) - Date.parse(b.presenteDesdeAt);
      }
      return b.minutosEnCola - a.minutosEnCola;
    };
    const pedidosTienda = pedidosFormateados
      .filter((p) => p.canalOrigen === CanalOrigen.KIOSKO)
      .sort(porUrgencia);
    const pedidosWeb = pedidosFormateados
      .filter((p) => p.canalOrigen === CanalOrigen.WEB)
      .sort(porUrgencia);

    // 4) Contadores
    const contadores = {
      pedidosEnTienda: pedidosTienda.length,
      pedidosWeb: pedidosWeb.length,
      alertasCriticas: pedidosFormateados.filter((p) => p.nivelUrgencia >= 3).length,
      // Clientes de pie esperando: los de la cola más los que ya están en manos de un bodeguero.
      clientesEnTienda:
        pedidosFormateados.filter((p) => p.clienteEnTienda).length +
        equipo.reduce((n, b) => n + b.pedidosActuales.filter((s) => s.clienteEnTienda).length, 0),
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
   * Calcula scores de similitud entre los pedidos en cola (SOLICITADO)
   * y los items que están siendo atendidos por bodegueros activos de la tienda.
   *
   *   match exacto (mismo precioCOId) ........... peso 10
   *   match por producto (mismo productoId) ..... peso 4
   *   match por categoría ...................... peso 1
   *   bono antigüedad .......................... +1 por minuto en cola
   *
   * Solo se devuelven entradas con `itemsCompartidos > 0` y `score >= UMBRAL_SUGERENCIA`
   * (descarta sugerencias basadas solo en categoría + antigüedad, que eran ruido).
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
            in: ESTADOS_OCUPAN_SLOT_BODEGA,
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
      const matchVariante = item.precioCOId && precioCOIdsEnProceso.has(item.precioCOId);
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
