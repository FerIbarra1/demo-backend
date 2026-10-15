import { RolUsuario } from '@prisma/client';
import { PedidoBusquedaController } from './pedido-busqueda.controller';

/**
 * F17 (oct 2026): el contrato del escáner.
 *
 * El escáner dejó de NAVEGAR: antes el panel hacía `router.push(rutaAccion)` a
 * la ruta del rol, y esa ruta (`/bodega/pedidos/[id]`) se eliminó. Ahora abre
 * el `DetallePedidoModal` con el `pedidoId`.
 *
 * Estos tests fijan las dos mitades del contrato:
 *   1. `resolverEscaneo` NO devuelve `rutaAccion` — si volviera, alguien la
 *      usaría y aterrizaría en un 404.
 *   2. Sí devuelve lo que el panel necesita: quién lo tiene y si le toca.
 */

const usuario = {
  userId: 3,
  nombre: 'Bodeguero',
  rol: RolUsuario.BODEGA,
  tiendaId: 5,
};

/** Un pedido como lo devuelve el `findUnique` del controller. */
function pedido(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    numeroPedido: 'PD-2026-000042',
    clienteNombre: 'Cliente Demo',
    estado: 'EN_REVISION',
    canalOrigen: 'WEB',
    total: 100,
    tienda: { nombre: 'Punto Textil' },
    _count: { items: 3 },
    ...over,
  };
}

function crearController(p: Record<string, unknown> | null = pedido()) {
  const buscarPorFolio = jest.fn().mockResolvedValue({
    id: 42,
    numeroPedido: 'PD-2026-000042',
    externalFolio: null,
    estado: 'EN_REVISION',
  });
  const findUnique = jest.fn().mockResolvedValue(p);

  const svc = new PedidoBusquedaController(
    { buscarPorFolio } as never,
    { pedido: { findUnique } } as never,
  );

  return { svc, buscarPorFolio };
}

describe('PedidoBusquedaController.resolverEscaneo', () => {
  it('NO devuelve rutaAccion (el escáner ya no navega)', async () => {
    const { svc } = crearController();
    const r = (await svc.resolverEscaneo('PD-2026-000042', usuario)) as Record<
      string,
      unknown
    >;

    // Si este campo volviera, el panel lo usaría para navegar a una ruta que
    // ya no existe. La regresión es silenciosa: solo se ve al escanear.
    expect(r).not.toHaveProperty('rutaAccion');
  });

  it('devuelve quién lo tiene y si a este usuario le toca', async () => {
    const { svc } = crearController();
    const r = (await svc.resolverEscaneo('PD-2026-000042', usuario)) as any;

    expect(r.encontrado).toBe(true);
    expect(r.responsable).toEqual({
      rol: RolUsuario.BODEGA,
      label: 'Bodega',
      queHace: 'surtiendo',
    });
    // BODEGA sobre un pedido en EN_REVISION: sí le toca.
    expect(r.puedeOperar).toBe(true);
    expect(r.mensaje).toBeNull();
  });

  it('a un rol ajeno le dice quién lo tiene, sin 403 seco', async () => {
    // Un pedido en el área de entrega visto por bodega: no le toca, y el panel tiene
    // que poder decirle a quién mandar al cliente.
    const { svc } = crearController(pedido({ estado: 'REVISADO' }));
    const r = (await svc.resolverEscaneo('PD-2026-000042', usuario)) as any;

    expect(r.puedeOperar).toBe(false);
    expect(r.mensaje).toContain('Mostrador');
  });

  it('devuelve el pedido con los datos que el panel pinta', async () => {
    const { svc } = crearController();
    const r = (await svc.resolverEscaneo('PD-2026-000042', usuario)) as any;

    expect(r.pedido).toMatchObject({
      id: 42,
      numeroPedido: 'PD-2026-000042',
      clienteNombre: 'Cliente Demo',
      itemsCount: 3,
      tiendaNombre: 'Punto Textil',
    });
    // El label legible viene del mapa de estados, no del enum crudo.
    expect(r.pedido.estadoLabel).toBe('En revisión por bodega');
  });

  it('si el pedido se borró entre la búsqueda y el detalle, no revienta', async () => {
    const { svc } = crearController(null);
    const r = (await svc.resolverEscaneo('PD-2026-000042', usuario)) as any;
    expect(r).toEqual({ encontrado: false });
  });
});
