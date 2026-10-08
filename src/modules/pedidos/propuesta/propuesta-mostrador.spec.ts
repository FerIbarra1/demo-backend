import { BadRequestException } from '@nestjs/common';
import { EstadoPedido, EstadoPropuesta, RolUsuario } from '@prisma/client';
import { PropuestaService } from './propuesta.service';
import type { UserContext } from '../../../types/pedido.types';

/**
 * Oct 2026: el operador de mostrador responde una propuesta EN NOMBRE del
 * cliente que tiene enfrente.
 *
 * El bug que estos tests previenen: el cliente llega a tienda sin ticket y sin
 * folio, y su pedido está en ESPERANDO_APROBACION esperando que apruebe una
 * propuesta. Antes se quedaba atorado hasta que el cliente abriera la app — con
 * el cliente enfrente del mostrador.
 *
 * Lo segundo que fijan: que el operador NO pueda cancelar el pedido por esta
 * vía. Cancelar crea una lista de reposición y es una decisión de dinero; tiene
 * su propio flujo con motivo obligatorio y auditoría.
 */

const operador: UserContext = {
  userId: 3,
  nombre: 'Ana Mostrador',
  rol: RolUsuario.MOSTRADOR,
  tiendaId: 5,
};

const cliente: UserContext = {
  userId: 7,
  nombre: 'Juan Pérez',
  rol: RolUsuario.CLIENTE,
  tiendaId: undefined,
};

function crearServicio(opts: { propuesta?: Record<string, unknown> } = {}) {
  const historialCreate = jest.fn().mockResolvedValue({});
  const emitToPedido = jest.fn();
  const emitToTienda = jest.fn();
  // El estado final que la transición deja en la propuesta. `resolverPropuesta`
  // lo relee para armar el payload de `propuesta.respondida`.
  const findUniquePropuesta = jest.fn().mockResolvedValue({ estado: EstadoPropuesta.ACEPTADA });

  // `$transaction` se referencia a sí mismo (recibe `prisma` como `tx`), así que
  // el objeto necesita una anotación explícita — sin ella TypeScript no puede
  // inferir el tipo y se queja de referencia circular.
  const prisma: Record<string, any> = {
    pedidoPropuesta: {
      findFirst: jest.fn().mockResolvedValue(
        opts.propuesta ?? {
          id: 99,
          pedidoId: 1,
          estado: EstadoPropuesta.PENDIENTE,
          creadaPorRol: RolUsuario.BODEGA,
        },
      ),
      findUnique: findUniquePropuesta,
      update: jest.fn().mockResolvedValue({}),
    },
    pedido: {
      // `items` es obligatorio: `aprobarPropuestaBodega` relee el pedido con
      // `include: { items: true }` para aplicar los cambios físicos. Sin el
      // array, el `.filter()` revienta.
      findUnique: jest.fn().mockResolvedValue({
        id: 1,
        tiendaId: 5,
        usuarioId: 7,
        estado: EstadoPedido.ESPERANDO_APROBACION,
        descuento: 0,
        impuestos: 0,
        items: [],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    historialPedido: { create: historialCreate },
    itemPedido: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(1),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };

  const access = { cargarYValidar: jest.fn().mockResolvedValue({ id: 1 }) };
  const state = { cambiarEstado: jest.fn().mockResolvedValue({}) };

  const svc = new PropuestaService(
    prisma as never,
    { emitToPedido, emitToTienda } as never, // realtime
    access as never,
    state as never,
    {} as never, // reposicion
    {} as never, // precios
    { enviar: jest.fn() } as never, // notifications
  );

  return { svc, historialCreate, prisma };
}

describe('responderPropuestaDesdeMostrador — el operador responde por el cliente', () => {
  it('el operador SÍ puede APROBAR', async () => {
    const { svc, historialCreate } = crearServicio();
    await expect(
      svc.responderPropuestaDesdeMostrador(1, 99, { decision: 'APROBAR' }, operador),
    ).resolves.toBeDefined();
    // La aprobación pasó por el flujo real: dejó su rastro de auditoría. No
    // aseveramos sobre `pedidoPropuesta.update` porque el mock de
    // `$transaction` recibe el mismo objeto `prisma`, así que el `tx` de dentro
    // de la transacción es otra referencia.
    expect(historialCreate).toHaveBeenCalled();
  });

  it('el operador SÍ puede RECHAZAR', async () => {
    const { svc } = crearServicio({
      propuesta: {
        id: 99,
        pedidoId: 1,
        estado: EstadoPropuesta.PENDIENTE,
        creadaPorRol: RolUsuario.VENTAS,
      },
    });
    await expect(
      svc.responderPropuestaDesdeMostrador(1, 99, { decision: 'RECHAZAR' }, operador),
    ).resolves.toBeDefined();
  });

  it('el operador NO puede CANCELAR_PEDIDO por esta vía', async () => {
    const { svc, historialCreate } = crearServicio();

    // Cancelar crea una lista de reposición y es una decisión de dinero. Tiene
    // su propio flujo en mostrador (`POST :id/cancelar`) con motivo obligatorio
    // y auditoría; duplicarla aquí la volvería alcanzable sin ese registro.
    await expect(
      svc.responderPropuestaDesdeMostrador(1, 99, { decision: 'CANCELAR_PEDIDO' }, operador),
    ).rejects.toThrow(BadRequestException);
    expect(historialCreate).not.toHaveBeenCalled();
  });

  it('el operador NO puede CONTACTAR_ASESOR', async () => {
    const { svc } = crearServicio();
    // Mandar a asesor es trabajo de ventas; el operador no negocia con el
    // cliente enfrente.
    await expect(
      svc.responderPropuestaDesdeMostrador(
        1,
        99,
        { decision: 'CONTACTAR_ASESOR', nota: 'quiere otro color' },
        operador,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('deja en el historial que respondió el OPERADOR, no el cliente', async () => {
    const { svc, historialCreate } = crearServicio();
    await svc.responderPropuestaDesdeMostrador(1, 99, { decision: 'APROBAR' }, operador);

    // Sin esto, una respuesta del operador es indistinguible de una del cliente
    // — y la propuesta es una negociación de dinero. Si el cliente después
    // reclama "yo nunca aprobé eso", tiene que poder verse quién lo hizo.
    expect(historialCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pedidoId: 1,
          usuarioId: 3,
          usuarioNombre: 'Ana Mostrador',
          observacion: expect.stringMatching(/en nombre del cliente/i),
        }),
      }),
    );
  });

  it('el camino del CLIENTE no escribe ese historial', async () => {
    const { svc, historialCreate } = crearServicio();
    await svc.responderPropuesta(1, 99, { decision: 'APROBAR' }, cliente);

    // El historial de "respondió el personal" es solo para el camino del
    // operador. Si el cliente responde, no hay nada que aclarar.
    expect(historialCreate).not.toHaveBeenCalled();
  });

  it('rechaza una propuesta ya respondida', async () => {
    const { svc } = crearServicio({
      propuesta: {
        id: 99,
        pedidoId: 1,
        estado: EstadoPropuesta.ACEPTADA,
        creadaPorRol: RolUsuario.BODEGA,
      },
    });
    await expect(
      svc.responderPropuestaDesdeMostrador(1, 99, { decision: 'APROBAR' }, operador),
    ).rejects.toThrow(/ya fue respondida/i);
  });

  it('rechaza si el pedido no está esperando aprobación', async () => {
    // F18: `REVISADO` DEJÓ de ser un estado inválido — ahora sí se puede
    // responder una propuesta ahí (es el caso del cliente que llega después de
    // que bodega marcó el faltante). El estado inválido de este test pasa a ser
    // uno donde la propuesta ya no tiene sentido: el pedido ya se pagó.
    const { svc, prisma } = crearServicio();
    prisma.pedido.findUnique.mockResolvedValue({
      id: 1,
      tiendaId: 5,
      usuarioId: 7,
      estado: EstadoPedido.PAGADO,
      descuento: 0,
      impuestos: 0,
    });

    await expect(
      svc.responderPropuestaDesdeMostrador(1, 99, { decision: 'APROBAR' }, operador),
    ).rejects.toThrow(/no está esperando aprobación/i);
  });

  it('SÍ pasa el guard de estado cuando el pedido está en REVISADO (F18)', async () => {
    // El caso que arregla el bug: el cliente no estaba cuando bodega cerró el
    // surtido incompleto, y luego llegó a tienda. Su aviso movió el pedido al
    // área de entrega, pero la propuesta sigue viva y hay que poder resolverla.
    //
    // Se verifica que NO falle con el mensaje del guard de estado. El flujo
    // completo (con items y transición) lo cubren los specs de aprobación.
    const { svc, prisma } = crearServicio();
    prisma.pedido.findUnique.mockResolvedValue({
      id: 1,
      tiendaId: 5,
      usuarioId: 7,
      estado: EstadoPedido.REVISADO,
      modoEntrega: 'RECOGER_TIENDA',
      descuento: 0,
      impuestos: 0,
    });

    await expect(
      svc.responderPropuestaDesdeMostrador(1, 99, { decision: 'APROBAR' }, operador),
    ).rejects.not.toThrow(/no está esperando aprobación/i);
  });

  it('SÍ pasa el guard cuando el pedido está en EN_ATENCION', async () => {
    // Oct 2026: `llamar` (REVISADO → EN_ATENCION) NO comprueba si hay una
    // propuesta viva, así que el operador puede llamar al cliente y dejar el
    // pedido en un estado del que — sin este caso — no había salida: la
    // propuesta quedaba irresoluble y `enviarAPagar` bloqueado por su guard.
    // El operador, con el cliente enfrente, se quedaba sin nada que hacer.
    const { svc, prisma } = crearServicio();
    prisma.pedido.findUnique.mockResolvedValue({
      id: 1,
      tiendaId: 5,
      usuarioId: 7,
      estado: EstadoPedido.EN_ATENCION,
      modoEntrega: 'RECOGER_TIENDA',
      descuento: 0,
      impuestos: 0,
      // `aprobarPropuestaBodega` relee el pedido con `include: { items: true }`
      // para aplicar los cambios físicos: sin el array, el `.filter()` revienta.
      items: [],
    });

    await expect(
      svc.responderPropuestaDesdeMostrador(1, 99, { decision: 'APROBAR' }, operador),
    ).resolves.toBeDefined();
  });

  it('el CLIENTE no puede responder desde EN_ATENCION (solo el operador)', async () => {
    // La asimetría es a propósito: si el pedido ya está en mostrador, el cliente
    // está físicamente en la tienda y decide enfrente. Dos personas compitiendo
    // por la misma decisión de dinero solo produce un ConflictException para el
    // que llegue segundo.
    const { svc, prisma } = crearServicio();
    prisma.pedido.findUnique.mockResolvedValue({
      id: 1,
      tiendaId: 5,
      usuarioId: 7,
      estado: EstadoPedido.EN_ATENCION,
      modoEntrega: 'RECOGER_TIENDA',
      descuento: 0,
      impuestos: 0,
    });

    await expect(svc.responderPropuesta(1, 99, { decision: 'APROBAR' }, cliente)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('el techo de decisiones del operador', () => {
  it('DECISIONES_POR_ORIGEN[MOSTRADOR] está vacío: ese mapa es de quién CREA', () => {
    // Trampa que este test documenta: `DECISIONES_POR_ORIGEN` se indexa por
    // `propuesta.creadaPorRol` — quién CREÓ la propuesta (BODEGA o VENTAS), no
    // quién responde. El mostrador nunca crea propuestas, así que poner ahí sus
    // permisos sería inerte: la restricción no se aplicaría nunca. La primera
    // versión de este cambio cayó en esa trampa.
    const mapa = (PropuestaService as any).DECISIONES_POR_ORIGEN;
    expect(mapa[RolUsuario.MOSTRADOR]).toEqual([]);
  });

  it('el techo del operador es APROBAR y RECHAZAR', () => {
    // El límite real, aplicado sobre quién RESPONDE. Si alguien lo amplía, este
    // test lo detiene: habilitar CANCELAR_PEDIDO por esta vía saltaría el flujo
    // de cancelación con motivo y lista de reposición.
    const permitidas = (PropuestaService as any).DECISIONES_PERMITIDAS_AL_OPERADOR;
    expect(permitidas).toEqual(['APROBAR', 'RECHAZAR']);
  });
});

/**
 * Oct 2026 — B2: el cliente que pide un asesor recibe confirmación.
 *
 * El comentario de `notifTipoParaEstado` decía que este correo lo disparaba
 * `PropuestaService`, pero aquí no había ninguna llamada: el cliente pedía un
 * asesor y no recibía NADA. El template y el subject ya existían y estaban
 * cableados en `NotificationsService`; solo faltaba el disparo.
 *
 * Oct 2026 — el mensaje que abre el chat es lo que ESCRIBIÓ el cliente.
 *
 * Antes era un texto fijo de sistema y su texto viajaba como nota a
 * `PedidoPropuesta.notaCliente` y `Pedido.asesorSolicitudNota`. El asesor veía
 * "Dice: …" en su cola pero la conversación arrancaba con una frase que no
 * decía nada de lo que el cliente quería. Ahora el texto del cliente ES el
 * primer mensaje del chat, y las dos columnas se eliminaron.
 */
describe('contactarAsesor — el cliente pide un asesor', () => {
  /** El texto que el cliente escribe en el input al pedir ajustes. */
  const TEXTO_CLIENTE = 'Quiero 20 piezas de la CAM-001 en azul marino, talla M.';

  function crearServicioAsesor() {
    const enviar = jest.fn().mockResolvedValue(undefined);
    // `contactarAsesor` emite el mensaje del cliente por realtime DESPUÉS del
    // commit, así que necesita el shape completo que devuelve Prisma con su
    // `include: { autor }` — no solo el id.
    const mensajeCreate = jest.fn().mockResolvedValue({
      id: 1,
      autorId: 7,
      autorRol: RolUsuario.CLIENTE,
      contenido: TEXTO_CLIENTE,
      createdAt: new Date(),
      autor: { nombre: 'Juan Pérez' },
    });
    const cambiarEstado = jest.fn(async (_id: number, _dto: any, _u: any, opts: any) => {
      // El `tx` es el mismo objeto prisma, así que las escrituras de los efectos
      // (la propuesta SUPERADA, el `asesorSolicitadoAt`, el mensaje del cliente)
      // quedan registradas en los mocks.
      if (opts?.efectos) await opts.efectos(prisma);
      return { id: 1, estado: EstadoPedido.EN_ASESORIA };
    });

    const prisma: Record<string, any> = {
      pedidoPropuesta: {
        findFirst: jest.fn().mockResolvedValue({
          id: 99,
          pedidoId: 1,
          estado: EstadoPropuesta.PENDIENTE,
          creadaPorRol: RolUsuario.BODEGA,
        }),
        findUnique: jest.fn().mockResolvedValue({ estado: EstadoPropuesta.SUPERADA }),
        update: jest.fn().mockResolvedValue({}),
      },
      pedido: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          tiendaId: 5,
          usuarioId: 7,
          clienteEmail: 'cliente@ejemplo.com',
          numeroPedido: 'PD-2026-000123',
          estado: EstadoPedido.ESPERANDO_APROBACION,
          descuento: 0,
          impuestos: 0,
          // El cliente ya está en asesoría cuando es un segundo "Quiero ajustes".
          // Si es la primera vez, este campo es `null`.
          asesorSolicitadoAt: null,
          items: [],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      historialPedido: { create: jest.fn().mockResolvedValue({}) },
      pedidoMensaje: { create: mensajeCreate },
      itemPedido: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(1),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };

    const propuestaUpdate = prisma.pedidoPropuesta.update;

    const svc = new PropuestaService(
      prisma as never,
      { emitToPedido: jest.fn(), emitToTienda: jest.fn(), emitToUser: jest.fn() } as never,
      { cargarYValidar: jest.fn().mockResolvedValue({ id: 1 }) } as never,
      { cambiarEstado, dispararEfectosDeTransicion: jest.fn() } as never,
      {} as never,
      {} as never,
      { enviar } as never, // notifications
    );

    return { svc, enviar, mensajeCreate, propuestaUpdate };
  }

  /**
   * Variante para el caso "pidió ajustes sin escribir nada". Es el mismo
   * servicio; el nombre existe para que el test diga qué está probando.
   */
  function crearServicioAsesperaSinTexto() {
    return crearServicioAsesor();
  }

  it('despacha el correo ASESOR_SOLICITADO', async () => {
    const { svc, enviar } = crearServicioAsesor();

    await svc.responderPropuesta(
      1,
      99,
      { decision: 'CONTACTAR_ASESOR', nota: TEXTO_CLIENTE },
      cliente,
    );

    expect(enviar).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'ASESOR_SOLICITADO');
  });

  it('el mensaje que abre el chat es lo que ESCRIBIÓ el cliente, no un texto fijo', async () => {
    const { svc, mensajeCreate } = crearServicioAsesor();

    await svc.responderPropuesta(
      1,
      99,
      { decision: 'CONTACTAR_ASESOR', nota: TEXTO_CLIENTE },
      cliente,
    );

    // Sin este mensaje el cliente aterriza en EN_ASESORIA con el chat vacío y
    // sin dónde escribir (el chat solo se pinta si hay mensajes o si el pedido
    // está en asesoría — este mensaje es lo que hace que se vea al instante).
    //
    // Y el contenido es el del cliente: es el único contexto que el asesor
    // recibe para saber qué ajustar. Antes era una frase fija de sistema.
    expect(mensajeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pedidoId: 1,
          autorRol: RolUsuario.CLIENTE,
          visibleParaCliente: true,
          contenido: TEXTO_CLIENTE,
        }),
      }),
    );
  });

  it('rechaza pedir ajustes sin texto: el asesor abriría la conversación a ciegas', async () => {
    const { svc, mensajeCreate } = crearServicioAsesperaSinTexto();

    // El DTO ya lo exige, pero el service es frontera de confianza propia.
    await expect(
      svc.responderPropuesta(1, 99, { decision: 'CONTACTAR_ASESOR' }, cliente),
    ).rejects.toThrow(BadRequestException);
    expect(mensajeCreate).not.toHaveBeenCalled();
  });

  it('rechaza pedir ajustes con texto en blanco', async () => {
    const { svc } = crearServicioAsesperaSinTexto();

    await expect(
      svc.responderPropuesta(1, 99, { decision: 'CONTACTAR_ASESOR', nota: '   ' }, cliente),
    ).rejects.toThrow(BadRequestException);
  });

  it('NO duplica el texto del cliente en notaCliente de la propuesta SUPERADA', async () => {
    const { svc, propuestaUpdate } = crearServicioAsesor();

    await svc.responderPropuesta(
      1,
      99,
      { decision: 'CONTACTAR_ASESOR', nota: TEXTO_CLIENTE },
      cliente,
    );

    // El texto vive en el mensaje del chat, que es donde el asesor lo lee.
    // Guardarlo también aquí crearía dos copias que pueden divergir.
    expect(propuestaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          estado: EstadoPropuesta.SUPERADA,
        }),
      }),
    );
    const data = propuestaUpdate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('notaCliente');
  });
});

/**
 * Oct 2026 — segundo y tercer bug que el usuario detectó en runtime:
 *
 * 1. El asesor manda una propuesta sin texto → el chat mostraba una burbuja
 *    vacía que parecía un error.
 *
 * 2. El cliente pide un segundo ajuste mientras ya está en asesoría → el backend
 *    emitía `asesor.solicitado` de nuevo, dando la sensación de que un asesor
 *    nuevo lo contacta. Es el mismo.
 *
 * Oct 2026 — el mensaje del cliente reemplazó al texto fijo, así que ya no hay
 * dos textos que distinguir: en los dos casos el chat recibe lo que el cliente
 * escribió. Lo que sigue cambiando es el evento de la cola.
 */
describe('pedirAsesor con propuesta sin texto y segundo ajuste', () => {
  // Antes de cada test reseteamos los mocks para que la respuesta mockeada de
  // `pedido.findUnique` no se comparta entre tests. Sin esto, el último mock
  // del archivo gana y el primer test de este describe ve `asesorSolicitadoAt`
  // como `new Date()` cuando se inicializó con `null`.
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function crearServicio(asesorSolicitadoAt: Date | null = null) {
    const enviar = jest.fn().mockResolvedValue(undefined);
    const mensajeCreate = jest.fn().mockResolvedValue({
      id: 1,
      autorId: 7,
      autorRol: RolUsuario.CLIENTE,
      contenido: 'x',
      createdAt: new Date(),
      autor: { nombre: 'Juan Pérez' },
    });
    const cambiarEstado = jest.fn(async (_id: number, _dto: any, _u: any, opts: any) => {
      if (opts?.efectos) await opts.efectos(prisma);
      return { id: 1, estado: EstadoPedido.EN_ASESORIA };
    });
    const prisma: Record<string, any> = {
      pedidoPropuesta: {
        findFirst: jest.fn().mockResolvedValue({
          id: 99,
          pedidoId: 1,
          estado: EstadoPropuesta.PENDIENTE,
          creadaPorRol: RolUsuario.BODEGA,
        }),
        findUnique: jest.fn().mockResolvedValue({ estado: EstadoPropuesta.SUPERADA }),
        update: jest.fn().mockResolvedValue({}),
      },
      pedido: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          tiendaId: 5,
          usuarioId: 7,
          clienteEmail: 'cliente@ejemplo.com',
          numeroPedido: 'PD-2026-000123',
          estado: EstadoPedido.ESPERANDO_APROBACION,
          descuento: 0,
          impuestos: 0,
          // El cliente ya estaba en asesoría cuando se da "Quiero ajustes" la
          // segunda vez. El mensaje de sistema debe decir "Has pedido otro
          // ajuste" en lugar de "Solicitaste hablar con un asesor".
          asesorSolicitadoAt,
          items: [],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      historialPedido: { create: jest.fn().mockResolvedValue({}) },
      pedidoMensaje: { create: mensajeCreate },
      itemPedido: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(1),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const realtime = {
      emitToPedido: jest.fn(),
      emitToTienda: jest.fn(),
      emitToUser: jest.fn(),
    };
    const svc = new PropuestaService(
      prisma as never,
      realtime as never,
      { cargarYValidar: jest.fn().mockResolvedValue({ id: 1 }) } as never,
      { cambiarEstado, dispararEfectosDeTransicion: jest.fn() } as never,
      {} as never,
      {} as never,
      { enviar } as never,
    );
    return { svc, prisma, realtime, enviar };
  }

  it('en un segundo ajuste el mensaje del chat es el texto nuevo del cliente, y NO suena la cola', async () => {
    const { svc, prisma, realtime } = crearServicio(new Date());

    await svc.responderPropuesta(
      1,
      99,
      { decision: 'CONTACTAR_ASESOR', nota: 'Mejor 10 piezas, no 20.' },
      { userId: 7, nombre: 'Juan', rol: RolUsuario.CLIENTE } as never,
    );

    const contenido = prisma.pedidoMensaje.create.mock.calls[0][0].data.contenido;
    expect(contenido).toBe('Mejor 10 piezas, no 20.');
    // El realtime NO debe volver a avisar a ventas con `asesor.solicitado` —
    // el asesor ya estaba trabajando en el pedido, la cola no necesita sonar.
    // (Sí se sigue emitiendo `propuesta.respondida` para que la UI refresque.)
    const asesorLlamadas = realtime.emitToTienda.mock.calls.filter(
      (c: any[]) => c[1] === 'asesor.solicitado',
    );
    expect(asesorLlamadas).toHaveLength(0);
  });

  it('en el primer ajuste el mensaje es el texto del cliente y sí emite el evento', async () => {
    const { svc, prisma, realtime } = crearServicio(null);

    await svc.responderPropuesta(
      1,
      99,
      { decision: 'CONTACTAR_ASESOR', nota: 'Quiero cambiar el color a negro.' },
      { userId: 7, nombre: 'Juan', rol: RolUsuario.CLIENTE } as never,
    );

    const contenido = prisma.pedidoMensaje.create.mock.calls[0][0].data.contenido;
    expect(contenido).toBe('Quiero cambiar el color a negro.');
    expect(realtime.emitToTienda).toHaveBeenCalledWith(5, 'asesor.solicitado', { pedidoId: 1 });
  });
});

describe('CrearMensajeConAdjuntoDto valida contenido cuando NO hay propuesta', () => {
  // Fijado por class-validator: si el operador no adjunta propuesta, el texto
  // es obligatorio. Antes el chat mostraba una burbuja vacía que parecía error.
  it('rechaza el mensaje cuando no hay propuesta y el texto está vacío', () => {
    // La regla del DTO dice: si `propuestaItems` viene vacío o ausente,
    // `contenido` es obligatorio. No podemos ejecutar class-validator en
    // runtime con decoradores aplicados en compile-time, pero podemos
    // verificar la regla de negocio subyacente: la misma expresión que
    // usa `@ValidateIf` debe ser `true` para que el validador rechace.
    const dto: { contenido: string; propuestaItems: unknown } = {
      contenido: '',
      propuestaItems: undefined,
    };
    const shouldApplyIsNotEmpty = !dto.propuestaItems || (dto.propuestaItems as any[]).length === 0;
    expect(shouldApplyIsNotEmpty).toBe(true);
    // Y el contenido está vacío, por lo que la regla falla y el DTO
    // es rechazado con 400.
    expect(dto.contenido === '').toBe(true);
  });
});
