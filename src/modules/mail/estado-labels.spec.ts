import { EstadoPedido } from '@prisma/client';
import { ESTADO_PEDIDO_LABELS, estadoPedidoLabel } from './estado-labels';

/**
 * El nombre de cada estado para el cliente. La MISMA tabla que `ETIQUETA_ESTADO` del frontend
 * (`demo-frontend/src/lib/utils/seguimiento.ts`, probada en `scripts/test-seguimiento.ts` con estos mismos valores).
 */
describe('ESTADO_PEDIDO_LABELS', () => {
  it('la tabla exacta (si cambia un valor, cámbialo también en el frontend)', () => {
    expect(ESTADO_PEDIDO_LABELS).toEqual({
      SOLICITADO: 'Recibido',
      EN_REVISION: 'En preparación',
      ESPERANDO_APROBACION: 'Pendiente de aprobación',
      EN_ASESORIA: 'Con un asesor de ventas',
      EN_DTF: 'En impresión DTF',
      REVISADO: 'Listo en tienda',
      EN_ATENCION: 'En atención en mostrador',
      PENDIENTE_PAGO: 'Pendiente de pago',
      PAGADO: 'Pagado',
      ENVIADO: 'Enviado',
      ENTREGADO: 'Entregado',
      CANCELADO: 'Cancelado',
    });
  });

  it('hay una etiqueta por cada estado del enum (un estado nuevo no puede quedar sin nombre)', () => {
    expect(Object.keys(ESTADO_PEDIDO_LABELS).sort()).toEqual(Object.values(EstadoPedido).sort());
  });

  it('voz neutra y sin jerga: ni "tu", ni imperativos, ni nombres internos', () => {
    for (const texto of Object.values(ESTADO_PEDIDO_LABELS)) {
      expect(texto).not.toMatch(/\btu\b|\bte\b|\btus\b|revísalo/i);
      expect(texto).not.toMatch(/bodega|plancha|vfp|firebird|erp/i);
    }
  });

  it('un estado desconocido no tumba nada: devuelve el valor crudo', () => {
    expect(estadoPedidoLabel('REVISADO')).toBe('Listo en tienda');
    expect(estadoPedidoLabel('ALGO_NUEVO')).toBe('ALGO_NUEVO');
  });
});
