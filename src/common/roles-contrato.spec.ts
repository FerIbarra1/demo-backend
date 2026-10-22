import 'reflect-metadata';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { RolUsuario } from '@prisma/client';
import { ROLES_KEY } from './decorators/roles.decorator';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { IS_API_KEY_AUTH_KEY } from './decorators/api-key.decorator';
import { AuthController } from '../modules/auth/auth.controller';
import { ROLES_EMPLEADO } from '../modules/usuarios/dto/usuarios.dto';

/**
 * Contrato de roles (oct 2026).
 *
 * Cada vez que se agregó un rol faltó nombrarlo en alguna lista: `MOSTRADOR_MONITOR` no estaba
 * en el DTO de usuarios ni en `logout`/`me` (el cierre de sesión devolvía 403 y el refresh token
 * quedaba vivo), y `VENTAS` no estaba en la búsqueda por folio. Este spec convierte "no se me
 * olvide" en "falla el build": un rol nuevo no pasa hasta que alguien decida, explícitamente,
 * dónde entra.
 *
 * Y fija lo contrario: `RolesGuard` deja pasar a CUALQUIER rol autenticado en un endpoint sin
 * `@Roles`, así que un endpoint sin ninguna declaración sería una puerta abierta para el rol
 * nuevo.
 */

const rolesDe = (alvo: object): RolUsuario[] | undefined => Reflect.getMetadata(ROLES_KEY, alvo);

describe('Contrato de roles', () => {
  const todos = Object.values(RolUsuario);

  it('el DTO de usuarios ofrece todos los roles de empleado (todos menos CLIENTE)', () => {
    const esperados = todos.filter((r) => r !== RolUsuario.CLIENTE).sort();
    expect([...ROLES_EMPLEADO].sort()).toEqual(esperados);
  });

  describe('AuthController: sesión y perfil de todo usuario autenticado', () => {
    const proto = AuthController.prototype as unknown as Record<string, object>;
    const paraTodos = ['logout', 'getProfile', 'updateProfile', 'changePassword'];

    it.each(paraTodos)('%s admite a todos los roles', (metodo) => {
      const roles = rolesDe(proto[metodo]);
      expect(roles).toBeDefined();
      expect(todos.filter((r) => !roles!.includes(r))).toEqual([]);
    });

    it('heartbeat admite a todos los roles de empleado (a CLIENTE no le aplica)', () => {
      const roles = rolesDe(proto.heartbeat)!;
      const faltan = todos.filter((r) => r !== RolUsuario.CLIENTE && !roles.includes(r));
      expect(faltan).toEqual([]);
      expect(roles).not.toContain(RolUsuario.CLIENTE);
    });
  });

  describe('ningún endpoint queda abierto a "cualquier rol autenticado"', () => {
    const raiz = join(__dirname, '..', 'modules');
    const archivos: string[] = [];
    const recorrer = (dir: string) => {
      for (const nombre of readdirSync(dir)) {
        const ruta = join(dir, nombre);
        if (statSync(ruta).isDirectory()) recorrer(ruta);
        else if (nombre.endsWith('.controller.ts')) archivos.push(ruta);
      }
    };
    recorrer(raiz);

    it('hay controllers que revisar', () => {
      expect(archivos.length).toBeGreaterThan(20);
    });

    it('todo handler HTTP declara @Roles, @Public o @ApiKeyAuth (en el método o en la clase)', () => {
      const abiertos: string[] = [];
      for (const archivo of archivos) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const modulo = require(archivo) as Record<string, unknown>;
        for (const exportado of Object.values(modulo)) {
          if (typeof exportado !== 'function' || !exportado.prototype) continue;
          const clase = exportado as new (...a: never[]) => object;
          const esController = Reflect.getMetadata('path', clase) !== undefined;
          if (!esController) continue;
          for (const nombre of Object.getOwnPropertyNames(clase.prototype)) {
            if (nombre === 'constructor') continue;
            const handler = (clase.prototype as Record<string, object>)[nombre];
            if (typeof handler !== 'function') continue;
            if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue; // no es ruta
            const declarado =
              Reflect.getMetadata(ROLES_KEY, handler) ??
              Reflect.getMetadata(ROLES_KEY, clase) ??
              Reflect.getMetadata(IS_PUBLIC_KEY, handler) ??
              Reflect.getMetadata(IS_PUBLIC_KEY, clase) ??
              Reflect.getMetadata(IS_API_KEY_AUTH_KEY, handler) ??
              Reflect.getMetadata(IS_API_KEY_AUTH_KEY, clase);
            if (declarado === undefined) abiertos.push(`${clase.name}.${nombre}`);
          }
        }
      }
      expect(abiertos).toEqual([]);
    });
  });

  describe('GERENTE solo está donde se le nombra (lista cerrada)', () => {
    // El gerente supervisa UNA tienda (torre, salud, búsqueda). Lo que solo hace el ADMIN —marcar gratis, cancelar
    // pagados, cambiar precios, crear empleados— es solo del ADMIN porque `RolesGuard` niega por defecto: basta con
    // que GERENTE no aparezca en esos controllers. Este test lo convierte en contrato: si alguien agrega GERENTE a
    // un `@Roles` fuera de esta lista (sea de método o de clase), falla y tiene que explicar por qué.
    const PERMITIDO_COMPLETO = [
      'GerenciaController',
      'PedidoConsultaController',
      'PedidoBusquedaController',
      // Destrabar pedidos (gerente y admin) y las tareas del Sistema Comercial (también las ve el cajero).
      'DestrabarController',
      'TareasErpController',
    ];
    const PERMITIDO_SOLO = {
      AuthController: ['logout', 'getProfile', 'updateProfile', 'changePassword', 'heartbeat'],
      // Kioskos de SU tienda (alta, ubicación, apagar, desvincular) y vincular sus tablets. El alcance por tienda
      // lo hace `KioskoService`/`KioskoPairingService` (`kiosko.service.spec.ts`); aquí solo se nombra dónde entra.
      KioskoController: ['listar', 'crear', 'actualizar', 'desvincular'],
      KioskoPairingController: ['buscar', 'aprobar', 'cancelar'],
    } as Record<string, string[]>;

    const raiz = join(__dirname, '..', 'modules');
    const archivos: string[] = [];
    const recorrer = (dir: string) => {
      for (const nombre of readdirSync(dir)) {
        const ruta = join(dir, nombre);
        if (statSync(ruta).isDirectory()) recorrer(ruta);
        else if (nombre.endsWith('.controller.ts')) archivos.push(ruta);
      }
    };
    recorrer(raiz);

    it('GERENTE aparece únicamente en las rutas autorizadas', () => {
      const encontrados: string[] = [];
      for (const archivo of archivos) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const modulo = require(archivo) as Record<string, unknown>;
        for (const exportado of Object.values(modulo)) {
          if (typeof exportado !== 'function' || !exportado.prototype) continue;
          const clase = exportado as new (...a: never[]) => object;
          if (Reflect.getMetadata('path', clase) === undefined) continue;
          for (const nombre of Object.getOwnPropertyNames(clase.prototype)) {
            if (nombre === 'constructor') continue;
            const handler = (clase.prototype as Record<string, object>)[nombre];
            if (typeof handler !== 'function') continue;
            if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
            // Como `RolesGuard`: el `@Roles` del método manda sobre el de la clase.
            const roles = rolesDe(handler) ?? rolesDe(clase) ?? [];
            if (!roles.includes(RolUsuario.GERENTE)) continue;
            const permitido =
              PERMITIDO_COMPLETO.includes(clase.name) ||
              PERMITIDO_SOLO[clase.name]?.includes(nombre);
            if (!permitido) encontrados.push(`${clase.name}.${nombre}`);
          }
        }
      }
      expect(encontrados).toEqual([]);
    });

    it('y de verdad está en las que dice la lista (no es una lista que quedó vacía)', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GerenciaController } = require('../modules/admin-torre/gerencia.controller');
      expect(rolesDe(GerenciaController)).toEqual([RolUsuario.GERENTE]);
    });
  });

  describe('TESORERIA no entra a las consolas de otros roles', () => {
    // Las consolas operan pedidos de UNA tienda y asumen `user.tiendaId`. Tesorería no tiene tienda
    // y su única puerta a los pedidos es el módulo de pagos, que ve solo lo que tiene una
    // transferencia. Si alguien la agrega a una de estas listas, este test pregunta por qué.
    const consolas: Array<[string, string]> = [
      ['../modules/pedidos/cajero/cajero.controller', 'CajeroController'],
      ['../modules/pedidos/bodega/bodega.controller', 'BodegaController'],
      ['../modules/mostrador/mostrador.controller', 'MostradorController'],
      ['../modules/pedidos/ventas/ventas.controller', 'VentasController'],
      ['../modules/pedidos/cliente/cliente.controller', 'ClienteController'],
      ['../modules/pedidos/messages/messages.controller', 'MessagesController'],
      ['../modules/pedidos/reposicion/reposicion.controller', 'ReposicionController'],
      ['../modules/pedidos/core/pedido-consulta.controller', 'PedidoConsultaController'],
      ['../modules/pedidos/core/pedido-busqueda.controller', 'PedidoBusquedaController'],
    ];

    it.each(consolas)('%s (%s)', (ruta, nombre) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const clase = (require(ruta) as Record<string, object>)[nombre];
      expect(clase).toBeDefined();
      expect(rolesDe(clase) ?? []).not.toContain(RolUsuario.TESORERIA);
    });
  });
});
