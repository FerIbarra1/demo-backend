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
