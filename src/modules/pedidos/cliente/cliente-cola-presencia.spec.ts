import { CanalOrigen, ModoEntrega, Prisma } from '@prisma/client';
import { ClienteService } from './cliente.service';
import { PreciosService } from '../../precios/precios.service';

/**
 * F22 (oct 2026): el lugar en la cola de mostrador.
 *
 * Un pedido de KIOSKO se hace con el cliente EN la tienda, así que su lugar en la cola
 * cuenta desde ese momento (`presenteDesdeAt`). Un web empieza sin lugar: lo toma
 * cuando avisa su llegada. Es la llave de orden de la cola — antes todo web con aviso
 * pasaba delante de cualquier kiosko aunque este llevara media hora esperando.
 *
 * Y los dos endpoints nuevos del cliente: retirar su aviso y "sí, aún lo quiero".
 */

const precioCO = {
  id: 1,
  productoId: 11,
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
  producto: { id: 11, nombre: 'Producto', codigo: 'COD-1' },
  corrida: { nombre: 'Corrida A' },
  talla: { nombre: 'M' },
  color: { nombre: 'Rojo' },
};

function crearServicio() {
  const creado: { data?: any } = {};
  const prisma = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (args: any) => {
        creado.data = args.data;
        return { id: 99, ...args.data, items: args.data.items.create };
      }),
    },
    tienda: { findFirst: jest.fn().mockResolvedValue({ id: 1, activa: true }) },
    kiosko: { findFirst: jest.fn().mockResolvedValue({ id: 42 }) },
    precioCO: { findMany: jest.fn().mockResolvedValue([precioCO]) },
    usuario: {
      findUnique: jest.fn().mockResolvedValue({ listaPrecioCodigo: null, tiendasCliente: [] }),
    },
  };
  const presencia = { retirarPorCliente: jest.fn().mockResolvedValue({ ok: true, pedidoId: 5 }) };
  const sinRecoger = { confirmarInteres: jest.fn().mockResolvedValue({ ok: true, pedidoId: 5 }) };

  const svc = new ClienteService(
    prisma as never,
    { enviar: jest.fn().mockResolvedValue(undefined) } as never,
    { emitToTienda: jest.fn() } as never,
    { generarNumeroPedido: jest.fn().mockResolvedValue('PD-2026-000001') } as never,
    {} as never, // storage
    { validarDeviceToken: jest.fn().mockResolvedValue(true) } as never, // kioskoService
    {} as never, // kioskoLlegada
    new PreciosService(prisma as never),
    {} as never, // reposicion
    presencia as never,
    sinRecoger as never,
  );
  return { svc, creado, presencia, sinRecoger };
}

const usuario = { userId: 7, nombre: 'Cliente', rol: 'CLIENTE' as never, tiendaId: 1 };
const dto = {
  clienteNombre: 'Cliente',
  clienteEmail: 'c@test.local',
  modoEntrega: ModoEntrega.RECOGER_TIENDA,
  items: [{ precioCOId: 1, cantidad: 1 }],
};

describe('crearPedido — presenteDesdeAt', () => {
  it('un pedido de KIOSKO toma su lugar en la cola al hacerse', async () => {
    const { svc, creado } = crearServicio();
    const antes = Date.now();

    await svc.crearPedido(
      { ...dto, modoEntrega: ModoEntrega.KIOSKO } as never,
      usuario as never,
      undefined,
      42,
      'token-del-kiosko',
    );

    expect(creado.data.canalOrigen).toBe(CanalOrigen.KIOSKO);
    expect(creado.data.presenteDesdeAt).toBeInstanceOf(Date);
    expect(creado.data.presenteDesdeAt.getTime()).toBeGreaterThanOrEqual(antes);
  });

  it('un pedido WEB empieza SIN lugar: lo toma cuando avisa su llegada', async () => {
    // Si naciera con lugar, un web que nunca llega estaría en la cola desde que lo
    // hizo — y el gate de presencia (que exige aviso) pierde su sentido.
    const { svc, creado } = crearServicio();

    await svc.crearPedido(dto as never, usuario as never);

    expect(creado.data.canalOrigen).toBe(CanalOrigen.WEB);
    expect(creado.data).not.toHaveProperty('presenteDesdeAt');
  });
});

describe('endpoints nuevos del cliente', () => {
  it('retirarLlegada delega en PresenciaService con el id del usuario', async () => {
    const { svc, presencia } = crearServicio();
    await svc.retirarLlegada(5, 7);
    expect(presencia.retirarPorCliente).toHaveBeenCalledWith(5, 7);
  });

  it('confirmarInteres delega en SinRecogerService con el id del usuario', async () => {
    const { svc, sinRecoger } = crearServicio();
    await svc.confirmarInteres(5, 7);
    expect(sinRecoger.confirmarInteres).toHaveBeenCalledWith(5, 7);
  });
});
