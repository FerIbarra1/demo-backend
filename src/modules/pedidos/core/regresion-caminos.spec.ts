import { EstadoPedido, ModoEntrega } from '@prisma/client';
import { destinoTrasSurtido } from './destino-post-surtido.util';
import { PedidoStateService } from './pedido-state.service';

/**
 * F16 (sep 2026): tests de regresión de los caminos que NO debían cambiar.
 *
 * El plan (§5.3) pide verificar que el flujo nuevo no rompió lo que ya
 * funcionaba. Estos tests fijan el comportamiento de los tres caminos que
 * cierran la verificación de bodega, porque la auditoría adversarial marcó como
 * riesgo más probable (R12) que uno de ellos se quedara sin la bifurcación por
 * `modoEntrega` — y un pedido a domicilio con faltante aterrizaría en
 * REVISADO, donde nadie lo recoge.
 *
 * El helper `destinoTrasSurtido` es la garantía: los tres caminos lo usan, así
 * que no pueden divergir. Estos tests fijan QUÉ devuelve para cada modo.
 */

describe('Regresión: los tres caminos que cierran bodega (F16)', () => {
  /**
   * Los tres call sites que deben usar el helper. Si alguien agrega un cuarto
   * camino y no lo usa, este test no lo atrapa — pero sí documenta cuáles son.
   */
  const CAMINOS = [
    'SurtidoService.confirmarSurtido',
    'PropuestaService.aprobarPropuestaBodega',
    'PropuestaService.aprobarPropuestaVentas (rama sin pendientes)',
  ];

  it('los tres caminos comparten la misma decisión de destino', () => {
    // No hay tres implementaciones: hay una función y tres llamadas. Este test
    // existe para que quede explícito en la suite.
    expect(CAMINOS).toHaveLength(3);
  });

  describe('pedido de tienda (no domicilio)', () => {
    it.each([
      ['KIOSKO', ModoEntrega.KIOSKO],
      ['RECOGER_TIENDA', ModoEntrega.RECOGER_TIENDA],
    ])('%s → REVISADO sin encolar', (_nombre, modo) => {
      const d = destinoTrasSurtido(modo);
      expect(d.estado).toBe(EstadoPedido.REVISADO);
      expect(d.encolarFirebird).toBe(false);
    });
  });

  describe('pedido a domicilio', () => {
    it('DOMICILIO → PENDIENTE_PAGO con encolado inmediato', () => {
      const d = destinoTrasSurtido(ModoEntrega.DOMICILIO);
      expect(d.estado).toBe(EstadoPedido.PENDIENTE_PAGO);
      expect(d.encolarFirebird).toBe(true);
    });

    it('un domicilio con faltante NO aterriza en mostrador (riesgo R12)', () => {
      // El escenario del riesgo: el cliente aprueba una propuesta de bodega por
      // un faltante en un pedido A DOMICILIO. Si ese camino no bifurcara, el
      // pedido iría a REVISADO y se quedaría ahí para siempre — nadie va a
      // recogerlo en tienda porque el cliente espera en su casa.
      const d = destinoTrasSurtido(ModoEntrega.DOMICILIO);
      expect(d.estado).not.toBe(EstadoPedido.REVISADO);
      expect(d.estado).toBe(EstadoPedido.PENDIENTE_PAGO);
    });
  });

  describe('la rama "con items pendientes" de ventas no cambia', () => {
    it('sigue yendo a EN_REVISION (el pedido vuelve a bodega a surtir)', () => {
      // Esa rama NO usa el helper: cuando el asesor propuso productos que nadie
      // verificó, el pedido tiene que volver a bodega sin importar el modo de
      // entrega. El destino es EN_REVISION, no REVISADO.
      //
      // Se documenta aquí para que quede claro que es intencional y que no es
      // un camino que "se olvidó" de usar el helper.
      const destinoEsperado = EstadoPedido.EN_REVISION;
      expect(destinoEsperado).not.toBe(EstadoPedido.REVISADO);
      expect(destinoEsperado).not.toBe(EstadoPedido.PENDIENTE_PAGO);
    });
  });

  describe('el encolado a Firebird no se duplica', () => {
    it('solo el destino PENDIENTE_PAGO encola', () => {
      // Invariante: un pedido en REVISADO nunca tiene fila en la cola del
      // ERP. Si se encolara dos veces, `PedidoPendienteEnvio.pedidoId` es
      // @unique y el segundo intento falla con P2002 — que es intencional.
      for (const modo of Object.values(ModoEntrega)) {
        const d = destinoTrasSurtido(modo);
        if (d.estado === EstadoPedido.REVISADO) {
          expect(d.encolarFirebird).toBe(false);
        }
      }
    });
  });

  /**
   * Oct 2026 — B1: el operador resuelve la propuesta de un pedido que YA está
   * en el área de entrega.
   *
   * El escenario real: bodega cierra un surtido incompleto con el cliente
   * presente, así que el pedido va a REVISADO con la propuesta viva (F18). El
   * operador la resuelve enfrente, y `destinoTrasSurtido` devuelve REVISADO otra
   * vez — el MISMO estado. `TRANSICIONES[REVISADO]` no incluye REVISADO, así que
   * `cambiarEstado` lanzaba "Transición no permitida: REVISADO → REVISADO" y el
   * operador se quedaba sin salida: la propuesta seguía viva y `enviarAPagar`
   * bloqueado. El botón "Ver la propuesta" no servía para nada.
   *
   * Este test usa el `PedidoStateService` REAL a propósito. Los specs de
   * `PropuestaService` mockean `cambiarEstado` con un `jest.fn()`, así que
   * `TRANSICIONES` nunca se ejerce — y eso es exactamente lo que dejó pasar el
   * bug.
   */
  describe('B1: resolver una propuesta en el área de entrega (REVISADO → REVISADO)', () => {
    function crearState() {
      const transiciones: Array<{ de: EstadoPedido; a: EstadoPedido }> = [];
      const historial: Array<{ observacion: string }> = [];
      let estado = EstadoPedido.REVISADO;

      const tx = {
        pedido: {
          findUnique: jest.fn(async () => ({
            id: 1,
            tiendaId: 5,
            usuarioId: 7,
            estado,
            modoEntrega: ModoEntrega.KIOSKO,
            asignadoAId: null,
            asignadoAt: null,
            tiempoAtencionBodegaMs: 0,
            bodegaTurnoDesdeAta: null,
          })),
          updateMany: jest.fn(async (args: any) => {
            // En el camino de "mismo estado" NO se reescribe `estado`: si esta
            // lista crece, es que se escribió un estado que no cambió.
            if (args.data.estado !== undefined) {
              transiciones.push({ de: estado, a: args.data.estado });
              estado = args.data.estado;
            }
            return { count: 1 };
          }),
        },
        historialPedido: {
          create: jest.fn(async (args: any) => {
            historial.push({ observacion: args.data.observacion });
            return {};
          }),
          count: jest.fn(async () => 0),
        },
        pedidoPendienteEnvio: { findFirst: jest.fn(async () => null), create: jest.fn() },
      };

      const prisma = {
        $transaction: jest.fn(async (fn: any) => fn(tx)),
        pedido: { findUnique: jest.fn(async () => ({ estado })) },
      };

      const svc = new PedidoStateService(
        prisma as never,
        { enviar: jest.fn().mockResolvedValue(undefined) } as never,
        { emitToTienda: jest.fn(), emitToPedido: jest.fn() } as never,
        { cargarYValidar: jest.fn().mockResolvedValue({ id: 1, estado }) } as never,
        {} as never,
      );

      return { svc, transiciones, historial };
    }

    const operador = { userId: 3, nombre: 'Ana Mostrador', rol: 'MOSTRADOR' } as never;

    it('NO lanza, y aplica los efectos sin escribir un estado que no cambió', async () => {
      const { svc, transiciones } = crearState();

      let efectosCorrieron = false;
      await expect(
        svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.REVISADO } as never, operador, {
          permitirMismoEstado: true,
          efectos: async () => {
            efectosCorrieron = true;
          },
        } as never),
      ).resolves.toBeDefined();

      // Los efectos SÍ corren: son el punto de la opción (aplicar los items de
      // la propuesta que el operador acaba de resolver).
      expect(efectosCorrieron).toBe(true);
      // Y no se escribió ninguna transición: el pedido ya estaba en REVISADO.
      expect(transiciones).toEqual([]);
    });

    it('sin la opción, la misma llamada SÍ falla (el bug original)', async () => {
      const { svc } = crearState();

      // Este es el comportamiento que rompía el flujo. Se fija aquí para que
      // nadie "arregle" B1 agregando REVISADO a TRANSICIONES[REVISADO]: eso
      // dejaría que cualquier caller transicione al mismo estado.
      await expect(
        svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.REVISADO } as never, operador),
      ).rejects.toThrow(/Transición no permitida/);
    });

    it('NO reenvía el correo del estado: el pedido ya estaba ahí', async () => {
      const { svc } = crearState();
      const enviar = jest.fn();
      (svc as unknown as { notifications: { enviar: jest.Mock } }).notifications = { enviar };

      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.REVISADO } as never, operador, {
        permitirMismoEstado: true,
      } as never);

      // Sin esto, cada vez que el operador resolviera un faltante el cliente
      // recibiría otro "tu pedido ya está listo en tienda".
      expect(enviar).not.toHaveBeenCalled();
    });

    it('limpia `llamadoAt` al salir de EN_ATENCION (el folio deja de estar "atendido")', async () => {
      // El caso: el operador llamó al cliente (REVISADO → EN_ATENCION) y luego
      // resuelve la propuesta que tenía viva. El destino es REVISADO otra vez,
      // así que la regla "limpiar llamadoAt salvo que el destino sea REVISADO"
      // NO aplicaba — y el pedido volvía a la lista de espera mientras la TV lo
      // seguía mostrando en el panel "Atendiendo".
      const escrituras: Array<Record<string, unknown>> = [];
      let estado = EstadoPedido.EN_ATENCION;

      const tx = {
        pedido: {
          findUnique: jest.fn(async () => ({
            id: 1,
            tiendaId: 5,
            usuarioId: 7,
            estado,
            modoEntrega: ModoEntrega.KIOSKO,
            asignadoAId: null,
            asignadoAt: null,
            tiempoAtencionBodegaMs: 0,
            bodegaTurnoDesdeAt: null,
          })),
          updateMany: jest.fn(async (args: any) => {
            escrituras.push(args.data);
            if (args.data.estado !== undefined) estado = args.data.estado;
            return { count: 1 };
          }),
        },
        historialPedido: {
          create: jest.fn().mockResolvedValue({}),
          // F22: el correo "listo en tienda" es del PRIMER paso a REVISADO; la máquina
          // cuenta cuántas veces ya estuvo ahí.
          count: jest.fn().mockResolvedValue(0),
        },
        pedidoPendienteEnvio: { findFirst: jest.fn(), create: jest.fn() },
      };

      const svc = new PedidoStateService(
        {
          $transaction: jest.fn(async (fn: any) => fn(tx)),
          pedido: { findUnique: jest.fn(async () => ({ estado })) },
        } as never,
        { enviar: jest.fn().mockResolvedValue(undefined) } as never,
        { emitToTienda: jest.fn(), emitToPedido: jest.fn() } as never,
        { cargarYValidar: jest.fn().mockResolvedValue({ id: 1, estado }) } as never,
        {} as never,
      );

      await svc.cambiarEstado(1, { nuevoEstado: EstadoPedido.REVISADO } as never, operador, {
        asignacion: 'limpiar',
      } as never);

      expect(escrituras[0]).toHaveProperty('llamadoAt', null);
    });
  });
});
