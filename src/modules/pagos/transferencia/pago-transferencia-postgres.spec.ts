import 'dotenv/config';
import { ConflictException, BadRequestException } from '@nestjs/common';
import {
  EstadoPagoTransferencia as E,
  EstadoPedido,
  ModoEntrega,
  PrismaClient,
  RolUsuario,
} from '@prisma/client';
import { PagoTransferenciaService } from './pago-transferencia.service';
import { TesoreriaService } from './tesoreria.service';
import { CuentasBancariasService } from '../cuentas/cuentas-bancarias.service';
import { PedidoAccessService } from '../../pedidos/core/pedido-access.service';
import { AdminService } from '../../pedidos/admin/admin.service';
import {
  resolverPagoAlCancelarse,
  pagoBloqueaCancelacion,
  ACTOR_AGENTE,
  emitirTransferenciaAlPasarAPago,
} from './hooks';
import { PedidoStateService } from '../../pedidos/core/pedido-state.service';

/**
 * Pagos por transferencia contra PostgreSQL REAL: los escenarios del plan (§9) que dependen de lo
 * que hacen los índices parciales, las escrituras condicionales y las transacciones. Un mock de
 * Prisma no puede decir si "dos tesoreros a la vez" o "dos emisiones a la vez" quedan bien.
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
const correos: Array<{ tipo: string }> = [];
const notifications = {
  enviarTransferencia: jest.fn(async (_p: unknown, tipo: string) => void correos.push({ tipo })),
  enviar: jest.fn().mockResolvedValue(undefined),
};
const config = {
  get: (k: string) =>
    ({
      'app.pagos.zonaHoraria': 'America/Mexico_City',
      'app.mail.frontendUrl': 'https://tienda.test',
      'app.pagos.transferenciaVenceHoras': 48,
      'app.pagos.comprobantes.maxBytes': 8 * 1024 * 1024,
      'app.pagos.alertaSinRegistrarHoras': 4,
    })[k],
};
// PNG mínimo válido por firma.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 7),
]);
const guardados: string[] = [];
const storage = {
  guardar: jest.fn(async (_b: Buffer, _m: string, pagoId: number) => {
    const k = `comprobantes/${pagoId}/${guardados.length}.png`;
    guardados.push(k);
    return k;
  }),
  eliminar: jest.fn(),
  leer: jest.fn(),
};

let tiendaId: number;
let clienteId: number;
let otroClienteId: number;
let tesoreroId: number;
let cajeroId: number;
let cuentaId: number;
const pedidoIds: number[] = [];
let n = 0;

const cliente = () => ({ userId: clienteId, nombre: 'Cliente', rol: RolUsuario.CLIENTE });
const tesorero = () => ({ userId: tesoreroId, nombre: 'Tesorera', rol: RolUsuario.TESORERIA });
const mostrador = () => ({
  userId: tesoreroId,
  nombre: 'Mostrador',
  rol: RolUsuario.MOSTRADOR,
  tiendaId,
});
const cajero = (tid?: number) => ({
  userId: cajeroId,
  nombre: 'Cajera Test',
  rol: RolUsuario.CAJERO,
  tiendaId: tid ?? tiendaId,
});

function servicios() {
  const cuentas = new CuentasBancariasService(prisma as never);
  const pagos = new PagoTransferenciaService(
    prisma as never,
    realtime as never,
    notifications as never,
    config as never,
    new PedidoAccessService(prisma as never),
    cuentas,
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
  const admin = new AdminService(
    prisma as never,
    notifications as never,
    realtime as never,
    new PedidoAccessService(prisma as never),
    {} as never,
  );
  return { pagos, tes, admin };
}

/** Tiendas y cuentas extra que crean algunas pruebas para aislarse de lo que dejan las demás. */
const tiendasExtra: number[] = [];
const cuentasExtra: number[] = [];

async function crearTiendaAislada() {
  const t = await prisma.tienda.create({
    data: { nombre: `Pago X ${suffix}-${++n}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  tiendasExtra.push(t.id);
  const c = await prisma.cuentaBancaria.create({
    data: { tiendaId: t.id, banco: 'BBVA', titular: 'TEST SA', clabe: '012180001234567899' },
  });
  cuentasExtra.push(c.id);
  return t.id;
}

async function crearPedido(
  opts: { estado?: EstadoPedido; modo?: ModoEntrega; total?: number; tienda?: number } = {},
) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-T${suffix}-${++n}`,
      usuarioId: clienteId,
      tiendaId: opts.tienda ?? tiendaId,
      estado: opts.estado ?? EstadoPedido.PENDIENTE_PAGO,
      modoEntrega: opts.modo ?? ModoEntrega.RECOGER_TIENDA,
      clienteNombre: 'Cliente Test',
      clienteEmail: `t-${suffix}@test.local`,
      subtotal: opts.total ?? 1500,
      total: opts.total ?? 1500,
      pendienteEnvio: { create: { estado: 'PROCESADO', externalFolio: `F${n}` } },
    },
  });
  pedidoIds.push(p.id);
  return p;
}

const aprobarDto = (monto = 1500, extra: object = {}) => ({
  montoRecibido: monto,
  abonoFecha: new Date().toISOString(),
  confirmoEnBanco: true,
  ...extra,
});

beforeAll(async () => {
  await prisma.$connect();
  tiendaId = (
    await prisma.tienda.create({
      data: { nombre: `Pago T ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
    })
  ).id;
  const mk = async (rol: RolUsuario, tid?: number) =>
    (
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
  clienteId = await mk(RolUsuario.CLIENTE);
  otroClienteId = (
    await prisma.usuario.create({
      data: {
        email: `otro-${suffix}@test.local`,
        password: 'x',
        nombre: 'Otro',
        rol: RolUsuario.CLIENTE,
      },
    })
  ).id;
  tesoreroId = await mk(RolUsuario.TESORERIA);
  cajeroId = await mk(RolUsuario.CAJERO, tiendaId);
  // La cuenta global activa de la BD de desarrollo se respeta: se crea una de la TIENDA de prueba.
  cuentaId = (
    await prisma.cuentaBancaria.create({
      data: { tiendaId, banco: 'BBVA', titular: 'TEST SA', clabe: '012180001234567899' },
    })
  ).id;
});

afterAll(async () => {
  await prisma.pagoTransferenciaEvento.deleteMany({
    where: { pago: { pedidoId: { in: pedidoIds } } },
  });
  await prisma.pagoComprobante.deleteMany({ where: { pago: { pedidoId: { in: pedidoIds } } } });
  await prisma.pedidoPagoTransferencia.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.cuentaBancaria.deleteMany({ where: { id: { in: [cuentaId, ...cuentasExtra] } } });
  await prisma.usuario.deleteMany({
    where: { id: { in: [clienteId, otroClienteId, tesoreroId, cajeroId] } },
  });
  await prisma.tienda.deleteMany({ where: { id: { in: [tiendaId, ...tiendasExtra] } } });
  await prisma.$disconnect();
});

beforeEach(() => {
  jest.clearAllMocks();
  correos.length = 0;
});

/** Los correos salen sin esperarse (a propósito): el test espera a que aparezca. */
async function esperarCorreo(tipo: string) {
  for (let i = 0; i < 40; i++) {
    if (correos.some((c) => c.tipo === tipo)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `No salió el correo ${tipo}. Salieron: ${correos.map((c) => c.tipo).join(', ') || 'ninguno'}`,
  );
}

const ver = async (pedidoId: number) =>
  (await prisma.pedidoPagoTransferencia.findFirst({
    where: { pedidoId },
    orderBy: { id: 'desc' },
  }))!;

describe('Emitir instrucciones', () => {
  it('crea UN pago con snapshot de la cuenta, referencia de 7 dígitos y manda el correo', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    const r = await pagos.emitirInstrucciones(p.id, cliente());
    expect(r.pago?.estado).toBe(E.PENDIENTE);
    expect(r.pago?.referencia).toMatch(/^\d{7}$/);
    expect(r.pago?.instrucciones?.texto).toContain('012180001234567899');
    expect(r.pago?.instrucciones?.texto).toContain('$1,500.00');
    await esperarCorreo('TRANSFERENCIA_INSTRUCCIONES');
    const fila = await ver(p.id);
    expect((fila.cuentaSnapshot as { clabe: string }).clabe).toBe('012180001234567899');
    expect(await prisma.pagoTransferenciaEvento.count({ where: { pagoId: fila.id } })).toBe(1);
  });

  it('dos emisiones simultáneas dan el MISMO pago (índice parcial)', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    const [a, b] = await Promise.all([
      pagos.emitirInstrucciones(p.id, cliente()),
      pagos.emitirInstrucciones(p.id, mostrador()),
    ]);
    expect(a.pago?.id).toBe(b.pago?.id);
    expect(await prisma.pedidoPagoTransferencia.count({ where: { pedidoId: p.id } })).toBe(1);
  });

  it('el snapshot no cambia si después editan la cuenta', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    await pagos.emitirInstrucciones(p.id, cliente());
    await prisma.cuentaBancaria.update({ where: { id: cuentaId }, data: { banco: 'OTRO BANCO' } });
    const r = await pagos.obtenerParaCliente(p.id, cliente());
    expect(r.pago?.instrucciones?.lineas.find((l) => l.etiqueta === 'Banco')?.valor).toBe('BBVA');
    await prisma.cuentaBancaria.update({ where: { id: cuentaId }, data: { banco: 'BBVA' } });
  });

  it('los pedidos a DOMICILIO quedan fuera (400) y no se crea nada', async () => {
    const { pagos } = servicios();
    const p = await crearPedido({ modo: ModoEntrega.DOMICILIO });
    await expect(pagos.emitirInstrucciones(p.id, cliente())).rejects.toThrow(/domicilio/i);
    expect(await prisma.pedidoPagoTransferencia.count({ where: { pedidoId: p.id } })).toBe(0);
  });

  it('solo con el pedido PENDIENTE_PAGO (antes el total puede cambiar)', async () => {
    const { pagos } = servicios();
    const p = await crearPedido({ estado: EstadoPedido.REVISADO });
    await expect(pagos.emitirInstrucciones(p.id, cliente())).rejects.toThrow(BadRequestException);
  });

  it('el pedido de OTRO cliente es 404, no 403', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    await expect(
      pagos.obtenerParaCliente(p.id, {
        userId: otroClienteId,
        nombre: 'Otro',
        rol: RolUsuario.CLIENTE,
      }),
    ).rejects.toThrow(/no encontrado/i);
  });
});

describe('Cambiar de método (escenarios 1-3)', () => {
  it('1: sin comprobante, puede pagar en tienda', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    await pagos.emitirInstrucciones(p.id, cliente());
    await pagos.cambiarATienda(p.id, cliente());
    expect((await ver(p.id)).estado).toBe(E.CANCELADO);
    // y puede volver a pedir transferencia: el índice solo cuenta pagos vivos
    const otra = await pagos.emitirInstrucciones(p.id, cliente());
    expect(otra.pago?.estado).toBe(E.PENDIENTE);
  });

  it('2: con comprobante enviado NO puede (puede haber dinero en camino)', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    await pagos.emitirInstrucciones(p.id, cliente());
    await pagos.subirComprobante(p.id, cliente(), { buffer: PNG } as never, {});
    expect((await ver(p.id)).estado).toBe(E.EN_REVISION);
    await expect(pagos.cambiarATienda(p.id, cliente())).rejects.toThrow(ConflictException);
  });

  it('4: tras pagar en tienda (o vencer) se pueden pedir los datos DE NUEVO; con un pago vivo no', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();

    // Sin pago: cliente y mostrador pueden pedir los datos, y no hay transferencia en curso.
    expect((await pagos.obtenerParaCliente(p.id, cliente())).puedePedirDatos).toBe(true);
    expect((await pagos.obtenerParaCliente(p.id, cliente())).transferenciaEnCurso).toBe(false);
    expect((await pagos.resumenParaTienda(p.id, mostrador())).puedeEnviarDatos).toBe(true);

    // Con un pago vivo, pedirlos devolvería el mismo: no se ofrece.
    await pagos.emitirInstrucciones(p.id, cliente());
    expect((await pagos.obtenerParaCliente(p.id, cliente())).puedePedirDatos).toBe(false);
    expect((await pagos.obtenerParaCliente(p.id, cliente())).transferenciaEnCurso).toBe(true);
    const enCurso = await pagos.resumenParaTienda(p.id, mostrador());
    expect(enCurso.puedeEnviarDatos).toBe(false);
    // Sin comprobante todavía, caja puede pasar al cliente a pagar en tienda (el botón no da 409).
    expect(enCurso.pago?.puedeCambiarATienda).toBe(true);

    // El cliente cambia a pagar en tienda (pago CANCELADO) y luego se arrepiente. Antes el
    // mostrador no podía dar los datos (`!pago?.estado`) aunque `emitirInstrucciones` sí crea otro.
    await pagos.cambiarATienda(p.id, cliente());
    expect((await pagos.obtenerParaCliente(p.id, cliente())).transferenciaEnCurso).toBe(false);
    expect((await pagos.obtenerParaCliente(p.id, cliente())).puedePedirDatos).toBe(true);
    expect((await pagos.resumenParaTienda(p.id, mostrador())).puedeEnviarDatos).toBe(true);
    const nuevo = await pagos.emitirInstrucciones(p.id, mostrador());
    expect(nuevo.pago?.estado).toBe(E.PENDIENTE);
  });

  it('sin cuenta bancaria activa NO se ofrece la transferencia (antes: botón que daba 409)', async () => {
    // Un servicio de cuentas que dice "no hay": la BD de desarrollo puede tener una cuenta global
    // activa y el test no debe depender de eso.
    const sinCuentas = new PagoTransferenciaService(
      prisma as never,
      realtime as never,
      notifications as never,
      config as never,
      new PedidoAccessService(prisma as never),
      { hayCuentaVigente: async () => false } as never,
      storage as never,
    );
    const p = await crearPedido();
    const c = await sinCuentas.obtenerParaCliente(p.id, cliente());
    expect(c.puedePedirDatos).toBe(false);
    expect(c.motivoNoDisponible).toMatch(/no está configurado/);
    const t = await sinCuentas.resumenParaTienda(p.id, mostrador());
    expect(t.puedeEnviarDatos).toBe(false);
    expect(t.motivoNoDisponible).toMatch(/no está configurado/);
  });

  it('3: ya verificada, la transferencia ES el pago: no puede cambiar', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero());
    await expect(pagos.cambiarATienda(p.id, cliente())).rejects.toThrow(/verificada/i);
  });

  it('caja ve "NO COBRAR" mientras está abierta y "REGISTRAR EN VFP" ya verificada', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    expect((await pagos.resumenParaTienda(p.id, mostrador())).pago?.caja.accion).toBe('NO_COBRAR');
    await tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero());
    const r = await pagos.resumenParaTienda(p.id, mostrador());
    expect(r.pago?.caja.accion).toBe('REGISTRAR_EN_VFP');
    expect(r.pago?.folioVfp).toMatch(/^F/);
  });
});

describe('Tesorería: verificar (escenarios 17, y reglas de dinero)', () => {
  it('el monto debe ser EXACTO', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await expect(tes.aprobar(e.pago!.id, aprobarDto(1499.99) as never, tesorero())).rejects.toThrow(
      /no coincide/,
    );
    expect((await ver(p.id)).estado).toBe(E.PENDIENTE);
  });

  it('aprobar verifica SIN cambiar el estado del pedido (PAGADO es de VFP)', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await tes.aprobar(
      e.pago!.id,
      aprobarDto(1500, { claveRastreo: 'mban 0100 ' + suffix }) as never,
      tesorero(),
    );
    const fila = await ver(p.id);
    expect(fila.estado).toBe(E.VERIFICADO);
    expect(fila.claveRastreo).toBe('MBAN0100' + suffix);
    expect((await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } })).estado).toBe(
      EstadoPedido.PENDIENTE_PAGO,
    );
    await esperarCorreo('TRANSFERENCIA_VERIFICADA');
  });

  it('el detalle dice qué acciones caben: la pantalla no repite el mapa estado→acción', async () => {
    const { pagos, tes } = servicios();
    const ninguna = {
      puedeAprobar: false,
      aprobarRequiereNota: false,
      puedeVencer: false,
      puedeRechazar: false,
      puedeRegistrarAbonoSinPedido: false,
      puedeReembolsar: false,
      puedeResolverRevision: false,
      puedeReenviar: false,
    };
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    const id = e.pago!.id;

    // Instrucciones abiertas: Tesorería puede verificar el abono si lo ve en el banco, pero no hay
    // comprobante que rechazar.
    expect((await tes.detalle(id)).acciones).toEqual({
      ...ninguna,
      puedeAprobar: true,
      puedeReenviar: true,
    });

    // Con algo por aclarar se bloquea aprobar y aparece "resolver" (mismo candado que `aprobar`).
    await prisma.pedidoPagoTransferencia.update({
      where: { id },
      data: { requiereRevision: 'ALERTA_TOTAL de prueba' },
    });
    expect((await tes.detalle(id)).acciones).toEqual({
      ...ninguna,
      puedeResolverRevision: true,
      puedeReenviar: true,
    });

    // Ya verificada: no hay nada más que verificar ni que reenviar.
    await tes.resolverRevision(id, { nota: 'Se confirmó con la tienda' }, tesorero());
    await tes.aprobar(id, aprobarDto() as never, tesorero());
    expect((await tes.detalle(id)).acciones).toEqual(ninguna);

    // Si el pedido deja de ser pagable (la tienda lo cobró / se canceló) y el abono llega después,
    // el camino es "abono sin pedido", no aprobar.
    const otro = await crearPedido();
    const eo = await pagos.emitirInstrucciones(otro.id, cliente());
    await prisma.pedido.update({ where: { id: otro.id }, data: { estado: EstadoPedido.PAGADO } });
    expect((await tes.detalle(eo.pago!.id)).acciones).toMatchObject({
      puedeAprobar: false,
      puedeRegistrarAbonoSinPedido: true,
    });
  });

  it('17: dos tesoreros a la vez → uno aprueba, el otro 409', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    const r = await Promise.allSettled([
      tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero()),
      tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero()),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    expect(
      await prisma.pagoTransferenciaEvento.count({
        where: { pagoId: e.pago!.id, tipo: 'VERIFICADO' },
      }),
    ).toBe(1);
  });

  it('un mismo SPEI (clave de rastreo) no puede pagar DOS pedidos', async () => {
    const { pagos, tes } = servicios();
    const a = await crearPedido();
    const b = await crearPedido();
    const ea = await pagos.emitirInstrucciones(a.id, cliente());
    const eb = await pagos.emitirInstrucciones(b.id, cliente());
    await tes.aprobar(
      ea.pago!.id,
      aprobarDto(1500, { claveRastreo: 'REPETIDA' + suffix }) as never,
      tesorero(),
    );
    await expect(
      tes.aprobar(
        eb.pago!.id,
        aprobarDto(1500, { claveRastreo: 'REPETIDA' + suffix }) as never,
        tesorero(),
      ),
    ).rejects.toThrow(/ya pagó el pedido/);
    expect((await ver(b.id)).estado).toBe(E.PENDIENTE);
  });

  it('un pago con algo por aclarar (total cambió en VFP) NO se aprueba hasta resolverlo', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await prisma.pedidoPagoTransferencia.update({
      where: { id: e.pago!.id },
      data: { requiereRevision: 'ALERTA_TOTAL de prueba' },
    });
    await expect(tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero())).rejects.toThrow(
      /aclarar/,
    );
    await tes.resolverRevision(e.pago!.id, { nota: 'Se confirmó con la tienda' }, tesorero());
    await expect(tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero())).resolves.toBeDefined();
  });
});

describe('Rechazar y reintentar', () => {
  it('rechazar devuelve el pago a PENDIENTE y el cliente puede subir otro; avisa por correo', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await pagos.subirComprobante(p.id, cliente(), { buffer: PNG } as never, {});
    await tes.rechazar(e.pago!.id, { motivo: 'ILEGIBLE' } as never, tesorero());
    const fila = await ver(p.id);
    expect(fila.estado).toBe(E.PENDIENTE);
    expect(fila.intentos).toBe(1);
    await esperarCorreo('TRANSFERENCIA_RECHAZADA');
    const otro = Buffer.concat([PNG, Buffer.from('otro')]);
    await expect(
      pagos.subirComprobante(p.id, cliente(), { buffer: otro } as never, {}),
    ).resolves.toBeDefined();
  });

  it('subir el mismo archivo dos veces es idempotente', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await pagos.subirComprobante(p.id, cliente(), { buffer: PNG } as never, {});
    await pagos.subirComprobante(p.id, cliente(), { buffer: PNG } as never, {});
    expect(await prisma.pagoComprobante.count({ where: { pagoId: e.pago!.id } })).toBe(1);
  });

  it('un archivo que no es imagen/PDF se rechaza sin guardar nada', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    await pagos.emitirInstrucciones(p.id, cliente());
    await expect(
      pagos.subirComprobante(
        p.id,
        cliente(),
        { buffer: Buffer.from('<html><script>x</script></html>') } as never,
        {},
      ),
    ).rejects.toThrow(/imagen/);
    expect(storage.guardar).not.toHaveBeenCalled();
  });
});

describe('Enganches con el pedido (D7 / D8): el dinero no se ignora', () => {
  it('pedido cancelado con pago PENDIENTE → pago CANCELADO', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    await pagos.emitirInstrucciones(p.id, cliente());
    await prisma.$transaction((tx) => resolverPagoAlCancelarse(tx, p.id, ACTOR_AGENTE));
    expect((await ver(p.id)).estado).toBe(E.CANCELADO);
  });

  it('pedido cancelado con transferencia VERIFICADA → REEMBOLSO_PENDIENTE por el monto', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero());
    await prisma.$transaction((tx) => resolverPagoAlCancelarse(tx, p.id, ACTOR_AGENTE));
    const fila = await ver(p.id);
    expect(fila.estado).toBe(E.REEMBOLSO_PENDIENTE);
    expect(fila.reembolsoMonto?.toString()).toBe('1500');
    await tes.registrarReembolso(fila.id, { referencia: 'SPEI-DEV-001' }, tesorero());
    expect((await ver(p.id)).estado).toBe(E.REEMBOLSADO);
    await esperarCorreo('TRANSFERENCIA_REEMBOLSADA');
  });

  it('pedido cancelado con comprobante EN REVISIÓN → se queda marcado para Tesorería (no se descarta)', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    await pagos.emitirInstrucciones(p.id, cliente());
    await pagos.subirComprobante(p.id, cliente(), { buffer: PNG } as never, {});
    await prisma.$transaction((tx) => resolverPagoAlCancelarse(tx, p.id, ACTOR_AGENTE));
    const fila = await ver(p.id);
    expect(fila.estado).toBe(E.EN_REVISION);
    expect(fila.requiereRevision).toMatch(/CANCEL/i);
  });

  it('VFP cobra un pedido con transferencia VERIFICADA → APLICADO (el caso feliz)', async () => {
    const { pagos, tes, admin } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero());
    await admin.marcarComoPagado(p.id, undefined, {
      userId: 0,
      nombre: 'AGENT',
      rol: 'AGENT' as never,
    });
    const fila = await ver(p.id);
    expect(fila.estado).toBe(E.APLICADO);
    expect(fila.aplicadoAt).not.toBeNull();
    expect((await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } })).estado).toBe(
      EstadoPedido.PAGADO,
    );
  });

  it('VFP cobra (pagó en tienda) con transferencia PENDIENTE → se cancela; con comprobante en revisión → se marca', async () => {
    const { pagos, admin } = servicios();
    const a = await crearPedido();
    await pagos.emitirInstrucciones(a.id, cliente());
    await admin.marcarComoPagado(a.id, undefined, {
      userId: 0,
      nombre: 'AGENT',
      rol: 'AGENT' as never,
    });
    expect((await ver(a.id)).estado).toBe(E.CANCELADO);

    const b = await crearPedido();
    await pagos.emitirInstrucciones(b.id, cliente());
    await pagos.subirComprobante(b.id, cliente(), { buffer: PNG } as never, {});
    await admin.marcarComoPagado(b.id, undefined, {
      userId: 0,
      nombre: 'AGENT',
      rol: 'AGENT' as never,
    });
    const fila = await ver(b.id);
    expect(fila.estado).toBe(E.EN_REVISION);
    expect(fila.requiereRevision).toMatch(/COBR/i);
  });

  it('abono sin pedido: el dinero que llega a un pedido ya cobrado queda como reembolso', async () => {
    const { pagos, tes, admin } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await pagos.subirComprobante(p.id, cliente(), { buffer: PNG } as never, {});
    await admin.marcarComoPagado(p.id, undefined, {
      userId: 0,
      nombre: 'AGENT',
      rol: 'AGENT' as never,
    });
    // aprobar ya no aplica (el pedido está PAGADO)…
    await expect(tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero())).rejects.toThrow(
      /abono sin pedido/,
    );
    // …pero el dinero SÍ llegó: doble pago → a reembolso.
    await tes.abonoSinPedido(
      e.pago!.id,
      { ...aprobarDto(), nota: 'Pagó en caja y además transfirió' } as never,
      tesorero(),
    );
    expect((await ver(p.id)).estado).toBe(E.REEMBOLSO_PENDIENTE);
  });

  it('el ADMIN no cobra a mano un pedido con transferencia abierta sin forzar y explicar', async () => {
    const { pagos, admin } = servicios();
    const p = await crearPedido();
    await pagos.emitirInstrucciones(p.id, cliente());
    const adminUser = { userId: 987_001, nombre: 'Admin', rol: RolUsuario.ADMIN };
    await expect(admin.marcarComoPagado(p.id, undefined, adminUser)).rejects.toThrow(
      /transferencia en curso/,
    );
    await expect(admin.marcarComoPagado(p.id, { forzar: true }, adminUser)).rejects.toThrow(
      /transferencia en curso/,
    );
    await expect(
      admin.marcarComoPagado(
        p.id,
        { forzar: true, referencia: 'Cliente pagó en efectivo' },
        adminUser,
      ),
    ).resolves.toBeDefined();
  });
});

describe('Por la máquina de estados REAL', () => {
  it('cancelar el pedido con cambiarEstado resuelve el pago en la misma transacción y avisa a Tesorería', async () => {
    const { pagos, tes } = servicios();
    const estado = new PedidoStateService(
      prisma as never,
      notifications as never,
      realtime as never,
      new PedidoAccessService(prisma as never),
      {} as never,
    );
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero());
    jest.clearAllMocks();

    await estado.cambiarEstado(
      p.id,
      { nuevoEstado: EstadoPedido.CANCELADO, observacion: 'prueba' },
      { userId: 987_002, nombre: 'Admin', rol: RolUsuario.ADMIN },
      { asignacion: 'limpiar' },
    );

    expect((await ver(p.id)).estado).toBe(E.REEMBOLSO_PENDIENTE);
    expect(realtime.emitToTesoreria).toHaveBeenCalledWith(
      'pago.estado',
      expect.objectContaining({ estado: E.REEMBOLSO_PENDIENTE }),
    );
    expect(realtime.emitToTesoreria).toHaveBeenCalledWith('pago.alerta', expect.anything());
  });

  it('un pedido sin pago por transferencia se cancela exactamente igual que antes', async () => {
    const estado = new PedidoStateService(
      prisma as never,
      notifications as never,
      realtime as never,
      new PedidoAccessService(prisma as never),
      {} as never,
    );
    const p = await crearPedido();
    await estado.cambiarEstado(
      p.id,
      { nuevoEstado: EstadoPedido.CANCELADO },
      { userId: 987_002, nombre: 'Admin', rol: RolUsuario.ADMIN },
      { asignacion: 'limpiar' },
    );
    expect((await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } })).estado).toBe(
      EstadoPedido.CANCELADO,
    );
    expect(realtime.emitToTesoreria).not.toHaveBeenCalled();
  });
});

describe('Bloqueo de la cancelación del cliente', () => {
  it('bloquea con comprobante en revisión o dinero verificado; no con instrucciones sin comprobante', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    expect(await pagoBloqueaCancelacion(prisma, p.id)).toBeNull();
    await pagos.subirComprobante(p.id, cliente(), { buffer: PNG } as never, {});
    expect((await pagoBloqueaCancelacion(prisma, p.id))?.estado).toBe(E.EN_REVISION);
    await tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero());
    expect((await pagoBloqueaCancelacion(prisma, p.id))?.estado).toBe(E.VERIFICADO);
  });
});

// ====================================================================
// Fase 2: vencimiento MANUAL, abono tardío, atraso y conciliación
// ====================================================================

/** Hace que las instrucciones de un pago ya hayan pasado su vigencia. */
const vencerReloj = (pagoId: number, horasAtras = 1) =>
  prisma.pedidoPagoTransferencia.update({
    where: { id: pagoId },
    data: { venceAt: new Date(Date.now() - horasAtras * 3_600_000) },
  });

describe('Vencimiento manual', () => {
  it('unas instrucciones VIGENTES no se pueden cerrar (409) y no se tocan', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await expect(tes.vencer(e.pago!.id, tesorero())).rejects.toThrow(/vigentes/);
    expect((await ver(p.id)).estado).toBe(E.PENDIENTE);
    expect((await tes.detalle(e.pago!.id)).acciones.puedeVencer).toBe(false);
  });

  it('vencidas y sin comprobante: se cierran, quedan en bitácora y caja ya puede cobrar', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await vencerReloj(e.pago!.id);

    // Mientras no se cierre, caja sigue con el bloqueo, y el texto le dice qué hacer.
    const antes = await pagos.resumenParaTienda(p.id, mostrador());
    expect(antes.pago?.caja.accion).toBe('NO_COBRAR');
    expect(antes.pago?.caja.mensaje).toMatch(/venció.*Tesorería.*cierre/i);
    expect((await tes.detalle(e.pago!.id)).acciones.puedeVencer).toBe(true);

    const d = await tes.vencer(e.pago!.id, tesorero());
    expect(d.estado).toBe(E.VENCIDO);
    expect(
      await prisma.pagoTransferenciaEvento.count({
        where: { pagoId: e.pago!.id, tipo: 'VENCIDO' },
      }),
    ).toBe(1);
    expect(realtime.emitToTesoreria).toHaveBeenCalledWith(
      'pago.estado',
      expect.objectContaining({ estado: E.VENCIDO }),
    );

    // Ya no hay pago vivo: caja cobra y el cliente (o el mostrador) puede pedir datos nuevos.
    const despues = await pagos.resumenParaTienda(p.id, mostrador());
    expect(despues.pago?.caja.accion).toBeNull();
    expect(despues.puedeEnviarDatos).toBe(true);
    expect((await pagos.obtenerParaCliente(p.id, cliente())).puedePedirDatos).toBe(true);
    expect((await pagos.obtenerParaCliente(p.id, cliente())).transferenciaEnCurso).toBe(false);
  });

  it('con un comprobante en revisión NO se cierra aunque haya vencido: puede haber dinero en camino', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await pagos.subirComprobante(p.id, cliente(), { buffer: PNG } as never, {});
    await vencerReloj(e.pago!.id);
    await expect(tes.vencer(e.pago!.id, tesorero())).rejects.toThrow(/dinero en camino/);
    expect((await ver(p.id)).estado).toBe(E.EN_REVISION);
    expect((await tes.detalle(e.pago!.id)).acciones.puedeVencer).toBe(false);
  });

  it('cerrar dos veces seguidas: la segunda es 409, no escribe otra bitácora', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await vencerReloj(e.pago!.id);
    await tes.vencer(e.pago!.id, tesorero());
    await expect(tes.vencer(e.pago!.id, tesorero())).rejects.toBeInstanceOf(ConflictException);
    expect(
      await prisma.pagoTransferenciaEvento.count({
        where: { pagoId: e.pago!.id, tipo: 'VENCIDO' },
      }),
    ).toBe(1);
  });

  it('dos tesoreros cerrando a la vez: uno cierra y el otro recibe 409', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await vencerReloj(e.pago!.id);
    const r = await Promise.allSettled([
      tes.vencer(e.pago!.id, tesorero()),
      tes.vencer(e.pago!.id, tesorero()),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.pagoTransferenciaEvento.count({
        where: { pagoId: e.pago!.id, tipo: 'VENCIDO' },
      }),
    ).toBe(1);
  });

  it('"Esperando" y "Vencidas" se reparten las instrucciones abiertas por su vigencia', async () => {
    const { pagos, tes } = servicios();
    const vigente = await crearPedido();
    const vencida = await crearPedido();
    const ev = await pagos.emitirInstrucciones(vigente.id, cliente());
    const ex = await pagos.emitirInstrucciones(vencida.id, cliente());
    await vencerReloj(ex.pago!.id);

    const ids = async (grupo: 'esperando' | 'vencidas') =>
      (await tes.listar({ grupo, tiendaId, limite: 100 } as never)).data.map((f) => f.id);
    expect(await ids('esperando')).toContain(ev.pago!.id);
    expect(await ids('esperando')).not.toContain(ex.pago!.id);
    expect(await ids('vencidas')).toContain(ex.pago!.id);
    expect(await ids('vencidas')).not.toContain(ev.pago!.id);
    const resumen = await tes.resumen();
    expect(resumen.vencidas).toBeGreaterThanOrEqual(1);
  });

  it('"cerrar vencidas" cierra las que aplican, omite las que cambiaron y es idempotente', async () => {
    const { pagos, tes } = servicios();
    const a = await crearPedido();
    const b = await crearPedido();
    const c = await crearPedido();
    const ea = await pagos.emitirInstrucciones(a.id, cliente());
    const eb = await pagos.emitirInstrucciones(b.id, cliente());
    const ec = await pagos.emitirInstrucciones(c.id, cliente());
    await Promise.all([ea, eb, ec].map((e) => vencerReloj(e.pago!.id)));
    // c recibe un comprobante entre que se vence y se cierra: ya no es candidata.
    await pagos.subirComprobante(c.id, cliente(), { buffer: PNG } as never, {});

    const r1 = await tes.cerrarVencidas(tesorero());
    expect(r1.cerradas).toBeGreaterThanOrEqual(2);
    expect((await ver(a.id)).estado).toBe(E.VENCIDO);
    expect((await ver(b.id)).estado).toBe(E.VENCIDO);
    expect((await ver(c.id)).estado).toBe(E.EN_REVISION);
    // Una segunda pasada no encuentra nada de esas tres.
    await tes.cerrarVencidas(tesorero());
    expect(
      await prisma.pagoTransferenciaEvento.count({
        where: { pagoId: { in: [ea.pago!.id, eb.pago!.id] }, tipo: 'VENCIDO' },
      }),
    ).toBe(2);
  });
});

describe('Abono tardío (pago VENCIDO)', () => {
  it('se puede verificar, pero exige explicar qué pasó; queda marcado como tardío', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await vencerReloj(e.pago!.id);
    await tes.vencer(e.pago!.id, tesorero());

    const d = await tes.detalle(e.pago!.id);
    expect(d.acciones).toMatchObject({
      puedeAprobar: true,
      aprobarRequiereNota: true,
      puedeVencer: false,
    });
    expect(d.advertencias.join(' ')).toMatch(/vencieron/);

    await expect(tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero())).rejects.toThrow(
      /abono tardío/,
    );
    expect((await ver(p.id)).estado).toBe(E.VENCIDO);

    await tes.aprobar(
      e.pago!.id,
      aprobarDto(1500, { nota: 'Transfirió al día siguiente, lo vimos en el banco' }) as never,
      tesorero(),
    );
    expect((await ver(p.id)).estado).toBe(E.VERIFICADO);
    const ev = await prisma.pagoTransferenciaEvento.findFirstOrThrow({
      where: { pagoId: e.pago!.id, tipo: 'VERIFICADO' },
    });
    expect(ev.detalle).toMatchObject({ tardio: true });
  });

  it('si el cliente ya pidió otras instrucciones, el abono se resuelve en ESE pago (no hay dos vivos)', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const viejo = await pagos.emitirInstrucciones(p.id, cliente());
    await vencerReloj(viejo.pago!.id);
    await tes.vencer(viejo.pago!.id, tesorero());
    const nuevo = await pagos.emitirInstrucciones(p.id, cliente());
    expect(nuevo.pago!.id).not.toBe(viejo.pago!.id);

    const d = await tes.detalle(viejo.pago!.id);
    expect(d.acciones.puedeAprobar).toBe(false);
    expect(d.advertencias.join(' ')).toMatch(new RegExp(`pago ${nuevo.pago!.id}`));
    await expect(
      tes.aprobar(
        viejo.pago!.id,
        aprobarDto(1500, { nota: 'abono tardío de prueba' }) as never,
        tesorero(),
      ),
    ).rejects.toThrow(/ya pidió otras instrucciones/);
    expect((await ver(p.id)).id).toBe(nuevo.pago!.id);
  });
});

describe('Verificadas atrasadas (sin proceso: se calcula al leer)', () => {
  it('una verificada que lleva más de las horas configuradas sin registrarse sale marcada y contada', async () => {
    const { pagos, tes } = servicios();
    const reciente = await crearPedido();
    const vieja = await crearPedido();
    const er = await pagos.emitirInstrucciones(reciente.id, cliente());
    const ev = await pagos.emitirInstrucciones(vieja.id, cliente());
    await tes.aprobar(er.pago!.id, aprobarDto() as never, tesorero());
    await tes.aprobar(ev.pago!.id, aprobarDto() as never, tesorero());
    await prisma.pedidoPagoTransferencia.update({
      where: { id: ev.pago!.id },
      data: { verificadoAt: new Date(Date.now() - 5 * 3_600_000) },
    });

    const lista = await tes.listar({ grupo: 'verificados', tiendaId, limite: 100 } as never);
    const porId = new Map(lista.data.map((f) => [f.id, f]));
    expect(porId.get(er.pago!.id)?.atrasado).toBe(false);
    expect(porId.get(ev.pago!.id)?.atrasado).toBe(true);
    // Lo que más tiempo lleva esperando va primero: es lo que se olvida.
    expect(lista.data.findIndex((f) => f.id === ev.pago!.id)).toBeLessThan(
      lista.data.findIndex((f) => f.id === er.pago!.id),
    );
    expect((await tes.resumen()).verificadosAtrasados).toBeGreaterThanOrEqual(1);
  });
});

describe('Conciliación', () => {
  it('lista por día del NEGOCIO con folio de VFP y totaliza lo que falta registrar', async () => {
    const { pagos, tes } = servicios();
    const tiendaX = await crearTiendaAislada();
    const sinRegistrar = await crearPedido({ total: 1500, tienda: tiendaX });
    const registrado = await crearPedido({ total: 800, tienda: tiendaX });
    const e1 = await pagos.emitirInstrucciones(sinRegistrar.id, cliente());
    const e2 = await pagos.emitirInstrucciones(registrado.id, cliente());
    await tes.aprobar(e1.pago!.id, aprobarDto(1500) as never, tesorero());
    await tes.aprobar(e2.pago!.id, aprobarDto(800) as never, tesorero());
    // El de 800 ya lo cobró VFP.
    await prisma.pedidoPagoTransferencia.update({
      where: { id: e2.pago!.id },
      data: { estado: E.APLICADO, aplicadoAt: new Date() },
    });

    const r = await tes.conciliacion({ tiendaId: tiendaX } as never);
    expect(r.filas.map((f) => f.folioWeb).sort()).toEqual(
      [sinRegistrar.numeroPedido, registrado.numeroPedido].sort(),
    );
    // Trae el folio de VFP: es lo que se busca en el corte de caja.
    expect(r.filas.every((f) => /^F\d+$/.test(f.folioVfp ?? ''))).toBe(true);
    expect(r.totales).toMatchObject({
      pagos: 2,
      verificado: '2300.00',
      registradoEnVfp: '800.00',
      sinRegistrarEnVfp: '1500.00',
      reembolsos: '0.00',
    });
    expect(r.porTienda).toEqual([
      expect.objectContaining({ verificado: '2300.00', sinRegistrar: '1500.00' }),
    ]);
  });

  it('un día sin verificaciones sale vacío; lo de otro día no entra', async () => {
    const { tes } = servicios();
    const r = await tes.conciliacion({
      desde: '2001-01-01',
      hasta: '2001-01-02',
      tiendaId,
    } as never);
    expect(r.filas).toHaveLength(0);
    expect(r.totales.pagos).toBe(0);
    expect(r.totales.verificado).toBe('0.00');
  });

  it('valida el rango: fechas reales, orden y tope de días', async () => {
    const { tes } = servicios();
    await expect(
      tes.conciliacion({ desde: '2026-02-31', hasta: '2026-03-01' } as never),
    ).rejects.toThrow(/reales/);
    await expect(
      tes.conciliacion({ desde: '2026-10-16', hasta: '2026-10-01' } as never),
    ).rejects.toThrow(/posterior/);
    await expect(
      tes.conciliacion({ desde: '2026-01-01', hasta: '2026-10-01' } as never),
    ).rejects.toThrow(/máximo/);
  });

  it('el CSV trae BOM, el encabezado y el pago, con nombre por rango', async () => {
    const { pagos, tes } = servicios();
    const tiendaX = await crearTiendaAislada();
    const p = await crearPedido({ total: 1500, tienda: tiendaX });
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await tes.aprobar(e.pago!.id, aprobarDto() as never, tesorero());
    const { csv, nombre } = await tes.conciliacionCsv({ tiendaId: tiendaX } as never);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Folio Sistema Comercial');
    expect(csv).toContain(p.numeroPedido);
    expect(csv.trim().split('\r\n')).toHaveLength(2); // encabezado + el único pago de esa tienda
    expect(nombre).toMatch(/^conciliacion-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

// ====================================================================
// El cliente elige el método al hacer el pedido: la transferencia se emite SOLA al pasar a pago
// ====================================================================

describe('Transferencia elegida al pedir: se emite sola al pasar a pago', () => {
  const mostradorActor = { id: null, rol: 'MOSTRADOR', nombre: 'Mostrador' };
  const emitir = (pedidoId: number) =>
    prisma.$transaction((tx) => emitirTransferenciaAlPasarAPago(tx, pedidoId, mostradorActor));
  const conMetodo = (pedidoId: number, metodo: 'TRANSFERENCIA' | 'EN_TIENDA' | null) =>
    prisma.pedido.update({ where: { id: pedidoId }, data: { metodoPagoPreferido: metodo } });

  it('crea el pago con la cuenta, el total firme y un evento marcado como automático', async () => {
    const p = await crearPedido({ total: 1500 });
    await conMetodo(p.id, 'TRANSFERENCIA');
    const cambio = await emitir(p.id);
    expect(cambio).toMatchObject({ pedidoId: p.id, tiendaId, estado: E.PENDIENTE });

    const fila = await ver(p.id);
    expect(fila.estado).toBe(E.PENDIENTE);
    expect(fila.montoEsperado.toString()).toBe('1500');
    expect(fila.referencia).toMatch(/^\d{7}$/);
    expect((fila.cuentaSnapshot as { clabe: string }).clabe).toBe('012180001234567899');
    const ev = await prisma.pagoTransferenciaEvento.findFirstOrThrow({
      where: { pagoId: fila.id, tipo: 'INSTRUCCIONES_EMITIDAS' },
    });
    expect(ev.detalle).toMatchObject({ automatico: true });
    // No manda correo propio: el cliente recibe los datos en el de "listo para pagar".
    expect(correos).toHaveLength(0);
  });

  it('es idempotente: volver a pasar por aquí no crea un segundo pago', async () => {
    const p = await crearPedido();
    await conMetodo(p.id, 'TRANSFERENCIA');
    await emitir(p.id);
    expect(await emitir(p.id)).toBeNull();
    expect(await prisma.pedidoPagoTransferencia.count({ where: { pedidoId: p.id } })).toBe(1);
  });

  it('el cliente lo ve de inmediato y caja sabe que NO debe cobrar', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    await conMetodo(p.id, 'TRANSFERENCIA');
    await emitir(p.id);
    const c = await pagos.obtenerParaCliente(p.id, cliente());
    expect(c.transferenciaEnCurso).toBe(true);
    expect(c.pago?.instrucciones?.lineas.length).toBeGreaterThan(0);
    expect((await pagos.resumenParaTienda(p.id, mostrador())).pago?.caja.accion).toBe('NO_COBRAR');
  });

  it('con pago en caja, sin método, o a domicilio NO emite nada (y no estorba mandar a pagar)', async () => {
    const enCaja = await crearPedido();
    await conMetodo(enCaja.id, 'EN_TIENDA');
    const sinMetodo = await crearPedido();
    const domicilio = await crearPedido({ modo: ModoEntrega.DOMICILIO });
    await conMetodo(domicilio.id, 'TRANSFERENCIA');
    for (const x of [enCaja, sinMetodo, domicilio]) expect(await emitir(x.id)).toBeNull();
    expect(
      await prisma.pedidoPagoTransferencia.count({
        where: { pedidoId: { in: [enCaja.id, sinMetodo.id, domicilio.id] } },
      }),
    ).toBe(0);
  });
});

describe('Caja sube el comprobante en nombre del cliente (16-oct)', () => {
  it('la cajera lo sube: el pago pasa a EN_REVISION, queda anotado quién y la vista de caja lo dice', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());

    const vista = await pagos.subirComprobante(p.id, cajero(), { buffer: PNG } as never, {});

    // La respuesta es la VISTA DE CAJA (no la del cliente).
    expect('puedeEnviarDatos' in vista).toBe(true);
    expect((await ver(p.id)).estado).toBe(E.EN_REVISION);
    const c = await prisma.pagoComprobante.findFirstOrThrow({ where: { pagoId: e.pago!.id } });
    expect(c.subidoPorId).toBe(cajeroId);
    expect(c.estado).toBe('PENDIENTE');
    const ev = await prisma.pagoTransferenciaEvento.findFirstOrThrow({
      where: { pagoId: e.pago!.id, tipo: 'COMPROBANTE_SUBIDO' },
    });
    expect(ev.actorRol).toBe(RolUsuario.CAJERO);
    expect(ev.actorNombre).toBe('Cajera Test');
    expect((ev.detalle as { porTienda: boolean }).porTienda).toBe(true);
    // Y NO verificó nada: sigue siendo trabajo de Tesorería.
    expect((await ver(p.id)).verificadoAt).toBeNull();
    // El cliente recibe su correo de "recibimos tu comprobante".
    await esperarCorreo('TRANSFERENCIA_COMPROBANTE_RECIBIDO');
  });

  it('caja ve el comprobante como "subido por la tienda" y Tesorería también', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await pagos.subirComprobante(p.id, cajero(), { buffer: PNG } as never, {});

    const caja = await pagos.resumenParaTienda(p.id, cajero());
    expect(caja.pago?.comprobantes).toEqual([
      expect.objectContaining({ porTienda: true, subidoPorNombre: 'CAJERO', estado: 'PENDIENTE' }),
    ]);
    const detalle = await tes.detalle(e.pago!.id);
    expect(detalle.comprobantes[0]).toMatchObject({ porTienda: true, subidoPorNombre: 'CAJERO' });
  });

  it('el comprobante que sube el CLIENTE sigue igual: no se marca como de la tienda', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    const vista = await pagos.subirComprobante(p.id, cliente(), { buffer: PNG } as never, {});

    // La respuesta sigue siendo la vista del cliente.
    expect('puedePedirDatos' in vista).toBe(true);
    expect((await tes.detalle(e.pago!.id)).comprobantes[0]).toMatchObject({
      porTienda: false,
      subidoPorNombre: null,
    });
  });

  it('caja ve los datos para transferir mientras hay algo que pagar, y solo entonces', async () => {
    const { pagos } = servicios();
    const p = await crearPedido({ total: 2340.5 });
    await pagos.emitirInstrucciones(p.id, cliente());

    const abierto = await pagos.resumenParaTienda(p.id, cajero());
    const lineas = abierto.pago!.datosParaTransferir!.lineas;
    const valor = (etiqueta: RegExp) => lineas.find((l) => etiqueta.test(l.etiqueta))?.valor;
    expect(valor(/clabe/i)).toBe('012180001234567899');
    expect(valor(/monto/i)).toMatch(/2340\.50|2,340\.50/);
    expect(abierto.pago!.datosParaTransferir!.texto).toContain('012180001234567899');

    // Con el pago ya verificado no hay nada que dictar: los datos dejan de ofrecerse.
    const { tes } = servicios();
    await tes.aprobar(abierto.pago!.id, aprobarDto(2340.5) as never, tesorero());
    expect((await pagos.resumenParaTienda(p.id, cajero())).pago!.datosParaTransferir).toBeNull();
  });

  it('`puedeSubirComprobante` lo decide el servidor: sí con la transferencia abierta, no con tres en revisión ni ya verificada', async () => {
    const { pagos, tes } = servicios();
    const p = await crearPedido();
    await pagos.emitirInstrucciones(p.id, cliente());
    expect((await pagos.resumenParaTienda(p.id, cajero())).pago!.puedeSubirComprobante).toBe(true);

    for (const extra of ['a', 'b', 'c']) {
      const otro = Buffer.concat([PNG, Buffer.from(extra)]);
      await pagos.subirComprobante(p.id, cajero(), { buffer: otro } as never, {});
    }
    const lleno = await pagos.resumenParaTienda(p.id, cajero());
    expect(lleno.pago!.comprobantes).toHaveLength(3);
    expect(lleno.pago!.puedeSubirComprobante).toBe(false);
    await expect(
      pagos.subirComprobante(
        p.id,
        cajero(),
        { buffer: Buffer.concat([PNG, Buffer.from('d')]) } as never,
        {},
      ),
    ).rejects.toThrow(/Tesorería/);

    await tes.aprobar(lleno.pago!.id, aprobarDto() as never, tesorero());
    expect((await pagos.resumenParaTienda(p.id, cajero())).pago!.puedeSubirComprobante).toBe(false);
  });

  it('subir el mismo archivo dos veces es idempotente también para caja', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    const e = await pagos.emitirInstrucciones(p.id, cliente());
    await pagos.subirComprobante(p.id, cajero(), { buffer: PNG } as never, {});
    await pagos.subirComprobante(p.id, cajero(), { buffer: PNG } as never, {});
    expect(await prisma.pagoComprobante.count({ where: { pagoId: e.pago!.id } })).toBe(1);
  });

  it('MOSTRADOR no puede subirlo (403) y una cajera de OTRA tienda tampoco; no se guarda nada', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    await pagos.emitirInstrucciones(p.id, cliente());
    storage.guardar.mockClear();

    await expect(
      pagos.subirComprobante(p.id, mostrador(), { buffer: PNG } as never, {}),
    ).rejects.toThrow(/cliente o la cajera/);
    const otraTienda = await crearTiendaAislada();
    await expect(
      pagos.subirComprobante(p.id, cajero(otraTienda), { buffer: PNG } as never, {}),
    ).rejects.toBeDefined();
    expect(storage.guardar).not.toHaveBeenCalled();
    expect(await prisma.pagoComprobante.count({ where: { pago: { pedidoId: p.id } } })).toBe(0);
  });

  it('sin una transferencia esperando comprobante, la cajera recibe 400 (no se inventa un pago)', async () => {
    const { pagos } = servicios();
    const p = await crearPedido();
    await expect(
      pagos.subirComprobante(p.id, cajero(), { buffer: PNG } as never, {}),
    ).rejects.toThrow(/no tiene una transferencia/);
  });
});
