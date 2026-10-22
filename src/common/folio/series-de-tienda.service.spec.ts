import { SeriesDeTiendaService, TTL_SERIES_MS } from './series-de-tienda.service';

function crear(filas: Array<{ id: number; serie: string | null }>) {
  const findMany = jest.fn().mockResolvedValue(filas);
  const svc = new SeriesDeTiendaService({ tienda: { findMany } } as never);
  return { svc, findMany };
}

describe('SeriesDeTiendaService', () => {
  it('lee las series una vez y las sirve de memoria', async () => {
    const { svc, findMany } = crear([
      { id: 1, serie: 'HMO' },
      { id: 2, serie: null },
    ]);
    await svc.cargar();
    await svc.cargar();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(svc.serieDe(1)).toBe('HMO');
    expect(svc.serieDe(2)).toBeNull();
    expect(svc.serieDe(99)).toBeUndefined();
  });

  it('varias respuestas a la vez comparten UNA lectura', async () => {
    const { svc, findMany } = crear([{ id: 1, serie: 'HMO' }]);
    await Promise.all([svc.cargar(), svc.cargar(), svc.cargar()]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('se refresca al vencer el TTL: una serie nueva se ve sin reiniciar', async () => {
    const { svc, findMany } = crear([{ id: 1, serie: 'HMO' }]);
    await svc.cargar();
    await svc.cargar(Date.now() + TTL_SERIES_MS + 1);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('invalidar fuerza la siguiente lectura', async () => {
    const { svc, findMany } = crear([{ id: 1, serie: 'HMO' }]);
    await svc.cargar();
    svc.invalidar();
    await svc.cargar();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('si la lectura falla, el siguiente intento vuelve a probar (no se queda atascado)', async () => {
    const findMany = jest
      .fn()
      .mockRejectedValueOnce(new Error('BD caída'))
      .mockResolvedValue([{ id: 1, serie: 'HMO' }]);
    const svc = new SeriesDeTiendaService({ tienda: { findMany } } as never);
    await expect(svc.cargar()).rejects.toThrow('BD caída');
    await svc.cargar();
    expect(svc.serieDe(1)).toBe('HMO');
  });
});
