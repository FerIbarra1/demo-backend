import { mensajeDeEntornoInvalido, validarEntorno } from './validar-entorno';

const SECRETO_A = 'a'.repeat(40);
const SECRETO_B = 'b'.repeat(40);
const SECRETO_C = 'c'.repeat(40);

const PRODUCCION_VALIDA: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db:5432/x',
  JWT_SECRET: SECRETO_A,
  KIOSKO_QR_SECRET: SECRETO_B,
  AGENT_API_KEY: SECRETO_C,
  FRONTEND_URL: 'https://app.ejemplo-real.com',
  SMTP_HOST: 'smtp.correo.com',
  SMTP_PORT: '587',
  SMTP_USER: 'u',
  SMTP_PASS: 'p',
  SMTP_FROM: 'Tienda <no-reply@tienda.com>',
  AWS_ACCESS_KEY_ID: 'AK',
  AWS_SECRET_ACCESS_KEY: 'SK',
  AWS_S3_BUCKET: 'bucket',
  AWS_REGION: 'us-west-2',
};

describe('validarEntorno', () => {
  it('una producción completa no tiene problemas', () => {
    expect(validarEntorno(PRODUCCION_VALIDA, true)).toEqual([]);
  });

  it('en desarrollo solo exige los dos secretos (y distintos)', () => {
    expect(validarEntorno({ JWT_SECRET: 'corto', KIOSKO_QR_SECRET: SECRETO_B }, false)).toEqual([]);
    expect(validarEntorno({}, false)).toHaveLength(2);
    expect(validarEntorno({ JWT_SECRET: SECRETO_A, KIOSKO_QR_SECRET: SECRETO_A }, false)).toEqual([
      expect.stringContaining('no puede ser igual a JWT_SECRET'),
    ]);
    expect(validarEntorno({ JWT_SECRET: SECRETO_A, KIOSKO_QR_SECRET: 'corto' }, false)).toEqual([
      expect.stringContaining('mínimo 32'),
    ]);
  });

  it.each([
    ['JWT_SECRET de ejemplo', { JWT_SECRET: 'secret-key' }, 'JWT_SECRET'],
    ['JWT_SECRET corto', { JWT_SECRET: 'x'.repeat(31) }, 'JWT_SECRET'],
    [
      'JWT_SECRET con marca de ejemplo aunque sea largo',
      { JWT_SECRET: 'cambiar-por-secreto-' + 'x'.repeat(30) },
      'JWT_SECRET',
    ],
    [
      'AGENT_API_KEY de ejemplo',
      { AGENT_API_KEY: 'dev-agent-key-cambiar-en-produccion' },
      'AGENT_API_KEY',
    ],
    ['AGENT_API_KEY ausente', { AGENT_API_KEY: undefined }, 'AGENT_API_KEY'],
    ['FRONTEND_URL ausente', { FRONTEND_URL: undefined }, 'FRONTEND_URL'],
    ['FRONTEND_URL sin https', { FRONTEND_URL: 'http://app.tienda.com' }, 'https://'],
    [
      'FRONTEND_URL con ruta (CORS la compara tal cual)',
      { FRONTEND_URL: 'https://app.tienda.com/tienda' },
      'sin ruta',
    ],
    ['FRONTEND_URL con parámetros', { FRONTEND_URL: 'https://app.tienda.com/?a=1' }, 'sin ruta'],
    ['FRONTEND_URL que no es una URL', { FRONTEND_URL: 'https://' }, 'FRONTEND_URL'],
    ['SMTP_PORT ausente (caería a MailHog en silencio)', { SMTP_PORT: undefined }, 'SMTP_PORT'],
    ['SMTP_PORT que no es un número', { SMTP_PORT: 'abc' }, 'SMTP_PORT'],
    ['TRUST_PROXY_HOPS que no es un entero', { TRUST_PROXY_HOPS: 'uno' }, 'TRUST_PROXY_HOPS'],
    ['SMTP en localhost', { SMTP_HOST: 'localhost' }, 'SMTP_HOST'],
    ['SMTP sin usuario', { SMTP_USER: '' }, 'SMTP_USER'],
    ['sin base de datos', { DATABASE_URL: undefined }, 'DATABASE_URL'],
    [
      'sin S3 (disco local: se pierde al redesplegar)',
      { AWS_S3_BUCKET: undefined },
      'AWS_S3_BUCKET',
    ],
    ['sin credenciales de S3', { AWS_ACCESS_KEY_ID: undefined }, 'AWS_ACCESS_KEY_ID'],
  ])('producción: %s', (_n, cambio, texto) => {
    const problemas = validarEntorno({ ...PRODUCCION_VALIDA, ...cambio }, true);
    expect(problemas.length).toBeGreaterThan(0);
    expect(problemas.join('\n')).toContain(texto);
  });

  it('una barra final en FRONTEND_URL se tolera (app.config la quita); TRUST_PROXY_HOPS vacío también', () => {
    expect(
      validarEntorno({ ...PRODUCCION_VALIDA, FRONTEND_URL: 'https://app.tienda.com/' }, true),
    ).toEqual([]);
    expect(validarEntorno({ ...PRODUCCION_VALIDA, TRUST_PROXY_HOPS: '' }, true)).toEqual([]);
    expect(validarEntorno({ ...PRODUCCION_VALIDA, TRUST_PROXY_HOPS: '1' }, true)).toEqual([]);
  });

  it('lista TODO junto, no una variable por arranque fallido', () => {
    const problemas = validarEntorno(
      { NODE_ENV: 'production', JWT_SECRET: 'secret-key', KIOSKO_QR_SECRET: SECRETO_B },
      true,
    );
    expect(problemas.length).toBeGreaterThanOrEqual(8);
    const mensaje = mensajeDeEntornoInvalido(problemas);
    expect(mensaje).toContain(`Entorno inválido (${problemas.length})`);
    for (const v of [
      'JWT_SECRET',
      'AGENT_API_KEY',
      'DATABASE_URL',
      'FRONTEND_URL',
      'SMTP_HOST',
      'AWS_S3_BUCKET',
    ]) {
      expect(mensaje).toContain(v);
    }
  });
});
