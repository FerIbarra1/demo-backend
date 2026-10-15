import { EstadoPedido, EstadoSurtido } from '@prisma/client';
import { BodegaService } from './bodega.service';

/**
 * F17 (oct 2026): el endpoint de la ÁREA DE ENTREGA.
 *
 * El problema que resuelve: cuando el cliente pide cambios en mostrador, el
 * pedido vuelve a bodega — pero la bolsa con el ticket SIGUE físicamente en la
 * mesa del área de entrega. En la tablet de surtido ese pedido aparecía como una
 * tarjeta más en la cola, indistinguible de un pedido nuevo, y el bodeguero no
 * sabía que tenía que ir al área de entrega a sacar prendas de una bolsa.
 *
 * Oct 2026 — el contrato CAMBIÓ: la tarjeta es un AVISO, no un detalle. Antes
 * devolvía `porQuitar`/`porAgregar` (las listas de prendas) y la tarjeta las
 * pintaba, duplicando lo que el sheet ya muestra. Ahora devuelve solo lo que la
 * tarjeta necesita para decir "hay trabajo pendiente en este pedido".
 *
 * Estos tests fijan las dos mitades del contrato:
 *   1. Solo aparecen los pedidos que NECESITAN ajuste (nada de ruido).
 *   2. Cada uno trae la procedencia, para redactar la línea del motivo.
 */

function crearServicio(pedidos: any[] = []) {
  const findMany = jest.fn().mockResolvedValue(pedidos);

  const prisma = {
    pedido: { findMany },
    // El getter `pedidoTraeAjuste` lee `prisma.itemPedido.fields.cantidad` para
    // el field reference. Es una propiedad estática del cliente, no una query.
    itemPedido: { fields: { cantidad: { __field: 'cantidad' } } },
  };

  const svc = new BodegaService(
    prisma as never,
    {} as never, // realtime
    {} as never, // state
    {} as never, // access
  );

  return { svc, findMany };
}

/** Un pedido tal como lo devuelve la query del endpoint. */
function pedido(opts: {
  id?: number;
  items?: any[];
  estadoAnterior?: EstadoPedido | null;
}) {
  return {
    id: opts.id ?? 1,
    numeroPedido: 'PD-2026-000123',
    clienteNombre: 'Juan Pérez',
    canalOrigen: 'KIOSCO',
    fechaPedido: new Date('2026-10-05T10:00:00Z'),
    items: opts.items ?? [],
    historial: [{ estadoAnterior: opts.estadoAnterior ?? EstadoPedido.REVISADO }],
  };
}

/** Un item del pedido, con los defaults que no importan para el test. */
function item(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    cantidad: 3,
    cantidadSurtida: 3,
    piezasRetiradas: 0,
    estadoSurtido: EstadoSurtido.COMPLETO,
    original: true,
    cancelada: false,
    ...over,
  };
}

describe('obtenerAjustesEntrega', () => {
  it('sin tienda devuelve vacío (no consulta)', async () => {
    const { svc, findMany } = crearServicio();
    await expect(svc.obtenerAjustesEntrega(undefined)).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('solo busca pedidos EN_REVISION sin asignar', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerAjustesEntrega(5);

    const where = findMany.mock.calls[0][0].where;
    expect(where.estado).toBe(EstadoPedido.EN_REVISION);
    // Sin asignar: si ya lo tomó un bodeguero, está en su slot, no en el aviso.
    expect(where.asignadoAId).toBeNull();
    expect(where.tiendaId).toBe(5);
  });

  /**
   * F21 (oct 2026): el `where` tiene los TRES caminos, incluido el sobrante.
   *
   * Antes este test hacía `toEqual` sobre el objeto literal del `where`, así que
   * pasaba en verde sin ejercitar la consulta real — y no detectaba que el caso
   * del sobrante (`cantidadSurtida > cantidad`) no estaba en el OR. Un pedido
   * cuyo ÚNICO ajuste fue bajar la cantidad tiene todos sus items
   * `original: true, cancelada: false`, así que ningún item lo satisfacía,
   * Prisma no lo devolvía, y el filtro en memoria solo puede DESCARTAR lo que ya
   * llegó: nunca podía recuperarlo.
   *
   * Se afirma sobre la forma del OR en vez de sobre el objeto completo para que
   * el test siga siendo legible, y se comprueba explícitamente el tercer término.
   */
  it('el filtro grueso incluye los tres caminos, sobrante incluido', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerAjustesEntrega(5);

    const or = findMany.mock.calls[0][0].where.items.some.OR;
    expect(or).toContainEqual({ original: false });
    expect(or).toContainEqual({ cancelada: true });
    // Field reference: compara dos columnas del MISMO modelo dentro del `some`.
    expect(or).toHaveLength(3);
    expect(or[2]).toHaveProperty('cantidadSurtida.gt');
  });

  it('devuelve solo los campos que la tarjeta necesita (folio, cliente, canal, motivo)', async () => {
    const { svc } = crearServicio([
      pedido({ items: [item({ cancelada: true, cantidadSurtida: 2 })] }),
    ]);

    const [r] = await svc.obtenerAjustesEntrega(5);

    // El detalle de prendas vive SOLO en el sheet: el endpoint ya no lo manda.
    expect(r).not.toHaveProperty('porQuitar');
    expect(r).not.toHaveProperty('porAgregar');
    expect(r).toMatchObject({
      id: 1,
      numeroPedido: 'PD-2026-000123',
      clienteNombre: 'Juan Pérez',
      canalOrigen: 'KIOSCO',
      motivoReingreso: 'AJUSTE_MOSTRADOR',
    });
  });

  it('una línea cancelada con piezas apartadas pide trabajo', async () => {
    const { svc } = crearServicio([
      pedido({ items: [item({ id: 2, cantidad: 2, cantidadSurtida: 2, cancelada: true })] }),
    ]);

    const r = await svc.obtenerAjustesEntrega(5);
    expect(r).toHaveLength(1);
  });

  it('F21: el SOBRANTE de una baja de cantidad pide trabajo', async () => {
    // La línea SIGUE activa (no está cancelada) pero se le bajó la cantidad:
    // había 3 y el cliente se lleva 1 → sobran 2 prendas en la bolsa.
    const { svc } = crearServicio([
      pedido({ items: [item({ id: 5, cantidad: 1, cantidadSurtida: 3, cancelada: false })] }),
    ]);

    const r = await svc.obtenerAjustesEntrega(5);
    expect(r).toHaveLength(1);
  });

  it('F21: un faltante de bodega NO pide trabajo', async () => {
    // NO_DISPONIBLE: `cantidadSurtida` es 0, así que no hay nada en la bolsa.
    // El fallback viejo reportaba la cantidad PEDIDA y mandaba al bodeguero a
    // buscar prendas que nunca salieron del anaquel.
    const { svc } = crearServicio([
      pedido({
        items: [
          item({
            id: 6,
            cantidad: 5,
            cantidadSurtida: 0,
            cancelada: true,
            estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
          }),
        ],
      }),
    ]);

    const r = await svc.obtenerAjustesEntrega(5);
    expect(r).toHaveLength(0);
  });

  it('F21: un pedido sin trabajo real no aparece en la tarjeta', async () => {
    // Cancelada pero sin piezas apartadas: no hay nada que sacar.
    const { svc } = crearServicio([
      pedido({ items: [item({ id: 7, cantidad: 3, cantidadSurtida: 0, cancelada: true })] }),
    ]);

    const ajustes = await svc.obtenerAjustesEntrega(5);
    expect(ajustes).toHaveLength(0);
  });

  /**
   * F21 (oct 2026): el retiro YA HECHO no se vuelve a pedir.
   *
   * `piezasFueraDeLaBolsa` es posicional: no sabe que el bodeguero ya sacó las
   * prendas. Sin `piezasRetiradas`, un segundo ajuste sobre el mismo pedido
   * volvía a pedir sacar mercancía que ya estaba fuera de la bolsa.
   */
  it('F21: un retiro ya confirmado deja de pedir trabajo', async () => {
    const { svc } = crearServicio([
      pedido({
        items: [
          item({
            id: 8,
            cantidad: 1,
            cantidadSurtida: 3,
            piezasRetiradas: 2, // las 2 que sobraban ya se sacaron
            cancelada: false,
          }),
        ],
      }),
    ]);

    const r = await svc.obtenerAjustesEntrega(5);
    expect(r).toHaveLength(0);
  });

  it('F21: un retiro parcial sigue pidiendo el resto', async () => {
    // El ajuste 1 quitó 2 y el ajuste 2 quitó 1 más: el total fuera de la bolsa
    // es 3, y solo se retiraron 2. La tercera tiene que salir.
    const { svc } = crearServicio([
      pedido({
        items: [
          item({
            id: 9,
            cantidad: 1,
            cantidadSurtida: 4,
            piezasRetiradas: 2,
            cancelada: false,
          }),
        ],
      }),
    ]);

    const r = await svc.obtenerAjustesEntrega(5);
    expect(r).toHaveLength(1);
  });

  /**
   * P2 (oct 2026): un item agregado YA SURTIDO no es trabajo pendiente.
   *
   * El filtro viejo era `!i.cancelada && !i.original`, sin mirar `estadoSurtido`
   * — aunque su propio comentario decía "y que nadie ha verificado todavía". Un
   * item agregado que bodega ya surtió (COMPLETO) seguía apareciendo como "Traer
   * del anaquel", mandando a buscar prendas que ya estaban en la bolsa.
   */
  it('un item agregado ya surtido no pide trabajo', async () => {
    const { svc } = crearServicio([
      pedido({
        items: [
          item({
            id: 10,
            original: false,
            estadoSurtido: EstadoSurtido.COMPLETO,
            cantidad: 4,
            cantidadSurtida: 4,
          }),
        ],
      }),
    ]);

    const r = await svc.obtenerAjustesEntrega(5);
    expect(r).toHaveLength(0);
  });

  it('un item agregado PENDIENTE sí pide trabajo (traer del anaquel)', async () => {
    // El caso que el filtro fino NO debe perder: un pedido cuyo único trabajo es
    // traer del anaquel, sin nada que quitar de la bolsa.
    const { svc } = crearServicio([
      pedido({
        items: [
          item({
            id: 11,
            original: false,
            estadoSurtido: EstadoSurtido.PENDIENTE,
            cantidad: 4,
            cantidadSurtida: 0,
          }),
        ],
      }),
    ]);

    const r = await svc.obtenerAjustesEntrega(5);
    expect(r).toHaveLength(1);
  });

  it('un item cancelado NO se cuenta también como agregado', async () => {
    // Un item cancelado que además fuera `original: false` (agregado en un
    // ajuste anterior y luego retirado) pide trabajo UNA vez, no dos.
    //
    // Este caso vivía en `bodega-plancha.spec.ts`, que se borró al renombrar el
    // endpoint; se recupera aquí para no perder la cobertura.
    const { svc } = crearServicio([
      pedido({ items: [item({ id: 9, original: false, cancelada: true, cantidadSurtida: 2 })] }),
    ]);

    const r = await svc.obtenerAjustesEntrega(5);
    expect(r).toHaveLength(1);
  });

  it('deriva el motivo de reingreso del último cambio de estado', async () => {
    const { svc } = crearServicio([
      pedido({
        id: 1,
        estadoAnterior: EstadoPedido.REVISADO,
        items: [item({ cancelada: true, cantidadSurtida: 2 })],
      }),
      pedido({
        id: 2,
        estadoAnterior: EstadoPedido.ESPERANDO_APROBACION,
        items: [item({ id: 5, original: false, estadoSurtido: EstadoSurtido.PENDIENTE })],
      }),
    ]);

    const r = await svc.obtenerAjustesEntrega(5);
    // Vino del área de entrega → el cliente cambió algo en mostrador.
    expect(r[0].motivoReingreso).toBe('AJUSTE_MOSTRADOR');
    // Vino de una propuesta → el cliente aprobó la contrapropuesta del asesor.
    expect(r[1].motivoReingreso).toBe('PROPUESTA_VENTAS');
  });
});

/**
 * F21 (oct 2026): el predicado compartido entre la tarjeta y el lote.
 *
 * `obtenerLoteSurtirJuntos` excluye estos pedidos del picking por lote (el lote
 * no tiene checklist de retiro). Antes tenía su PROPIA copia del `where`, sin el
 * término del sobrante, así que un pedido cuyo único ajuste fue bajar la
 * cantidad SÍ entraba al lote y avanzaba con prendas de más en la bolsa.
 */
describe('pedidoTraeAjuste (predicado compartido)', () => {
  it('el lote excluye los pedidos con sobrante, igual que la tarjeta', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerLoteSurtirJuntos(1, 5);

    const notItems = findMany.mock.calls[0][0].where.NOT.items;
    const or = notItems.some.OR;
    // Mismo predicado que la tarjeta: si divergieran, un pedido con sobrante
    // entraría al lote sin checklist.
    expect(or).toContainEqual({ original: false });
    expect(or).toContainEqual({ cancelada: true });
    expect(or[2]).toHaveProperty('cantidadSurtida.gt');
  });
});
