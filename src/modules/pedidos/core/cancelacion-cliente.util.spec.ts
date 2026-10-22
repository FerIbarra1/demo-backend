import { EstadoPagoTransferencia as Pago, EstadoPedido as E, ModoEntrega } from '@prisma/client';
import {
  banderasDeCancelacion,
  CodigoNoCancelable,
  decidirCancelacionDelCliente,
} from './cancelacion-cliente.util';

/**
 * Oct 2026 — la decisión de «¿puede el cliente cancelar?» cruzada con los 12 estados del pedido × los estados de pago
 * (sin pago, PENDIENTE, EN_REVISION, VERIFICADO).
 *
 * Las expectativas están ESCRITAS A MANO, fila por fila, y no derivadas de la misma lógica: si alguien cambia una regla,
 * esta tabla es la que tiene que enterarse y obligar a que el cambio sea una decisión y no un accidente.
 */

type Situacion = 'sinPago' | 'pendiente' | 'enRevision' | 'verificado';
const PAGO: Record<Situacion, Pago | null> = {
  sinPago: null,
  pendiente: Pago.PENDIENTE,
  enRevision: Pago.EN_REVISION,
  verificado: Pago.VERIFICADO,
};

/** `true` = puede cancelar; si no, el código por el que no. */
type Esperado = true | CodigoNoCancelable;

/** Lo que pasa con el dinero en un estado donde el cliente SÍ puede cancelar. */
const ESTADO_CANCELABLE: Record<Situacion, Esperado> = {
  sinPago: true,
  pendiente: true,
  enRevision: 'PAGO_EN_REVISION',
  verificado: 'PAGO_VERIFICADO',
};
const SIEMPRE = (c: CodigoNoCancelable): Record<Situacion, Esperado> => ({
  sinPago: c,
  pendiente: c,
  enRevision: c,
  verificado: c,
});

const TABLA: Record<E, Record<Situacion, Esperado>> = {
  // Decisión 2 del dueño: estos seis SÍ cancelan (Pendiente de pago, solo sin comprobante enviado).
  [E.SOLICITADO]: ESTADO_CANCELABLE, //            «Recibido»
  [E.EN_REVISION]: ESTADO_CANCELABLE, //           «En preparación»
  [E.ESPERANDO_APROBACION]: ESTADO_CANCELABLE, //  «Pendiente de aprobación»
  [E.EN_ASESORIA]: ESTADO_CANCELABLE, //           «Con un asesor»
  [E.REVISADO]: ESTADO_CANCELABLE, //              «Listo en tienda»
  [E.PENDIENTE_PAGO]: ESTADO_CANCELABLE, //        «Pendiente de pago»
  // Decisión 3: «En atención» se CIERRA para el cliente.
  [E.EN_ATENCION]: SIEMPRE('EN_ATENCION'),
  // Decisión 4: EN_DTF queda igual (se cancela desde la tarjeta de cada diseño).
  [E.EN_DTF]: SIEMPRE('EN_DTF'),
  // Decisión 4: Pagado, Enviado y Entregado → mostrador.
  [E.PAGADO]: SIEMPRE('YA_PAGADO'),
  [E.ENVIADO]: SIEMPRE('YA_PAGADO'),
  [E.ENTREGADO]: SIEMPRE('ENTREGADO'),
  [E.CANCELADO]: SIEMPRE('YA_CANCELADO'),
};

describe('decidirCancelacionDelCliente — los 12 estados × los estados de pago', () => {
  it('la tabla cubre TODOS los estados del enum (un estado nuevo obliga a clasificarlo)', () => {
    expect(Object.keys(TABLA).sort()).toEqual(Object.values(E).sort());
    expect(Object.values(E)).toHaveLength(12);
  });

  const casos = (Object.keys(TABLA) as E[]).flatMap((estado) =>
    (Object.keys(PAGO) as Situacion[]).map((situacion) => [estado, situacion] as const),
  );
  expect(casos).toHaveLength(48);

  it.each(casos)('%s con pago «%s»', (estado, situacion) => {
    const esperado = TABLA[estado][situacion];
    const d = decidirCancelacionDelCliente(
      { estado, modoEntrega: ModoEntrega.RECOGER_TIENDA },
      PAGO[situacion],
    );

    if (esperado === true) {
      expect(d.puede).toBe(true);
      expect(d.codigo).toBeNull();
      expect(d.motivo).toBeNull();
    } else {
      expect(d.puede).toBe(false);
      expect(d.codigo).toBe(esperado);
      // Un «no» siempre se explica: el botón sigue visible y dice POR QUÉ.
      expect(typeof d.motivo).toBe('string');
      expect(d.motivo!.length).toBeGreaterThan(20);
      // Y un «no» nunca pide nada más: ni aviso de mercancía ni la pregunta de la transferencia.
      expect(d.mercanciaApartada).toBe(false);
      expect(d.preguntarTransferencia).toBe(false);
    }
  });
});

describe('decidirCancelacionDelCliente — lo que acompaña a un «sí»', () => {
  it('«¿ya transferiste?» solo con una transferencia PENDIENTE', () => {
    const d = (pago: Pago | null) =>
      decidirCancelacionDelCliente({ estado: E.PENDIENTE_PAGO }, pago).preguntarTransferencia;
    expect(d(Pago.PENDIENTE)).toBe(true);
    expect(d(null)).toBe(false);
  });

  it.each([
    [E.REVISADO, true],
    [E.ESPERANDO_APROBACION, true],
    [E.EN_ASESORIA, true],
    [E.PENDIENTE_PAGO, true],
    [E.SOLICITADO, false],
    [E.EN_REVISION, false],
  ])('%s: el aviso de que la mercancía apartada vuelve al anaquel = %s', (estado, aviso) => {
    expect(decidirCancelacionDelCliente({ estado }, null).mercanciaApartada).toBe(aviso);
  });
});

describe('decidirCancelacionDelCliente — «En atención» responde con un motivo claro', () => {
  const d = decidirCancelacionDelCliente({ estado: E.EN_ATENCION }, null);

  it('lo cierra y manda a decírselo a quien lo atiende', () => {
    expect(d.puede).toBe(false);
    expect(d.codigo).toBe('EN_ATENCION');
    expect(d.motivo).toMatch(/te están atendiendo en mostrador/i);
    expect(d.motivo).toMatch(/díselo a la persona que te atiende/i);
  });
});

describe('decidirCancelacionDelCliente — a domicilio no hay mostrador al que ir', () => {
  it('manda a hablar con la tienda, no a mostrador', () => {
    const pagado = decidirCancelacionDelCliente(
      { estado: E.ENVIADO, modoEntrega: ModoEntrega.DOMICILIO },
      null,
    );
    expect(pagado.motivo).toMatch(/comunícate con la tienda/i);
    expect(pagado.motivo).not.toMatch(/acércate a mostrador/i);

    const entregado = decidirCancelacionDelCliente(
      { estado: E.ENTREGADO, modoEntrega: ModoEntrega.DOMICILIO },
      null,
    );
    expect(entregado.motivo).toMatch(/comunícate con la tienda/i);

    const verificado = decidirCancelacionDelCliente(
      { estado: E.PENDIENTE_PAGO, modoEntrega: ModoEntrega.DOMICILIO },
      Pago.VERIFICADO,
    );
    expect(verificado.motivo).toMatch(/comunícate con la tienda/i);
  });

  it('en tienda sí manda a mostrador', () => {
    const d = decidirCancelacionDelCliente(
      { estado: E.PAGADO, modoEntrega: ModoEntrega.RECOGER_TIENDA },
      null,
    );
    expect(d.motivo).toMatch(/acércate a mostrador/i);
  });
});

describe('decidirCancelacionDelCliente — el texto que lee el cliente', () => {
  // El cliente nunca lee jerga interna (ver el vocabulario del frontend): ni «bodega», ni «administrador», ni el
  // Sistema Comercial, ni un #id.
  const PROHIBIDO = /bodega|administrador|sistema comercial|firebird|vfp|\berp\b|#\d|\.\.\./i;

  const todos = (Object.keys(TABLA) as E[])
    .flatMap((estado) =>
      (Object.keys(PAGO) as Situacion[]).flatMap((s) =>
        [ModoEntrega.RECOGER_TIENDA, ModoEntrega.DOMICILIO].map(
          (modoEntrega) => decidirCancelacionDelCliente({ estado, modoEntrega }, PAGO[s]).motivo,
        ),
      ),
    )
    .filter((m): m is string => !!m);

  it('ningún motivo usa jerga interna', () => {
    expect(todos.length).toBeGreaterThan(0);
    for (const m of todos) expect(m).not.toMatch(PROHIBIDO);
  });

  it('todos terminan en punto y empiezan en mayúscula', () => {
    for (const m of todos) {
      expect(m).toMatch(/^[A-ZÁÉÍÓÚ]/);
      expect(m).toMatch(/\.$/);
    }
  });
});

describe('banderasDeCancelacion — lo que viaja en «Mis pedidos» y en el detalle', () => {
  it('un «sí» no lleva motivo y un «no» sí', () => {
    const si = banderasDeCancelacion(decidirCancelacionDelCliente({ estado: E.SOLICITADO }, null));
    expect(si).toEqual({
      puedeCancelar: true,
      motivoNoPuedeCancelar: null,
      cancelarDevuelveMercancia: false,
      cancelarPideConfirmarTransferencia: false,
    });

    const no = banderasDeCancelacion(decidirCancelacionDelCliente({ estado: E.PAGADO }, null));
    expect(no.puedeCancelar).toBe(false);
    expect(no.motivoNoPuedeCancelar).toMatch(/ya fue pagado/i);
  });
});
