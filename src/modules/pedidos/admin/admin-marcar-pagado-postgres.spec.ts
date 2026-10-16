import 'dotenv/config';
import { ConflictException } from '@nestjs/common';
import { EstadoPedido, PrismaClient, RolUsuario } from '@prisma/client';
import { AdminService } from './admin.service';
import { PedidoAccessService } from '../core/pedido-access.service';

/**
 * Fase 0 de pagos por transferencia (oct 2026): `marcarComoPagado` contra PostgreSQL REAL.
 *
 * Dos bugs que un mock de Prisma no puede ver porque dependen de lo que el `where` de un
 * `updateMany` hace con filas de verdad:
 *
 *   H3  El `updateMany` filtraba por `estado: { not: PAGADO }`. Si el pedido se cancelaba
 *       entre la lectura y la escritura, `CANCELADO → PAGADO`.
 *   H10 Solo `PAGADO` contaba como "ya cobrado": un pedido ENVIADO retrocedía a PAGADO
 *       cada vez que llegaba otro evento del trigger con FINALIZADA = true.
 */

jest.setTimeout(30_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const notifications = { enviar: jest.fn().mockResolvedValue(undefined) };
const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn(), emitToUser: jest.fn() };

let tiendaId: number;
let clienteId: number;
const pedidoIds: number[] = [];
let consecutivo = 0;

const AGENTE = { userId: 0, nombre: 'AGENT_EXTERNAL', rol: 'AGENT' as RolUsuario };
// Un humano: el agente es `userId: 0` (el id real de un usuario nunca es 0).
const ADMIN = { userId: 987_654, nombre: 'Admin Test', rol: RolUsuario.ADMIN };

function servicio(cliente: unknown = prisma) {
  return new AdminService(
    cliente as never,
    notifications as never,
    realtime as never,
    new PedidoAccessService(prisma as never),
    {} as never,
  );
}

async function crearPedido(estado: EstadoPedido, opts: { encolado?: boolean } = {}) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-P${suffix}-${++consecutivo}`,
      usuarioId: clienteId,
      tiendaId,
      estado,
      clienteNombre: 'Cliente Test',
      clienteEmail: `pago-${suffix}@test.local`,
      subtotal: 100,
      total: 100,
      ...(opts.encolado === false ? {} : { pendienteEnvio: { create: { estado: 'PROCESADO' } } }),
    },
  });
  pedidoIds.push(p.id);
  return p;
}

beforeAll(async () => {
  await prisma.$connect();
  const tienda = await prisma.tienda.create({
    data: { nombre: `Pago test ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  tiendaId = tienda.id;
  const cliente = await prisma.usuario.create({
    data: {
      email: `pago-cliente-${suffix}@test.local`,
      password: 'solo-para-pruebas',
      nombre: 'Cliente',
      rol: RolUsuario.CLIENTE,
    },
  });
  clienteId = cliente.id;
});

afterAll(async () => {
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.usuario.deleteMany({ where: { id: clienteId } });
  await prisma.tienda.deleteMany({ where: { id: tiendaId } });
  await prisma.$disconnect();
});

beforeEach(() => jest.clearAllMocks());

describe('marcarComoPagado contra PostgreSQL', () => {
  it('camino feliz: PENDIENTE_PAGO → PAGADO con historial, realtime y correo UNA vez', async () => {
    const p = await crearPedido(EstadoPedido.PENDIENTE_PAGO);
    await servicio().marcarComoPagado(p.id, { referencia: 'FACTURA-1' }, AGENTE);

    const despues = await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } });
    expect(despues.estado).toBe(EstadoPedido.PAGADO);
    expect(despues.fechaPago).not.toBeNull();

    const historial = await prisma.historialPedido.findMany({ where: { pedidoId: p.id } });
    expect(historial).toHaveLength(1);
    expect(historial[0]).toMatchObject({
      estadoAnterior: EstadoPedido.PENDIENTE_PAGO,
      estadoNuevo: EstadoPedido.PAGADO,
    });
    expect(historial[0].observacion).toContain('FACTURA-1');
    expect(realtime.emitToTienda).toHaveBeenCalledTimes(1);
    expect(notifications.enviar).toHaveBeenCalledTimes(1);
  });

  it('H3: un pedido que se CANCELA entre la lectura y la escritura NO se revive', async () => {
    const p = await crearPedido(EstadoPedido.PENDIENTE_PAGO);

    // El cliente "gana la carrera": justo después de que el servicio hace su primera
    // lectura (PENDIENTE_PAGO), el pedido se cancela. Con el `where` viejo
    // (`estado: { not: PAGADO }`) el UPDATE seguía aplicando y dejaba CANCELADO → PAGADO.
    let cancelado = false;
    const conCarrera = {
      pedido: {
        findUnique: async (args: never) => {
          const fila = await prisma.pedido.findUnique(args);
          if (!cancelado) {
            cancelado = true;
            await prisma.pedido.update({
              where: { id: p.id },
              data: { estado: EstadoPedido.CANCELADO },
            });
          }
          return fila;
        },
      },
      pedidoPendienteEnvio: prisma.pedidoPendienteEnvio,
      $transaction: (cb: never) => prisma.$transaction(cb),
    };

    await expect(servicio(conCarrera).marcarComoPagado(p.id, undefined, AGENTE)).rejects.toThrow(
      ConflictException,
    );

    const despues = await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } });
    expect(despues.estado).toBe(EstadoPedido.CANCELADO);
    expect(despues.fechaPago).toBeNull();
    expect(await prisma.historialPedido.count({ where: { pedidoId: p.id } })).toBe(0);
    expect(notifications.enviar).not.toHaveBeenCalled();
  });

  it('H3: la transición se guarda con el estado LEÍDO en la transacción, no el de antes', async () => {
    // El agente puede cobrar desde cualquier estado no terminal. Si el pedido cambia de
    // estado en medio (REVISADO → EN_ATENCION, por ejemplo), el historial debe decir
    // desde dónde pasó REALMENTE a PAGADO.
    const p = await crearPedido(EstadoPedido.EN_ATENCION);
    let movido = false;
    const conCambio = {
      pedido: {
        findUnique: async (args: never) => {
          const fila = await prisma.pedido.findUnique(args);
          if (!movido) {
            movido = true;
            await prisma.pedido.update({
              where: { id: p.id },
              data: { estado: EstadoPedido.PENDIENTE_PAGO },
            });
          }
          return fila;
        },
      },
      pedidoPendienteEnvio: prisma.pedidoPendienteEnvio,
      $transaction: (cb: never) => prisma.$transaction(cb),
    };

    await servicio(conCambio).marcarComoPagado(p.id, undefined, AGENTE);

    const historial = await prisma.historialPedido.findMany({ where: { pedidoId: p.id } });
    expect(historial[0].estadoAnterior).toBe(EstadoPedido.PENDIENTE_PAGO);
    expect(realtime.emitToTienda).toHaveBeenCalledWith(
      tiendaId,
      'pedido.estado',
      expect.objectContaining({ estadoAnterior: EstadoPedido.PENDIENTE_PAGO }),
    );
  });

  it.each([EstadoPedido.ENVIADO, EstadoPedido.ENTREGADO, EstadoPedido.PAGADO])(
    'H10: un pedido %s ya cobrado no se toca (sin retroceso, sin correo, sin historial)',
    async (estado) => {
      const p = await crearPedido(estado);
      const resultado = await servicio().marcarComoPagado(p.id, undefined, AGENTE);

      expect(resultado.estado).toBe(estado);
      const despues = await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } });
      expect(despues.estado).toBe(estado);
      expect(await prisma.historialPedido.count({ where: { pedidoId: p.id } })).toBe(0);
      expect(realtime.emitToTienda).not.toHaveBeenCalled();
      expect(notifications.enviar).not.toHaveBeenCalled();
    },
  );

  it('dos cobros simultáneos del mismo pedido: uno escribe, el otro es idempotente', async () => {
    const p = await crearPedido(EstadoPedido.PENDIENTE_PAGO);
    const [a, b] = await Promise.all([
      servicio().marcarComoPagado(p.id, undefined, AGENTE),
      servicio().marcarComoPagado(p.id, undefined, AGENTE),
    ]);
    expect(a.estado).toBe(EstadoPedido.PAGADO);
    expect(b.estado).toBe(EstadoPedido.PAGADO);
    expect(await prisma.historialPedido.count({ where: { pedidoId: p.id } })).toBe(1);
    expect(notifications.enviar).toHaveBeenCalledTimes(1);
  });

  it('un CANCELADO ya cancelado sigue rechazándose', async () => {
    const p = await crearPedido(EstadoPedido.CANCELADO);
    await expect(servicio().marcarComoPagado(p.id, undefined, AGENTE)).rejects.toThrow(
      /PENDIENTE_PAGO/,
    );
  });

  it('el agente no cobra un pedido que nunca llegó a Firebird', async () => {
    const p = await crearPedido(EstadoPedido.REVISADO, { encolado: false });
    await expect(servicio().marcarComoPagado(p.id, undefined, AGENTE)).rejects.toThrow(
      /nunca llegó a Firebird/,
    );
  });

  it('un ADMIN humano solo cobra desde PENDIENTE_PAGO', async () => {
    const p = await crearPedido(EstadoPedido.EN_ATENCION);
    await expect(servicio().marcarComoPagado(p.id, undefined, ADMIN)).rejects.toThrow(
      /PENDIENTE_PAGO/,
    );
  });

  it('un pago manual de ADMIN queda marcado como MANUAL en el historial', async () => {
    const p = await crearPedido(EstadoPedido.PENDIENTE_PAGO);
    await servicio().marcarComoPagado(p.id, { referencia: '  FIREBIRD-77  ' }, ADMIN);
    const [fila] = await prisma.historialPedido.findMany({ where: { pedidoId: p.id } });
    expect(fila.observacion).toContain('MANUALMENTE');
    expect(fila.observacion).toContain('Admin Test');
    expect(fila.observacion).toContain('FIREBIRD-77');

    const sinRef = await crearPedido(EstadoPedido.PENDIENTE_PAGO);
    await servicio().marcarComoPagado(sinRef.id, undefined, ADMIN);
    const [fila2] = await prisma.historialPedido.findMany({ where: { pedidoId: sinRef.id } });
    expect(fila2.observacion).toContain('sin referencia');
  });

  it('una fecha de pago inválida se rechaza antes de tocar nada', async () => {
    const p = await crearPedido(EstadoPedido.PENDIENTE_PAGO);
    await expect(
      servicio().marcarComoPagado(p.id, { fechaPago: 'no-es-fecha' }, AGENTE),
    ).rejects.toThrow(/fechaPago/);
    const despues = await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } });
    expect(despues.estado).toBe(EstadoPedido.PENDIENTE_PAGO);
  });
});
