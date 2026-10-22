import { ForbiddenException } from '@nestjs/common';
import { EstadoPedido, RolUsuario } from '@prisma/client';
import { PedidoAccessService } from './pedido-access.service';

/**
 * El GERENTE es un empleado de UNA tienda para `PedidoAccessService` (la fuente única de "¿puede ver/operar este
 * pedido?"): ve los pedidos de SU tienda y de ninguna otra, y la tienda sale solo del token. Sin tienda en el
 * token, no ve nada. Que no sea cross-tienda es lo que lo distingue del ADMIN.
 */
describe('PedidoAccessService — el GERENTE', () => {
  const svc = new PedidoAccessService({} as never);
  const pedido = (tiendaId: number) => ({
    id: 1,
    usuarioId: 99,
    tiendaId,
    asignadoAId: null,
    estado: EstadoPedido.PENDIENTE_PAGO,
  });
  const gerente = (tiendaId?: number | null) => ({
    userId: 7,
    rol: RolUsuario.GERENTE,
    tiendaId: tiendaId as never,
  });

  it('ve un pedido de SU tienda', () => {
    expect(() => svc.validar(pedido(3), gerente(3))).not.toThrow();
  });

  it('NO ve un pedido de otra tienda (403)', () => {
    expect(() => svc.validar(pedido(4), gerente(3))).toThrow(ForbiddenException);
  });

  it('sin tienda en el token no ve ninguno (403)', () => {
    expect(() => svc.validar(pedido(3), gerente(null))).toThrow(ForbiddenException);
    expect(() => svc.validar(pedido(3), gerente(undefined))).toThrow(ForbiddenException);
  });

  it('a diferencia del ADMIN, no pasa por cualquier tienda', () => {
    const admin = { userId: 1, rol: RolUsuario.ADMIN, tiendaId: undefined as never };
    expect(() => svc.validar(pedido(4), admin)).not.toThrow();
    expect(() => svc.validar(pedido(4), gerente(3))).toThrow();
  });
});
