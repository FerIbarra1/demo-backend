import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * PLAN-ADMIN-MULTITIENDA §4.1 y §7 (oct 2026): el contrato que evita el IDOR por omisión.
 *
 * `tienda-consola.http.spec.ts` prueba los endpoints que YA están en su tabla. Este spec cubre el que
 * NO está todavía: un controller nuevo que lea `user.tiendaId` a secas (el ADMIN, que no trae tienda
 * en el token, recibiría 500 o —peor— la lista de todas las tiendas), o que lea `?tiendaId=` por su
 * cuenta (otra copia de la regla, y la primera que se olvide de ignorarlo a un empleado abre el IDOR).
 *
 * Lo correcto es `@TiendaConsola()` (común: `tienda-consola.ts`). Lo que de verdad es de OTRA cosa se
 * declara abajo, con su razón: así cada excepción se ve y se discute, en vez de colarse.
 *
 * Es un escaneo del código (como `rutas-con-estacion.spec.ts`): pequeño, rápido y sin levantar Nest.
 */

const RAIZ = join(__dirname, '..', 'modules');

/** Lo que SÍ puede leer `user.tiendaId` directo. Cada línea lleva su porqué. */
const LEE_TIENDA_DEL_TOKEN: Record<string, string> = {
  // `ventanillas/ventanillas-cajero.controller.ts` ya NO está aquí (F3.5, "cubrir puesto"): el ADMIN ocupa
  // una ventanilla de la tienda que opera, así que la tienda sale de `@TiendaConsola()` como en el resto.
  'mostradores/mostradores-operador.controller.ts':
    'Estaciones (D3): el mostrador es del operador de ESA tienda; el ADMIN no lo ocupa (llama sin número, que no asigna). Fuera de alcance del plan.',
  'pedidos/bodega/bodega-monitor.controller.ts':
    'TV de pared (F4): está ligada a su usuario *_MONITOR y a su tienda. La vista del ADMIN se hace en F4.',
  'pedidos/cajero/cajero-monitor.controller.ts': 'TV de pared (F4): igual que la de bodega.',
  'mostrador/mostrador-monitor.controller.ts': 'TV de pared (F4): igual que la de bodega.',
  'favoritos/favoritos.controller.ts':
    'Tienda del CLIENTE (catálogo), no de una consola de empleado.',
  'dtf/dtf.controllers.ts':
    'Lado del CLIENTE del DTF (`tiendaDe`: X-Tienda-Id o la del token, como el catálogo). La consola de Impresión de este mismo archivo resuelve en ImpresionService.tienda().',
};

/** Lo que SÍ puede leer `@Query('tiendaId')` por su cuenta. */
const LEE_TIENDA_DEL_QUERY: Record<string, string> = {
  'pedidos/admin/admin.controller.ts':
    'Listado del panel de ADMIN (el controller es solo ADMIN): un FILTRO opcional (todas las tiendas si se omite), no la tienda de una consola.',
  'dtf/dtf.controllers.ts':
    'Impresión solo reenvía el valor crudo a ImpresionService.tienda(), que delega en resolverTiendaDeConsola: la regla vive en un solo sitio.',
};

const quitarComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

function controllers(dir = RAIZ, acc: string[] = []): string[] {
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) controllers(ruta, acc);
    // `.controllers.ts` también: el módulo DTF agrupa los suyos en `dtf.controllers.ts`.
    else if (/\.controllers?\.ts$/.test(nombre)) acc.push(ruta);
  }
  return acc;
}

const archivos = controllers().map((ruta) => ({
  nombre: relative(RAIZ, ruta).split('\\').join('/'),
  codigo: quitarComentarios(readFileSync(ruta, 'utf8')),
}));

/** `user.tiendaId`, `usuario.tiendaId`, `u.tiendaId`, `req.user.tiendaId`… */
const LEE_TOKEN = /\b(?:user|usuario|u|req\.user|request\.user)\??\.tiendaId\b/;
const LEE_QUERY = /@Query\(\s*['"]tiendaId['"]\s*\)/;

describe('Contrato de la tienda de consola', () => {
  it('hay controllers que revisar', () => {
    expect(archivos.length).toBeGreaterThan(20);
  });

  it('ningún controller de consola lee `user.tiendaId` directo: usa @TiendaConsola()', () => {
    const infractores = archivos
      .filter((a) => LEE_TOKEN.test(a.codigo) && !(a.nombre in LEE_TIENDA_DEL_TOKEN))
      .map((a) => a.nombre);
    expect(infractores).toEqual([]);
  });

  it("ningún controller de consola lee `@Query('tiendaId')` por su cuenta: la función lo hace", () => {
    const infractores = archivos
      .filter((a) => LEE_QUERY.test(a.codigo) && !(a.nombre in LEE_TIENDA_DEL_QUERY))
      .map((a) => a.nombre);
    expect(infractores).toEqual([]);
  });

  it('la lista de excepciones no se pudre: cada una sigue haciendo lo que dice', () => {
    const porNombre = new Map(archivos.map((a) => [a.nombre, a.codigo]));
    const huerfanas = [
      ...Object.keys(LEE_TIENDA_DEL_TOKEN).filter((n) => !LEE_TOKEN.test(porNombre.get(n) ?? '')),
      ...Object.keys(LEE_TIENDA_DEL_QUERY).filter((n) => !LEE_QUERY.test(porNombre.get(n) ?? '')),
    ];
    expect(huerfanas).toEqual([]);
  });
});
