import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EstadoPedido, ModoEntrega, TipoNotificacion } from '@prisma/client';
import { MAX_CONFIRMACIONES_INTERES, SinRecogerService } from './sin-recoger.service';

/**
 * F22 (oct 2026): los pedidos apartados que nadie recoge.
 *
 *   24 h → correo "¿aún quieres tu pedido?" (una sola vez)
 *   72 h → aparece como VENCIDO en el mostrador; el operador decide (NO se cancela solo)
 *
 * Y los avisos de llegada que nadie atendió caducan solos.
 */
const horas = (h: number) => new Date(Date.now() - h * 3_600_000);

function crearServicio(
  opts: {
    candidatosRecordatorio?: Array<Record<string, unknown>>;
    candidatosCaducidad?: Array<Record<string, unknown>>;
    reclamo?: number;
    pedido?: Record<string, unknown> | null;
  } = {},
) {
  const findMany = jest.fn(async (args: any) =>
    // La caducidad filtra por presenteDesdeAt; el recordatorio por esperaClienteDesdeAt.
    args.where.presenteDesdeAt
      ? (opts.candidatosCaducidad ?? [])
      : (opts.candidatosRecordatorio ?? []),
  );
  const updateMany = jest.fn(async (_args: unknown) => ({ count: opts.reclamo ?? 1 }));
  const historialCreate = jest.fn().mockResolvedValue({});
  const findUnique = jest.fn().mockResolvedValue(opts.pedido ?? null);

  const prisma = {
    pedido: { findMany, updateMany, findUnique },
    historialPedido: { create: historialCreate },
  };
  const realtime = { emitToTienda: jest.fn() };
  const enviar = jest.fn().mockResolvedValue([]);
  const config = {
    get: jest.fn().mockReturnValue({
      recordatorioHoras: 24,
      vencidoHoras: 72,
      presenciaCaducaHoras: 8,
    }),
  };

  const svc = new SinRecogerService(
    prisma as never,
    config as never,
    realtime as never,
    { enviar } as never,
  );
  return { svc, findMany, updateMany, historialCreate, realtime, enviar };
}

const pedidoEsperando = (extra: Record<string, unknown> = {}) => ({
  id: 10,
  tiendaId: 5,
  estado: EstadoPedido.REVISADO,
  modoEntrega: ModoEntrega.RECOGER_TIENDA,
  clienteEmail: 'a@b.com',
  esperaClienteDesdeAt: horas(30),
  recordatorioRecogerAt: null,
  ...extra,
});

describe('SinRecogerService.barrer — recordatorio "¿aún lo quieres?"', () => {
  it('manda el correo RECORDATORIO_RECOGER a los que llevan más de 24 h', async () => {
    const { svc, enviar } = crearServicio({ candidatosRecordatorio: [pedidoEsperando()] });

    const r = await svc.barrer();

    expect(r.recordatorios).toBe(1);
    expect(enviar).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10 }),
      TipoNotificacion.RECORDATORIO_RECOGER,
    );
  });

  it('busca solo pedidos AUSENTES, de recoger en tienda y que no se hayan recordado', async () => {
    const { svc, findMany } = crearServicio();
    await svc.barrer();

    // La consulta del recordatorio es la que filtra por esperaClienteDesdeAt.
    const where = findMany.mock.calls
      .map((c) => c[0].where)
      .find((w: any) => w.esperaClienteDesdeAt)!;
    expect(where.estado).toEqual({
      in: [EstadoPedido.REVISADO, EstadoPedido.ESPERANDO_APROBACION],
    });
    // Un pedido a domicilio no se "recoge": su ciclo es otro.
    expect(where.modoEntrega).toEqual({ in: [ModoEntrega.RECOGER_TIENDA, ModoEntrega.KIOSKO] });
    // Una sola vez por ciclo de espera.
    expect(where.recordatorioRecogerAt).toBeNull();
    // Si el cliente está en la tienda, preguntarle si aún lo quiere es absurdo.
    expect(where.OR).toEqual(expect.arrayContaining([{ llegadaDescartadaAt: { not: null } }]));
    // Y respeta el plazo.
    const limite = (where.esperaClienteDesdeAt.lt as Date).getTime();
    expect(Math.abs(Date.now() - 24 * 3_600_000 - limite)).toBeLessThan(5_000);
  });

  it('RECLAMA la fila antes de enviar: dos barridos no mandan dos correos', async () => {
    // Si otra instancia (o el barrido anterior) ya lo reclamó, `count` es 0 y no se
    // envía. Es mejor perder un recordatorio que mandar el mismo correo cada 15 min.
    const { svc, enviar, historialCreate } = crearServicio({
      candidatosRecordatorio: [pedidoEsperando()],
      reclamo: 0,
    });

    const r = await svc.barrer();

    expect(r.recordatorios).toBe(0);
    expect(enviar).not.toHaveBeenCalled();
    expect(historialCreate).not.toHaveBeenCalled();
  });

  it('el reclamo es condicional: solo si recordatorioRecogerAt sigue en null', async () => {
    const { svc, updateMany } = crearServicio({ candidatosRecordatorio: [pedidoEsperando()] });
    await svc.barrer();

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 10, recordatorioRecogerAt: null },
      data: { recordatorioRecogerAt: expect.any(Date) },
    });
  });

  it('deja constancia en el historial y avisa a la consola', async () => {
    const { svc, historialCreate, realtime } = crearServicio({
      candidatosRecordatorio: [pedidoEsperando()],
    });

    await svc.barrer();

    expect(historialCreate.mock.calls[0][0].data.observacion).toMatch(/recordatorio enviado/i);
    expect(realtime.emitToTienda).toHaveBeenCalledWith(5, 'monitor.invalidado', { pedidoId: 10 });
  });

  it('un correo que falla NO tumba el barrido ni a los demás pedidos', async () => {
    const { svc, enviar } = crearServicio({
      candidatosRecordatorio: [pedidoEsperando({ id: 10 }), pedidoEsperando({ id: 11 })],
    });
    enviar.mockRejectedValueOnce(new Error('SMTP caído'));

    const r = await svc.barrer();

    expect(r.recordatorios).toBe(2);
    expect(enviar).toHaveBeenCalledTimes(2);
  });
});

describe('SinRecogerService.barrer — caducidad de avisos sin atender', () => {
  it('caduca el aviso de un pedido REVISADO presente que nadie atendió en 8 h', async () => {
    const { svc, updateMany, historialCreate } = crearServicio({
      candidatosCaducidad: [{ id: 20, tiendaId: 5 }],
    });

    const r = await svc.barrer();

    expect(r.caducadas).toBe(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 20, estado: EstadoPedido.REVISADO, llegadaDescartadaAt: null },
      data: { llegadaDescartadaAt: expect.any(Date) },
    });
    expect(historialCreate.mock.calls[0][0].data.observacion).toMatch(/caducó/i);
  });

  it('NO cuenta como descarte: no fue una falsa alarma, fue tiempo', async () => {
    // Si incrementara `llegadaDescartes`, un cliente que avisa legítimamente y a
    // quien nadie atiende en 8 h se quedaría sin botón web.
    const { svc, updateMany } = crearServicio({ candidatosCaducidad: [{ id: 20, tiendaId: 5 }] });
    await svc.barrer();
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain('llegadaDescartes');
  });

  it('solo caduca pedidos en REVISADO (uno ya llamado lo está atendiendo alguien)', async () => {
    const { svc, findMany } = crearServicio();
    await svc.barrer();

    const where = findMany.mock.calls.map((c) => c[0].where).find((w: any) => w.presenteDesdeAt)!;
    expect(where.estado).toBe(EstadoPedido.REVISADO);
    // Y solo los que de verdad están presentes.
    expect(where.llegadaDescartadaAt).toBeNull();
  });

  it('si el pedido cambió entre la lectura y la escritura, no lo toca ni lo cuenta', async () => {
    const { svc, historialCreate } = crearServicio({
      candidatosCaducidad: [{ id: 20, tiendaId: 5 }],
      reclamo: 0,
    });

    const r = await svc.barrer();

    expect(r.caducadas).toBe(0);
    expect(historialCreate).not.toHaveBeenCalled();
  });

  it('invalida el monitor UNA vez por tienda, no una por pedido', async () => {
    const { svc, realtime } = crearServicio({
      candidatosCaducidad: [
        { id: 20, tiendaId: 5 },
        { id: 21, tiendaId: 5 },
        { id: 22, tiendaId: 6 },
      ],
    });

    await svc.barrer();

    expect(realtime.emitToTienda).toHaveBeenCalledTimes(2);
  });
});

describe('SinRecogerService.confirmarInteres — "sí, aún lo quiero"', () => {
  const pedido = (extra: Record<string, unknown> = {}) => ({
    id: 10,
    usuarioId: 7,
    tiendaId: 5,
    estado: EstadoPedido.REVISADO,
    canalOrigen: 'WEB',
    llegadaAnunciadaAt: null,
    llegadaDescartadaAt: null,
    interesConfirmadoCount: 0,
    ...extra,
  });

  it('reinicia la espera: nuevo plazo y nuevo recordatorio', async () => {
    const { svc, updateMany, historialCreate } = crearServicio({ pedido: pedido() });

    await expect(svc.confirmarInteres(10, 7)).resolves.toEqual({ ok: true, pedidoId: 10 });

    const { data } = updateMany.mock.calls[0][0] as any;
    expect(data.esperaClienteDesdeAt).toBeInstanceOf(Date);
    expect(data.recordatorioRecogerAt).toBeNull();
    expect(data.interesConfirmadoCount).toEqual({ increment: 1 });
    expect(historialCreate.mock.calls[0][0].data.observacion).toMatch(/sigue interesado/i);
  });

  it(`tiene tope (${MAX_CONFIRMACIONES_INTERES}): después decide el mostrador`, async () => {
    // Sin tope, un cliente podría postergar para siempre una bolsa apartada
    // diciendo "sí" cada tres días sin pasar nunca.
    const { svc, updateMany } = crearServicio({
      pedido: pedido({ interesConfirmadoCount: MAX_CONFIRMACIONES_INTERES }),
    });

    await expect(svc.confirmarInteres(10, 7)).rejects.toThrow(/pasa por tu pedido|cancélalo/i);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('la escritura es condicional al conteo leído: un doble toque no cuenta dos veces', async () => {
    const { svc, updateMany } = crearServicio({
      pedido: pedido({ interesConfirmadoCount: 1 }),
    });
    await svc.confirmarInteres(10, 7);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 10, interesConfirmadoCount: 1 } }),
    );
  });

  it('si otro toque ganó la carrera, responde sin escribir historial', async () => {
    const { svc, historialCreate } = crearServicio({ pedido: pedido(), reclamo: 0 });
    await expect(svc.confirmarInteres(10, 7)).rejects.toThrow(BadRequestException);
    expect(historialCreate).not.toHaveBeenCalled();
  });

  it('solo el dueño del pedido', async () => {
    const { svc } = crearServicio({ pedido: pedido({ usuarioId: 99 }) });
    await expect(svc.confirmarInteres(10, 7)).rejects.toThrow(NotFoundException);
  });

  it('solo si el pedido está apartado esperando al cliente', async () => {
    const { svc } = crearServicio({ pedido: pedido({ estado: EstadoPedido.PAGADO }) });
    await expect(svc.confirmarInteres(10, 7)).rejects.toThrow(/no está esperando/i);
  });

  it('si el cliente ya está en la tienda no tiene sentido preguntarle', async () => {
    const { svc } = crearServicio({ pedido: pedido({ llegadaAnunciadaAt: new Date() }) });
    await expect(svc.confirmarInteres(10, 7)).rejects.toThrow(/ya avisaste/i);
  });
});
