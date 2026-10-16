import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IS_API_KEY_AUTH_KEY } from '../decorators/api-key.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Rutas de API key (`@ApiKeyAuth`, p. ej. `POST admin/pedidos/:id/marcar-pagado`).
 *
 * Regresión: el guard devolvía `true` para TODA ruta de API key sin autenticar el JWT. El agente
 * de Firebird entra (con `X-Agent-Key`), pero un ADMIN con sesión válida nunca llegaba a tener
 * `request.user`, así que `ApiKeyGuard` lo rechazaba con 401 y el botón "Marcar como pagado
 * (manual)" del panel no funcionaba.
 */
describe('JwtAuthGuard en rutas de API key', () => {
  // `AuthGuard('jwt')` es un mixin: se espía el `canActivate` de passport para no necesitar
  // una estrategia real. Si se llama, es que el guard SÍ intentó autenticar el JWT.
  const passportCanActivate = jest.fn();
  let guard: JwtAuthGuard;

  const contexto = (headers: Record<string, string>) =>
    ({
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    }) as unknown as ExecutionContext;

  const guardCon = (meta: { publica?: boolean; apiKey?: boolean }) => {
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === IS_PUBLIC_KEY ? !!meta.publica : key === IS_API_KEY_AUTH_KEY ? !!meta.apiKey : false,
    };
    return new JwtAuthGuard(reflector as never);
  };

  beforeEach(() => {
    passportCanActivate.mockReset().mockReturnValue(true);
    jest
      .spyOn(AuthGuard('jwt').prototype, 'canActivate')
      .mockImplementation(passportCanActivate as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('con X-Agent-Key pasa sin JWT (el agente no es un usuario): lo valida ApiKeyGuard', () => {
    guard = guardCon({ apiKey: true });
    expect(guard.canActivate(contexto({ 'x-agent-key': 'k' }))).toBe(true);
    expect(passportCanActivate).not.toHaveBeenCalled();
  });

  it('SIN X-Agent-Key autentica el JWT: así un ADMIN llega con request.user a ApiKeyGuard', () => {
    guard = guardCon({ apiKey: true });
    guard.canActivate(contexto({ authorization: 'Bearer abc' }));
    expect(passportCanActivate).toHaveBeenCalledTimes(1);
  });

  it('sin credenciales de ningún tipo no pasa de largo: se exige autenticar', () => {
    guard = guardCon({ apiKey: true });
    guard.canActivate(contexto({}));
    expect(passportCanActivate).toHaveBeenCalledTimes(1);
  });

  it('una ruta que NO es de API key sigue exigiendo JWT, traiga o no X-Agent-Key', () => {
    guard = guardCon({});
    guard.canActivate(contexto({ 'x-agent-key': 'k' }));
    expect(passportCanActivate).toHaveBeenCalledTimes(1);
  });

  it('una ruta pública pasa sin autenticar', () => {
    guard = guardCon({ publica: true });
    expect(guard.canActivate(contexto({}))).toBe(true);
    expect(passportCanActivate).not.toHaveBeenCalled();
  });
});
