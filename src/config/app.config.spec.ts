import appConfig from './app.config';

/**
 * Lo que `app.config` deriva del entorno y el arranque da por hecho. Se llama a la fábrica con `process.env` acotado
 * (y se restaura): son reglas que un valor mal escrito en el servidor rompe en silencio.
 */
const CLAVES = [
  'TRUST_PROXY_HOPS',
  'FRONTEND_URL',
  'NODE_ENV',
  'DTF_PREFLIGHT_MEMORIA_MB',
] as const;
const guardado: Record<string, string | undefined> = {};

const restaurar = () => {
  for (const k of CLAVES) {
    if (guardado[k] === undefined) delete process.env[k];
    else process.env[k] = guardado[k];
  }
};

beforeEach(() => CLAVES.forEach((k) => (guardado[k] = process.env[k])));
afterEach(restaurar);

const cargar = (env: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return appConfig();
};

describe('app.config: proxies delante (TRUST_PROXY_HOPS)', () => {
  it.each([
    [
      'producción sin variable → 1 (nginx)',
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: undefined },
      1,
    ],
    ['desarrollo sin variable → 0', { NODE_ENV: 'development', TRUST_PROXY_HOPS: undefined }, 0],
    [
      'producción con la variable VACÍA → el defecto (antes: NaN → 0 sin avisar)',
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '' },
      1,
    ],
    [
      'producción con solo espacios → el defecto',
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '  ' },
      1,
    ],
    ['valor explícito 2', { NODE_ENV: 'production', TRUST_PROXY_HOPS: '2' }, 2],
    ['valor explícito 0 (sin proxy)', { NODE_ENV: 'production', TRUST_PROXY_HOPS: '0' }, 0],
    ['basura → el defecto, nunca NaN', { NODE_ENV: 'production', TRUST_PROXY_HOPS: 'uno' }, 1],
    ['negativo → el defecto', { NODE_ENV: 'production', TRUST_PROXY_HOPS: '-3' }, 1],
  ])('%s', (_n, env, esperado) => {
    expect(cargar(env).trustProxyHops).toBe(esperado);
  });
});

describe('app.config: origen del frontend (CORS y enlaces de los correos)', () => {
  it('quita las barras finales: el `Origin` del navegador nunca las lleva y se compara tal cual', () => {
    const c = cargar({ FRONTEND_URL: 'https://app.tienda.com/' });
    expect(c.corsOrigins).toEqual(['https://app.tienda.com']);
    expect(c.mail.frontendUrl).toBe('https://app.tienda.com');
    expect(cargar({ FRONTEND_URL: ' https://app.tienda.com// ' }).corsOrigins).toEqual([
      'https://app.tienda.com',
    ]);
  });

  it('sin variable cae al front local de desarrollo', () => {
    expect(cargar({ FRONTEND_URL: undefined }).corsOrigins).toEqual(['http://localhost:3001']);
  });
});

describe('app.config: memoria del preflight DTF (DTF_PREFLIGHT_MEMORIA_MB)', () => {
  it.each([
    ['sin variable → 2048 MB', undefined, 2048],
    ['256 (un contenedor de 512 MB)', '256', 256],
    ['vacía o basura → el defecto, nunca NaN ni 0', 'mucha', 2048],
    ['cero o negativa → el defecto', '0', 2048],
  ])('%s', (_n, valor, esperado) => {
    expect(cargar({ DTF_PREFLIGHT_MEMORIA_MB: valor }).dtf.preflightMemoriaMb).toBe(esperado);
  });
});
