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
function crearServicio(estadoActual: EstadoPedido) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });

  const tx = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue({
        id: 1,
        tiendaId: 5,
        estado: estadoActual,
        asignadoAId: null,
        asignadoAt: null,
        tiempoAtencionBodegaMs: 0,
        bodegaTurnoDesdeAt: null,
        usuarioId: 7,
      }),
      updateMany,
    },
    historialPedido: { create: jest.fn().mockResolvedValue({}) },
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

  const svc = new PedidoStateService(
    prisma as never,
    { enviar: jest.fn().mockResolvedValue(undefined) } as never, // notifications
    { emitToTienda: jest.fn(), emitToPedido: jest.fn() } as never, // realtime
    { cargarYValidar: jest.fn().mockResolvedValue({ id: 1, estado: estadoActual }) } as never, // access
    {} as never, // storage
  );

  return { svc, updateMany, tx };
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
      expect(await intenta(EstadoPedido.ESPERANDO_APROBACION, EstadoPedido.REVISADO)).toBe(
        true,
      );
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
