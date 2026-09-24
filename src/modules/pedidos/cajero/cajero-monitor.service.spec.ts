import { EstadoPedido, ModoEntrega, CanalOrigen } from '@prisma/client';
import { CajeroMonitorService } from './cajero-monitor.service';

/**
 * F16 (sep 2026): tests del monitor de cajero tras el cambio de flujo.
 *
 * Dos reglas que se rompen en silencio si alguien las toca:
 *   1. Ya NO filtra por canal (los pedidos web se cobran aquí).
 *   2. Excluye los pedidos a DOMICILIO (no se cobran en ventanilla).
 *   3. Ya NO calcula urgencia (decisión D13).
 */

/** Prisma mockeado: captura los `where` que construye el service. */
function crearServicio() {
  const pedidoFindMany = jest.fn().mockResolvedValue([]);

  const prisma = {
    tienda: {
      findUnique: jest.fn().mockResolvedValue({ id: 5, nombre: 'Tienda Test' }),
    },
    ventanilla: { findMany: jest.fn().mockResolvedValue([]) },
    pedido: { findMany: pedidoFindMany },
  };

  return { svc: new CajeroMonitorService(prisma as never), pedidoFindMany };
}

describe('CajeroMonitorService — sin candado de canal (F16)', () => {
  it('la cola sin asignar NO filtra por canalOrigen', async () => {
    const { svc, pedidoFindMany } = crearServicio();
    await svc.obtenerMonitorCajero(5);
    const where = pedidoFindMany.mock.calls[0][0].where;
    // Antes: `canalOrigen: CanalOrigen.KIOSKO` — escondía los pedidos web.
    expect(where).not.toHaveProperty('canalOrigen');
    expect(where.estado).toBe(EstadoPedido.PENDING_PAID);
    expect(where.cajeroAsignadoId).toBeNull();
  });

  it('la cola sin asignar excluye los pedidos a DOMICILIO', async () => {
    const { svc, pedidoFindMany } = crearServicio();
    await svc.obtenerMonitorCajero(5);
    const where = pedidoFindMany.mock.calls[0][0].where;
    // Al quitar el filtro de KIOSKO, los domicilio dejarían de estar excluidos
    // de facto; hay que excluirlos explícitamente.
    expect(where.modoEntrega).toEqual({ not: ModoEntrega.DOMICILIO });
  });

  it('el snapshot no expone nivelUrgencia ni alertasCriticas (D13)', async () => {
    const { svc } = crearServicio();
    const snap = await svc.obtenerMonitorCajero(5);
    expect(snap.contadores).not.toHaveProperty('alertasCriticas');
    expect(Object.keys(snap.contadores).sort()).toEqual(
      ['cajerosLogueados', 'colaSinAsignar', 'totalEnCaja'].sort(),
    );
  });

  it('conserva minutosEnCola como dato informativo', async () => {
    const { svc, pedidoFindMany } = crearServicio();
    // Un pedido en la cola, para que el mapeo corra.
    pedidoFindMany.mockResolvedValueOnce([
      { id: 1, numeroPedido: 'PD-2026-000001', fechaPedido: new Date(Date.now() - 12 * 60_000) },
    ]);
    const snap = await svc.obtenerMonitorCajero(5);
    const fila = snap.colaSinAsignar[0];
    expect(fila.minutosEnCola).toBeGreaterThanOrEqual(11);
    // Pero NO se traduce a urgencia.
    expect(fila).not.toHaveProperty('nivelUrgencia');
  });

  it('lanza 400 si el usuario no tiene tienda', async () => {
    const { svc } = crearServicio();
    await expect(svc.obtenerMonitorCajero(0)).rejects.toThrow(/tienda asignada/i);
  });
});
