import { EstadoPedido } from '@prisma/client';
import { PedidoStateService } from './pedido-state.service';

/**
 * F16 (sep 2026): tests de la máquina de estados con el flujo
 * bodega → mostrador → pago.
 *
 * `TRANSICIONES` es privado del módulo, así que estos tests la ejercitan a
 * través de `cambiarEstado` con Prisma mockeado. Lo que importa es qué arcos
 * acepta y cuáles rechaza — es la garantía de que un pedido no puede llegar a
 * pago sin pasar por mostrador.
 */

/** Prisma mockeado que registra la transición intentada. */
function crearServicio(
  estadoActual: EstadoPedido,
  opts: { asignadoAId?: number | null; vecesEnRevisado?: number } = {},
) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });

  const tx = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue({
        id: 1,
        tiendaId: 5,
        estado: estadoActual,
        numeroPedido: 'PT-0001',
        asignadoAId: opts.asignadoAId ?? null,
        asignadoAt: null,
        tiempoAtencionBodegaMs: 0,
        bodegaTurnoDesdeAt: null,
        usuarioId: 7,
      }),
      updateMany,
    },
    historialPedido: {
      create: jest.fn().mockResolvedValue({}),
      // F22: el correo "listo en tienda" es del PRIMER paso a REVISADO; la máquina
      // cuenta cuántas veces ya estuvo ahí.
      count: jest.fn().mockResolvedValue(opts.vecesEnRevisado ?? 0),
    },
    pedidoPendienteEnvio: {
      create: jest.fn().mockResolvedValue({}),
      // El guard de PENDIENTE_PAGO consulta si el pedido YA tiene fila en la
      // cola del ERP. En estos tests no hay ninguna, así que el caller debe
      // pasar `encolarFirebird: true` (que es lo que hace el código real).
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  const prisma = {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    // `dispararEfectos` relee el pedido DESPUÉS del commit para mandar la
    // notificación. Antes eso vivía dentro de la transacción y no hacía falta.
    pedido: { findUnique: jest.fn().mockResolvedValue({ id: 1, tiendaId: 5 }) },
  };

  const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn(), emitToUser: jest.fn() };

  const svc = new PedidoStateService(
    prisma as never,
    { enviar: jest.fn().mockResolvedValue(undefined) } as never, // notifications
    realtime as never,
    { cargarYValidar: jest.fn().mockResolvedValue({ id: 1, estado: estadoActual }) } as never, // access
    {} as never, // storage
  );

  return { svc, updateMany, tx, realtime };
}

const usuario = { userId: 3, nombre: 'Operador', rol: 'MOSTRADOR' } as never;

/**
 * Intenta una transición y dice si la máquina la aceptó.
 *
 * Añade `encolarFirebird` cuando el destino es PENDIENTE_PAGO, porque la máquina
 * lo exige (un pedido en ese estado sin fila en la cola del ERP es invisible
 * al agente para siempre). El guard tiene su propio test más abajo; aquí sólo
 * se pregunta qué aristas permite `TRANSICIONES`.
 */
async function intenta(
  desde: EstadoPedido,
  hacia: EstadoPedido,
  opts: Record<string, unknown> = {},
): Promise<boolean> {
  const { svc } = crearServicio(desde);
  const opciones =
    hacia === EstadoPedido.PENDIENTE_PAGO && opts.encolarFirebird === undefined
      ? { ...opts, encolarFirebird: true }
      : opts;
  try {
    await svc.cambiarEstado(1, { nuevoEstado: hacia } as never, usuario, opciones as never);
    return true;
  } catch {
    return false;
  }
}

describe('TRANSICIONES con REVISADO (F16)', () => {
  describe('bodega puede mandar a mostrador', () => {
    it('EN_REVISION → REVISADO', async () => {
      expect(await intenta(EstadoPedido.EN_REVISION, EstadoPedido.REVISADO)).toBe(true);
    });

    it('ESPERANDO_APROBACION → REVISADO (el cliente aprobó)', async () => {
      expect(await intenta(EstadoPedido.ESPERANDO_APROBACION, EstadoPedido.REVISADO)).toBe(true);
    });

    it('EN_ASESORIA → REVISADO (contrapropuesta sin pendientes)', async () => {
      expect(await intenta(EstadoPedido.EN_ASESORIA, EstadoPedido.REVISADO)).toBe(true);
    });
  });

  describe('mostrador puede liberar, ajustar y cancelar', () => {
    it('REVISADO → PENDIENTE_PAGO (liberar)', async () => {
      expect(await intenta(EstadoPedido.REVISADO, EstadoPedido.PENDIENTE_PAGO)).toBe(true);
    });

    it('REVISADO → EN_REVISION (ajustar) exige asignacion explícita', async () => {
      // Sin `asignacion` la máquina rechaza: el caller es un operador de
      // mostrador, y con el default histórico el pedido quedaría asignado a
      // él, invisible y bloqueado para todos los bodegueros.
      expect(await intenta(EstadoPedido.REVISADO, EstadoPedido.EN_REVISION)).toBe(false);
      expect(
        await intenta(EstadoPedido.REVISADO, EstadoPedido.EN_REVISION, {
          asignacion: 'limpiar',
        }),
      ).toBe(true);
    });

    it('REVISADO → CANCELLED (cancelar)', async () => {
      expect(await intenta(EstadoPedido.REVISADO, EstadoPedido.CANCELADO)).toBe(true);
    });
  });

  describe('el pago solo se alcanza desde REVISADO o desde domicilio', () => {
    it('EN_REVISION → PENDIENTE_PAGO sigue permitido (domicilio)', async () => {
      expect(await intenta(EstadoPedido.EN_REVISION, EstadoPedido.PENDIENTE_PAGO)).toBe(true);
    });

    it('ESPERANDO_APROBACION → PENDIENTE_PAGO sigue permitido (domicilio)', async () => {
      expect(await intenta(EstadoPedido.ESPERANDO_APROBACION, EstadoPedido.PENDIENTE_PAGO)).toBe(
        true,
      );
    });

    it('SOLICITADO NO puede saltar a PENDIENTE_PAGO', async () => {
      // Un pedido recién creado no puede llegar a caja sin pasar por bodega
      // (y, si es de tienda, por mostrador).
      expect(await intenta(EstadoPedido.SOLICITADO, EstadoPedido.PENDIENTE_PAGO)).toBe(false);
    });

    it('SOLICITADO NO puede saltar a REVISADO', async () => {
      // Bodega tiene que revisarlo primero: nadie verificó los productos.
      expect(await intenta(EstadoPedido.SOLICITADO, EstadoPedido.REVISADO)).toBe(false);
    });

    it('EN_ASESORIA NO puede ir directo a pago', async () => {
      expect(await intenta(EstadoPedido.EN_ASESORIA, EstadoPedido.PENDIENTE_PAGO)).toBe(false);
    });
  });

  describe('mostrador no puede reabrir un pedido ya liberado', () => {
    it('PENDIENTE_PAGO → REVISADO no existe', async () => {
      // Una vez liberado el pedido ya está en el ERP; devolverlo a mostrador
      // dejaría a Firebird con un pedido vivo que el cliente podría cambiar.
      expect(await intenta(EstadoPedido.PENDIENTE_PAGO, EstadoPedido.REVISADO)).toBe(false);
    });

    it('PENDIENTE_PAGO → CANCELLED sigue permitido (D14)', async () => {
      // Decisión del negocio: si el cliente se arrepiente en caja, mostrador
      // puede cancelar. Firebird se sincroniza por SWCANCEL.
      expect(await intenta(EstadoPedido.PENDIENTE_PAGO, EstadoPedido.CANCELADO)).toBe(true);
    });
  });

  describe('estados terminales', () => {
    it('COMPLETED no transiciona a nada', async () => {
      for (const destino of Object.values(EstadoPedido)) {
        expect(await intenta(EstadoPedido.ENTREGADO, destino)).toBe(false);
      }
    });

    it('CANCELLED no transiciona a nada', async () => {
      for (const destino of Object.values(EstadoPedido)) {
        expect(await intenta(EstadoPedido.CANCELADO, destino)).toBe(false);
      }
    });
  });

  describe('el encolado a Firebird solo aplica a PENDIENTE_PAGO', () => {
    it('liberar desde mostrador encola', async () => {
      const { svc, tx } = crearServicio(EstadoPedido.REVISADO);
      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.PENDIENTE_PAGO } as never, usuario, {
        encolarFirebird: true,
      } as never);
      expect(tx.pedidoPendienteEnvio.create).toHaveBeenCalled();
    });

    it('mandar a mostrador NO encola', async () => {
      const { svc, tx } = crearServicio(EstadoPedido.EN_REVISION);
      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.REVISADO } as never, usuario, {
        encolarFirebird: false,
      } as never);
      expect(tx.pedidoPendienteEnvio.create).not.toHaveBeenCalled();
    });
  });

  describe('INVARIANTE: PENDIENTE_PAGO exige encolar a Firebird', () => {
    it('rechaza ir a PENDIENTE_PAGO sin encolarFirebird y sin fila previa', async () => {
      // Un pedido en PENDIENTE_PAGO sin fila en `PedidoPendienteEnvio` es
      // invisible al agente, nunca recibe folio y se queda atascado para
      // siempre. El comentario de `encolarFirebird` ya lo declaraba
      // obligatorio; este test fija que la máquina lo verifique.
      expect(
        await intenta(EstadoPedido.REVISADO, EstadoPedido.PENDIENTE_PAGO, {
          encolarFirebird: false,
        }),
      ).toBe(false);
    });

    it('acepta ir a PENDIENTE_PAGO con encolarFirebird', async () => {
      expect(
        await intenta(EstadoPedido.REVISADO, EstadoPedido.PENDIENTE_PAGO, {
          encolarFirebird: true,
        }),
      ).toBe(true);
    });

    it('acepta si el pedido YA tenía fila en la cola del ERP', async () => {
      // Reintento idempotente: la fila la creó una transición anterior, así que
      // no hace falta volver a encolar.
      const { svc, tx } = crearServicio(EstadoPedido.REVISADO);
      (tx.pedidoPendienteEnvio.findFirst as jest.Mock).mockResolvedValue({ id: 9 });
      await expect(
        svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.PENDIENTE_PAGO } as never, usuario, {
          encolarFirebird: false,
        } as never),
      ).resolves.toBeDefined();
    });

    it('no exige el flag para otros destinos', async () => {
      expect(
        await intenta(EstadoPedido.REVISADO, EstadoPedido.EN_REVISION, {
          asignacion: 'limpiar',
        }),
      ).toBe(true);
    });
  });
});

describe('oct 2026 — avisar al bodeguero cuando cancelan el pedido que está surtiendo', () => {
  async function cancelar(desde: EstadoPedido, asignadoAId: number | null) {
    const { svc, realtime } = crearServicio(desde, { asignadoAId });
    await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.CANCELADO } as never, usuario, {
      asignacion: 'limpiar',
    } as never);
    return realtime;
  }

  it('EN_REVISION → CANCELADO avisa SOLO al bodeguero que lo tenía', async () => {
    const realtime = await cancelar(EstadoPedido.EN_REVISION, 42);

    // Va a su room personal, no a toda la tienda.
    expect(realtime.emitToUser).toHaveBeenCalledTimes(1);
    expect(realtime.emitToUser).toHaveBeenCalledWith(42, 'pedido.cancelado-en-bodega', {
      pedidoId: 1,
      numeroPedido: 'PT-0001',
    });
  });

  it('el aviso usa la asignación PREVIA a la transición, que ya se limpió en la BD', async () => {
    // `cambiosDeAsignacion('limpiar')` pone `asignadoAId: null` en el mismo update
    // que cancela. Si el aviso leyera el pedido después, no sabría a quién avisar.
    const { svc, tx, realtime } = crearServicio(EstadoPedido.EN_REVISION, { asignadoAId: 42 });

    await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.CANCELADO } as never, usuario, {
      asignacion: 'limpiar',
    } as never);

    const datos = tx.pedido.updateMany.mock.calls[0][0].data;
    expect(datos.asignadoAId).toBeNull();
    expect(realtime.emitToUser).toHaveBeenCalledWith(
      42,
      'pedido.cancelado-en-bodega',
      expect.anything(),
    );
  });

  it('un pedido que nadie tenía asignado no avisa a nadie', async () => {
    const realtime = await cancelar(EstadoPedido.EN_REVISION, null);
    expect(realtime.emitToUser).not.toHaveBeenCalled();
  });

  it.each([
    [EstadoPedido.SOLICITADO],
    [EstadoPedido.REVISADO],
    [EstadoPedido.ESPERANDO_APROBACION],
    [EstadoPedido.PENDIENTE_PAGO],
  ])('cancelar desde %s no avisa a bodega', async (estado) => {
    // En REVISADO y posteriores la bolsa ya salió de las manos del bodeguero.
    const realtime = await cancelar(estado, 42);
    expect(realtime.emitToUser).not.toHaveBeenCalled();
  });

  it('un cambio que no es cancelación no dispara el aviso', async () => {
    const { svc, realtime } = crearServicio(EstadoPedido.EN_REVISION, { asignadoAId: 42 });
    await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.REVISADO } as never, usuario, {
      asignacion: 'limpiar',
    } as never);
    expect(realtime.emitToUser).not.toHaveBeenCalled();
  });
});

/**
 * F22 (oct 2026): el correo "tu pedido ya está listo en tienda" es del PRIMER paso a
 * `REVISADO`.
 *
 * El bug: salía cada vez que el pedido entraba ahí — al devolver a la cola un
 * llamado equivocado, al traerlo desde asesoría y al volver de cada ajuste de
 * mostrador. El cliente que está de pie en la tienda recibía "tu pedido ya está
 * listo" tres veces.
 */
describe('F22 — el correo "listo en tienda" es del primer paso a REVISADO', () => {
  async function transicion(
    desde: EstadoPedido,
    hacia: EstadoPedido,
    opts: { vecesEnRevisado?: number; opciones?: Record<string, unknown> } = {},
  ) {
    const { svc, tx } = crearServicio(desde, { vecesEnRevisado: opts.vecesEnRevisado });
    const r = (await svc.cambiarEstado(1, { nuevoEstado: hacia } as never, usuario, {
      tx: tx as never,
      ...(opts.opciones ?? {}),
    } as never)) as { efectos: { notifTipo: string | null } };
    return r.efectos.notifTipo;
  }

  it('la PRIMERA vez que entra a REVISADO sí se avisa al cliente', async () => {
    expect(
      await transicion(EstadoPedido.EN_REVISION, EstadoPedido.REVISADO, { vecesEnRevisado: 0 }),
    ).toBe('LISTO_EN_TIENDA');
  });

  it('volver de un ajuste (ya estuvo en REVISADO) NO manda otro correo', async () => {
    expect(
      await transicion(EstadoPedido.EN_REVISION, EstadoPedido.REVISADO, { vecesEnRevisado: 1 }),
    ).toBeNull();
  });

  it('deshacer una llamada (EN_ATENCION → REVISADO) NO manda otro correo', async () => {
    expect(
      await transicion(EstadoPedido.EN_ATENCION, EstadoPedido.REVISADO, { vecesEnRevisado: 1 }),
    ).toBeNull();
  });

  it('`sinNotificar` lo suprime aun siendo la primera vez (cliente enfrente)', async () => {
    expect(
      await transicion(EstadoPedido.EN_ASESORIA, EstadoPedido.REVISADO, {
        vecesEnRevisado: 0,
        opciones: { sinNotificar: true },
      }),
    ).toBeNull();
  });

  it('`sinNotificar` no afecta a otros destinos que sí deben notificar', async () => {
    // Sin la opción, cancelar notifica; la opción es una excepción explícita del
    // caller, no un cambio de la tabla de notificaciones.
    expect(await transicion(EstadoPedido.REVISADO, EstadoPedido.CANCELADO)).toBe('CANCELADO');
  });

  it('el conteo se hace ANTES de escribir la fila de esta transición', async () => {
    // Si el historial ya tuviera la fila de esta misma entrada, siempre contaría
    // 1 y el primer correo NUNCA saldría.
    const { svc, tx } = crearServicio(EstadoPedido.EN_REVISION);
    const orden: string[] = [];
    tx.historialPedido.count.mockImplementation(async () => {
      orden.push('count');
      return 0;
    });
    tx.historialPedido.create.mockImplementation(async () => {
      orden.push('create');
      return {};
    });

    await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.REVISADO } as never, usuario);

    expect(orden).toEqual(['count', 'create']);
  });

  it('no consulta el historial para destinos que no son REVISADO', async () => {
    const { svc, tx } = crearServicio(EstadoPedido.REVISADO);
    await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.CANCELADO } as never, usuario);
    expect(tx.historialPedido.count).not.toHaveBeenCalled();
  });
});

/**
 * F22: la antigüedad de la ESPERA (`esperaClienteDesdeAt`) de donde salen el
 * recordatorio "¿aún lo quieres?" y la lista de vencidos.
 */
describe('F22 — esperaClienteDesdeAt mide cuánto lleva la bolsa esperando', () => {
  async function datosDeEspera(desde: EstadoPedido, hacia: EstadoPedido) {
    const { svc, tx } = crearServicio(desde);
    await svc.cambiarEstado(1, { nuevoEstado: hacia } as never, usuario, {
      asignacion: 'limpiar',
      encolarFirebird: hacia === EstadoPedido.PENDIENTE_PAGO,
    } as never);
    return tx.pedido.updateMany.mock.calls[0][0].data as Record<string, unknown>;
  }

  it.each([
    [EstadoPedido.EN_REVISION, EstadoPedido.REVISADO],
    [EstadoPedido.EN_REVISION, EstadoPedido.ESPERANDO_APROBACION],
    [EstadoPedido.EN_ASESORIA, EstadoPedido.REVISADO],
  ])('arranca al apartarse la bolsa: %s → %s', async (desde, hacia) => {
    const d = await datosDeEspera(desde, hacia);
    expect(d.esperaClienteDesdeAt).toBeInstanceOf(Date);
    // Un ciclo nuevo de espera: recordatorio y confirmaciones empiezan de cero.
    expect(d.recordatorioRecogerAt).toBeNull();
    expect(d.interesConfirmadoCount).toBe(0);
  });

  it.each([
    [EstadoPedido.REVISADO, EstadoPedido.EN_ATENCION],
    [EstadoPedido.EN_ATENCION, EstadoPedido.REVISADO],
    [EstadoPedido.ESPERANDO_APROBACION, EstadoPedido.REVISADO],
  ])('NO se reinicia al moverse DENTRO del grupo: %s → %s', async (desde, hacia) => {
    // Lo que importa es cuánto lleva la bolsa esperando, no la última acción. Si
    // llamar o devolver a la cola reiniciaran el reloj, un pedido que el operador
    // manipula nunca llegaría a "vencido".
    const d = await datosDeEspera(desde, hacia);
    expect(d).not.toHaveProperty('esperaClienteDesdeAt');
    expect(d).not.toHaveProperty('recordatorioRecogerAt');
  });

  it.each([
    [EstadoPedido.REVISADO, EstadoPedido.PENDIENTE_PAGO],
    [EstadoPedido.REVISADO, EstadoPedido.CANCELADO],
    [EstadoPedido.REVISADO, EstadoPedido.EN_REVISION],
    [EstadoPedido.EN_ATENCION, EstadoPedido.PENDIENTE_PAGO],
  ])('se limpia al salir de la bolsa apartada: %s → %s', async (desde, hacia) => {
    const d = await datosDeEspera(desde, hacia);
    expect(d.esperaClienteDesdeAt).toBeNull();
    expect(d.recordatorioRecogerAt).toBeNull();
  });
});

/**
 * F22: quién llamó y desde qué mostrador son la misma señal que `llamadoAt`
 * ("este folio está anunciado") y no pueden sobrevivir separadas.
 */
describe('F22 — la llamada se limpia completa al salir de EN_ATENCION', () => {
  it.each([
    [EstadoPedido.EN_ATENCION, EstadoPedido.REVISADO],
    [EstadoPedido.EN_ATENCION, EstadoPedido.PENDIENTE_PAGO],
    [EstadoPedido.EN_ATENCION, EstadoPedido.CANCELADO],
    [EstadoPedido.REVISADO, EstadoPedido.EN_ATENCION],
  ])('%s → %s limpia llamadoAt, llamadoPorId y llamadoMostradorId', async (desde, hacia) => {
    const { svc, tx } = crearServicio(desde);
    await svc.cambiarEstado(1, { nuevoEstado: hacia } as never, usuario, {
      encolarFirebird: hacia === EstadoPedido.PENDIENTE_PAGO,
    } as never);
    const d = tx.pedido.updateMany.mock.calls[0][0].data;
    expect(d.llamadoAt).toBeNull();
    expect(d.llamadoPorId).toBeNull();
    expect(d.llamadoMostradorId).toBeNull();
  });
});
