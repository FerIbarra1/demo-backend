import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RolUsuario } from '@prisma/client';
import { MostradoresService } from './mostradores.service';

/**
 * F22 (oct 2026): los mostradores físicos de la tienda. Mismas reglas que las
 * ventanillas del cajero: el admin define cuántos hay y el operador elige en cuál
 * trabaja. La TV dice "Pasa al mostrador N" cuando llama a un cliente.
 */

type Mostrador = {
  id: number;
  tiendaId: number;
  numero: number;
  operadorId: number | null;
  activa: boolean;
};

function crearServicio(
  opts: {
    mostradores?: Mostrador[];
    usuario?: Record<string, unknown> | null;
    asignacionCount?: number;
    llamados?: Array<{ id: number }>;
  } = {},
) {
  const mostradores = opts.mostradores ?? [];
  const usuario =
    opts.usuario === undefined
      ? { id: 3, nombre: 'Ana', apellido: 'Ruiz', rol: RolUsuario.MOSTRADOR, tiendaId: 5 }
      : opts.usuario;

  const tx = {
    mostrador: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          mostradores.find(
            (m) =>
              m.tiendaId === where.tiendaId &&
              m.operadorId === where.operadorId &&
              m.id !== where.NOT?.id,
          ) ?? null,
      ),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(async () => ({ count: opts.asignacionCount ?? 1 })),
      findUnique: jest.fn(
        async ({ where }: any) => mostradores.find((m) => m.id === where.id) ?? null,
      ),
    },
  };

  const llamados = opts.llamados ?? [];
  const prisma = {
    // Pedidos que el operador tenía LLAMADOS desde el mostrador que se suelta.
    pedido: {
      findMany: jest.fn().mockResolvedValue(llamados),
      count: jest.fn().mockResolvedValue(llamados.length),
    },
    usuario: { findUnique: jest.fn().mockResolvedValue(usuario) },
    tienda: { findUnique: jest.fn().mockResolvedValue({ id: 5 }) },
    mostrador: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where?.numero?.in) return mostradores.filter((m) => where.numero.in.includes(m.numero));
        return mostradores;
      }),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        if (orderBy) {
          const orden = [...mostradores].sort((a, b) => b.numero - a.numero);
          return orden[0] ?? null;
        }
        if (where?.NOT) {
          return (
            mostradores.find(
              (m) =>
                m.tiendaId === where.tiendaId && m.numero === where.numero && m.id !== where.NOT.id,
            ) ?? null
          );
        }
        return (
          mostradores.find(
            (m) => m.tiendaId === where.tiendaId && m.operadorId === where.operadorId,
          ) ?? null
        );
      }),
      findUnique: jest.fn(
        async ({ where }: any) => mostradores.find((m) => m.id === where.id) ?? null,
      ),
      count: jest.fn(
        async ({ where }: any) =>
          mostradores.filter((m) => m.tiendaId === where.tiendaId && m.activa === where.activa)
            .length,
      ),
      create: jest.fn(async ({ data }: any) => ({ id: 100 + data.numero, activa: true, ...data })),
      update: jest.fn(async ({ where, data }: any) => ({
        ...mostradores.find((m) => m.id === where.id),
        ...data,
      })),
      delete: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === 'function' ? arg(tx) : Promise.all(arg),
    ),
  };
  const realtime = { emitToTienda: jest.fn(), emitToUser: jest.fn() };

  const estado = { cambiarEstado: jest.fn().mockResolvedValue({}) };
  const svc = new MostradoresService(prisma as never, realtime as never, estado as never);
  return { svc, prisma, tx, realtime, estado };
}

const m = (
  id: number,
  numero: number,
  operadorId: number | null = null,
  activa = true,
): Mostrador => ({
  id,
  tiendaId: 5,
  numero,
  operadorId,
  activa,
});

describe('MostradoresService.crearN', () => {
  it('numera a continuación de los existentes', async () => {
    const { svc, prisma } = crearServicio({ mostradores: [m(1, 1), m(2, 2)] });

    const creados = await svc.crearN(5, 2);

    expect(creados.map((c: any) => c.numero)).toEqual([3, 4]);
    expect(prisma.mostrador.create).toHaveBeenCalledTimes(2);
  });

  it('arranca en 1 en una tienda sin mostradores', async () => {
    const { svc } = crearServicio();
    const creados = await svc.crearN(5, 1);
    expect(creados.map((c: any) => c.numero)).toEqual([1]);
  });

  it.each([0, 21, 1.5, -1])('rechaza una cantidad inválida (%s)', async (n) => {
    const { svc } = crearServicio();
    await expect(svc.crearN(5, n)).rejects.toThrow(BadRequestException);
  });

  it('rechaza una tienda que no existe', async () => {
    const { svc, prisma } = crearServicio();
    prisma.tienda.findUnique.mockResolvedValue(null);
    await expect(svc.crearN(99, 1)).rejects.toThrow(NotFoundException);
  });
});

describe('MostradoresService.renumerar / borrar', () => {
  it('no deja renumerar a un número que ya existe en la tienda', async () => {
    const { svc } = crearServicio({ mostradores: [m(1, 1), m(2, 2)] });
    await expect(svc.renumerar(5, 1, 2)).rejects.toThrow(ConflictException);
  });

  it('renumera a un número libre', async () => {
    const { svc, prisma } = crearServicio({ mostradores: [m(1, 1)] });
    await svc.renumerar(5, 1, 7);
    expect(prisma.mostrador.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { numero: 7 } });
  });

  it('no opera un mostrador de OTRA tienda', async () => {
    const { svc } = crearServicio({ mostradores: [{ ...m(1, 1), tiendaId: 9 }] });
    await expect(svc.renumerar(5, 1, 2)).rejects.toThrow(NotFoundException);
    await expect(svc.borrar(5, 1)).rejects.toThrow(NotFoundException);
  });

  it('no borra un mostrador OCUPADO por un operador', async () => {
    const { svc, prisma } = crearServicio({ mostradores: [m(1, 1, 3)] });
    await expect(svc.borrar(5, 1)).rejects.toThrow(/ocupado/i);
    expect(prisma.mostrador.delete).not.toHaveBeenCalled();
  });

  it('borra uno libre', async () => {
    const { svc, prisma } = crearServicio({ mostradores: [m(1, 1)] });
    await expect(svc.borrar(5, 1)).resolves.toEqual({ ok: true });
    expect(prisma.mostrador.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });
});

describe('MostradoresService.elegir', () => {
  it('asigna el mostrador libre y avisa a la tienda por realtime', async () => {
    const { svc, realtime } = crearServicio({ mostradores: [m(1, 1), m(2, 2)] });

    const r = await svc.elegir(3, 5, 2);

    expect(r).toBeTruthy();
    expect(realtime.emitToTienda).toHaveBeenCalledWith(
      5,
      'mostrador.asignado',
      expect.objectContaining({
        mostradorId: 2,
        numero: 2,
        operadorId: 3,
        operadorNombre: 'Ana Ruiz',
      }),
    );
  });

  it('la asignación es atómica: si otro operador lo tomó entre la lectura y la escritura, 409', async () => {
    // Dos operadores que eligen el mismo mostrador a la vez: sin la guarda
    // `updateMany` los dos creerían tenerlo.
    const { svc, realtime } = crearServicio({ mostradores: [m(1, 1)], asignacionCount: 0 });

    await expect(svc.elegir(3, 5, 1)).rejects.toThrow(ConflictException);
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
  });

  it('libera el mostrador que el operador tenía antes (1:1)', async () => {
    const { svc, tx } = crearServicio({ mostradores: [m(1, 1, 3), m(2, 2)] });

    await svc.elegir(3, 5, 2);

    expect(tx.mostrador.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { operadorId: null },
    });
  });

  it('elegir el que ya tenía es idempotente: no escribe ni avisa', async () => {
    const { svc, tx, realtime } = crearServicio({ mostradores: [m(1, 1, 3)] });

    await svc.elegir(3, 5, 1);

    expect(tx.mostrador.updateMany).not.toHaveBeenCalled();
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
  });

  it('un mostrador inactivo no se puede elegir', async () => {
    const { svc } = crearServicio({ mostradores: [m(1, 1, null, false)] });
    await expect(svc.elegir(3, 5, 1)).rejects.toThrow(/inactivo/i);
  });

  it('solo MOSTRADOR y ADMIN eligen mostrador', async () => {
    const { svc } = crearServicio({
      mostradores: [m(1, 1)],
      usuario: { id: 3, nombre: 'X', apellido: null, rol: RolUsuario.CAJERO, tiendaId: 5 },
    });
    await expect(svc.elegir(3, 5, 1)).rejects.toThrow(BadRequestException);
  });

  it('un usuario de otra tienda no puede elegir en esta', async () => {
    const { svc } = crearServicio({
      mostradores: [m(1, 1)],
      usuario: { id: 3, nombre: 'X', apellido: null, rol: RolUsuario.MOSTRADOR, tiendaId: 9 },
    });
    await expect(svc.elegir(3, 5, 1)).rejects.toThrow(NotFoundException);
  });
});

describe('MostradoresService.liberar', () => {
  it('libera el mostrador del operador y avisa', async () => {
    const { svc, prisma, realtime } = crearServicio({ mostradores: [m(1, 1, 3)] });

    await svc.liberar(3, 5);

    expect(prisma.mostrador.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { operadorId: null },
    });
    expect(realtime.emitToTienda).toHaveBeenCalledWith(5, 'mostrador.liberado', {
      mostradorId: 1,
      numero: 1,
    });
  });

  it('sin mostrador asignado es un no-op (cerrar sesión no debe fallar)', async () => {
    const { svc, prisma, realtime } = crearServicio({ mostradores: [m(1, 1)] });

    await expect(svc.liberar(3, 5)).resolves.toEqual({ ok: true, clientesRegresadosALaCola: 0 });
    expect(prisma.mostrador.update).not.toHaveBeenCalled();
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
  });

  it('el cliente que tenía LLAMADO vuelve a la cola por la máquina de estados (la TV no lo deja anunciado)', async () => {
    const { svc, estado } = crearServicio({
      mostradores: [m(1, 1, 3)],
      llamados: [{ id: 70 }, { id: 71 }],
    });

    const r = await svc.liberar(3, 5);

    expect(r.clientesRegresadosALaCola).toBe(2);
    expect(estado.cambiarEstado).toHaveBeenCalledTimes(2);
    expect(estado.cambiarEstado.mock.calls[0][0]).toBe(70);
    expect(estado.cambiarEstado.mock.calls[0][1]).toMatchObject({ nuevoEstado: 'REVISADO' });
    // Sin correo ("tu pedido ya está listo") para quien está de pie en la tienda.
    expect(estado.cambiarEstado.mock.calls[0][3]).toMatchObject({ sinNotificar: true });
  });

  it('un pedido que ya cambió de estado no tumba la liberación', async () => {
    const { svc, estado } = crearServicio({
      mostradores: [m(1, 1, 3)],
      llamados: [{ id: 70 }, { id: 71 }],
    });
    estado.cambiarEstado.mockRejectedValueOnce(new Error('Transición no permitida'));

    const r = await svc.liberar(3, 5);

    expect(r.clientesRegresadosALaCola).toBe(1);
  });
});

describe('MostradoresService.elegir — ocupado por otro', () => {
  it('sin confirmación: 409 con un código que la pantalla reconoce y dice quién lo tiene', async () => {
    const { svc } = crearServicio({ mostradores: [m(1, 1, 9)] });
    await expect(svc.elegir(3, 5, 1)).rejects.toMatchObject({
      response: { code: 'MOSTRADOR_OCUPADO' },
    });
  });

  it('con `forzar` toma el control, avisa al que lo tenía y le devuelve a su cliente llamado', async () => {
    const { svc, realtime, estado } = crearServicio({
      mostradores: [m(1, 1, 9)],
      llamados: [{ id: 70 }],
    });

    await svc.elegir(3, 5, 1, true);

    expect(realtime.emitToUser).toHaveBeenCalledWith(9, 'mostrador.perdido', { numero: 1 });
    expect(estado.cambiarEstado).toHaveBeenCalledTimes(1);
  });
});

describe('MostradoresService.resolverParaLlamar — sin modo genérico', () => {
  it('devuelve el mostrador donde trabaja el operador', async () => {
    const { svc } = crearServicio({ mostradores: [m(1, 1), m(2, 2, 3)] });
    await expect(svc.resolverParaLlamar(3, 5)).resolves.toMatchObject({ id: 2, numero: 2 });
  });

  it('con mostradores configurados y sin elegir, exige elegir (la TV no sabría a cuál mandar)', async () => {
    const { svc } = crearServicio({ mostradores: [m(1, 1), m(2, 2)] });
    await expect(svc.resolverParaLlamar(3, 5)).rejects.toThrow(/elige tu mostrador/i);
  });

  it('en una tienda SIN mostradores ya NO llama "sin número": pide al admin crearlos', async () => {
    // Antes devolvía null y el operador trabajaba genérico. Ahora el mostrador es la estación que
    // autoriza a atender, igual que la ventanilla del cajero.
    const { svc } = crearServicio();
    await expect(svc.resolverParaLlamar(3, 5)).rejects.toThrow(/no tiene mostradores/i);
  });

  it('los mostradores inactivos no cuentan como configurados', async () => {
    const { svc } = crearServicio({ mostradores: [m(1, 1, null, false)] });
    await expect(svc.resolverParaLlamar(3, 5)).rejects.toThrow(/no tiene mostradores/i);
  });

  it('el ADMIN queda exento: sin mostrador llama sin número', async () => {
    const { svc } = crearServicio();
    await expect(svc.resolverParaLlamar(3, 5, true)).resolves.toBeNull();
  });
});

describe('MostradoresService.delOperadorConCarga — cuántos clientes regresarían al soltarlo', () => {
  it('cuenta los clientes que el operador tiene llamados desde su mostrador', async () => {
    const { svc, prisma } = crearServicio({
      mostradores: [m(2, 2, 3)],
      llamados: [{ id: 10 }, { id: 11 }],
    });
    await expect(svc.delOperadorConCarga(3, 5)).resolves.toMatchObject({
      id: 2,
      numero: 2,
      clientesEnCurso: 2,
    });
    // Solo los EN_ATENCION de ESE mostrador: la misma regla con la que `liberar` los regresa.
    expect(prisma.pedido.count).toHaveBeenCalledWith({
      where: { estado: 'EN_ATENCION', llamadoMostradorId: 2 },
    });
  });

  it('sin mostrador asignado es null (la consola entra como observador)', async () => {
    const { svc } = crearServicio({ mostradores: [m(1, 1)] });
    await expect(svc.delOperadorConCarga(3, 5)).resolves.toBeNull();
  });
});
