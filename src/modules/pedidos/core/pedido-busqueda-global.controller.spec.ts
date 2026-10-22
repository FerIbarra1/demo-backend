import 'reflect-metadata';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { RolUsuario } from '@prisma/client';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { MostradorQueryService } from '../../mostrador/mostrador-query.service';
import { PedidoBusquedaGlobalController } from './pedido-busqueda-global.controller';

/**
 * N2 (oct 2026): la búsqueda GLOBAL es solo del ADMIN, por HTTP con el `RolesGuard` real y el mismo `ValidationPipe`
 * de `main.ts`. Lo que importa: un empleado NO puede usarla (vería pedidos de otras tiendas) y el servicio se llama
 * SIN tienda solo para el ADMIN.
 */
describe('GET admin/busqueda/pedidos (búsqueda global, solo ADMIN)', () => {
  let app: INestApplication;
  let base: string;
  const query = { buscarPedidos: jest.fn() };

  class Auth implements CanActivate {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      req.user = JSON.parse(String(req.headers['x-usuario']));
      return true;
    }
  }

  beforeAll(async () => {
    @Module({
      controllers: [PedidoBusquedaGlobalController],
      providers: [
        { provide: APP_GUARD, useClass: Auth },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: MostradorQueryService, useValue: query },
      ],
    })
    class Mod {}
    app = await NestFactory.create(Mod, { logger: false });
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
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    query.buscarPedidos.mockResolvedValue({
      data: [{ id: 1, tienda: { id: 2 } }],
      meta: { total: 1 },
    });
  });

  const pedir = (rol: RolUsuario, qs: string, tiendaId?: number) =>
    fetch(`${base}/admin/busqueda/pedidos?${qs}`, {
      headers: { 'x-usuario': JSON.stringify({ userId: 7, nombre: 'P', rol, tiendaId }) },
    });

  it.each([
    RolUsuario.BODEGA,
    RolUsuario.CAJERO,
    RolUsuario.MOSTRADOR,
    RolUsuario.VENTAS,
    RolUsuario.CLIENTE,
  ])('%s → 403 y no se busca nada', async (rol) => {
    expect((await pedir(rol, 'q=camisa', 1)).status).toBe(403);
    expect(query.buscarPedidos).not.toHaveBeenCalled();
  });

  it('ADMIN: busca SIN tienda (todas) y pagina', async () => {
    const r = await pedir(RolUsuario.ADMIN, 'q=%20camisa%20&pagina=2&limite=5');
    expect(r.status).toBe(200);
    expect(query.buscarPedidos).toHaveBeenCalledWith(
      'camisa',
      expect.objectContaining({ rol: 'ADMIN' }),
      undefined,
      2,
      5,
    );
  });

  it('ADMIN con tienda en el token: sigue siendo global (no se acota a la suya)', async () => {
    await pedir(RolUsuario.ADMIN, 'q=camisa', 3);
    expect(query.buscarPedidos.mock.calls[0][2]).toBeUndefined();
  });

  it('menos de 2 caracteres → 400 del DTO (@MinLength) y no se consulta; sin q → vacío', async () => {
    expect((await pedir(RolUsuario.ADMIN, 'q=a')).status).toBe(400);
    const r = await pedir(RolUsuario.ADMIN, '');
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual([]);
    expect(query.buscarPedidos).not.toHaveBeenCalled();
  });

  it('un ?tiendaId= es 400 (no se ignora en silencio: aquí no acota nada)', async () => {
    expect((await pedir(RolUsuario.ADMIN, 'q=camisa&tiendaId=2')).status).toBe(400);
    expect(query.buscarPedidos).not.toHaveBeenCalled();
  });
});
