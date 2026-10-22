import { decorarConFolio, esPedidoLike } from './folio-decorador';

const series: Record<number, string | null> = { 1: 'HMO', 2: 'MXL', 3: null };
const serieDe = (id: number) => series[id];
const pedido = (extra: Record<string, unknown> = {}) => ({
  id: 10,
  numeroPedido: 'PD-2026-000010',
  tiendaId: 1,
  folioErp: '0000152573',
  ...extra,
});

describe('decorarConFolio', () => {
  it('un pedido con folio sale con la etiqueta SERIE-folio', () => {
    const p: any = pedido();
    decorarConFolio(p, serieDe);
    expect(p.folio).toBe('HMO-0000152573');
  });

  it('el MISMO folio en otra tienda lleva SU serie (el consecutivo es por tienda)', () => {
    const a: any = pedido({ tiendaId: 1 });
    const b: any = pedido({ tiendaId: 2 });
    decorarConFolio([a, b], serieDe);
    expect([a.folio, b.folio]).toEqual(['HMO-0000152573', 'MXL-0000152573']);
  });

  it('sin serie (la tienda aún no sincroniza TIENDAS.SERIE) o tienda desconocida: el folio solo', () => {
    const sinSerie: any = pedido({ tiendaId: 3 });
    const desconocida: any = pedido({ tiendaId: 99 });
    decorarConFolio([sinSerie, desconocida], serieDe);
    expect(sinSerie.folio).toBe('0000152573');
    expect(desconocida.folio).toBe('0000152573');
  });

  it('un pedido que aún no tiene folio lleva folio: null (la pantalla muestra lo de siempre)', () => {
    const p: any = pedido({ folioErp: null });
    decorarConFolio(p, serieDe);
    expect(p.folio).toBeNull();
    expect('folio' in p).toBe(true);
  });

  it('lo encuentra a cualquier profundidad: listas, paginación, pedidos anidados', () => {
    const anidado: any = pedido({ id: 3, folioErp: '0000000003' });
    const resp: any = {
      data: [pedido({ id: 1 }), { pago: { id: 7, pedido: anidado } }],
      meta: { total: 2 },
    };
    decorarConFolio(resp, serieDe);
    expect(resp.data[0].folio).toBe('HMO-0000152573');
    expect(resp.data[1].pago.pedido.folio).toBe('HMO-0000000003');
    expect(resp.meta).toEqual({ total: 2 });
  });

  it('no pisa un `folio` que el servicio ya puso', () => {
    const p: any = pedido({ folio: 'A MANO' });
    decorarConFolio(p, serieDe);
    expect(p.folio).toBe('A MANO');
  });

  it('un objeto SIN folioErp o SIN tiendaId no es un pedido para esto (las TV públicas no lo reciben)', () => {
    const tv: any = { id: 1, numeroPedido: 'PD-2026-000001', mostradorNumero: 2 };
    const sinTienda: any = { id: 1, numeroPedido: 'PD-1', folioErp: '0000000001' };
    const sinFolioErp: any = { id: 1, numeroPedido: 'PD-1', tiendaId: 1 };
    decorarConFolio([tv, sinTienda, sinFolioErp], serieDe);
    for (const o of [tv, sinTienda, sinFolioErp]) expect('folio' in o).toBe(false);
  });

  it('respeta fechas, decimales, buffers y nulos; no se cae con ciclos', () => {
    class Decimal {
      constructor(public d = [1]) {}
    }
    const ciclo: any = { id: 1, numeroPedido: 'PD-1', tiendaId: 1, folioErp: '0000000001' };
    ciclo.yo = ciclo;
    const fecha = new Date();
    const dec = new Decimal();
    const resp: any = { fecha, dec, buf: Buffer.from('x'), nada: null, indef: undefined, ciclo };
    expect(() => decorarConFolio(resp, serieDe)).not.toThrow();
    expect(resp.fecha).toBe(fecha);
    expect(resp.dec).toBe(dec);
    expect(ciclo.folio).toBe('HMO-0000000001');
  });

  it('valores que no son objeto no hacen nada', () => {
    for (const v of [null, undefined, 3, 'texto', true])
      expect(() => decorarConFolio(v, serieDe)).not.toThrow();
  });

  it('una respuesta enorme no cuesta de más: tope de nodos', () => {
    const grande = Array.from({ length: 200_000 }, (_, i) => ({ i }));
    const inicio = Date.now();
    decorarConFolio(grande, serieDe);
    expect(Date.now() - inicio).toBeLessThan(500);
  });

  it('esPedidoLike', () => {
    expect(esPedidoLike(pedido())).toBe(true);
    expect(esPedidoLike({ numeroPedido: 'x', tiendaId: 1 })).toBe(false);
  });
});
