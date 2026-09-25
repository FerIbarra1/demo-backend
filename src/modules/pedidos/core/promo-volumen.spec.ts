import { Prisma } from '@prisma/client';
import { aplicarPromoVolumen } from './promo-volumen.util';

/**
 * Promo de volumen (sep 2026): tests de la re-evaluación del precio efectivo.
 *
 * Es la regla que decide si un pedido paga lista 2 por llevar 12+ piezas, y la
 * que REVOCA esa promo si el pedido encoge (bodega no encontró mercancía). Un
 * error aquí significa cobrar de más o de menos, así que se fijan los casos
 * límite del umbral, la idempotencia y la no-regresión de los pedidos viejos.
 *
 * Se mockea el `tx` de Prisma y se capturan las escrituras en un array, que es
 * el patrón de `invariantes-propuesta.spec.ts`.
 */

interface ItemFalso {
  id: number;
  cantidad: number;
  precioUnitario: Prisma.Decimal;
  precioUnitarioBase: Prisma.Decimal | null;
  precioUnitarioMayoreo: Prisma.Decimal | null;
}

/** Item con par congelado. `base`/`mayoreo` en pesos. */
function item(
  id: number,
  cantidad: number,
  base: number,
  mayoreo: number,
  efectivo?: number,
): ItemFalso {
  return {
    id,
    cantidad,
    precioUnitario: new Prisma.Decimal(efectivo ?? base),
    precioUnitarioBase: new Prisma.Decimal(base),
    precioUnitarioMayoreo: new Prisma.Decimal(mayoreo),
  };
}

/** `tx` falso que devuelve `items` y registra los updates en `escritos`. */
function crearTx(items: ItemFalso[]) {
  const escritos: Array<{ id: number; precioUnitario: Prisma.Decimal; subtotal: Prisma.Decimal }> = [];
  const tx = {
    itemPedido: {
      findMany: jest.fn(async () => items),
      update: jest.fn(async ({ where, data }: any) => {
        escritos.push({ id: where.id, ...data });
        return data;
      }),
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, escritos };
}

describe('aplicarPromoVolumen', () => {
  describe('el umbral de 12 piezas', () => {
    it('aplica mayoreo justo en 12 piezas', async () => {
      const { tx, escritos } = crearTx([item(1, 12, 100, 95)]);
      const r = await aplicarPromoVolumen(tx, 1);

      expect(r).toEqual({ totalPiezas: 12, aplica: true });
      expect(escritos).toHaveLength(1);
      expect(escritos[0].precioUnitario.toString()).toBe('95');
      // El subtotal se recalcula con el precio nuevo, no se deja el viejo.
      expect(escritos[0].subtotal.toString()).toBe('1140');
    });

    it('NO aplica con 11 piezas', async () => {
      const { tx, escritos } = crearTx([item(1, 11, 100, 95)]);
      const r = await aplicarPromoVolumen(tx, 1);

      expect(r).toEqual({ totalPiezas: 11, aplica: false });
      expect(escritos).toHaveLength(0);
    });

    it('suma las piezas de TODOS los items, no por línea', async () => {
      // 12 piezas repartidas en 5 productos/colores distintos califican igual
      // que 12 del mismo color: la promo es por volumen del pedido.
      const { tx, escritos } = crearTx([
        item(1, 3, 100, 95),
        item(2, 3, 200, 190),
        item(3, 2, 100, 95),
        item(4, 2, 100, 95),
        item(5, 2, 100, 95),
      ]);
      const r = await aplicarPromoVolumen(tx, 1);

      expect(r).toEqual({ totalPiezas: 12, aplica: true });
      expect(escritos.map((e) => e.id).sort()).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('nunca encarece a un cliente con mejor lista', () => {
    it('un cliente de lista 3 conserva su precio (base < mayoreo)', async () => {
      // Las listas van de menudeo (1, caro) a mayoreo (6, barato). La lista 3
      // de este cliente vale 90, MÁS BARATA que el mayoreo (95): aplicarle la
      // promo le subiría el precio. El `min()` lo evita.
      const { tx, escritos } = crearTx([item(1, 12, 90, 95)]);
      const r = await aplicarPromoVolumen(tx, 1);

      expect(r.aplica).toBe(true);
      expect(escritos).toHaveLength(0); // 90 ya es el mínimo: no se toca
    });

    it('ante datos malos (mayoreo más caro que la base) conserva la base', async () => {
      const { tx, escritos } = crearTx([item(1, 20, 100, 150)]);
      await aplicarPromoVolumen(tx, 1);

      expect(escritos).toHaveLength(0);
    });
  });

  describe('pedidos anteriores a la promo', () => {
    it('no toca nada si el item no tiene par congelado', async () => {
      const viejo: ItemFalso = {
        id: 1,
        cantidad: 20,
        precioUnitario: new Prisma.Decimal(100),
        precioUnitarioBase: null,
        precioUnitarioMayoreo: null,
      };
      const { tx, escritos } = crearTx([viejo]);
      const r = await aplicarPromoVolumen(tx, 1);

      expect(r.aplica).toBe(false);
      expect(escritos).toHaveLength(0);
    });

    it('no toca nada si CUALQUIER item del pedido es viejo', async () => {
      // Un pedido a medio migrar no debe quedar con dos precios distintos
      // entre sus líneas: o todos entran a la promo, o ninguno.
      const { tx, escritos } = crearTx([
        item(1, 12, 100, 95),
        {
          id: 2,
          cantidad: 1,
          precioUnitario: new Prisma.Decimal(100),
          precioUnitarioBase: null,
          precioUnitarioMayoreo: null,
        },
      ]);
      const r = await aplicarPromoVolumen(tx, 1);

      expect(r.aplica).toBe(false);
      expect(escritos).toHaveLength(0);
    });
  });

  describe('revocación: el pedido encoge', () => {
    it('devuelve los items a su precio base cuando baja de 12', async () => {
      // El escenario real: el pedido se creó con 12 piezas y ganó el mayoreo;
      // bodega encontró faltante y quedaron 5. El cliente NO conserva la promo
      // sobre lo que sí se surtió.
      const { tx, escritos } = crearTx([item(1, 5, 100, 95, 95)]);
      const r = await aplicarPromoVolumen(tx, 1);

      expect(r).toEqual({ totalPiezas: 5, aplica: false });
      expect(escritos).toHaveLength(1);
      expect(escritos[0].precioUnitario.toString()).toBe('100');
      expect(escritos[0].subtotal.toString()).toBe('500');
    });

    it('aplica a TODOS los items cuando el pedido crece a 12', async () => {
      // El escenario inverso: el cliente creó 5 piezas a precio normal y el
      // mostrador agregó 7 más. Los items originales TAMBIÉN bajan de precio.
      const { tx, escritos } = crearTx([
        item(1, 5, 100, 95, 100), // original, aún a precio base
        item(2, 7, 100, 95, 100), // agregado en mostrador
      ]);
      const r = await aplicarPromoVolumen(tx, 1);

      expect(r).toEqual({ totalPiezas: 12, aplica: true });
      expect(escritos.map((e) => e.id).sort()).toEqual([1, 2]);
      expect(escritos.every((e) => e.precioUnitario.toString() === '95')).toBe(true);
    });
  });

  describe('idempotencia', () => {
    it('correrlo dos veces da el mismo resultado', async () => {
      const items = [item(1, 6, 100, 95), item(2, 6, 200, 190)];
      const { tx, escritos } = crearTx(items);

      await aplicarPromoVolumen(tx, 1);
      const primeraPasada = escritos.map((e) => e.precioUnitario.toString());

      // Segunda pasada: los items ya quedaron en mayoreo, así que no debe
      // escribir otra vez (ni acumular descuento).
      const itemsActualizados = items.map((i) => ({
        ...i,
        precioUnitario: i.precioUnitarioMayoreo!,
      }));
      const { tx: tx2, escritos: escritos2 } = crearTx(itemsActualizados);
      await aplicarPromoVolumen(tx2, 1);

      expect(primeraPasada).toEqual(['95', '190']);
      expect(escritos2).toHaveLength(0);
    });
  });

  describe('items cancelados', () => {
    it('no cuenta sus piezas ni los re-pricia', async () => {
      // El `where` ya filtra `cancelada: false`; el mock devuelve solo los
      // activos, así que este test fija el contrato de la query.
      const { tx } = crearTx([item(1, 11, 100, 95)]);
      const r = await aplicarPromoVolumen(tx, 1);

      expect(tx.itemPedido.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { pedidoId: 1, cancelada: false },
        }),
      );
      expect(r.totalPiezas).toBe(11);
    });
  });

  describe('pedido sin items', () => {
    it('no explota y reporta 0 piezas', async () => {
      const { tx, escritos } = crearTx([]);
      const r = await aplicarPromoVolumen(tx, 1);

      expect(r).toEqual({ totalPiezas: 0, aplica: false });
      expect(escritos).toHaveLength(0);
    });
  });
});
