import { AuthController } from './auth.controller';

/**
 * El contrato HTTP de la sesión, sin BD: qué sale en el CUERPO y qué en la COOKIE.
 *
 * Antes `login`, `register`, `refresh` y `kiosk-login` devolvían el `refreshToken` también en el JSON. Eso anulaba la
 * cookie httpOnly: cualquier script (XSS) podía llamar a `POST /auth/refresh` y leerlo de la respuesta.
 */
const RESULTADO = {
  accessToken: 'acceso',
  refreshToken: 'REFRESCO-SECRETO',
  refreshTokenId: 7,
  expiresIn: 3600,
  user: { id: 1, email: 'a@b.c', nombre: 'A', rol: 'CLIENTE' },
};

function armar() {
  const authService = {
    register: jest.fn().mockResolvedValue(RESULTADO),
    login: jest.fn().mockResolvedValue(RESULTADO),
    refreshToken: jest.fn().mockResolvedValue(RESULTADO),
    loginByKioskToken: jest.fn().mockResolvedValue(RESULTADO),
    logout: jest.fn().mockResolvedValue({ message: 'ok' }),
  };
  const res = { cookie: jest.fn(), clearCookie: jest.fn() };
  const controller = new AuthController(authService as never);
  return { controller, authService, res: res as never, cookies: res };
}

describe('AuthController: el refresh token solo viaja en la cookie', () => {
  const casos: Array<[string, (c: AuthController, res: never) => Promise<unknown>]> = [
    ['login', (c, res) => c.login({ email: 'a@b.c', password: 'x' } as never, res)],
    ['register', (c, res) => c.register({} as never, res)],
    ['refresh', (c, res) => c.refreshToken({} as never, { cookies: { refresh_token: 'r' } }, res)],
    ['kiosk-login', (c, res) => c.kioskLogin({} as never, res)],
  ];

  it.each(casos)(
    '%s: el cuerpo NO lleva refreshToken ni refreshTokenId, la cookie sí',
    async (_n, llamar) => {
      const { controller, res, cookies } = armar();
      const cuerpo = (await llamar(controller, res)) as Record<string, unknown>;

      expect(cuerpo).not.toHaveProperty('refreshToken');
      expect(cuerpo).not.toHaveProperty('refreshTokenId');
      expect(JSON.stringify(cuerpo)).not.toContain('REFRESCO-SECRETO');
      expect(cuerpo).toMatchObject({ accessToken: 'acceso', expiresIn: 3600, user: { id: 1 } });
      expect(cookies.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'REFRESCO-SECRETO',
        expect.objectContaining({ httpOnly: true, path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 }),
      );
    },
  );
});

describe('AuthController: logout', () => {
  it('pasa la cookie al servicio (cierra ESTE dispositivo) y la borra con los MISMOS atributos con que se escribió', async () => {
    const { controller, authService, res, cookies } = armar();
    await controller.logout(
      5,
      'tok',
      'CLIENTE' as never,
      { cookies: { refresh_token: 'mi-refresco' } } as never,
      res,
    );

    expect(authService.logout).toHaveBeenCalledWith(5, 'tok', 'CLIENTE', 'mi-refresco');
    const escritas = armar();
    await escritas.controller.login({ email: 'a@b.c', password: 'x' } as never, escritas.res);
    const { maxAge: _m, ...alEscribir } = escritas.cookies.cookie.mock.calls[0][2];
    // Si difieren (path, sameSite, secure, httpOnly) el navegador no reconoce la cookie y la sesión queda "pegada".
    expect(cookies.clearCookie).toHaveBeenCalledWith('refresh_token', alEscribir);
  });

  it('sin cookie igualmente cierra sesión (el servicio revoca todas)', async () => {
    const { controller, authService, res } = armar();
    await controller.logout(5, 'tok', 'CLIENTE' as never, {} as never, res);
    expect(authService.logout).toHaveBeenCalledWith(5, 'tok', 'CLIENTE', undefined);
  });
});
