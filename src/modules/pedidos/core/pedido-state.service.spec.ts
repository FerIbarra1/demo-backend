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
    pedidoPendienteEnvio: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
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

/** Intenta una transición y dice si la máquina la aceptó. */
async function intenta(
  desde: EstadoPedido,
  hacia: EstadoPedido,
  opts: Record<string, unknown> = {},
): Promise<boolean> {
  const { svc } = crearServicio(desde);
  try {
    await svc.cambiarEstado(
      1,
      { nuevoEstado: hacia } as never,
      usuario,
      opts as never,
    );
    return true;
  } catch {
    return false;
  }
}

describe('TRANSICIONES con EN_MOSTRADOR (F16)', () => {
  describe('bodega puede mandar a mostrador', () => {
    it('REVIEWING → EN_MOSTRADOR', async () => {
      expect(await intenta(EstadoPedido.REVIEWING, EstadoPedido.EN_MOSTRADOR)).toBe(true);
    });

    it('WAITING_CUSTOMER_APPROVAL → EN_MOSTRADOR (el cliente aprobó)', async () => {
      expect(
        await intenta(EstadoPedido.WAITING_CUSTOMER_APPROVAL, EstadoPedido.EN_MOSTRADOR),
      ).toBe(true);
    });

    it('EN_ASESORIA → EN_MOSTRADOR (contrapropuesta sin pendientes)', async () => {
      expect(await intenta(EstadoPedido.EN_ASESORIA, EstadoPedido.EN_MOSTRADOR)).toBe(true);
    });
  });

  describe('mostrador puede liberar, ajustar y cancelar', () => {
    it('EN_MOSTRADOR → PENDING_PAID (liberar)', async () => {
      expect(await intenta(EstadoPedido.EN_MOSTRADOR, EstadoPedido.PENDING_PAID)).toBe(true);
    });

    it('EN_MOSTRADOR → REVIEWING (ajustar) exige asignacion explícita', async () => {
      // Sin `asignacion` la máquina rechaza: el caller es un operador de
      // mostrador, y con el default histórico el pedido quedaría asignado a
      // él, invisible y bloqueado para todos los bodegueros.
      expect(await intenta(EstadoPedido.EN_MOSTRADOR, EstadoPedido.REVIEWING)).toBe(false);
      expect(
        await intenta(EstadoPedido.EN_MOSTRADOR, EstadoPedido.REVIEWING, {
          asignacion: 'limpiar',
        }),
      ).toBe(true);
    });

    it('EN_MOSTRADOR → CANCELLED (cancelar)', async () => {
      expect(await intenta(EstadoPedido.EN_MOSTRADOR, EstadoPedido.CANCELLED)).toBe(true);
    });
  });

  describe('el pago solo se alcanza desde EN_MOSTRADOR o desde domicilio', () => {
    it('REVIEWING → PENDING_PAID sigue permitido (domicilio)', async () => {
      expect(await intenta(EstadoPedido.REVIEWING, EstadoPedido.PENDING_PAID)).toBe(true);
    });

    it('WAITING_CUSTOMER_APPROVAL → PENDING_PAID sigue permitido (domicilio)', async () => {
      expect(
        await intenta(EstadoPedido.WAITING_CUSTOMER_APPROVAL, EstadoPedido.PENDING_PAID),
      ).toBe(true);
    });

    it('PENDING_REVIEW NO puede saltar a PENDING_PAID', async () => {
      // Un pedido recién creado no puede llegar a caja sin pasar por bodega
      // (y, si es de tienda, por mostrador).
      expect(await intenta(EstadoPedido.PENDING_REVIEW, EstadoPedido.PENDING_PAID)).toBe(false);
    });

    it('PENDING_REVIEW NO puede saltar a EN_MOSTRADOR', async () => {
      // Bodega tiene que revisarlo primero: nadie verificó los productos.
      expect(await intenta(EstadoPedido.PENDING_REVIEW, EstadoPedido.EN_MOSTRADOR)).toBe(false);
    });

    it('EN_ASESORIA NO puede ir directo a pago', async () => {
      expect(await intenta(EstadoPedido.EN_ASESORIA, EstadoPedido.PENDING_PAID)).toBe(false);
    });
  });

  describe('mostrador no puede reabrir un pedido ya liberado', () => {
    it('PENDING_PAID → EN_MOSTRADOR no existe', async () => {
      // Una vez liberado el pedido ya está en el ERP; devolverlo a mostrador
      // dejaría a Firebird con un pedido vivo que el cliente podría cambiar.
      expect(await intenta(EstadoPedido.PENDING_PAID, EstadoPedido.EN_MOSTRADOR)).toBe(false);
    });

    it('PENDING_PAID → CANCELLED sigue permitido (D14)', async () => {
      // Decisión del negocio: si el cliente se arrepiente en caja, mostrador
      // puede cancelar. Firebird se sincroniza por SWCANCEL.
      expect(await intenta(EstadoPedido.PENDING_PAID, EstadoPedido.CANCELLED)).toBe(true);
    });
  });

  describe('estados terminales', () => {
    it('COMPLETED no transiciona a nada', async () => {
      for (const destino of Object.values(EstadoPedido)) {
        expect(await intenta(EstadoPedido.COMPLETED, destino)).toBe(false);
      }
    });

    it('CANCELLED no transiciona a nada', async () => {
      for (const destino of Object.values(EstadoPedido)) {
        expect(await intenta(EstadoPedido.CANCELLED, destino)).toBe(false);
      }
    });
  });

  describe('el encolado a Firebird solo aplica a PENDING_PAID', () => {
    it('liberar desde mostrador encola', async () => {
      const { svc, tx } = crearServicio(EstadoPedido.EN_MOSTRADOR);
      await svc.cambiarEstado(
        1,
        { nuevoEstado: EstadoPedido.PENDING_PAID } as never,
        usuario,
        { encolarFirebird: true } as never,
      );
      expect(tx.pedidoPendienteEnvio.create).toHaveBeenCalled();
    });

    it('mandar a mostrador NO encola', async () => {
      const { svc, tx } = crearServicio(EstadoPedido.REVIEWING);
      await svc.cambiarEstado(
        1,
        { nuevoEstado: EstadoPedido.EN_MOSTRADOR } as never,
        usuario,
        { encolarFirebird: false } as never,
      );
      expect(tx.pedidoPendienteEnvio.create).not.toHaveBeenCalled();
    });
  });
});
