import { EstadoPagoTransferencia, EstadoPedido, ModoEntrega } from '@prisma/client';
import {
  WHERE_LLAMABLE,
  esNoCobrar,
  esperandoValidacion,
  ordenarFilaDeCaja,
  whereFilaDeCaja,
} from './cola-caja.util';

/**
 * Oct 2026: el orden de la fila de caja. Lo comparten la consola, "Llamar siguiente" y la TV, así
 * que si esto se equivoca, las tres se equivocan igual — por eso se fija aquí, sin base de datos.
 */

const min = (n: number) => new Date(Date.UTC(2026, 9, 16, 12, 0, 0) + n * 60_000);

function fila(
  id: number,
  o: {
    pedido?: number; // minuto en que se HIZO el pedido
    cola?: number | null; // minuto en que llegó a la fila de caja
    verificada?: number; // minuto en que Tesorería verificó la transferencia
    enProceso?: boolean; // transferencia PENDIENTE / EN_REVISION: no se cobra
    espera?: number; // minuto en que la cajera la regresó "hasta que se valide"
  } = {},
) {
  return {
    id,
    fechaPedido: min(o.pedido ?? 0),
    colaCajaDesdeAt: o.cola === null ? null : min(o.cola ?? 0),
    esperaValidacionDesdeAt: o.espera !== undefined ? min(o.espera) : null,
    pagosTransferencia:
      o.verificada !== undefined
        ? [{ estado: EstadoPagoTransferencia.VERIFICADO, verificadoAt: min(o.verificada) }]
        : o.enProceso
          ? [{ estado: EstadoPagoTransferencia.PENDIENTE, verificadoAt: null }]
          : [],
  };
}

const ids = (filas: Array<{ id: number }>) => filas.map((f) => f.id);

describe('whereFilaDeCaja / WHERE_LLAMABLE', () => {
  it('la fila son los PENDIENTE_PAGO sin ventanilla y que se cobran en tienda', () => {
    expect(whereFilaDeCaja(5)).toEqual({
      estado: EstadoPedido.PENDIENTE_PAGO,
      cajeroAsignadoId: null,
      modoEntrega: { not: ModoEntrega.DOMICILIO },
      tiendaId: 5,
    });
  });

  it('sin tienda no filtra por tienda (el ADMIN sin tienda ve todas)', () => {
    expect(whereFilaDeCaja()).not.toHaveProperty('tiendaId');
  });

  it('lo llamable excluye SOLO lo regresado "hasta que se valide" que sigue sin verificar', () => {
    // Las DOS condiciones juntas: con una transferencia sin verificar a secas SÍ se llama (16-oct:
    // llegan clientes que necesitan ayuda para transferir); la marca sola, con la transferencia ya
    // verificada, tampoco excluye — la marca no necesita limpiarse.
    expect(WHERE_LLAMABLE).toEqual({
      NOT: {
        esperaValidacionDesdeAt: { not: null },
        pagosTransferencia: {
          some: {
            estado: {
              in: [EstadoPagoTransferencia.PENDIENTE, EstadoPagoTransferencia.EN_REVISION],
            },
          },
        },
      },
    });
  });
});

describe('ordenarFilaDeCaja — primero llegado a CAJA, primero atendido', () => {
  it('ordena por cuándo llegó a la fila, NO por cuándo se hizo el pedido', () => {
    // El pedido web se hizo a las 9:00 (minuto 0) pero mostrador lo mandó a pagar a las 11:10
    // (minuto 130); el de kiosko se hizo a las 10:50 y llegó a caja a las 11:05 (minuto 125).
    const web = fila(1, { pedido: 0, cola: 130 });
    const kiosko = fila(2, { pedido: 110, cola: 125 });
    expect(ids(ordenarFilaDeCaja([web, kiosko]))).toEqual([2, 1]);
  });

  it('un pedido anterior a la columna (sin colaCajaDesdeAt) cae a la fecha del pedido', () => {
    const viejo = fila(1, { pedido: 10, cola: null });
    const nuevo = fila(2, { pedido: 5, cola: 50 });
    expect(ids(ordenarFilaDeCaja([nuevo, viejo]))).toEqual([1, 2]);
  });

  it('devolver a la cola conserva el lugar: la hora de la fila no cambia', () => {
    // Caja suelta el pedido 1 (llegó al minuto 10) y el 2 (minuto 20) sigue esperando.
    expect(ids(ordenarFilaDeCaja([fila(2, { cola: 20 }), fila(1, { cola: 10 })]))).toEqual([1, 2]);
  });

  it('"No se presentó" lo manda al final: su hora de fila pasa a ser ahora', () => {
    const ausente = fila(1, { cola: 10 });
    const esperando = fila(2, { cola: 20 });
    expect(ids(ordenarFilaDeCaja([ausente, esperando]))[0]).toBe(1); // antes: otra vez primero
    const tras = { ...ausente, colaCajaDesdeAt: min(60) };
    expect(ids(ordenarFilaDeCaja([tras, esperando]))).toEqual([2, 1]);
  });

  it('el empate se resuelve por id, siempre igual', () => {
    expect(ids(ordenarFilaDeCaja([fila(9), fila(3), fila(5)]))).toEqual([3, 5, 9]);
  });

  it('no muta la lista que recibe', () => {
    const entrada = [fila(2, { cola: 20 }), fila(1, { cola: 10 })];
    ordenarFilaDeCaja(entrada);
    expect(ids(entrada)).toEqual([2, 1]);
  });
});

describe('ordenarFilaDeCaja — NADIE pasa adelante: orden estricto de llegada', () => {
  it('una transferencia verificada NO pasa delante de quien llegó antes (16-oct: misma importancia)', () => {
    // Antes las verificadas se atendían primero. El dueño pidió orden de llegada para todos.
    const efectivo = fila(1, { cola: 0 });
    const transferencia = fila(2, { cola: 5, verificada: 30 });
    expect(ids(ordenarFilaDeCaja([transferencia, efectivo]))).toEqual([1, 2]);
  });

  it('si llegó ANTES, la verificada va primero — por su llegada, no por haber pagado', () => {
    const verificada = fila(1, { cola: 0, verificada: 50 });
    const efectivo = fila(2, { cola: 10 });
    expect(ids(ordenarFilaDeCaja([efectivo, verificada]))).toEqual([1, 2]);
  });

  it('"No se presentó" la manda al final aunque ya esté verificada: no hay prioridad que la devuelva al frente', () => {
    // Verificada, llamada, no se presentó → cola = 40 (ahora). Con la prioridad vieja encabezaba la fila para siempre.
    const ausente = fila(1, { cola: 40, verificada: 30 });
    const esperando = fila(2, { cola: 20 });
    expect(ids(ordenarFilaDeCaja([ausente, esperando]))).toEqual([2, 1]);
  });

  it('regresarla "hasta que se valide" conserva el lugar: al verificarse sigue delante de quien llegó después', () => {
    const regresada = fila(1, { cola: 0, verificada: 55, espera: 8 });
    const despues = fila(2, { cola: 10 });
    expect(ids(ordenarFilaDeCaja([despues, regresada]))).toEqual([1, 2]);
  });
});

describe('ordenarFilaDeCaja — la transferencia sin verificar entra EN SU LUGAR de llegada', () => {
  it('no se manda al final: se atiende por orden de llegada, con la misma importancia', () => {
    // 16-oct: antes iba al final de la lista y "Llamar siguiente" la saltaba. Pero el cliente que
    // necesita ayuda para transferir (o a quien le va a pagar un tercero) llega a ventanilla igual.
    const enProceso = fila(1, { cola: 0, enProceso: true });
    const efectivoA = fila(2, { cola: 10 });
    const efectivoB = fila(3, { cola: 20 });
    expect(esNoCobrar(enProceso)).toBe(true);
    expect(ids(ordenarFilaDeCaja([efectivoB, enProceso, efectivoA]))).toEqual([1, 2, 3]);
  });

  it('el orden es SOLO la llegada, paguen como paguen', () => {
    const lista = ordenarFilaDeCaja([
      fila(1, { cola: 0, enProceso: true }),
      fila(2, { cola: 30 }),
      fila(3, { cola: 5, verificada: 50 }),
      fila(4, { cola: 10 }),
    ]);
    expect(ids(lista)).toEqual([1, 3, 4, 2]);
  });

  it('un pedido de efectivo no es "no cobrar"', () => {
    expect(esNoCobrar(fila(1))).toBe(false);
  });
});

describe('esperandoValidacion — lo que "Llamar siguiente" salta', () => {
  it('con la marca y la transferencia sin verificar: sí', () => {
    expect(esperandoValidacion(fila(1, { enProceso: true, espera: 5 }))).toBe(true);
  });

  it('sin la marca, una transferencia sin verificar se llama normal', () => {
    expect(esperandoValidacion(fila(1, { enProceso: true }))).toBe(false);
  });

  it('con la marca pero YA verificada: deja de esperar sola, sin limpiar nada', () => {
    expect(esperandoValidacion(fila(1, { verificada: 30, espera: 5 }))).toBe(false);
  });

  it('con la marca pero sin transferencia viva (se canceló o venció): se llama normal', () => {
    expect(esperandoValidacion(fila(1, { espera: 5 }))).toBe(false);
  });

  it('regresarla no la mueve de lugar: sigue ordenada por su llegada', () => {
    const regresada = fila(1, { cola: 0, enProceso: true, espera: 8 });
    const otra = fila(2, { cola: 10 });
    expect(ids(ordenarFilaDeCaja([otra, regresada]))).toEqual([1, 2]);
  });
});
