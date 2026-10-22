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

/**
 * F22: los IDs que coinciden se calculan en SQL (`$queryRaw`) y Prisma pagina y
 * ordena sobre ellos. `ids` es lo que devuelve esa consulta.
 */
function crearServicio(ids: number[] = [1, 2, 3]) {
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);
  const queryRaw = jest.fn().mockResolvedValue(ids.map((id) => ({ id })));

  const prisma = {
    pedido: { findMany, count },
    // Las filas llevan su resumen de DTF; estos pedidos no tienen ninguno.
    pedidoDtf: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: queryRaw,
  };

  const svc = new MostradorQueryService(
    prisma as never,
    {} as never, // pedidoState
  );

  return { svc, findMany, count, queryRaw };
}

/** El `where` que el servicio construyó en la primera llamada a findMany. */
function whereDe(findMany: jest.Mock) {
  return findMany.mock.calls[0][0].where;
}

/** El SQL (con marcadores) y los parámetros de la consulta cruda. */
function sqlDe(queryRaw: jest.Mock): { sql: string; values: unknown[] } {
  const q = queryRaw.mock.calls[0][0];
  return { sql: q.sql as string, values: q.values as unknown[] };
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
    const { svc, findMany, queryRaw } = crearServicio();
    await svc.buscarPedidos('Juan', operador, 5);
    // No hay lista blanca de estados: la cobertura es total por construcción,
    // ni en el SQL ni en el where de Prisma.
    expect(whereDe(findMany).estado).toBeUndefined();
    expect(sqlDe(queryRaw).sql).not.toMatch(/\bestado\b/);
    expect(findMany).toHaveBeenCalled();
  });

  it('Prisma solo pagina y ordena sobre los IDs que el SQL devolvió', async () => {
    const { svc, findMany } = crearServicio([7, 9]);
    await svc.buscarPedidos('Juan', operador, 5);
    expect(whereDe(findMany).id).toEqual({ in: [7, 9] });
  });

  it('sin coincidencias devuelve vacío sin consultar pedidos', async () => {
    const { svc, findMany, count } = crearServicio([]);
    const r = await svc.buscarPedidos('Nadie', operador, 5, 1, 20);

    expect(r).toEqual({ data: [], meta: { total: 0, pagina: 1, limite: 20, totalPaginas: 0 } });
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('busca por el folio de VFP, que es el que el cliente trae en el ticket', async () => {
    const { svc, queryRaw } = crearServicio();
    await svc.buscarPedidos('12345', operador, 5);

    const { sql } = sqlDe(queryRaw);
    expect(sql).toContain('pedidos_pendientes_envio');
    expect(sql).toContain('external_folio');
  });

  it('busca por folio interno, nombre y correo', async () => {
    const { svc, queryRaw } = crearServicio();
    await svc.buscarPedidos('juan@correo.com', operador, 5);

    const { sql } = sqlDe(queryRaw);
    expect(sql).toContain('numero_pedido');
    expect(sql).toContain('cliente_nombre');
    expect(sql).toContain('cliente_email');
  });

  describe('F22 — lo que el cliente sin papeles sabe de memoria', () => {
    it('busca por TELÉFONO, solo contra dígitos: "55 1234-5678" encuentra "5512345678"', async () => {
      // La pantalla decía "busca por teléfono" y el backend no lo buscaba.
      const { svc, queryRaw } = crearServicio();
      await svc.buscarPedidos('55 1234-5678', operador, 5);

      const { sql, values } = sqlDe(queryRaw);
      expect(sql).toContain('cliente_telefono');
      expect(sql).toMatch(/regexp_replace\(coalesce\(p\.cliente_telefono/);
      // Un teléfono NO se parte por espacios: sus pedazos cortos no matchearían
      // nada y el AND entre palabras fallaría.
      expect(values).toContain('%5512345678%');
      expect(sql.match(/ AND /g)?.length ?? 0).toBeLessThanOrEqual(1);
    });

    it('ignora los acentos: "Jose" encuentra a "José"', async () => {
      const { svc, queryRaw } = crearServicio();
      await svc.buscarPedidos('José', operador, 5);

      const { sql, values } = sqlDe(queryRaw);
      // `insensitive` solo ignora mayúsculas; el nombre se normaliza en SQL y el
      // texto del operador en JS, así "José" y "jose" caen en la misma cadena.
      expect(sql).toContain('translate(p.cliente_nombre');
      expect(values).toContain('%jose%');
    });

    it('palabras sueltas: cada una tiene que aparecer (AND), en cualquier campo (OR)', async () => {
      // "perez juan" no encontraba a "Juan Pérez" porque se buscaba la cadena
      // entera.
      const { svc, queryRaw } = crearServicio();
      await svc.buscarPedidos('perez juan', operador, 5);

      const { sql, values } = sqlDe(queryRaw);
      expect(values).toEqual(expect.arrayContaining(['%perez%', '%juan%']));
      expect(sql).toMatch(/\) AND \(/);
    });

    it('el texto del operador va como PARÁMETRO, nunca interpolado en el SQL', async () => {
      const { svc, queryRaw } = crearServicio();
      const hostil = "x'; DROP TABLE pedidos; --";
      await svc.buscarPedidos(hostil, operador, 5);

      const { sql } = sqlDe(queryRaw);
      expect(sql).not.toContain('DROP TABLE');
      expect(sql).not.toContain(hostil);
    });

    it('escapa los comodines de LIKE: "100%" se busca literal', async () => {
      const { svc, queryRaw } = crearServicio();
      await svc.buscarPedidos('100%', operador, 5);

      const { values } = sqlDe(queryRaw);
      expect(values).toContain('%100\\%%');
    });

    it('limita las coincidencias: es un buscador de mostrador, no un reporte', async () => {
      const { svc, queryRaw } = crearServicio();
      await svc.buscarPedidos('Juan', operador, 5);
      expect(sqlDe(queryRaw).sql).toMatch(/LIMIT 200/);
    });
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
    const fila = (id: number, extra: Record<string, unknown>) => ({
      id,
      canalOrigen: 'WEB',
      fechaPedido: new Date(Date.now() - 3_600_000),
      llegadaAnunciadaAt: null,
      llegadaDescartadaAt: null,
      presenteDesdeAt: null,
      llamadoPor: null,
      llamadoMostrador: null,
      ...extra,
    });
    findMany.mockResolvedValue([
      fila(1, { llegadaAnunciadaAt: hace5min, presenteDesdeAt: hace5min }),
      // Aviso descartado: el cliente no estaba, así que no cuenta como espera.
      fila(2, {
        llegadaAnunciadaAt: hace5min,
        presenteDesdeAt: hace5min,
        llegadaDescartadaAt: new Date(),
      }),
      // Sin aviso: nunca avisó.
      fila(3, {}),
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
  it('acota a la tienda del usuario EN LAS DOS CAPAS: el SQL y el where de Prisma', async () => {
    // La tienda no puede depender de una sola de las dos capas.
    const { svc, findMany, queryRaw } = crearServicio();
    await svc.buscarPedidos('Juan', operador, 5);

    expect(whereDe(findMany).tiendaId).toBe(5);
    const { sql, values } = sqlDe(queryRaw);
    expect(sql).toContain('p.tienda_id =');
    expect(values).toContain(5);
  });

  it('falla cerrado si el usuario no tiene tienda', async () => {
    const { svc, findMany, queryRaw } = crearServicio();
    const sinTienda: UserContext = { ...operador, tiendaId: undefined };

    // Antes el filtro era `if (rol !== ADMIN && tiendaId)`: sin tienda, el
    // `where` quedaba SIN filtro y el usuario veía pedidos de todas las
    // tiendas. Ahora lanza, igual que `PedidoAccessService.validar`.
    await expect(svc.buscarPedidos('Juan', sinTienda, undefined)).rejects.toThrow(
      ForbiddenException,
    );
    expect(queryRaw).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('ADMIN sin tienda no queda acotado a ninguna (la búsqueda global del servicio)', async () => {
    const { svc, findMany, queryRaw } = crearServicio();
    await svc.buscarPedidos('Juan', admin, undefined);

    expect(whereDe(findMany).tiendaId).toBeUndefined();
    expect(sqlDe(queryRaw).sql).not.toContain('p.tienda_id');
  });

  // PLAN-ADMIN-MULTITIENDA (oct 2026, D1): la consola del ADMIN muestra UNA tienda a la vez. Antes el
  // servicio ignoraba la tienda para el ADMIN y su buscador devolvía pedidos de todas, mezclados, dentro
  // de una consola que decía "Obregón". La búsqueda global es otra cosa (N2) y se pide sin tienda.
  it('ADMIN que eligió tienda: la búsqueda se acota a ESA tienda, en las dos capas', async () => {
    const { svc, findMany, queryRaw } = crearServicio();
    await svc.buscarPedidos('Juan', admin, 7);

    expect(whereDe(findMany).tiendaId).toBe(7);
    const { sql, values } = sqlDe(queryRaw);
    expect(sql).toContain('p.tienda_id =');
    expect(values).toContain(7);
  });
});
