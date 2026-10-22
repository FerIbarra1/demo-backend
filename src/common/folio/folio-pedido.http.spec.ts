import 'reflect-metadata';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { FolioPedidoInterceptor } from './folio-pedido.interceptor';
import { SeriesDeTiendaService } from './series-de-tienda.service';

/**
 * Oct 2026 (B2) por HTTP real: el interceptor global decora los pedidos de la respuesta de CUALQUIER endpoint, y las
 * respuestas que no llevan pedidos (o las TV públicas) salen intactas.
 */
@Controller('prueba')
class PruebaController {
  @Get('pedido')
  pedido() {
    return {
      id: 1,
      numeroPedido: 'PD-2026-000001',
      tiendaId: 1,
      folioErp: '0000152573',
      clienteNombre: 'Ana',
    };
  }

  @Get('lista')
  lista() {
    return {
      data: [
        { id: 1, numeroPedido: 'PD-1', tiendaId: 1, folioErp: '0000000007' },
        { id: 2, numeroPedido: 'PD-2', tiendaId: 2, folioErp: null },
      ],
      meta: { total: 2 },
    };
  }

  @Get('tv')
  tv() {
    return { cola: [{ id: 3, numeroPedido: 'PD-3', turno: '2573' }] };
  }

  @Get('texto')
  texto() {
    return 'ok';
  }
}

describe('FolioPedidoInterceptor por HTTP', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const series = {
      cargar: jest.fn(async () => undefined),
      serieDe: (id: number) => ({ 1: 'HMO', 2: 'MXL' })[id as 1 | 2],
    };
    @Module({
      controllers: [PruebaController],
      providers: [
        { provide: SeriesDeTiendaService, useValue: series },
        { provide: APP_INTERCEPTOR, useClass: FolioPedidoInterceptor },
      ],
    })
    class ModuloDePrueba {}
    app = await NestFactory.create(ModuloDePrueba, { logger: false });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(() => app.close());

  const get = async (ruta: string) => {
    const r = await fetch(base + ruta);
    const texto = await r.text();
    return { status: r.status, texto, json: () => JSON.parse(texto) };
  };

  it('un pedido sale con su `folio` y conserva todo lo demás', async () => {
    const r = await get('/prueba/pedido');
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({
      id: 1,
      numeroPedido: 'PD-2026-000001',
      tiendaId: 1,
      folioErp: '0000152573',
      clienteNombre: 'Ana',
      folio: 'HMO-0000152573',
    });
  });

  it('una lista pagina con cada pedido decorado (sin folio → folio: null)', async () => {
    const j = (await get('/prueba/lista')).json();
    expect(j.data.map((p: any) => p.folio)).toEqual(['HMO-0000000007', null]);
    expect(j.meta).toEqual({ total: 2 });
  });

  it('la forma de una TV pública (sin tiendaId ni folioErp) NO recibe el folio completo', async () => {
    expect((await get('/prueba/tv')).json()).toEqual({
      cola: [{ id: 3, numeroPedido: 'PD-3', turno: '2573' }],
    });
  });

  it('una respuesta de texto pasa tal cual', async () => {
    expect((await get('/prueba/texto')).texto).toBe('ok');
  });
});
