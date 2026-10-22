import { renderToStaticMarkup } from 'react-dom/server';
import { MessagesService } from './messages.service';

/**
 * Oct 2026 — el correo "tu asesor te envió un mensaje" llama al pedido como lo llama la pantalla y el ticket.
 *
 * El asesor solo escribe con el pedido ya surtido (EN_ASESORIA), o sea con el folio del Sistema Comercial ya asignado.
 * El correo llevaba el `PD-…` en el asunto y en el cuerpo (no cargaba los datos del folio), así que el cliente recibía
 * un número que su pedido ya no mostraba en ninguna parte.
 */
describe('MessagesService · correo de la primera respuesta del asesor', () => {
  const pedidoBase = {
    id: 17310,
    numeroPedido: 'PD-2026-000018',
    clienteEmail: 'cliente@test.local',
    clienteNombre: 'Cliente',
    estado: 'EN_ASESORIA',
    total: 100,
    fechaPedido: new Date('2026-10-19T12:00:00Z'),
    tienda: { nombre: 'Hermosillo', serie: 'HMO' },
    pendienteEnvio: null,
    folioErp: null as string | null,
  };

  function armar(
    pedido: typeof pedidoBase,
    opts: { asignadoAt?: Date | null; correosPrevios?: number } = {},
  ) {
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      pedidoFolioSolicitud: {
        findUnique: jest.fn().mockResolvedValue({ asignadoAt: opts.asignadoAt ?? null }),
      },
      notificacion: { count: jest.fn().mockResolvedValue(opts.correosPrevios ?? 0) },
      pedido: { findUnique: jest.fn().mockResolvedValue(pedido) },
      pedidoMensaje: {
        findUnique: jest.fn().mockResolvedValue({
          id: 5,
          contenido: 'Hola, ya revisé tu pedido',
          autor: { nombre: 'Ana', apellido: 'Ventas' },
        }),
      },
      mensajeBodegueroEnviado: { create: jest.fn().mockResolvedValue({}) },
    };
    const config = { get: jest.fn().mockReturnValue('https://tienda.test') };
    const configuracion = {
      obtenerLogoUrl: jest.fn().mockResolvedValue('https://logo.test/l.png'),
    };
    const svc = new MessagesService(
      prisma as any,
      {} as any,
      {} as any,
      { sendEmail } as any,
      config as any,
      {} as any,
      configuracion as any,
      {} as any,
      {} as any,
    );
    return { svc, sendEmail };
  }

  it('con folio del ERP: el asunto lleva SERIE-folio, no el PD-…', async () => {
    const { svc, sendEmail } = armar({ ...pedidoBase, folioErp: '0000152573' });
    await (svc as any).dispararEmailPrimeraRespuestaAsesor(5, 17310);

    const asunto = sendEmail.mock.calls[0][0].subject as string;
    expect(asunto).toContain('HMO-0000152573');
    expect(asunto).not.toContain('PD-2026-000018');
    expect(asunto).not.toContain('17310');
  });

  it('sin folio todavía: el número del pedido (nunca el id interno)', async () => {
    const { svc, sendEmail } = armar(pedidoBase);
    await (svc as any).dispararEmailPrimeraRespuestaAsesor(5, 17310);

    const asunto = sendEmail.mock.calls[0][0].subject as string;
    expect(asunto).toContain('PD-2026-000018');
    expect(asunto).not.toContain('17310');
  });

  it('el primer correo con folio lleva el "pedido en línea" (PD-…) que une los dos números; el asunto no', async () => {
    const { svc, sendEmail } = armar(
      { ...pedidoBase, folioErp: '0000152573' },
      { asignadoAt: new Date('2026-10-19T12:01:00Z'), correosPrevios: 0 },
    );
    await (svc as any).dispararEmailPrimeraRespuestaAsesor(5, 17310);

    const { template, subject } = sendEmail.mock.calls[0][0];
    expect(subject).toContain('HMO-0000152573');
    expect(subject).not.toContain('PD-2026-000018');
    const texto = renderToStaticMarkup(template as never);
    expect(texto).toContain('HMO-0000152573');
    expect(texto).toContain('pedido en línea PD-2026-000018');
  });

  it('si ya se mandó un correo con el folio, no se repite el PD-…', async () => {
    const { svc, sendEmail } = armar(
      { ...pedidoBase, folioErp: '0000152573' },
      { asignadoAt: new Date('2026-10-19T12:01:00Z'), correosPrevios: 1 },
    );
    await (svc as any).dispararEmailPrimeraRespuestaAsesor(5, 17310);

    const texto = renderToStaticMarkup(sendEmail.mock.calls[0][0].template as never);
    expect(texto).toContain('HMO-0000152573');
    expect(texto).not.toContain('PD-2026-000018');
  });
});
