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
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { DestrabarController, TareasErpController } from './destrabar.controller';
import { DestrabarService } from './destrabar.service';
import { TareasErpService } from './tareas-erp.service';

/**
 * Por HTTP con el `RolesGuard` y el `ValidationPipe` REALES: destrabar es del gerente (y el admin), el cajero solo ve y
 * cierra las tareas, y los demás roles reciben 403. El motivo es obligatorio (400 sin él).
 */
describe('destrabar y tareas-erp por HTTP', () => {
  let app: INestApplication;
  let base: string;
  const destrabar = { obtener: jest.fn(), ejecutar: jest.fn() };
  const tareas = { listar: jest.fn(), resolver: jest.fn() };
  const prisma = { tienda: { count: jest.fn().mockResolvedValue(1) } };

  class Auth implements CanActivate {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      req.user = JSON.parse(String(req.headers['x-usuario']));
      return true;
    }
  }

  beforeAll(async () => {
    @Module({
      controllers: [DestrabarController, TareasErpController],
      providers: [
        { provide: APP_GUARD, useClass: Auth },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: DestrabarService, useValue: destrabar },
        { provide: TareasErpService, useValue: tareas },
        { provide: PrismaService, useValue: prisma },
      ],
    })
    class Mod {}
    app = await NestFactory.create(Mod, { logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    destrabar.obtener.mockResolvedValue({});
    destrabar.ejecutar.mockResolvedValue({});
    tareas.listar.mockResolvedValue({ data: [], meta: {} });
    tareas.resolver.mockResolvedValue({});
  });

  const pedir = (ruta: string, rol: RolUsuario, tiendaId?: number, body?: object) =>
    fetch(`${base}/${ruta}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        'x-usuario': JSON.stringify({ userId: 7, nombre: 'P', rol, tiendaId }),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  it.each([
    RolUsuario.BODEGA,
    RolUsuario.CAJERO,
    RolUsuario.MOSTRADOR,
    RolUsuario.VENTAS,
    RolUsuario.TESORERIA,
    RolUsuario.IMPRESION,
    RolUsuario.CLIENTE,
  ])('%s no destraba pedidos (403) y no se ejecuta nada', async (rol) => {
    expect((await pedir('pedidos/5/destrabar', rol, 1)).status).toBe(403);
    expect(
      (await pedir('pedidos/5/destrabar/CANCELAR_SIN_PAGO', rol, 1, { motivo: 'prueba' })).status,
    ).toBe(403);
    expect(destrabar.obtener).not.toHaveBeenCalled();
    expect(destrabar.ejecutar).not.toHaveBeenCalled();
  });

  it('el gerente sí; sin motivo o con uno corto es 400 y un campo de más también (precio, estado…)', async () => {
    expect((await pedir('pedidos/5/destrabar', RolUsuario.GERENTE, 1)).status).toBe(200);
    expect(
      (await pedir('pedidos/5/destrabar/CANCELAR_SIN_PAGO', RolUsuario.GERENTE, 1, {})).status,
    ).toBe(400);
    expect(
      (
        await pedir('pedidos/5/destrabar/CANCELAR_SIN_PAGO', RolUsuario.GERENTE, 1, {
          motivo: 'ab',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await pedir('pedidos/5/destrabar/CANCELAR_SIN_PAGO', RolUsuario.GERENTE, 1, {
          motivo: 'válido',
          estado: 'PAGADO',
        })
      ).status,
    ).toBe(400);
    expect(destrabar.ejecutar).not.toHaveBeenCalled();
    expect(
      (
        await pedir('pedidos/5/destrabar/CANCELAR_SIN_PAGO', RolUsuario.GERENTE, 1, {
          motivo: 'Lleva 5 días sin pagar',
        })
      ).status,
    ).toBe(201);
    expect(destrabar.ejecutar).toHaveBeenCalledWith(
      5,
      'CANCELAR_SIN_PAGO',
      expect.objectContaining({ motivo: 'Lleva 5 días sin pagar' }),
      expect.objectContaining({ rol: 'GERENTE', tiendaId: 1 }),
      expect.anything(),
    );
  });

  it('QUITAR_PRODUCTOS: cada línea lleva solo itemId y cantidad (un precio, un producto nuevo o una cantidad negativa dan 400)', async () => {
    const quitar = (items: unknown) =>
      pedir('pedidos/5/destrabar/QUITAR_PRODUCTOS', RolUsuario.GERENTE, 1, {
        motivo: 'Pidió quitar uno por teléfono',
        items,
      });

    // Nada de eso llega al servicio: la frontera lo rechaza antes.
    for (const malo of [
      [{ itemId: 3, cantidad: 0, precioUnitario: 1 }], // un precio en el body
      [{ itemId: 3, cantidad: 1, precioCOId: 9 }], // agregar un producto
      [{ itemId: 3, cantidad: -1 }],
      [{ itemId: 3, cantidad: 1.5 }],
      [{ itemId: 0, cantidad: 1 }],
      [{ cantidad: 1 }],
      'no es una lista',
    ]) {
      expect((await quitar(malo)).status).toBe(400);
    }
    expect(destrabar.ejecutar).not.toHaveBeenCalled();

    expect(
      (
        await quitar([
          { itemId: 3, cantidad: 0 },
          { itemId: 4, cantidad: 2 },
        ])
      ).status,
    ).toBe(201);
    expect(destrabar.ejecutar).toHaveBeenCalledWith(
      5,
      'QUITAR_PRODUCTOS',
      expect.objectContaining({
        items: [
          { itemId: 3, cantidad: 0 },
          { itemId: 4, cantidad: 2 },
        ],
      }),
      expect.objectContaining({ rol: 'GERENTE' }),
      expect.anything(),
    );
  });

  it('las tareas: el cajero las ve y las cierra; "descartar" es solo del gerente; los demás roles, 403', async () => {
    expect((await pedir('tareas-erp', RolUsuario.CAJERO, 2)).status).toBe(200);
    expect(tareas.listar).toHaveBeenCalledWith(2);
    expect((await pedir('tareas-erp/9/hecha', RolUsuario.CAJERO, 2, {})).status).toBe(201);
    expect(
      (await pedir('tareas-erp/9/descartar', RolUsuario.CAJERO, 2, { nota: 'no aplica' })).status,
    ).toBe(403);
    expect(
      (await pedir('tareas-erp/9/descartar', RolUsuario.GERENTE, 2, { nota: 'no aplica' })).status,
    ).toBe(201);
    for (const rol of [
      RolUsuario.BODEGA,
      RolUsuario.MOSTRADOR,
      RolUsuario.VENTAS,
      RolUsuario.TESORERIA,
      RolUsuario.CLIENTE,
    ]) {
      expect((await pedir('tareas-erp', rol, 2)).status).toBe(403);
    }
  });
});
