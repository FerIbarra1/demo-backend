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
function crearServicio(ventanillas: unknown[] = []) {
  const pedidoFindMany = jest.fn().mockResolvedValue([]);

  const prisma = {
    tienda: {
      findUnique: jest.fn().mockResolvedValue({ id: 5, nombre: 'Tienda Test' }),
    },
    ventanilla: { findMany: jest.fn().mockResolvedValue(ventanillas) },
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
    expect(where.estado).toBe(EstadoPedido.PENDIENTE_PAGO);
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

  it('la cola sin asignar NO oculta a quien espera una transferencia (16-oct): se ve de inmediato', async () => {
    const { svc, pedidoFindMany } = crearServicio();
    await svc.obtenerMonitorCajero(5);
    const where = pedidoFindMany.mock.calls[0][0].where;
    // `WHERE_COBRABLE` (`pagosTransferencia: { none: … }`) la dejaba fuera hasta que Tesorería
    // verificaba, y el cliente recién mandado a pagar no aparecía en la pared.
    expect(where).not.toHaveProperty('pagosTransferencia');
  });

  it('el snapshot no expone nivelUrgencia ni alertasCriticas (D13)', async () => {
    const { svc } = crearServicio();
    const snap = await svc.obtenerMonitorCajero(5);
    expect(snap.contadores).not.toHaveProperty('alertasCriticas');
    expect(Object.keys(snap.contadores).sort()).toEqual(
      ['cajerosLogueados', 'colaSinAsignar', 'totalEnCaja'].sort(),
    );
  });

  it('con folio del Sistema Comercial la TV recibe SOLO los últimos 4 dígitos (el folio completo no viaja)', async () => {
    const { svc, pedidoFindMany } = crearServicio();
    pedidoFindMany.mockResolvedValueOnce([
      {
        id: 1,
        numeroPedido: 'PD-2026-000001',
        folioErp: '0000152573',
        fechaPedido: new Date(Date.now() - 12 * 60_000),
        colaCajaDesdeAt: null,
        esperaValidacionDesdeAt: null,
        pagosTransferencia: [],
      },
    ]);
    const snap = await svc.obtenerMonitorCajero(5);
    expect(snap.colaSinAsignar[0]).toEqual({
      id: 1,
      numeroPedido: 'PD-2026-000001',
      turno: '2573',
    });
    expect(JSON.stringify(snap)).not.toContain('0000152573');
  });

  it('la TV es pública: cada turno sale con folio y NADA más (§9.4)', async () => {
    const { svc, pedidoFindMany } = crearServicio();
    // Un pedido en la cola, para que el mapeo corra.
    pedidoFindMany.mockResolvedValueOnce([
      {
        id: 1,
        numeroPedido: 'PD-2026-000001',
        fechaPedido: new Date(Date.now() - 12 * 60_000),
        colaCajaDesdeAt: null,
        esperaValidacionDesdeAt: null,
        pagosTransferencia: [],
      },
    ]);
    const snap = await svc.obtenerMonitorCajero(5);
    // Antes salían también `minutosEnCola`, `cajeroAsignadoAt` y `cajeroAsignadoNombre`: la pantalla
    // no los pinta, pero viajaban al navegador de la pared. Y tampoco hay urgencia (D13).
    expect(snap.colaSinAsignar[0]).toEqual({ id: 1, numeroPedido: 'PD-2026-000001', turno: null });
  });

  it('la ventanilla no expone el id del usuario del cajero, pero sí su nombre (la tarjeta lo muestra)', async () => {
    const { svc, pedidoFindMany } = crearServicio([
      {
        id: 1,
        numero: 1,
        cajeroId: 9,
        cajero: {
          id: 9,
          nombre: 'Ana',
          apellido: 'Ruiz',
          lastLogin: new Date(),
          ultimoHeartbeat: new Date(),
        },
      },
    ]);
    // Primera consulta de pedidos: los de su ventanilla.
    pedidoFindMany.mockResolvedValueOnce([{ id: 7, numeroPedido: 'PD-7' }]);
    const snap = await svc.obtenerMonitorCajero(5);
    expect(snap.ventanillas).toHaveLength(1);
    expect(snap.ventanillas[0]).not.toHaveProperty('cajeroId');
    expect(snap.ventanillas[0].cajeroNombre).toBe('Ana Ruiz');
    expect(snap.ventanillas[0].detallePedidos).toEqual([
      { id: 7, numeroPedido: 'PD-7', turno: null },
    ]);
  });

  it('lanza 400 si el usuario no tiene tienda', async () => {
    const { svc } = crearServicio();
    await expect(svc.obtenerMonitorCajero(0)).rejects.toThrow(/tienda asignada/i);
  });
});

describe('CajeroMonitorService — cajero activo (H6)', () => {
  const hace = (horas: number) => new Date(Date.now() - horas * 3_600_000);
  const ventanillaCon = (
    cajero: { lastLogin: Date | null; ultimoHeartbeat: Date | null } | null,
  ) => ({
    id: 1,
    numero: 1,
    cajeroId: cajero ? 99 : null,
    cajero: cajero ? { id: 99, nombre: 'Ana', apellido: null, ...cajero } : null,
  });

  it('un cajero que entró hace poco está activo', async () => {
    const { svc } = crearServicio([
      ventanillaCon({ lastLogin: new Date(Date.now() - 60_000), ultimoHeartbeat: null }),
    ]);
    const snap = await svc.obtenerMonitorCajero(5);
    expect(snap.ventanillas[0].cajeroActivo).toBe(true);
  });

  it('un turno largo NO lo saca del monitor mientras el latido siga llegando', async () => {
    // Entró hace 14 h pero el `RolShell` manda el latido cada 5 minutos.
    const { svc } = crearServicio([
      ventanillaCon({ lastLogin: hace(14), ultimoHeartbeat: new Date() }),
    ]);
    const snap = await svc.obtenerMonitorCajero(5);
    expect(snap.ventanillas[0].cajeroActivo).toBe(true);
  });

  it('sin señales en 15 min está inactivo (antes eran 12 HORAS: la ventanilla quedaba abierta medio día)', async () => {
    const { svc } = crearServicio([
      ventanillaCon({ lastLogin: hace(3), ultimoHeartbeat: new Date(Date.now() - 20 * 60_000) }),
    ]);
    const snap = await svc.obtenerMonitorCajero(5);
    expect(snap.ventanillas[0].cajeroActivo).toBe(false);
  });

  it('un cajero que solo tiene latido (nunca registró login) también cuenta', async () => {
    const { svc } = crearServicio([
      ventanillaCon({ lastLogin: null, ultimoHeartbeat: new Date() }),
    ]);
    const snap = await svc.obtenerMonitorCajero(5);
    expect(snap.ventanillas[0].cajeroActivo).toBe(true);
  });

  it('una ventanilla libre no tiene cajero activo', async () => {
    const { svc } = crearServicio([ventanillaCon(null)]);
    const snap = await svc.obtenerMonitorCajero(5);
    expect(snap.ventanillas[0].cajeroActivo).toBe(false);
  });

  it('pide el latido a la BD', async () => {
    const { svc } = crearServicio([]);
    // Se inspecciona el `select` real: si alguien quita `ultimoHeartbeat` del select, la
    // comparación de arriba leería `undefined` y siempre daría false.
    const prismaMock = (svc as unknown as { prisma: { ventanilla: { findMany: jest.Mock } } })
      .prisma;
    await svc.obtenerMonitorCajero(5);
    const select = prismaMock.ventanilla.findMany.mock.calls[0][0].include.cajero.select;
    expect(select.ultimoHeartbeat).toBe(true);
  });
});
