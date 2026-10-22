import 'reflect-metadata';
import { CanActivate, ExecutionContext, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { RolUsuario } from '@prisma/client';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { GerenciaController } from './gerencia.controller';
import { TorreControlService } from './torre-control.service';
import { SaludSistemaService } from './salud-sistema.service';

/**
 * Oct 2026: lo que ve el GERENTE de UNA tienda. Por HTTP con el `RolesGuard` y la resolución de tienda REALES:
 * solo el GERENTE (y el ADMIN, que pasa siempre) entra; su tienda sale del TOKEN y un `?tiendaId=` no la cambia; y
 * el ADMIN, que no trae tienda, tiene que elegir una.
 */
describe('gerencia/* (el GERENTE ve SU tienda)', () => {
  let app: INestApplication;
  let base: string;
  const torre = { obtener: jest.fn() };
  const salud = { obtenerParaGerente: jest.fn() };
  const prisma = { tienda: { count: jest.fn() } };

  class Auth implements CanActivate {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      req.user = JSON.parse(String(req.headers['x-usuario']));
      return true;
    }
  }

  beforeAll(async () => {
    @Module({
      controllers: [GerenciaController],
      providers: [
        { provide: APP_GUARD, useClass: Auth },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: TorreControlService, useValue: torre },
        { provide: SaludSistemaService, useValue: salud },
        { provide: PrismaService, useValue: prisma },
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
    salud.obtenerParaGerente.mockResolvedValue({ generadoAt: 'x' });
    prisma.tienda.count.mockResolvedValue(1);
  });

  const pedir = (ruta: string, rol: RolUsuario, tiendaId?: number, query = '') =>
    fetch(`${base}/gerencia/${ruta}${query}`, {
      headers: { 'x-usuario': JSON.stringify({ userId: 7, nombre: 'P', rol, tiendaId }) },
    });

  describe.each(['torre-control', 'salud'])('GET gerencia/%s', (ruta) => {
    it.each([
      RolUsuario.BODEGA,
      RolUsuario.BODEGA_MONITOR,
      RolUsuario.CAJERO,
      RolUsuario.CAJERO_MONITOR,
      RolUsuario.MOSTRADOR,
      RolUsuario.MOSTRADOR_MONITOR,
      RolUsuario.VENTAS,
      RolUsuario.CLIENTE,
      RolUsuario.TESORERIA,
      RolUsuario.IMPRESION,
    ])('%s → 403 y no se calcula nada', async (rol) => {
      expect((await pedir(ruta, rol, 1)).status).toBe(403);
      expect(torre.obtener).not.toHaveBeenCalled();
      expect(salud.obtenerParaGerente).not.toHaveBeenCalled();
    });

    it('GERENTE → 200 con la tienda de SU token; un ?tiendaId= de otra tienda se IGNORA', async () => {
      const r = await pedir(ruta, RolUsuario.GERENTE, 3, '?tiendaId=9');
      expect(r.status).toBe(200);
      if (ruta === 'torre-control') {
        expect(torre.obtener).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 7, rol: 'GERENTE', tiendaId: 3 }),
          expect.any(Date),
          3,
        );
      } else {
        expect(salud.obtenerParaGerente).toHaveBeenCalledWith(3);
      }
      // Ni siquiera se consulta la BD por la tienda "9": solo un ADMIN elige.
      expect(prisma.tienda.count).not.toHaveBeenCalled();
    });

    it('GERENTE sin tienda en el token → 403 (no es algo que él pueda elegir)', async () => {
      expect((await pedir(ruta, RolUsuario.GERENTE)).status).toBe(403);
      expect(torre.obtener).not.toHaveBeenCalled();
      expect(salud.obtenerParaGerente).not.toHaveBeenCalled();
    });

    it('ADMIN sin tienda → 400 "Elige una tienda"; eligiéndola → 200 con ESA tienda', async () => {
      expect((await pedir(ruta, RolUsuario.ADMIN)).status).toBe(400);
      expect(torre.obtener).not.toHaveBeenCalled();
      const ok = await pedir(ruta, RolUsuario.ADMIN, undefined, '?tiendaId=5');
      expect(ok.status).toBe(200);
      expect(prisma.tienda.count).toHaveBeenCalledWith({ where: { id: 5 } });
    });

    it('ADMIN eligiendo una tienda que no existe → 404', async () => {
      prisma.tienda.count.mockResolvedValue(0);
      expect((await pedir(ruta, RolUsuario.ADMIN, undefined, '?tiendaId=99')).status).toBe(404);
    });
  });
});
