import { EstadoPedido, ModoEntrega, CanalOrigen, Prisma } from '@prisma/client';
import { destinoTrasSurtido } from './destino-post-surtido.util';

/**
 * F16 (sep 2026): tests del camino COMPLETO del flujo nuevo.
 *
 * El plan (§5.3) pide probar el recorrido end-to-end:
 *   PENDING_REVIEW → REVIEWING → EN_MOSTRADOR → PENDING_PAID → PAID → COMPLETED
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
        transiciones.push({ de: estado, a: args.data.estado });
        estado = args.data.estado;
        return { count: 1 };
      }),
    },
    historialPedido: { create: jest.fn().mockResolvedValue({}) },
    pedidoPendienteEnvio: {
      create: jest.fn(async (args: any) => {
        encolados.push(args.data.pedidoId);
        return {};
      }),
    },
  };

  const prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) };

  // Import diferido para no acoplar el mock al constructor real.
  const { PedidoStateService } = require('./pedido-state.service');
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
        EstadoPedido.REVIEWING,
        ModoEntrega.KIOSKO,
      );

      // 1) Bodega confirma el surtido: el helper decide el destino.
      const destino = destinoTrasSurtido(ModoEntrega.KIOSKO);
      await svc.cambiarEstado(
        1,
        { nuevoEstado: destino.estado } as never,
        usuario,
        { asignacion: 'limpiar', reloj: 'detener', encolarFirebird: destino.encolarFirebird } as never,
      );

      expect(transiciones[0]).toEqual({
        de: EstadoPedido.REVIEWING,
        a: EstadoPedido.EN_MOSTRADOR,
      });
      // INVARIANTE: al entrar a mostrador NO se encola al ERP.
      expect(encolados).toHaveLength(0);

      // 2) Mostrador libera: AQUÍ entra al ERP.
      await svc.cambiarEstado(
        1,
        { nuevoEstado: EstadoPedido.PENDING_PAID } as never,
        usuario,
        { encolarFirebird: true, invalidarMonitor: true } as never,
      );

      expect(transiciones[1]).toEqual({
        de: EstadoPedido.EN_MOSTRADOR,
        a: EstadoPedido.PENDING_PAID,
      });
      expect(encolados).toEqual([1]);

      // 3) El webhook del ERP marca pagado.
      await svc.cambiarEstadoPorSistema(1, EstadoPedido.PAID, {
        usuarioNombre: 'AGENT_EXTERNAL',
      });
      expect(transiciones[2]).toEqual({
        de: EstadoPedido.PENDING_PAID,
        a: EstadoPedido.PAID,
      });

      // 4) Mostrador entrega.
      await svc.cambiarEstado(
        1,
        { nuevoEstado: EstadoPedido.COMPLETED } as never,
        usuario,
        {},
      );
      expect(transiciones[3]).toEqual({
        de: EstadoPedido.PAID,
        a: EstadoPedido.COMPLETED,
      });

      // El pedido se encoló UNA sola vez en todo el recorrido.
      expect(encolados).toHaveLength(1);
    });

    it('el ajuste devuelve el pedido a bodega y luego vuelve a mostrador', async () => {
      const { svc, transiciones, encolados } = crearServicio(
        EstadoPedido.EN_MOSTRADOR,
        ModoEntrega.KIOSKO,
      );

      // El cliente pide cambios → vuelve a bodega SIN encolar.
      await svc.cambiarEstado(
        1,
        { nuevoEstado: EstadoPedido.REVIEWING } as never,
        usuario,
        { asignacion: 'limpiar', reloj: 'reanudar' } as never,
      );
      expect(transiciones[0].a).toBe(EstadoPedido.REVIEWING);
      expect(encolados).toHaveLength(0);

      // Bodega surte lo nuevo → vuelve a mostrador, tampoco encola.
      const destino = destinoTrasSurtido(ModoEntrega.KIOSKO);
      await svc.cambiarEstado(
        1,
        { nuevoEstado: destino.estado } as never,
        usuario,
        { asignacion: 'limpiar', reloj: 'detener', encolarFirebird: destino.encolarFirebird } as never,
      );
      expect(transiciones[1].a).toBe(EstadoPedido.EN_MOSTRADOR);
      expect(encolados).toHaveLength(0);

      // El cliente queda conforme → libera → AHORA sí encola.
      await svc.cambiarEstado(
        1,
        { nuevoEstado: EstadoPedido.PENDING_PAID } as never,
        usuario,
        { encolarFirebird: true } as never,
      );
      expect(encolados).toEqual([1]);
    });

    it('cancelar desde mostrador NO encola al ERP', async () => {
      const { svc, encolados } = crearServicio(
        EstadoPedido.EN_MOSTRADOR,
        ModoEntrega.KIOSKO,
      );

      await svc.cambiarEstado(
        1,
        { nuevoEstado: EstadoPedido.CANCELLED } as never,
        usuario,
        { asignacion: 'limpiar', reloj: 'detener' } as never,
      );

      // El pedido nunca llegó al ERP, así que no hay nada que sincronizar.
      expect(encolados).toHaveLength(0);
    });
  });

  describe('pedido a domicilio (salta mostrador)', () => {
    it('va de bodega directo a pago con el encolado inmediato', async () => {
      const { svc, transiciones, encolados } = crearServicio(
        EstadoPedido.REVIEWING,
        ModoEntrega.DOMICILIO,
      );

      const destino = destinoTrasSurtido(ModoEntrega.DOMICILIO);
      await svc.cambiarEstado(
        1,
        { nuevoEstado: destino.estado } as never,
        usuario,
        { asignacion: 'limpiar', reloj: 'detener', encolarFirebird: destino.encolarFirebird } as never,
      );

      expect(transiciones[0]).toEqual({
        de: EstadoPedido.REVIEWING,
        a: EstadoPedido.PENDING_PAID,
      });
      // A diferencia del pedido de tienda, aquí SÍ se encola de inmediato:
      // no hay nada que mostrarle a un cliente que no está en la tienda.
      expect(encolados).toEqual([1]);
    });

    it('nunca pasa por EN_MOSTRADOR', async () => {
      const { svc, transiciones } = crearServicio(
        EstadoPedido.REVIEWING,
        ModoEntrega.DOMICILIO,
      );

      const destino = destinoTrasSurtido(ModoEntrega.DOMICILIO);
      await svc.cambiarEstado(
        1,
        { nuevoEstado: destino.estado } as never,
        usuario,
        { encolarFirebird: true } as never,
      );

      expect(transiciones.every((t) => t.a !== EstadoPedido.EN_MOSTRADOR)).toBe(true);
    });
  });

  describe('el invariante central: PENDING_PAID ⟺ encolado', () => {
    it('ningún camino llega a PENDING_PAID sin encolar', () => {
      // El helper es la garantía: `encolarFirebird` es true exactamente cuando
      // el destino es PENDING_PAID. Si alguien agrega un modo de entrega nuevo
      // y olvida la regla, este test lo atrapa.
      for (const modo of Object.values(ModoEntrega)) {
        const d = destinoTrasSurtido(modo);
        expect(d.encolarFirebird).toBe(d.estado === EstadoPedido.PENDING_PAID);
      }
    });

    it('un pedido en EN_MOSTRADOR nunca tiene fila en la cola del ERP', () => {
      // Consecuencia del helper: como EN_MOSTRADOR siempre va con
      // encolarFirebird=false, un pedido en ese estado no puede estar en el ERP.
      for (const modo of Object.values(ModoEntrega)) {
        const d = destinoTrasSurtido(modo);
        if (d.estado === EstadoPedido.EN_MOSTRADOR) {
          expect(d.encolarFirebird).toBe(false);
        }
      }
    });
  });
});
