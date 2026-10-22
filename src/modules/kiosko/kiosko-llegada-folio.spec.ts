import { HttpException } from '@nestjs/common';
import { KioskoLlegadaService } from './kiosko-llegada.service';
import {
  FALLOS_POR_FOLIO,
  FALLOS_POR_KIOSKO,
  LimiteIntentosLlegada,
  VENTANA_INTENTOS_MS,
} from './kiosko-llegada-intentos';
import { firmarLlegoQr } from '../pedidos/core/qr-llegada.util';

/**
 * Aviso de llegada con un folio TECLEADO.
 *
 * B2 (oct 2026): el folio del Sistema Comercial resuelve el pedido, siempre dentro de la tienda del kiosko.
 * B3 (oct 2026): como el folio es consecutivo y público, tecleado exige un segundo factor — los últimos 4 dígitos
 * del teléfono del pedido — con tope de intentos. El QR firmado no lo necesita.
 */
const pedido = {
  id: 9,
  numeroPedido: 'PD-2026-000009',
  folioErp: '0000152573',
  tiendaId: 5,
  estado: 'REVISADO',
  clienteNombre: 'Cliente Test',
  clienteTelefono: '+526621234567',
  usuario: { telefono: '+526629990000' },
  total: 100,
  items: [{ id: 1 }],
  llegadaAnunciadaAt: null,
  llegadaDescartadaAt: null,
  presenteDesdeAt: null,
  canalOrigen: 'WEB',
  tienda: { nombre: 'Tienda', serie: 'HMO' },
};

/** Reloj controlable: los topes de intentos viven 10 minutos. */
function relojFalso() {
  let ahora = 1_000_000;
  return { reloj: () => ahora, avanzar: (ms: number) => (ahora += ms) };
}

function crear(encontrado: unknown = pedido, kioskoId = 1) {
  const findFirst = jest.fn().mockResolvedValue(null);
  findFirst.mockResolvedValueOnce(null); // numeroPedido
  findFirst.mockResolvedValue(encontrado); // folioErp (y las siguientes llamadas)
  const findUnique = jest.fn().mockResolvedValue(encontrado);
  const prisma = {
    pedido: { findFirst, findUnique },
    kiosko: { findUnique: jest.fn().mockResolvedValue({ tiendaId: 5, estado: 'ACTIVO' }) },
    pedidoPendienteEnvio: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const tiempo = relojFalso();
  const svc = new KioskoLlegadaService(
    prisma as never,
    { validarDeviceToken: jest.fn().mockResolvedValue(true) } as never,
    { emitToTienda: jest.fn(), emitToPedido: jest.fn() } as never,
    { get: jest.fn().mockReturnValue('secreto') } as never,
    new LimiteIntentosLlegada(tiempo.reloj),
  );
  const consultar = (folio: string, telefono4?: string, id = kioskoId) =>
    svc.consultar({ kioskoId: id, kioskoTiendaId: 5, deviceToken: 't', folio, telefono4 });
  return { svc, consultar, findFirst, findUnique, prisma, tiempo };
}

/** Lo que devolvió una excepción HTTP, para comparar respuestas. */
async function rechazo(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (e) {
    const err = e as HttpException;
    return { status: err.getStatus(), body: err.getResponse() };
  }
  throw new Error('se esperaba un rechazo');
}

describe('kiosko — aviso de llegada con el folio del ERP (B2)', () => {
  it.each(['0000152573', 'HMO-0000152573', 'hmo 0000152573'])(
    '"%s" resuelve el pedido de ESTA tienda',
    async (folio) => {
      const { consultar, findFirst } = crear();
      const r = await consultar(folio, '4567');
      expect(r.pedidoId).toBe(9);
      const donde = (findFirst.mock.calls[1][0] as any).where;
      expect(donde).toMatchObject({ folioErp: '0000152573', tiendaId: 5 });
    },
  );

  it('con serie, exige que sea la de la tienda del pedido', async () => {
    const { consultar, findFirst } = crear();
    await consultar('HMO-0000152573', '4567');
    expect((findFirst.mock.calls[1][0] as any).where.tienda).toEqual({ serie: 'HMO' });
  });

  it('la pantalla "¿es este tu pedido?" muestra el folio con serie (no el PD-…)', async () => {
    const { consultar } = crear();
    expect((await consultar('0000152573', '4567')).folioVisible).toBe('HMO-0000152573');
  });

  it('un pedido sin folio todavía se muestra con su número interno', async () => {
    const { consultar } = crear({ ...pedido, folioErp: null });
    expect((await consultar('0000152573', '4567')).folioVisible).toBe('PD-2026-000009');
  });

  it('el número interno PD-… también resuelve (con el teléfono)', async () => {
    const { consultar, findFirst } = crear();
    findFirst.mockReset();
    findFirst.mockResolvedValueOnce(pedido); // numeroPedido
    const r = await consultar('PD-2026-000009', '4567');
    expect(r.pedidoId).toBe(9);
    expect((findFirst.mock.calls[0][0] as any).where).toEqual({
      numeroPedido: 'PD-2026-000009',
      tiendaId: 5,
    });
  });
});

describe('kiosko — aviso de llegada: segundo factor (B3)', () => {
  it.each(['152573', '0000152573'])(
    'un folio sin ceros ("%s") ahora SÍ se rellena: el teléfono es lo que impide resolver el pedido de otro',
    async (folio) => {
      const { consultar, findFirst } = crear();
      await consultar(folio, '4567');
      expect((findFirst.mock.calls[1][0] as any).where).toMatchObject({ folioErp: '0000152573' });
    },
  );

  it('acepta los últimos 4 dígitos del teléfono del PEDIDO', async () => {
    const { consultar } = crear();
    expect((await consultar('0000152573', '4567')).pedidoId).toBe(9);
  });

  it('o los del teléfono del USUARIO (el cliente recuerda uno u otro)', async () => {
    const { consultar } = crear();
    expect((await consultar('0000152573', '0000')).pedidoId).toBe(9);
  });

  it('un teléfono distinto NO resuelve el pedido', async () => {
    const { consultar } = crear();
    const r = await rechazo(consultar('0000152573', '1111'));
    expect(r.status).toBe(404);
    expect(r.body.codigo).toBe('PEDIDO_NO_VERIFICADO');
  });

  it('"no existe", "teléfono distinto" y "sin teléfono registrado" dan la MISMA respuesta (no es un oráculo)', async () => {
    const noExiste = await rechazo(crear(null).consultar('0000999999', '4567'));
    const distinto = await rechazo(crear().consultar('0000152573', '1111'));
    const sinTelefono = await rechazo(
      crear({ ...pedido, clienteTelefono: null, usuario: { telefono: null } }).consultar(
        '0000152573',
        '4567',
      ),
    );
    expect(distinto).toEqual(noExiste);
    expect(sinTelefono).toEqual(noExiste);
  });

  it('ningún dato del pedido sale antes de verificar', async () => {
    const r = await rechazo(crear().consultar('0000152573', '1111'));
    expect(Object.keys(r.body).sort()).toEqual(['codigo', 'message']);
    expect(JSON.stringify(r.body)).not.toMatch(/Cliente Test|152573|HMO|100/);
  });

  it('sin los 4 dígitos es un 400, y ni siquiera se consulta la BD', async () => {
    const { consultar, findFirst, prisma } = crear();
    for (const t of [undefined, '', '123', '12345', 'abcd']) {
      const r = await rechazo(consultar('0000152573', t as string | undefined));
      expect(r.status).toBe(400);
      expect(r.body.codigo).toBe('FALTA_TELEFONO');
    }
    expect(findFirst).not.toHaveBeenCalled();
    expect(prisma.pedidoPendienteEnvio.findFirst).not.toHaveBeenCalled();
  });

  it('el QR firmado NO pide teléfono: la firma es la prueba', async () => {
    const { svc, findUnique } = crear();
    const qr = firmarLlegoQr(9, 5, 'secreto');
    const r = await svc.consultar({ kioskoId: 1, kioskoTiendaId: 5, deviceToken: 't', qr });
    expect(r.pedidoId).toBe(9);
    expect(findUnique).toHaveBeenCalled();
  });

  it('un QR de OTRA tienda sigue rechazándose', async () => {
    const { svc } = crear();
    const qr = firmarLlegoQr(9, 6, 'secreto');
    await expect(
      svc.consultar({ kioskoId: 1, kioskoTiendaId: 5, deviceToken: 't', qr }),
    ).rejects.toMatchObject({ response: { codigo: 'OTRA_TIENDA' } });
  });
});

describe('kiosko — aviso de llegada: tope de intentos (B3)', () => {
  async function fallar(consultar: ReturnType<typeof crear>['consultar'], veces: number) {
    for (let i = 0; i < veces; i++) {
      expect((await rechazo(consultar('0000152573', '1111'))).status).toBe(404);
    }
  }

  it(`tras ${FALLOS_POR_FOLIO} fallos con un folio, el siguiente es 429 aunque ya traiga el teléfono correcto`, async () => {
    const { consultar } = crear();
    await fallar(consultar, FALLOS_POR_FOLIO);
    const r = await rechazo(consultar('0000152573', '4567'));
    expect(r.status).toBe(429);
    expect(r.body.codigo).toBe('DEMASIADOS_INTENTOS');
  });

  it('el 429 no distingue folios que existen de los que no', async () => {
    const existe = crear();
    const noExiste = crear(null);
    await fallar(existe.consultar, FALLOS_POR_FOLIO);
    for (let i = 0; i < FALLOS_POR_FOLIO; i++)
      await rechazo(noExiste.consultar('0000152573', '1111'));
    expect(await rechazo(existe.consultar('0000152573', '4567'))).toEqual(
      await rechazo(noExiste.consultar('0000152573', '4567')),
    );
  });

  it('el bloqueo es por folio: otro folio del mismo kiosko sigue disponible', async () => {
    const { consultar } = crear();
    await fallar(consultar, FALLOS_POR_FOLIO);
    expect((await consultar('0000152574', '4567')).pedidoId).toBe(9);
  });

  it('el bloqueo es por kiosko: el mismo folio en otro kiosko sigue disponible', async () => {
    const { consultar } = crear();
    await fallar(consultar, FALLOS_POR_FOLIO);
    expect((await consultar('0000152573', '4567', 2)).pedidoId).toBe(9);
  });

  it('variar la serie o los ceros no reinicia el contador (es el mismo folio)', async () => {
    const { consultar } = crear();
    for (const f of ['0000152573', 'HMO-0000152573', '152573', 'hmo 152573', '0000152573']) {
      expect((await rechazo(consultar(f, '1111'))).status).toBe(404);
    }
    expect((await rechazo(consultar('152573', '4567'))).status).toBe(429);
  });

  it('un acierto limpia el contador del folio: el cliente que se equivocó antes no queda castigado', async () => {
    const { consultar } = crear();
    await fallar(consultar, FALLOS_POR_FOLIO - 1);
    expect((await consultar('0000152573', '4567')).pedidoId).toBe(9);
    await fallar(consultar, FALLOS_POR_FOLIO - 1);
    expect((await consultar('0000152573', '4567')).pedidoId).toBe(9);
  });

  it('pasada la ventana de 10 minutos, el folio se libera solo', async () => {
    const { consultar, tiempo } = crear();
    await fallar(consultar, FALLOS_POR_FOLIO);
    expect((await rechazo(consultar('0000152573', '4567'))).status).toBe(429);
    tiempo.avanzar(VENTANA_INTENTOS_MS + 1);
    expect((await consultar('0000152573', '4567')).pedidoId).toBe(9);
  });

  it(`barrer folios con teléfonos al azar se corta a los ${FALLOS_POR_KIOSKO} fallos del kiosko`, async () => {
    const { consultar } = crear();
    // Un fallo por folio distinto: ninguno llega al tope por folio, pero el kiosko acumula.
    for (let i = 0; i < FALLOS_POR_KIOSKO; i++) {
      const folio = String(200000 + i);
      expect((await rechazo(consultar(folio, '1111'))).status).toBe(404);
    }
    const r = await rechazo(consultar('0000152573', '4567'));
    expect(r.status).toBe(429);
    // …y es solo de ESTE kiosko.
    expect((await consultar('0000152573', '4567', 2)).pedidoId).toBe(9);
  });

  it('un acierto NO reinicia el tope del kiosko (si no, el barrido nunca llegaría a él)', async () => {
    const { consultar } = crear();
    for (let i = 0; i < FALLOS_POR_KIOSKO - 1; i++)
      await rechazo(consultar(String(300000 + i), '1111'));
    expect((await consultar('0000152573', '4567')).pedidoId).toBe(9); // acierto
    await rechazo(consultar('0000400000', '1111')); // el fallo número 30
    expect((await rechazo(consultar('0000152573', '4567'))).status).toBe(429);
  });
});
