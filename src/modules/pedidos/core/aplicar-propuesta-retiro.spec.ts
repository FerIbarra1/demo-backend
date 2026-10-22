import { EstadoSurtido, Prisma } from '@prisma/client';
import { aplicarPropuestaDeVentas } from './aplicar-propuesta-ventas.util';

/**
 * `aplicarPropuestaDeVentas` avisa si hay piezas que SACAR de la bolsa
 * (`huboRetiro`), y eso manda el pedido de vuelta a bodega al checklist de
 * retiro.
 *
 * Es solo una señal de RUTEO. Desde oct 2026 no genera lista de reposición: las
 * piezas que un ajuste quita las saca el bodeguero de la bolsa y las regresa al
 * anaquel él mismo mientras hace el ajuste. La reposición es solo de pedidos
 * cancelados o rechazados. Antes (F20) esta función devolvía además un mapa
 * `piezasRetiradas` que alimentaba `crearDesdeAjuste`; ambos se eliminaron.
 *
 * Lo que sí hay que cuidar aquí es que la señal sea VERDADERA: un `huboRetiro`
 * falso manda el pedido a bodega a un checklist vacío.
 */

function item(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    pedidoId: 1,
    cantidad: 10,
    cantidadPedida: 10,
    cantidadSurtida: 10,
    estadoSurtido: EstadoSurtido.COMPLETO,
    cancelada: false,
    piezasRetiradas: 0,
    precioUnitario: new Prisma.Decimal(100),
    subtotal: new Prisma.Decimal(1000),
    ...over,
  };
}

function crearTx(items: any[]) {
  const tx = {
    pedidoDtf: { count: async () => 0, findMany: async () => [] }, // sin trabajos DTF (impresión DTF, oct 2026)
    itemPedido: {
      findUnique: jest.fn(async ({ where }: any) => items.find((x) => x.id === where.id) ?? null),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
      count: jest.fn(async () => items.filter((i) => !i.cancelada).length),
      findMany: jest.fn(async () => items.filter((i) => !i.cancelada)),
    },
    // La rama `cambio`/`agregado` resuelve el PrecioCO del reemplazo para
    // crear la línea nueva.
    precioCO: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        tiendaId: 5,
        productoId: 1,
        precio: new Prisma.Decimal(100),
        lista1: new Prisma.Decimal(100),
        lista2: new Prisma.Decimal(80),
        lista3: new Prisma.Decimal(0),
        lista4: new Prisma.Decimal(0),
        lista5: new Prisma.Decimal(0),
        lista6: new Prisma.Decimal(0),
        producto: { nombre: 'Reemplazo', codigo: 'R1' },
        corrida: { nombre: 'A' },
        talla: { nombre: 'M' },
        color: { nombre: 'N' },
      })),
    },
    pedido: { update: jest.fn(async () => ({})) },
  };
  return tx;
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

async function aplicar(items: any[], props: any[]) {
  const tx = crearTx(items);
  const r = await aplicarPropuestaDeVentas(
    tx as never,
    pedido,
    props as never,
    items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
    'lista1',
  );
  return { r, tx };
}

describe('huboRetiro: ¿hay piezas que sacar de la bolsa?', () => {
  it("'no-disponible' sobre un item con 10 apartadas", async () => {
    const { r } = await aplicar([item({ id: 1 })], [propuesta(1, 'no-disponible')]);

    expect(r.huboRetiro).toBe(true);
  });

  it("'no-disponible' sobre un item SIN piezas no hay nada que sacar", async () => {
    const { r } = await aplicar(
      [item({ id: 1, estadoSurtido: EstadoSurtido.NO_DISPONIBLE, cantidadSurtida: 0 })],
      [propuesta(1, 'no-disponible')],
    );

    expect(r.huboRetiro).toBe(false);
  });

  it("'cambio' retira el original que estaba en la bolsa", async () => {
    const { r } = await aplicar(
      [item({ id: 1, cantidadSurtida: 7 })],
      [propuesta(1, 'cambio', { cantidadNueva: 3, precioCOId: 900 })],
    );

    expect(r.huboRetiro).toBe(true);
  });

  it("'parcial' a 0 retira lo que había", async () => {
    const { r } = await aplicar(
      [item({ id: 1, cantidadSurtida: 5 })],
      [propuesta(1, 'parcial', { cantidadNueva: 0 })],
    );

    expect(r.huboRetiro).toBe(true);
  });

  it("'parcial' a la BAJA deja sobrante en la bolsa", async () => {
    // Había 10 apartadas y el cliente deja 4: sobran 6 y el bodeguero las saca.
    const { r, tx } = await aplicar(
      [item({ id: 1, cantidadSurtida: 10 })],
      [propuesta(1, 'parcial', { cantidadNueva: 4 })],
    );

    expect(r.huboRetiro).toBe(true);
    // El hallazgo físico NO se pisa (F21).
    const data = (tx.itemPedido.update as jest.Mock).mock.calls[0][0].data;
    expect(data.cantidad).toBe(4);
    expect(data.cantidadSurtida).toBe(10);
  });

  it("'parcial' que SUBE no registra retiro: no hay nada que sacar", async () => {
    const { r } = await aplicar(
      [item({ id: 1, cantidadSurtida: 5 })],
      [propuesta(1, 'parcial', { cantidadNueva: 8 })],
    );

    expect(r.huboRetiro).toBe(false);
  });

  it('un pedido sin cambios no registra retiro', async () => {
    const { r } = await aplicar([item({ id: 1 })], [propuesta(1, 'completo')]);

    expect(r.huboRetiro).toBe(false);
  });
});

describe("huboRetiro: la rama 'completo' sobre un faltante de bodega", () => {
  it('PARCIAL se ajusta a lo que hay y NO es un retiro', async () => {
    // Bodega encontró 3 de 10 y el cliente aprobó "lo que hay". `cantidad` baja
    // a 3: las 3 piezas de la bolsa SON las que se lleva. Antes esta rama
    // marcaba retiro (creyendo que sobraba algo) y el pedido volvía a bodega a
    // un checklist vacío, con un mensaje al cliente que prometía un trabajo que
    // no existe.
    const { r, tx } = await aplicar(
      [item({ id: 1, cantidad: 10, cantidadSurtida: 3, estadoSurtido: EstadoSurtido.PARCIAL })],
      [propuesta(1, 'completo')],
    );

    const data = (tx.itemPedido.update as jest.Mock).mock.calls[0][0].data;
    expect(data.cantidad).toBe(3);
    expect(data.estadoSurtido).toBe(EstadoSurtido.COMPLETO);
    expect(r.huboRetiro).toBe(false);
  });

  it('NO_DISPONIBLE sin piezas se cancela y tampoco es un retiro', async () => {
    const { r } = await aplicar(
      [
        item({ id: 1, estadoSurtido: EstadoSurtido.NO_DISPONIBLE, cantidadSurtida: 0 }),
        item({ id: 2 }),
      ],
      [propuesta(1, 'completo'), propuesta(2, 'completo')],
    );

    expect(r.huboRetiro).toBe(false);
  });
});

describe('huboRetiro: lo que el bodeguero ya sacó no se vuelve a pedir', () => {
  it('quitar una línea cuyas piezas YA se sacaron no manda a bodega', async () => {
    // Ya estaba cancelada por un ajuste anterior y el bodeguero sacó las 5.
    // (El segundo item activo evita el guard de "pedido sin productos".)
    const { r } = await aplicar(
      [item({ id: 1, cancelada: true, cantidadSurtida: 5, piezasRetiradas: 5 }), item({ id: 2 })],
      [propuesta(1, 'no-disponible')],
    );

    expect(r.huboRetiro).toBe(false);
  });

  it('quitar una línea con retiro parcial sí manda a sacar lo que queda', async () => {
    // Había 5, el bodeguero ya sacó 2 (cantidad 3): quedan 3 dentro de la bolsa.
    const { r } = await aplicar(
      [item({ id: 1, cantidad: 3, cantidadSurtida: 5, piezasRetiradas: 2 })],
      [propuesta(1, 'no-disponible')],
    );

    expect(r.huboRetiro).toBe(true);
  });

  it('SUBIR sobre lo que hay en la bolsa re-verifica, aunque quepa en lo que se encontró', async () => {
    // Había 5, el bodeguero sacó 2 (en la bolsa quedan 3). El cliente ahora
    // quiere 4: eso es MÁS de lo que hay en la bolsa aunque sea menos de las 5
    // que se encontraron. Las 2 que sacó ya están en el anaquel, así que el item
    // vuelve a PENDIENTE; si no, quedaba COMPLETO con 3 piezas y se cobraban 4.
    const { r, tx } = await aplicar(
      [item({ id: 1, cantidad: 3, cantidadSurtida: 5, piezasRetiradas: 2 })],
      [propuesta(1, 'parcial', { cantidadNueva: 4 })],
    );

    const data = (tx.itemPedido.update as jest.Mock).mock.calls[0][0].data;
    expect(data.cantidad).toBe(4);
    expect(data.estadoSurtido).toBe(EstadoSurtido.PENDIENTE);
    // Oct 2026 (decisión 2): se rebasa a lo que hay en la bolsa (5 − 2 = 3): bodega
    // verifica 1 pieza, no 4.
    expect(data.cantidadSurtida).toBe(3);
    expect(data.piezasBase).toBe(3);
    // El conteo de retiros se reinicia junto con el hallazgo al que pertenece.
    expect(data.piezasRetiradas).toBe(0);
    expect(r.huboRetiro).toBe(false);
  });

  it('BAJAR otra vez solo pide sacar lo que de verdad sobra', async () => {
    // Había 5, ya salieron 2 (cantidad 3, en la bolsa 3). Ahora baja a 2: sobra
    // 1, no 3.
    const { r, tx } = await aplicar(
      [item({ id: 1, cantidad: 3, cantidadSurtida: 5, piezasRetiradas: 2 })],
      [propuesta(1, 'parcial', { cantidadNueva: 2 })],
    );

    const data = (tx.itemPedido.update as jest.Mock).mock.calls[0][0].data;
    expect(data.cantidad).toBe(2);
    expect(data.cantidadSurtida).toBe(5);
    expect(data.estadoSurtido).toBe(EstadoSurtido.COMPLETO);
    expect(r.huboRetiro).toBe(true);
  });

  it('BAJAR a lo que ya hay en la bolsa no pide nada', async () => {
    // Había 5, ya salieron 2 (en la bolsa quedan 3). Si la cantidad queda en 3
    // otra vez, no hay sobrante.
    const { r } = await aplicar(
      [item({ id: 1, cantidad: 4, cantidadSurtida: 5, piezasRetiradas: 2 })],
      [propuesta(1, 'parcial', { cantidadNueva: 3 })],
    );

    expect(r.huboRetiro).toBe(false);
  });
});
