import { EstadoPedido } from '@prisma/client';
import { derivarMotivoReingreso } from './motivo-reingreso';

/**
 * F17 (oct 2026): la derivación de "por qué este pedido está en la cola".
 *
 * Se extrajo del monitor de bodega porque ahora la cola de `/bodega` la usa
 * para pintar el badge "Liberado por Ana". Estos tests fijan el contrato para
 * que los dos consumidores no puedan divergir.
 *
 * Los tres motivos y lo que significan para el bodeguero:
 *   LIBERADO         — otro lo soltó. Nada nuevo que surtir.
 *   AJUSTE_MOSTRADOR — el cliente cambió algo. Surtir lo nuevo.
 *   PROPUESTA_VENTAS — el cliente aprobó la contrapropuesta. Surtir lo propuesto.
 */

/** Un pedido en la cola, con los defaults que no importan para cada caso. */
function pedido(over: Partial<Parameters<typeof derivarMotivoReingreso>[0]> = {}) {
  return {
    estado: EstadoPedido.EN_REVISION,
    asignadoAId: null,
    items: [{ original: true }],
    historial: [{ estadoAnterior: EstadoPedido.SOLICITADO }],
    ...over,
  };
}

describe('derivarMotivoReingreso', () => {
  it('un pedido nuevo (nunca salió de bodega) no tiene motivo', () => {
    // Su último cambio fue SOLICITADO → EN_REVISION: lo acaba de tomar nadie,
    // es la primera vez que entra a bodega.
    expect(derivarMotivoReingreso(pedido())).toBeNull();
  });

  it('LIBERADO cuando el último cambio fue EN_REVISION → EN_REVISION', () => {
    // `liberarPedido` NO escribe estado: deja una auto-transición en el
    // historial. Ese es el discriminador.
    expect(
      derivarMotivoReingreso(
        pedido({ historial: [{ estadoAnterior: EstadoPedido.EN_REVISION }] }),
      ),
    ).toBe('LIBERADO');
  });

  it('AJUSTE_MOSTRADOR cuando hay items nuevos y viene del área de entrega', () => {
    expect(
      derivarMotivoReingreso(
        pedido({
          items: [{ original: true }, { original: false }],
          historial: [{ estadoAnterior: EstadoPedido.REVISADO }],
        }),
      ),
    ).toBe('AJUSTE_MOSTRADOR');
  });

  it('PROPUESTA_VENTAS cuando hay items nuevos y viene de una propuesta', () => {
    expect(
      derivarMotivoReingreso(
        pedido({
          items: [{ original: false }],
          historial: [{ estadoAnterior: EstadoPedido.ESPERANDO_APROBACION }],
        }),
      ),
    ).toBe('PROPUESTA_VENTAS');
  });

  it('ASESORIA cuando el asesor devolvió el pedido a bodega', () => {
    // Oct 2026: el asesor revisó con el cliente y el pedido original estaba
    // bien, así que lo manda de vuelta a bodega. NO agrega items (por eso el
    // caso no exige `itemsNuevos`), pero el bodeguero necesita saber que el
    // pedido ya pasó por ventas — si no, lo trata como nuevo.
    expect(
      derivarMotivoReingreso(
        pedido({
          items: [{ original: true }],
          historial: [{ estadoAnterior: EstadoPedido.EN_ASESORIA }],
        }),
      ),
    ).toBe('ASESORIA');
  });

  it('ASESORIA gana sobre LIBERADO si el asesor devolvió un pedido ya tocado', () => {
    // El orden importa: EN_ASESORIA se evalúa antes que EN_REVISION. Si se
    // invirtiera, un pedido devuelto por el asesor se leería como "otro
    // bodeguero lo soltó" y el bodeguero no sabría que ventas ya lo revisó.
    expect(
      derivarMotivoReingreso(
        pedido({ historial: [{ estadoAnterior: EstadoPedido.EN_ASESORIA }] }),
      ),
    ).not.toBe('LIBERADO');
  });

  it('un pedido ASIGNADO no tiene motivo: vive en el slot del bodeguero', () => {
    // El motivo describe por qué está EN LA COLA. Si ya lo tomó alguien, la
    // pregunta no aplica — y pintar "Liberado por Ana" en un pedido que Ana
    // está surtiendo ahora mismo sería confuso.
    expect(
      derivarMotivoReingreso(
        pedido({
          asignadoAId: 42,
          historial: [{ estadoAnterior: EstadoPedido.EN_REVISION }],
        }),
      ),
    ).toBeNull();
  });

  it('un pedido fuera de EN_REVISION no tiene motivo', () => {
    for (const estado of [
      EstadoPedido.SOLICITADO,
      EstadoPedido.REVISADO,
      EstadoPedido.PENDIENTE_PAGO,
      EstadoPedido.ENTREGADO,
    ]) {
      expect(
        derivarMotivoReingreso(
          pedido({
            estado,
            historial: [{ estadoAnterior: EstadoPedido.EN_REVISION }],
          }),
        ),
      ).toBeNull();
    }
  });

  it('sin historial no revienta y devuelve null', () => {
    expect(derivarMotivoReingreso(pedido({ historial: [] }))).toBeNull();
  });

  it('items nuevos SIN el estado anterior correcto no inventan un motivo', () => {
    // El discriminador son las DOS condiciones. Un item nuevo que llegó por un
    // camino que no conocemos no debe etiquetarse como ajuste del cliente.
    expect(
      derivarMotivoReingreso(
        pedido({
          items: [{ original: false }],
          historial: [{ estadoAnterior: EstadoPedido.SOLICITADO }],
        }),
      ),
    ).toBeNull();
  });
});
