import { referenciaWebDelPrimerCorreo } from './referencia-web';

/**
 * El "Pedido en línea: PD-…" solo va en el PRIMER correo que ya lleva el folio (ver `referencia-web.ts`).
 */
function db(opts: { asignadoAt?: Date | null; solicitud?: boolean; previos?: number }) {
  const count = jest.fn().mockResolvedValue(opts.previos ?? 0);
  return {
    count,
    db: {
      pedidoFolioSolicitud: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            opts.solicitud === false ? null : { asignadoAt: opts.asignadoAt ?? null },
          ),
      },
      notificacion: { count },
    } as never,
  };
}
const pedido = { id: 17310, numeroPedido: 'PD-2026-000018', folioErp: '0000152573' };
const ASIGNADO = new Date('2026-10-19T12:01:00Z');

describe('referenciaWebDelPrimerCorreo', () => {
  it('el primer correo con folio lleva el PD-…', async () => {
    const { db: d, count } = db({ asignadoAt: ASIGNADO, previos: 0 });
    expect(await referenciaWebDelPrimerCorreo(d, pedido)).toBe('PD-2026-000018');
    // Cuenta los correos EXITOSOS desde que se asignó el folio (el de "recibido" es anterior y no cuenta).
    expect(count).toHaveBeenCalledWith({
      where: { pedidoId: 17310, canal: 'EMAIL', exitosa: true, enviadaAt: { gte: ASIGNADO } },
    });
  });

  it('a partir del segundo, no se repite', async () => {
    const { db: d } = db({ asignadoAt: ASIGNADO, previos: 1 });
    expect(await referenciaWebDelPrimerCorreo(d, pedido)).toBeNull();
  });

  it('sin folio todavía no hay nada que unir (ni consulta nada)', async () => {
    const { db: d, count } = db({ asignadoAt: ASIGNADO });
    expect(await referenciaWebDelPrimerCorreo(d, { ...pedido, folioErp: null })).toBeNull();
    expect(count).not.toHaveBeenCalled();
  });

  it('un folio sin fecha de asignación (anterior a la cola de folios) no sabe cuál fue el primero: sin línea', async () => {
    expect(await referenciaWebDelPrimerCorreo(db({ asignadoAt: null }).db, pedido)).toBeNull();
    expect(await referenciaWebDelPrimerCorreo(db({ solicitud: false }).db, pedido)).toBeNull();
  });
});
