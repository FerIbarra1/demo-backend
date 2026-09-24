import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EstadoPedido, ModoEntrega } from '@prisma/client';
import { minutosEntre } from '../core/urgencia.util';

/**
 * Monitor de ventanillas (jun 2026): snapshot por VENTANILLA (1, 2, 3…)
 * de la tienda, con sus pedidos en PENDING_PAID asignados y la cola
 * sin asignar ("Turnos siguientes").
 *
 * F11 (ago 2026): cada ventanilla tiene un número físico (1..N) definido
 * por el admin. La snapshot agrupa pedidos por la FK `cajeroAsignadoId`
 * que matchea con el `cajeroId` de la ventanilla. Si la ventanilla no tiene
 * cajero asignado (libre), aparece igual con `cajeroId: null` y
 * `pedidosAsignados: 0`.
 *
 * F16 (sep 2026): dos cambios de fondo.
 *   1. Ya NO filtra por canal. Antes solo veía pedidos KIOSKO, y con el flujo
 *      nuevo los web también llegan a caja (mostrador los libera). Se excluyen
 *      los pedidos a DOMICILIO, que no se cobran en ventanilla.
 *   2. Ya NO calcula urgencia (decisión D13). En caja el pedido espera al
 *      CLIENTE, no al revés: marcar "crítico" un pedido cuyo cliente aún no
 *      llega es ruido. Los relojes de urgencia viven solo en bodega.
 *
 * El TV consume este endpoint cada 5s y muestra ventanillas + cola.
 */
@Injectable()
export class CajeroMonitorService {
  constructor(private prisma: PrismaService) {}

  async obtenerMonitorCajero(tiendaId: number) {
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

    // 1) Todas las ventanillas activas de la tienda (incluidas las libres).
    const ventanillasRaw = await this.prisma.ventanilla.findMany({
      where: { tiendaId, activa: true },
      include: {
        cajero: {
          select: {
            id: true,
            nombre: true,
            apellido: true,
            lastLogin: true,
          },
        },
      },
      orderBy: { numero: 'asc' },
    });

    const ventanaLogueoMs = 12 * 60 * 60 * 1000;
    const limiteLogueo = new Date(ahora.getTime() - ventanaLogueoMs);

    const ventanillas = await Promise.all(
      ventanillasRaw.map(async (v) => {
        // Sólo se listan los pedidos del cajero si está "activo" (logueado en
        // las últimas 12h). Si está libre o inactivo, la sección aparece vacía.
        const cajeroActivo =
          v.cajero !== null && v.cajero.lastLogin !== null && v.cajero.lastLogin >= limiteLogueo;
        const pedidosRaw = cajeroActivo
          ? await this.prisma.pedido.findMany({
              where: {
                estado: EstadoPedido.PENDING_PAID,
                cajeroAsignadoId: v.cajeroId,
                // F16: sin filtro de canal (los web también se cobran aquí).
                modoEntrega: { not: ModoEntrega.DOMICILIO },
              },
              select: {
                id: true,
                numeroPedido: true,
                cajeroAsignadoAt: true,
                fechaPedido: true,
              },
              orderBy: { cajeroAsignadoAt: 'asc' },
            })
          : [];

        const detallePedidos = pedidosRaw.map((p) => {
          const minutosAsignado = p.cajeroAsignadoAt
            ? minutosEntre(p.cajeroAsignadoAt, ahora)
            : null;
          const minutos = minutosAsignado ?? minutosEntre(p.fechaPedido, ahora);
          return {
            id: p.id,
            numeroPedido: p.numeroPedido,
            cajeroAsignadoAt: p.cajeroAsignadoAt ? p.cajeroAsignadoAt.toISOString() : null,
            // Dato informativo, NO urgencia (decisión D13).
            minutosEnCola: minutos,
            cajeroAsignadoNombre: v.cajero
              ? `${v.cajero.nombre}${v.cajero.apellido ? ' ' + v.cajero.apellido : ''}`
              : null,
          };
        });

        return {
          ventanillaId: v.id,
          numero: v.numero,
          cajeroId: v.cajeroId,
          cajeroNombre: v.cajero
            ? `${v.cajero.nombre}${v.cajero.apellido ? ' ' + v.cajero.apellido : ''}`
            : null,
          cajeroActivo,
          pedidosAsignados: pedidosRaw.length,
          detallePedidos,
        };
      }),
    );

    // 2) Cola sin asignar (PENDING_PAID + cajeroAsignadoId null).
    // F16: sin filtro de canal; se excluyen los domicilio (no se cobran en
    // ventanilla).
    const colaRaw = await this.prisma.pedido.findMany({
      where: {
        tiendaId,
        estado: EstadoPedido.PENDING_PAID,
        modoEntrega: { not: ModoEntrega.DOMICILIO },
        cajeroAsignadoId: null,
      },
      select: {
        id: true,
        numeroPedido: true,
        fechaPedido: true,
      },
      orderBy: { fechaPedido: 'asc' },
    });

    const colaSinAsignar = colaRaw.map((p) => {
      const minutos = minutosEntre(p.fechaPedido, ahora);
      return {
        id: p.id,
        numeroPedido: p.numeroPedido,
        cajeroAsignadoAt: null,
        // Dato informativo, NO urgencia (decisión D13).
        minutosEnCola: minutos,
        cajeroAsignadoNombre: null,
      };
    });

    const totalEnCaja = ventanillas.reduce((acc, v) => acc + v.pedidosAsignados, 0);

    return {
      timestamp: ahora.toISOString(),
      tiendaId: tienda.id,
      tiendaNombre: tienda.nombre,
      ventanillas,
      contadores: {
        cajerosLogueados: ventanillas.length,
        colaSinAsignar: colaSinAsignar.length,
        totalEnCaja,
        // F16: `alertasCriticas` se eliminó (decisión D13). Contaba pedidos
        // con más de 10 min en cola, pero en caja el pedido espera al CLIENTE:
        // un pedido esperando no es un problema del cajero, y marcar urgencia
        // ahí era ruido. Los relojes de urgencia viven solo en bodega.
      },
      colaSinAsignar,
    };
  }
}
