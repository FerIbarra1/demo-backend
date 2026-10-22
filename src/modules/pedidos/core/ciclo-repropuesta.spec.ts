import { Prisma, EstadoSurtido, EstadoPedido } from '@prisma/client';
import { aplicarPropuestaDeVentas } from './aplicar-propuesta-ventas.util';
import { aplicarCambiosFisicos } from './aplicar-cambios-surtido.util';
import { construirPropuestaDeBodega } from './propuesta-bodega.util';
import { piezasFueraDeLaBolsa } from './ajuste-cantidad.util';
import { motivoDeReingreso, derivarMotivoReingreso } from './motivo-reingreso';

/**
 * F21 (oct 2026) — FASE 3: el ciclo de re-propuesta.
 *
 * El escenario que el usuario describió:
 *
 *   "Si el ajuste viene incompleto vuelve el mismo flujo de propuesta, enviar al
 *    cliente. Tomar en cuenta que también puede que el cliente ya esté en
 *    mostrador."
 *
 * Y los casos que enumeró:
 *
 *   - "Que no haya cantidad del nuevo producto que seleccionó."
 *   - "Un producto que solo había 4 disponibles, cancelaron otro pedido que
 *      tenía el producto, y por ende puedo poner más cantidad."
 *
 * Este spec fija las DOS vueltas del ciclo y los dos finales posibles: el pedido
 * cierra, o vuelve a generar propuesta. Lo que NO puede pasar es que se quede
 * atorado en medio.
 */

// ---------------------------------------------------------------- helpers

const BASE = 100;
const MAYOREO = 80;

function item(opts: {
  id: number;
  cantidadPedida: number;
  cantidadSurtida: number;
  cantidad: number;
  estadoSurtido?: EstadoSurtido;
  cancelada?: boolean;
  original?: boolean;
}) {
  const estadoSurtido = opts.estadoSurtido ?? EstadoSurtido.COMPLETO;
  return {
    id: opts.id,
    productoId: 1,
    productoNombre: `Prenda ${opts.id}`,
    productoCodigo: `C0${opts.id}`,
    productoImagen: null,
    corridaNombre: 'Verano',
    tallaNombre: 'M',
    colorNombre: 'Negro',
    cantidadPedida: opts.cantidadPedida,
    cantidad: opts.cantidad,
    cantidadSurtida: opts.cantidadSurtida,
    estadoSurtido,
    precioUnitario: new Prisma.Decimal(BASE),
    precioUnitarioBase: new Prisma.Decimal(BASE),
    precioUnitarioMayoreo: new Prisma.Decimal(MAYOREO),
    subtotal: new Prisma.Decimal(BASE * opts.cantidad),
    cancelada: opts.cancelada ?? false,
    original: opts.original ?? true,
  };
}

function crearTx(items: any[]) {
  const updates: Array<{ id: number; data: any }> = [];
  const creados: any[] = [];
  const estado = new Map(items.map((i) => [i.id, { ...i }]));
  const tx = {
    pedidoDtf: { count: async () => 0, findMany: async () => [] }, // sin trabajos DTF (impresión DTF, oct 2026)
    itemPedido: {
      findUnique: async ({ where }: any) => estado.get(where.id) ?? null,
      findMany: async () => [...estado.values()],
      update: async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        const actual = { ...estado.get(where.id), ...data };
        estado.set(where.id, actual);
        return actual;
      },
      create: async ({ data }: any) => {
        creados.push(data);
        return data;
      },
      count: async ({ where }: any) =>
        [...estado.values()].filter((i) => {
          if (i.cancelada) return false;
          if (where?.estadoSurtido?.not) return i.estadoSurtido !== where.estadoSurtido.not;
          return true;
        }).length,
    },
    pedido: { update: async () => ({}) },
    pedidoPropuesta: { update: async () => ({}) },
    precioCO: {
      findUnique: async ({ where }: any) => ({
        id: where.id,
        productoId: 9,
        tiendaId: 1,
        producto: { nombre: 'Prenda nueva', codigo: 'C099' },
        corrida: { nombre: 'Verano' },
        talla: { nombre: 'L' },
        color: { nombre: 'Azul' },
        precio: 100,
        precio1: 100,
        precio2: 80,
        precio3: 100,
        precio4: 100,
        precio5: 100,
        precio6: 100,
      }),
    },
  };
  return { tx, updates, creados };
}

const pedido = {
  id: 1,
  tiendaId: 1,
  descuento: new Prisma.Decimal(0),
  impuestos: new Prisma.Decimal(0),
};

// ---------------------------------------------------------------- vuelta 1

describe('F21 fase 3 — el ajuste que SUBE y bodega no alcanza', () => {
  it('el item vuelve a bodega a surtir las piezas nuevas', async () => {
    const items = [item({ id: 1, cantidadPedida: 5, cantidadSurtida: 3, cantidad: 3 })];
    const { tx } = crearTx(items);

    const r = await aplicarPropuestaDeVentas(
      tx as never,
      pedido,
      [
        {
          itemId: 1,
          tipo: 'parcial',
          producto: 'Prenda 1',
          variante: 'M',
          cantidad: 5,
          precioUnitario: BASE,
          subtotal: 500,
          cantidadNueva: 7,
        },
      ] as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );

    // Queda pendiente: bodega tiene que verificar 4 piezas que nadie vio.
    expect(r.quedanPendientes).toBe(true);
  });

  it('bodega cierra y NO alcanza: nace una propuesta nueva para el cliente', () => {
    // Bodega fue a surtir las 4 nuevas y solo encontró 1. El estado queda:
    // pidió 7, hay 4, se lleva 4 → y el sistema tiene que proponerle eso.
    const trasSurtido = [
      item({
        id: 1,
        cantidadPedida: 7,
        cantidadSurtida: 4,
        cantidad: 4,
        estadoSurtido: EstadoSurtido.PARCIAL,
      }),
    ];

    const { items, total } = construirPropuestaDeBodega(trasSurtido as never);

    const linea = items[0];
    expect(linea.tipo).toBe('parcial');
    expect(linea.cantidadOriginal).toBe(7); // lo que pidió
    expect(linea.cantidadNueva).toBe(4); // lo que hay
    expect(total).toBe(400);
  });

  it('el cliente aprueba la propuesta nueva y el pedido cierra', async () => {
    const items = [
      item({
        id: 1,
        cantidadPedida: 7,
        cantidadSurtida: 4,
        cantidad: 4,
        estadoSurtido: EstadoSurtido.PARCIAL,
      }),
    ];
    const { tx, updates } = crearItemTx(items);

    // El cliente aprueba "lo que hay": la propuesta trae tipo 'completo' cuando
    // ya no hay nada que negociar.
    await aplicarCambiosFisicos(tx as never, pedido, [
      { id: 1, estadoSurtido: EstadoSurtido.PARCIAL, cantidadSurtida: 4, motivoSurtido: null },
    ]);

    const u = updates.find((x) => x.id === 1)!;
    expect(u.data.cantidad).toBe(4);
    expect(u.data.estadoSurtido).toBe(EstadoSurtido.COMPLETO);
  });
});

/** Un `tx` que captura updates, para `aplicarCambiosFisicos`. */
function crearItemTx(items: any[]) {
  const updates: Array<{ id: number; data: any }> = [];
  const estado = new Map(items.map((i) => [i.id, { ...i }]));
  const tx = {
    pedidoDtf: { count: async () => 0, findMany: async () => [] }, // sin trabajos DTF (impresión DTF, oct 2026)
    itemPedido: {
      findUnique: async ({ where }: any) => estado.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        estado.set(where.id, { ...estado.get(where.id), ...data });
        return estado.get(where.id);
      },
    },
    pedido: { update: async () => ({}) },
  };
  return { tx, updates };
}

// ---------------------------------------------------------------- agregado

describe('F21 fase 3 — el producto agregado que tampoco existe', () => {
  it('nace PENDIENTE: nadie lo ha verificado contra el anaquel', async () => {
    const items = [item({ id: 1, cantidadPedida: 3, cantidadSurtida: 3, cantidad: 3 })];
    const { tx, creados } = crearTx(items);

    await aplicarPropuestaDeVentas(
      tx as never,
      pedido,
      [
        {
          itemId: -1,
          tipo: 'agregado',
          producto: 'Prenda nueva',
          variante: 'L · Azul',
          cantidad: 2,
          precioUnitario: BASE,
          subtotal: 200,
          tempId: -1,
          precioCOId: 77,
        },
      ] as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );

    expect(creados).toHaveLength(1);
    // El item agregado nace PENDIENTE: bodega tiene que verificar que exista.
    expect(creados[0].estadoSurtido).toBe('PENDIENTE');
    expect(creados[0].original).toBe(false);
  });

  it('bodega no lo encuentra y el cliente decide otra vez', () => {
    // El agregado quedó NO_DISPONIBLE tras la verificación de bodega. La
    // propuesta nueva lo reporta como tal y NO lo cobra.
    const items = [
      item({ id: 1, cantidadPedida: 3, cantidadSurtida: 3, cantidad: 3 }),
      item({
        id: 2,
        cantidadPedida: 2,
        cantidadSurtida: 0,
        cantidad: 2,
        estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
        original: false,
      }),
    ];

    const { items: propuestos, total } = construirPropuestaDeBodega(items as never);

    const agregado = propuestos.find((p) => p.itemId === 2)!;
    expect(agregado.tipo).toBe('no-disponible');
    expect(agregado.subtotal).toBe(0); // no se cobra
    // Solo se cobra la línea que sí existe.
    expect(total).toBe(300);
  });
});

// ---------------------------------------------------------------- retiro

describe('F21 fase 3 — el pedido que vuelve SOLO a retirar de la bolsa', () => {
  it('el sobrante de una baja llega a la tarjeta de ajustes', () => {
    // El asesor bajó de 5 a 2 y había 3 en la bolsa: sobra 1. La línea SIGUE
    // activa, así que el filtro `cancelada` de la tarjeta no la veía.
    const activaReducida = { cancelada: false, cantidad: 2, cantidadSurtida: 3 };
    expect(piezasFueraDeLaBolsa(activaReducida)).toBe(1);
  });

  it('una línea cancelada devuelve todo lo que había', () => {
    expect(piezasFueraDeLaBolsa({ cancelada: true, cantidad: 5, cantidadSurtida: 3 })).toBe(3);
  });

  it('un faltante de bodega NO manda a buscar prendas que nunca salieron', () => {
    // NO_DISPONIBLE: cantidadSurtida 0. El fallback viejo reportaba la cantidad
    // PEDIDA y mandaba al bodeguero a buscar 5 prendas que nunca estuvieron.
    expect(piezasFueraDeLaBolsa({ cancelada: true, cantidad: 5, cantidadSurtida: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------- motivo

describe('F21 fase 3 — por qué le llegó el pedido al bodeguero', () => {
  it('vuelve de ESPERANDO_APROBACION: fue una propuesta del asesor', () => {
    expect(motivoDeReingreso(EstadoPedido.ESPERANDO_APROBACION)).toBe('PROPUESTA_VENTAS');
  });

  it('vuelve del área de entrega: el cliente cambió algo', () => {
    expect(motivoDeReingreso(EstadoPedido.REVISADO)).toBe('AJUSTE_MOSTRADOR');
  });

  it('vuelve de asesoría: el asesor revisó y el pedido estaba bien', () => {
    expect(motivoDeReingreso(EstadoPedido.EN_ASESORIA)).toBe('ASESORIA');
  });

  it('vuelve de bodega: otro bodeguero lo liberó', () => {
    expect(motivoDeReingreso(EstadoPedido.EN_REVISION)).toBe('LIBERADO');
  });

  it('sin procedencia conocida no inventa un motivo', () => {
    expect(motivoDeReingreso(null)).toBe(null);
  });

  it('coincide con `derivarMotivoReingreso` en los casos sin items nuevos', () => {
    // Las dos funciones tienen que contar la misma historia: una la usa el
    // monitor (con items) y la otra la tarjeta de ajustes (sin items).
    for (const estado of [
      EstadoPedido.REVISADO,
      EstadoPedido.ESPERANDO_APROBACION,
      EstadoPedido.EN_ASESORIA,
      EstadoPedido.EN_REVISION,
    ]) {
      const conItems = derivarMotivoReingreso({
        estado: EstadoPedido.EN_REVISION,
        asignadoAId: null,
        items: [{ original: true }],
        historial: [{ estadoAnterior: estado }],
      });
      expect(conItems).toBe(motivoDeReingreso(estado));
    }
  });
});
