import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { toPlainText } from '@react-email/render';
import { mailTemplates } from './mail.templates';
import { TransferenciaPago, VarianteTransferencia } from './templates/TransferenciaPago';
import { construirInstrucciones } from '../pagos/transferencia/instrucciones.util';
import { lineasParaCorreo } from '../pagos/transferencia/pago-comun';

/**
 * Los correos no deben decir lo mismo dos veces (oct 2026). El correo de instrucciones repetía el
 * monto tres veces y pedía "sube tu comprobante" en una nota, en el cierre y en el botón; los de
 * "enviado" y "cancelado" repetían folio, estado y paquetería. Estas pruebas leen el texto
 * RENDERIZADO de cada correo, que es lo que lee el cliente.
 */

const FOLIO = 'F12345';
const pedidoBase = {
  pedidoId: 1,
  numeroPedido: 'PD2026000123',
  clienteNombre: 'Cliente Demo',
  total: '2340.50',
  fechaPedido: new Date('2026-10-16T18:00:00Z'),
  externalFolio: FOLIO,
  tiendaNombre: 'Punto Textil Mexicali',
  tiendaTelefono: '686-000-0001',
  tiendaDireccion: 'Av. Reforma 123, Mexicali',
  items: [
    {
      productoNombre: 'Playera',
      productoCodigo: 'C0300',
      tallaNombre: 'M',
      colorNombre: 'Negro',
      cantidad: 3,
      precioUnitario: '780.17',
      subtotal: '2340.50',
    },
  ],
};
const ctx = (estado: string, extra: object = {}) => ({
  pedido: { ...pedidoBase, estado, ...extra } as never,
  pedidoUrl: 'http://tienda.test/pedidos/1',
  logoUrl: 'http://tienda.test/logo.png',
  frontendUrl: 'http://tienda.test',
  qrDataUrl: 'data:image/png;base64,AAAA',
});
const T = mailTemplates as unknown as Record<string, (p: object) => React.ReactElement>;

const ins = construirInstrucciones({
  folio: FOLIO,
  monto: '2340.50' as never,
  cuenta: {
    banco: 'BBVA',
    titular: 'PUNTO TEXTIL SA DE CV',
    clabe: '012180001234567899',
    cuenta: null,
    instrucciones: null,
  },
  referencia: '3340781',
  concepto: 'PD2026000123',
  pedidoUrl: 'http://tienda.test/pedidos/1',
});
const transf = (variante: VarianteTransferencia, extra: object = {}) =>
  React.createElement(TransferenciaPago, { ...ctx('PENDIENTE_PAGO'), variante, ...extra } as never);

const casos: Array<[string, () => React.ReactElement]> = [
  ['PedidoRecibido', () => T.PedidoRecibido(ctx('SOLICITADO'))],
  [
    'PedidoRecibido (transferencia)',
    () => T.PedidoRecibido(ctx('SOLICITADO', { pagoPorTransferencia: true })),
  ],
  ['PedidoListoEnTienda', () => T.PedidoListoEnTienda(ctx('REVISADO'))],
  ['PedidoRecordatorioRecoger', () => T.PedidoRecordatorioRecoger(ctx('REVISADO'))],
  [
    'RevisionPropuesta bodega',
    () =>
      T.RevisionPropuesta({
        ...ctx('ESPERANDO_APROBACION'),
        mensajeBodeguero: 'Faltan 2 piezas.',
        origen: 'bodega',
      }),
  ],
  [
    'RevisionPropuesta ventas',
    () =>
      T.RevisionPropuesta({
        ...ctx('EN_ASESORIA'),
        mensajeBodeguero: 'Te propongo esto.',
        origen: 'ventas',
      }),
  ],
  [
    'RevisionPropuesta asesor',
    () =>
      T.RevisionPropuesta({
        ...ctx('EN_ASESORIA'),
        mensajeBodeguero: 'Necesito cambiar tallas.',
        origen: 'asesor',
      }),
  ],
  ['PedidoAprobado (con QR)', () => T.PedidoAprobado(ctx('PENDIENTE_PAGO'))],
  [
    'PedidoAprobado (domicilio)',
    () => T.PedidoAprobado(ctx('PENDIENTE_PAGO', { direccionEnvio: 'Calle 5 #10' })),
  ],
  [
    'PedidoAprobado (transferencia)',
    () => T.PedidoAprobado(ctx('PENDIENTE_PAGO', { pagoPorTransferencia: true })),
  ],
  ['PagoConfirmado', () => T.PagoConfirmado(ctx('PAGADO'))],
  [
    'PedidoEnviado',
    () =>
      T.PedidoEnviado(
        ctx('ENVIADO', { paqueteria: 'Estafeta', direccionEnvio: 'Calle 5 #10, Hermosillo' }),
      ),
  ],
  ['PedidoEntregado', () => T.PedidoEntregado(ctx('ENTREGADO'))],
  [
    'PedidoEntregado (lo recogió otra persona)',
    () => T.PedidoEntregado(ctx('ENTREGADO', { recogioNombre: 'Juan Pérez (chofer)' })),
  ],
  [
    'PedidoCancelado',
    () => T.PedidoCancelado(ctx('CANCELADO', { motivoCancelacion: 'Cancelado por el cliente' })),
  ],
  [
    'Transferencia INSTRUCCIONES',
    () => transf('INSTRUCCIONES', { lineas: lineasParaCorreo(ins), notas: ins.notas }),
  ],
  ['Transferencia COMPROBANTE_RECIBIDO', () => transf('COMPROBANTE_RECIBIDO')],
  ['Transferencia VERIFICADA', () => transf('VERIFICADA')],
  [
    'Transferencia RECHAZADA',
    () =>
      transf('RECHAZADA', {
        detalle: 'Hay algo que aclarar con tu comprobante. El monto no coincide.',
      }),
  ],
  [
    'Transferencia REEMBOLSADA',
    () => transf('REEMBOLSADA', { detalle: 'Referencia de la devolución: SPEI 123' }),
  ],
];

/** Texto plano del correo SIN el pie común (derechos, enlaces de navegación y aviso legal). */
async function texto(el: React.ReactElement): Promise<string> {
  // `render` de react-email usa un `import()` dinámico que jest (CommonJS) no soporta sin una bandera
  // experimental; el HTML estático de react-dom es el mismo que arma `render`.
  const plano = toPlainText(renderToStaticMarkup(el));
  return plano
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}
const PIE =
  /^(©|Mis pedidos|Recibes este correo|-{5,}|¿Dudas con tu pedido|Si tienes dudas con tu pedido)/;
const sinPie = (t: string) => t.split('\n').filter((l) => !PIE.test(l));

describe('correos: sin redundancia', () => {
  it.each(casos)('%s: ninguna línea se repite', async (_n, fn) => {
    const lineas = sinPie(await texto(fn())).filter((l) => l.length > 10);
    const repetidas = lineas.filter((l, i) => lineas.indexOf(l) !== i);
    expect(repetidas).toEqual([]);
  });

  it.each(casos.filter(([n]) => !/Bienvenida|Reset/.test(n)))(
    '%s: el folio sale UNA vez (en el resumen), no en el título ni el saludo',
    async (_n, fn) => {
      const t = await texto(fn());
      expect(t.split(FOLIO).length - 1).toBeLessThanOrEqual(1);
    },
  );

  it.each(casos)('%s: sin fila "Estado:" (el título ya dice qué pasó)', async (_n, fn) => {
    expect(await texto(fn())).not.toMatch(/^Estado:/m);
  });

  it.each(casos)('%s: el enlace del pedido sale una sola vez (el botón)', async (_n, fn) => {
    const t = await texto(fn());
    expect(t.split('http://tienda.test/pedidos/1').length - 1).toBe(1);
  });
});

describe('correos de transferencia a DOMICILIO (oct 2026: ahí solo se paga por transferencia)', () => {
  const dom = { direccionEnvio: 'Calle 5 #10, Hermosillo' };

  it.each(['INSTRUCCIONES', 'VERIFICADA', 'RECHAZADA'] as const)(
    '%s no manda a pagar en tienda ni a recoger',
    async (variante) => {
      const t = await texto(transf(variante, { pedido: { ...pedidoBase, ...dom, estado: 'PENDIENTE_PAGO' } } as never));
      expect(t).not.toMatch(/pagar en tienda|pídelo en caja|recoger tu pedido|mostrador/i);
    },
  );

  it('VERIFICADA dice que sale a envío', async () => {
    const t = await texto(transf('VERIFICADA', { pedido: { ...pedidoBase, ...dom, estado: 'PENDIENTE_PAGO' } } as never));
    expect(t).toContain('tu pedido sale a envío');
  });

  it('para quien recoge en tienda no cambia nada', async () => {
    const t = await texto(transf('VERIFICADA'));
    expect(t).toContain('podrás recoger tu pedido');
  });
});

describe('correo de cancelado: el motivo solo si aporta (oct 2026)', () => {
  it('si lo canceló el propio cliente no le repite «Motivo: Cancelado por el cliente»: le da el aviso por si no fue él', async () => {
    const t = await texto(T.PedidoCancelado(ctx('CANCELADO', { motivoCancelacion: 'Cancelado por el cliente' })));
    expect(t).not.toMatch(/Motivo/);
    expect(t).toContain('Si no solicitaste esta cancelación');
  });

  it('un motivo de verdad sí se dice', async () => {
    const t = await texto(T.PedidoCancelado(ctx('CANCELADO', { motivoCancelacion: 'No recibimos el pago.' })));
    expect(t).toContain('Motivo');
    expect(t).toContain('No recibimos el pago.');
  });
});

describe('correos: cómo se llama el número (oct 2026)', () => {
  it('antes del folio es "Pedido", no "Folio": el PD-… no es el folio del Sistema Comercial', async () => {
    const t = await texto(
      T.PedidoRecibido(ctx('SOLICITADO', { externalFolio: null, numeroPedido: 'PD-2026-000123' })),
    );
    expect(t).toContain('Pedido: PD-2026-000123');
    expect(t).not.toContain('Folio:');
  });

  it('con el folio del Sistema Comercial sí es "Folio"', async () => {
    const t = await texto(
      T.PedidoListoEnTienda(ctx('REVISADO', { folioErp: '0000152573', serieTienda: 'HMO', externalFolio: null })),
    );
    expect(t).toContain('Folio: HMO-0000152573');
  });

  it('"recibido" ya no habla de la "cola de bodega" y, a domicilio, no manda a la tienda', async () => {
    const recoger = await texto(T.PedidoRecibido(ctx('SOLICITADO')));
    expect(recoger).not.toMatch(/cola de bodega/i);
    expect(recoger).toContain('revisar en tienda');

    const domicilio = await texto(T.PedidoRecibido(ctx('SOLICITADO', { direccionEnvio: 'Calle 5 #10' })));
    expect(domicilio).not.toMatch(/revisar en tienda|cola de bodega/i);
    expect(domicilio).toContain('cuando salga a envío');
  });

  it('"listo para pagar" a domicilio no promete un pago que no sabe cómo ofrecer', async () => {
    const t = await texto(T.PedidoAprobado(ctx('PENDIENTE_PAGO', { direccionEnvio: 'Calle 5 #10' })));
    expect(t).not.toMatch(/salga a camino|ya puedes completar el pago/i);
    expect(t).toContain('Cuando se confirme el pago');
  });
});

describe('correos: el puente entre el PD-… y el folio (oct 2026)', () => {
  const conFolio = { folioErp: '0000152573', serieTienda: 'HMO', externalFolio: null };

  it('el primer correo con folio dice cuál era el número que el cliente ya conocía', async () => {
    const t = await texto(T.PedidoListoEnTienda(ctx('REVISADO', { ...conFolio, referenciaWeb: 'PD-2026-000123' })));
    expect(t).toContain('Folio: HMO-0000152573');
    expect(t).toContain('Pedido en línea: PD-2026-000123');
  });

  it('los demás correos no lo repiten: un solo número', async () => {
    const t = await texto(T.PedidoListoEnTienda(ctx('REVISADO', { ...conFolio, referenciaWeb: null })));
    expect(t).toContain('Folio: HMO-0000152573');
    expect(t).not.toContain('Pedido en línea');
    expect(t).not.toContain('PD-2026-000123');
  });
});

describe('correo de instrucciones de transferencia', () => {
  it('el monto sale UNA vez (la tabla) y no hay un segundo "sube tu comprobante"', async () => {
    const t = await texto(
      transf('INSTRUCCIONES', { lineas: lineasParaCorreo(ins), notas: ins.notas }),
    );
    expect(t.split('$2,340.50').length - 1).toBe(1);
    expect(t.toLowerCase().split('comprobante').length - 1).toBe(1); // solo el texto del botón
    expect(t).not.toMatch(/Productos|Total\$/); // sin la lista de productos
  });

  it('ya no le dice al cliente que puede cambiar el método por su cuenta: lo pide en caja', async () => {
    const t = await texto(
      transf('INSTRUCCIONES', { lineas: lineasParaCorreo(ins), notas: ins.notas }),
    );
    expect(t).toMatch(/pídelo en caja/);
  });

  it('el texto copiable (WhatsApp) sí lleva el enlace para subir el comprobante', () => {
    expect(ins.texto).toContain('sube tu comprobante aquí: http://tienda.test/pedidos/1');
    // …pero las notas que se pintan junto a la tabla no lo repiten.
    expect(ins.notas.join(' ')).not.toContain('http');
  });
});

describe('correo de "entregado": quién lo recogió (oct 2026)', () => {
  it('si lo recogió otra persona, el titular lo lee y se le dice qué hacer si no la reconoce', async () => {
    const t = await texto(
      T.PedidoEntregado(ctx('ENTREGADO', { recogioNombre: 'Juan Pérez (chofer)' })),
    );
    expect(t).toMatch(/Lo recogió:\s*Juan Pérez \(chofer\)/);
    expect(t).toMatch(/Si no reconoces a esa persona/);
  });

  it('si lo recogió el titular NO aparece nada: no hay "Lo recogió: <el mismo>"', async () => {
    expect(await texto(T.PedidoEntregado(ctx('ENTREGADO')))).not.toMatch(/Lo recogió/);
    expect(await texto(T.PedidoEntregado(ctx('ENTREGADO', { recogioNombre: null })))).not.toMatch(
      /Lo recogió/,
    );
  });
});

describe('correos: la información es cierta con el flujo actual', () => {
  it('"listo en tienda" no manda a un chat que no existe en ese estado', async () => {
    const t = await texto(T.PedidoListoEnTienda(ctx('REVISADO')));
    expect(t.toLowerCase()).not.toContain('chat');
    expect(t).toContain('Av. Reforma 123, Mexicali');
  });

  it('la propuesta de bodega ya no habla de "sustituciones" (se eliminaron) ni de un chat con bodega', async () => {
    const t = await texto(
      T.RevisionPropuesta({
        ...ctx('ESPERANDO_APROBACION'),
        mensajeBodeguero: 'x',
        origen: 'bodega',
      }),
    );
    expect(t.toLowerCase()).not.toMatch(/sustitucion|chat/);
  });

  it('"listo para pagar" a quien transfiere NO le dice que presente su folio en caja', async () => {
    const t = await texto(T.PedidoAprobado(ctx('PENDIENTE_PAGO', { pagoPorTransferencia: true })));
    expect(t).toContain('Ver datos para transferir');
    expect(t.toLowerCase()).not.toMatch(/en caja|ventanilla/);
  });

  it('"cancelado" no promete un saldo a favor que no existe', async () => {
    const t = await texto(T.PedidoCancelado(ctx('CANCELADO', { motivoCancelacion: 'x' })));
    expect(t.toLowerCase()).not.toContain('saldo a favor');
  });

  it('"verificada" no dice que el pedido está pagado: lo registra la tienda en VFP', async () => {
    const t = await texto(transf('VERIFICADA'));
    expect(t.toLowerCase()).not.toMatch(/\bpagado\b/);
    expect(t).toMatch(/registre el pago/);
  });
});
