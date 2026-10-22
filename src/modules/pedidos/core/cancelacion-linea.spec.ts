import { EstadoSurtido, Prisma } from '@prisma/client';
import { aplicarPropuestaDeVentas } from './aplicar-propuesta-ventas.util';
import {
  datosDeRetiroPorDecision,
  datosDeFaltaDeBodega,
  seRetiraronPiezas,
} from './cancelacion-linea.util';

/**
 * F20 (oct 2026): las dos razones por las que una línea sale del pedido.
 *
 * El bug que esto fija: TODOS los caminos de cancelación escribían el mismo
 * trío (`cancelada: true`, `estadoSurtido: NO_DISPONIBLE`, `cantidadSurtida: 0`)
 * sin importar la razón. Así, cuando el cliente quitaba un producto que bodega
 * había apartado COMPLETO, el sistema borraba el hecho de que sí había — y la
 * pantalla lo mostraba como un faltante de inventario.
 *
 * La distinción se deriva de las cantidades, sin columna nueva:
 *   cancelada && cantidadSurtida > 0   → se retiró, y SÍ había
 *   cancelada && cantidadSurtida === 0 → bodega no la encontró
 */

describe('cancelacion-linea.util — los dos helpers', () => {
  it('falta de bodega limpia el estado físico', () => {
    expect(datosDeFaltaDeBodega()).toEqual({
      cancelada: true,
      estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
      cantidadSurtida: 0,
    });
  });

  it('retiro por decisión CONSERVA el estado físico', () => {
    expect(
      datosDeRetiroPorDecision({
        estadoSurtido: EstadoSurtido.COMPLETO,
        cantidadSurtida: 10,
      }),
    ).toEqual({
      cancelada: true,
      estadoSurtido: EstadoSurtido.COMPLETO,
      cantidadSurtida: 10,
    });
  });

  it('retiro por decisión también conserva un PARCIAL', () => {
    expect(
      datosDeRetiroPorDecision({
        estadoSurtido: EstadoSurtido.PARCIAL,
        cantidadSurtida: 3,
      }),
    ).toEqual({
      cancelada: true,
      estadoSurtido: EstadoSurtido.PARCIAL,
      cantidadSurtida: 3,
    });
  });

  describe('seRetiraronPiezas: el predicado que separa las dos razones', () => {
    it('cancelada CON piezas apartadas → se retiró', () => {
      expect(seRetiraronPiezas({ cancelada: true, cantidadSurtida: 10 })).toBe(true);
    });

    it('cancelada SIN piezas: no había nada (falta de bodega)', () => {
      expect(seRetiraronPiezas({ cancelada: true, cantidadSurtida: 0 })).toBe(false);
    });

    it('una línea activa nunca "se retiró"', () => {
      expect(seRetiraronPiezas({ cancelada: false, cantidadSurtida: 10 })).toBe(false);
    });
  });
});

// =============================================================================
// El comportamiento end-to-end sobre `aplicarPropuestaDeVentas`
// =============================================================================

function item(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    pedidoId: 1,
    cantidad: 10,
    cantidadPedida: 10,
    cantidadSurtida: 10,
    estadoSurtido: EstadoSurtido.COMPLETO,
    cancelada: false,
    precioUnitario: new Prisma.Decimal(100),
    subtotal: new Prisma.Decimal(1000),
    ...over,
  };
}

function crearTx(items: any[]) {
  const updates: Array<{ id: number; data: any }> = [];
  const tx = {
    pedidoDtf: { count: async () => 0, findMany: async () => [] }, // sin trabajos DTF (impresión DTF, oct 2026)
    itemPedido: {
      findUnique: jest.fn(async ({ where }: any) => {
        const i = items.find((x) => x.id === where.id);
        return i ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        return {};
      }),
      create: jest.fn(async () => ({})),
      count: jest.fn(async () => items.filter((i) => !i.cancelada).length),
      findMany: jest.fn(async () => items.filter((i) => !i.cancelada)),
    },
    precioCO: { findUnique: jest.fn() },
    pedido: { update: jest.fn(async () => ({})) },
  };
  return { tx, updates };
}

const pedido = {
  id: 1,
  tiendaId: 5,
  descuento: new Prisma.Decimal(0),
  impuestos: new Prisma.Decimal(0),
};

function propuesta(itemId: number, tipo: string, extra: any = {}) {
  return {
    itemId,
    tipo,
    producto: 'X',
    variante: 'M',
    cantidad: 10,
    precioUnitario: 100,
    subtotal: 1000,
    ...extra,
  };
}

describe('F20 — el cliente quita un producto que SÍ estaba disponible', () => {
  it("'no-disponible' sobre un item COMPLETO conserva las 10 piezas", async () => {
    // El caso del reporte: bodega apartó las 10, el cliente decidió quitarlas.
    const { tx, updates } = crearTx([item({ id: 1 })]);
    const r = await aplicarPropuestaDeVentas(
      tx as never,
      pedido,
      [propuesta(1, 'no-disponible')] as never,
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'lista1',
    );

    expect(updates[0].data).toMatchObject({
      cancelada: true,
      estadoSurtido: EstadoSurtido.COMPLETO,
      cantidadSurtida: 10,
    });
    // Y hay mercancía que sacar de la bolsa.
    expect(r.huboRetiro).toBe(true);
  });

  it("'no-disponible' sobre un item que NO había nada limpia el estado", async () => {
    const { tx, updates } = crearTx([
      item({ id: 1, estadoSurtido: EstadoSurtido.NO_DISPONIBLE, cantidadSurtida: 0 }),
    ]);
    const r = await aplicarPropuestaDeVentas(
      tx as never,
      pedido,
      [propuesta(1, 'no-disponible')] as never,
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'lista1',
    );

    expect(updates[0].data).toMatchObject({
      cancelada: true,
      estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
      cantidadSurtida: 0,
    });
    expect(r.huboRetiro).toBe(false);
  });

  it("'parcial' a 0 conserva el hallazgo físico", async () => {
    const { tx, updates } = crearTx([item({ id: 1, cantidadSurtida: 5 })]);
    const r = await aplicarPropuestaDeVentas(
      tx as never,
      pedido,
      [propuesta(1, 'parcial', { cantidadNueva: 0 })] as never,
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'lista1',
    );

    expect(updates[0].data).toMatchObject({
      cancelada: true,
      estadoSurtido: EstadoSurtido.COMPLETO,
      cantidadSurtida: 5,
    });
    expect(r.huboRetiro).toBe(true);
  });
});

describe('F20 — la rama que SÍ es falta de bodega', () => {
  it("'completo' sobre un item NO_DISPONIBLE limpia el estado", async () => {
    // El cliente aprobó "lo que hay" y lo que hay es nada: aquí sí es correcto
    // limpiar, porque `NO_DISPONIBLE` + 0 describe literalmente lo que pasó.
    const { tx, updates } = crearTx([
      item({ id: 1, estadoSurtido: EstadoSurtido.NO_DISPONIBLE, cantidadSurtida: 0 }),
    ]);
    await aplicarPropuestaDeVentas(
      tx as never,
      pedido,
      [propuesta(1, 'completo')] as never,
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'lista1',
    );

    expect(updates[0].data).toMatchObject({
      cancelada: true,
      estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
      cantidadSurtida: 0,
    });
  });
});

describe('F20 — la distinción sobrevive a la regla de derivación', () => {
  it('los dos casos quedan distinguibles leyendo solo el item', async () => {
    // Retiro: había 10 y se quitó.
    const retiro = { cancelada: true, cantidadSurtida: 10 };
    // Falta: no había nada.
    const falta = { cancelada: true, cantidadSurtida: 0 };

    expect(seRetiraronPiezas(retiro)).toBe(true);
    expect(seRetiraronPiezas(falta)).toBe(false);
    // Es exactamente el predicado que la UI usa para elegir el badge.
  });
});
