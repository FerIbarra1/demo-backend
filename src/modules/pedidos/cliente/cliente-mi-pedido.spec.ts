import { ClienteService } from './cliente.service';
import { EstadoPedido, ModoEntrega } from '@prisma/client';

/**
 * Oct 2026 — lo que recibe el cliente en el detalle de SU pedido (`obtenerMiPedido`).
 *
 * 1. El historial es SU versión: sin números internos ("#45"), sin nombres de procesos del sistema ("AGENT_EXTERNAL") y
 *    sin los ids de la fila. Se escribe para el personal y el cliente lo lee tal cual.
 * 2. `turno`: los últimos 4 dígitos del folio, que es lo que dicen las TV de pared. Lo decide el servidor.
 */
function crearServicio(pedido: Record<string, unknown>) {
  const prisma = {
    pedido: { findFirst: jest.fn().mockResolvedValue(pedido) },
    pedidoDtf: { findMany: jest.fn().mockResolvedValue([]) },
    pedidoIntervencion: { findFirst: jest.fn().mockResolvedValue(null) },
    // Oct 2026: el detalle trae `puedeCancelar`, que consulta el pago del pedido (aquí: ninguno).
    pedidoPagoTransferencia: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const svc = new ClienteService(
    prisma as never,
    {} as never, // notifications
    {} as never, // realtime
    {} as never, // state
    { resolverImagen: (u: string | null) => u } as never, // storage
    {} as never, // kioskoService
    {} as never, // kioskoLlegada
    {} as never, // precios
    {} as never, // reposicion
    {} as never, // presencia
    {} as never, // sinRecoger
  );
  return svc;
}

const base = {
  id: 17310,
  usuarioId: 7,
  numeroPedido: 'PD-2026-000018',
  tiendaId: 1,
  estado: EstadoPedido.REVISADO,
  modoEntrega: ModoEntrega.RECOGER_TIENDA,
  folioErp: '0000152573',
  items: [],
  mensajes: [],
  propuestas: [],
  historial: [
    {
      id: 1,
      pedidoId: 17310,
      usuarioId: 4321,
      estadoAnterior: null,
      estadoNuevo: EstadoPedido.SOLICITADO,
      observacion: 'Pedido creado por cliente',
      usuarioNombre: 'Cliente',
      createdAt: new Date('2026-10-19T12:00:00Z'),
    },
    {
      id: 2,
      pedidoId: 17310,
      usuarioId: 0,
      estadoAnterior: EstadoPedido.REVISADO,
      estadoNuevo: EstadoPedido.PENDIENTE_PAGO,
      observacion: 'Cliente aprobó la propuesta #45 de bodega — pendiente de pago',
      usuarioNombre: 'AGENT_EXTERNAL',
      createdAt: new Date('2026-10-19T12:05:00Z'),
    },
  ],
};

describe('ClienteService.obtenerMiPedido · lo que lee el cliente', () => {
  it('el historial es SU versión: hitos con frase propia, sin texto del personal, ids ni quién lo hizo', async () => {
    const r: any = await crearServicio(base).obtenerMiPedido(17310, 7);

    expect(r.historial.map((h: any) => h.observacion)).toEqual([
      'Recibimos tu pedido',
      'Tu pedido pasó a pago',
    ]);
    for (const h of r.historial) {
      expect(h).not.toHaveProperty('id');
      expect(h).not.toHaveProperty('pedidoId');
      expect(h).not.toHaveProperty('usuarioId');
      expect(h.usuarioNombre).toBe('');
    }
    expect(JSON.stringify(r.historial)).not.toMatch(/#\d|AGENT_EXTERNAL|propuesta/i);
  });

  it('con folio y en un estado que sale en la TV: trae el turno (últimos 4 dígitos)', async () => {
    const r: any = await crearServicio(base).obtenerMiPedido(17310, 7);
    expect(r.turno).toBe('2573');
  });

  it('sin folio, a domicilio, o ya entregado: sin turno', async () => {
    expect(
      ((await crearServicio({ ...base, folioErp: null }).obtenerMiPedido(17310, 7)) as any).turno,
    ).toBeNull();
    expect(
      (
        (await crearServicio({ ...base, modoEntrega: ModoEntrega.DOMICILIO }).obtenerMiPedido(
          17310,
          7,
        )) as any
      ).turno,
    ).toBeNull();
    expect(
      (
        (await crearServicio({ ...base, estado: EstadoPedido.ENTREGADO }).obtenerMiPedido(
          17310,
          7,
        )) as any
      ).turno,
    ).toBeNull();
  });
});
