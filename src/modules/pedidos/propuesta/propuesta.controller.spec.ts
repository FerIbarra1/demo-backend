import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { PropuestaController } from './propuesta.controller';
import { PropuestaService } from './propuesta.service';
import { AjusteService } from './ajuste.service';
import { RolUsuario } from '@prisma/client';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';

/**
 * Fase 2 (oct 2026): el endpoint de vista previa, por HTTP de verdad.
 *
 * Los specs de la calculadora y del servicio no pasan por el enrutador ni por el
 * `ValidationPipe`, y ahí es donde un contrato roto aparece "solo en producción"
 * (ver el historial de `propuesta-dto.spec.ts`). Aquí se levanta la app con el
 * controlador real y las MISMAS opciones de pipe que `main.ts`.
 *
 * Los guards de auth y de roles son globales (APP_GUARD) y no se montan aquí: lo
 * que se prueba es la ruta, el cuerpo y que lo recibido llegue al servicio.
 */
describe('POST /pedidos/:id/ajuste/vista-previa', () => {
  let app: INestApplication;
  let base: string;
  const vistaPrevia = jest.fn(async (..._args: unknown[]) => ({ items: [], total: 0 }));

  beforeAll(async () => {
    // `@nestjs/testing` no está instalado: se levanta el módulo con NestFactory.
    @Module({
      controllers: [PropuestaController],
      providers: [
        { provide: PropuestaService, useValue: {} },
        { provide: AjusteService, useValue: { vistaPrevia } },
      ],
    })
    class ModuloDePrueba {}

    app = await NestFactory.create(ModuloDePrueba, { logger: false });
    // Mismas opciones que src/main.ts (incluida la conversión implícita).
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => vistaPrevia.mockClear());

  const post = (ruta: string, body: unknown) =>
    fetch(`${base}${ruta}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('acepta las tres intenciones y se las pasa al servicio con el id del pedido', async () => {
    const intenciones = [
      { accion: 'CANTIDAD', itemId: 1, cantidad: 3 },
      { accion: 'QUITAR', itemId: 2 },
      { accion: 'AGREGAR', precioCOId: 9, cantidad: 5 },
    ];
    const r = await post('/pedidos/7/ajuste/vista-previa', { intenciones });

    expect(r.status).toBe(201);
    expect(vistaPrevia).toHaveBeenCalledTimes(1);
    expect(vistaPrevia.mock.calls[0][0]).toBe(7);
    expect(vistaPrevia.mock.calls[0][1]).toMatchObject(intenciones);
  });

  it('RECHAZA un precio dentro de una intención: el cliente no influye en el dinero', async () => {
    const r = await post('/pedidos/7/ajuste/vista-previa', {
      intenciones: [{ accion: 'CANTIDAD', itemId: 1, cantidad: 3, precioUnitario: 1 }],
    });
    expect(r.status).toBe(400);
    expect(vistaPrevia).not.toHaveBeenCalled();
  });

  it('RECHAZA un cuerpo sin intenciones', async () => {
    const r = await post('/pedidos/7/ajuste/vista-previa', {});
    expect(r.status).toBe(400);
  });

  it('RECHAZA un id de pedido que no es un entero', async () => {
    const r = await post('/pedidos/abc/ajuste/vista-previa', { intenciones: [] });
    expect(r.status).toBe(400);
  });

  it('una lista vacía es válida (el pedido tal como está)', async () => {
    const r = await post('/pedidos/7/ajuste/vista-previa', { intenciones: [] });
    expect(r.status).toBe(201);
  });
});

describe('POST cliente/pedidos/:id/propuesta/:propuestaId/vista', () => {
  it('es solo del CLIENTE: marcarla por el personal mentiría ("el cliente la vio")', () => {
    // Los guards son globales y no se montan en este spec, así que se fija el
    // metadato que el guard de roles lee.
    const roles = Reflect.getMetadata(ROLES_KEY, PropuestaController.prototype.marcarVista);
    expect(roles).toEqual([RolUsuario.CLIENTE]);
  });
});
