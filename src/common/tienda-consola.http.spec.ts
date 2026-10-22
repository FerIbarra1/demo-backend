import 'reflect-metadata';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Module,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { RolUsuario } from '@prisma/client';
import { ROLES_KEY } from './decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { MostradorController } from '../modules/mostrador/mostrador.controller';
import { MostradorService } from '../modules/mostrador/mostrador.service';
import { MostradorQueryService } from '../modules/mostrador/mostrador-query.service';
import { CajeroController } from '../modules/pedidos/cajero/cajero.controller';
import { CajeroService } from '../modules/pedidos/cajero/cajero.service';
import { BodegaController } from '../modules/pedidos/bodega/bodega.controller';
import { BodegaService } from '../modules/pedidos/bodega/bodega.service';
import { SurtidoService } from '../modules/pedidos/bodega/surtido.service';
import { VentasController } from '../modules/pedidos/ventas/ventas.controller';
import { VentasService } from '../modules/pedidos/ventas/ventas.service';
import { ReposicionController } from '../modules/pedidos/reposicion/reposicion.controller';
import { ReposicionService } from '../modules/pedidos/reposicion/reposicion.service';
import { PedidoConsultaController } from '../modules/pedidos/core/pedido-consulta.controller';
import { PedidoStateService } from '../modules/pedidos/core/pedido-state.service';
import { MostradoresOperadorController } from '../modules/mostradores/mostradores-operador.controller';
import { MostradoresService } from '../modules/mostradores/mostradores.service';
import { VentanillasCajeroController } from '../modules/ventanillas/ventanillas-cajero.controller';
import { VentanillasService } from '../modules/ventanillas/ventanillas.service';

/**
 * PLAN-ADMIN-MULTITIENDA §4.1 y §6 (oct 2026): la matriz ANTI-IDOR, por HTTP de verdad.
 *
 *   rol  ×  (con / sin / ajeno `?tiendaId=`)  ×  cada endpoint de lista de las consolas
 *
 * Se levantan los controllers REALES (enrutador, guards de ruta y el `ValidationPipe` con las mismas
 * opciones de `main.ts`) con los servicios simulados, y se mira QUÉ TIENDA recibe el servicio. Es el
 * sitio donde un controller que lea `user.tiendaId` a secas, o el query sin pasar por la función, se
 * delata. Un mock de la función no probaría nada: aquí se prueba el cableado.
 *
 * Los roles de cada endpoint salen de su `@Roles` (no de una lista copiada): el día que se agregue uno,
 * la matriz lo cubre sola.
 */

type Llamadas = jest.Mock<Promise<unknown>, unknown[]>;
const mocksDe = new Map<Type, Record<string, Llamadas>>();

/** Servicio simulado: cualquier método existe, devuelve algo con forma de lista y recuerda sus llamadas. */
function servicioSimulado(token: Type) {
  const metodos: Record<string, Llamadas> = {};
  mocksDe.set(token, metodos);
  return new Proxy(
    {},
    {
      get: (_t, nombre: string) => {
        if (nombre === 'then') return undefined; // no es una promesa
        return (metodos[nombre] ??= jest.fn(async () => ({ data: [], meta: {} })));
      },
    },
  );
}

interface Endpoint {
  nombre: string;
  controller: Type;
  /** Nombre del método del controller (para leer su @Roles, por si algún día lo sobreescribe). */
  handler: string;
  ruta: string;
  servicio: Type;
  metodo: string;
  /** Posición de la tienda entre los argumentos con los que el controller llama al servicio. */
  argTienda: number;
  /** Indicador (badge) en vez de lista: sin tienda responde 0 en vez de 400/403. */
  opcional?: true;
  /** Qué responde un `opcional` sin tienda: `{ pendientes: 0 }` (badge, por defecto) o nada (`null` → cuerpo vacío). */
  sinTienda?: 'vacio';
  /** Una ACCIÓN (POST) y no una lista: elige de la cola de una tienda, así que el ADMIN debe mandar la suya. */
  http?: 'POST';
  /** Cuerpo JSON de la acción (los handlers de ventanilla leen `body.ventanillaId`). */
  cuerpo?: object;
}

const ENDPOINTS: Endpoint[] = [
  // ── Mostrador
  {
    nombre: 'mostrador/cola',
    controller: MostradorController,
    handler: 'listarCola',
    ruta: '/pedidos/mostrador/cola',
    servicio: MostradorQueryService,
    metodo: 'obtenerCola',
    argTienda: 0,
  },
  {
    nombre: 'mostrador/listos',
    controller: MostradorController,
    handler: 'listarListos',
    ruta: '/pedidos/mostrador/listos',
    servicio: MostradorQueryService,
    metodo: 'obtenerPedidosListos',
    argTienda: 0,
  },
  {
    nombre: 'mostrador/sin-aviso',
    controller: MostradorController,
    handler: 'listarSinAviso',
    ruta: '/pedidos/mostrador/sin-aviso',
    servicio: MostradorQueryService,
    metodo: 'obtenerSinAviso',
    argTienda: 0,
  },
  {
    nombre: 'mostrador/buscar',
    controller: MostradorController,
    handler: 'buscar',
    ruta: '/pedidos/mostrador/buscar?q=camisa',
    servicio: MostradorQueryService,
    metodo: 'buscarPedidos',
    argTienda: 2,
  },
  // ── Mostrador: una ACCIÓN que elige de la cola de UNA tienda (el ADMIN manda la suya)
  {
    nombre: 'mostrador/llamar-siguiente',
    controller: MostradorController,
    handler: 'llamarSiguiente',
    ruta: '/pedidos/mostrador/llamar-siguiente',
    http: 'POST',
    servicio: MostradorService,
    metodo: 'llamarSiguiente',
    argTienda: 1,
  },
  // ── Ventanilla de caja (F3.5, "cubrir puesto"): el ADMIN ocupa la de la tienda que opera, así que la tienda
  // sale de `@TiendaConsola()`. Antes `disponibles` le daba `[]` y no había forma de que ocupara una.
  {
    nombre: 'cajero/ventanilla/disponibles',
    controller: VentanillasCajeroController,
    handler: 'disponibles',
    ruta: '/cajero/ventanilla/disponibles',
    servicio: VentanillasService,
    metodo: 'listarPorTienda',
    argTienda: 0,
  },
  {
    // "Mi ventanilla en ESTA tienda": sin tienda no hay a quién preguntarle, y responde null (no 400/403).
    nombre: 'cajero/ventanilla (la mía)',
    controller: VentanillasCajeroController,
    handler: 'miVentanilla',
    ruta: '/cajero/ventanilla',
    servicio: VentanillasService,
    metodo: 'ventanillaDelCajero',
    argTienda: 1,
    opcional: true,
    sinTienda: 'vacio',
  },
  {
    nombre: 'cajero/ventanilla/elegir',
    controller: VentanillasCajeroController,
    handler: 'elegir',
    ruta: '/cajero/ventanilla/elegir',
    http: 'POST',
    cuerpo: { ventanillaId: 5 },
    servicio: VentanillasService,
    metodo: 'elegir',
    argTienda: 1,
  },
  {
    nombre: 'cajero/ventanilla/liberar',
    controller: VentanillasCajeroController,
    handler: 'liberar',
    ruta: '/cajero/ventanilla/liberar',
    http: 'POST',
    cuerpo: {},
    servicio: VentanillasService,
    metodo: 'liberar',
    argTienda: 1,
  },
  // ── Consulta compartida por las 5 consolas
  {
    nombre: 'consulta/buscar',
    controller: PedidoConsultaController,
    handler: 'buscar',
    ruta: '/pedidos/consulta/buscar?q=camisa',
    servicio: MostradorQueryService,
    metodo: 'buscarPedidos',
    argTienda: 2,
  },
  // ── Caja
  {
    nombre: 'cajero/cola-ventanilla',
    controller: CajeroController,
    handler: 'obtenerColaVentanilla',
    ruta: '/cajero/pedidos/cola-ventanilla',
    servicio: CajeroService,
    metodo: 'obtenerColaVentanilla',
    argTienda: 0,
  },
  {
    nombre: 'cajero/mis-pedidos',
    controller: CajeroController,
    handler: 'misPedidos',
    ruta: '/cajero/pedidos/mis-pedidos',
    servicio: CajeroService,
    metodo: 'obtenerMisPedidosCajero',
    argTienda: 1,
  },
  // ── Bodega
  {
    nombre: 'bodega/pendientes',
    controller: BodegaController,
    handler: 'obtenerPendientes',
    ruta: '/bodega/pedidos/pendientes',
    servicio: BodegaService,
    metodo: 'obtenerPedidosBodega',
    argTienda: 0,
  },
  {
    nombre: 'bodega/mis-pedidos',
    controller: BodegaController,
    handler: 'misPedidos',
    ruta: '/bodega/pedidos/mis-pedidos',
    servicio: BodegaService,
    metodo: 'obtenerMisPedidosBodeguero',
    argTienda: 1,
  },
  {
    nombre: 'bodega/surtir-juntos',
    controller: BodegaController,
    handler: 'surtirJuntos',
    ruta: '/bodega/pedidos/surtir-juntos',
    servicio: BodegaService,
    metodo: 'obtenerSurtirJuntos',
    argTienda: 1,
  },
  {
    nombre: 'bodega/surtir-juntos/lote',
    controller: BodegaController,
    handler: 'surtirJuntosLote',
    ruta: '/bodega/pedidos/surtir-juntos/lote',
    servicio: BodegaService,
    metodo: 'obtenerLoteSurtirJuntos',
    argTienda: 1,
  },
  {
    nombre: 'bodega/surtir-juntos/cola',
    controller: BodegaController,
    handler: 'surtirJuntosCola',
    ruta: '/bodega/pedidos/surtir-juntos/cola',
    servicio: BodegaService,
    metodo: 'obtenerSurtirJuntosCola',
    argTienda: 0,
  },
  {
    nombre: 'bodega/ajustes-entrega',
    controller: BodegaController,
    handler: 'ajustesEntrega',
    ruta: '/bodega/pedidos/ajustes-entrega',
    servicio: BodegaService,
    metodo: 'obtenerAjustesEntrega',
    argTienda: 0,
  },
  // ── Ventas
  {
    nombre: 'ventas/cola',
    controller: VentasController,
    handler: 'cola',
    ruta: '/ventas/pedidos/cola',
    servicio: VentasService,
    metodo: 'obtenerCola',
    argTienda: 0,
  },
  // ── Reposición
  {
    nombre: 'reposicion',
    controller: ReposicionController,
    handler: 'listar',
    ruta: '/bodega/reposicion',
    servicio: ReposicionService,
    metodo: 'listarPendientes',
    argTienda: 0,
  },
  {
    nombre: 'reposicion/contador',
    controller: ReposicionController,
    handler: 'contador',
    ruta: '/bodega/reposicion/contador',
    servicio: ReposicionService,
    metodo: 'contarPendientes',
    argTienda: 0,
    opcional: true,
  },
];

const rolesDe = (e: Endpoint): RolUsuario[] =>
  (Reflect.getMetadata(ROLES_KEY, e.controller.prototype[e.handler]) ??
    Reflect.getMetadata(ROLES_KEY, e.controller)) as RolUsuario[];

/** Tiendas que "existen" en la BD simulada. La 404 es la que no está aquí. */
const TIENDAS_EXISTENTES = [1, 2, 3];

describe('Consolas: de qué tienda es cada lista (anti-IDOR, rol × tiendaId × endpoint)', () => {
  let app: INestApplication;
  let base: string;

  /** Quien llama: lo que normalmente pone `JwtAuthGuard` en `request.user`. */
  class AutenticacionDePrueba implements CanActivate {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      req.user = JSON.parse(String(req.headers['x-usuario']));
      return true;
    }
  }

  beforeAll(async () => {
    const servicios = [
      MostradorService,
      MostradorQueryService,
      CajeroService,
      BodegaService,
      SurtidoService,
      VentasService,
      ReposicionService,
      PedidoStateService,
      MostradoresService,
      VentanillasService,
    ];
    @Module({
      controllers: [
        MostradorController,
        CajeroController,
        BodegaController,
        VentasController,
        ReposicionController,
        PedidoConsultaController,
        MostradoresOperadorController,
        VentanillasCajeroController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: AutenticacionDePrueba },
        {
          provide: PrismaService,
          useValue: {
            tienda: {
              count: jest.fn(async ({ where }: { where: { id: number } }) =>
                TIENDAS_EXISTENTES.includes(where.id) ? 1 : 0,
              ),
            },
            // Las acciones (`@RequiereEstacion`) pasan por `EstacionGuard`: el empleado de la prueba SÍ
            // tiene estación. Lo que se prueba aquí es la tienda, no la estación (eso lo cubre su spec).
            ventanilla: { findFirst: jest.fn(async () => ({ id: 1 })) },
            mostrador: { findFirst: jest.fn(async () => ({ id: 1 })), count: jest.fn() },
          },
        },
        ...servicios.map((s) => ({ provide: s, useValue: servicioSimulado(s) })),
      ],
    })
    class ModuloDePrueba {}

    app = await NestFactory.create(ModuloDePrueba, { logger: false });
    // Mismas opciones que src/main.ts: con `forbidNonWhitelisted`, un `?tiendaId=` que no esté en el DTO
    // de un buscador es 400 para TODOS — justo lo que este spec tiene que destapar.
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

  beforeEach(() => {
    for (const metodos of mocksDe.values()) for (const m of Object.values(metodos)) m.mockClear();
  });

  const llamar = (
    e: Endpoint,
    user: { rol: RolUsuario; tiendaId?: number },
    tiendaQuery?: string,
  ) => {
    const url = new URL(base + e.ruta);
    if (tiendaQuery !== undefined) url.searchParams.append('tiendaId', tiendaQuery);
    return fetch(url, {
      method: e.http ?? 'GET',
      headers: {
        'x-usuario': JSON.stringify({ userId: 77, nombre: 'Prueba', ...user }),
        ...(e.cuerpo ? { 'content-type': 'application/json' } : {}),
      },
      body: e.cuerpo ? JSON.stringify(e.cuerpo) : undefined,
    });
  };
  /** Un `opcional` sin tienda: ni 400 ni 403, y responde "nada que mostrar" en la forma que le toca. */
  const esperarSinTienda = async (e: Endpoint, r: Response) => {
    expect(r.status).toBe(e.http === 'POST' ? 201 : 200);
    if (e.sinTienda === 'vacio') expect(await r.text()).toBe('');
    else expect(await r.json()).toEqual({ pendientes: 0 });
  };
  /** El mock del método (lo crea si nadie lo ha llamado aún: un "no se llamó" no puede depender del orden). */
  const mockDe = (servicio: Type, metodo: string) =>
    (mocksDe.get(servicio)![metodo] ??= jest.fn(async () => ({ data: [], meta: {} })));
  /** Lo que responde un endpoint cuando todo sale bien: un GET da 200 y un POST de Nest, 201. */
  const ok = (e: Endpoint) => (e.http === 'POST' ? 201 : 200);
  const recibido = (e: Endpoint) => mockDe(e.servicio, e.metodo);
  const tiendaRecibida = (e: Endpoint) => recibido(e).mock.calls[0]?.[e.argTienda];

  describe.each(ENDPOINTS)('$nombre', (e) => {
    const roles = rolesDe(e);
    const empleados = roles.filter((r) => r !== RolUsuario.ADMIN);

    it('el endpoint admite al ADMIN y a algún rol de empleado (si no, la matriz no prueba nada)', () => {
      expect(roles).toContain(RolUsuario.ADMIN);
      expect(empleados.length).toBeGreaterThan(0);
    });

    describe.each(empleados)('empleado %s (tienda 1)', (rol) => {
      it('sin ?tiendaId= ve SU tienda', async () => {
        const r = await llamar(e, { rol, tiendaId: 1 });
        expect(r.status).toBe(ok(e));
        expect(tiendaRecibida(e)).toBe(1);
      });

      it.each(['2', '3', '999'])(
        'con ?tiendaId=%s (de otra tienda) sigue viendo SOLO la suya',
        async (ajena) => {
          const r = await llamar(e, { rol, tiendaId: 1 }, ajena);
          expect(r.status).toBe(ok(e));
          expect(recibido(e)).toHaveBeenCalledTimes(1);
          expect(tiendaRecibida(e)).toBe(1);
        },
      );

      it('un ?tiendaId= que es basura se ignora (no es un 400: no es suyo para elegir)', async () => {
        const r = await llamar(e, { rol, tiendaId: 1 }, 'abc');
        expect(r.status).toBe(ok(e));
        expect(tiendaRecibida(e)).toBe(1);
      });

      it(
        'sin tienda asignada: ' +
          (e.opcional ? 'el indicador dice 0' : '403 y el servicio ni se entera'),
        async () => {
          const r = await llamar(e, { rol }, '2');
          if (e.opcional) await esperarSinTienda(e, r);
          else expect(r.status).toBe(403);
          expect(recibido(e)).not.toHaveBeenCalled();
        },
      );
    });

    describe('ADMIN sin tienda en el token', () => {
      const admin = { rol: RolUsuario.ADMIN };

      it.each(TIENDAS_EXISTENTES.map(String))(
        'elige la tienda %s: el servicio recibe esa',
        async (t) => {
          const r = await llamar(e, admin, t);
          expect(r.status).toBe(ok(e));
          expect(tiendaRecibida(e)).toBe(Number(t));
        },
      );

      it(
        e.opcional
          ? 'sin elegir tienda el indicador dice 0'
          : 'sin elegir tienda: 400 "Elige una tienda" (antes 500, o la cola de TODAS las tiendas)',
        async () => {
          const r = await llamar(e, admin);
          if (e.opcional) {
            await esperarSinTienda(e, r);
          } else {
            expect(r.status).toBe(400);
            expect((await r.json()).message).toBe('Elige una tienda');
          }
          expect(recibido(e)).not.toHaveBeenCalled();
        },
      );

      it.each(['abc', '0', '-1', '1.5', '99999999999'])(
        'un tiendaId inválido (%s) es 400',
        async (malo) => {
          const r = await llamar(e, admin, malo);
          expect(r.status).toBe(400);
          expect(recibido(e)).not.toHaveBeenCalled();
        },
      );

      it('una tienda que no existe es 404, no una lista vacía que parece "esta tienda no tiene pedidos"', async () => {
        const r = await llamar(e, admin, '4040');
        expect(r.status).toBe(404);
        expect((await r.json()).message).toBe('La tienda no existe');
        expect(recibido(e)).not.toHaveBeenCalled();
      });
    });

    describe('ADMIN que SÍ trae tienda en el token (3)', () => {
      it('sin elegir otra usa la del token; eligiendo una, esa', async () => {
        const r1 = await llamar(e, { rol: RolUsuario.ADMIN, tiendaId: 3 });
        expect(r1.status).toBe(ok(e));
        expect(tiendaRecibida(e)).toBe(3);

        recibido(e).mockClear();
        const r2 = await llamar(e, { rol: RolUsuario.ADMIN, tiendaId: 3 }, '2');
        expect(r2.status).toBe(ok(e));
        expect(tiendaRecibida(e)).toBe(2);
      });
    });
  });

  // D3 (PLAN-ADMIN-MULTITIENDA): el ADMIN no ocupa el MOSTRADOR (llama sin número, que no asigna), pero abrir
  // la consola pide `disponibles` para el selector de estación: sin tienda en el token llegaba `undefined` a
  // Prisma y respondía 500. No es una lista de ninguna tienda: es "nada". La ventanilla de CAJA ya no está
  // aquí: desde F3.5 el ADMIN SÍ la ocupa y su `disponibles` vive en la tabla ENDPOINTS (lista de UNA tienda).
  describe('estaciones: el ADMIN no ocupa mostrador, pero tampoco recibe 500', () => {
    const ESTACIONES = [
      {
        nombre: 'mostrador/puesto/disponibles',
        ruta: '/mostrador/puesto/disponibles',
        rol: RolUsuario.MOSTRADOR,
        servicio: MostradoresService,
      },
    ];

    describe.each(ESTACIONES)('$nombre', (est) => {
      const pedir = (user: object) =>
        fetch(base + est.ruta, {
          headers: { 'x-usuario': JSON.stringify({ userId: 77, nombre: 'Prueba', ...user }) },
        });

      it('ADMIN sin tienda: 200 con lista vacía y sin molestar al servicio', async () => {
        const r = await pedir({ rol: RolUsuario.ADMIN });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual([]);
        expect(mockDe(est.servicio, 'listarPorTienda')).not.toHaveBeenCalled();
      });

      it('el empleado sigue viendo las de SU tienda', async () => {
        const r = await pedir({ rol: est.rol, tiendaId: 1 });
        expect(r.status).toBe(200);
        expect(mockDe(est.servicio, 'listarPorTienda').mock.calls[0][0]).toBe(1);
      });
    });
  });
});
