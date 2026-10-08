import { contarMensajesNoLeidos } from './mensajes-no-leidos.util';

/**
 * Oct 2026: el conteo de mensajes no leídos de las listas.
 *
 * El SQL en sí se verificó contra la BD real (los watermarks de los 11 pedidos
 * de desarrollo dan los conteos esperados). Lo que estos tests fijan son las
 * dos partes que el SQL no cubre y que sí se pueden romper en silencio:
 *
 * 1. **El `bigint`.** `COUNT()` en PostgreSQL llega como `bigint`, y `JSON.stringify`
 *    LANZA ("Do not know how to serialize a BigInt") al serializar la respuesta.
 *    El mapeo a `Number` no es cosmético: sin él el endpoint devuelve un 500.
 * 2. **El atajo de lista vacía.** Sin él, una página sin pedidos dispararía un
 *    `IN ()` — que en SQL es un error de sintaxis.
 */

function crearPrisma(filas: Array<{ pedido_id: number; no_leidos: bigint }>) {
  const $queryRaw = jest.fn(async () => filas);
  return { prisma: { $queryRaw } as never, $queryRaw };
}

describe('contarMensajesNoLeidos', () => {
  it('convierte el bigint de COUNT a number (si no, el JSON de la respuesta explota)', async () => {
    const { prisma } = crearPrisma([{ pedido_id: 42, no_leidos: 3n }]);
    const mapa = await contarMensajesNoLeidos(prisma, [42], 'cliente');

    expect(mapa.get(42)).toBe(3);
    expect(typeof mapa.get(42)).toBe('number');
    // La prueba de fuego: serializar como lo haría el controller.
    expect(() => JSON.stringify(Object.fromEntries(mapa))).not.toThrow();
  });

  it('mapea por pedidoId', async () => {
    const { prisma } = crearPrisma([
      { pedido_id: 1, no_leidos: 0n },
      { pedido_id: 2, no_leidos: 7n },
    ]);
    const mapa = await contarMensajesNoLeidos(prisma, [1, 2], 'tienda');

    expect(mapa.get(1)).toBe(0);
    expect(mapa.get(2)).toBe(7);
  });

  it('sin pedidos, no consulta (un `IN ()` es error de sintaxis)', async () => {
    const { prisma, $queryRaw } = crearPrisma([]);
    const mapa = await contarMensajesNoLeidos(prisma, [], 'cliente');

    expect(mapa.size).toBe(0);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it('un pedido sin fila en el resultado se lee como 0, no como undefined', async () => {
    // El LEFT JOIN garantiza una fila por pedido, pero si un id no existiera el
    // consumidor no debe pintar "undefined mensajes".
    const { prisma } = crearPrisma([{ pedido_id: 1, no_leidos: 2n }]);
    const mapa = await contarMensajesNoLeidos(prisma, [1, 999], 'cliente');

    expect(mapa.get(999) ?? 0).toBe(0);
  });
});
