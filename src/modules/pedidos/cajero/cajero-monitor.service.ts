import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EstadoPedido, ModoEntrega } from '@prisma/client';
import { operadorActivo } from '../core/estacion.util';
import { SELECT_ORDEN_COLA_CAJA, ordenarFilaDeCaja, whereFilaDeCaja } from '../core/cola-caja.util';
import { turnoCorto } from '../../pedidos/core/folio-erp.util';

/**
 * Monitor de ventanillas (jun 2026): snapshot por VENTANILLA (1, 2, 3…)
 * de la tienda, con sus pedidos en PENDIENTE_PAGO asignados y la cola
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
 *
 * Oct 2026 (16-oct, §9.4): REDUCIDO A FOLIO + NÚMEROS. La TV es una pantalla PÚBLICA y este payload
 * viaja hasta su navegador. Cada pedido traía además la hora en que se asignó, los minutos en cola
 * y el nombre del cajero —y cada ventanilla el id del usuario—: la TV no pinta nada de eso. Ahora
 * sale solo el folio y los números de ventanilla; el cajero de la ventanilla (personal, no cliente)
 * es lo único con nombre, porque la tarjeta lo muestra. Los minutos en cola y demás viven en la
 * consola de caja, autenticada.
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
            ultimoHeartbeat: true,
          },
        },
      },
      orderBy: { numero: 'asc' },
    });

    const ventanillas = await Promise.all(
      ventanillasRaw.map(async (v) => {
        // Solo se listan los pedidos del cajero si está "activo": con señal de vida (sesión o
        // latido) en los últimos 15 min (`core/estacion.util.ts`). Oct 2026: antes eran 12 HORAS, y
        // una ventanilla cuyo cajero cerró la pestaña se quedaba "Esperando cliente" medio día.
        // Si está libre o inactivo, la sección aparece vacía (la TV la pinta "Cerrada").
        const cajeroActivo = operadorActivo(v.cajero, ahora);
        const pedidosRaw = cajeroActivo
          ? await this.prisma.pedido.findMany({
              where: {
                estado: EstadoPedido.PENDIENTE_PAGO,
                cajeroAsignadoId: v.cajeroId,
                // F16: sin filtro de canal (los web también se cobran aquí).
                modoEntrega: { not: ModoEntrega.DOMICILIO },
              },
              select: { id: true, numeroPedido: true, folioErp: true },
              orderBy: { cajeroAsignadoAt: 'asc' },
            })
          : [];

        const detallePedidos = pedidosRaw.map((p) => ({
          id: p.id,
          numeroPedido: p.numeroPedido,
          turno: turnoCorto(p.folioErp),
        }));

        return {
          ventanillaId: v.id,
          numero: v.numero,
          cajeroNombre: v.cajero
            ? `${v.cajero.nombre}${v.cajero.apellido ? ' ' + v.cajero.apellido : ''}`
            : null,
          cajeroActivo,
          pedidosAsignados: pedidosRaw.length,
          detallePedidos,
        };
      }),
    );

    // 2) Cola sin asignar (PENDIENTE_PAGO + cajeroAsignadoId null).
    // F16: sin filtro de canal; se excluyen los domicilio (no se cobran en
    // ventanilla).
    //
    // Oct 2026: es la MISMA fila y el MISMO orden de turno que la consola (`cola-caja.util.ts`): las
    // transferencias ya verificadas primero, luego quien llegó antes a caja. Antes se listaban por
    // `fechaPedido`, así que la TV mostraba un orden distinto al que seguía la cajera.
    //
    // Y aparecen TODOS los de tienda en PENDIENTE_PAGO, de inmediato, paguen en caja o por
    // transferencia y esté o no validada (decisión del dueño, 16-oct; sin `WHERE_COBRABLE`). Una
    // primera versión ocultaba a quien esperaba a Tesorería, y el cliente que mostrador acababa de
    // mandar a pagar no se veía en la pared: no sabía si su turno había entrado. La TV es pública:
    // no distingue cómo paga cada quien, solo el folio. Domicilio nunca (`whereFilaDeCaja`).
    const colaRaw = await this.prisma.pedido.findMany({
      where: whereFilaDeCaja(tiendaId),
      select: { ...SELECT_ORDEN_COLA_CAJA, numeroPedido: true, folioErp: true },
    });

    const colaSinAsignar = ordenarFilaDeCaja(colaRaw).map((p) => ({
      id: p.id,
      numeroPedido: p.numeroPedido,
      turno: turnoCorto(p.folioErp),
    }));

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
