import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { PedidoAccessService } from '../core/pedido-access.service';
import { UserContext } from '../../../types/pedido.types';
import { EstadoPedido, Prisma, RolUsuario } from '@prisma/client';
import {
  rankearSimilares,
  TOP_LISTA,
  agruparColaPorZonaCompartida,
  type PedidoColaParaAgrupar,
} from '../core/similitud.util';
import {
  MAX_PEDIDOS_POR_BODEGUERO,
  ESTADOS_OCUPAN_SLOT_BODEGA,
} from '../core/pedido-limits';
import { zonaKey } from '../core/zona.util';
import { asignadoANombre } from '../core/pedido-mapper';
import { tiempoAtencionEn } from '../core/atencion.util';
import type {
  SurtirJuntosPedidoDto,
  LoteSurtirJuntosDto,
  ZonaLoteDto,
} from './dto/surtir-juntos.dto';

/**
 * Servicio del dominio BODEGA.
 *
 * Responsabilidad: cola de pedidos pendientes, tomar / liberar / marcar
 * como enviado, listar mis pedidos en proceso. Toda transición de estado
 * delega a `PedidoStateService`. El surtido y el monitor viven como
 * services hermanos (`surtido.service.ts`, `monitor.service.ts`) en esta
 * misma carpeta para mantener el dominio cohesivo.
 */
@Injectable()
export class BodegaService {
  private readonly logger = new Logger(BodegaService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private state: PedidoStateService,
    private access: PedidoAccessService,
  ) {}

  async obtenerPedidosBodega(
    tiendaId?: number,
    estado?: EstadoPedido,
    pagina = 1,
    limite = 20,
    estados?: EstadoPedido[],
    soloLibres?: boolean,
  ) {
    const where: Prisma.PedidoWhereInput = {};
    if (tiendaId) where.tiendaId = tiendaId;
    if (estados && estados.length > 0) {
      where.estado = { in: estados };
    } else if (estado) {
      where.estado = estado;
    } else {
      where.estado = {
        in: [EstadoPedido.PENDING_REVIEW, EstadoPedido.REVIEWING],
      };
    }
    if (soloLibres) {
      where.asignadoAId = null;
    }
    const skip = (pagina - 1) * limite;
    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
          asignadoA: { select: { id: true, nombre: true, apellido: true } },
        },
        orderBy: { fechaPedido: 'asc' },
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);
    const ahora = new Date();
    const data = pedidos.map((p: any) => ({
      ...p,
      asignadoANombre: asignadoANombre(p.asignadoA),
      // F12: minutos en manos del bodeguero (reloj de atención). Se pausa en
      // WAITING_CUSTOMER_APPROVAL. Para pedidos en cola (PENDING_REVIEW) el
      // reloj corre desde que se creó.
      minutosAtencionBodega: Math.floor(
        tiempoAtencionEn(
          {
            tiempoAtencionBodegaMs: p.tiempoAtencionBodegaMs,
            bodegaTurnoDesdeAt: p.bodegaTurnoDesdeAt,
          },
          ahora,
        ) / 60000,
      ),
    }));
    return {
      data,
      meta: { total, pagina, limite, totalPaginas: Math.ceil(total / limite) },
    };
  }

  async obtenerMisPedidosBodeguero(usuarioId: number, tiendaId?: number, max?: number) {
    const estadosEnProcesoBodega: EstadoPedido[] = ESTADOS_OCUPAN_SLOT_BODEGA;
    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where: {
          asignadoAId: usuarioId,
          estado: { in: estadosEnProcesoBodega },
          ...(tiendaId ? { tiendaId } : {}),
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
          // F12: reloj de atención del bodeguero (para urgencia correcta).
          tiempoAtencionBodegaMs: true,
          bodegaTurnoDesdeAt: true,
          _count: { select: { items: true } },
        },
        orderBy: { asignadoAt: 'asc' },
      }),
      this.prisma.pedido.count({
        where: {
          asignadoAId: usuarioId,
          estado: { in: estadosEnProcesoBodega },
          ...(tiendaId ? { tiendaId } : {}),
        },
      }),
    ]);

    const ahora = new Date();
    return {
      data: pedidos.map((p) => ({
        ...p,
        total: Number(p.total),
        // F12: minutos en manos del bodeguero usando el reloj de atención.
        // Se PAUSA en WAITING_CUSTOMER_APPROVAL (esperando al cliente).
        minutosEnProceso: Math.floor(
          tiempoAtencionEn(
            {
              tiempoAtencionBodegaMs: p.tiempoAtencionBodegaMs,
              bodegaTurnoDesdeAt: p.bodegaTurnoDesdeAt,
            },
            ahora,
          ) / 60000,
        ),
      })),
      meta: {
        total,
        limiteMaximo: max ?? 4,
        disponiblesParaTomar: Math.max(0, (max ?? 4) - total),
      },
    };
  }

  async tomarPedido(pedidoId: number, usuario: UserContext) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);

    if (pedido.asignadoAId !== null && pedido.asignadoAId !== usuario.userId) {
      const asignado = await this.prisma.usuario.findUnique({
        where: { id: pedido.asignadoAId },
        select: { nombre: true, apellido: true },
      });
      const nombreOtro =
        `${asignado?.nombre ?? ''} ${asignado?.apellido ?? ''}`.trim() ||
        'otro bodeguero';
      throw new ConflictException(
        `Este pedido ya fue tomado por ${nombreOtro}. Pide que lo libere o selecciona otro pedido.`,
      );
    }

    if (pedido.estado === EstadoPedido.REVIEWING) {
      // F12: atomicidad contra la carrera TOCTOU — dos bodegueros no pueden
      // tomar el mismo pedido liberado. updateMany con condición asignadoAId=null
      // garantiza que solo uno gana (count===1). Al retomar, el reloj de
      // atención sigue corriendo (bodegaTurnoDesdeAt se mantiene si ya corría).
      const result = await this.prisma.$transaction(async (tx) => {
        const actualizado = await tx.pedido.updateMany({
          where: { id: pedidoId, asignadoAId: null },
          data: {
            asignadoAId: usuario.userId,
            asignadoAt: new Date(),
            bodegaTurnoDesdeAt: new Date(),
          },
        });
        if (actualizado.count !== 1) {
          throw new ConflictException(
            'Este pedido ya fue tomado por otro bodeguero. Actualiza la pantalla.',
          );
        }
        await tx.historialPedido.create({
          data: {
            pedidoId,
            estadoAnterior: EstadoPedido.REVIEWING,
            estadoNuevo: EstadoPedido.REVIEWING,
            observacion: `Pedido retomado por ${usuario.nombre} (liberado previamente)`,
            usuarioId: usuario.userId,
            usuarioNombre: usuario.nombre,
          },
        });
        return tx.pedido.findUnique({ where: { id: pedidoId } });
      });
      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.asignado', {
        id: pedidoId,
        asignadoAId: usuario.userId,
        asignadoANombre: `${usuario.nombre}`,
      });
      return result;
    }

    const result = await this.state.cambiarEstado(
      pedidoId,
      { nuevoEstado: EstadoPedido.REVIEWING, observacion: 'Pedido tomado por bodega' },
      usuario,
    );

    this.realtime.emitToTienda(pedido.tiendaId, 'pedido.asignado', {
      id: pedidoId,
      asignadoAId: usuario.userId,
      asignadoANombre: `${usuario.nombre}`,
    });

    return result;
  }

  async liberarPedido(pedidoId: number, usuario: UserContext) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);

    const esAdmin = usuario.rol === RolUsuario.ADMIN;
    const esAsignado =
      usuario.rol === RolUsuario.BODEGA && pedido.asignadoAId === usuario.userId;

    if (!esAdmin && !esAsignado) {
      throw new BadRequestException(
        'Sólo el bodeguero asignado al pedido (o un admin) puede liberarlo.',
      );
    }

    // F12: se puede liberar desde REVIEWING (caso normal) o desde
    // WAITING_CUSTOMER_APPROVAL (cliente no respondió, bodeguero lo suelta a la
    // cola). En ambos casos el pedido vuelve a REVIEWING sin asignar y el reloj
    // de atención se reanuda (sigue siendo tarea de bodega).
    const liberable =
      pedido.estado === EstadoPedido.REVIEWING ||
      pedido.estado === EstadoPedido.WAITING_CUSTOMER_APPROVAL;
    if (!liberable) {
      throw new BadRequestException(
        `Sólo se puede liberar un pedido en REVIEWING o esperando cliente (actual: ${pedido.estado})`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const pedidoActualizado = await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          estado: EstadoPedido.REVIEWING,
          asignadoAId: null,
          asignadoAt: null,
          // F12: al liberar, el reloj sigue corriendo (es tarea de bodega).
          bodegaTurnoDesdeAt: new Date(),
        },
      });
      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: pedido.estado,
          estadoNuevo: EstadoPedido.REVIEWING,
          observacion:
            pedido.estado === EstadoPedido.WAITING_CUSTOMER_APPROVAL
              ? `Pedido liberado por ${usuario.nombre} (cliente no respondió la propuesta)`
              : `Pedido liberado por ${usuario.nombre}`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });
      this.logger.log(
        `Pedido ${pedidoId}: liberado por ${usuario.nombre} (volverá a estar disponible para tomar)`,
      );

      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.liberado', {
        id: pedidoId,
        numeroPedido: pedidoActualizado.numeroPedido,
        liberadoPor: usuario.nombre,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.liberado', { id: pedidoId });

      return pedidoActualizado;
    });
  }

  async marcarEnviado(pedidoId: number, usuario: UserContext) {
    await this.access.cargarYValidar(pedidoId, usuario, {
      requiereAsignacionBodega: true,
    });
    const pedidoCompleto = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { shippingDireccion: true },
    });
    if (!pedidoCompleto) {
      throw new NotFoundException('Pedido no encontrado');
    }
    if (!pedidoCompleto.shippingDireccion) {
      throw new BadRequestException(
        'Sólo los pedidos a domicilio pasan por "Enviado". Para pedidos de kiosko o web recoger en tienda, entrégalo desde el módulo Mostrador.',
      );
    }
    return this.state.cambiarEstado(
      pedidoId,
      { nuevoEstado: EstadoPedido.SHIPPED, observacion: 'Pedido enviado al cliente' },
      usuario,
    );
  }

  /**
   * F10 (ago 2026): lista pedidos en cola que comparten items con los
   * pedidos que el bodeguero autenticado tiene asignados. Alimenta el
   * banner "Surtir juntos" en /bodega.
   *
   * Algoritmo (mismos pesos que el monitor y que `calcularSimilaresParaPedido`
   * del surtido.service.ts, centralizados en `core/similitud.util.ts`):
   *
   *   1. Tomar los items NO cancelados de los pedidos del bodeguero.
   *   2. Buscar pedidos en PENDING_REVIEW o REVIEWING-sin-asignar de la
   *      misma tienda, distintos a los del bodeguero.
   *   3. Rankearlos con `rankearSimilares` (10/precioCO + 4/producto +
   *      1/minuto antigüedad, umbral 4, top 10).
   *   4. Para cada pedido rankeado, hidratar el detalle de items
   *      compartidos (qué producto, qué cantidad, con qué pedidos del
   *      bodeguero lo comparten) para que el frontend pueda renderizar
   *      el banner sin pedir más queries.
   *
   * Devuelve array vacío si el bodeguero no tiene pedidos asignados o si
   * ninguno tiene productos compartidos con la cola.
   */
  async obtenerSurtirJuntos(
    usuarioId: number,
    tiendaId?: number,
  ): Promise<SurtirJuntosPedidoDto[]> {
    if (!tiendaId) return [];

    // 1) Items de referencia: todos los no-cancelados de los pedidos del bodeguero.
    const pedidosDelBodeguero = await this.prisma.pedido.findMany({
      where: {
        asignadoAId: usuarioId,
        estado: {
          in: [
            EstadoPedido.REVIEWING,
            EstadoPedido.WAITING_CUSTOMER_APPROVAL,
          ],
        },
        tiendaId,
      },
      select: { id: true },
    });

    if (pedidosDelBodeguero.length === 0) return [];

    const itemsReferencia = await this.prisma.itemPedido.findMany({
      where: { pedidoId: { in: pedidosDelBodeguero.map((p) => p.id) }, cancelada: false },
      select: {
        pedidoId: true,
        productoId: true,
        precioCO: { select: { colorId: true } },
      },
    });
    if (itemsReferencia.length === 0) return [];

    // 2) Candidatos: cola abierta de la misma tienda, distintos a los del bodeguero.
    const idsDelBodeguero = new Set(pedidosDelBodeguero.map((p) => p.id));
    const candidatos = await this.prisma.pedido.findMany({
      where: {
        tiendaId,
        estado: {
          in: [EstadoPedido.PENDING_REVIEW, EstadoPedido.REVIEWING],
        },
        asignadoAId: null,
        id: { notIn: Array.from(idsDelBodeguero) },
      },
      select: {
        id: true,
        numeroPedido: true,
        clienteNombre: true,
        canalOrigen: true,
        fechaPedido: true,
        items: {
          where: { cancelada: false },
          select: {
            id: true,
            productoId: true,
            cantidad: true,
            precioCO: { select: { colorId: true } },
          },
        },
      },
      orderBy: { fechaPedido: 'asc' },
    });
    if (candidatos.length === 0) return [];

    // 3) Rankear con helper puro (mismo algoritmo que el monitor).
    const ranked = rankearSimilares(
      itemsReferencia.map((it) => ({
        productoId: it.productoId,
        colorId: it.precioCO?.colorId ?? null,
      })),
      candidatos.map((c) => ({
        id: c.id,
        numeroPedido: c.numeroPedido,
        fechaPedido: c.fechaPedido,
        items: c.items.map((it) => ({
          productoId: it.productoId,
          colorId: it.precioCO?.colorId ?? null,
        })),
      })),
      { top: TOP_LISTA },
    );
    if (ranked.length === 0) return [];

    // 4) Hidratar detalle para los N pedidos que pasaron el umbral.
    const rankedIds = new Set(ranked.map((r) => r.id));
    const candidatosDetalle = new Map(candidatos.map((c) => [c.id, c]));

    // Mapa productoId → nombre para enriquecer items compartidos sin un join extra.
    const productoIds = new Set<number>();
    const colorIds = new Set<number>();
    for (const r of ranked) {
      const c = candidatosDetalle.get(r.id);
      if (!c) continue;
      for (const it of c.items) {
        productoIds.add(it.productoId);
        if (it.precioCO?.colorId != null) colorIds.add(it.precioCO.colorId);
      }
    }
    const [productos, colores] = await Promise.all([
      this.prisma.producto.findMany({
        where: { id: { in: Array.from(productoIds) } },
        select: { id: true, nombre: true },
      }),
      this.prisma.color.findMany({
        where: { id: { in: Array.from(colorIds) } },
        select: { id: true, nombre: true, hex: true },
      }),
    ]);
    const productoNombreById = new Map(productos.map((p) => [p.id, p.nombre]));
    const colorById = new Map(colores.map((c) => [c.id, c]));

    // Mapa zona (productoId:colorId) → con qué pedidos del bodeguero la comparten.
    // zonaCompartidaConBodeguero.get(zonaKey) = Set<pedidoIdDelBodeguero>
    // Se construye en memoria desde itemsReferencia (ya cargado en bloque),
    // evitando una query por pedido del bodeguero (N+1).
    const zonaCompartidaConBodeguero = new Map<string, Set<number>>();
    for (const it of itemsReferencia) {
      const key = zonaKey(it.productoId, it.precioCO?.colorId ?? null);
      let s = zonaCompartidaConBodeguero.get(key);
      if (!s) {
        s = new Set();
        zonaCompartidaConBodeguero.set(key, s);
      }
      s.add(it.pedidoId);
    }

    const ahora = new Date();
    return ranked.map((r) => {
      const c = candidatosDetalle.get(r.id)!;
      const itemsCompartidos: SurtirJuntosPedidoDto['items'] = [];
      for (const it of c.items) {
        const color = it.precioCO?.colorId != null
          ? colorById.get(it.precioCO.colorId)
          : undefined;
        const key = zonaKey(it.productoId, it.precioCO?.colorId ?? null);
        const compartidoCon = zonaCompartidaConBodeguero.get(key);
        if (!compartidoCon || compartidoCon.size === 0) continue;
        itemsCompartidos.push({
          productoId: it.productoId,
          productoNombre: productoNombreById.get(it.productoId) ?? '(producto)',
          cantidad: it.cantidad,
          colorId: color?.id ?? null,
          colorNombre: color?.nombre ?? null,
          colorHex: color?.hex ?? null,
          pedidosCompartidosCon: Array.from(compartidoCon),
        });
      }
      return {
        id: r.id,
        numeroPedido: r.numeroPedido,
        clienteNombre: c.clienteNombre,
        canalOrigen: c.canalOrigen,
        minutosEnCola: Math.floor(
          (ahora.getTime() - c.fechaPedido.getTime()) / 60000,
        ),
        itemsCompartidos: r.itemsCompartidos,
        score: r.score,
        items: itemsCompartidos,
      };
    });
  }

  /**
   * F12 (sep 2026): agrupa la COLA de bodega (PENDING_REVIEW + REVIEWING sin
   * asignar) en clusters de pedidos que comparten zona (producto+color).
   *
   * A diferencia de `obtenerSurtirJuntos` (que parte de los pedidos del
   * bodeguero), esto sugiere desde la cola SIN requerir selección previa: el
   * bodeguero ve qué pedidos conviene tomar juntos desde que entran.
   *
   * Devuelve clusters con >= 2 pedidos. Cada cluster trae `grupoId` (estable)
   * para que el frontend marque los pedidos que se surten juntos.
   */
  async obtenerSurtirJuntosCola(tiendaId?: number) {
    if (!tiendaId) return [];

    const pedidos = await this.prisma.pedido.findMany({
      where: {
        tiendaId,
        OR: [
          { estado: EstadoPedido.PENDING_REVIEW },
          { estado: EstadoPedido.REVIEWING, asignadoAId: null },
        ],
      },
      select: {
        id: true,
        numeroPedido: true,
        clienteNombre: true,
        canalOrigen: true,
        fechaPedido: true,
        items: {
          where: { cancelada: false },
          select: {
            productoId: true,
            precioCO: { select: { colorId: true } },
          },
        },
      },
      orderBy: { fechaPedido: 'asc' },
    });

    const paraAgrupar: PedidoColaParaAgrupar[] = pedidos.map((p) => ({
      id: p.id,
      numeroPedido: p.numeroPedido,
      clienteNombre: p.clienteNombre,
      canalOrigen: p.canalOrigen,
      fechaPedido: p.fechaPedido,
      items: p.items.map((it) => ({
        productoId: it.productoId,
        colorId: it.precioCO?.colorId ?? null,
      })),
    }));

    const clusters = agruparColaPorZonaCompartida(paraAgrupar);

    // Hidratar nombre de producto y color para cada zona compartida.
    const zonas = new Set<string>();
    for (const c of clusters) for (const z of c.zonasCompartidas) zonas.add(z);
    const productoIds = new Set<number>();
    const colorIds = new Set<number>();
    for (const z of zonas) {
      const [pid, cid] = z.split(':');
      const pn = parseInt(pid, 10);
      if (!isNaN(pn)) productoIds.add(pn);
      const cn = parseInt(cid, 10);
      if (!isNaN(cn)) colorIds.add(cn);
    }
    const [productos, colores] = await Promise.all([
      this.prisma.producto.findMany({
        where: { id: { in: Array.from(productoIds) } },
        select: { id: true, nombre: true },
      }),
      this.prisma.color.findMany({
        where: { id: { in: Array.from(colorIds) } },
        select: { id: true, nombre: true, hex: true },
      }),
    ]);
    const productoNombreById = new Map(productos.map((p) => [p.id, p.nombre]));
    const colorById = new Map(colores.map((c) => [c.id, c]));

    return clusters.map((c) => ({
      grupoId: c.grupoId,
      zonasCompartidas: c.zonasCompartidas.map((z) => {
        const [pid, cid] = z.split(':');
        const pn = parseInt(pid, 10);
        const cn = parseInt(cid, 10);
        const color = !isNaN(cn) ? colorById.get(cn) : undefined;
        return {
          productoId: pn,
          productoNombre: productoNombreById.get(pn) ?? '(producto)',
          colorId: !isNaN(cn) ? cn : null,
          colorNombre: color?.nombre ?? null,
          colorHex: color?.hex ?? null,
        };
      }),
      pedidos: c.pedidos.map((p) => ({
        id: p.id,
        numeroPedido: p.numeroPedido,
        clienteNombre: p.clienteNombre,
        canalOrigen: p.canalOrigen,
        minutosEnCola: Math.floor(
          (new Date().getTime() - p.fechaPedido.getTime()) / 60000,
        ),
      })),
    }));
  }

  /**
   * F11 (ago 2026): batch de surtido del bodeguero. Devuelve todos los items
   * de sus pedidos asignados agrupados por ZONA (producto+color), para que
   * pueda surtir varios pedidos a la vez sin navegar entre ellos: va una sola
   * vez a cada zona de la bodega y agarra las tallas de todos los pedidos.
   *
   * Devuelve `{ zonas, pedidos }` — `zonas` para el picking agrupado y
   * `pedidos` con el resumen por pedido para confirmar cada uno.
   */
  async obtenerLoteSurtirJuntos(
    usuarioId: number,
    tiendaId?: number,
  ): Promise<LoteSurtirJuntosDto> {
    const estadosEnLote: EstadoPedido[] = [
      EstadoPedido.REVIEWING,
      EstadoPedido.WAITING_CUSTOMER_APPROVAL,
    ];

    const pedidos = await this.prisma.pedido.findMany({
      where: {
        asignadoAId: usuarioId,
        estado: { in: estadosEnLote },
        ...(tiendaId ? { tiendaId } : {}),
      },
      select: {
        id: true,
        numeroPedido: true,
        clienteNombre: true,
        estado: true,
        total: true,
        items: {
          where: { cancelada: false },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            productoId: true,
            productoNombre: true,
            tallaNombre: true,
            corridaNombre: true,
            cantidad: true,
            cantidadSurtida: true,
            estadoSurtido: true,
            motivoSurtido: true,
            precioCO: {
              select: {
                colorId: true,
                color: { select: { id: true, nombre: true, hex: true } },
              },
            },
          },
        },
      },
      orderBy: { asignadoAt: 'asc' },
    });

    if (pedidos.length === 0) {
      return { zonas: [], pedidos: [] };
    }

    // Agrupar items por zona (productoId:colorId). Si el item no tiene colorId,
    // usamos colorNombre como fallback para no perder el agrupamiento.
    const zonasMap = new Map<string, ZonaLoteDto>();

    for (const p of pedidos) {
      for (const it of p.items) {
        const color = it.precioCO?.color ?? null;
        const colorId = color?.id ?? null;
        const colorNombre = color?.nombre ?? null;
        const key = zonaKey(it.productoId, colorId, colorNombre);

        let zona = zonasMap.get(key);
        if (!zona) {
          zona = {
            productoId: it.productoId,
            productoNombre: it.productoNombre,
            colorId,
            colorNombre,
            colorHex: color?.hex ?? null,
            items: [],
          };
          zonasMap.set(key, zona);
        }
        zona.items.push({
          itemId: it.id,
          pedidoId: p.id,
          numeroPedido: p.numeroPedido,
          tallaNombre: it.tallaNombre,
          corridaNombre: it.corridaNombre,
          cantidad: it.cantidad,
          cantidadSurtida: it.cantidadSurtida,
          estadoSurtido: it.estadoSurtido,
          motivoSurtido: it.motivoSurtido,
        });
      }
    }

    const zonas = Array.from(zonasMap.values()).sort((a, b) =>
      a.productoNombre.localeCompare(b.productoNombre),
    );

    return {
      zonas,
      pedidos: pedidos.map((p) => ({
        id: p.id,
        numeroPedido: p.numeroPedido,
        clienteNombre: p.clienteNombre,
        estado: p.estado,
        total: Number(p.total),
      })),
    };
  }

  /**
   * F11 (ago 2026): toma un grupo de pedidos similares ("surtir juntos") de
   * una sola vez. Valida el límite de pedidos simultáneos y que ninguno esté
   * asignado a otro bodeguero. Cada pedido sigue el mismo patrón que
   * `tomarPedido`: PENDING_REVIEW → REVIEWING + asignación, o REVIEWING
   * libre → asignación.
   */
  async tomarGrupo(ids: number[], usuario: UserContext) {
    if (ids.length === 0) {
      throw new BadRequestException('Debes indicar al menos un pedido.');
    }
    const idsUnicos = Array.from(new Set(ids));

    // Cargar los pedidos de la tienda del bodeguero.
    const pedidos = await this.prisma.pedido.findMany({
      where: {
        id: { in: idsUnicos },
        tiendaId: usuario.tiendaId,
      },
      select: { id: true, tiendaId: true, estado: true, asignadoAId: true },
    });

    const encontrados = new Set(pedidos.map((p) => p.id));
    const faltantes = idsUnicos.filter((id) => !encontrados.has(id));
    if (faltantes.length > 0) {
      throw new NotFoundException(
        `Pedido(s) no encontrados en tu tienda: ${faltantes.join(', ')}`,
      );
    }

    // Ninguno debe estar asignado a otro bodeguero.
    const asignadoAOtro = pedidos.find(
      (p) => p.asignadoAId != null && p.asignadoAId !== usuario.userId,
    );
    if (asignadoAOtro) {
      throw new ConflictException(
        `El pedido ${asignadoAOtro.id} ya fue tomado por otro bodeguero.`,
      );
    }

    // Validar límite de pedidos simultáneos.
    const yaTomados = pedidos.filter((p) => p.asignadoAId === usuario.userId).length;
    const aTomar = idsUnicos.length - yaTomados;
    const actuales = await this.prisma.pedido.count({
      where: {
        asignadoAId: usuario.userId,
        estado: { in: ESTADOS_OCUPAN_SLOT_BODEGA },
      },
    });
    if (actuales + aTomar > MAX_PEDIDOS_POR_BODEGUERO) {
      const faltan = actuales + aTomar - MAX_PEDIDOS_POR_BODEGUERO;
      throw new BadRequestException(
        `El grupo excede el límite de ${MAX_PEDIDOS_POR_BODEGUERO} pedidos simultáneos. ` +
          `Libera ${faltan} espacio(s) (finaliza o libera un pedido) antes de agregar este grupo.`,
      );
    }

    const tomados = await this.prisma.$transaction(async (tx) => {
      // F12: re-validar el límite DENTRO de la transacción (el conteo previo
      // fuera de ella es una carrera: otro bodeguero pudo tomar pedidos entre
      // el count y la asignación). Contamos los slots ocupados por este
      // bodeguero en el momento de la escritura.
      const actualesTx = await tx.pedido.count({
        where: {
          asignadoAId: usuario.userId,
          estado: { in: ESTADOS_OCUPAN_SLOT_BODEGA },
        },
      });
      if (actualesTx + aTomar > MAX_PEDIDOS_POR_BODEGUERO) {
        const faltan = actualesTx + aTomar - MAX_PEDIDOS_POR_BODEGUERO;
        throw new BadRequestException(
          `El grupo excede el límite de ${MAX_PEDIDOS_POR_BODEGUERO} pedidos simultáneos. ` +
            `Libera ${faltan} espacio(s) (finaliza o libera un pedido) antes de agregar este grupo.`,
        );
      }

      const resultado: Array<{ id: number }> = [];
      for (const pedido of pedidos) {
        // Saltar los que ya son del bodeguero (defensa; no deberían venir en candidatos).
        if (pedido.asignadoAId === usuario.userId) continue;

        // F12: atomicidad contra la carrera TOCTOU — updateMany con condición
        // asignadoAId=null garantiza que solo un bodeguero gana cada pedido.
        const res = await tx.pedido.updateMany({
          where: { id: pedido.id, asignadoAId: null },
          data: {
            estado: EstadoPedido.REVIEWING,
            asignadoAId: usuario.userId,
            asignadoAt: new Date(),
            bodegaTurnoDesdeAt: new Date(),
          },
        });
        if (res.count !== 1) {
          throw new ConflictException(
            `El pedido ${pedido.id} ya fue tomado por otro bodeguero. Actualiza la pantalla.`,
          );
        }
        await tx.historialPedido.create({
          data: {
            pedidoId: pedido.id,
            estadoAnterior: pedido.estado,
            estadoNuevo: EstadoPedido.REVIEWING,
            observacion: `Pedido tomado en grupo por ${usuario.nombre}`,
            usuarioId: usuario.userId,
            usuarioNombre: usuario.nombre,
          },
        });
        resultado.push({ id: pedido.id });
      }
      return resultado;
    });

    for (const p of tomados) {
      this.realtime.emitToTienda(pedidos.find((x) => x.id === p.id)!.tiendaId, 'pedido.asignado', {
        id: p.id,
        asignadoAId: usuario.userId,
        asignadoANombre: usuario.nombre,
      });
    }

    return tomados;
  }
}
