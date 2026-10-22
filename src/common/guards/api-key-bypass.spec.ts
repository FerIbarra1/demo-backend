import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolUsuario } from '@prisma/client';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_API_KEY_AUTH_KEY } from '../decorators/api-key.decorator';

/**
 * Los guards globales (`JwtAuthGuard`, `RolesGuard`) corren ANTES que los
 * guards declarados a nivel de controller. Las rutas del agente externo
 * (Firebird) se autentican con `ApiKeyGuard` + `@ApiKeyAuth()`, y el agente no
 * tiene JWT ni rol: sin una excepción explícita, `JwtAuthGuard` lo rechazaba
 * con 401 y `RolesGuard` con 403 antes de que `ApiKeyGuard` llegara a evaluar
 * el header `X-Agent-Key`.
 *
 * Estos tests fijan ese contrato. Si alguien quita el bypass, fallan.
 */
describe('Guards globales vs. rutas de API key', () => {
  /** Reflector que responde según la metadata que el test declare presente. */
  function reflectorCon(metadata: {
    isPublic?: boolean;
    isApiKeyAuth?: boolean;
    roles?: RolUsuario[];
  }): Reflector {
    return {
      getAllAndOverride: (key: string) => {
        if (key === IS_PUBLIC_KEY) return metadata.isPublic;
        if (key === IS_API_KEY_AUTH_KEY) return metadata.isApiKeyAuth;
        return metadata.roles;
      },
    } as unknown as Reflector;
  }

  function contextoCon(user?: unknown, headers: Record<string, string> = {}): ExecutionContext {
    return {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({ user, headers }),
        getResponse: () => ({}),
      }),
    } as unknown as ExecutionContext;
  }

  describe('JwtAuthGuard', () => {
    it('deja pasar al AGENTE (X-Agent-Key) en una ruta @ApiKeyAuth() sin JWT', () => {
      const guard = new JwtAuthGuard(reflectorCon({ isApiKeyAuth: true }));
      // Sin el bypass esto delegaría en passport y lanzaría 401. El agente siempre trae su
      // llave; sin ella la petición se autentica como cualquier otra (ver `jwt-auth.guard.spec`:
      // así un ADMIN con sesión puede usar "Marcar como pagado" del panel).
      expect(guard.canActivate(contextoCon(undefined, { 'x-agent-key': 'llave' }))).toBe(true);
    });

    it('sigue dejando pasar una ruta @Public()', () => {
      const guard = new JwtAuthGuard(reflectorCon({ isPublic: true }));
      expect(guard.canActivate(contextoCon())).toBe(true);
    });

    it('NO exime una ruta normal: delega en passport', async () => {
      const guard = new JwtAuthGuard(reflectorCon({}));
      // Sin estrategia 'jwt' registrada, `super.canActivate` rechaza. Lo que
      // importa es que NO devuelva `true` por accidente: el bypass solo debe
      // aplicar a rutas marcadas.
      await expect(guard.canActivate(contextoCon())).rejects.toThrow(
        /Unknown authentication strategy/,
      );
    });
  });

  describe('RolesGuard', () => {
    it('deja pasar una ruta @ApiKeyAuth() aunque la clase tenga @Roles()', () => {
      const guard = new RolesGuard(reflectorCon({ isApiKeyAuth: true, roles: [RolUsuario.ADMIN] }));
      // El agente no tiene `user`; sin el bypass esto lanzaría 403.
      expect(guard.canActivate(contextoCon())).toBe(true);
    });

    it('sigue rechazando un rol no autorizado en una ruta normal', () => {
      const guard = new RolesGuard(reflectorCon({ roles: [RolUsuario.ADMIN] }));
      expect(() => guard.canActivate(contextoCon({ rol: RolUsuario.BODEGA }))).toThrow(
        ForbiddenException,
      );
    });

    it('sigue exigiendo usuario cuando hay @Roles()', () => {
      const guard = new RolesGuard(reflectorCon({ roles: [RolUsuario.ADMIN] }));
      expect(() => guard.canActivate(contextoCon(undefined))).toThrow(ForbiddenException);
    });

    it('permite ADMIN en una ruta con @Roles()', () => {
      const guard = new RolesGuard(reflectorCon({ roles: [RolUsuario.BODEGA] }));
      expect(guard.canActivate(contextoCon({ rol: RolUsuario.ADMIN }))).toBe(true);
    });
  });
});
