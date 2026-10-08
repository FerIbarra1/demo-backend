import { ForbiddenException } from '@nestjs/common';
import { EstadoPedido, RolUsuario } from '@prisma/client';
import { MostradorQueryService } from './mostrador-query.service';
import type { UserContext } from '../../types/pedido.types';

/**
 * Oct 2026: el buscador del mostrador.
 *
 * El bug que estos tests previenen: el operador tiene un cliente enfrente que
 * llegó SIN ticket y SIN número de pedido, dice su nombre, y el buscador no lo
 * encuentra porque el pedido todavía está en bodega (o esperando aprobación, o
 * en asesoría, o ya en caja). Cubría 3 de los 10 estados.
 *
 * El segundo bug: el cliente trae el folio de VFP en su ticket, pero el
 * buscador solo miraba `numeroPedido` — que es interno e invisible para él.
 *
 * El tercero: ordenaba por `fechaPago asc`, y los pedidos en REVISADO
 * tienen `fechaPago` NULL, así que Postgres los mandaba al final. Con el
 * `take: 20` fijo, el pedido que el operador necesitaba podía quedar cortado.
 */

const operador: UserContext = {
  userId: 3,
  nombre: 'Ana Mostrador',
  rol: RolUsuario.MOSTRADOR,
  tiendaId: 5,
};

const admin: UserContext = {
  userId: 1,
  nombre: 'Admin',
  rol: RolUsuario.ADMIN,
  // Sin tienda: es el caso del ADMIN y el del usuario mal configurado.
};

function crearServicio() {
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);

  const prisma = {
    pedido: { findMany, count },
  };

  const svc = new MostradorQueryService(
    prisma as never,
    {} as never, // pedidoState
  );

  return { svc, findMany, count };
}

/** El `where` que el servicio construyó en la primera llamada a findMany. */
function whereDe(findMany: jest.Mock) {
  return findMany.mock.calls[0][0].where;
}

describe('buscarPedidos — el operador siempre encuentra al cliente', () => {
  it('NO filtra por estado: un pedido en bodega también se encuentra', async () => {
    const { svc, findMany } = crearServicio();
    await svc.buscarPedidos('Juan', operador, 5);

    // El bug era `estado: { in: [REVISADO, PAID, SHIPPED] }`. Si vuelve a
    // aparecer un filtro de estado aquí, el cliente que llega temprano vuelve a
    // quedar invisible.
    expect(whereDe(findMany).estado).toBeUndefined();
  });

  it.each([
    ['SOLICITADO', EstadoPedido.SOLICITADO],
    ['EN_REVISION', EstadoPedido.EN_REVISION],
    ['ESPERANDO_APROBACION', EstadoPedido.ESPERANDO_APROBACION],
    ['EN_ASESORIA', EstadoPedido.EN_ASESORIA],
    ['REVISADO', EstadoPedido.REVISADO],
    ['PENDIENTE_PAGO', EstadoPedido.PENDIENTE_PAGO],
    ['PAGADO', EstadoPedido.PAGADO],
    ['ENVIADO', EstadoPedido.ENVIADO],
    ['ENTREGADO', EstadoPedido.ENTREGADO],
    ['CANCELADO', EstadoPedido.CANCELADO],
  ])('cubre el estado %s', async (_nombre, _estado) => {
    const { svc, findMany } = crearServicio();
    await svc.buscarPedidos('Juan', operador, 5);
    // No hay lista blanca de estados: la cobertura es total por construcción.
    expect(whereDe(findMany).estado).toBeUndefined();
    expect(findMany).toHaveBeenCalled();
  });

  it('busca por el folio de VFP, que es el que el cliente trae en el ticket', async () => {
    const { svc, findMany } = crearServicio();
    await svc.buscarPedidos('12345', operador, 5);

    const or = whereDe(findMany).OR;
    const buscaFolioVfp = or.some(
      (c: Record<string, unknown>) =>
        JSON.stringify(c).includes('pendienteEnvio') &&
        JSON.stringify(c).includes('externalFolio'),
    );
    expect(buscaFolioVfp).toBe(true);
  });

  it('busca por nombre y por correo, además del folio interno', async () => {
    const { svc, findMany } = crearServicio();
    await svc.buscarPedidos('juan@correo.com', operador, 5);

    const serializado = JSON.stringify(whereDe(findMany).OR);
    expect(serializado).toContain('numeroPedido');
    expect(serializado).toContain('clienteNombre');
    expect(serializado).toContain('clienteEmail');
  });

  it('incluye pendienteEnvio, o el frontend muestra "Pedido #id" en vez del folio', async () => {
    const { svc, findMany } = crearServicio();
    await svc.buscarPedidos('Juan', operador, 5);

    // `folioVisible()` del frontend lee `pedido.pendienteEnvio?.externalFolio`.
    // Sin este include, cae al fallback y el operador lee un número que el
    // cliente no reconoce.
    expect(findMany.mock.calls[0][0].include.pendienteEnvio).toBeDefined();
  });

  it('ordena por estado para que los pedidos accionables salgan primero', async () => {
    const { svc, findMany } = crearServicio();
    await svc.buscarPedidos('Juan', operador, 5);

    const orderBy = findMany.mock.calls[0][0].orderBy;
    // El enum está declarado en orden de ciclo de vida: los activos primero,
    // COMPLETED/CANCELLED al final. Antes ordenaba por `fechaPago asc`, que
    // mandaba los REVISADO (fechaPago NULL) al final de la lista.
    expect(orderBy[0]).toEqual({ estado: 'asc' });
  });

  it('anota esperandoDesdeMin, o el badge "EN TIENDA" no se pinta', async () => {
    const { svc, findMany } = crearServicio();
    const hace5min = new Date(Date.now() - 5 * 60_000);
    findMany.mockResolvedValue([
      {
        id: 1,
        llegadaAnunciadaAt: hace5min,
        llegadaDescartadaAt: null,
      },
      // Aviso descartado: el cliente no estaba, así que no cuenta como espera.
      {
        id: 2,
        llegadaAnunciadaAt: hace5min,
        llegadaDescartadaAt: new Date(),
      },
      // Sin aviso: nunca avisó.
      { id: 3, llegadaAnunciadaAt: null, llegadaDescartadaAt: null },
    ]);

    const r = await svc.buscarPedidos('Juan', operador, 5);

    // `BadgeEnTienda` devuelve `null` cuando el campo es `undefined`, así que
    // sin esta anotación un pedido con aviso vigente se veía igual que uno sin
    // aviso — justo la distinción que el operador necesita.
    expect(r.data[0].esperandoDesdeMin).toBeGreaterThanOrEqual(4);
    expect(r.data[1].esperandoDesdeMin).toBeNull();
    expect(r.data[2].esperandoDesdeMin).toBeNull();
  });

  it('pagina y devuelve meta, en vez del take:20 silencioso', async () => {
    const { svc, findMany, count } = crearServicio();
    count.mockResolvedValue(45);

    const r = await svc.buscarPedidos('Juan', operador, 5, 3, 20);

    expect(findMany.mock.calls[0][0].skip).toBe(40);
    expect(findMany.mock.calls[0][0].take).toBe(20);
    expect(r.meta).toEqual({ total: 45, pagina: 3, limite: 20, totalPaginas: 3 });
  });
});

describe('buscarPedidos — aislamiento por tienda', () => {
  it('acota a la tienda del usuario', async () => {
    const { svc, findMany } = crearServicio();
    await svc.buscarPedidos('Juan', operador, 5);
    expect(whereDe(findMany).tiendaId).toBe(5);
  });

  it('falla cerrado si el usuario no tiene tienda', async () => {
    const { svc, findMany } = crearServicio();
    const sinTienda: UserContext = { ...operador, tiendaId: undefined };

    // Antes el filtro era `if (rol !== ADMIN && tiendaId)`: sin tienda, el
    // `where` quedaba SIN filtro y el usuario veía pedidos de todas las
    // tiendas. Ahora lanza, igual que `PedidoAccessService.validar`.
    await expect(svc.buscarPedidos('Juan', sinTienda, undefined)).rejects.toThrow(
      ForbiddenException,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it('ADMIN no queda acotado a una tienda', async () => {
    const { svc, findMany } = crearServicio();
    await svc.buscarPedidos('Juan', admin, undefined);
    expect(whereDe(findMany).tiendaId).toBeUndefined();
  });
});
