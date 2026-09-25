import { Prisma } from '@prisma/client';
import { CatalogoService } from './catalogo.service';
import { PreciosService } from '../precios/precios.service';

/**
 * Promo de volumen (sep 2026): el endpoint del carrito.
 *
 * El test que importa aquí es el INVARIANTE entre carrito y pedido: el total
 * que ve el cliente en `/carrito` tiene que ser exactamente el que congelará
 * `ClienteService.crearPedido`. Si divergen, el cliente ve un precio y se le
 * cobra otro — la clase de bug que `precio-lista.util.ts` existe para prevenir.
 *
 * El caso que motivó estos tests: un cliente de lista 3 cuya lista está sin
 * capturar en Firebird (0). `precioDeLista` cae al precio base, así que su
 * precio efectivo es el de lista1 y la promo SÍ debe aplicarle. Un gate por
 * nombre de columna diría que no.
 */

function precioCOMock(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    precio: new Prisma.Decimal('60'),
    lista1: new Prisma.Decimal('60'),
    lista2: new Prisma.Decimal('57'),
    lista3: new Prisma.Decimal('54'),
    lista4: new Prisma.Decimal('51'),
    lista5: new Prisma.Decimal('48'),
    lista6: new Prisma.Decimal('45'),
    ...overrides,
  };
}

function crearServicio(
  preciosCO: ReturnType<typeof precioCOMock>[],
  columna: string,
) {
  const prisma = {
    precioCO: { findMany: jest.fn().mockResolvedValue(preciosCO) },
  };
  const precios = {
    columnaParaUsuario: jest.fn(async () => columna),
  };
  const svc = new CatalogoService(
    prisma as never,
    {} as never, // storage
    precios as unknown as PreciosService,
  );
  return { svc, prisma };
}

describe('CatalogoService.evaluarPromoVolumen', () => {
  it('aplica la promo a un cliente de lista 1 con 12 piezas', async () => {
    const { svc } = crearServicio([precioCOMock()], 'lista1');

    const r = await svc.evaluarPromoVolumen([{ precioCOId: 1, cantidad: 12 }], 1, 8);

    expect(r.elegible).toBe(true);
    expect(r.aplica).toBe(true);
    expect(r.total).toBe(684); // 57 × 12
    expect(r.totalSinPromo).toBe(720); // 60 × 12
    expect(r.ahorro).toBe(36);
    expect(r.piezasFaltantes).toBe(0);
  });

  it('no aplica con 11 piezas y dice cuántas faltan', async () => {
    const { svc } = crearServicio([precioCOMock()], 'lista1');

    const r = await svc.evaluarPromoVolumen([{ precioCOId: 1, cantidad: 11 }], 1, 8);

    expect(r.aplica).toBe(false);
    expect(r.piezasFaltantes).toBe(1);
    expect(r.total).toBe(660);
    expect(r.ahorro).toBe(0);
  });

  it('un cliente de lista 3 no es elegible (ya paga menos que lista2)', async () => {
    const { svc } = crearServicio([precioCOMock()], 'lista3');

    const r = await svc.evaluarPromoVolumen([{ precioCOId: 1, cantidad: 12 }], 1, 42);

    expect(r.elegible).toBe(false);
    expect(r.aplica).toBe(false);
    expect(r.total).toBe(648); // 54 × 12, su propia lista
    expect(r.ahorro).toBe(0);
  });

  it('un cliente de lista 3 SIN capturar (0) SÍ es elegible', async () => {
    // Firebird puede tener la lista del cliente sin capturar. `precioDeLista`
    // cae al precio base, así que el precio efectivo de este cliente es el de
    // lista1 (60) y la promo sí le baja a 57. Es el caso donde un gate por
    // nombre de columna divergiría de la creación del pedido.
    const { svc } = crearServicio(
      [precioCOMock({ lista3: new Prisma.Decimal('0') })],
      'lista3',
    );

    const r = await svc.evaluarPromoVolumen([{ precioCOId: 1, cantidad: 12 }], 1, 42);

    expect(r.elegible).toBe(true);
    expect(r.aplica).toBe(true);
    expect(r.total).toBe(684);
    expect(r.ahorro).toBe(36);
  });

  it('devuelve el precio POR LÍNEA para que las cards cuadren con el total', async () => {
    // Sin esto las cards suman el precio base y el total lleva promo: el
    // cliente ve dos precios distintos en la misma pantalla.
    const { svc } = crearServicio([precioCOMock()], 'lista1');

    const r = await svc.evaluarPromoVolumen([{ precioCOId: 1, cantidad: 12 }], 1, 8);

    expect(r.items).toEqual([
      {
        precioCOId: 1,
        cantidad: 12,
        precioUnitario: 57,
        precioUnitarioSinPromo: 60,
      },
    ]);
    // La suma de las líneas tiene que dar el total.
    const sumaLineas = r.items.reduce(
      (acc, i) => acc + i.precioUnitario * i.cantidad,
      0,
    );
    expect(sumaLineas).toBe(r.total);
  });

  it('las líneas van a precio base cuando la promo no aplica', async () => {
    const { svc } = crearServicio([precioCOMock()], 'lista1');

    const r = await svc.evaluarPromoVolumen([{ precioCOId: 1, cantidad: 11 }], 1, 8);

    expect(r.items[0].precioUnitario).toBe(60);
    const sumaLineas = r.items.reduce(
      (acc, i) => acc + i.precioUnitario * i.cantidad,
      0,
    );
    expect(sumaLineas).toBe(r.total);
  });

  it('suma las piezas de todos los items para decidir el umbral', async () => {
    const { svc } = crearServicio(
      [precioCOMock({ id: 1 }), precioCOMock({ id: 2 })],
      'lista1',
    );

    const r = await svc.evaluarPromoVolumen(
      [
        { precioCOId: 1, cantidad: 7 },
        { precioCOId: 2, cantidad: 5 },
      ],
      1,
      8,
    );

    expect(r.totalPiezas).toBe(12);
    expect(r.aplica).toBe(true);
    // 57 × 12
    expect(r.total).toBe(684);
  });

  it('ignora las variantes que no existen en la tienda', async () => {
    const { svc } = crearServicio([precioCOMock({ id: 1 })], 'lista1');

    const r = await svc.evaluarPromoVolumen(
      [
        { precioCOId: 1, cantidad: 12 },
        { precioCOId: 999, cantidad: 5 }, // no está en la respuesta
      ],
      1,
      8,
    );

    // Solo cuenta la que existe: 12 piezas, no 17.
    expect(r.totalPiezas).toBe(12);
  });
});
