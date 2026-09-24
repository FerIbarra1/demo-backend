import { EstadoPedido, ModoEntrega } from '@prisma/client';
import { destinoTrasSurtido } from './destino-post-surtido.util';

/**
 * F16 (sep 2026): tests del helper que decide a dónde va el pedido cuando
 * bodega (o ventas) termina de verificar.
 *
 * Es el guard de regresión del riesgo R12 del plan: si la bifurcación por
 * `modoEntrega` se aplica en `confirmarSurtido` pero NO en los caminos de
 * propuesta, un pedido a domicilio con faltante aterriza en EN_MOSTRADOR y
 * queda atorado — nadie lo recoge en tienda. Por eso la decisión vive en un
 * solo lugar y estos tests la fijan.
 */
describe('destinoTrasSurtido (F16)', () => {
  it('un pedido a DOMICILIO va a PENDING_PAID con encolado inmediato', () => {
    const destino = destinoTrasSurtido(ModoEntrega.DOMICILIO);
    expect(destino.estado).toBe(EstadoPedido.PENDING_PAID);
    expect(destino.encolarFirebird).toBe(true);
  });

  it('un pedido de KIOSKO va a EN_MOSTRADOR SIN encolar', () => {
    const destino = destinoTrasSurtido(ModoEntrega.KIOSKO);
    expect(destino.estado).toBe(EstadoPedido.EN_MOSTRADOR);
    // Crítico: si esto fuera true, el ERP vería el pedido antes de que el
    // cliente lo confirme, y un ajuste en mostrador lo dejaría desincronizado.
    expect(destino.encolarFirebird).toBe(false);
  });

  it('un pedido de RECOGER_TIENDA va a EN_MOSTRADOR SIN encolar', () => {
    const destino = destinoTrasSurtido(ModoEntrega.RECOGER_TIENDA);
    expect(destino.estado).toBe(EstadoPedido.EN_MOSTRADOR);
    expect(destino.encolarFirebird).toBe(false);
  });

  it('el encolado a Firebird solo ocurre en el camino a PENDING_PAID', () => {
    // Invariante del plan: "PENDING_PAID ⟺ fila en PedidoPendienteEnvio".
    // Si algún modo llegara a PENDING_PAID sin encolar, el pedido sería
    // invisible al agente y se quedaría atascado para siempre.
    for (const modo of Object.values(ModoEntrega)) {
      const destino = destinoTrasSurtido(modo);
      expect(destino.encolarFirebird).toBe(
        destino.estado === EstadoPedido.PENDING_PAID,
      );
    }
  });

  it('solo DOMICILIO salta mostrador', () => {
    for (const modo of Object.values(ModoEntrega)) {
      const destino = destinoTrasSurtido(modo);
      if (modo === ModoEntrega.DOMICILIO) {
        expect(destino.estado).toBe(EstadoPedido.PENDING_PAID);
      } else {
        expect(destino.estado).toBe(EstadoPedido.EN_MOSTRADOR);
      }
    }
  });
});
