import { EstadoPedido, ModoEntrega } from '@prisma/client';
import { motivoNoAvisable, evaluarAviso } from './llegada-aviso.util';

/**
 * Oct 2026: la regla de "¿este pedido ya se puede avisar en tienda?" vivía
 * duplicada en `kiosko-llegada.service.ts` y en `cliente.service.ts`, con mapas
 * de mensajes que ya habían divergido. Con un tercer camino (mostrador) se
 * centralizó aquí. Estos tests fijan la regla en un solo lugar.
 */
describe('motivoNoAvisable', () => {
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
    ['PENDIENTE_PAGO', EstadoPedido.PENDIENTE_PAGO],
    ['PAGADO', EstadoPedido.PAGADO],
    ['ENVIADO', EstadoPedido.ENVIADO],
  ])('rechaza el aviso en %s con AUN_NO_ESTA_LISTO', (_n, estado) => {
    const motivo = motivoNoAvisable({ ...base, estado });
    expect(motivo?.codigo).toBe('AUN_NO_ESTA_LISTO');
    expect(motivo?.message.length).toBeGreaterThan(0);
  });

  it('distingue un pedido ya entregado de uno cancelado', () => {
    // El frontend usa el `codigo` para elegir el copy, así que no pueden
    // colapsarse en el mismo valor.
    expect(motivoNoAvisable({ ...base, estado: EstadoPedido.ENTREGADO })?.codigo).toBe(
      'YA_ENTREGADO',
    );
    expect(motivoNoAvisable({ ...base, estado: EstadoPedido.CANCELADO })?.codigo).toBe('CANCELADO');
  });

  it('da un mensaje para TODOS los estados no avisables', () => {
    // Un estado sin mensaje cae al genérico; lo que no puede pasar es que el
    // cliente vea un texto vacío.
    for (const estado of Object.values(EstadoPedido)) {
      if (estado === EstadoPedido.REVISADO) continue;
      const motivo = motivoNoAvisable({ ...base, estado });
      expect(motivo?.message.trim().length).toBeGreaterThan(0);
    }
  });
});

/**
 * Oct 2026: el operador de mostrador con el cliente enfrente.
 *
 * El bug que estos tests previenen: el cliente llega a tienda SIN ticket y SIN
 * folio, y su pedido todavía está en bodega (o esperando que apruebe una
 * propuesta, o en caja). Con la regla del CLIENTE, `marcar-llegada` devolvía 409
 * y el operador se quedaba sin salida. Ahora puede registrar la presencia en
 * cualquier estado no terminal — pero eso NO debe meter el pedido a la cola del
 * mostrador antes de tiempo.
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
  ])('el operador NO puede avisar en %s (terminal)', (_n, estado) => {
    const r = evaluarAviso({ ...base, estado }, 'OPERADOR');
    expect(r.puede).toBe(false);
    expect(r.codigo).toBe(
      estado === EstadoPedido.ENTREGADO ? 'YA_ENTREGADO' : 'CANCELADO',
    );
  });

  it('el operador no puede avisar un pedido a domicilio', () => {
    const r = evaluarAviso({ ...base, modoEntrega: ModoEntrega.DOMICILIO }, 'OPERADOR');
    expect(r.puede).toBe(false);
    expect(r.codigo).toBe('ES_A_DOMICILIO');
  });

  it('entraACola es true SOLO en REVISADO, para los dos orígenes', () => {
    // Es el invariante que sostiene todo: marcar la llegada en EN_REVISION deja
    // constancia de que el cliente está ahí, pero NO mete el pedido a la cola
    // del mostrador. El gate de visibilidad sigue exigiendo REVISADO.
    for (const estado of Object.values(EstadoPedido)) {
      const esperado = estado === EstadoPedido.REVISADO;
      expect(evaluarAviso({ ...base, estado }, 'OPERADOR').entraACola).toBe(esperado);
      expect(evaluarAviso({ ...base, estado }, 'CLIENTE').entraACola).toBe(esperado);
    }
  });

  it('la regla del CLIENTE no cambió: sigue rechazando lo que no está listo', () => {
    // El cliente avisando desde su casa, con el pedido en bodega, es ruido en la
    // consola. Solo el operador —que tiene al cliente enfrente— puede hacerlo.
    for (const estado of Object.values(EstadoPedido)) {
      if (estado === EstadoPedido.REVISADO) continue;
      expect(evaluarAviso({ ...base, estado }, 'CLIENTE').puede).toBe(false);
    }
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
    const enBodega = evaluarAviso(
      { ...base, estado: EstadoPedido.EN_REVISION },
      'OPERADOR',
    );
    expect(enCola.message).toMatch(/cola/i);
    expect(enBodega.message).toMatch(/equipo/i);
    expect(enCola.message).not.toBe(enBodega.message);
  });
});
