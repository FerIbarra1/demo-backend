import { ClienteService } from './cliente.service';
import { PreciosService } from '../../precios/precios.service';
import { CanalOrigen, EstadoPedido, ModoEntrega, Prisma } from '@prisma/client';

/**
 * Fase 0 (sep 2026): el pedido debe congelar el precio de la lista DEL CLIENTE.
 *
 * El bug que estos tests previenen: `crearPedido` usaba `pco.precio` (que es
 * sinónimo de `lista1`) sin importar la lista del cliente. Un cliente con lista
 * 3 veía precios de lista 3 en el catálogo y se le cobraba lista 1, con el
 * error congelado en `ItemPedido.precioUnitario` (snapshot) y viajando así al
 * ERP.
 *
 * Se prueba a nivel de `crearPedido` con Prisma mockeado: lo que importa es el
 * `precioUnitario` y el `subtotal` que se escriben, no la BD.
 */

/** PrecioCO con precios claramente distintos por lista, para detectar cruces. */
function precioCOMock(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    productoId: 10 + id,
    tiendaId: 1,
    corridaId: 1,
    tallaId: 1,
    colorId: 1,
    precio: new Prisma.Decimal('100.00'),
    lista1: new Prisma.Decimal('100.00'),
    lista2: new Prisma.Decimal('200.00'),
    lista3: new Prisma.Decimal('300.00'),
    lista4: new Prisma.Decimal('400.00'),
    lista5: new Prisma.Decimal('500.00'),
    lista6: new Prisma.Decimal('600.00'),
    producto: { id: 10 + id, nombre: `Producto ${id}`, codigo: `COD-${id}` },
    corrida: { nombre: 'Corrida A' },
    talla: { nombre: 'M' },
    color: { nombre: 'Rojo' },
    ...overrides,
  };
}

/**
 * Construye un ClienteService con Prisma mockeado. `listaPrecioCodigo` es la
 * lista GLOBAL del usuario; `listaPorTienda` la de `UsuarioTienda`.
 */
function crearServicio(opts: {
  preciosCO: ReturnType<typeof precioCOMock>[];
  listaPrecioCodigo?: string | null;
  listaPorTienda?: string | null;
}) {
  const pedidoCreado: { data?: any } = {};

  const prisma = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue(null), // sin idempotency hit
      create: jest.fn(async (args: any) => {
        pedidoCreado.data = args.data;
        return {
          id: 99,
          numeroPedido: args.data.numeroPedido,
          tiendaId: args.data.tiendaId,
          canalOrigen: args.data.canalOrigen,
          kioskoId: args.data.kioskoId,
          items: args.data.items.create,
          ...args.data,
        };
      }),
    },
    tienda: { findFirst: jest.fn().mockResolvedValue({ id: 1, activa: true }) },
    precioCO: { findMany: jest.fn().mockResolvedValue(opts.preciosCO) },
    usuario: {
      findUnique: jest.fn().mockResolvedValue({
        listaPrecioCodigo: opts.listaPrecioCodigo ?? null,
        tiendasCliente:
          opts.listaPorTienda !== undefined
            ? [{ listaPrecioCodigo: opts.listaPorTienda }]
            : [],
      }),
    },
  };

  const svc = new ClienteService(
    prisma as never,
    // `enviar` es fire-and-forget (`.catch(...)`), así que debe devolver una
    // promesa o el `void` explota antes de llegar a las aserciones.
    { enviar: jest.fn().mockResolvedValue(undefined) } as never, // notifications
    { emitToTienda: jest.fn() } as never, // realtime
    { generarNumeroPedido: jest.fn().mockResolvedValue('PD-2026-000001') } as never, // state
    {} as never, // storage
    {} as never, // kioskoService
    {} as never, // kioskoLlegada
    new PreciosService(prisma as never),
  );

  return { svc, pedidoCreado, prisma };
}

const usuarioBase = {
  userId: 7,
  nombre: 'Cliente Test',
  rol: 'CLIENTE' as never,
  tiendaId: 1,
};

const dtoBase = {
  clienteNombre: 'Cliente Test',
  clienteEmail: 'cliente@test.local',
  modoEntrega: ModoEntrega.RECOGER_TIENDA,
  items: [{ precioCOId: 1, cantidad: 3 }],
};

describe('ClienteService.crearPedido — precio por lista (Fase 0)', () => {
  it('congela el precio de la lista 3 cuando el cliente tiene lista 3', async () => {
    const { svc, pedidoCreado } = crearServicio({
      preciosCO: [precioCOMock(1)],
      listaPrecioCodigo: '3',
    });

    await svc.crearPedido(dtoBase as never, usuarioBase as never);

    const item = pedidoCreado.data.items.create[0];
    expect(item.precioUnitario.toString()).toBe('300');
    // 300 × 3, no 100 × 3
    expect(item.subtotal.toString()).toBe('900');
    expect(pedidoCreado.data.subtotal.toString()).toBe('900');
    expect(pedidoCreado.data.total.toString()).toBe('900');
  });

  it('NO usa lista1 cuando el cliente tiene otra lista (regresión del bug)', async () => {
    const { svc, pedidoCreado } = crearServicio({
      preciosCO: [precioCOMock(1)],
      listaPrecioCodigo: '2',
    });

    await svc.crearPedido(dtoBase as never, usuarioBase as never);

    const item = pedidoCreado.data.items.create[0];
    expect(item.precioUnitario.toString()).not.toBe('100');
    expect(item.precioUnitario.toString()).toBe('200');
  });

  it('usa lista1 cuando el cliente no tiene lista (sin regresión)', async () => {
    const { svc, pedidoCreado } = crearServicio({
      preciosCO: [precioCOMock(1)],
      listaPrecioCodigo: null,
    });

    await svc.crearPedido(dtoBase as never, usuarioBase as never);

    const item = pedidoCreado.data.items.create[0];
    expect(item.precioUnitario.toString()).toBe('100');
    expect(item.subtotal.toString()).toBe('300');
  });

  it('la lista por tienda gana sobre la global', async () => {
    const { svc, pedidoCreado } = crearServicio({
      preciosCO: [precioCOMock(1)],
      listaPrecioCodigo: '2', // global
      listaPorTienda: '5', // por sucursal — debe ganar
    });

    await svc.crearPedido(dtoBase as never, usuarioBase as never);

    const item = pedidoCreado.data.items.create[0];
    expect(item.precioUnitario.toString()).toBe('500');
  });

  it('el total es la suma de los subtotales con lista mixta', async () => {
    const { svc, pedidoCreado } = crearServicio({
      // Dos productos con listas distintas capturadas: el segundo sin lista 4
      // (0) debe caer a su precio base, no a 0.
      preciosCO: [
        precioCOMock(1),
        precioCOMock(2, { lista4: new Prisma.Decimal('0'), precio: new Prisma.Decimal('50.00') }),
      ],
      listaPrecioCodigo: '4',
    });

    await svc.crearPedido(
      {
        ...dtoBase,
        items: [
          { precioCOId: 1, cantidad: 2 }, // 400 × 2 = 800
          { precioCOId: 2, cantidad: 1 }, // lista4=0 → fallback 50 × 1 = 50
        ],
      } as never,
      usuarioBase as never,
    );

    const items = pedidoCreado.data.items.create;
    expect(items[0].precioUnitario.toString()).toBe('400');
    expect(items[0].subtotal.toString()).toBe('800');
    expect(items[1].precioUnitario.toString()).toBe('50');
    expect(items[1].subtotal.toString()).toBe('50');
    expect(pedidoCreado.data.total.toString()).toBe('850');
  });

  it('mantiene el estado inicial y el modo de entrega', async () => {
    const { svc, pedidoCreado } = crearServicio({
      preciosCO: [precioCOMock(1)],
      listaPrecioCodigo: '3',
    });

    await svc.crearPedido(dtoBase as never, usuarioBase as never);

    expect(pedidoCreado.data.estado).toBe(EstadoPedido.PENDING_REVIEW);
    expect(pedidoCreado.data.canalOrigen).toBe(CanalOrigen.WEB);
    expect(pedidoCreado.data.modoEntrega).toBe(ModoEntrega.RECOGER_TIENDA);
    // El precio de lista no debe alterar el snapshot de cantidad original.
    expect(pedidoCreado.data.items.create[0].cantidadOriginal).toBe(3);
  });
});
