import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EstadoSurtido, Prisma } from '@prisma/client';
import { AjusteService } from './ajuste.service';

/**
 * Fase 2 (oct 2026): la parte de `calcularAjuste` que toca la BD.
 *
 * La calculadora es pura y tiene su propio spec; aquí se fija lo que le toca al
 * servicio: que los precios de un producto AGREGADO salgan de la lista del
 * CLIENTE que hizo el pedido (no de `pco.precio`, que es siempre lista 1), que
 * una variante ajena o inexistente falle al ENVIAR y no cuando el cliente
 * aprueba, y que la imagen se resuelva igual que en el detalle del pedido.
 */

const D = (n: number) => new Prisma.Decimal(n);

function item(id: number, cantidad: number) {
  return {
    id,
    pedidoId: 1,
    productoNombre: `P${id}`,
    productoCodigo: `C${id}`,
    productoId: 10 + id,
    precioCOId: 20 + id,
    corridaNombre: 'Adulto',
    tallaNombre: 'M',
    colorNombre: 'N',
    cantidadPedida: cantidad,
    cantidad,
    cantidadSurtida: cantidad,
    piezasRetiradas: 0,
    estadoSurtido: EstadoSurtido.COMPLETO,
    cancelada: false,
    precioUnitario: D(100),
    precioUnitarioBase: D(100),
    precioUnitarioMayoreo: D(80),
    subtotal: D(100).mul(cantidad),
    producto: {
      imagenPrincipal: 'general.jpg',
      imagenesProducto: [{ url: 'azul.jpg', colorId: 3 }],
    },
    precioCO: { colorId: 3 },
  };
}

/** Variante del catálogo: lista1 $60, lista2 $57, lista3 $54 (la del cliente del caso). */
function variante(over: Record<string, unknown> = {}) {
  return {
    id: 9,
    tiendaId: 5,
    productoId: 99,
    colorId: 4,
    precio: D(60),
    lista1: D(60),
    lista2: D(57),
    lista3: D(54),
    lista4: D(0),
    lista5: D(0),
    lista6: D(0),
    producto: {
      nombre: 'Nueva',
      codigo: 'CN',
      imagenPrincipal: 'general.jpg',
      imagenesProducto: [{ url: 'rojo.jpg', colorId: 4 }],
    },
    talla: { nombre: 'L' },
    color: { nombre: 'Rojo' },
    corrida: { nombre: 'Adulto' },
    ...over,
  };
}

function crear(opts: { variantes?: any[]; columna?: string } = {}) {
  const prisma: any = {
    pedido: { findUnique: jest.fn(async () => ({ id: 1, usuarioId: 100, tiendaId: 5 })) },
    itemPedido: { findMany: jest.fn(async () => [item(1, 8)]) },
    precioCO: { findMany: jest.fn(async () => opts.variantes ?? [variante()]) },
  };
  const precios = { columnaParaPedido: jest.fn(async () => opts.columna ?? 'lista1') };
  const access = { cargarYValidar: jest.fn(async () => ({})) };
  const storage = { resolverImagen: jest.fn((v: string | null) => (v ? `cdn/${v}` : null)) };
  const svc = new AjusteService(prisma, access as never, precios as never, storage as never);
  return { svc, prisma, precios, access, storage };
}

const usuario = { userId: 8, rol: 'VENTAS', tiendaId: 5, nombre: 'Asesor' } as never;

describe('AjusteService.calcular', () => {
  it('describe el pedido con la imagen del COLOR de la variante, no la general', async () => {
    const { svc } = crear();
    const r = await svc.calcular(1, []);
    expect(r.items[0].productoImagen).toBe('cdn/azul.jpg');
  });

  it('un AGREGAR usa la lista del CLIENTE que hizo el pedido, no lista 1', async () => {
    const { svc, precios } = crear({ columna: 'lista3' });
    const r = await svc.calcular(1, [{ accion: 'AGREGAR', precioCOId: 9, cantidad: 2 }]);

    expect(precios.columnaParaPedido).toHaveBeenCalledWith(
      expect.objectContaining({ usuarioId: 100, tiendaId: 5 }),
    );
    const a = r.items.find((l) => l.tipo === 'agregado')!;
    // 10 piezas < 12 → sin promo → el precio de SU lista ($54), no los $60 de lista 1.
    expect(a.precioUnitario).toBe(54);
    expect(a.subtotal).toBe(108);
    expect(a.productoImagen).toBe('cdn/rojo.jpg');
    expect(a.variante).toBe('Adulto · L · Rojo');
  });

  it('una variante de OTRA tienda falla al calcular, no al aprobar', async () => {
    const { svc } = crear({ variantes: [variante({ tiendaId: 99 })] });
    await expect(
      svc.calcular(1, [{ accion: 'AGREGAR', precioCOId: 9, cantidad: 1 }]),
    ).rejects.toThrow(BadRequestException);
  });

  it('una variante que no existe responde 404', async () => {
    const { svc } = crear({ variantes: [] });
    await expect(
      svc.calcular(1, [{ accion: 'AGREGAR', precioCOId: 9, cantidad: 1 }]),
    ).rejects.toThrow(NotFoundException);
  });

  it('carga también las líneas que bodega no encontró, para poder reponerlas', async () => {
    const { svc, prisma } = crear();
    await svc.calcular(1, []);

    // Vivas + las que `sePuedeReponer`; el filtro fino lo hace la calculadora.
    const { where } = prisma.itemPedido.findMany.mock.calls[0][0];
    expect(where.pedidoId).toBe(1);
    expect(where.OR).toEqual([
      { cancelada: false },
      { cancelada: true, estadoSurtido: EstadoSurtido.NO_DISPONIBLE, cantidadSurtida: 0 },
    ]);
  });

  it('REPONER sobre una línea sin existencia la devuelve al snapshot', async () => {
    const { svc, prisma } = crear();
    prisma.itemPedido.findMany.mockResolvedValue([
      item(1, 8),
      {
        ...item(2, 5),
        cancelada: true,
        estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
        cantidadSurtida: 0,
      },
    ]);

    const r = await svc.calcular(1, [{ accion: 'REPONER', itemId: 2, cantidad: 3 }]);

    expect(r.items.find((l) => l.itemId === 2)).toMatchObject({
      tipo: 'parcial',
      cantidadNueva: 3,
      cantidadDisponible: 0,
      productoImagen: 'cdn/azul.jpg',
    });
  });

  it('REPONER sobre una línea viva responde 400', async () => {
    const { svc } = crear();
    await expect(svc.calcular(1, [{ accion: 'REPONER', itemId: 1, cantidad: 3 }])).rejects.toThrow(
      BadRequestException,
    );
  });

  it('no consulta el catálogo si no se agrega nada', async () => {
    const { svc, prisma, precios } = crear();
    await svc.calcular(1, [{ accion: 'CANTIDAD', itemId: 1, cantidad: 3 }]);
    expect(prisma.precioCO.findMany).not.toHaveBeenCalled();
    expect(precios.columnaParaPedido).not.toHaveBeenCalled();
  });

  it('usa el cliente transaccional que le pasan', async () => {
    const { svc, prisma } = crear();
    const tx: any = {
      pedido: { findUnique: jest.fn(async () => ({ id: 1, usuarioId: 100, tiendaId: 5 })) },
      itemPedido: { findMany: jest.fn(async () => [item(1, 8)]) },
      precioCO: { findMany: jest.fn() },
    };
    await svc.calcular(1, [], tx);
    expect(tx.itemPedido.findMany).toHaveBeenCalled();
    expect(prisma.itemPedido.findMany).not.toHaveBeenCalled();
  });
});

describe('AjusteService.vistaPrevia', () => {
  it('valida primero que el usuario pueda ver el pedido', async () => {
    const { svc, access } = crear();
    await svc.vistaPrevia(1, [], usuario);
    expect(access.cargarYValidar).toHaveBeenCalledWith(1, usuario);
  });

  it('si no tiene acceso, no calcula nada', async () => {
    const { svc, access, prisma } = crear();
    access.cargarYValidar.mockRejectedValueOnce(new Error('sin acceso'));
    await expect(svc.vistaPrevia(1, [], usuario)).rejects.toThrow('sin acceso');
    expect(prisma.itemPedido.findMany).not.toHaveBeenCalled();
  });
});
