import { EstadoPedido, ModoEntrega } from '@prisma/client';
import {
  esFolioErp,
  etiquetaDelPedido,
  formatearFolio,
  interpretarFolio,
  necesitaFolio,
  turnoCorto,
  turnoParaElCliente,
  DIGITOS_DE_TURNO,
} from './folio-erp.util';

describe('esFolioErp', () => {
  it('acepta exactamente 10 dígitos', () => {
    expect(esFolioErp('0000152573')).toBe(true);
    expect(esFolioErp('9999999999')).toBe(true);
  });

  it.each([
    '',
    '152573',
    '00001525734',
    'PD-2026-00',
    '0000152 73',
    'HMO-0000152573',
    null,
    undefined,
    152573,
  ])('rechaza %p (el "PD-2026-00" del agente anterior no es un folio)', (v) => {
    expect(esFolioErp(v)).toBe(false);
  });
});

describe('formatearFolio / etiquetaDelPedido', () => {
  it('antepone la serie de la tienda', () => {
    expect(formatearFolio('HMO', '0000152573')).toBe('HMO-0000152573');
    expect(formatearFolio(' mxl ', '0000148980')).toBe('MXL-0000148980');
  });

  it('sin serie muestra el folio solo (lo que entiende el Sistema Comercial)', () => {
    expect(formatearFolio(null, '0000152573')).toBe('0000152573');
    expect(formatearFolio('', '0000152573')).toBe('0000152573');
  });

  it('el pedido sin folio se identifica con su número interno hasta que el agente contesta', () => {
    expect(etiquetaDelPedido({ folioErp: null, numeroPedido: 'PD-2026-000123' }, 'HMO')).toBe(
      'PD-2026-000123',
    );
    expect(
      etiquetaDelPedido({ folioErp: '0000152573', numeroPedido: 'PD-2026-000123' }, 'HMO'),
    ).toBe('HMO-0000152573');
  });
});

describe('interpretarFolio', () => {
  it.each([
    ['HMO-0000152573', { serie: 'HMO', folio: '0000152573' }],
    ['hmo-0000152573', { serie: 'HMO', folio: '0000152573' }],
    ['HMO 152573', { serie: 'HMO', folio: '0000152573' }],
    ['0000152573', { serie: null, folio: '0000152573' }], // lo que lleva el QR para el lector del Sistema Comercial
    ['152573', { serie: null, folio: '0000152573' }], // como lo dice la gente
    ['  0000000001 ', { serie: null, folio: '0000000001' }],
  ])('%p', (texto, esperado) => {
    expect(interpretarFolio(texto)).toEqual(esperado);
  });

  it.each(['', 'PD-2026-000123', 'HMO-', 'abc', '12345678901', 'H-123'])(
    '%p no es un folio',
    (texto) => {
      expect(interpretarFolio(texto)).toBeNull();
    },
  );
});

describe('necesitaFolio', () => {
  it('no hasta que sale del surtido, ni cancelado', () => {
    expect(necesitaFolio(EstadoPedido.SOLICITADO)).toBe(false);
    expect(necesitaFolio(EstadoPedido.EN_REVISION)).toBe(false);
    expect(necesitaFolio(EstadoPedido.CANCELADO)).toBe(false);
  });

  it('sí en todo estado posterior al surtido (incluida la espera de la impresión DTF)', () => {
    const despues = Object.values(EstadoPedido).filter(
      (e) => !['SOLICITADO', 'EN_REVISION', 'CANCELADO'].includes(e),
    );
    expect(despues).toEqual(
      expect.arrayContaining(['REVISADO', 'ESPERANDO_APROBACION', 'PENDIENTE_PAGO', 'EN_DTF']),
    );
    for (const e of despues) expect(necesitaFolio(e)).toBe(true);
  });
});

describe('turnoCorto (lo que se dice en voz alta y se pinta en las TV de pared)', () => {
  it('los últimos dígitos del folio, con sus ceros', () => {
    expect(turnoCorto('0000152573')).toBe('2573');
    expect(turnoCorto('0000000611')).toBe('0611');
    expect(turnoCorto('0000000001')).toBe('0001');
  });

  it('coincide con el final del folio impreso (HMO-0000152573 → …2573)', () => {
    expect('HMO-0000152573'.endsWith(turnoCorto('0000152573')!)).toBe(true);
  });

  it('sin folio (o con basura) no hay turno: la TV muestra lo que ya mostraba', () => {
    for (const v of [null, undefined, '', 'PD-2026-00', '152573']) expect(turnoCorto(v)).toBeNull();
  });

  it('son cuatro dígitos (decisión del dueño); un solo número lo cambia', () => {
    expect(DIGITOS_DE_TURNO).toBe(4);
  });

  it('dos pedidos que esperan a la vez en una tienda no chocan: el consecutivo avanza de uno en uno', () => {
    const activos = Array.from({ length: 300 }, (_, i) => String(152_300 + i).padStart(10, '0'));
    const turnos = activos.map((f) => turnoCorto(f));
    expect(new Set(turnos).size).toBe(turnos.length);
  });
});

describe('turnoParaElCliente ("Tu turno en pantalla": solo cuando el pedido sale en una TV)', () => {
  const E = EstadoPedido;
  const conFolio = { folioErp: '0000152573', modoEntrega: ModoEntrega.RECOGER_TIENDA };

  it.each([E.REVISADO, E.EN_ATENCION, E.PENDIENTE_PAGO])('en %s: los últimos 4 dígitos', (estado) => {
    expect(turnoParaElCliente({ ...conFolio, estado })).toBe('2573');
  });

  it.each([E.SOLICITADO, E.EN_REVISION, E.EN_ASESORIA, E.ESPERANDO_APROBACION, E.PAGADO, E.ENTREGADO, E.CANCELADO])(
    'en %s no sale en ninguna TV: sin turno',
    (estado) => {
      expect(turnoParaElCliente({ ...conFolio, estado })).toBeNull();
    },
  );

  it('a domicilio no pasa por ventanilla: sin turno aunque tenga folio', () => {
    expect(
      turnoParaElCliente({ folioErp: '0000152573', estado: E.PENDIENTE_PAGO, modoEntrega: ModoEntrega.DOMICILIO }),
    ).toBeNull();
  });

  it('sin folio todavía no hay turno que mostrar', () => {
    expect(turnoParaElCliente({ folioErp: null, estado: E.REVISADO })).toBeNull();
  });
});
