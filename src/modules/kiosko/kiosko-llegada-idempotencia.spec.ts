import { CanalLlegada, EstadoPedido, ModoEntrega } from '@prisma/client';
import { KioskoLlegadaService } from './kiosko-llegada.service';

/**
 * Oct 2026: al extraer `registrarAviso` (la escritura compartida por los tres
 * caminos: kiosko, app del cliente y mostrador) hay que respetar el contrato
 * de `reanudado`, que los specs de `kiosko-llegada.service.spec.ts` ya fijan:
 *
 *   `reanudado: true`  → el aviso se RE-EMITIÓ (realtime disparado).
 *   `reanudado: false` → el guard de idempotencia lo suprimió: era el mismo
 *                        aviso otra vez, sin descarte de por medio.
 *
 * El flag elige el copy: con `false` el cliente ve "Ya avisamos al equipo" en
 * vez del mensaje del estado, porque no pasó nada nuevo. Un aviso DESCARTADO
 * por el operador siempre se re-emite (el cliente tiene que poder re-avisar de
 * inmediato), así que también es `true`.
 */
function crearServicio(pedido: Record<string, unknown>) {
  const update = jest
    .fn()
    .mockImplementation(({ data }) => Promise.resolve({ ...pedido, ...data }));
  const emitToTienda = jest.fn();
  const emitToPedido = jest.fn();

  const prisma = {
    pedido: { findUnique: jest.fn().mockResolvedValue(pedido), update },
    historialPedido: { create: jest.fn().mockResolvedValue({}) },
  };

  const svc = new KioskoLlegadaService(
    prisma as never,
    {} as never, // kioskoService
    { emitToTienda, emitToPedido } as never,
    { get: () => 'secreto-de-prueba-de-32-caracteres-minimo' } as never,
  );

  return { svc, emitToTienda, emitToPedido };
}

/**
 * `emitToTienda` recibe DOS eventos distintos, así que filtrar por "fue
 * llamado" mezcla el aviso con la invalidación del monitor. Estos helpers
 * separan los dos para poder afirmar sobre cada uno.
 */
function avisos(tienda: jest.Mock) {
  return tienda.mock.calls.filter(([, evento]) => evento === 'pedido.llegada-anunciada');
}
function invalidaciones(tienda: jest.Mock) {
  return tienda.mock.calls.filter(([, evento]) => evento === 'monitor.invalidado');
}

const base = {
  id: 1,
  tiendaId: 5,
  numeroPedido: 'PD-2026-000123',
  clienteNombre: 'Juan Pérez',
  estado: EstadoPedido.EN_MOSTRADOR,
  modoEntrega: ModoEntrega.RECOGER_TIENDA,
  llegadaAnunciadaAt: null,
  llegadaUltimoAvisoAt: null,
  llegadaAnunciadaCount: 0,
  llegadaUltimaEmisionAt: null,
  llegadaDescartadaAt: null,
  tienda: { nombre: 'Centro' },
};

const usuario = {
  userId: 3,
  nombre: 'Ana Mostrador',
  rol: 'MOSTRADOR' as never,
  tiendaId: 5,
};

describe('registrarAviso — el contrato de reanudado', () => {
  it('primer aviso: se emite y es reanudado (no se suprimió)', async () => {
    const { svc, emitToTienda } = crearServicio({ ...base });

    const r = await svc.confirmarDesdeMostrador(1, usuario);

    expect(r.reanudado).toBe(true);
    expect(avisos(emitToTienda)).toHaveLength(1);
    expect(avisos(emitToTienda)[0][2]).toEqual(
      expect.objectContaining({ canal: CanalLlegada.MOSTRADOR }),
    );
    // Y la TV/consola recomputan, porque el pedido acaba de entrar a la cola.
    expect(invalidaciones(emitToTienda)).toHaveLength(1);
  });

  it('aviso repetido dentro de los 60s: se suprime y NO es reanudado', async () => {
    const hace10s = new Date(Date.now() - 10_000);
    const { svc, emitToTienda } = crearServicio({
      ...base,
      llegadaAnunciadaAt: hace10s,
      llegadaUltimoAvisoAt: hace10s,
      llegadaAnunciadaCount: 1,
      llegadaUltimaEmisionAt: hace10s,
    });

    const r = await svc.confirmarDesdeMostrador(1, usuario);

    expect(r.reanudado).toBe(false);
    expect(avisos(emitToTienda)).toHaveLength(0);
    // Tampoco se invalida el monitor: nada cambió.
    expect(invalidaciones(emitToTienda)).toHaveLength(0);
  });

  it('aviso repetido DESPUÉS de los 60s: se re-emite', async () => {
    const hace2min = new Date(Date.now() - 2 * 60_000);
    const { svc, emitToTienda } = crearServicio({
      ...base,
      llegadaAnunciadaAt: hace2min,
      llegadaUltimoAvisoAt: hace2min,
      llegadaAnunciadaCount: 1,
      llegadaUltimaEmisionAt: hace2min,
    });

    const r = await svc.confirmarDesdeMostrador(1, usuario);

    expect(r.reanudado).toBe(true);
    expect(avisos(emitToTienda)).toHaveLength(1);
  });

  it('un aviso descartado se re-emite de inmediato', async () => {
    // El descarte lo hizo el operador porque el cliente no estaba, así que
    // hacerlo esperar la ventana lo dejaría sin forma de re-avisar. Este es el
    // camino que más importa desde mostrador: el operador descarta y el cliente
    // vuelve a aparecer.
    const hace10s = new Date(Date.now() - 10_000);
    const { svc, emitToTienda } = crearServicio({
      ...base,
      llegadaAnunciadaAt: hace10s,
      llegadaUltimoAvisoAt: hace10s,
      llegadaAnunciadaCount: 1,
      llegadaUltimaEmisionAt: hace10s,
      llegadaDescartadaAt: new Date(),
    });

    const r = await svc.confirmarDesdeMostrador(1, usuario);

    expect(r.reanudado).toBe(true);
    expect(avisos(emitToTienda)).toHaveLength(1);
  });

  it('marcar desde mostrador escribe el canal y el autor', async () => {
    const { svc } = crearServicio({ ...base });
    const prisma = (svc as never as { prisma: { pedido: { update: jest.Mock } } }).prisma;

    await svc.confirmarDesdeMostrador(1, usuario);

    expect(prisma.pedido.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          llegadaAnunciadaCanal: CanalLlegada.MOSTRADOR,
          llegadaAnunciadaPor: 'Ana Mostrador',
          llegadaAnunciadaKioskoId: null,
        }),
      }),
    );
  });

  it('rechaza un pedido que no está listo para revisarse', async () => {
    const { svc, emitToTienda } = crearServicio({
      ...base,
      estado: EstadoPedido.REVIEWING,
    });

    await expect(svc.confirmarDesdeMostrador(1, usuario)).rejects.toThrow(/preparando tu pedido/i);
    expect(emitToTienda).not.toHaveBeenCalled();
  });
});
