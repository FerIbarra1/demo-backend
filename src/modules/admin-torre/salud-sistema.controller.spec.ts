import 'reflect-metadata';
import { CanActivate, ExecutionContext, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { RolUsuario } from '@prisma/client';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SaludSistemaController } from './salud-sistema.controller';
import { SaludSistemaService } from './salud-sistema.service';

/** N3 (oct 2026): la salud muestra errores y mensajes internos del ERP: solo ADMIN, por HTTP con el `RolesGuard` real. */
describe('GET admin/salud (solo ADMIN)', () => {
  let app: INestApplication;
  let base: string;
  const salud = { obtener: jest.fn() };
  class Auth implements CanActivate {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      req.user = JSON.parse(String(req.headers['x-usuario']));
      return true;
    }
  }
  beforeAll(async () => {
    @Module({
      controllers: [SaludSistemaController],
      providers: [
        { provide: APP_GUARD, useClass: Auth },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: SaludSistemaService, useValue: salud },
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
    salud.obtener.mockResolvedValue({ nivel: 'verde' });
  });
  const pedir = (rol: RolUsuario) =>
    fetch(`${base}/admin/salud`, {
      headers: { 'x-usuario': JSON.stringify({ userId: 7, nombre: 'P', rol, tiendaId: 1 }) },
    });

  it.each([
    RolUsuario.BODEGA,
    RolUsuario.CAJERO,
    RolUsuario.MOSTRADOR,
    RolUsuario.VENTAS,
    RolUsuario.CLIENTE,
    RolUsuario.TESORERIA,
    RolUsuario.IMPRESION,
    // El gerente tiene SU vista (`gerencia/salud`, sin lo técnico); la completa sigue siendo solo del ADMIN.
    RolUsuario.GERENTE,
  ])('%s → 403', async (rol) => {
    expect((await pedir(rol)).status).toBe(403);
    expect(salud.obtener).not.toHaveBeenCalled();
  });
  it('ADMIN → 200', async () => {
    const r = await pedir(RolUsuario.ADMIN);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ nivel: 'verde' });
  });
});
