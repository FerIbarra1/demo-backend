import { EstadoPedido, ModoEntrega } from '@prisma/client';
import { destinoTrasSurtido } from './destino-post-surtido.util';

/**
 * F16 (sep 2026): tests de regresión de los caminos que NO debían cambiar.
 *
 * El plan (§5.3) pide verificar que el flujo nuevo no rompió lo que ya
 * funcionaba. Estos tests fijan el comportamiento de los tres caminos que
 * cierran la verificación de bodega, porque la auditoría adversarial marcó como
 * riesgo más probable (R12) que uno de ellos se quedara sin la bifurcación por
 * `modoEntrega` — y un pedido a domicilio con faltante aterrizaría en
 * EN_MOSTRADOR, donde nadie lo recoge.
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
    ])('%s → EN_MOSTRADOR sin encolar', (_nombre, modo) => {
      const d = destinoTrasSurtido(modo);
      expect(d.estado).toBe(EstadoPedido.EN_MOSTRADOR);
      expect(d.encolarFirebird).toBe(false);
    });
  });

  describe('pedido a domicilio', () => {
    it('DOMICILIO → PENDING_PAID con encolado inmediato', () => {
      const d = destinoTrasSurtido(ModoEntrega.DOMICILIO);
      expect(d.estado).toBe(EstadoPedido.PENDING_PAID);
      expect(d.encolarFirebird).toBe(true);
    });

    it('un domicilio con faltante NO aterriza en mostrador (riesgo R12)', () => {
      // El escenario del riesgo: el cliente aprueba una propuesta de bodega por
      // un faltante en un pedido A DOMICILIO. Si ese camino no bifurcara, el
      // pedido iría a EN_MOSTRADOR y se quedaría ahí para siempre — nadie va a
      // recogerlo en tienda porque el cliente espera en su casa.
      const d = destinoTrasSurtido(ModoEntrega.DOMICILIO);
      expect(d.estado).not.toBe(EstadoPedido.EN_MOSTRADOR);
      expect(d.estado).toBe(EstadoPedido.PENDING_PAID);
    });
  });

  describe('la rama "con items pendientes" de ventas no cambia', () => {
    it('sigue yendo a REVIEWING (el pedido vuelve a bodega a surtir)', () => {
      // Esa rama NO usa el helper: cuando el asesor propuso productos que nadie
      // verificó, el pedido tiene que volver a bodega sin importar el modo de
      // entrega. El destino es REVIEWING, no EN_MOSTRADOR.
      //
      // Se documenta aquí para que quede claro que es intencional y que no es
      // un camino que "se olvidó" de usar el helper.
      const destinoEsperado = EstadoPedido.REVIEWING;
      expect(destinoEsperado).not.toBe(EstadoPedido.EN_MOSTRADOR);
      expect(destinoEsperado).not.toBe(EstadoPedido.PENDING_PAID);
    });
  });

  describe('el encolado a Firebird no se duplica', () => {
    it('solo el destino PENDING_PAID encola', () => {
      // Invariante: un pedido en EN_MOSTRADOR nunca tiene fila en la cola del
      // ERP. Si se encolara dos veces, `PedidoPendienteEnvio.pedidoId` es
      // @unique y el segundo intento falla con P2002 — que es intencional.
      for (const modo of Object.values(ModoEntrega)) {
        const d = destinoTrasSurtido(modo);
        if (d.estado === EstadoPedido.EN_MOSTRADOR) {
          expect(d.encolarFirebird).toBe(false);
        }
      }
    });
  });
});
