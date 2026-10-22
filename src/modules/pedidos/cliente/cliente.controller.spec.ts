import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RolUsuario } from '@prisma/client';
import { AddressInfo } from 'net';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import { ClienteController } from './cliente.controller';
import { ClienteService } from './cliente.service';

/**
 * Oct 2026: cancelar un pedido y su lista de motivos, por HTTP de verdad.
 *
 * Los specs del servicio no pasan por el enrutador ni por el `ValidationPipe`, y ahí es donde un contrato roto aparece
 * "solo en producción". Se levanta la app con el controlador real y las MISMAS opciones de pipe que `main.ts`
 * (incluida la conversión implícita, que es justo lo que convierte el string "false" en `true`).
 */
describe('cancelar mi pedido, por HTTP', () => {
  let app: INestApplication;
  let base: string;
  const cancelarPedido = jest.fn(async (..._a: unknown[]) => ({ id: 7, estado: 'CANCELADO' }));
  const motivosDeCancelacion = jest.fn(() => [
    { codigo: 'OTRO', etiqueta: 'Otro motivo', pideDetalle: true },
  ]);
  const obtenerMiPedido = jest.fn(async (..._a: unknown[]) => ({ id: 7 }));

  beforeAll(async () => {
    @Module({
      controllers: [ClienteController],
      providers: [
        {
          provide: ClienteService,
          useValue: { cancelarPedido, motivosDeCancelacion, obtenerMiPedido },
        },
      ],
    })
    class ModuloDePrueba {}

    app = await NestFactory.create(ModuloDePrueba, { logger: false });
    // El guard de auth real pone al usuario en la petición; aquí se simula.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { userId: 100, rol: RolUsuario.CLIENTE, tiendaId: 5, nombre: 'Cliente' };
      next();
    });
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

  beforeEach(() => jest.clearAllMocks());

  const post = (ruta: string, body?: unknown) =>
    fetch(`${base}${ruta}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('SIN cuerpo vale: el motivo es opcional (el cliente de siempre no manda nada)', async () => {
    const r = await post('/cliente/pedidos/7/cancelar');
    expect(r.status).toBe(200);
    const [id, userId, , dto] = cancelarPedido.mock.calls[0] as [number, number, unknown, object];
    expect([id, userId]).toEqual([7, 100]);
    expect(dto).toEqual({});
  });

  it('con un cuerpo vacío también', async () => {
    expect((await post('/cliente/pedidos/7/cancelar', {})).status).toBe(200);
  });

  it('el motivo y la confirmación llegan al servicio', async () => {
    const r = await post('/cliente/pedidos/7/cancelar', {
      motivo: 'OTRO',
      detalle: 'Me voy de viaje',
      noHeTransferido: true,
    });
    expect(r.status).toBe(200);
    expect(cancelarPedido.mock.calls[0][3]).toEqual({
      motivo: 'OTRO',
      detalle: 'Me voy de viaje',
      noHeTransferido: true,
    });
  });

  it('un motivo fuera de la lista es un 400 y no llega al servicio', async () => {
    expect((await post('/cliente/pedidos/7/cancelar', { motivo: 'PORQUE_SI' })).status).toBe(400);
    expect(cancelarPedido).not.toHaveBeenCalled();
  });

  it('un campo que no existe es un 400 (forbidNonWhitelisted): ni un precio ni un estado se cuelan', async () => {
    expect((await post('/cliente/pedidos/7/cancelar', { estado: 'PAGADO' })).status).toBe(400);
    expect((await post('/cliente/pedidos/7/cancelar', { total: 0 })).status).toBe(400);
    expect(cancelarPedido).not.toHaveBeenCalled();
  });

  it('el STRING "false" NO confirma la transferencia (la conversión implícita lo volvería true)', async () => {
    expect((await post('/cliente/pedidos/7/cancelar', { noHeTransferido: 'false' })).status).toBe(
      400,
    );
    expect((await post('/cliente/pedidos/7/cancelar', { noHeTransferido: 1 })).status).toBe(400);
    expect(cancelarPedido).not.toHaveBeenCalled();
  });

  it('un texto de más de 200 caracteres es un 400', async () => {
    const r = await post('/cliente/pedidos/7/cancelar', {
      motivo: 'OTRO',
      detalle: 'x'.repeat(201),
    });
    expect(r.status).toBe(400);
  });

  it('GET motivos-cancelacion lo atiende SU ruta, no `:id` (ParseIntPipe habría respondido 400)', async () => {
    const r = await fetch(`${base}/cliente/pedidos/motivos-cancelacion`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([
      { codigo: 'OTRO', etiqueta: 'Otro motivo', pideDetalle: true },
    ]);
    expect(obtenerMiPedido).not.toHaveBeenCalled();
  });

  it('sigue habiendo detalle por id', async () => {
    expect((await fetch(`${base}/cliente/pedidos/7`)).status).toBe(200);
    expect(obtenerMiPedido).toHaveBeenCalledWith(7, 100);
  });

  it('solo el CLIENTE (y el ADMIN) entran a este controlador, ningún rol de tienda', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, ClienteController) as RolUsuario[];
    expect([...roles].sort()).toEqual([RolUsuario.ADMIN, RolUsuario.CLIENTE].sort());
  });
});
