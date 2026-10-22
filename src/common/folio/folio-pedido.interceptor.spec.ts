import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { FolioPedidoInterceptor } from './folio-pedido.interceptor';

const ctx = (tipo: string) => ({ getType: () => tipo }) as unknown as ExecutionContext;
const handler = (valor: unknown): CallHandler => ({ handle: () => of(valor) });
const series = (serie: string | null = 'HMO') => ({
  cargar: jest.fn(async () => undefined),
  serieDe: jest.fn(() => serie),
});

describe('FolioPedidoInterceptor', () => {
  const pedido = () => ({ id: 1, numeroPedido: 'PD-1', tiendaId: 1, folioErp: '0000152573' });

  it('decora los pedidos de la respuesta HTTP', async () => {
    const i = new FolioPedidoInterceptor(series() as never);
    const r: any = await firstValueFrom(i.intercept(ctx('http'), handler({ data: [pedido()] })));
    expect(r.data[0].folio).toBe('HMO-0000152573');
  });

  it('no toca lo que no es HTTP (sockets)', async () => {
    const s = series();
    const i = new FolioPedidoInterceptor(s as never);
    const p: any = pedido();
    await firstValueFrom(i.intercept(ctx('ws'), handler(p)));
    expect(p.folio).toBeUndefined();
    expect(s.cargar).not.toHaveBeenCalled();
  });

  it('respuestas sin cuerpo (null, texto) pasan tal cual y sin leer la BD', async () => {
    const s = series();
    const i = new FolioPedidoInterceptor(s as never);
    expect(await firstValueFrom(i.intercept(ctx('http'), handler(null)))).toBeNull();
    expect(await firstValueFrom(i.intercept(ctx('http'), handler('ok')))).toBe('ok');
    expect(s.cargar).not.toHaveBeenCalled();
  });

  it('si no se pueden leer las series NO tumba la respuesta: el folio sale sin prefijo', async () => {
    // La lectura falla y no hay serie en memoria: `serieDe` no sabe nada.
    const s = { ...series(), serieDe: jest.fn(() => undefined) };
    s.cargar = jest.fn(async () => {
      throw new Error('BD caída');
    });
    const i = new FolioPedidoInterceptor(s as never);
    const r: any = await firstValueFrom(i.intercept(ctx('http'), handler(pedido())));
    expect(r.folio).toBe('0000152573');
  });
});
