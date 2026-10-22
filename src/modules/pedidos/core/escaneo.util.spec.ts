import { EstadoPedido, RolUsuario } from '@prisma/client';
import { responsableDe, puedeOperar, mensajeNoEsTuyo } from './escaneo.util';

/**
 * Oct 2026: la lógica que decide si el panel del escáner ofrece la acción
 * primaria o cae a solo lectura. Es lo que evita que escanear un pedido que no
 * te toca te deje en una página vacía.
 */
describe('responsableDe', () => {
  it('asigna cada estado al rol que lo opera', () => {
    expect(responsableDe(EstadoPedido.SOLICITADO).rol).toBe(RolUsuario.BODEGA);
    expect(responsableDe(EstadoPedido.EN_REVISION).rol).toBe(RolUsuario.BODEGA);
    expect(responsableDe(EstadoPedido.EN_ASESORIA).rol).toBe(RolUsuario.VENTAS);
    expect(responsableDe(EstadoPedido.REVISADO).rol).toBe(RolUsuario.MOSTRADOR);
    expect(responsableDe(EstadoPedido.PENDIENTE_PAGO).rol).toBe(RolUsuario.CAJERO);
    expect(responsableDe(EstadoPedido.PAGADO).rol).toBe(RolUsuario.MOSTRADOR);
  });

  it('no asigna responsable en estados terminales', () => {
    expect(responsableDe(EstadoPedido.ENTREGADO).rol).toBeNull();
    expect(responsableDe(EstadoPedido.CANCELADO).rol).toBeNull();
  });

  it('cubre TODOS los estados del enum', () => {
    // Un estado sin entrada dejaría el panel del escáner sin texto.
    for (const estado of Object.values(EstadoPedido)) {
      const r = responsableDe(estado);
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.queHace.length).toBeGreaterThan(0);
    }
  });

  it('el cliente es el responsable de una propuesta pendiente', () => {
    // No es un rol interno, pero el operador necesita saber que la pelota
    // no está de su lado.
    expect(responsableDe(EstadoPedido.ESPERANDO_APROBACION).rol).toBe(RolUsuario.CLIENTE);
  });
});

describe('puedeOperar', () => {
  it('el rol dueño del estado puede operar', () => {
    expect(puedeOperar(EstadoPedido.EN_REVISION, RolUsuario.BODEGA)).toBe(true);
    expect(puedeOperar(EstadoPedido.REVISADO, RolUsuario.MOSTRADOR)).toBe(true);
    expect(puedeOperar(EstadoPedido.PENDIENTE_PAGO, RolUsuario.CAJERO)).toBe(true);
  });

  it('un rol ajeno NO puede operar', () => {
    // El caso que motiva todo: bodega escanea un pedido que ya salió.
    expect(puedeOperar(EstadoPedido.REVISADO, RolUsuario.BODEGA)).toBe(false);
    expect(puedeOperar(EstadoPedido.PENDIENTE_PAGO, RolUsuario.MOSTRADOR)).toBe(false);
    expect(puedeOperar(EstadoPedido.EN_REVISION, RolUsuario.CAJERO)).toBe(false);
  });

  it('el GERENTE ve quién tiene el pedido pero no lo opera (sus acciones llegan aparte, con bitácora)', () => {
    for (const estado of Object.values(EstadoPedido)) {
      expect(puedeOperar(estado, RolUsuario.GERENTE)).toBe(false);
    }
  });

  it('ADMIN puede operar cualquier estado no terminal', () => {
    expect(puedeOperar(EstadoPedido.EN_REVISION, RolUsuario.ADMIN)).toBe(true);
    expect(puedeOperar(EstadoPedido.PENDIENTE_PAGO, RolUsuario.ADMIN)).toBe(true);
  });

  it('nadie opera un estado terminal, ni el ADMIN', () => {
    expect(puedeOperar(EstadoPedido.ENTREGADO, RolUsuario.ADMIN)).toBe(false);
    expect(puedeOperar(EstadoPedido.CANCELADO, RolUsuario.ADMIN)).toBe(false);
  });

  it('sin rol no se puede operar', () => {
    expect(puedeOperar(EstadoPedido.EN_REVISION, undefined)).toBe(false);
  });
});

describe('mensajeNoEsTuyo', () => {
  it('nombra al responsable en vez de dar un error seco', () => {
    // Patrón Toast KDS: "otra estación debe cumplir este ticket primero".
    expect(mensajeNoEsTuyo(EstadoPedido.REVISADO)).toMatch(/Mostrador/);
    expect(mensajeNoEsTuyo(EstadoPedido.PENDIENTE_PAGO)).toMatch(/Caja/);
    expect(mensajeNoEsTuyo(EstadoPedido.EN_REVISION)).toMatch(/Bodega/);
  });

  it('explica los estados terminales sin hablar de responsables', () => {
    expect(mensajeNoEsTuyo(EstadoPedido.ENTREGADO)).toMatch(/entregado/i);
    expect(mensajeNoEsTuyo(EstadoPedido.CANCELADO)).toMatch(/cancelado/i);
  });
});
