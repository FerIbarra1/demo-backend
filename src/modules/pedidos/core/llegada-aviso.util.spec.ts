import { EstadoPedido, ModoEntrega } from '@prisma/client';
import { motivoNoAvisable } from './llegada-aviso.util';

/**
 * Oct 2026: la regla de "¿este pedido ya se puede avisar en tienda?" vivía
 * duplicada en `kiosko-llegada.service.ts` y en `cliente.service.ts`, con mapas
 * de mensajes que ya habían divergido. Con un tercer camino (mostrador) se
 * centralizó aquí. Estos tests fijan la regla en un solo lugar.
 */
describe('motivoNoAvisable', () => {
  const base = {
    estado: EstadoPedido.EN_MOSTRADOR,
    modoEntrega: ModoEntrega.RECOGER_TIENDA,
  };

  it('deja pasar un pedido listo para recoger en tienda', () => {
    expect(motivoNoAvisable(base)).toBeNull();
  });

  it('deja pasar un pedido de kiosko listo', () => {
    expect(
      motivoNoAvisable({ ...base, modoEntrega: ModoEntrega.KIOSKO }),
    ).toBeNull();
  });

  it('rechaza un pedido a domicilio aunque esté listo', () => {
    const motivo = motivoNoAvisable({
      ...base,
      modoEntrega: ModoEntrega.DOMICILIO,
    });
    expect(motivo?.codigo).toBe('ES_A_DOMICILIO');
    expect(motivo?.message).toMatch(/domicilio/i);
  });

  it.each([
    ['PENDING_REVIEW', EstadoPedido.PENDING_REVIEW],
    ['REVIEWING', EstadoPedido.REVIEWING],
    ['WAITING_CUSTOMER_APPROVAL', EstadoPedido.WAITING_CUSTOMER_APPROVAL],
    ['EN_ASESORIA', EstadoPedido.EN_ASESORIA],
    ['PENDING_PAID', EstadoPedido.PENDING_PAID],
    ['PAID', EstadoPedido.PAID],
    ['SHIPPED', EstadoPedido.SHIPPED],
  ])('rechaza el aviso en %s con AUN_NO_ESTA_LISTO', (_n, estado) => {
    const motivo = motivoNoAvisable({ ...base, estado });
    expect(motivo?.codigo).toBe('AUN_NO_ESTA_LISTO');
    expect(motivo?.message.length).toBeGreaterThan(0);
  });

  it('distingue un pedido ya entregado de uno cancelado', () => {
    // El frontend usa el `codigo` para elegir el copy, así que no pueden
    // colapsarse en el mismo valor.
    expect(
      motivoNoAvisable({ ...base, estado: EstadoPedido.COMPLETED })?.codigo,
    ).toBe('YA_ENTREGADO');
    expect(
      motivoNoAvisable({ ...base, estado: EstadoPedido.CANCELLED })?.codigo,
    ).toBe('CANCELADO');
  });

  it('da un mensaje para TODOS los estados no avisables', () => {
    // Un estado sin mensaje cae al genérico; lo que no puede pasar es que el
    // cliente vea un texto vacío.
    for (const estado of Object.values(EstadoPedido)) {
      if (estado === EstadoPedido.EN_MOSTRADOR) continue;
      const motivo = motivoNoAvisable({ ...base, estado });
      expect(motivo?.message.trim().length).toBeGreaterThan(0);
    }
  });
});
