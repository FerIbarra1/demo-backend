import { CanalOrigen, EstadoPedido } from '@prisma/client';
import {
  ESTADOS_BOLSA_APARTADA,
  ESTADOS_ESPERA_CLIENTE,
  ORDEN_COLA,
  clientePresenteEnTienda,
  minutosEsperando,
  whereAusente,
  wherePresente,
} from './presencia.util';

/**
 * F22 (oct 2026): "¿el cliente está en la tienda?" — UNA sola respuesta para la
 * cola, la consola, la TV, `llamarSiguiente` y bodega.
 */
describe('clientePresenteEnTienda', () => {
  const ahora = new Date();

  it('KIOSKO está presente: el pedido se hizo con el cliente en la tienda', () => {
    expect(
      clientePresenteEnTienda({
        canalOrigen: 'KIOSKO',
        llegadaAnunciadaAt: null,
        llegadaDescartadaAt: null,
      }),
    ).toBe(true);
  });

  it('KIOSKO descartado NO está presente (el cliente se fue)', () => {
    // El hueco que esto cierra: descartar exigía `llegadaAnunciadaAt`, que un
    // kiosko nunca tiene, y el gate decía "KIOSKO siempre visible". Un cliente de
    // kiosko que se iba no tenía forma de salir de la cola ni de la TV.
    expect(
      clientePresenteEnTienda({
        canalOrigen: 'KIOSKO',
        llegadaAnunciadaAt: null,
        llegadaDescartadaAt: ahora,
      }),
    ).toBe(false);
  });

  it('WEB con aviso vigente está presente', () => {
    expect(
      clientePresenteEnTienda({
        canalOrigen: 'WEB',
        llegadaAnunciadaAt: ahora,
        llegadaDescartadaAt: null,
      }),
    ).toBe(true);
  });

  it('WEB sin aviso no está presente: podría estar en su casa', () => {
    expect(
      clientePresenteEnTienda({
        canalOrigen: 'WEB',
        llegadaAnunciadaAt: null,
        llegadaDescartadaAt: null,
      }),
    ).toBe(false);
  });

  it('WEB con aviso descartado no está presente', () => {
    expect(
      clientePresenteEnTienda({
        canalOrigen: 'WEB',
        llegadaAnunciadaAt: ahora,
        llegadaDescartadaAt: ahora,
      }),
    ).toBe(false);
  });
});

describe('wherePresente / whereAusente son complementarios', () => {
  it('wherePresente: sin descarte Y (kiosko O web con aviso)', () => {
    expect(wherePresente()).toEqual({
      llegadaDescartadaAt: null,
      OR: [
        { canalOrigen: CanalOrigen.KIOSKO },
        { canalOrigen: CanalOrigen.WEB, llegadaAnunciadaAt: { not: null } },
      ],
    });
  });

  it('whereAusente: descartado (cualquier canal) O web que nunca avisó', () => {
    expect(whereAusente()).toEqual({
      OR: [
        { llegadaDescartadaAt: { not: null } },
        { canalOrigen: CanalOrigen.WEB, llegadaAnunciadaAt: null },
      ],
    });
  });

  /**
   * Los dos `where` de Prisma tienen que decir lo MISMO que la función en memoria.
   * Se evalúan a mano sobre una matriz de casos: si alguien cambia uno y no el otro,
   * un pedido deja de estar en "Por revisar" y también de estar en "Sin aviso", y
   * desaparece de la consola.
   */
  type Fila = {
    canalOrigen: string;
    llegadaAnunciadaAt: Date | null;
    llegadaDescartadaAt: Date | null;
  };
  const evaluaPresente = (f: Fila) =>
    f.llegadaDescartadaAt === null &&
    (f.canalOrigen === 'KIOSKO' || (f.canalOrigen === 'WEB' && f.llegadaAnunciadaAt !== null));
  const evaluaAusente = (f: Fila) =>
    f.llegadaDescartadaAt !== null || (f.canalOrigen === 'WEB' && f.llegadaAnunciadaAt === null);

  const t = new Date();
  const casos: Fila[] = [];
  for (const canalOrigen of ['KIOSKO', 'WEB']) {
    for (const llegadaAnunciadaAt of [null, t]) {
      for (const llegadaDescartadaAt of [null, t]) {
        casos.push({ canalOrigen, llegadaAnunciadaAt, llegadaDescartadaAt });
      }
    }
  }

  it.each(casos.map((c) => [JSON.stringify(c), c] as const))(
    'ningún pedido cae en los dos ni en ninguno: %s',
    (_n, fila) => {
      expect(evaluaPresente(fila)).toBe(clientePresenteEnTienda(fila));
      // Presente XOR ausente: todo pedido apartado está en exactamente una lista.
      expect(evaluaPresente(fila)).not.toBe(evaluaAusente(fila));
    },
  );
});

describe('ORDEN_COLA — primero llegado, primero atendido', () => {
  it('ordena por presenteDesdeAt, no por el aviso', () => {
    // El orden viejo era `llegadaAnunciadaAt nulls last`: un pedido de kiosko no
    // tiene aviso, así que TODO web con aviso pasaba delante de cualquier kiosko
    // aunque el kiosko llevara media hora esperando.
    expect(ORDEN_COLA[0]).toEqual({ presenteDesdeAt: { sort: 'asc', nulls: 'last' } });
    expect(JSON.stringify(ORDEN_COLA)).not.toContain('llegadaAnunciadaAt');
  });

  it('desempata por fecha de pedido y por id (orden total y estable)', () => {
    expect(ORDEN_COLA.slice(1)).toEqual([{ fechaPedido: 'asc' }, { id: 'asc' }]);
  });
});

describe('minutosEsperando', () => {
  const fechaPedido = new Date(Date.now() - 5 * 3_600_000);
  const hace30 = new Date(Date.now() - 30 * 60_000);

  it('kiosko: cuenta desde que el cliente empezó a esperar (presenteDesdeAt)', () => {
    expect(
      minutosEsperando({
        canalOrigen: 'KIOSKO',
        llegadaAnunciadaAt: null,
        llegadaDescartadaAt: null,
        presenteDesdeAt: hace30,
        fechaPedido,
      }),
    ).toBe(30);
  });

  it('web: cuenta desde su aviso', () => {
    expect(
      minutosEsperando({
        canalOrigen: 'WEB',
        llegadaAnunciadaAt: hace30,
        llegadaDescartadaAt: null,
        presenteDesdeAt: hace30,
        fechaPedido,
      }),
    ).toBe(30);
  });

  it('un cliente que no está presente no está "esperando": null', () => {
    expect(
      minutosEsperando({
        canalOrigen: 'WEB',
        llegadaAnunciadaAt: hace30,
        llegadaDescartadaAt: new Date(),
        presenteDesdeAt: hace30,
        fechaPedido,
      }),
    ).toBeNull();
    expect(
      minutosEsperando({
        canalOrigen: 'WEB',
        llegadaAnunciadaAt: null,
        llegadaDescartadaAt: null,
        presenteDesdeAt: null,
        fechaPedido,
      }),
    ).toBeNull();
  });
});

describe('grupos de estados', () => {
  it('la espera del cliente es REVISADO y ESPERANDO_APROBACION', () => {
    expect([...ESTADOS_ESPERA_CLIENTE].sort()).toEqual(
      [EstadoPedido.REVISADO, EstadoPedido.ESPERANDO_APROBACION].sort(),
    );
  });

  it('la bolsa apartada suma EN_ATENCION (ya lo llamaron, sigue siendo la misma espera)', () => {
    expect(ESTADOS_BOLSA_APARTADA).toContain(EstadoPedido.EN_ATENCION);
    for (const e of ESTADOS_ESPERA_CLIENTE) expect(ESTADOS_BOLSA_APARTADA).toContain(e);
  });
});
