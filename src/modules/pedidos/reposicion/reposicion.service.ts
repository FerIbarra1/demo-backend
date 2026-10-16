import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { UserContext } from '../../../types/pedido.types';
import { EstadoReposicion, Prisma } from '@prisma/client';
import { piezasEnLaBolsa } from '../core/ajuste-cantidad.util';

/**
 * Una línea de `PedidoReposicion.items` (snapshot JSON, una por `ItemPedido`).
 */
interface EntradaReposicion {
  id: number;
  productoNombre: string;
  productoCodigo: string;
  corridaNombre: string;
  tallaNombre: string;
  colorNombre: string;
  /** Piezas que tienen que volver al anaquel. */
  cantidad: number;
  cantidadSurtida: number;
  estadoSurtido: string;
  /**
   * Esta entrada incluye lo que quedaba en la bolsa al CANCELAR. Es la marca que
   * hace idempotente a `crearDesdePedido` ahora que ya no sale temprano cuando la
   * fila existe: sin ella, un segundo rechazo sumaría la bolsa otra vez.
   */
  deCancelacion?: boolean;
}

function itemsDeFila(json: Prisma.JsonValue): EntradaReposicion[] {
  return Array.isArray(json) ? (json as unknown as EntradaReposicion[]) : [];
}

/** Suma por línea: una `ItemPedido` es UNA entrada aunque llegue por dos caminos. */
function sumarEntradas(
  base: EntradaReposicion[],
  nuevas: EntradaReposicion[],
): EntradaReposicion[] {
  const resultado = base.map((e) => ({ ...e }));
  for (const n of nuevas) {
    const previa = resultado.find((e) => e.id === n.id);
    if (previa) {
      previa.cantidad += n.cantidad;
      if (n.deCancelacion) previa.deCancelacion = true;
    } else {
      resultado.push({ ...n });
    }
  }
  return resultado;
}

/**
 * F13 (sep 2026): lista de reposición de bodega.
 *
 * Cuando el cliente RECHAZA una propuesta (o cancela durante la asesoría), el
 * pedido se cancela y los productos que bodega ya había apartado tienen que
 * volver físicamente al anaquel.
 *
 * IMPORTANTE: esto NO es un contador de inventario. El modelo B2B no maneja
 * stock (el modelo `Stock` se eliminó en el refactor B2B — ver el comentario
 * sobre `PrecioCO` en el schema). Es una lista de trabajo con confirmación
 * humana: bodega ve qué reponer y marca cuando ya volvió al anaquel.
 *
 * 1:1 con Pedido. Solo se crea al cancelar por rechazo del cliente; una
 * cancelación que viene de Firebird (SWCANCEL) no la crea, porque en ese caso
 * el ERP ya sabe que el pedido murió.
 *
 * Y SOLO DE LO QUE YA SALIÓ DE LAS MANOS DE BODEGA (oct 2026). Si el pedido se
 * cancela mientras bodega lo tiene (sin surtir o a medias), el bodeguero lo trae
 * en las manos, recibe el aviso de cancelación (`pedido.cancelado-en-bodega`) y
 * lo regresa al anaquel él mismo: no hay lista. Ver `bolsaEnManosDeBodega`.
 *
 * CUÁNDO HAY REPOSICIÓN (oct 2026). Hay UNA regla: la lista es de la mercancía que
 * ya salió de la bolsa y NADIE va a regresar al anaquel durante otra tarea.
 *
 *   - Un pedido CANCELADO o rechazado (`crearDesdePedido`): lo que sigue en la bolsa.
 *   - Un ajuste de MOSTRADOR que QUITA piezas (`registrarQuitadasEnMostrador`): las
 *     saca el operador enfrente del cliente y el pedido no pasa por bodega.
 *
 * Un ajuste de VENTAS, en cambio, no genera reposición: el pedido vuelve a bodega y
 * el bodeguero saca las piezas de la bolsa y las regresa él mismo con el checklist
 * de retiro. F17 hacía las dos cosas (`crearDesdeAjuste`) y el bodeguero acomodaba
 * la misma mercancía dos veces; ese método se eliminó y su nombre está prohibido
 * por spec. La diferencia con el de mostrador no es el rol, es quién regresa las
 * prendas al anaquel.
 */
@Injectable()
export class ReposicionService {
  private readonly logger = new Logger(ReposicionService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
  ) {}

  /**
   * Crea la entrada de reposición para un pedido cancelado. Se llama DENTRO
   * de la transacción que cancela el pedido, para que cancelación y lista sean
   * atómicas.
   *
   * Idempotente: una segunda llamada para el mismo pedido no suma la bolsa otra vez
   * (un segundo rechazo no debería duplicar la lista). Si la fila ya existe porque
   * el operador quitó piezas en mostrador, la cancelación se FUSIONA en ella en vez
   * de salir temprano: antes `if (existente) return` dejaba la bolsa restante sin
   * volver nunca al anaquel.
   *
   * Solo entran las piezas que HAY en la bolsa del área de entrega
   * (`cantidadSurtida − piezasRetiradas`). Quedan fuera:
   *
   *   - lo que nadie ha surtido (`cantidadSurtida: 0`): no hay nada que devolver.
   *     Antes el código caía a `cantidad` (lo PEDIDO) y un pedido cancelado en
   *     SOLICITADO mandaba a bodega a "reponer" mercancía que jamás salió del
   *     anaquel;
   *   - lo que un ajuste anterior ya sacó: el bodeguero lo regresó él mismo.
   *
   * `opts.bolsaEnManosDeBodega`: el pedido se cancela mientras bodega lo tiene
   * (ver `bolsaEnManosDeBodega`). No hay nada que listar — el bodeguero lo trae en
   * las manos y lo regresa solo — pero la fila SE CREA igual, ya resuelta
   * (`REPUESTO`, sin piezas): `motivo` no es solo del piso, `NotificationsService`
   * lo lee como `motivoCancelacion` para el correo de cancelación, así que omitir
   * la fila le quitaría al cliente la razón. Resuelta, no aparece en la lista
   * pendiente ni en el contador.
   */
  async crearDesdePedido(
    tx: Prisma.TransactionClient,
    pedidoId: number,
    motivo?: string,
    opts: { bolsaEnManosDeBodega?: boolean } = {},
  ): Promise<void> {
    const existente = await tx.pedidoReposicion.findUnique({ where: { pedidoId } });
    // Idempotente: la cancelación ya se fusionó en esta fila (ver `deCancelacion`).
    if (existente && itemsDeFila(existente.items).some((i) => i.deCancelacion)) return;

    // Snapshot de los items que bodega había apartado. Se guarda como JSON
    // para que la lista no cambie aunque el pedido se modifique después.
    //
    // F18 (oct 2026): se incluyen TAMBIÉN los cancelados que sí tenían piezas
    // apartadas. Antes se filtraba `cancelada: false`, así que los items que
    // bodega marcó `NO_DISPONIBLE` al cerrar el surtido **nunca entraban a la
    // lista** — esa mercancía no volvía al anaquel por ningún camino.
    const items = opts.bolsaEnManosDeBodega
      ? []
      : await tx.itemPedido.findMany({
          where: { pedidoId, cantidadSurtida: { gt: 0 } },
          select: {
            id: true,
            productoNombre: true,
            productoCodigo: true,
            corridaNombre: true,
            tallaNombre: true,
            colorNombre: true,
            cantidad: true,
            cantidadSurtida: true,
            piezasRetiradas: true,
            estadoSurtido: true,
          },
          orderBy: { id: 'asc' },
        });

    // `cantidad` se NORMALIZA a lo que de verdad está en la bolsa, que es lo
    // único que puede volver al anaquel.
    //
    // F21 (oct 2026): antes guardaba el item crudo, así que un pedido colapsado
    // (20 pedidas, 10 apartadas) le pedía a bodega reponer 20 piezas de las que
    // solo salieron 10.
    //
    // Oct 2026 (ajustes): además se DESCUENTA lo que el bodeguero ya sacó en un
    // ajuste anterior (`piezasRetiradas`). Esas piezas ya las regresó él al
    // anaquel; sin descontarlas, un pedido ajustado que luego se cancela las
    // listaba otra vez — el mismo "ya lo acomodé y me vuelve a salir", ahora por
    // la puerta de la cancelación. Una línea que se quitó en un ajuste y cuyas
    // piezas ya se sacaron queda en 0 y no entra a la lista.
    const aReponer: EntradaReposicion[] = items
      .map(({ piezasRetiradas, ...i }) => ({
        ...i,
        cantidad: piezasEnLaBolsa({ ...i, piezasRetiradas }),
        deCancelacion: true,
      }))
      .filter((i) => i.cantidad > 0);

    // Ya hay fila: el operador de mostrador quitó piezas antes de que se cancelara
    // (`registrarQuitadasEnMostrador`). Se FUSIONA en vez de salir: lo que quedó en
    // la bolsa también tiene que volver al anaquel, y `pedidoId` es único, así que
    // no hay una segunda fila donde ponerlo. `motivo` se pisa aquí porque es el
    // motivo del correo de cancelación.
    if (existente) {
      await this.fusionarEnFila(tx, existente, aReponer, { motivo });
      this.logger.log(
        `Pedido ${pedidoId}: cancelación fusionada en la reposición existente (${aReponer.length} item(s))`,
      );
      return;
    }

    // Sin nada que devolver la fila nace resuelta: ver el comentario del método.
    const hayQueReponer = aReponer.length > 0;
    await tx.pedidoReposicion.create({
      data: {
        pedidoId,
        estado: hayQueReponer ? EstadoReposicion.PENDIENTE : EstadoReposicion.REPUESTO,
        repuestoAt: hayQueReponer ? null : new Date(),
        items: aReponer as unknown as Prisma.InputJsonValue,
        motivo: motivo ?? null,
      },
    });

    this.logger.log(
      hayQueReponer
        ? `Pedido ${pedidoId}: entrada de reposición creada (${aReponer.length} item(s))`
        : `Pedido ${pedidoId}: nada que reponer (${
            opts.bolsaEnManosDeBodega ? 'bodega lo tiene en las manos' : 'sin piezas en la bolsa'
          })`,
    );
  }

  /**
   * Oct 2026 (propuestas, decisión 4): el operador de mostrador QUITÓ piezas en un
   * ajuste y esas piezas pasan a reposición.
   *
   * El cliente está enfrente y el operador saca las prendas de la bolsa él mismo;
   * lo que queda es devolverlas al anaquel, que es trabajo de bodega. El pedido NO
   * viaja a bodega a "re-surtirse" por eso (ver `MostradorService.ajustar`).
   *
   * NO se llama `crearDesdeAjuste` a propósito: ese era el método de F17, que
   * listaba las prendas que el BODEGUERO ya había sacado y regresado durante el
   * checklist de retiro — el "ya lo acomodé y me vuelve a salir" — y
   * `cancelacion-reposicion.spec` falla si el nombre reaparece. Esto es otra cosa:
   * aquí las saca el operador, nadie las regresa al anaquel, y por eso SÍ van a la
   * lista. Quien llama también suma `piezasRetiradas` para que el checklist de
   * bodega no vuelva a pedir sacarlas.
   *
   * `pedidoId` es único, así que esto convive con la fila de una cancelación
   * posterior: si la fila ya existe, se suma a ella; si ya estaba `REPUESTO`, se
   * reabre con SOLO lo nuevo (lo anterior ya volvió al anaquel y no se vuelve a
   * pedir). `motivo` no se toca: es el texto del correo de cancelación y un ajuste
   * no cancela nada.
   *
   * Va DENTRO de la transacción del ajuste: o quedan el ajuste y la lista, o ninguno.
   */
  async registrarQuitadasEnMostrador(
    tx: Prisma.TransactionClient,
    pedidoId: number,
    quitadas: Array<{ itemId: number; cantidad: number }>,
  ): Promise<void> {
    const validas = quitadas.filter((q) => q.cantidad > 0);
    if (validas.length === 0) return;

    const filas = await tx.itemPedido.findMany({
      where: { pedidoId, id: { in: validas.map((q) => q.itemId) } },
      select: {
        id: true,
        productoNombre: true,
        productoCodigo: true,
        corridaNombre: true,
        tallaNombre: true,
        colorNombre: true,
        cantidadSurtida: true,
        estadoSurtido: true,
      },
      orderBy: { id: 'asc' },
    });

    const nuevas: EntradaReposicion[] = filas.map((f) => ({
      ...f,
      cantidad: validas.filter((q) => q.itemId === f.id).reduce((a, q) => a + q.cantidad, 0),
    }));

    const existente = await tx.pedidoReposicion.findUnique({ where: { pedidoId } });
    if (existente) {
      await this.fusionarEnFila(tx, existente, nuevas);
    } else {
      await tx.pedidoReposicion.create({
        data: {
          pedidoId,
          estado: EstadoReposicion.PENDIENTE,
          items: nuevas as unknown as Prisma.InputJsonValue,
          motivo: null,
        },
      });
    }

    this.logger.log(
      `Pedido ${pedidoId}: ${validas.reduce((a, q) => a + q.cantidad, 0)} pieza(s) quitadas en mostrador pasan a reposición`,
    );
  }

  /**
   * Suma trabajo nuevo a la fila que ya existe (`pedidoId` es único).
   *
   * Una fila `REPUESTO` ya está resuelta —bodega confirmó que lo anterior volvió al
   * anaquel—, así que si entra trabajo nuevo se reabre con SOLO lo nuevo: sumarlo a
   * lo viejo le pediría a bodega devolver dos veces lo mismo. `creadaAt` se
   * renueva porque la lista se ordena por antigüedad y esto es trabajo recién
   * llegado.
   */
  private async fusionarEnFila(
    tx: Prisma.TransactionClient,
    existente: { pedidoId: number; estado: EstadoReposicion; items: Prisma.JsonValue },
    nuevas: EntradaReposicion[],
    opts: { motivo?: string } = {},
  ): Promise<void> {
    const hayTrabajoNuevo = nuevas.length > 0;
    const base =
      existente.estado === EstadoReposicion.REPUESTO && hayTrabajoNuevo
        ? []
        : itemsDeFila(existente.items);

    await tx.pedidoReposicion.update({
      where: { pedidoId: existente.pedidoId },
      data: {
        items: sumarEntradas(base, nuevas) as unknown as Prisma.InputJsonValue,
        ...(hayTrabajoNuevo
          ? {
              estado: EstadoReposicion.PENDIENTE,
              repuestoAt: null,
              repuestoPorId: null,
              creadaAt: new Date(),
            }
          : {}),
        ...(opts.motivo !== undefined ? { motivo: opts.motivo } : {}),
      },
    });
  }

  /**
   * Lista de reposición pendiente de la tienda. La consume la tablet de
   * bodega para saber qué mercancía tiene que volver al anaquel.
   */
  async listarPendientes(tiendaId: number, pagina = 1, limite = 20) {
    const skip = (pagina - 1) * limite;
    const where: Prisma.PedidoReposicionWhereInput = {
      estado: EstadoReposicion.PENDIENTE,
      pedido: { tiendaId },
    };
    const [reposiciones, total] = await Promise.all([
      this.prisma.pedidoReposicion.findMany({
        where,
        include: {
          pedido: {
            select: {
              id: true,
              numeroPedido: true,
              clienteNombre: true,
              fechaPedido: true,
              // La tarjeta dice POR QUÉ hay que devolver las prendas: el pedido se
              // canceló, o el cliente quitó piezas en mostrador y el pedido sigue vivo.
              estado: true,
            },
          },
        },
        orderBy: { creadaAt: 'asc' },
        skip,
        take: limite,
      }),
      this.prisma.pedidoReposicion.count({ where }),
    ]);

    return {
      data: reposiciones,
      meta: { total, pagina, limite, totalPaginas: Math.ceil(total / limite) },
    };
  }

  /**
   * Bodega confirma que la mercancía volvió al anaquel.
   */
  async confirmarRepuesto(pedidoId: number, usuario: UserContext) {
    const reposicion = await this.prisma.pedidoReposicion.findUnique({
      where: { pedidoId },
      include: { pedido: { select: { tiendaId: true } } },
    });
    if (!reposicion) {
      throw new NotFoundException('No hay reposición pendiente para este pedido');
    }
    if (reposicion.estado === EstadoReposicion.REPUESTO) {
      throw new BadRequestException('Esta reposición ya fue confirmada');
    }
    // Defensa en profundidad: el pedido debe ser de la tienda del bodeguero.
    if (usuario.tiendaId && reposicion.pedido.tiendaId !== usuario.tiendaId) {
      throw new BadRequestException('El pedido pertenece a otra tienda');
    }

    const actualizada = await this.prisma.pedidoReposicion.update({
      where: { pedidoId },
      data: {
        estado: EstadoReposicion.REPUESTO,
        repuestoAt: new Date(),
        repuestoPorId: usuario.userId,
      },
    });

    this.realtime.emitToTienda(reposicion.pedido.tiendaId, 'reposicion.repuesta', {
      pedidoId,
    });

    this.logger.log(`Pedido ${pedidoId}: reposición confirmada por ${usuario.nombre}`);

    return actualizada;
  }

  /**
   * Cuántas reposiciones pendientes tiene la tienda (para el badge de la UI).
   */
  async contarPendientes(tiendaId: number): Promise<number> {
    return this.prisma.pedidoReposicion.count({
      where: {
        estado: EstadoReposicion.PENDIENTE,
        pedido: { tiendaId },
      },
    });
  }
}
