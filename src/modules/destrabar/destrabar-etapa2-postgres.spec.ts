import 'dotenv/config';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  EstadoPagoTransferencia,
  EstadoPedido,
  EstadoPropuesta,
  EstadoSurtido,
  ModoEntrega,
  PrismaClient,
  RolUsuario,
} from '@prisma/client';
import { PedidoAccessService } from '../pedidos/core/pedido-access.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { ReposicionService } from '../pedidos/reposicion/reposicion.service';
import { AdminService } from '../pedidos/admin/admin.service';
import { BodegaService } from '../pedidos/bodega/bodega.service';
import { CajeroService } from '../pedidos/cajero/cajero.service';
import { PropuestaService } from '../pedidos/propuesta/propuesta.service';
import { VentasService } from '../pedidos/ventas/ventas.service';
import { MostradorService } from '../mostrador/mostrador.service';
import { DestrabarService } from './destrabar.service';

/**
 * Oct 2026 contra PostgreSQL REAL: destrabar pedidos, ETAPA 2 (responder la propuesta por el cliente, devolver a
 * bodega, quitar productos, liberar, marcar entregado y cancelar un pedido ya pagado).
 *
 * Lo que un mock no puede decir y este spec sí: que las filas que quedan son coherentes (la propuesta superada, el total
 * recalculado, la reposición, la transferencia que pasa sola a REEMBOLSO_PENDIENTE), que NINGÚN texto que lee el cliente
 * lleva el motivo interno, y que las acciones que cancelan no mandan correo.
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
const enviar = jest.fn().mockResolvedValue(undefined);
const confirmarDesdeMostrador = jest.fn().mockResolvedValue(undefined);
const config = { get: () => undefined };

let tiendaA: number;
let tiendaB: number;
let clienteId: number;
let gerenteId: number;
let adminId: number;
let bodegueroId: number;
let cajeroId: number;
let productoId: number;
const pedidoIds: number[] = [];
const usuarioIds: number[] = [];
let n = 0;

let destrabar: DestrabarService;

const gerenteA = () => ({
  userId: gerenteId,
  nombre: 'Gerente A (Gerente)',
  rol: RolUsuario.GERENTE,
  tiendaId: tiendaA,
});
const gerenteB = () => ({
  userId: gerenteId,
  nombre: 'Gerente B (Gerente)',
  rol: RolUsuario.GERENTE,
  tiendaId: tiendaB,
});
const admin = () => ({
  userId: adminId,
  nombre: 'Admin (Administrador)',
  rol: RolUsuario.ADMIN,
});

interface Linea {
  cantidad: number;
  nombre?: string;
}

/** Un pedido con líneas de $100 por pieza, todas surtidas completas. */
async function pedido(
  estado: EstadoPedido,
  o: {
    tienda?: number;
    lineas?: Linea[];
    asignadoAId?: number;
    cajeroAsignadoId?: number;
    envio?: { estado: string; folio?: string; erpId?: number };
  } = {},
) {
  const lineas = o.lineas ?? [{ cantidad: 2 }];
  const total = lineas.reduce((a, l) => a + l.cantidad * 100, 0);
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-E2${suffix}-${++n}`,
      usuarioId: clienteId,
      tiendaId: o.tienda ?? tiendaA,
      estado,
      modoEntrega: ModoEntrega.RECOGER_TIENDA,
      clienteNombre: 'Cliente E2',
      clienteEmail: `e2-${suffix}-${n}@test.local`,
      subtotal: total,
      total,
      asignadoAId: o.asignadoAId ?? null,
      cajeroAsignadoId: o.cajeroAsignadoId ?? null,
      items: {
        create: lineas.map((l, i) => ({
          productoId,
          cantidad: l.cantidad,
          cantidadPedida: l.cantidad,
          cantidadSurtida: l.cantidad,
          estadoSurtido: EstadoSurtido.COMPLETO,
          precioUnitario: 100,
          subtotal: l.cantidad * 100,
          productoNombre: l.nombre ?? `Playera ${i + 1}`,
          productoCodigo: `E2-${suffix}`,
          corridaNombre: 'Adulto',
          tallaNombre: 'M',
          colorNombre: 'Negro',
        })),
      },
      ...(o.envio
        ? {
            pendienteEnvio: {
              create: {
                estado: o.envio.estado,
                externalFolio: o.envio.folio ?? null,
                externalIdPEDIDOS: o.envio.erpId ?? null,
              },
            },
          }
        : {}),
    },
    include: { items: { orderBy: { id: 'asc' } } },
  });
  pedidoIds.push(p.id);
  return p;
}

const propuesta = (pedidoId: number, creadaPorRol: RolUsuario) =>
  prisma.pedidoPropuesta.create({
    data: { pedidoId, creadaPorId: bodegueroId, creadaPorRol, items: [], total: 0 },
  });
const leer = (id: number) =>
  prisma.pedido.findUniqueOrThrow({
    where: { id },
    include: { items: { orderBy: { id: 'asc' } } },
  });
const historial = async (id: number) =>
  JSON.stringify(await prisma.historialPedido.findMany({ where: { pedidoId: id } }));
const bitacora = (id: number) =>
  prisma.pedidoIntervencion.findMany({ where: { pedidoId: id }, orderBy: { id: 'asc' } });

beforeAll(async () => {
  const mk = (x: string) =>
    prisma.tienda.create({
      data: { nombre: `DestrE2 ${x} ${suffix}`, direccion: 'x', ciudad: x, estado: 'x' },
    });
  tiendaA = (await mk('A')).id;
  tiendaB = (await mk('B')).id;
  const u = async (rol: RolUsuario, tid?: number) => {
    const id = (
      await prisma.usuario.create({
        data: {
          email: `e2-${rol}-${suffix}@test.local`,
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
  gerenteId = await u(RolUsuario.GERENTE, tiendaA);
  adminId = await u(RolUsuario.ADMIN);
  bodegueroId = await u(RolUsuario.BODEGA, tiendaA);
  cajeroId = await u(RolUsuario.CAJERO, tiendaA);
  productoId = (
    await prisma.producto.create({ data: { codigo: `E2-${suffix}`, nombre: 'Playera E2' } })
  ).id;

  const access = new PedidoAccessService(prisma as never);
  const state = new PedidoStateService(
    prisma as never,
    { enviar } as never,
    realtime as never,
    access,
    { resolverImagen: (x: unknown) => x } as never,
  );
  const reposicion = new ReposicionService(prisma as never, realtime as never);
  const precios = { columnaParaPedido: jest.fn(async () => 'lista1') } as never;
  destrabar = new DestrabarService(
    prisma as never,
    access,
    state,
    reposicion,
    new AdminService(prisma as never, { enviar } as never, realtime as never, access, state),
    {} as never, // Tesorería: solo la usa MARCAR_VENCIDA (etapa 1)
    new PropuestaService(prisma as never, realtime as never, access, state, reposicion, precios, {
      enviar,
    } as never),
    new VentasService(prisma as never, {} as never, state),
    new BodegaService(prisma as never, realtime as never, state, access),
    new CajeroService(prisma as never, realtime as never, state, {} as never),
    new MostradorService(
      prisma as never,
      state,
      access,
      reposicion,
      realtime as never,
      precios,
      { confirmarDesdeMostrador } as never,
      {} as never,
      {} as never,
      config as never,
    ),
  );
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
  await prisma.producto.deleteMany({ where: { id: productoId } });
  await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } });
  await prisma.tienda.deleteMany({ where: { id: { in: [tiendaA, tiendaB] } } });
  await prisma.$disconnect();
});
beforeEach(() => jest.clearAllMocks());

describe('Responder la propuesta por el cliente (aprobar / rechazar)', () => {
  it('aprobar la de bodega: sigue su camino, queda marcada como forzada y el historial no lleva el motivo ni dice "mostrador"', async () => {
    const p = await pedido(EstadoPedido.ESPERANDO_APROBACION);
    const prop = await propuesta(p.id, RolUsuario.BODEGA);
    const v = await destrabar.obtener(p.id, gerenteA() as never);
    expect(v.acciones.map((a) => a.id)).toEqual(
      expect.arrayContaining(['APROBAR_PROPUESTA', 'RECHAZAR_PROPUESTA', 'CANCELAR_SIN_PAGO']),
    );

    await destrabar.ejecutar(
      p.id,
      'APROBAR_PROPUESTA',
      { motivo: 'Lleva 3 días sin contestar y ya habló por teléfono' },
      gerenteA() as never,
    );

    expect((await leer(p.id)).estado).toBe(EstadoPedido.REVISADO);
    expect(
      await prisma.pedidoPropuesta.findUniqueOrThrow({ where: { id: prop.id } }),
    ).toMatchObject({ estado: EstadoPropuesta.ACEPTADA, forzadaPorId: gerenteId });
    const h = await historial(p.id);
    expect(h).toContain('La tienda aprobó la propuesta, en nombre del cliente');
    // El historial lo lee el cliente: ni el id de la propuesta ni el valor interno de la decisión.
    expect(h).not.toMatch(/#\d|APROBAR/);
    expect(h).not.toContain('desde mostrador');
    expect(h).not.toContain('3 días');
    const [b] = await bitacora(p.id);
    expect(b).toMatchObject({
      tipo: 'APROBAR_PROPUESTA',
      actorRol: 'GERENTE',
      estadoAntes: 'ESPERANDO_APROBACION',
      estadoDespues: 'REVISADO',
      mensajeCliente: null,
    });
    expect(b.detalle).toMatchObject({ propuestaId: prop.id, origen: 'BODEGA' });
  });

  it('rechazar la de bodega CANCELA: sin correo, con reposición, y el cliente lee el texto estándar + su mensaje (sin el motivo)', async () => {
    const p = await pedido(EstadoPedido.ESPERANDO_APROBACION);
    const prop = await propuesta(p.id, RolUsuario.BODEGA);

    await destrabar.ejecutar(
      p.id,
      'RECHAZAR_PROPUESTA',
      {
        motivo: 'No contesta desde el lunes',
        mensajeCliente: 'Haz un pedido nuevo cuando quieras.',
      },
      gerenteA() as never,
    );

    expect((await leer(p.id)).estado).toBe(EstadoPedido.CANCELADO);
    expect(enviar).not.toHaveBeenCalled();
    expect(
      (await prisma.pedidoPropuesta.findUniqueOrThrow({ where: { id: prop.id } })).estado,
    ).toBe(EstadoPropuesta.RECHAZADA);
    expect(await prisma.pedidoReposicion.findUnique({ where: { pedidoId: p.id } })).not.toBeNull();
    const [b] = await bitacora(p.id);
    expect(b.mensajeCliente).toBe(
      'Cancelamos tu pedido porque no respondiste a la propuesta que te enviamos. Haz un pedido nuevo cuando quieras.',
    );
    expect(b.mensajeCliente).not.toContain('lunes');
    const h = await historial(p.id);
    expect(h).toContain('La tienda rechazó la propuesta');
    expect(h).not.toContain('Cliente rechazó');
    expect(h).not.toContain('lunes');
  });

  it('rechazar la del asesor lo regresa a asesoría (no cancela) y no deja mensaje para el cliente', async () => {
    const p = await pedido(EstadoPedido.ESPERANDO_APROBACION);
    await propuesta(p.id, RolUsuario.VENTAS);
    const accion = (await destrabar.obtener(p.id, gerenteA() as never)).acciones.find(
      (a) => a.id === 'RECHAZAR_PROPUESTA',
    )!;
    expect(accion).toMatchObject({ tono: 'normal', pideMensajeCliente: false });

    await destrabar.ejecutar(
      p.id,
      'RECHAZAR_PROPUESTA',
      { motivo: 'El cliente pidió otra cosa por teléfono', mensajeCliente: 'ignorado' },
      gerenteA() as never,
    );
    expect((await leer(p.id)).estado).toBe(EstadoPedido.EN_ASESORIA);
    const [b] = await bitacora(p.id);
    expect(b.mensajeCliente).toBeNull();
  });

  it('también cabe con el pedido ya en el área de entrega (REVISADO); sin propuesta pendiente no se ofrece; la segunda vez da 409', async () => {
    const sinPropuesta = await pedido(EstadoPedido.ESPERANDO_APROBACION);
    expect(
      (await destrabar.obtener(sinPropuesta.id, gerenteA() as never)).acciones.map((a) => a.id),
    ).not.toContain('APROBAR_PROPUESTA');

    const p = await pedido(EstadoPedido.REVISADO);
    await propuesta(p.id, RolUsuario.BODEGA);
    await destrabar.ejecutar(
      p.id,
      'APROBAR_PROPUESTA',
      { motivo: 'El cliente se fue sin responder' },
      gerenteA() as never,
    );
    await expect(
      destrabar.ejecutar(p.id, 'APROBAR_PROPUESTA', { motivo: 'otra vez' }, gerenteA() as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('un gerente de OTRA tienda no responde la propuesta (403) y el pedido no se mueve', async () => {
    const p = await pedido(EstadoPedido.ESPERANDO_APROBACION);
    await propuesta(p.id, RolUsuario.BODEGA);
    await expect(
      destrabar.ejecutar(p.id, 'APROBAR_PROPUESTA', { motivo: 'prueba' }, gerenteB() as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((await leer(p.id)).estado).toBe(EstadoPedido.ESPERANDO_APROBACION);
  });
});

describe('Devolver a bodega desde asesoría', () => {
  it('vuelve a EN_REVISION sin asignar, supera la propuesta y el cliente no lee ni "asesor" ni el motivo', async () => {
    const p = await pedido(EstadoPedido.EN_ASESORIA, { asignadoAId: bodegueroId });
    const prop = await propuesta(p.id, RolUsuario.VENTAS);

    await destrabar.ejecutar(
      p.id,
      'DEVOLVER_A_BODEGA',
      { motivo: 'El asesor se fue de vacaciones' },
      gerenteA() as never,
    );

    const despues = await leer(p.id);
    expect(despues).toMatchObject({ estado: EstadoPedido.EN_REVISION, asignadoAId: null });
    expect(
      await prisma.pedidoPropuesta.findUniqueOrThrow({ where: { id: prop.id } }),
    ).toMatchObject({ estado: EstadoPropuesta.SUPERADA, notaCliente: null });
    const h = await historial(p.id);
    expect(h).toContain('Devuelto a bodega por la tienda');
    expect(h).not.toContain('vacaciones');
    expect((await bitacora(p.id))[0]).toMatchObject({
      tipo: 'DEVOLVER_A_BODEGA',
      estadoAntes: 'EN_ASESORIA',
      estadoDespues: 'EN_REVISION',
    });
  });

  it('solo se ofrece en asesoría', async () => {
    const p = await pedido(EstadoPedido.SOLICITADO);
    expect(
      (await destrabar.obtener(p.id, gerenteA() as never)).acciones.map((a) => a.id),
    ).not.toContain('DEVOLVER_A_BODEGA');
  });
});

describe('Quitar o bajar productos (antes del ERP)', () => {
  it('quita una línea y baja otra: total recalculado, propuesta superada sin la nota, reposición, y NO registra la llegada del cliente', async () => {
    const p = await pedido(EstadoPedido.ESPERANDO_APROBACION, {
      lineas: [{ cantidad: 6 }, { cantidad: 2 }],
    });
    const prop = await propuesta(p.id, RolUsuario.BODEGA);
    const accion = (await destrabar.obtener(p.id, gerenteA() as never)).acciones.find(
      (a) => a.id === 'QUITAR_PRODUCTOS',
    )!;
    expect(accion.entrada).toBe('productos');
    expect(accion.lineas).toEqual([
      { itemId: p.items[0].id, descripcion: 'Playera 1 · Negro · M', cantidad: 6 },
      { itemId: p.items[1].id, descripcion: 'Playera 2 · Negro · M', cantidad: 2 },
    ]);

    await destrabar.ejecutar(
      p.id,
      'QUITAR_PRODUCTOS',
      {
        motivo: 'Pidió quitar la segunda y bajar la primera por teléfono',
        items: [
          { itemId: p.items[1].id, cantidad: 0 },
          { itemId: p.items[0].id, cantidad: 4 },
        ],
      },
      gerenteA() as never,
    );

    const despues = await leer(p.id);
    // El cliente no está: el pedido espera en el área de entrega, no a bodega.
    expect(despues.estado).toBe(EstadoPedido.REVISADO);
    expect(despues.items[0]).toMatchObject({ cantidad: 4, cancelada: false });
    expect(despues.items[1].cancelada).toBe(true);
    expect(Number(despues.total)).toBe(400);
    expect(
      await prisma.pedidoPropuesta.findUniqueOrThrow({ where: { id: prop.id } }),
    ).toMatchObject({ estado: EstadoPropuesta.SUPERADA, notaCliente: null });
    // Lo que se quitó pasa a reposición (las 2 de la segunda + las 2 que bajaron de la primera).
    const repo = await prisma.pedidoReposicion.findUniqueOrThrow({ where: { pedidoId: p.id } });
    const piezas = (repo.items as Array<{ cantidad: number }>).reduce((a, i) => a + i.cantidad, 0);
    expect(piezas).toBe(4);
    // El cliente está AUSENTE: nada de "llegó al mostrador".
    expect(confirmarDesdeMostrador).not.toHaveBeenCalled();
    const h = await historial(p.id);
    expect(h).toContain('Ajuste hecho por la tienda');
    expect(h).not.toContain('por teléfono');
    expect(h).not.toContain('Ajuste en mostrador');
    expect((await bitacora(p.id))[0]).toMatchObject({
      tipo: 'QUITAR_PRODUCTOS',
      estadoAntes: 'ESPERANDO_APROBACION',
      estadoDespues: 'REVISADO',
    });
  });

  it('solo quita o baja: subir, agregar, repetir, una línea ajena o vaciar el pedido dan 400 y no tocan nada', async () => {
    const p = await pedido(EstadoPedido.REVISADO, { lineas: [{ cantidad: 3 }, { cantidad: 1 }] });
    const otro = await pedido(EstadoPedido.REVISADO, { lineas: [{ cantidad: 1 }] });
    const probar = (items: Array<{ itemId: number; cantidad: number }> | undefined) =>
      destrabar.ejecutar(
        p.id,
        'QUITAR_PRODUCTOS',
        { motivo: 'prueba', items },
        gerenteA() as never,
      );

    await expect(probar(undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(probar([])).rejects.toBeInstanceOf(BadRequestException);
    await expect(probar([{ itemId: p.items[0].id, cantidad: 3 }])).rejects.toThrow(
      /solo se puede quitar o bajar/,
    );
    await expect(probar([{ itemId: p.items[0].id, cantidad: 9 }])).rejects.toThrow(
      /solo se puede quitar o bajar/,
    );
    await expect(probar([{ itemId: otro.items[0].id, cantidad: 0 }])).rejects.toThrow(
      /no es una línea activa/,
    );
    await expect(
      probar([
        { itemId: p.items[0].id, cantidad: 1 },
        { itemId: p.items[0].id, cantidad: 2 },
      ]),
    ).rejects.toThrow(/repetido/);
    await expect(
      probar([
        { itemId: p.items[0].id, cantidad: 0 },
        { itemId: p.items[1].id, cantidad: 0 },
      ]),
    ).rejects.toThrow(/sin productos/);
    await expect(probar([{ itemId: p.items[0].id, cantidad: -1 }])).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const intacto = await leer(p.id);
    expect(intacto.items.map((i) => [i.cantidad, i.cancelada])).toEqual([
      [3, false],
      [1, false],
    ]);
    expect(await bitacora(p.id)).toHaveLength(0);
  });

  it('con un producto que bodega no surtió completo la acción aparece BLOQUEADA (ajustar mandaría el pedido a bodega) y primero se resuelve la propuesta', async () => {
    const p = await pedido(EstadoPedido.ESPERANDO_APROBACION, {
      lineas: [{ cantidad: 3 }, { cantidad: 5 }],
    });
    // La segunda línea: pidió 5 y bodega solo encontró 3 (la propuesta está en la mesa).
    await prisma.itemPedido.update({
      where: { id: p.items[1].id },
      data: { cantidadSurtida: 3, estadoSurtido: EstadoSurtido.PARCIAL },
    });
    await propuesta(p.id, RolUsuario.BODEGA);

    const v = await destrabar.obtener(p.id, gerenteA() as never);
    const quitar = v.acciones.find((a) => a.id === 'QUITAR_PRODUCTOS')!;
    expect(quitar.bloqueadaPor).toMatch(/aprueba o rechaza la propuesta/);
    expect(v.acciones.find((a) => a.id === 'APROBAR_PROPUESTA')!.bloqueadaPor).toBeNull();
    await expect(
      destrabar.ejecutar(
        p.id,
        'QUITAR_PRODUCTOS',
        { motivo: 'prueba', items: [{ itemId: p.items[0].id, cantidad: 1 }] },
        gerenteA() as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await leer(p.id)).estado).toBe(EstadoPedido.ESPERANDO_APROBACION);
  });

  it('no se ofrece con el cliente en la mesa (EN_ATENCION) ni ya en caja', async () => {
    for (const estado of [EstadoPedido.EN_ATENCION, EstadoPedido.PENDIENTE_PAGO]) {
      const p = await pedido(estado);
      expect(
        (await destrabar.obtener(p.id, gerenteA() as never)).acciones.map((a) => a.id),
      ).not.toContain('QUITAR_PRODUCTOS');
    }
  });
});

describe('Liberar un pedido tomado', () => {
  it('bodega: lo suelta a la cola (sigue EN_REVISION), con su historial; sin bodeguero no se ofrece', async () => {
    const libre = await pedido(EstadoPedido.EN_REVISION);
    expect(
      (await destrabar.obtener(libre.id, gerenteA() as never)).acciones.map((a) => a.id),
    ).not.toContain('LIBERAR_BODEGA');

    const p = await pedido(EstadoPedido.EN_REVISION, { asignadoAId: bodegueroId });
    const a = (await destrabar.obtener(p.id, gerenteA() as never)).acciones.find(
      (x) => x.id === 'LIBERAR_BODEGA',
    )!;
    expect(a.descripcion).toContain('BODEGA'); // dice QUIÉN lo tiene

    await destrabar.ejecutar(
      p.id,
      'LIBERAR_BODEGA',
      { motivo: 'El bodeguero se fue sin cerrar sesión' },
      gerenteA() as never,
    );
    expect(await leer(p.id)).toMatchObject({ estado: EstadoPedido.EN_REVISION, asignadoAId: null });
    expect(await historial(p.id)).not.toContain('sin cerrar sesión');
    expect((await bitacora(p.id))[0].detalle).toMatchObject({ bodegueroId });
    expect(realtime.emitToTienda).toHaveBeenCalledWith(
      tiendaA,
      'pedido.liberado',
      expect.objectContaining({ id: p.id }),
    );
  });

  it('caja: lo suelta de la ventanilla conservando su lugar en la fila', async () => {
    const turno = new Date(Date.now() - 3_600_000);
    const p = await pedido(EstadoPedido.PENDIENTE_PAGO, { cajeroAsignadoId: cajeroId });
    await prisma.pedido.update({ where: { id: p.id }, data: { colaCajaDesdeAt: turno } });

    await destrabar.ejecutar(
      p.id,
      'LIBERAR_CAJA',
      { motivo: 'La cajera cerró y el cliente espera' },
      gerenteA() as never,
    );
    const despues = await leer(p.id);
    expect(despues).toMatchObject({ estado: EstadoPedido.PENDIENTE_PAGO, cajeroAsignadoId: null });
    expect(despues.colaCajaDesdeAt?.getTime()).toBe(turno.getTime());
  });

  it('el gerente de otra tienda no libera (403)', async () => {
    const p = await pedido(EstadoPedido.PENDIENTE_PAGO, { cajeroAsignadoId: cajeroId });
    await expect(
      destrabar.ejecutar(p.id, 'LIBERAR_CAJA', { motivo: 'prueba' }, gerenteB() as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((await leer(p.id)).cajeroAsignadoId).toBe(cajeroId);
  });
});

describe('Marcar entregado', () => {
  it('PAGADO y ENVIADO pasan a ENTREGADO sin correo y sin tareas; el cliente no lee el motivo', async () => {
    for (const estado of [EstadoPedido.PAGADO, EstadoPedido.ENVIADO]) {
      const p = await pedido(estado, { envio: { estado: 'PROCESADO', folio: '1', erpId: 1 } });
      await destrabar.ejecutar(
        p.id,
        'MARCAR_ENTREGADO',
        { motivo: 'Vino por él el martes y nadie lo marcó' },
        gerenteA() as never,
      );
      expect((await leer(p.id)).estado).toBe(EstadoPedido.ENTREGADO);
      expect(await prisma.tareaSistemaComercial.count({ where: { pedidoId: p.id } })).toBe(0);
      const h = await historial(p.id);
      expect(h).toContain('Marcado como entregado por la tienda');
      expect(h).not.toContain('martes');
      expect((await bitacora(p.id))[0]).toMatchObject({
        tipo: 'MARCAR_ENTREGADO',
        estadoDespues: 'ENTREGADO',
      });
    }
    expect(enviar).not.toHaveBeenCalled();
  });

  it('no se ofrece antes de cobrar ni ya entregado', async () => {
    for (const estado of [EstadoPedido.PENDIENTE_PAGO, EstadoPedido.ENTREGADO]) {
      const p = await pedido(estado);
      expect(
        (await destrabar.obtener(p.id, gerenteA() as never)).acciones.map((a) => a.id),
      ).not.toContain('MARCAR_ENTREGADO');
    }
  });
});

describe('Cancelar un pedido YA pagado (solo ADMIN)', () => {
  it('el gerente ni lo ve ni lo ejecuta (403)', async () => {
    const p = await pedido(EstadoPedido.PAGADO);
    expect(
      (await destrabar.obtener(p.id, gerenteA() as never)).acciones.map((a) => a.id),
    ).not.toContain('CANCELAR_PAGADO');
    await expect(
      destrabar.ejecutar(p.id, 'CANCELAR_PAGADO', { motivo: 'prueba' }, gerenteA() as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((await leer(p.id)).estado).toBe(EstadoPedido.PAGADO);
  });

  it('el ADMIN cancela: tarea "anular la venta" (no "cancelar"), transferencia a REEMBOLSO_PENDIENTE, reposición y sin correo', async () => {
    const p = await pedido(EstadoPedido.PAGADO, {
      envio: { estado: 'PROCESADO', folio: '0000000321', erpId: 321 },
    });
    const pago = await prisma.pedidoPagoTransferencia.create({
      data: {
        pedidoId: p.id,
        estado: EstadoPagoTransferencia.APLICADO,
        montoEsperado: 200,
        montoVerificado: 200,
        verificadoAt: new Date(),
        verificadoPorId: adminId,
        aplicadoAt: new Date(),
        cuentaSnapshot: { banco: 'B', titular: 'T', clabe: '012180001234567897' },
        referencia: String(6_900_000 + n).slice(0, 7),
        concepto: 'X',
      },
    });
    const a = (await destrabar.obtener(p.id, admin() as never)).acciones.find(
      (x) => x.id === 'CANCELAR_PAGADO',
    )!;
    expect(a).toMatchObject({ tono: 'peligro', pideMensajeCliente: true });
    expect(a.advierteErp).toContain('anule la venta');

    const r = await destrabar.ejecutar(
      p.id,
      'CANCELAR_PAGADO',
      {
        motivo: 'Producto defectuoso, el dueño autorizó devolver todo',
        mensajeCliente: 'Disculpa.',
      },
      admin() as never,
    );

    expect((await leer(p.id)).estado).toBe(EstadoPedido.CANCELADO);
    expect(enviar).not.toHaveBeenCalled();
    expect(r.tareas).toHaveLength(1);
    expect(r.tareas[0]).toMatchObject({
      tipo: 'ANULAR_VENTA_EN_ERP',
      titulo: 'Anular la venta en el Sistema Comercial',
      folio: '0000000321',
    });
    expect(r.tareas[0].instruccion).toContain('0000000321');
    expect(
      await prisma.pedidoPagoTransferencia.findUniqueOrThrow({ where: { id: pago.id } }),
    ).toMatchObject({ estado: EstadoPagoTransferencia.REEMBOLSO_PENDIENTE });
    expect(await prisma.pedidoReposicion.findUnique({ where: { pedidoId: p.id } })).not.toBeNull();
    const [b] = await bitacora(p.id);
    expect(b).toMatchObject({
      tipo: 'CANCELAR_PAGADO',
      actorRol: 'ADMIN',
      estadoAntes: 'PAGADO',
      estadoDespues: 'CANCELADO',
      mensajeCliente: 'Cancelamos tu pedido. Te devolveremos el pago que hiciste. Disculpa.',
    });
    const h = await historial(p.id);
    expect(h).not.toContain('defectuoso');
  });

  it('un pedido que nunca llegó al ERP no abre tarea (no hay venta que anular), y uno ya ENTREGADO no se cancela', async () => {
    const p = await pedido(EstadoPedido.PAGADO);
    const r = await destrabar.ejecutar(
      p.id,
      'CANCELAR_PAGADO',
      { motivo: 'Cobrado por error' },
      admin() as never,
    );
    expect(r.tareas).toHaveLength(0);
    expect((await leer(p.id)).estado).toBe(EstadoPedido.CANCELADO);

    const entregado = await pedido(EstadoPedido.ENTREGADO);
    await expect(
      destrabar.ejecutar(entregado.id, 'CANCELAR_PAGADO', { motivo: 'prueba' }, admin() as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cancelar SIN pago un pedido en el ERP sigue abriendo "cancelar" (no "anular la venta")', async () => {
    const p = await pedido(EstadoPedido.PENDIENTE_PAGO, {
      envio: { estado: 'PROCESADO', folio: '0000000654', erpId: 654 },
    });
    const r = await destrabar.ejecutar(
      p.id,
      'CANCELAR_SIN_PAGO',
      { motivo: 'No pagó' },
      gerenteA() as never,
    );
    expect(r.tareas.map((t) => t.tipo)).toEqual(['CANCELAR_EN_ERP']);
  });
});
