import 'dotenv/config';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  EstadoPagoTransferencia,
  EstadoPedido,
  ModoEntrega,
  PrismaClient,
  RolUsuario,
} from '@prisma/client';
import { PedidoAccessService } from '../pedidos/core/pedido-access.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { ReposicionService } from '../pedidos/reposicion/reposicion.service';
import { AdminService } from '../pedidos/admin/admin.service';
import { abrirTareaErp, cerrarTareasConfirmadasPorEl } from '../pedidos/core/tareas-erp.util';
import { CuentasBancariasService } from '../pagos/cuentas/cuentas-bancarias.service';
import { PagoTransferenciaService } from '../pagos/transferencia/pago-transferencia.service';
import { TesoreriaService } from '../pagos/transferencia/tesoreria.service';
import { DestrabarService } from './destrabar.service';
import { TareasErpService } from './tareas-erp.service';

/**
 * Oct 2026 contra PostgreSQL REAL: destrabar pedidos y la lista de tareas del Sistema Comercial. Dos tiendas, para
 * comprobar el aislamiento. Lo que se fija: la cancelación (de CUALQUIER camino) abre la tarea solo si el pedido YA
 * está en el ERP, la acción deja su bitácora y NO manda correo, y un gerente jamás toca una tienda ajena.
 */
jest.setTimeout(60_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const realtime = {
  emitToTienda: jest.fn(),
  emitToPedido: jest.fn(),
  emitToUser: jest.fn(),
  emitToTesoreria: jest.fn(),
};
const notifications = {
  enviar: jest.fn().mockResolvedValue(undefined),
  enviarTransferencia: jest.fn(),
};
const config = {
  get: (k: string) => ({ 'app.pagos.alertaSinRegistrarHoras': 4, 'app.mail.frontendUrl': 'x' })[k],
};
const storage = {
  guardar: jest.fn(),
  eliminar: jest.fn(),
  leer: jest.fn(),
  resolverImagen: (x: unknown) => x,
};

let tiendaA: number;
let tiendaB: number;
let clienteId: number;
let gerenteAId: number;
let cajeroAId: number;
const pedidoIds: number[] = [];
const usuarioIds: number[] = [];
let n = 0;

function construir() {
  const access = new PedidoAccessService(prisma as never);
  const state = new PedidoStateService(
    prisma as never,
    notifications as never,
    realtime as never,
    access,
    storage as never,
  );
  const reposicion = new ReposicionService(prisma as never, realtime as never);
  const admin = new AdminService(
    prisma as never,
    notifications as never,
    realtime as never,
    access,
    state,
  );
  const pagos = new PagoTransferenciaService(
    prisma as never,
    realtime as never,
    notifications as never,
    config as never,
    access,
    new CuentasBancariasService(prisma as never),
    storage as never,
  );
  const tes = new TesoreriaService(
    prisma as never,
    realtime as never,
    notifications as never,
    storage as never,
    pagos,
    config as never,
  );
  return {
    state,
    // Las acciones de la etapa 2 (propuestas, devolver, liberar, quitar productos) se prueban contra la BD en
    // `destrabar-etapa2-postgres.spec.ts`; aquí solo se ejercitan las de la etapa 1, que no las tocan.
    destrabar: new DestrabarService(
      prisma as never,
      access,
      state,
      reposicion,
      admin,
      tes,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ),
    tareas: new TareasErpService(prisma as never, config as never),
  };
}
const { state, destrabar, tareas } = construir();

const gerenteA = () => ({
  userId: gerenteAId,
  nombre: 'Gerente A',
  rol: RolUsuario.GERENTE,
  tiendaId: tiendaA,
});
const gerenteB = () => ({
  userId: gerenteAId,
  nombre: 'Gerente B',
  rol: RolUsuario.GERENTE,
  tiendaId: tiendaB,
});
const cajeroA = () => ({
  userId: cajeroAId,
  nombre: 'Cajero A',
  rol: RolUsuario.CAJERO,
  tiendaId: tiendaA,
});
const sistema = () => ({ userId: 0, nombre: 'AGENT_EXTERNAL', rol: RolUsuario.ADMIN });

async function pedido(
  tienda: number,
  estado: EstadoPedido,
  envio?: { estado: string; folio?: string; erpId?: number },
) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-D${suffix}-${++n}`,
      usuarioId: clienteId,
      tiendaId: tienda,
      estado,
      modoEntrega: ModoEntrega.RECOGER_TIENDA,
      clienteNombre: 'C',
      clienteEmail: `d${n}-${suffix}@test.local`,
      subtotal: 100,
      total: 100,
      ...(envio
        ? {
            pendienteEnvio: {
              create: {
                estado: envio.estado,
                externalFolio: envio.folio ?? null,
                externalIdPEDIDOS: envio.erpId ?? null,
              },
            },
          }
        : {}),
    },
  });
  pedidoIds.push(p.id);
  return p;
}
const tareasDe = (pedidoId: number) =>
  prisma.tareaSistemaComercial.findMany({ where: { pedidoId } });

beforeAll(async () => {
  const mk = (x: string) =>
    prisma.tienda.create({
      data: { nombre: `Destr ${x} ${suffix}`, direccion: 'x', ciudad: x, estado: 'x' },
    });
  tiendaA = (await mk('A')).id;
  tiendaB = (await mk('B')).id;
  const u = async (rol: RolUsuario, tid?: number) => {
    const id = (
      await prisma.usuario.create({
        data: {
          email: `${rol}-${suffix}@test.local`,
          password: 'x',
          nombre: rol,
          rol,
          tiendaId: tid ?? null,
        },
      })
    ).id;
    usuarioIds.push(id);
    return id;
  };
  clienteId = await u(RolUsuario.CLIENTE);
  gerenteAId = await u(RolUsuario.GERENTE, tiendaA);
  cajeroAId = await u(RolUsuario.CAJERO, tiendaA);
});

afterAll(async () => {
  const ids = pedidoIds;
  const pagos = await prisma.pedidoPagoTransferencia.findMany({
    where: { pedidoId: { in: ids } },
    select: { id: true },
  });
  await prisma.pagoTransferenciaEvento.deleteMany({
    where: { pagoId: { in: pagos.map((p) => p.id) } },
  });
  await prisma.pedidoPagoTransferencia.deleteMany({ where: { pedidoId: { in: ids } } });
  await prisma.pedidoReposicion.deleteMany({ where: { pedidoId: { in: ids } } });
  await prisma.pedido.deleteMany({ where: { id: { in: ids } } });
  await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } });
  await prisma.tienda.deleteMany({ where: { id: { in: [tiendaA, tiendaB] } } });
  await prisma.$disconnect();
});
beforeEach(() => jest.clearAllMocks());

describe('Cancelar un pedido y el Sistema Comercial (cualquier camino pasa por la máquina de estados)', () => {
  const cancelar = (id: number, user: object) =>
    state.cambiarEstado(
      id,
      { nuevoEstado: EstadoPedido.CANCELADO, observacion: 'Cancelado por prueba' },
      user as never,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
      },
    );

  it('YA en el ERP (PROCESADO): abre la tarea "cancelar en el Sistema Comercial" con su folio', async () => {
    const p = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, {
      estado: 'PROCESADO',
      folio: '0000000123',
      erpId: 777,
    });
    await cancelar(p.id, gerenteA());
    const t = await tareasDe(p.id);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      tipo: 'CANCELAR_EN_ERP',
      estado: 'PENDIENTE',
      folio: '0000000123',
      erpIdPedido: 777,
      tiendaId: tiendaA,
    });
  });

  it('todavía sin entregar al agente: no hay tarea y su fila se marca CANCELADO (la salud no la cuenta atorada)', async () => {
    const p = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, { estado: 'PENDIENTE' });
    await cancelar(p.id, gerenteA());
    expect(await tareasDe(p.id)).toHaveLength(0);
    const e = await prisma.pedidoPendienteEnvio.findUniqueOrThrow({ where: { pedidoId: p.id } });
    expect(e.estado).toBe('CANCELADO');
  });

  it('en vuelo (PROCESSING): no se toca ni hay tarea todavía; lo resuelve el ACK del agente', async () => {
    const p = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, { estado: 'PROCESSING' });
    await cancelar(p.id, gerenteA());
    expect(await tareasDe(p.id)).toHaveLength(0);
    expect(
      (await prisma.pedidoPendienteEnvio.findUniqueOrThrow({ where: { pedidoId: p.id } })).estado,
    ).toBe('PROCESSING');
  });

  it('lo cancela el SISTEMA (el ERP ya lo sabe): nunca genera tarea, aunque ya tenga folio', async () => {
    const p = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, {
      estado: 'PROCESADO',
      folio: '1',
      erpId: 1,
    });
    await cancelar(p.id, sistema());
    expect(await tareasDe(p.id)).toHaveLength(0);
  });

  it('un pedido que nunca se encoló (sin fila) no genera nada', async () => {
    const p = await pedido(tiendaA, EstadoPedido.SOLICITADO);
    await cancelar(p.id, gerenteA());
    expect(await tareasDe(p.id)).toHaveLength(0);
  });

  it('una sola tarea ABIERTA por pedido y tipo; y se cierra sola cuando el ERP confirma (idempotente)', async () => {
    const p = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, {
      estado: 'PROCESADO',
      folio: '2',
      erpId: 2,
    });
    const base = {
      pedidoId: p.id,
      tiendaId: tiendaA,
      tipo: 'CANCELAR_EN_ERP' as const,
      motivo: 'x',
      actor: { id: 1, rol: 'GERENTE', nombre: 'G' },
    };
    const a = await abrirTareaErp(prisma as never, base);
    const b = await abrirTareaErp(prisma as never, base);
    expect(b.id).toBe(a.id);
    expect(await cerrarTareasConfirmadasPorEl(prisma as never, p.id, 'CANCELAR_EN_ERP')).toBe(1);
    expect(await cerrarTareasConfirmadasPorEl(prisma as never, p.id, 'CANCELAR_EN_ERP')).toBe(0);
    expect((await tareasDe(p.id))[0]).toMatchObject({ estado: 'HECHA', resueltaVia: 'ERP' });
    // Cerrada, puede abrirse otra si hace falta.
    expect((await abrirTareaErp(prisma as never, base)).id).not.toBe(a.id);
  });
});

describe('DestrabarService — permisos y tienda', () => {
  it('un gerente NO toca un pedido de otra tienda (403), ni un cajero ni un cliente destraban', async () => {
    const ajeno = await pedido(tiendaB, EstadoPedido.PENDIENTE_PAGO);
    await expect(destrabar.obtener(ajeno.id, gerenteA() as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      destrabar.ejecutar(ajeno.id, 'CANCELAR_SIN_PAGO', { motivo: 'prueba' }, gerenteA() as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const propio = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO);
    await expect(destrabar.obtener(propio.id, cajeroA() as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const cliente = { userId: clienteId, nombre: 'C', rol: RolUsuario.CLIENTE, tiendaId: tiendaA };
    await expect(destrabar.obtener(propio.id, cliente as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect((await prisma.pedido.findUniqueOrThrow({ where: { id: ajeno.id } })).estado).toBe(
      EstadoPedido.PENDIENTE_PAGO,
    );
  });

  it('el servidor dice qué cabe: PENDIENTE_PAGO sin transferencia → cancelar y marcar pagado; ya pagado → nada', async () => {
    const p = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO);
    expect((await destrabar.obtener(p.id, gerenteA() as never)).acciones.map((a) => a.id)).toEqual([
      'CANCELAR_SIN_PAGO',
      'MARCAR_PAGADO',
    ]);
    // Ya cobrado, lo único que cabe al gerente es cerrarlo como entregado (cancelar uno pagado es del ADMIN).
    const pagado = await pedido(tiendaA, EstadoPedido.PAGADO);
    expect(
      (await destrabar.obtener(pagado.id, gerenteA() as never)).acciones.map((a) => a.id),
    ).toEqual(['MARCAR_ENTREGADO']);
  });
});

describe('DestrabarService — cancelar por falta de pago', () => {
  it('cancela, deja la bitácora con el motivo, NO manda correo y el cliente lee un texto estándar + su mensaje', async () => {
    const p = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, {
      estado: 'PROCESADO',
      folio: '0000000456',
      erpId: 456,
    });
    await expect(
      destrabar.ejecutar(p.id, 'CANCELAR_SIN_PAGO', { motivo: 'ab' }, gerenteA() as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    const r = await destrabar.ejecutar(
      p.id,
      'CANCELAR_SIN_PAGO',
      { motivo: 'Lleva 5 días sin pagar', mensajeCliente: 'Puedes volver a pedir cuando gustes.' },
      gerenteA() as never,
    );
    expect((await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } })).estado).toBe(
      EstadoPedido.CANCELADO,
    );
    expect(notifications.enviar).not.toHaveBeenCalled();

    const i = await prisma.pedidoIntervencion.findMany({ where: { pedidoId: p.id } });
    expect(i).toHaveLength(1);
    expect(i[0]).toMatchObject({
      tipo: 'CANCELAR_SIN_PAGO',
      motivo: 'Lleva 5 días sin pagar',
      actorRol: 'GERENTE',
      tiendaId: tiendaA,
      estadoAntes: 'PENDIENTE_PAGO',
      estadoDespues: 'CANCELADO',
    });
    expect(i[0].mensajeCliente).toBe(
      'Cancelamos tu pedido porque no recibimos el pago. Puedes volver a pedir cuando gustes.',
    );
    // El motivo INTERNO nunca es lo que lee el cliente: ni en su mensaje ni en el historial (que su pantalla pinta).
    expect(i[0].mensajeCliente).not.toContain('5 días');
    const h = await prisma.historialPedido.findMany({ where: { pedidoId: p.id } });
    expect(JSON.stringify(h)).not.toContain('5 días');
    // Ya está en el ERP: tarea para caja, y el panel la muestra con su instrucción.
    expect(r.tareas).toHaveLength(1);
    expect(r.tareas[0]).toMatchObject({
      tipo: 'CANCELAR_EN_ERP',
      titulo: 'Cancelar en el Sistema Comercial',
    });
    expect(r.tareas[0].instruccion).toContain('0000000456');
    // Y no hay segunda vez: la acción ya no cabe.
    await expect(
      destrabar.ejecutar(p.id, 'CANCELAR_SIN_PAGO', { motivo: 'otra vez' }, gerenteA() as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('con un comprobante de transferencia en revisión la acción aparece BLOQUEADA y no se ejecuta', async () => {
    const p = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO);
    await prisma.pedidoPagoTransferencia.create({
      data: {
        pedidoId: p.id,
        estado: EstadoPagoTransferencia.EN_REVISION,
        montoEsperado: 100,
        cuentaSnapshot: { banco: 'B', titular: 'T', clabe: '012180001234567897' },
        referencia: String(7_700_000 + n).slice(0, 7),
        concepto: 'X',
      },
    });
    const v = await destrabar.obtener(p.id, gerenteA() as never);
    expect(v.acciones.find((a) => a.id === 'CANCELAR_SIN_PAGO')!.bloqueadaPor).toMatch(/Tesorería/);
    expect(v.acciones.find((a) => a.id === 'MARCAR_PAGADO')!.bloqueadaPor).toMatch(/Tesorería/);
    await expect(
      destrabar.ejecutar(p.id, 'CANCELAR_SIN_PAGO', { motivo: 'prueba' }, gerenteA() as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } })).estado).toBe(
      EstadoPedido.PENDIENTE_PAGO,
    );
  });
});

describe('DestrabarService — marcar vencida y marcar pagado', () => {
  it('marcar vencida cierra la transferencia SIN comprobante y deja la bitácora; el pedido sigue por pagar', async () => {
    const p = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO);
    const pago = await prisma.pedidoPagoTransferencia.create({
      data: {
        pedidoId: p.id,
        estado: EstadoPagoTransferencia.PENDIENTE,
        montoEsperado: 100,
        cuentaSnapshot: { banco: 'B', titular: 'T', clabe: '012180001234567897' },
        referencia: String(7_800_000 + n).slice(0, 7),
        concepto: 'X',
      },
    });
    expect(
      (await destrabar.obtener(p.id, gerenteA() as never)).acciones.map((a) => a.id),
    ).toContain('MARCAR_VENCIDA');
    await destrabar.ejecutar(
      p.id,
      'MARCAR_VENCIDA',
      { motivo: 'El cliente ya no va a transferir' },
      gerenteA() as never,
    );
    expect(
      (await prisma.pedidoPagoTransferencia.findUniqueOrThrow({ where: { id: pago.id } })).estado,
    ).toBe('VENCIDO');
    expect((await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } })).estado).toBe(
      EstadoPedido.PENDIENTE_PAGO,
    );
    const i = await prisma.pedidoIntervencion.findFirstOrThrow({ where: { pedidoId: p.id } });
    expect(i).toMatchObject({
      tipo: 'MARCAR_VENCIDA',
      estadoAntes: 'PENDIENTE_PAGO',
      estadoDespues: 'PENDIENTE_PAGO',
    });
    expect(i.mensajeCliente).toBeNull();
  });

  it('marcar pagado: el pedido queda PAGADO y, si ya está en el ERP, abre la tarea "registrar el cobro" para caja', async () => {
    const p = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, {
      estado: 'PROCESADO',
      folio: '0000000789',
      erpId: 789,
    });
    const r = await destrabar.ejecutar(
      p.id,
      'MARCAR_PAGADO',
      { motivo: 'Pagó en efectivo, folio de ticket 55' },
      gerenteA() as never,
    );
    expect((await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } })).estado).toBe(
      EstadoPedido.PAGADO,
    );
    expect(r.tareas.map((t) => t.tipo)).toEqual(['REGISTRAR_COBRO_EN_ERP']);
    const i = await prisma.pedidoIntervencion.findFirstOrThrow({ where: { pedidoId: p.id } });
    expect(i).toMatchObject({
      tipo: 'MARCAR_PAGADO',
      motivo: 'Pagó en efectivo, folio de ticket 55',
    });
    // El motivo real queda en la bitácora, no en el historial que ve el cliente.
    expect(
      JSON.stringify(await prisma.historialPedido.findMany({ where: { pedidoId: p.id } })),
    ).not.toContain('efectivo');
  });
});

describe('TareasErpService — la lista que ve y cierra el cajero', () => {
  it('lista SOLO las de su tienda, la más vieja primero, con la bandera de atraso', async () => {
    const pa = await pedido(tiendaA, EstadoPedido.CANCELADO, {
      estado: 'PROCESADO',
      folio: 'A',
      erpId: 1,
    });
    const pb = await pedido(tiendaB, EstadoPedido.CANCELADO, {
      estado: 'PROCESADO',
      folio: 'B',
      erpId: 2,
    });
    const mk = (pedidoId: number, tiendaId: number, horas: number, folio: string) =>
      prisma.tareaSistemaComercial.create({
        data: {
          pedidoId,
          tiendaId,
          tipo: 'CANCELAR_EN_ERP',
          motivo: 'x',
          folio,
          createdAt: new Date(Date.now() - horas * 3_600_000),
        },
      });
    const ta = await mk(pa.id, tiendaA, 6, 'A');
    await mk(pb.id, tiendaB, 9, 'B');
    const l = await tareas.listar(tiendaA);
    const mias = l.data.filter((t) => [ta.id].includes(t.id));
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({
      atrasada: true,
      folio: 'A',
      titulo: 'Cancelar en el Sistema Comercial',
    });
    expect(l.data.every((t) => t.pedido.id !== pb.id)).toBe(true);
    expect(l.meta.atrasadas).toBeGreaterThanOrEqual(1);
  });

  it('el cajero la cierra ("ya lo hice"); la de otra tienda no (403); dos a la vez: uno gana y el otro recibe 409', async () => {
    const p = await pedido(tiendaA, EstadoPedido.CANCELADO, {
      estado: 'PROCESADO',
      folio: 'C',
      erpId: 3,
    });
    const t = await prisma.tareaSistemaComercial.create({
      data: { pedidoId: p.id, tiendaId: tiendaA, tipo: 'CANCELAR_EN_ERP', motivo: 'x' },
    });
    const otraTienda = {
      userId: cajeroAId,
      nombre: 'Cajero B',
      rol: RolUsuario.CAJERO,
      tiendaId: tiendaB,
    };
    await expect(
      tareas.resolver(t.id, 'MANUAL', undefined, otraTienda as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const r = await Promise.allSettled([
      tareas.resolver(t.id, 'MANUAL', undefined, cajeroA() as never),
      tareas.resolver(t.id, 'MANUAL', undefined, cajeroA() as never),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.tareaSistemaComercial.findUniqueOrThrow({ where: { id: t.id } }),
    ).toMatchObject({ estado: 'HECHA', resueltaVia: 'MANUAL' });
  });

  it('"no aplica" solo lo decide el gerente/admin y con nota; el cajero no', async () => {
    const p = await pedido(tiendaA, EstadoPedido.CANCELADO, {
      estado: 'PROCESADO',
      folio: 'D',
      erpId: 4,
    });
    const t = await prisma.tareaSistemaComercial.create({
      data: { pedidoId: p.id, tiendaId: tiendaA, tipo: 'CANCELAR_EN_ERP', motivo: 'x' },
    });
    await expect(
      tareas.resolver(t.id, 'DESCARTADA', 'no aplica', cajeroA() as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      tareas.resolver(t.id, 'DESCARTADA', undefined, gerenteA() as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await tareas.resolver(t.id, 'DESCARTADA', 'Ya estaba cancelado allá', gerenteA() as never);
    expect(
      await prisma.tareaSistemaComercial.findUniqueOrThrow({ where: { id: t.id } }),
    ).toMatchObject({ estado: 'DESCARTADA', notaResolucion: 'Ya estaba cancelado allá' });
  });
});

describe('DestrabarService — por qué canceló el cliente (opcional, solo para el personal)', () => {
  it('el gerente de la tienda ve el motivo; sin motivo es null; el de otra tienda no ve nada (403)', async () => {
    const p = await pedido(tiendaA, EstadoPedido.CANCELADO);
    // El cliente puede omitirlo (es opcional): no hay nada que mostrar.
    expect((await destrabar.obtener(p.id, gerenteA() as never)).cancelacionDelCliente).toBeNull();

    await prisma.pedidoCancelacionCliente.create({
      data: {
        pedidoId: p.id,
        tiendaId: tiendaA,
        usuarioId: clienteId,
        motivo: 'OTRO',
        detalle: 'Me voy de viaje',
        estadoAlCancelar: EstadoPedido.REVISADO,
      },
    });
    const v = await destrabar.obtener(p.id, gerenteA() as never);
    expect(v.cancelacionDelCliente).toMatchObject({
      motivo: 'OTRO',
      etiqueta: 'Otro motivo',
      detalle: 'Me voy de viaje',
      estadoAlCancelar: EstadoPedido.REVISADO,
    });

    // Es de la tienda: el gerente de otra no lo ve (ni el pedido).
    await expect(destrabar.obtener(p.id, gerenteB() as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('un motivo que ya no está en el catálogo se muestra con su código, no rompe la pantalla', async () => {
    const p = await pedido(tiendaA, EstadoPedido.CANCELADO);
    await prisma.pedidoCancelacionCliente.create({
      data: {
        pedidoId: p.id,
        tiendaId: tiendaA,
        motivo: 'MOTIVO_RETIRADO',
        estadoAlCancelar: EstadoPedido.SOLICITADO,
      },
    });
    const v = await destrabar.obtener(p.id, gerenteA() as never);
    expect(v.cancelacionDelCliente).toMatchObject({
      motivo: 'MOTIVO_RETIRADO',
      etiqueta: 'MOTIVO_RETIRADO',
    });
  });
});
