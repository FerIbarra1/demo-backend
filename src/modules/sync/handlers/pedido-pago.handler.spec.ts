import { EstadoPedido } from '@prisma/client';
import { PedidoPagoHandler } from './pedido-pago.handler';
import { OFFSET_ID_PEDIDO_NUBE } from '../../pedidos/core/id-pedido-externo.util';

/**
 * Fase 0 de pagos por transferencia (oct 2026): el handler de eventos de PEDIDOS.
 *
 * Tres reglas que se rompen en silencio:
 *
 *   1. Un cobro/cancelación SIN mapeo que puede ser nuestro se REINTENTA (antes se
 *      descartaba como PROCESADO y el pedido pagado en VFP se quedaba en
 *      PENDIENTE_PAGO). Pero un pedido creado directamente en VFP —que nunca va a tener
 *      mapeo— se omite sin reintentar: reintentarlo dejaría el checkpoint atorado.
 *   2. Un pedido que ya pasó por el cobro (PAGADO/ENVIADO/ENTREGADO) es idempotente:
 *      ENVIADO ya no retrocede a PAGADO.
 *   3. Los desfases se avisan, no se corrigen.
 */

const TIENDA_VFP = 7;
const ID_NUBE = 42;

type Datos = Record<string, unknown>;

function evento(datos: Datos, localId = 555, localTiendaId: number = TIENDA_VFP) {
  return {
    eventId: `BANDEJA:1:PEDIDOS:${localId}`,
    bandejaId: 1,
    tipo: 'PAGO' as const,
    operacion: 'U' as const,
    entidad: 'PEDIDOS',
    localId,
    localTiendaId,
    datos,
  };
}

function crear(opts: {
  mapeo?: number | null;
  estado?: EstadoPedido;
  total?: number;
  colaPorIdPreasignado?: { pedidoId: number } | null;
  entregasEnVuelo?: number;
}) {
  const externalRefs = { findSystemId: jest.fn().mockResolvedValue(opts.mapeo ?? null) };
  const prisma = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue({
        estado: opts.estado ?? EstadoPedido.PENDIENTE_PAGO,
        total: { toString: () => String(opts.total ?? 100) },
      }),
    },
    pedidoPendienteEnvio: {
      findFirst: jest.fn().mockResolvedValue(opts.colaPorIdPreasignado ?? null),
      count: jest.fn().mockResolvedValue(opts.entregasEnVuelo ?? 0),
    },
    // Sin pago por transferencia en estos casos.
    pedidoPagoTransferencia: { findFirst: jest.fn().mockResolvedValue(null) },
    // Oct 2026: el handler cierra solo las tareas del Sistema Comercial que el ERP confirma.
    tareaSistemaComercial: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const adminService = { marcarComoPagado: jest.fn().mockResolvedValue({}) };
  const pedidoState = { cambiarEstadoPorSistema: jest.fn().mockResolvedValue({}) };
  const handler = new PedidoPagoHandler(
    prisma as never,
    externalRefs as never,
    adminService as never,
    pedidoState as never,
  );
  return { handler, prisma, externalRefs, adminService, pedidoState };
}

describe('PedidoPagoHandler — pedidos que sí conocemos', () => {
  it('FINALIZADA en PENDIENTE_PAGO → marca pagado', async () => {
    const { handler, adminService } = crear({ mapeo: ID_NUBE });
    const r = await handler.procesar(evento({ FINALIZADA: true, IDFACTURA: 9 }));
    expect(r.ok).toBe(true);
    expect(adminService.marcarComoPagado).toHaveBeenCalledWith(
      ID_NUBE,
      expect.objectContaining({ referencia: 'FACTURA-9' }),
      expect.objectContaining({ userId: 0 }),
    );
  });

  it.each([EstadoPedido.PAGADO, EstadoPedido.ENVIADO, EstadoPedido.ENTREGADO])(
    'FINALIZADA repetido en un pedido %s es idempotente: no vuelve a cobrar',
    async (estado) => {
      const { handler, adminService } = crear({ mapeo: ID_NUBE, estado });
      // El caso real: facturación asigna IDFACTURA a un pedido ya cobrado y el trigger
      // manda otra vez la fila completa con FINALIZADA = true.
      const r = await handler.procesar(evento({ FINALIZADA: true, IDFACTURA: 12 }));
      expect(r.ok).toBe(true);
      expect(adminService.marcarComoPagado).not.toHaveBeenCalled();
    },
  );

  it('cobrado en VFP pero CANCELADO en la nube: falla visible, no resucita el pedido', async () => {
    const { handler, adminService } = crear({ mapeo: ID_NUBE, estado: EstadoPedido.CANCELADO });
    const r = await handler.procesar(evento({ FINALIZADA: true }));
    expect(r.ok).toBe(false);
    expect(r.mensaje).toMatch(/CONFLICTO/);
    expect(adminService.marcarComoPagado).not.toHaveBeenCalled();
  });

  it('SWCANCEL → delega en la máquina de estados', async () => {
    const { handler, pedidoState, prisma } = crear({ mapeo: ID_NUBE });
    prisma.pedido.findUnique.mockResolvedValue({
      estado: EstadoPedido.PENDIENTE_PAGO,
      total: { toString: () => '100' },
    });
    const r = await handler.procesar(evento({ SWCANCEL: true }));
    expect(r.ok).toBe(true);
    expect(pedidoState.cambiarEstadoPorSistema).toHaveBeenCalledWith(
      ID_NUBE,
      EstadoPedido.CANCELADO,
      expect.any(Object),
    );
  });

  it('un evento sin cobro ni cancelación no hace nada', async () => {
    const { handler, adminService, pedidoState } = crear({ mapeo: ID_NUBE });
    const r = await handler.procesar(evento({ NOTAS: 'x', FINALIZADA: false }));
    expect(r.ok).toBe(true);
    expect(adminService.marcarComoPagado).not.toHaveBeenCalled();
    expect(pedidoState.cambiarEstadoPorSistema).not.toHaveBeenCalled();
  });

  it('si el mapeo apunta a un pedido que ya no existe, se omite', async () => {
    const { handler, prisma } = crear({ mapeo: ID_NUBE });
    prisma.pedido.findUnique.mockResolvedValue(null);
    const r = await handler.procesar(evento({ FINALIZADA: true }));
    expect(r.ok).toBe(true);
  });
});

describe('PedidoPagoHandler — evento SIN mapeo (H2)', () => {
  it('pedido creado en VFP (ID normal, nada en vuelo): se omite SIN reintentar', async () => {
    const { handler, adminService } = crear({ mapeo: null, entregasEnVuelo: 0 });
    const r = await handler.procesar(evento({ FINALIZADA: true }, 8_123_456));
    // Si esto devolviera ok:false, cada cobro de un pedido nativo de VFP dejaría el
    // checkpoint atorado ~7 minutos y terminaría en DEAD_LETTER.
    expect(r.ok).toBe(true);
    expect(adminService.marcarComoPagado).not.toHaveBeenCalled();
  });

  it('cobro de un ID normal mientras el agente tiene pedidos sin ACK: se REINTENTA', async () => {
    const { handler, adminService } = crear({ mapeo: null, entregasEnVuelo: 1 });
    const r = await handler.procesar(evento({ FINALIZADA: true }, 8_123_456));
    expect(r.ok).toBe(false);
    expect(r.mensaje).toMatch(/reintenta/i);
    expect(adminService.marcarComoPagado).not.toHaveBeenCalled();
  });

  it('lo mismo con una cancelación', async () => {
    const { handler } = crear({ mapeo: null, entregasEnVuelo: 2 });
    const r = await handler.procesar(evento({ SWCANCEL: true }, 8_123_456));
    expect(r.ok).toBe(false);
  });

  it('ID pre-asignado por la nube con su fila en la cola: se resuelve SIN esperar el ACK', async () => {
    const localId = OFFSET_ID_PEDIDO_NUBE + ID_NUBE;
    const { handler, adminService, prisma } = crear({
      mapeo: null,
      colaPorIdPreasignado: { pedidoId: ID_NUBE },
    });
    const r = await handler.procesar(evento({ FINALIZADA: true }, localId));
    expect(r.ok).toBe(true);
    expect(adminService.marcarComoPagado).toHaveBeenCalledWith(
      ID_NUBE,
      expect.any(Object),
      expect.any(Object),
    );
    // La búsqueda va acotada a la tienda del evento: sin esto un `IDPEDIDO` igual en
    // otra tienda podría cobrar el pedido equivocado.
    expect(prisma.pedidoPendienteEnvio.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          pedidoId: ID_NUBE,
          externalIdPEDIDOS: localId,
          pedido: { tienda: { externalId: TIENDA_VFP } },
        }),
      }),
    );
  });

  it('ID pre-asignado SIN fila en la cola: es nuestro, se REINTENTA', async () => {
    const { handler, adminService } = crear({ mapeo: null, colaPorIdPreasignado: null });
    const r = await handler.procesar(evento({ FINALIZADA: true }, OFFSET_ID_PEDIDO_NUBE + 999));
    expect(r.ok).toBe(false);
    expect(adminService.marcarComoPagado).not.toHaveBeenCalled();
  });

  it('un evento que no mueve dinero no cuesta consultas extra', async () => {
    const { handler, prisma } = crear({ mapeo: null, entregasEnVuelo: 5 });
    const r = await handler.procesar(evento({ NOTAS: 'cambio de nota' }, 8_123_456));
    expect(r.ok).toBe(true);
    expect(prisma.pedidoPendienteEnvio.count).not.toHaveBeenCalled();
    expect(prisma.pedidoPendienteEnvio.findFirst).not.toHaveBeenCalled();
  });

  it('sin tienda en el evento no se busca (un `externalId: undefined` ignoraría el filtro)', async () => {
    const { handler, prisma } = crear({ mapeo: null, entregasEnVuelo: 5 });
    const sinTienda: Record<string, unknown> = evento({ FINALIZADA: true }, 8_123_456);
    delete sinTienda.localTiendaId;
    const r = await handler.procesar(sinTienda as never);
    expect(r.ok).toBe(true);
    expect(prisma.pedidoPendienteEnvio.count).not.toHaveBeenCalled();
  });

  it('la consulta de "en vuelo" se limita a la tienda y a reclamos recientes', async () => {
    const { handler, prisma } = crear({ mapeo: null, entregasEnVuelo: 0 });
    await handler.procesar(evento({ FINALIZADA: true }, 8_123_456));
    const where = prisma.pedidoPendienteEnvio.count.mock.calls[0][0].where;
    expect(where.estado).toBe('PROCESSING');
    expect(where.pedido).toEqual({ tienda: { externalId: TIENDA_VFP } });
    // Un reclamo viejo (agente caído) no cuenta: si no, una fila atorada volvería
    // sospechoso a TODO cobro nativo de la tienda para siempre.
    expect(where.ultimoIntentoAt.gte).toBeInstanceOf(Date);
  });
});

describe('PedidoPagoHandler — desfases VFP ↔ nube (H4)', () => {
  it('avisa cuando cambia el total en VFP', async () => {
    const { handler } = crear({ mapeo: ID_NUBE, total: 1500 });
    const r = await handler.procesar(evento({ TTOTAL: 1620 }));
    expect(r.ok).toBe(true);
    expect(r.mensaje).toMatch(/ALERTA_TOTAL/);
    expect(r.mensaje).toContain('1620.00');
    expect(r.mensaje).toContain('1500.00');
  });

  it('no avisa por un centavo de redondeo ni cuando el total coincide', async () => {
    const { handler } = crear({ mapeo: ID_NUBE, total: 1500 });
    expect((await handler.procesar(evento({ TTOTAL: 1500 }))).mensaje).not.toMatch(/ALERTA/);
    expect((await handler.procesar(evento({ TTOTAL: '1500.005' }))).mensaje).not.toMatch(/ALERTA/);
  });

  it('avisa cuando VFP desmarca un cobro que la nube da por hecho', async () => {
    const { handler, adminService } = crear({ mapeo: ID_NUBE, estado: EstadoPedido.PAGADO });
    const r = await handler.procesar(evento({ FINALIZADA: false }));
    expect(r.mensaje).toMatch(/ALERTA_REVERSA/);
    // Solo avisa: no toca el pedido.
    expect(adminService.marcarComoPagado).not.toHaveBeenCalled();
  });

  it('FINALIZADA=false en un pedido todavía sin cobrar no es alerta', async () => {
    const { handler } = crear({ mapeo: ID_NUBE, estado: EstadoPedido.PENDIENTE_PAGO });
    const r = await handler.procesar(evento({ FINALIZADA: false }));
    expect(r.mensaje).not.toMatch(/ALERTA/);
  });

  it('las alertas acompañan al cobro sin bloquearlo', async () => {
    const { handler, adminService } = crear({ mapeo: ID_NUBE, total: 100 });
    const r = await handler.procesar(evento({ FINALIZADA: true, TTOTAL: 130 }));
    expect(r.ok).toBe(true);
    expect(adminService.marcarComoPagado).toHaveBeenCalled();
    expect(r.mensaje).toMatch(/ALERTA_TOTAL/);
  });

  it('un error inesperado se reporta como fallo del evento (se reintenta)', async () => {
    const { handler, adminService } = crear({ mapeo: ID_NUBE });
    adminService.marcarComoPagado.mockRejectedValue(new Error('boom'));
    const r = await handler.procesar(evento({ FINALIZADA: true }));
    expect(r).toEqual({ ok: false, mensaje: 'boom' });
  });
});
