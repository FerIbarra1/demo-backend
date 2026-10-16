import { renderToStaticMarkup } from 'react-dom/server';
import { toPlainText } from '@react-email/render';
import { EstadoPagoTransferencia as E, TipoNotificacion } from '@prisma/client';
import { NotificationsService } from './notifications.service';

/**
 * Oct 2026: el correo que sale cuando el agente de VFP confirma el pedido (ya hay folio).
 *
 * El hueco que cierra: el cliente que eligió TRANSFERENCIA solo recibía un "entra a tu pedido
 * para ver los datos" (sin datos), y las instrucciones de verdad solo salían si caja las daba a
 * mano. Aquí se lee el HTML RENDERIZADO, que es lo que lee el cliente.
 */

const FOLIO_VFP = 'F-778899';

function crearServicio(pago: { estado: E } | null) {
  const enviados: Array<{
    subject: string;
    tipoNotificacion: TipoNotificacion;
    template: never;
    textFallback?: string;
  }> = [];
  const prisma = {
    pedidoPagoTransferencia: {
      findFirst: jest.fn().mockResolvedValue(
        pago && {
          id: 1,
          estado: pago.estado,
          montoEsperado: '2340.50',
          cuentaSnapshot: {
            banco: 'BBVA',
            titular: 'PUNTO TEXTIL SA DE CV',
            clabe: '012180001234567899',
            cuenta: null,
            instrucciones: null,
          },
          referencia: '3340781',
          concepto: 'PD2026000123',
          venceAt: new Date('2026-10-18T07:00:00Z'),
        },
      ),
    },
    itemPedido: { findMany: jest.fn().mockResolvedValue([]) },
    tienda: { findUnique: jest.fn().mockResolvedValue({ id: 5, nombre: 'Mexicali' }) },
    pedidoPendienteEnvio: { findUnique: jest.fn().mockResolvedValue({ externalFolio: FOLIO_VFP }) },
    pedidoReposicion: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const mail = {
    sendEmail: jest.fn(async (o: (typeof enviados)[number]) => void enviados.push(o)),
  };
  const config = {
    get: (k: string) =>
      ({
        'app.mail.frontendUrl': 'https://tienda.test',
        'app.pagos.zonaHoraria': 'America/Mexico_City',
        'app.pagos.transferenciaVenceHoras': 48,
        'app.kioskoQrSecret': 'secreto-de-prueba',
      })[k],
  };
  const svc = new NotificationsService(
    prisma as never,
    mail as never,
    config as never,
    { resolverImagen: jest.fn().mockReturnValue(null) } as never,
    { obtenerLogoUrl: jest.fn().mockResolvedValue('https://tienda.test/logo.png') } as never,
  );
  return { svc, enviados, prisma };
}

const pedido = (extra: object = {}) =>
  ({
    id: 1,
    numeroPedido: 'PD2026000123',
    tiendaId: 5,
    clienteNombre: 'Cliente Demo',
    clienteEmail: 'cliente@test.local',
    estado: 'PENDIENTE_PAGO',
    total: '2340.50',
    fechaPedido: new Date('2026-10-16T18:00:00Z'),
    metodoPagoPreferido: 'TRANSFERENCIA',
    shippingPaqueteria: null,
    shippingDireccion: null,
    ...extra,
  }) as never;

// `render` de react-email usa un import dinámico que Jest no soporta: se renderiza igual que en
// `correos.spec.ts`, que es el mismo HTML que lee el cliente.
const htmlDe = (o: { template: never }) => renderToStaticMarkup(o.template);
const texto = (o: { template: never }) => toPlainText(htmlDe(o));

describe('enviarListoParaPagar — el cliente que eligió transferencia', () => {
  it('recibe UN correo con las instrucciones completas, no el de "listo para pagar"', async () => {
    const { svc, enviados } = crearServicio({ estado: E.PENDIENTE });
    await svc.enviarListoParaPagar(pedido(), FOLIO_VFP);

    expect(enviados).toHaveLength(1);
    const [correo] = enviados;
    expect(correo.tipoNotificacion).toBe(TipoNotificacion.TRANSFERENCIA_INSTRUCCIONES);
    expect(correo.subject).toContain(FOLIO_VFP);

    const t = texto(correo);
    // Lo que el cliente necesita para transferir, EN el correo.
    expect(t).toContain('BBVA');
    expect(t).toContain('PUNTO TEXTIL SA DE CV');
    // La CLABE sale agrupada para leerse; sin espacios es la que se pega en la app del banco.
    expect(t.replace(/\s/g, '')).toContain('012180001234567899');
    expect(t).toContain('3340781');
    expect(t).toMatch(/2,340\.50/);
  });

  it('el folio del correo es el de VFP (el ACK ya lo escribió)', async () => {
    const { svc, enviados } = crearServicio({ estado: E.PENDIENTE });
    await svc.enviarListoParaPagar(pedido(), FOLIO_VFP);
    expect(texto(enviados[0])).toContain(FOLIO_VFP);
  });

  it.each([E.EN_REVISION, E.VERIFICADO])(
    'si ya transfirió (%s) no se le pide nada: no se manda ningún correo',
    async (estado) => {
      const { svc, enviados } = crearServicio({ estado });
      await svc.enviarListoParaPagar(pedido(), FOLIO_VFP);
      expect(enviados).toHaveLength(0);
    },
  );
});

describe('enviarListoParaPagar — pago en caja', () => {
  it('sin transferencia viva sale el correo de siempre, con el QR de caja', async () => {
    const { svc, enviados } = crearServicio(null);
    await svc.enviarListoParaPagar(pedido({ metodoPagoPreferido: 'EN_TIENDA' }), FOLIO_VFP);

    expect(enviados).toHaveLength(1);
    expect(enviados[0].tipoNotificacion).toBe(TipoNotificacion.REVISION_APROBADA);
    const html = htmlDe(enviados[0]);
    expect(html).toContain('data:image/png;base64');
    expect(toPlainText(html)).toMatch(/caja/i);
  });

  it('elegir transferencia al pedir pero NO tener datos emitidos (sin cuenta, o caja la pasó a tienda) no le dice "ve tus datos para transferir"', async () => {
    // Antes la plantilla leía `metodoPagoPreferido` y mandaba al cliente a buscar unos datos que
    // no existían, sin QR para pagar en caja.
    const { svc, enviados } = crearServicio(null);
    await svc.enviarListoParaPagar(pedido({ metodoPagoPreferido: 'TRANSFERENCIA' }), FOLIO_VFP);

    const html = htmlDe(enviados[0]);
    const t = toPlainText(html);
    expect(t).not.toMatch(/datos para transferir/i);
    expect(t).not.toMatch(/elegiste pagar por transferencia/i);
    expect(html).toContain('data:image/png;base64'); // el QR de caja
  });

  it('sin correo del cliente no envía nada', async () => {
    const { svc, enviados } = crearServicio({ estado: E.PENDIENTE });
    await svc.enviarListoParaPagar(pedido({ clienteEmail: null }), FOLIO_VFP);
    expect(enviados).toHaveLength(0);
  });
});
