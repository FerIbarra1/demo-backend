import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EstadoPedido, Prisma } from '@prisma/client';
import { ORDEN_COLA, wherePresente } from '../pedidos/core/presencia.util';
import {
  MonitorMostradorResponseDto,
  MonitorMostradorPedidoDto,
  MonitorMostradorPuestoDto,
} from './dto/monitor-mostrador.dto';
import { operadorActivo } from '../pedidos/core/estacion.util';

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
 *
 * Oct 2026: por PUESTOS (una tarjeta por mostrador, como la TV de caja) y reducido a folio +
 * números (ver `monitor-mostrador.dto.ts`). Se quitaron los contadores `listosParaEntregar` y
 * `sinCliente` y la lista de "sin recoger": la TV nunca los pintó, y llevaban nombres de clientes
 * a una pantalla pública. La consola del operador los obtiene de sus propios endpoints
 * (`/pedidos/mostrador/listos` y `/sin-aviso`).
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
      // F22: la regla única de presencia (`presencia.util.ts`): kiosko salvo que se
      // haya descartado, web con aviso vigente.
      ...wherePresente(),
    };

    // F16/F17: el panel "Atendiendo" son los pedidos que el operador ya mandó a
    // llamar. Se consultan aparte de la cola (y no con un filtro en memoria)
    // porque la cola está paginada por el orden de llamada: si se colaran ahí,
    // el cliente ya llamado seguiría viéndose en la lista de espera.
    //
    // F17: el discriminador es el ESTADO (`EN_ATENCION`), no `llamadoAt`. Antes
    // el panel era `llamadoAt IS NOT NULL` sobre REVISADO, lo que obligaba a
    // recordar el filtro en cada query y hacía indistinguibles "llamado" y "en
    // el área de entrega". El gate de presencia se conserva: un pedido sin cliente
    // no debe aparecer ni en "Atendiendo".
    const whereAtendiendo: Prisma.PedidoWhereInput = {
      tiendaId,
      estado: EstadoPedido.EN_ATENCION,
      ...wherePresente(),
    };

    // Oct 2026 (§9.4): la TV es PÚBLICA, así que cada consulta trae SOLO lo que la pantalla
    // dibuja —el folio y a qué mostrador pasar—, no nombre, canal, monto ni fechas del cliente.
    const [colaRaw, atendiendoRaw, mostradoresRaw] = await Promise.all([
      this.prisma.pedido.findMany({
        // La cola es solo REVISADO: un pedido ya llamado está en EN_ATENCION,
        // así que el estado por sí solo lo excluye.
        where: whereCola,
        select: { id: true, numeroPedido: true },
        // F22: "primero llegado, primero atendido" — el orden de llamada es el de
        // `ORDEN_COLA`, el MISMO de la consola y de `llamarSiguiente`.
        orderBy: ORDEN_COLA,
      }),
      // F16: panel "Atendiendo" — los llamados, del más reciente al más viejo
      // (el último llamado es el que está enfrente del mostrador ahora mismo).
      this.prisma.pedido.findMany({
        where: whereAtendiendo,
        select: {
          id: true,
          numeroPedido: true,
          llamadoMostradorId: true,
          // F22: a qué mostrador pasa el cliente.
          llamadoMostrador: { select: { numero: true } },
        },
        orderBy: [{ llamadoAt: 'desc' }, { id: 'desc' }],
      }),
      // Oct 2026: los puestos de la tienda (la TV es como la de caja: una tarjeta por mostrador).
      this.prisma.mostrador.findMany({
        where: { tiendaId, activa: true },
        include: {
          operador: {
            select: { nombre: true, apellido: true, lastLogin: true, ultimoHeartbeat: true },
          },
        },
        orderBy: { numero: 'asc' },
      }),
    ]);

    const cola: MonitorMostradorPedidoDto[] = colaRaw.map((p) => ({
      id: p.id,
      numeroPedido: p.numeroPedido,
      mostradorNumero: null,
    }));
    const atendiendo: MonitorMostradorPedidoDto[] = atendiendoRaw.map((p) => ({
      id: p.id,
      numeroPedido: p.numeroPedido,
      mostradorNumero: p.llamadoMostrador?.numero ?? null,
    }));

    // Oct 2026: lo llamado se reparte por mostrador. Quien tiene el folio es el puesto desde el que
    // se llamó; un llamado sin puesto válido va aparte (`sinMostrador`) para no desaparecer.
    const porPuesto = new Map<number, MonitorMostradorPedidoDto[]>();
    const sinMostrador: MonitorMostradorPedidoDto[] = [];
    const ids = new Set(mostradoresRaw.map((m) => m.id));
    atendiendoRaw.forEach((raw, i) => {
      const dto = atendiendo[i];
      if (raw.llamadoMostradorId !== null && ids.has(raw.llamadoMostradorId)) {
        const lista = porPuesto.get(raw.llamadoMostradorId) ?? [];
        lista.push(dto);
        porPuesto.set(raw.llamadoMostradorId, lista);
      } else {
        sinMostrador.push(dto);
      }
    });
    const mostradores: MonitorMostradorPuestoDto[] = mostradoresRaw.map((m) => ({
      mostradorId: m.id,
      numero: m.numero,
      operadorNombre: m.operador
        ? `${m.operador.nombre}${m.operador.apellido ? ' ' + m.operador.apellido : ''}`
        : null,
      // "Abierto" = operador con señales de vida en los últimos 15 min (`core/estacion.util.ts`).
      abierto: operadorActivo(m.operador, ahora),
      atendiendo: porPuesto.get(m.id) ?? [],
    }));

    return {
      timestamp: ahora.toISOString(),
      tiendaId: tienda.id,
      tiendaNombre: tienda.nombre,
      cola,
      atendiendo,
      mostradores,
      sinMostrador,
      contadores: { enCola: cola.length, atendiendo: atendiendo.length },
    };
  }
}
