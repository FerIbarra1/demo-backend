import { CatalogoService } from './catalogo.service';

/**
 * Fase 0 (sep 2026): el tope del slider de precios debe salir de la lista del
 * cliente, no de `precioBase` (que es sinónimo de lista1).
 *
 * El bug que estos tests previenen: un cliente de lista 6 (la más barata)
 * recibía un slider calibrado con precios de lista 1, así que el rango no
 * correspondía a nada de lo que veía en pantalla.
 */

/**
 * Prisma falso que registra los `aggregate` y devuelve máximos distintos según
 * la mitad de la consulta: `conLista` (filas con la lista capturada, `gt: 0`) o
 * `sinLista` (filas sin capturar, `lte: 0`). Distinguirlas es el punto del
 * código bajo prueba: agregar ambas mitades juntas daría un tope inflado.
 */
function crearPrismaFalso(maximos: {
  conLista?: Record<string, number | null>;
  sinLista?: Record<string, number | null>;
}) {
  const llamadas: Array<{ modelo: string; where: any }> = [];

  const agregado = (modelo: string) => (args: any) => {
    llamadas.push({ modelo, where: args.where });
    const campo = Object.keys(args._max)[0];
    // La mitad se decide por el filtro sobre la columna de lista.
    const esConLista = Object.values(args.where).some(
      (v: any) => v && typeof v === 'object' && 'gt' in v,
    );
    const fuente = esConLista ? maximos.conLista : maximos.sinLista;
    return Promise.resolve({ _max: { [campo]: fuente?.[campo] ?? null } });
  };

  return {
    prisma: {
      precioCO: { aggregate: agregado('precioCO') },
      precio: { aggregate: agregado('precio') },
      producto: { groupBy: () => Promise.resolve([]) },
      corrida: { findMany: () => Promise.resolve([]) },
      color: { findMany: () => Promise.resolve([]) },
    } as any,
    llamadas,
  };
}

function crearServicio(prisma: any, columna: string) {
  const precios = {
    columnaParaUsuario: () => Promise.resolve(columna),
  } as any;
  return new CatalogoService(prisma, {} as any, precios);
}

describe('CatalogoService.obtenerFiltrosDisponibles — precioMaximo por lista', () => {
  it('usa el máximo de la lista del cliente, no el precio base', async () => {
    // Todas las filas tienen lista6 capturada, así que la mitad "sin lista" no
    // aporta nada (null). El precio base de esas filas sería 100, y si el
    // código lo mezclara el tope saldría 100 en vez de 90.
    const { prisma } = crearPrismaFalso({
      conLista: { lista6: 90 },
      sinLista: { precio: null, precioBase: null },
    });
    const svc = crearServicio(prisma, 'lista6');

    const res = await svc.obtenerFiltrosDisponibles(1, 42);

    expect(res.precioMaximo).toBe(90);
  });

  it('cae al precio base de las filas sin lista capturada', async () => {
    // Ninguna fila tiene lista6: el fallback es `precio`/`precioBase`.
    const { prisma } = crearPrismaFalso({
      conLista: { lista6: null },
      sinLista: { precio: 130, precioBase: 100 },
    });
    const svc = crearServicio(prisma, 'lista6');

    const res = await svc.obtenerFiltrosDisponibles(1, 42);

    expect(res.precioMaximo).toBe(130);
  });

  it('sin usuario cae a lista1 (comportamiento del catálogo público)', async () => {
    const { prisma, llamadas } = crearPrismaFalso({
      conLista: { lista1: 100 },
      sinLista: { precio: null, precioBase: 100 },
    });
    const svc = crearServicio(prisma, 'lista1');

    const res = await svc.obtenerFiltrosDisponibles(1);

    expect(res.precioMaximo).toBe(100);
    // Cada mitad se agrega con su propio `where`: tomar MAX(listaN) y MAX(precio)
    // sobre TODAS las filas daría un tope inflado.
    const conLista = llamadas.filter((l) => l.where.lista1?.gt !== undefined);
    const sinLista = llamadas.filter((l) => l.where.lista1?.lte !== undefined);
    expect(conLista.length).toBeGreaterThan(0);
    expect(sinLista.length).toBeGreaterThan(0);
  });

  it('devuelve 0 cuando no hay precios', async () => {
    const { prisma } = crearPrismaFalso({
      conLista: { lista1: null },
      sinLista: { precio: null, precioBase: null },
    });
    const svc = crearServicio(prisma, 'lista1');

    const res = await svc.obtenerFiltrosDisponibles(1, 42);

    expect(res.precioMaximo).toBe(0);
  });
});
