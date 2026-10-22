import 'reflect-metadata';
import { CanActivate, ExecutionContext, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { RolUsuario } from '@prisma/client';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TorreControlController } from './torre-control.controller';
import { TorreControlService } from './torre-control.service';

/**
 * N1 (oct 2026): la torre de control junta la operación de TODAS las tiendas, así que es solo del ADMIN. Por HTTP con
 * el `RolesGuard` real: ningún rol de empleado (ni el cliente) la ve — un empleado no puede mirar otra tienda (D1).
 */
describe('GET admin/torre-control (solo ADMIN)', () => {
  let app: INestApplication;
  let base: string;
  const torre = { obtener: jest.fn() };

  class Auth implements CanActivate {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      req.user = JSON.parse(String(req.headers['x-usuario']));
      return true;
    }
  }

  beforeAll(async () => {
    @Module({
      controllers: [TorreControlController],
      providers: [
        { provide: APP_GUARD, useClass: Auth },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: TorreControlService, useValue: torre },
      ],
    })
    class Mod {}
    app = await NestFactory.create(Mod, { logger: false });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    torre.obtener.mockResolvedValue({ generadoAt: 'x', tiendas: [] });
  });

  const pedir = (rol: RolUsuario, tiendaId?: number) =>
    fetch(`${base}/admin/torre-control`, {
      headers: { 'x-usuario': JSON.stringify({ userId: 7, nombre: 'P', rol, tiendaId }) },
    });

  it.each([
    RolUsuario.BODEGA,
    RolUsuario.CAJERO,
    RolUsuario.MOSTRADOR,
    RolUsuario.VENTAS,
    RolUsuario.CLIENTE,
    RolUsuario.TESORERIA,
    RolUsuario.IMPRESION,
    // El gerente tiene SU vista (`gerencia/*`); la de todas las tiendas sigue siendo solo del ADMIN.
    RolUsuario.GERENTE,
  ])('%s → 403 y no se calcula nada', async (rol) => {
    expect((await pedir(rol, 1)).status).toBe(403);
    expect(torre.obtener).not.toHaveBeenCalled();
  });

  it('ADMIN → 200, con su propio contexto (el servicio se lo pasa a Impresión)', async () => {
    const r = await pedir(RolUsuario.ADMIN);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ generadoAt: 'x', tiendas: [] });
    expect(torre.obtener).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, rol: 'ADMIN' }),
    );
  });
});
