import { EstadoPedido, ModoEntrega, CanalOrigen, Prisma } from '@prisma/client';
import { destinoTrasSurtido } from './destino-post-surtido.util';
import { PedidoStateService } from './pedido-state.service';

/**
 * F16 (sep 2026): tests del camino COMPLETO del flujo nuevo.
 *
 * El plan (§5.3) pide probar el recorrido end-to-end:
 *   SOLICITADO → EN_REVISION → REVISADO → PENDIENTE_PAGO → PAID → COMPLETED
 *
 * Estos tests verifican la SECUENCIA de estados y, sobre todo, el invariante
 * central del cambio: **el pedido solo entra al ERP (Firebird) al liberar
 * mostrador**, nunca al surtir bodega. Si ese invariante se rompe, el ERP ve
 * pedidos que el cliente todavía puede cambiar.
 *
 * Se prueba la máquina de estados con Prisma mockeado (la transición real la
 * cubre `pedido-state.service.spec.ts`); aquí lo que importa es que la
 * SECUENCIA sea alcanzable y que el encolado ocurra en el paso correcto.
 */

/** Prisma mockeado que registra cada transición y cada encolado. */
function crearServicio(estadoInicial: EstadoPedido, modoEntrega: ModoEntrega) {
  const transiciones: Array<{ de: EstadoPedido; a: EstadoPedido }> = [];
  const encolados: number[] = [];
  let estado = estadoInicial;

  const tx = {
    pedido: {
      findUnique: jest.fn(async () => ({
        id: 1,
        tiendaId: 5,
        usuarioId: 7,
        estado,
        modoEntrega,
        asignadoAId: null,
        asignadoAt: null,
        tiempoAtencionBodegaMs: 0,
        bodegaTurnoDesdeAt: null,
      })),
      updateMany: jest.fn(async (args: any) => {
        // Oct 2026: con `permitirMismoEstado`, `data.estado` puede venir
        // `undefined` (no se reescribe el estado porque no cambió). Sin este
        // guard, el harness empujaría `{ de: X, a: undefined }` en silencio y
        // cualquier aserción sobre la secuencia pasaría por accidente.
        if (args.data.estado !== undefined) {
          transiciones.push({ de: estado, a: args.data.estado });
          estado = args.data.estado;
        }
        return { count: 1 };
      }),
    },
    // Oct 2026: la cancelación consulta si el pedido tenía un pago por transferencia (aquí: ninguno).
    pedidoPagoTransferencia: { findFirst: jest.fn().mockResolvedValue(null) },
    pedidoDtf: { count: async () => 0, findMany: async () => [] }, // sin trabajos DTF (impresión DTF, oct 2026)
    historialPedido: {
      create: jest.fn().mockResolvedValue({}),
      // F22: el correo "listo en tienda" es del PRIMER paso a REVISADO; la máquina
      // cuenta cuántas veces ya estuvo ahí.
      count: jest.fn().mockResolvedValue(0),
    },
    // Oct 2026 (parte B): al salir del surtido la máquina deja la solicitud del folio del ERP.
    pedidoFolioSolicitud: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    pedidoPendienteEnvio: {
      // Oct 2026: al cancelar, la máquina mira la fila de envío: este flujo nunca llegó al ERP (sin fila).
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (args: any) => {
        encolados.push(args.data.pedidoId);
        return {};
      }),
    },
  };

  const prisma = {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    // `cambiarEstadoPorSistema` lee el estado actual fuera de la transacción
    // para poder saltarse la transición si el pedido ya está en ese estado.
    pedido: { findUnique: jest.fn(async () => ({ estado })) },
  };

  const svc = new PedidoStateService(
    prisma as never,
    { enviar: jest.fn().mockResolvedValue(undefined) } as never,
    { emitToTienda: jest.fn(), emitToPedido: jest.fn() } as never,
    { cargarYValidar: jest.fn().mockResolvedValue({ id: 1, estado }) } as never,
    {} as never,
  );

  return { svc, transiciones, encolados, estadoActual: () => estado };
}

const usuario = { userId: 3, nombre: 'Actor', rol: 'MOSTRADOR' } as never;

describe('Camino completo del flujo (F16)', () => {
  describe('pedido de tienda (KIOSKO)', () => {
    it('recorre bodega → mostrador → pago con el encolado al final', async () => {
      const { svc, transiciones, encolados } = crearServicio(
        EstadoPedido.EN_REVISION,
        ModoEntrega.KIOSKO,
      );

      // 1) Bodega confirma el surtido: el helper decide el destino.
      const destino = destinoTrasSurtido(ModoEntrega.KIOSKO);
      await svc.cambiarEstado(1, { nuevoEstado: destino.estado } as never, usuario, {
        asignacion: 'limpiar',
        reloj: 'detener',
        encolarFirebird: destino.encolarFirebird,
      } as never);

      expect(transiciones[0]).toEqual({
        de: EstadoPedido.EN_REVISION,
        a: EstadoPedido.REVISADO,
      });
      // INVARIANTE: al entrar a mostrador NO se encola al ERP.
      expect(encolados).toHaveLength(0);

      // 2) Mostrador libera: AQUÍ entra al ERP.
      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.PENDIENTE_PAGO } as never, usuario, {
        encolarFirebird: true,
        invalidarMonitor: true,
      } as never);

      expect(transiciones[1]).toEqual({
        de: EstadoPedido.REVISADO,
        a: EstadoPedido.PENDIENTE_PAGO,
      });
      expect(encolados).toEqual([1]);

      // 3) El webhook del ERP marca pagado.
      await svc.cambiarEstadoPorSistema(1, EstadoPedido.PAGADO, {
        usuarioNombre: 'AGENT_EXTERNAL',
      });
      expect(transiciones[2]).toEqual({
        de: EstadoPedido.PENDIENTE_PAGO,
        a: EstadoPedido.PAGADO,
      });

      // 4) Mostrador entrega.
      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.ENTREGADO } as never, usuario, {});
      expect(transiciones[3]).toEqual({
        de: EstadoPedido.PAGADO,
        a: EstadoPedido.ENTREGADO,
      });

      // El pedido se encoló UNA sola vez en todo el recorrido.
      expect(encolados).toHaveLength(1);
    });

    it('el ajuste devuelve el pedido a bodega y luego vuelve a mostrador', async () => {
      const { svc, transiciones, encolados } = crearServicio(
        EstadoPedido.REVISADO,
        ModoEntrega.KIOSKO,
      );

      // El cliente pide cambios → vuelve a bodega SIN encolar.
      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.EN_REVISION } as never, usuario, {
        asignacion: 'limpiar',
        reloj: 'reanudar',
      } as never);
      expect(transiciones[0].a).toBe(EstadoPedido.EN_REVISION);
      expect(encolados).toHaveLength(0);

      // Bodega surte lo nuevo → vuelve a mostrador, tampoco encola.
      const destino = destinoTrasSurtido(ModoEntrega.KIOSKO);
      await svc.cambiarEstado(1, { nuevoEstado: destino.estado } as never, usuario, {
        asignacion: 'limpiar',
        reloj: 'detener',
        encolarFirebird: destino.encolarFirebird,
      } as never);
      expect(transiciones[1].a).toBe(EstadoPedido.REVISADO);
      expect(encolados).toHaveLength(0);

      // El cliente queda conforme → libera → AHORA sí encola.
      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.PENDIENTE_PAGO } as never, usuario, {
        encolarFirebird: true,
      } as never);
      expect(encolados).toEqual([1]);
    });

    it('cancelar desde mostrador NO encola al ERP', async () => {
      const { svc, encolados } = crearServicio(EstadoPedido.REVISADO, ModoEntrega.KIOSKO);

      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.CANCELADO } as never, usuario, {
        asignacion: 'limpiar',
        reloj: 'detener',
      } as never);

      // El pedido nunca llegó al ERP, así que no hay nada que sincronizar.
      expect(encolados).toHaveLength(0);
    });
  });

  describe('pedido a domicilio (salta mostrador)', () => {
    it('va de bodega directo a pago con el encolado inmediato', async () => {
      const { svc, transiciones, encolados } = crearServicio(
        EstadoPedido.EN_REVISION,
        ModoEntrega.DOMICILIO,
      );

      const destino = destinoTrasSurtido(ModoEntrega.DOMICILIO);
      await svc.cambiarEstado(1, { nuevoEstado: destino.estado } as never, usuario, {
        asignacion: 'limpiar',
        reloj: 'detener',
        encolarFirebird: destino.encolarFirebird,
      } as never);

      expect(transiciones[0]).toEqual({
        de: EstadoPedido.EN_REVISION,
        a: EstadoPedido.PENDIENTE_PAGO,
      });
      // A diferencia del pedido de tienda, aquí SÍ se encola de inmediato:
      // no hay nada que mostrarle a un cliente que no está en la tienda.
      expect(encolados).toEqual([1]);
    });

    it('nunca pasa por REVISADO', async () => {
      const { svc, transiciones } = crearServicio(EstadoPedido.EN_REVISION, ModoEntrega.DOMICILIO);

      const destino = destinoTrasSurtido(ModoEntrega.DOMICILIO);
      await svc.cambiarEstado(1, { nuevoEstado: destino.estado } as never, usuario, {
        encolarFirebird: true,
      } as never);

      expect(transiciones.every((t) => t.a !== EstadoPedido.REVISADO)).toBe(true);
    });
  });

  describe('el invariante central: PENDIENTE_PAGO ⟺ encolado', () => {
    it('ningún camino llega a PENDIENTE_PAGO sin encolar', () => {
      // El helper es la garantía: `encolarFirebird` es true exactamente cuando
      // el destino es PENDIENTE_PAGO. Si alguien agrega un modo de entrega nuevo
      // y olvida la regla, este test lo atrapa.
      for (const modo of Object.values(ModoEntrega)) {
        const d = destinoTrasSurtido(modo);
        expect(d.encolarFirebird).toBe(d.estado === EstadoPedido.PENDIENTE_PAGO);
      }
    });

    it('un pedido en REVISADO (el área de entrega) nunca tiene fila en la cola del ERP', () => {
      // Consecuencia del helper: como REVISADO siempre va con
      // encolarFirebird=false, un pedido en el área de entrega no puede estar en el ERP.
      for (const modo of Object.values(ModoEntrega)) {
        const d = destinoTrasSurtido(modo);
        if (d.estado === EstadoPedido.REVISADO) {
          expect(d.encolarFirebird).toBe(false);
        }
      }
    });
  });

  /**
   * F17 (oct 2026): el recorrido con el estado EN_ATENCION.
   *
   * El área de entrega (REVISADO) y la atención (EN_ATENCION) son dos puntos del mismo
   * paso por mostrador. Antes "llamado" era la columna `llamadoAt` y el estado
   * no cambiaba; ahora es una transición real, y estos tests fijan que el
   * camino de ida y vuelta sea alcanzable.
   */
  describe('F17: el área de entrega y la atención', () => {
    it('el operador llama al cliente y lo puede devolver al área de entrega', async () => {
      const { svc, transiciones } = crearServicio(EstadoPedido.REVISADO, ModoEntrega.KIOSKO);

      // Llamar: REVISADO → EN_ATENCION.
      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.EN_ATENCION } as never, usuario, {
        invalidarMonitor: true,
      } as never);
      expect(transiciones[0]).toEqual({
        de: EstadoPedido.REVISADO,
        a: EstadoPedido.EN_ATENCION,
      });

      // Deshacer la llamada: EN_ATENCION → REVISADO.
      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.REVISADO } as never, usuario, {
        invalidarMonitor: true,
      } as never);
      expect(transiciones[1]).toEqual({
        de: EstadoPedido.EN_ATENCION,
        a: EstadoPedido.REVISADO,
      });
    });

    it('desde EN_ATENCION se puede ajustar (vuelve a bodega) o enviar a pagar', async () => {
      const { svc, transiciones } = crearServicio(EstadoPedido.EN_ATENCION, ModoEntrega.KIOSKO);

      // El cliente pide cambios durante el recuento.
      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.EN_REVISION } as never, usuario, {
        asignacion: 'limpiar',
        reloj: 'reanudar',
      } as never);
      expect(transiciones[0]).toEqual({
        de: EstadoPedido.EN_ATENCION,
        a: EstadoPedido.EN_REVISION,
      });
    });

    it('desde EN_ATENCION se envía a pagar y AHÍ entra al ERP', async () => {
      const { svc, transiciones, encolados } = crearServicio(
        EstadoPedido.EN_ATENCION,
        ModoEntrega.KIOSKO,
      );

      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.PENDIENTE_PAGO } as never, usuario, {
        encolarFirebird: true,
        invalidarMonitor: true,
      } as never);

      expect(transiciones[0]).toEqual({
        de: EstadoPedido.EN_ATENCION,
        a: EstadoPedido.PENDIENTE_PAGO,
      });
      expect(encolados).toEqual([1]);
    });
  });
});
