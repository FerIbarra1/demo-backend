import { EstadoPedido, RolUsuario } from '@prisma/client';
import { responsableDe, puedeOperar, mensajeNoEsTuyo } from './escaneo.util';

/**
 * Oct 2026: la lógica que decide si el panel del escáner ofrece la acción
 * primaria o cae a solo lectura. Es lo que evita que escanear un pedido que no
 * te toca te deje en una página vacía.
 */
describe('responsableDe', () => {
  it('asigna cada estado al rol que lo opera', () => {
    expect(responsableDe(EstadoPedido.PENDING_REVIEW).rol).toBe(RolUsuario.BODEGA);
    expect(responsableDe(EstadoPedido.REVIEWING).rol).toBe(RolUsuario.BODEGA);
    expect(responsableDe(EstadoPedido.EN_ASESORIA).rol).toBe(RolUsuario.VENTAS);
    expect(responsableDe(EstadoPedido.EN_MOSTRADOR).rol).toBe(RolUsuario.MOSTRADOR);
    expect(responsableDe(EstadoPedido.PENDING_PAID).rol).toBe(RolUsuario.CAJERO);
    expect(responsableDe(EstadoPedido.PAID).rol).toBe(RolUsuario.MOSTRADOR);
  });

  it('no asigna responsable en estados terminales', () => {
    expect(responsableDe(EstadoPedido.COMPLETED).rol).toBeNull();
    expect(responsableDe(EstadoPedido.CANCELLED).rol).toBeNull();
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
    expect(responsableDe(EstadoPedido.WAITING_CUSTOMER_APPROVAL).rol).toBe(RolUsuario.CLIENTE);
  });
});

describe('puedeOperar', () => {
  it('el rol dueño del estado puede operar', () => {
    expect(puedeOperar(EstadoPedido.REVIEWING, RolUsuario.BODEGA)).toBe(true);
    expect(puedeOperar(EstadoPedido.EN_MOSTRADOR, RolUsuario.MOSTRADOR)).toBe(true);
    expect(puedeOperar(EstadoPedido.PENDING_PAID, RolUsuario.CAJERO)).toBe(true);
  });

  it('un rol ajeno NO puede operar', () => {
    // El caso que motiva todo: bodega escanea un pedido que ya salió.
    expect(puedeOperar(EstadoPedido.EN_MOSTRADOR, RolUsuario.BODEGA)).toBe(false);
    expect(puedeOperar(EstadoPedido.PENDING_PAID, RolUsuario.MOSTRADOR)).toBe(false);
    expect(puedeOperar(EstadoPedido.REVIEWING, RolUsuario.CAJERO)).toBe(false);
  });

  it('ADMIN puede operar cualquier estado no terminal', () => {
    expect(puedeOperar(EstadoPedido.REVIEWING, RolUsuario.ADMIN)).toBe(true);
    expect(puedeOperar(EstadoPedido.PENDING_PAID, RolUsuario.ADMIN)).toBe(true);
  });

  it('nadie opera un estado terminal, ni el ADMIN', () => {
    expect(puedeOperar(EstadoPedido.COMPLETED, RolUsuario.ADMIN)).toBe(false);
    expect(puedeOperar(EstadoPedido.CANCELLED, RolUsuario.ADMIN)).toBe(false);
  });

  it('sin rol no se puede operar', () => {
    expect(puedeOperar(EstadoPedido.REVIEWING, undefined)).toBe(false);
  });
});

describe('mensajeNoEsTuyo', () => {
  it('nombra al responsable en vez de dar un error seco', () => {
    // Patrón Toast KDS: "otra estación debe cumplir este ticket primero".
    expect(mensajeNoEsTuyo(EstadoPedido.EN_MOSTRADOR)).toMatch(/Mostrador/);
    expect(mensajeNoEsTuyo(EstadoPedido.PENDING_PAID)).toMatch(/Caja/);
    expect(mensajeNoEsTuyo(EstadoPedido.REVIEWING)).toMatch(/Bodega/);
  });

  it('explica los estados terminales sin hablar de responsables', () => {
    expect(mensajeNoEsTuyo(EstadoPedido.COMPLETED)).toMatch(/entregado/i);
    expect(mensajeNoEsTuyo(EstadoPedido.CANCELLED)).toMatch(/cancelado/i);
  });
});
