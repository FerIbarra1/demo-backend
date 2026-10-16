import { EstadoPedido, ModoEntrega } from '@prisma/client';
import { motivoNoAvisable, evaluarAviso, avisoDeLlegadaSirve } from './llegada-aviso.util';

/**
 * La regla de "¿se puede registrar el aviso de llegada de este pedido?" vive en
 * UN solo lugar (antes estaba duplicada en kiosko y cliente, con mapas de
 * mensajes que ya habían divergido).
 *
 * F22 (oct 2026): el cliente puede avisar su llegada en CUALQUIER estado no
 * terminal — también antes de que bodega termine. Antes solo en `REVISADO`: el
 * cliente que llegaba temprano no tenía cómo decirlo (la app le ocultaba el botón
 * y el kiosko respondía 409), aunque bodega ya priorizaba a los clientes
 * presentes y `destinoTrasSurtidoIncompleto` decidía mirando ese mismo dato.
 */
describe('motivoNoAvisable (la regla vista desde el CLIENTE)', () => {
  const base = {
    estado: EstadoPedido.REVISADO,
    modoEntrega: ModoEntrega.RECOGER_TIENDA,
  };

  it('deja pasar un pedido listo para recoger en tienda', () => {
    expect(motivoNoAvisable(base)).toBeNull();
  });

  it('deja pasar un pedido de kiosko listo', () => {
    expect(motivoNoAvisable({ ...base, modoEntrega: ModoEntrega.KIOSKO })).toBeNull();
  });

  it('rechaza un pedido a domicilio aunque esté listo', () => {
    const motivo = motivoNoAvisable({
      ...base,
      modoEntrega: ModoEntrega.DOMICILIO,
    });
    expect(motivo?.codigo).toBe('ES_A_DOMICILIO');
    expect(motivo?.message).toMatch(/domicilio/i);
  });

  it.each([
    ['SOLICITADO', EstadoPedido.SOLICITADO],
    ['EN_REVISION', EstadoPedido.EN_REVISION],
    ['ESPERANDO_APROBACION', EstadoPedido.ESPERANDO_APROBACION],
    ['EN_ASESORIA', EstadoPedido.EN_ASESORIA],
    ['REVISADO', EstadoPedido.REVISADO],
    ['EN_ATENCION', EstadoPedido.EN_ATENCION],
    ['PENDIENTE_PAGO', EstadoPedido.PENDIENTE_PAGO],
    ['PAGADO', EstadoPedido.PAGADO],
    ['ENVIADO', EstadoPedido.ENVIADO],
  ])('el CLIENTE SÍ puede avisar en %s (aviso anticipado)', (_n, estado) => {
    expect(motivoNoAvisable({ ...base, estado })).toBeNull();
  });

  it('distingue un pedido ya entregado de uno cancelado', () => {
    // El frontend usa el `codigo` para elegir el copy, así que no pueden
    // colapsarse en el mismo valor.
    expect(motivoNoAvisable({ ...base, estado: EstadoPedido.ENTREGADO })?.codigo).toBe(
      'YA_ENTREGADO',
    );
    expect(motivoNoAvisable({ ...base, estado: EstadoPedido.CANCELADO })?.codigo).toBe('CANCELADO');
  });

  it('da un mensaje no vacío para TODO lo que rechaza', () => {
    // Lo que no puede pasar es que el cliente vea un texto vacío.
    for (const estado of Object.values(EstadoPedido)) {
      const motivo = motivoNoAvisable({ ...base, estado });
      if (motivo) expect(motivo.message.trim().length).toBeGreaterThan(0);
    }
    expect(
      motivoNoAvisable({ ...base, modoEntrega: ModoEntrega.DOMICILIO })?.message.trim().length,
    ).toBeGreaterThan(0);
  });
});

/**
 * Oct 2026: el operador de mostrador con el cliente enfrente.
 *
 * El bug que estos tests previenen: el cliente llega a tienda SIN ticket y SIN
 * folio, y su pedido todavía está en bodega (o esperando que apruebe una
 * propuesta, o en caja). Con la regla vieja del CLIENTE, `marcar-llegada`
 * devolvía 409 y el operador se quedaba sin salida.
 */
describe('evaluarAviso — el operador marca la presencia del cliente', () => {
  const base = {
    estado: EstadoPedido.REVISADO,
    modoEntrega: ModoEntrega.RECOGER_TIENDA,
  };

  it.each([
    ['SOLICITADO', EstadoPedido.SOLICITADO],
    ['EN_REVISION', EstadoPedido.EN_REVISION],
    ['ESPERANDO_APROBACION', EstadoPedido.ESPERANDO_APROBACION],
    ['EN_ASESORIA', EstadoPedido.EN_ASESORIA],
    ['REVISADO', EstadoPedido.REVISADO],
    ['PENDIENTE_PAGO', EstadoPedido.PENDIENTE_PAGO],
    ['PAGADO', EstadoPedido.PAGADO],
    ['ENVIADO', EstadoPedido.ENVIADO],
  ])('el operador SÍ puede avisar en %s', (_n, estado) => {
    expect(evaluarAviso({ ...base, estado }, 'OPERADOR').puede).toBe(true);
  });

  it.each([
    ['ENTREGADO', EstadoPedido.ENTREGADO],
    ['CANCELADO', EstadoPedido.CANCELADO],
  ])('NADIE puede avisar en %s (terminal)', (_n, estado) => {
    for (const origen of ['OPERADOR', 'CLIENTE'] as const) {
      const r = evaluarAviso({ ...base, estado }, origen);
      expect(r.puede).toBe(false);
      expect(r.codigo).toBe(estado === EstadoPedido.ENTREGADO ? 'YA_ENTREGADO' : 'CANCELADO');
    }
  });

  it('nadie puede avisar un pedido a domicilio', () => {
    for (const origen of ['OPERADOR', 'CLIENTE'] as const) {
      const r = evaluarAviso({ ...base, modoEntrega: ModoEntrega.DOMICILIO }, origen);
      expect(r.puede).toBe(false);
      expect(r.codigo).toBe('ES_A_DOMICILIO');
    }
  });

  it('entraACola es true en REVISADO, EN_ATENCION y ESPERANDO_APROBACION', () => {
    // REVISADO / EN_ATENCION: ya están en la cola. ESPERANDO_APROBACION: el aviso
    // lo mueve al área de entrega (PresenciaService.alLlegarCliente).
    // En EN_REVISION NO: el pedido sigue en bodega y entrará a la cola, con su
    // badge EN TIENDA, cuando bodega termine.
    const enCola = new Set<EstadoPedido>([
      EstadoPedido.REVISADO,
      EstadoPedido.EN_ATENCION,
      EstadoPedido.ESPERANDO_APROBACION,
    ]);
    for (const estado of Object.values(EstadoPedido)) {
      const esperado = enCola.has(estado);
      expect(evaluarAviso({ ...base, estado }, 'OPERADOR').entraACola).toBe(
        esperado && estado !== EstadoPedido.ENTREGADO && estado !== EstadoPedido.CANCELADO,
      );
    }
    expect(evaluarAviso({ ...base, estado: EstadoPedido.EN_REVISION }, 'CLIENTE').entraACola).toBe(
      false,
    );
    expect(
      evaluarAviso({ ...base, estado: EstadoPedido.ESPERANDO_APROBACION }, 'CLIENTE').entraACola,
    ).toBe(true);
  });

  it('motivoNoAvisable sigue siendo equivalente a la regla del CLIENTE', () => {
    for (const estado of Object.values(EstadoPedido)) {
      const motivo = motivoNoAvisable({ ...base, estado });
      const evaluacion = evaluarAviso({ ...base, estado }, 'CLIENTE');
      expect(motivo === null).toBe(evaluacion.puede);
    }
  });

  it('el mensaje del operador distingue si el pedido ya entró a la cola', () => {
    const enCola = evaluarAviso({ ...base }, 'OPERADOR');
    const enBodega = evaluarAviso({ ...base, estado: EstadoPedido.EN_REVISION }, 'OPERADOR');
    expect(enCola.message).toMatch(/cola/i);
    expect(enBodega.message).toMatch(/equipo/i);
    expect(enCola.message).not.toBe(enBodega.message);
  });

  describe('avisoDeLlegadaSirve (lo que la app del cliente ofrece)', () => {
    it('sirve mientras el pedido sigue antes de pagarse, hasta el área de entrega', () => {
      for (const estado of [
        EstadoPedido.SOLICITADO,
        EstadoPedido.EN_REVISION,
        EstadoPedido.ESPERANDO_APROBACION,
        EstadoPedido.EN_ASESORIA,
        EstadoPedido.REVISADO,
      ]) {
        expect(avisoDeLlegadaSirve({ ...base, estado })).toBe(true);
      }
    });

    it('NO sirve cuando ya lo están atendiendo, ni del pago en adelante (solo dejaría constancia)', () => {
      // El servidor ACEPTARÍA el aviso en estos estados, pero ya no cambia nada: el cliente pasó
      // por mostrador. Mostrarle "Ya llegué" en un pedido por pagar era el síntoma.
      for (const estado of [
        EstadoPedido.EN_ATENCION,
        EstadoPedido.PENDIENTE_PAGO,
        EstadoPedido.PAGADO,
        EstadoPedido.ENVIADO,
        EstadoPedido.ENTREGADO,
        EstadoPedido.CANCELADO,
      ]) {
        expect(avisoDeLlegadaSirve({ ...base, estado })).toBe(false);
      }
    });

    it('un pedido a domicilio nunca lo ofrece', () => {
      expect(
        avisoDeLlegadaSirve({ estado: EstadoPedido.REVISADO, modoEntrega: ModoEntrega.DOMICILIO }),
      ).toBe(false);
    });
  });
});
