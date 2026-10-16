import { PedidoStateService } from './pedido-state.service';
import {
  OFFSET_ID_PEDIDO_NUBE,
  esIdPreasignadoPorLaNube,
  pedidoIdDesdeIdPreasignado,
} from './id-pedido-externo.util';

describe('id-pedido-externo.util', () => {
  it('la máquina de estados pre-asigna el ID con ESTE offset', async () => {
    // Antes el literal estaba duplicado aquí y en el handler de pagos, y un spec leía el
    // código fuente para compararlos. Ahora hay una sola constante; este test comprueba
    // que `encolarEnvioAFirebird` realmente la usa.
    const create = jest.fn().mockResolvedValue({});
    const estado = new PedidoStateService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    await estado.encolarEnvioAFirebird({ pedidoPendienteEnvio: { create } } as never, 42);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pedidoId: 42,
        externalIdPEDIDOS: OFFSET_ID_PEDIDO_NUBE + 42,
      }),
    });
  });

  it('reconoce el rango pre-asignado y sabe volver al pedido', () => {
    expect(esIdPreasignadoPorLaNube(OFFSET_ID_PEDIDO_NUBE + 1)).toBe(true);
    expect(esIdPreasignadoPorLaNube(OFFSET_ID_PEDIDO_NUBE)).toBe(true);
    expect(esIdPreasignadoPorLaNube(9_999_999)).toBe(false);
    expect(esIdPreasignadoPorLaNube(Number.NaN)).toBe(false);
    expect(pedidoIdDesdeIdPreasignado(OFFSET_ID_PEDIDO_NUBE + 123)).toBe(123);
  });

  it('el offset sigue en 1B: cambiarlo rompe los IDs ya asignados en Firebird', () => {
    expect(OFFSET_ID_PEDIDO_NUBE).toBe(1_000_000_000);
  });
});
