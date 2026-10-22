import { RolUsuario } from '@prisma/client';
import { RealtimeGateway } from './realtime.gateway';

/**
 * `puedeVerPedido` decide quién puede unirse al room `pedido-{id}` y recibir
 * en vivo los mensajes de chat, los cambios de surtido y las transiciones de
 * estado de ese pedido.
 *
 * Antes bastaba con que la tienda del JWT coincidiera con la del pedido. Como
 * un usuario CLIENTE también lleva `tiendaId` en el token, cualquier cliente
 * podía suscribirse a los pedidos de otro cliente de su misma tienda. Estos
 * tests fijan la regla correcta, la misma que aplica `PedidoAccessService`.
 */
describe('RealtimeGateway.puedeVerPedido', () => {
  const gateway = new RealtimeGateway(
    {} as never,
    {
      pedido: {
        findUnique: jest.fn(),
      },
    } as never,
  );

  // `puedeVerPedido` es privado: se ejerce a través de su contrato real.
  const puedeVer = (rol: RolUsuario, userId: number, tiendaId: number | undefined) =>
    (
      gateway as unknown as {
        puedeVerPedido: (client: { data: unknown }, pedidoId: number) => Promise<boolean>;
      }
    ).puedeVerPedido({ data: { userId, rol, tiendaId, nombre: 'X' } }, 1);

  const prismaMock = (gateway as unknown as { prisma: { pedido: { findUnique: jest.Mock } } })
    .prisma;

  beforeEach(() => {
    prismaMock.pedido.findUnique.mockReset();
  });

  it('un CLIENTE dueño del pedido sí entra', async () => {
    prismaMock.pedido.findUnique.mockResolvedValue({
      id: 1,
      usuarioId: 42,
      tiendaId: 7,
    });
    await expect(puedeVer(RolUsuario.CLIENTE, 42, 7)).resolves.toBe(true);
  });

  it('un CLIENTE de la MISMA tienda pero de otro pedido NO entra', async () => {
    prismaMock.pedido.findUnique.mockResolvedValue({
      id: 1,
      usuarioId: 42,
      tiendaId: 7,
    });
    // El caso del bug: mismo tiendaId, distinto usuarioId.
    await expect(puedeVer(RolUsuario.CLIENTE, 99, 7)).resolves.toBe(false);
  });

  it('un CLIENTE sin tienda en el token tampoco entra al pedido ajeno', async () => {
    prismaMock.pedido.findUnique.mockResolvedValue({
      id: 1,
      usuarioId: 42,
      tiendaId: 7,
    });
    await expect(puedeVer(RolUsuario.CLIENTE, 99, undefined)).resolves.toBe(false);
  });

  it('un empleado de la tienda del pedido sí entra', async () => {
    prismaMock.pedido.findUnique.mockResolvedValue({
      id: 1,
      usuarioId: 42,
      tiendaId: 7,
    });
    await expect(puedeVer(RolUsuario.BODEGA, 5, 7)).resolves.toBe(true);
    await expect(puedeVer(RolUsuario.MOSTRADOR, 6, 7)).resolves.toBe(true);
  });

  it('un empleado de OTRA tienda NO entra', async () => {
    prismaMock.pedido.findUnique.mockResolvedValue({
      id: 1,
      usuarioId: 42,
      tiendaId: 7,
    });
    await expect(puedeVer(RolUsuario.BODEGA, 5, 8)).resolves.toBe(false);
  });

  it('ADMIN entra a cualquier pedido', async () => {
    prismaMock.pedido.findUnique.mockResolvedValue({
      id: 1,
      usuarioId: 42,
      tiendaId: 7,
    });
    await expect(puedeVer(RolUsuario.ADMIN, 1, undefined)).resolves.toBe(true);
  });

  it('un pedido inexistente no se puede ver', async () => {
    prismaMock.pedido.findUnique.mockResolvedValue(null);
    await expect(puedeVer(RolUsuario.ADMIN, 1, 7)).resolves.toBe(false);
  });
});

describe('RealtimeGateway: socket seguro', () => {
  const { RealtimeGateway: Gateway } = jest.requireActual(
    './realtime.gateway',
  ) as typeof import('./realtime.gateway');

  it('el socket muere cuando vence el JWT con el que entró (y se limpia al desconectar)', async () => {
    jest.useFakeTimers();
    try {
      const jwt = {
        verifyAsync: jest.fn().mockResolvedValue({
          sub: 7,
          rol: RolUsuario.CLIENTE,
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
      };
      const gw = new Gateway(jwt as never, {} as never);
      const client = {
        id: 's1',
        data: {} as Record<string, unknown>,
        handshake: { auth: { token: 't' }, headers: {} },
        join: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
      };
      await gw.handleConnection(client as never);
      expect(client.disconnect).not.toHaveBeenCalled();
      jest.advanceTimersByTime(59_000);
      expect(client.disconnect).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2_000);
      expect(client.disconnect).toHaveBeenCalledWith(true);

      // Al desconectar por su cuenta, el temporizador no queda vivo.
      const otro = { ...client, disconnect: jest.fn(), data: {} as Record<string, unknown> };
      await gw.handleConnection(otro as never);
      gw.handleDisconnect(otro as never);
      jest.advanceTimersByTime(120_000);
      expect(otro.disconnect).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['un refresh token (con jti)', { sub: 7, rol: RolUsuario.CLIENTE, jti: 'a-uuid' }],
    ['el token del QR del kiosko (con kind)', { sub: 7, rol: RolUsuario.CLIENTE, kind: 'kiosk' }],
  ])('%s NO abre un socket: se desconecta y no entra a ningún room', async (_n, payload) => {
    const gw = new Gateway(
      { verifyAsync: jest.fn().mockResolvedValue(payload) } as never,
      {} as never,
    );
    const client = {
      id: 's2',
      data: {} as Record<string, unknown>,
      handshake: { auth: { token: 't' }, headers: {} },
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };
    await gw.handleConnection(client as never);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('joinPedido ignora un id que no es un entero positivo (antes rompía el findUnique)', async () => {
    const prisma = { pedido: { findUnique: jest.fn() } };
    const gw = new Gateway({} as never, prisma as never);
    const client = { data: { userId: 1, rol: RolUsuario.ADMIN }, join: jest.fn() };
    for (const malo of ['5', {}, -1, 0, 1.5, null, undefined, NaN]) {
      await gw.handleJoinPedido(malo as never, client as never);
    }
    expect(prisma.pedido.findUnique).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });
});
