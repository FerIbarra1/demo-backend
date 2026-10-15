import { EstadoPedido, ModoEntrega } from '@prisma/client';
import {
  destinoTrasSurtido,
  destinoTrasSurtidoIncompleto,
  clientePresenteEnTienda,
} from './destino-post-surtido.util';

/**
 * F18 (oct 2026): a dónde va un pedido cuando bodega cierra el surtido.
 *
 * El bug que estos tests fijan: F17 mandaba TODO pedido incompleto al área de
 * entrega (`REVISADO`), incluso el de un cliente ausente. Pero
 * `resolverPropuesta` exige `ESPERANDO_APROBACION`, así que la propuesta nacía
 * **irrespondible** — ni el cliente, ni el operador, ni el admin podían
 * decidirla, y el cliente nunca se enteraba de que su pedido estaba incompleto.
 *
 * La regla del negocio:
 *   completo                → REVISADO (área de entrega). Nadie aprueba nada.
 *   incompleto + PRESENTE   → REVISADO. Mostrador lo resuelve enfrente.
 *   incompleto + AUSENTE    → ESPERANDO_APROBACION. El cliente decide.
 */

describe('destinoTrasSurtido (surtido COMPLETO)', () => {
  it('un pedido de tienda va al área de entrega sin encolar al ERP', () => {
    for (const modo of [ModoEntrega.KIOSKO, ModoEntrega.RECOGER_TIENDA]) {
      expect(destinoTrasSurtido(modo)).toEqual({
        estado: EstadoPedido.REVISADO,
        encolarFirebird: false,
      });
    }
  });

  it('un pedido a domicilio va a pago con encolado inmediato', () => {
    expect(destinoTrasSurtido(ModoEntrega.DOMICILIO)).toEqual({
      estado: EstadoPedido.PENDIENTE_PAGO,
      encolarFirebird: true,
    });
  });

  it('el modo de entrega NO cambia el destino por tener faltantes', () => {
    // Un pedido a domicilio con faltante sigue yendo a pago: no hay cliente en
    // tienda a quien mostrarle nada, y el faltante se resuelve por el flujo de
    // propuesta async de siempre.
    expect(destinoTrasSurtidoIncompleto(ModoEntrega.DOMICILIO, false)).toEqual({
      estado: EstadoPedido.PENDIENTE_PAGO,
      encolarFirebird: true,
    });
  });
});

describe('destinoTrasSurtidoIncompleto', () => {
  it('cliente PRESENTE → área de entrega, sin esperar aprobación', () => {
    // Kiosko, o web con llegada vigente: el cliente está enfrente y el de
    // mostrador le dice qué faltó y lo resuelve. Los cambios de mostrador NO
    // necesitan aprobación del cliente.
    for (const modo of [ModoEntrega.KIOSKO, ModoEntrega.RECOGER_TIENDA]) {
      expect(destinoTrasSurtidoIncompleto(modo, true)).toEqual({
        estado: EstadoPedido.REVISADO,
        encolarFirebird: false,
      });
    }
  });

  it('cliente AUSENTE → espera su aprobación', () => {
    // El caso que arregla el bug: el pedido no puede ir al área de entrega
    // porque nadie lo va a resolver ahí — el cliente tiene que decidir desde su
    // app, y `resolverPropuesta` exige justo este estado.
    for (const modo of [ModoEntrega.KIOSKO, ModoEntrega.RECOGER_TIENDA]) {
      expect(destinoTrasSurtidoIncompleto(modo, false)).toEqual({
        estado: EstadoPedido.ESPERANDO_APROBACION,
        encolarFirebird: false,
      });
    }
  });

  it('NUNCA encola al ERP, esté presente o no', () => {
    // El ERP solo ve pedidos que el cliente ya confirmó. Un pedido incompleto
    // —y menos uno sin aprobar— no debe existir en Firebird.
    for (const modo of Object.values(ModoEntrega)) {
      expect(destinoTrasSurtidoIncompleto(modo, true).encolarFirebird).toBe(
        modo === ModoEntrega.DOMICILIO,
      );
      expect(destinoTrasSurtidoIncompleto(modo, false).encolarFirebird).toBe(
        modo === ModoEntrega.DOMICILIO,
      );
    }
  });
});

describe('clientePresenteEnTienda', () => {
  it('KIOSKO siempre: el pedido se hizo en la tienda', () => {
    expect(
      clientePresenteEnTienda({
        canalOrigen: 'KIOSKO',
        llegadaAnunciadaAt: null,
        llegadaDescartadaAt: null,
      }),
    ).toBe(true);
  });

  it('KIOSKO descartado: el cliente se fue, no está (F22)', () => {
    // Antes un kiosko era presente SIEMPRE y no había forma de decir "ya se fue".
    expect(
      clientePresenteEnTienda({
        canalOrigen: 'KIOSKO',
        llegadaAnunciadaAt: null,
        llegadaDescartadaAt: new Date(),
      }),
    ).toBe(false);
  });

  it('WEB con aviso vigente: el cliente está', () => {
    expect(
      clientePresenteEnTienda({
        canalOrigen: 'WEB',
        llegadaAnunciadaAt: new Date(),
        llegadaDescartadaAt: null,
      }),
    ).toBe(true);
  });

  it('WEB sin aviso: el cliente no está', () => {
    expect(
      clientePresenteEnTienda({
        canalOrigen: 'WEB',
        llegadaAnunciadaAt: null,
        llegadaDescartadaAt: null,
      }),
    ).toBe(false);
  });

  it('WEB con aviso DESCARTADO: el cliente se fue, no está', () => {
    // El operador descartó el aviso porque el cliente no apareció. Tratarlo
    // como presente mandaría el pedido al área de entrega a esperar a alguien
    // que ya se fue.
    expect(
      clientePresenteEnTienda({
        canalOrigen: 'WEB',
        llegadaAnunciadaAt: new Date(),
        llegadaDescartadaAt: new Date(),
      }),
    ).toBe(false);
  });
});
