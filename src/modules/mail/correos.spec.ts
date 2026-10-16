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
  venceAt: new Date('2026-10-18T07:00:00Z'),
  zonaHoraria: 'America/Mexico_City',
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
  ['Transferencia POR_VENCER', () => transf('POR_VENCER', { lineas: lineasParaCorreo(ins) })],
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
