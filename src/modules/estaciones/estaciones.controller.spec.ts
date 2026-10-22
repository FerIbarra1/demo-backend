import 'reflect-metadata';
import { CanActivate, ExecutionContext, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { RolUsuario } from '@prisma/client';
import { RolesGuard } from '../../common/guards/roles.guard';
import { VentanillasService } from '../ventanillas/ventanillas.service';
import { BodegaPresenciaService } from './bodega-presencia.service';
import { EstacionesController } from './estaciones.controller';

/**
 * F3.5 (oct 2026): `POST /estaciones/soltar`, por HTTP de verdad con el `RolesGuard` real.
 *
 * Es lo que la pantalla llama ANTES de que el ADMIN cambie de tienda o cierre sesión. Suelta a la vez su
 * ventanilla de caja y los pedidos de bodega que traía, en cualquier tienda. Lo que se cuida:
 *  - es SOLO del ADMIN: un cajero o un bodeguero que lo llamara soltaría estaciones ajenas a su criterio
 *    (cada uno ya tiene su propio "liberar", que sí respeta su tienda);
 *  - los pedidos de bodega se devuelven SIN sacarlo de línea (`soloPedidos`): cambiar de tienda no es irse;
 *  - la respuesta dice qué soltó, para el aviso de la pantalla ("Soltaste la ventanilla 2 y 1 pedido…").
 *
 * Lo que se escribe en la BD lo cubren `admin-cubre-puesto-postgres.spec.ts` y `bodega-presencia-postgres.spec.ts`.
 */
describe('POST /estaciones/soltar', () => {
  let app: INestApplication;
  let base: string;
  const ventanillas = { liberarDelUsuario: jest.fn() };
  const bodegueros = { salio: jest.fn() };

  class AutenticacionDePrueba implements CanActivate {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      req.user = JSON.parse(String(req.headers['x-usuario']));
      return true;
    }
  }

  beforeAll(async () => {
    @Module({
      controllers: [EstacionesController],
      providers: [
        { provide: APP_GUARD, useClass: AutenticacionDePrueba },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: VentanillasService, useValue: ventanillas },
        { provide: BodegaPresenciaService, useValue: bodegueros },
      ],
    })
    class ModuloDePrueba {}
    app = await NestFactory.create(ModuloDePrueba, { logger: false });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    ventanillas.liberarDelUsuario.mockResolvedValue(null);
    bodegueros.salio.mockResolvedValue({ pedidosRegresados: 0 });
  });

  const soltar = (rol: RolUsuario, userId = 77) =>
    fetch(`${base}/estaciones/soltar`, {
      method: 'POST',
      headers: { 'x-usuario': JSON.stringify({ userId, nombre: 'Prueba', rol }) },
    });

  it.each([RolUsuario.CAJERO, RolUsuario.BODEGA, RolUsuario.MOSTRADOR, RolUsuario.CLIENTE])(
    '%s → 403 y no se suelta nada',
    async (rol) => {
      const r = await soltar(rol);
      expect(r.status).toBe(403);
      expect(ventanillas.liberarDelUsuario).not.toHaveBeenCalled();
      expect(bodegueros.salio).not.toHaveBeenCalled();
    },
  );

  it('el ADMIN suelta SU ventanilla y SUS pedidos de bodega, y la respuesta dice cuánto', async () => {
    ventanillas.liberarDelUsuario.mockResolvedValue({
      numero: 2,
      tiendaId: 5,
      ok: true,
      pedidosRegresadosALaFila: 3,
    });
    bodegueros.salio.mockResolvedValue({ pedidosRegresados: 1 });

    const r = await soltar(RolUsuario.ADMIN, 42);

    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({
      ventanilla: { numero: 2, pedidosRegresados: 3 },
      pedidosDeBodegaRegresados: 1,
    });
    // Con SU id (el del token), nunca uno que venga en la petición.
    expect(ventanillas.liberarDelUsuario).toHaveBeenCalledWith(42);
    // `soloPedidos`: cambiar de tienda no lo saca de línea ni dice a la TV que se fue.
    expect(bodegueros.salio).toHaveBeenCalledWith(42, { soloPedidos: true });
  });

  it('sin nada que soltar responde en ceros (no es un error: la pantalla lo llama siempre)', async () => {
    const r = await soltar(RolUsuario.ADMIN);
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ ventanilla: null, pedidosDeBodegaRegresados: 0 });
  });
});
