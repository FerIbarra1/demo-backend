import 'dotenv/config';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  EstadoPagoTransferencia,
  EstadoPedido,
  EstadoPropuesta,
  ModoEntrega,
  PrismaClient,
  RolUsuario,
} from '@prisma/client';
import { PedidoAccessService } from '../core/pedido-access.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { ReposicionService } from '../reposicion/reposicion.service';
import { ClienteService } from './cliente.service';

/**
 * Oct 2026 contra PostgreSQL REAL: cancelar un pedido (el cliente).
 *
 * Los mocks de Prisma esconden justo lo que aquí importa: que la lista, el detalle y la cancelación real salgan de la
 * MISMA decisión. Esta prueba cruza los 12 estados × los estados de pago (48 pedidos de verdad, con su pago de verdad)
 * y comprueba que `puedeCancelar` de «Mis pedidos» y del detalle es exactamente lo que el servidor hace al cancelar:
 * si la bandera dice que sí, cancela; si dice que no, responde 409 con el MISMO texto que la bandera.
 */
jest.setTimeout(120_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const realtime = {
  emitToTienda: jest.fn(),
  emitToPedido: jest.fn(),
  emitToUser: jest.fn(),
  emitToTesoreria: jest.fn(),
};
const notifications = { enviar: jest.fn().mockResolvedValue(undefined) };
const storage = { resolverImagen: (x: unknown) => x };

const access = new PedidoAccessService(prisma as never);
const state = new PedidoStateService(
  prisma as never,
  notifications as never,
  realtime as never,
  access,
  storage as never,
);
const svc = new ClienteService(
  prisma as never,
  notifications as never,
  realtime as never,
  state,
  storage as never,
  {} as never, // kioskoService
  {} as never, // kioskoLlegada
  {} as never, // precios
  new ReposicionService(prisma as never, realtime as never),
  {} as never, // presencia
  {} as never, // sinRecoger
);

let tiendaId: number;
let clienteId: number;
let otroClienteId: number;
let bodegueroId: number;
const pedidoIds: number[] = [];
const usuarioIds: number[] = [];
let n = 0;

const comoCliente = (id = clienteId) => ({
  userId: id,
  nombre: 'Cliente',
  rol: RolUsuario.CLIENTE,
  tiendaId,
});

type Situacion = 'sinPago' | 'PENDIENTE' | 'EN_REVISION' | 'VERIFICADO';
const SITUACIONES: Situacion[] = ['sinPago', 'PENDIENTE', 'EN_REVISION', 'VERIFICADO'];

async function pedido(
  estado: EstadoPedido,
  situacion: Situacion = 'sinPago',
  duenoId = clienteId,
  modoEntrega: ModoEntrega = ModoEntrega.RECOGER_TIENDA,
) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-C${suffix}-${++n}`,
      usuarioId: duenoId,
      tiendaId,
      estado,
      modoEntrega,
      clienteNombre: 'C',
      clienteEmail: `c${n}-${suffix}@test.local`,
      subtotal: 100,
      total: 100,
    },
  });
  pedidoIds.push(p.id);
  if (situacion !== 'sinPago') await pago(p.id, situacion);
  return p;
}

const pago = (pedidoId: number, estado: Situacion | EstadoPagoTransferencia) =>
  prisma.pedidoPagoTransferencia.create({
    data: {
      pedidoId,
      estado: estado as EstadoPagoTransferencia,
      montoEsperado: 100,
      cuentaSnapshot: { banco: 'B', titular: 'T', clabe: '012180001234567897' },
      referencia: String(6_100_000 + ++n).slice(0, 7),
      concepto: 'X',
      // La BD exige que todo pago verificado diga cuánto, cuándo y quién.
      ...(estado === EstadoPagoTransferencia.VERIFICADO
        ? { verificadoAt: new Date(), montoVerificado: 100, verificadoPorId: bodegueroId }
        : {}),
    },
  });

const leer = (id: number) => prisma.pedido.findUniqueOrThrow({ where: { id } });
const motivoGuardado = (id: number) =>
  prisma.pedidoCancelacionCliente.findUnique({ where: { pedidoId: id } });

beforeAll(async () => {
  await prisma.$connect();
  tiendaId = (
    await prisma.tienda.create({
      data: { nombre: `Cancel ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
    })
  ).id;
  const mk = async (email: string, rol: RolUsuario) => {
    const id = (
      await prisma.usuario.create({
        data: {
          email: `${email}-${suffix}@test.local`,
          password: 'integration-test-only',
          nombre: email,
          rol,
          ...(rol === RolUsuario.BODEGA ? { tiendaId } : {}),
        },
      })
    ).id;
    usuarioIds.push(id);
    return id;
  };
  clienteId = await mk('cancel-cli', RolUsuario.CLIENTE);
  otroClienteId = await mk('cancel-otro', RolUsuario.CLIENTE);
  bodegueroId = await mk('cancel-bod', RolUsuario.BODEGA);
});

afterAll(async () => {
  const pagos = await prisma.pedidoPagoTransferencia.findMany({
    where: { pedidoId: { in: pedidoIds } },
    select: { id: true },
  });
  await prisma.pagoTransferenciaEvento.deleteMany({
    where: { pagoId: { in: pagos.map((p) => p.id) } },
  });
  await prisma.pedidoPagoTransferencia.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.pedidoReposicion.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  // La cancelación del motivo, las propuestas y el historial se van en cascada con el pedido.
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } });
  await prisma.tienda.deleteMany({ where: { id: tiendaId } });
  await prisma.$disconnect();
});
beforeEach(() => jest.clearAllMocks());

describe('LISTA = DETALLE = CANCELACIÓN REAL (12 estados × 4 situaciones de pago, contra la BD)', () => {
  type Caso = { id: number; estado: EstadoPedido; situacion: Situacion };
  const casos: Caso[] = [];
  const lista = new Map<number, Record<string, unknown>>();
  const detalle = new Map<number, Record<string, unknown>>();

  const BANDERAS = [
    'puedeCancelar',
    'motivoNoPuedeCancelar',
    'cancelarDevuelveMercancia',
    'cancelarPideConfirmarTransferencia',
  ] as const;
  const banderas = (x: Record<string, unknown>) =>
    Object.fromEntries(BANDERAS.map((k) => [k, x[k]]));

  beforeAll(async () => {
    for (const estado of Object.values(EstadoPedido)) {
      for (const situacion of SITUACIONES) {
        const p = await pedido(estado, situacion);
        casos.push({ id: p.id, estado, situacion });
      }
    }
    // UNA sola llamada para los 48: así también se prueba que la consulta de pagos por lote asigna cada pago a su pedido.
    const page = await svc.obtenerMisPedidos(clienteId, 1, 100);
    for (const p of page.data) lista.set(p.id, p as never);
    for (const c of casos) detalle.set(c.id, (await svc.obtenerMiPedido(c.id, clienteId)) as never);
  });

  it('son 48 pedidos y la lista los trae todos', () => {
    expect(casos).toHaveLength(48);
    expect(Object.values(EstadoPedido)).toHaveLength(12);
    for (const c of casos) expect(lista.has(c.id)).toBe(true);
  });

  it('la lista y el detalle dicen LO MISMO de cada pedido', () => {
    for (const c of casos) {
      expect({ caso: c, ...banderas(lista.get(c.id)!) }).toEqual({
        caso: c,
        ...banderas(detalle.get(c.id)!),
      });
    }
  });

  it('exactamente 12 de los 48 se pueden cancelar: los seis estados cancelables, sin pago o con pago PENDIENTE', () => {
    const si = casos.filter((c) => lista.get(c.id)!.puedeCancelar === true);
    expect(si).toHaveLength(12);
    expect([...new Set(si.map((c) => c.estado))].sort()).toEqual(
      [
        EstadoPedido.SOLICITADO,
        EstadoPedido.EN_REVISION,
        EstadoPedido.ESPERANDO_APROBACION,
        EstadoPedido.EN_ASESORIA,
        EstadoPedido.REVISADO,
        EstadoPedido.PENDIENTE_PAGO,
      ].sort(),
    );
    expect([...new Set(si.map((c) => c.situacion))].sort()).toEqual(['PENDIENTE', 'sinPago']);
  });

  it('«En atención» sale cerrado, con su motivo, en la lista y en el detalle', () => {
    for (const c of casos.filter((x) => x.estado === EstadoPedido.EN_ATENCION)) {
      for (const origen of [lista, detalle]) {
        expect(origen.get(c.id)!.puedeCancelar).toBe(false);
        expect(origen.get(c.id)!.motivoNoPuedeCancelar).toMatch(
          /díselo a la persona que te atiende/i,
        );
      }
    }
  });

  it.each(
    Object.values(EstadoPedido).flatMap((estado) => SITUACIONES.map((s) => [estado, s] as const)),
  )(
    '%s con pago «%s»: la cancelación real hace lo que dijo la bandera',
    async (estado, situacion) => {
      const c = casos.find((x) => x.estado === estado && x.situacion === situacion)!;
      const b = banderas(lista.get(c.id)!);

      if (b.puedeCancelar === true) {
        // Con una transferencia PENDIENTE el servidor exige la confirmación «todavía no transferí»: la bandera lo avisa.
        expect(b.cancelarPideConfirmarTransferencia).toBe(situacion === 'PENDIENTE');
        if (b.cancelarPideConfirmarTransferencia) {
          const sin = await svc.cancelarPedido(c.id, clienteId, comoCliente()).catch((e) => e);
          expect(sin).toBeInstanceOf(ConflictException);
          expect(sin.getResponse().codigo).toBe('CONFIRMAR_TRANSFERENCIA');
          expect((await leer(c.id)).estado).toBe(estado);
        }
        await svc.cancelarPedido(c.id, clienteId, comoCliente(), { noHeTransferido: true });
        expect((await leer(c.id)).estado).toBe(EstadoPedido.CANCELADO);

        // El pago PENDIENTE (sin dinero) se cierra con el pedido; no queda una transferencia viva sobre un pedido cancelado.
        if (situacion === 'PENDIENTE') {
          const p = await prisma.pedidoPagoTransferencia.findFirstOrThrow({
            where: { pedidoId: c.id },
          });
          expect(p.estado).toBe(EstadoPagoTransferencia.CANCELADO);
        }
      } else {
        const err = await svc.cancelarPedido(c.id, clienteId, comoCliente()).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictException);
        // El botón dice POR QUÉ con el mismo texto que da el servidor.
        expect(err.getResponse().message).toBe(b.motivoNoPuedeCancelar);
        // Y no se movió nada.
        expect((await leer(c.id)).estado).toBe(estado);
        if (situacion !== 'sinPago') {
          const p = await prisma.pedidoPagoTransferencia.findFirstOrThrow({
            where: { pedidoId: c.id },
          });
          expect(p.estado).toBe(situacion);
        }
      }
    },
  );
});

describe('el motivo (opcional): se guarda si se dio y NO se guarda si se omite', () => {
  it('sin motivo: el pedido se cancela y no queda ninguna fila', async () => {
    const p = await pedido(EstadoPedido.REVISADO);
    await svc.cancelarPedido(p.id, clienteId, comoCliente());
    expect((await leer(p.id)).estado).toBe(EstadoPedido.CANCELADO);
    expect(await motivoGuardado(p.id)).toBeNull();
  });

  it('con un motivo de la lista: queda con su tienda, su dueño y el estado en que estaba', async () => {
    const p = await pedido(EstadoPedido.REVISADO);
    await svc.cancelarPedido(p.id, clienteId, comoCliente(), { motivo: 'TARDO_MUCHO' });
    expect(await motivoGuardado(p.id)).toMatchObject({
      pedidoId: p.id,
      tiendaId,
      usuarioId: clienteId,
      motivo: 'TARDO_MUCHO',
      detalle: null,
      estadoAlCancelar: EstadoPedido.REVISADO,
    });
  });

  it('«Otro» guarda el texto limpio', async () => {
    const p = await pedido(EstadoPedido.SOLICITADO);
    await svc.cancelarPedido(p.id, clienteId, comoCliente(), {
      motivo: 'OTRO',
      detalle: '  Me  voy de   viaje ',
    });
    expect(await motivoGuardado(p.id)).toMatchObject({
      motivo: 'OTRO',
      detalle: 'Me voy de viaje',
      estadoAlCancelar: EstadoPedido.SOLICITADO,
    });
  });

  it('un texto con un motivo que no es «Otro» es un 400 y el pedido NO se cancela', async () => {
    const p = await pedido(EstadoPedido.REVISADO);
    await expect(
      svc.cancelarPedido(p.id, clienteId, comoCliente(), { motivo: 'TARDO_MUCHO', detalle: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await leer(p.id)).estado).toBe(EstadoPedido.REVISADO);
    expect(await motivoGuardado(p.id)).toBeNull();
  });

  it('un cancelar que se rechaza (409) no deja motivo huérfano', async () => {
    const p = await pedido(EstadoPedido.EN_ATENCION);
    await expect(
      svc.cancelarPedido(p.id, clienteId, comoCliente(), { motivo: 'TARDO_MUCHO' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await motivoGuardado(p.id)).toBeNull();
  });

  it('el motivo NO llega al cliente: ni en su pedido, ni en su historial, ni en el aviso de la tienda, ni en el correo', async () => {
    const p = await pedido(EstadoPedido.REVISADO);
    await svc.cancelarPedido(p.id, clienteId, comoCliente(), {
      motivo: 'OTRO',
      detalle: 'SECRETO-DE-ANALITICA',
    });

    // Lo que lee el cliente: su pedido completo, tal como lo devuelve el servidor.
    const suPedido = await svc.obtenerMiPedido(p.id, clienteId);
    expect(JSON.stringify(suPedido)).not.toMatch(/SECRETO-DE-ANALITICA/);
    expect(suPedido).not.toHaveProperty('cancelacionCliente');
    const suLista = (await svc.obtenerMisPedidos(clienteId, 1, 200)).data.find(
      (x) => x.id === p.id,
    );
    expect(JSON.stringify(suLista)).not.toMatch(/SECRETO-DE-ANALITICA/);

    // El historial (el del personal, completo) tampoco lo lleva: dice siempre lo mismo.
    const historial = await prisma.historialPedido.findMany({ where: { pedidoId: p.id } });
    expect(JSON.stringify(historial)).not.toMatch(/SECRETO-DE-ANALITICA/);
    expect(historial.some((h) => h.observacion === 'Cancelado por el cliente')).toBe(true);

    // El correo de cancelación lee `PedidoReposicion.motivo`: es el texto fijo.
    const rep = await prisma.pedidoReposicion.findUnique({ where: { pedidoId: p.id } });
    expect(rep?.motivo).toBe('Cancelado por el cliente');

    // Y sí queda para el negocio.
    expect((await motivoGuardado(p.id))!.detalle).toBe('SECRETO-DE-ANALITICA');
  });
});

describe('cancelar cierra la propuesta que esperaba la decisión del cliente', () => {
  it('desde ESPERANDO_APROBACION la propuesta queda RECHAZADA y «Mis pedidos» deja de pintarla pendiente', async () => {
    const p = await pedido(EstadoPedido.ESPERANDO_APROBACION);
    const prop = await prisma.pedidoPropuesta.create({
      data: {
        pedidoId: p.id,
        creadaPorId: bodegueroId,
        creadaPorRol: RolUsuario.BODEGA,
        items: [],
        total: 100,
      },
    });
    const antes = (await svc.obtenerMisPedidos(clienteId, 1, 200)).data.find((x) => x.id === p.id)!;
    expect(antes.propuestas.map((x) => x.id)).toEqual([prop.id]);

    await svc.cancelarPedido(p.id, clienteId, comoCliente(), { motivo: 'CAMBIE_DE_OPINION' });

    const cerrada = await prisma.pedidoPropuesta.findUniqueOrThrow({ where: { id: prop.id } });
    expect(cerrada.estado).toBe(EstadoPropuesta.RECHAZADA);
    expect(cerrada.respondidaAt).not.toBeNull();
    // El motivo no se cuela en la nota que ve el personal en el historial de propuestas.
    expect(cerrada.notaCliente).toBeNull();

    const despues = (await svc.obtenerMisPedidos(clienteId, 1, 200)).data.find(
      (x) => x.id === p.id,
    )!;
    expect(despues.propuestas).toEqual([]);
    expect(realtime.emitToPedido).toHaveBeenCalledWith(
      p.id,
      'propuesta.respondida',
      expect.objectContaining({ propuestaId: prop.id, estado: 'RECHAZADA' }),
    );
  });

  it('una propuesta ya resuelta no se toca', async () => {
    const p = await pedido(EstadoPedido.REVISADO);
    const prop = await prisma.pedidoPropuesta.create({
      data: {
        pedidoId: p.id,
        creadaPorId: bodegueroId,
        estado: EstadoPropuesta.ACEPTADA,
        items: [],
        total: 100,
      },
    });
    await svc.cancelarPedido(p.id, clienteId, comoCliente());
    expect(
      (await prisma.pedidoPropuesta.findUniqueOrThrow({ where: { id: prop.id } })).estado,
    ).toBe(EstadoPropuesta.ACEPTADA);
    expect(realtime.emitToPedido).not.toHaveBeenCalledWith(
      p.id,
      'propuesta.respondida',
      expect.anything(),
    );
  });
});

describe('las carreras: entre que se decide y se escribe, el mundo se mueve', () => {
  /**
   * Inyecta un cambio ENTRE la decisión (que consulta los pagos) y la escritura: es la ventana real entre la lectura del
   * servicio y la transacción de la máquina de estados. El cambio se hace justo después de que la decisión leyó.
   */
  function despuesDeDecidir(accion: () => Promise<unknown>) {
    const original = prisma.pedidoPagoTransferencia.findMany.bind(prisma.pedidoPagoTransferencia);
    return jest.spyOn(prisma.pedidoPagoTransferencia, 'findMany').mockImplementationOnce(((
      args: never,
    ) =>
      (original as (a: never) => Promise<unknown>)(args).then(async (r) => {
        await accion();
        return r;
      })) as never);
  }

  afterEach(() => jest.restoreAllMocks());

  it('el operador LLAMA al cliente (EN_ATENCION) justo antes de cancelar: 409 y el pedido sigue en atención', async () => {
    const p = await pedido(EstadoPedido.REVISADO);
    despuesDeDecidir(() =>
      prisma.pedido.update({ where: { id: p.id }, data: { estado: EstadoPedido.EN_ATENCION } }),
    );

    const err = await svc.cancelarPedido(p.id, clienteId, comoCliente()).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(String(err.message)).toMatch(/cambió mientras se procesaba/i);
    expect((await leer(p.id)).estado).toBe(EstadoPedido.EN_ATENCION);
  });

  it('llega un comprobante justo antes de cancelar: 409, el pedido sigue por pagar y la transferencia queda intacta', async () => {
    const p = await pedido(EstadoPedido.PENDIENTE_PAGO);
    despuesDeDecidir(() => pago(p.id, EstadoPagoTransferencia.EN_REVISION));

    const err = await svc
      .cancelarPedido(p.id, clienteId, comoCliente(), { motivo: 'CAMBIE_DE_OPINION' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().codigo).toBe('PAGO_EN_REVISION');
    expect((await leer(p.id)).estado).toBe(EstadoPedido.PENDIENTE_PAGO);
    expect(
      (await prisma.pedidoPagoTransferencia.findFirstOrThrow({ where: { pedidoId: p.id } })).estado,
    ).toBe(EstadoPagoTransferencia.EN_REVISION);
    // La transacción se revirtió entera: ni motivo ni reposición.
    expect(await motivoGuardado(p.id)).toBeNull();
    expect(await prisma.pedidoReposicion.findUnique({ where: { pedidoId: p.id } })).toBeNull();
  });
});

describe('el pedido es del cliente que lo cancela', () => {
  it('el pedido de OTRO es un 404 (no revela ni que existe ni en qué estado está) y no se toca', async () => {
    const ajeno = await pedido(EstadoPedido.PAGADO, 'sinPago', otroClienteId);
    const err = await svc.cancelarPedido(ajeno.id, clienteId, comoCliente()).catch((e) => e);
    // Antes recibía «ya fue pagado» (409): le confirmaba que el pedido existe y que estaba pagado.
    expect(err).toBeInstanceOf(NotFoundException);
    expect((await leer(ajeno.id)).estado).toBe(EstadoPedido.PAGADO);

    const enRevision = await pedido(EstadoPedido.PENDIENTE_PAGO, 'EN_REVISION', otroClienteId);
    await expect(
      svc.cancelarPedido(enRevision.id, clienteId, comoCliente()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el motivo del pedido de otro tampoco se guarda', async () => {
    const ajeno = await pedido(EstadoPedido.REVISADO, 'sinPago', otroClienteId);
    await svc
      .cancelarPedido(ajeno.id, clienteId, comoCliente(), { motivo: 'OTRO', detalle: 'x' })
      .catch(() => undefined);
    expect(await motivoGuardado(ajeno.id)).toBeNull();
  });
});

describe('domicilio: no hay mostrador al que mandarlo', () => {
  it('un domicilio ya enviado se manda a hablar con la tienda', async () => {
    const p = await pedido(EstadoPedido.ENVIADO, 'sinPago', clienteId, ModoEntrega.DOMICILIO);
    const d = await svc.obtenerMiPedido(p.id, clienteId);
    expect(d.puedeCancelar).toBe(false);
    expect(d.motivoNoPuedeCancelar).toMatch(/comunícate con la tienda/i);
    expect(d.motivoNoPuedeCancelar).not.toMatch(/mostrador/i);
  });
});
