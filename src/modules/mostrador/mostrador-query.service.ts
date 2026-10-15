import { Injectable, ForbiddenException } from '@nestjs/common';
import { Prisma, EstadoPedido, RolUsuario } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import {
  ESTADOS_ESPERA_CLIENTE,
  ORDEN_COLA,
  clientePresenteEnTienda,
  minutosEsperando,
  whereAusente,
  wherePresente,
} from '../pedidos/core/presencia.util';
import { estadoDeEspera, umbralesSinRecoger } from '../pedidos/core/sin-recoger.util';
import { UserContext } from '../../types/pedido.types';

/**
 * F22: el pedido "como lo ve el mostrador" — con los minutos que el cliente lleva
 * esperando en tienda (si está) y, si ya fue llamado, quién lo atiende y en qué
 * mostrador. Lo comparten la cola, el buscador y la lista de entrega, para que un
 * mismo pedido se vea igual en las tres.
 */
const INCLUDE_ATENCION = {
  llamadoPor: { select: { id: true, nombre: true, apellido: true } },
  llamadoMostrador: { select: { id: true, numero: true } },
} satisfies Prisma.PedidoInclude;

function conAtencion<
  T extends {
    canalOrigen: string;
    llegadaAnunciadaAt: Date | null;
    llegadaDescartadaAt: Date | null;
    presenteDesdeAt: Date | null;
    fechaPedido: Date;
    llamadoPor?: { nombre: string; apellido: string | null } | null;
    llamadoMostrador?: { numero: number } | null;
  },
>(p: T, ahora: number) {
  const { llamadoPor, llamadoMostrador } = p;
  return {
    ...p,
    esperandoDesdeMin: minutosEsperando(p, ahora),
    // La TV y la consola necesitan saber si hay alguien a quién llamar. Para un
    // pedido de kiosko es true salvo que el mostrador lo haya descartado.
    clienteEnTienda: clientePresenteEnTienda(p),
    // F22: quién lo atiende y dónde, para que el segundo operador que abra un
    // pedido ya llamado vea "Lo atiende Ana · Mostrador 2" y no pise a su
    // compañera.
    atendidoPorNombre: llamadoPor
      ? `${llamadoPor.nombre}${llamadoPor.apellido ? ' ' + llamadoPor.apellido : ''}`
      : null,
    mostradorNumero: llamadoMostrador?.numero ?? null,
  };
}

/** Escapa los comodines de LIKE para que el texto del operador se busque literal. */
function escaparLike(t: string): string {
  return t.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Minúsculas y sin acentos: "José" y "jose" tienen que encontrarse. */
function sinAcentos(t: string): string {
  return t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * Consultas de lectura de la consola de mostrador.
 *
 * Se extrajeron de `MostradorService`, que era tres servicios en uno: las
 * consultas, las transiciones de estado y la mutación de items tipo POS. Estas
 * cinco no mutan nada — sólo leen y paginan — así que no tienen por qué
 * convivir con las acciones ni con `PedidoStateService`.
 *
 * `obtenerPedido` delega en `PedidoStateService.obtenerDetalle` porque el
 * detalle lo comparten las cinco consolas y su mapeo (items, mensajes,
 * historial) es el mismo para todas.
 */
@Injectable()
export class MostradorQueryService {
  constructor(
    private prisma: PrismaService,
    private pedidoState: PedidoStateService,
    private readonly config?: ConfigService,
  ) {}
  /**
   * Pedidos de la tienda del usuario listos para entregar (PAID o SHIPPED).
   * Paginado y ordenados por fecha de pago ascendente: los más antiguos
   * primero (FIFO) para evitar que se queden en cola mucho tiempo.
   *
   * PR7: si `orden === 'esperando'` (default), los pedidos con aviso
   * de llegada activo (`llegadaAnunciadaAt IS NOT NULL AND
   * llegadaDescartadaAt IS NULL`) van PRIMERO, FIFO entre ellos. El
   * resto mantiene el orden por fechaPago. Sin este orden, el badge
   * "EN TIENDA" en el mostrador pierde sentido — el operador no sabría
   * cuál de los 10 pedidos PAID es el que tiene al cliente esperando.
   */
  async obtenerPedidosListos(
    tiendaId: number,
    pagina = 1,
    limite = 20,
    orden: 'esperando' | 'pago' = 'esperando',
  ) {
    const skip = (pagina - 1) * limite;
    const where: Prisma.PedidoWhereInput = {
      tiendaId,
      estado: { in: [EstadoPedido.PAGADO, EstadoPedido.ENVIADO] },
    };
    const orderBy: Prisma.PedidoOrderByWithRelationInput[] =
      orden === 'esperando'
        ? [
            // F22: un aviso DESCARTADO no debe seguir colando al pedido al
            // frente (el mismo criterio que bodega). `llegadaAnunciadaAt` queda
            // seteado para siempre; sin esta clave, el pedido de un cliente que
            // ya se fue viajaría prioritario por un aviso que se desmintió.
            { llegadaDescartadaAt: { sort: 'asc', nulls: 'first' } },
            // nullsLast simula "avisados primero, resto después", en el orden en
            // que el cliente empezó a esperar.
            { presenteDesdeAt: { sort: 'asc', nulls: 'last' } },
            { fechaPago: 'asc' },
            { id: 'asc' },
          ]
        : [{ fechaPago: 'asc' }, { id: 'asc' }];

    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
          // Oct 2026: sin `pendienteEnvio` el folio visible del frontend cae a
          // "Pedido #id" (`lib/utils/folio.ts`) y la lista muestra un número
          // que el cliente no reconoce. Es el folio de VFP, el del ticket.
          pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
        },
        orderBy,
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);

    // Anotar `esperandoDesdeMin` para que la UI del mostrador pueda
    // mostrar "EN TIENDA · hace 2 min" sin recalcular en cliente.
    const ahora = Date.now();
    const data = pedidos.map((p) => ({
      ...p,
      esperandoDesdeMin: minutosEsperando(p, ahora),
    }));

    return {
      data,
      meta: {
        total,
        pagina,
        limite,
        totalPaginas: Math.ceil(total / limite),
      },
    };
  }

  /**
   * Búsqueda del operador de mostrador. Es el caso de uso central de la
   * consola: un cliente llega a tienda SIN el ticket y SIN el número de
   * pedido, dice su nombre, y el operador tiene que encontrarlo.
   *
   * Oct 2026 — tres arreglos que la hacían inservible justo en ese escenario:
   *
   * 1. **Cubría 3 de los 10 estados.** Filtraba `REVISADO | PAID |
   *    SHIPPED`, así que un pedido que todavía está en bodega, esperando que
   *    el cliente apruebe una propuesta, en asesoría o ya en caja NO SE
   *    ENCONTRABA — y el operador se quedaba sin salida con el cliente
   *    enfrente. Ahora busca en todos los estados, incluidos los terminales:
   *    poder decir "ese pedido ya se lo entregamos" es parte del trabajo.
   *
   * 2. **No buscaba el folio que el cliente conoce.** El cliente trae el folio
   *    de VFP (`externalFolio`); el buscador solo miraba `numeroPedido`, que es
   *    interno e invisible para él (ver `lib/utils/folio.ts` en el frontend).
   *    También se agregó el correo, que es lo que el cliente dicta cuando no
   *    recuerda su teléfono.
   *
   * 3. **El orden enterraba los pedidos accionables.** Ordenaba por
   *    `fechaPago asc`, y los pedidos en `REVISADO` tienen `fechaPago`
   *    NULL — Postgres los manda al final. Con el `take: 20` fijo, el pedido
   *    que el operador necesitaba podía quedar cortado. Ahora ordena por el
   *    enum de estado, que está declarado en orden de ciclo de vida: los
   *    activos primero, los terminales al final. Dentro de cada estado, el más
   *    reciente primero (el cliente que acaba de llegar).
   *
   * El `include` de `pendienteEnvio` no es cosmético: sin él, `folioVisible()`
   * del frontend cae a `"Pedido #id"` y el operador lee un número que el
   * cliente no reconoce.
   */
  async buscarPedidos(q: string, usuario: UserContext, tiendaId?: number, pagina = 1, limite = 20) {
    // La tienda sale SOLO del JWT (`user.tiendaId`), nunca de un header. Antes el
    // filtro era `if (rol !== ADMIN && tiendaId)`: un usuario sin tienda
    // quedaba SIN filtro y veía pedidos de todas las tiendas. Falla cerrado,
    // igual que `PedidoAccessService.validar`.
    const where: Prisma.PedidoWhereInput = {};
    if (usuario.rol !== RolUsuario.ADMIN) {
      if (!tiendaId) {
        throw new ForbiddenException(
          'Tu usuario no tiene tienda asignada. Contacta al administrador.',
        );
      }
      where.tiendaId = tiendaId;
    }

    // F22: los IDs que coinciden se calculan en SQL (ver `idsQueCoinciden`) y
    // Prisma pagina y ordena sobre ellos. `where.tiendaId` se conserva ADEMÁS del
    // filtro del SQL: la tienda no puede depender de una sola de las dos capas.
    const ids = await this.idsQueCoinciden(
      q,
      usuario.rol === RolUsuario.ADMIN ? undefined : tiendaId,
    );
    if (ids.length === 0) {
      return { data: [], meta: { total: 0, pagina, limite, totalPaginas: 0 } };
    }
    where.id = { in: ids };

    const skip = (pagina - 1) * limite;
    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
          // El folio que el cliente trae en el ticket. Sin esto la UI muestra
          // "Pedido #id" y el operador no puede confirmar con el cliente.
          pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
          ...INCLUDE_ATENCION,
        },
        // El enum está declarado en orden de ciclo de vida (activos primero,
        // terminales al final), así que ordenar por él pone arriba lo que el
        // operador puede resolver ahora. Dentro de cada estado, el más reciente.
        orderBy: [{ estado: 'asc' }, { fechaPedido: 'desc' }, { id: 'desc' }],
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);

    // Oct 2026: anotar `esperandoDesdeMin` igual que `obtenerPedidosListos` y
    // `obtenerCola`. Sin esto, el badge "EN TIENDA · N min" del buscador nunca
    // se pintaba: `BadgeEnTienda` devuelve `null` cuando el campo es
    // `undefined`, así que un pedido con aviso vigente se veía igual que uno
    // sin aviso — justo la distinción que el operador necesita.
    const ahora = Date.now();
    const data = pedidos.map((p) => conAtencion(p, ahora));

    return {
      data,
      meta: {
        total,
        pagina,
        limite,
        totalPaginas: Math.ceil(total / limite),
      },
    };
  }

  /**
   * F22: IDs de los pedidos que coinciden con lo que el operador escribió.
   *
   * Tres cosas que `contains insensitive` de Prisma no hace y que el operador
   * necesita con el cliente enfrente, sin ticket y sin folio:
   *
   *  1. **Teléfono.** La pantalla decía "busca por teléfono" y el backend no lo
   *     buscaba. Es lo primero que un cliente sin papeles sabe de memoria.
   *     Se compara solo contra dígitos: "55 1234-5678" encuentra "5512345678".
   *  2. **Acentos.** "Jose" no encontraba a "José" (`insensitive` solo ignora
   *     mayúsculas). Se normalizan los dos lados.
   *  3. **Palabras sueltas.** "perez juan" no encontraba a "Juan Pérez" porque se
   *     buscaba la cadena entera. Ahora cada palabra tiene que aparecer en
   *     ALGUNO de los campos (AND entre palabras, OR entre campos).
   *
   * El texto del operador va siempre como parámetro (nunca interpolado) y con los
   * comodines de LIKE escapados. Se limita a 200 coincidencias: es un buscador de
   * mostrador, no un reporte.
   */
  private async idsQueCoinciden(q: string, tiendaId?: number): Promise<number[]> {
    const crudo = q.trim();
    // Un teléfono ("55 1234 5678") no se parte por espacios: sus pedazos
    // cortos no matchearían nada y el AND fallaría.
    const esTelefono = /^[\d\s()+-]+$/.test(crudo) && crudo.replace(/\D/g, '').length >= 6;
    const tokens = (esTelefono ? [crudo.replace(/\s/g, '')] : sinAcentos(crudo).split(/\s+/))
      .filter(Boolean)
      .slice(0, 5);
    if (tokens.length === 0) return [];

    const condiciones = tokens.map((t) => {
      const like = `%${escaparLike(sinAcentos(t))}%`;
      const digitos = t.replace(/\D/g, '');
      const telefono =
        digitos.length >= 3
          ? Prisma.sql`OR regexp_replace(coalesce(p.cliente_telefono, ''), '\\D', '', 'g') LIKE ${`%${digitos}%`}`
          : Prisma.empty;
      return Prisma.sql`(
        lower(translate(p.cliente_nombre, 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')) LIKE ${like}
        OR lower(p.numero_pedido) LIKE ${like}
        OR lower(p.cliente_email) LIKE ${like}
        OR lower(coalesce(pe.external_folio, '')) LIKE ${like}
        ${telefono}
      )`;
    });

    const filas = await this.prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
      SELECT p.id
        FROM pedidos p
        LEFT JOIN pedidos_pendientes_envio pe ON pe.pedido_id = p.id
       WHERE ${tiendaId ? Prisma.sql`p.tienda_id = ${tiendaId} AND` : Prisma.empty}
             ${Prisma.join(condiciones, ' AND ')}
       ORDER BY p.id DESC
       LIMIT 200
    `);
    return filas.map((f) => f.id);
  }

  /**
   * Detalle completo de un pedido. La validación de tienda/rol la hace
   * `PedidoAccessService` a través de `obtenerDetalle`.
   */
  async obtenerPedido(pedidoId: number, usuario: UserContext) {
    return this.pedidoState.obtenerDetalle(pedidoId, usuario);
  }

  /**
   * Cola de pedidos apartados esperando que el cliente los revise.
   *
   * Gate de visibilidad (decisión D5 del plan):
   *   - KIOSKO        → visible SIEMPRE. El pedido se hizo en la tienda, así
   *                     que el cliente está ahí por definición.
   *   - WEB           → visible SÓLO si el cliente ya avisó su llegada
   *                     (`llegadaAnunciadaAt` poblado y no descartado). Sin
   *                     ese aviso el pedido podría estar en casa del cliente;
   *                     mostrador no tiene a quién llamar.
   *
   * Orden: los que ya avisaron llegada PRIMERO (FIFO entre ellos por el
   * momento del aviso), luego el resto por antigüedad. Es el mismo criterio
   * que ya usa `obtenerPedidosListos`, para que el badge "EN TIENDA" no
   * pierda sentido cuando hay varios pedidos en cola.
   */
  async obtenerCola(tiendaId: number, pagina = 1, limite = 20) {
    const skip = (pagina - 1) * limite;
    const where: Prisma.PedidoWhereInput = {
      tiendaId,
      // F18 (oct 2026): la cola incluye REVISADO **y EN_ATENCION**.
      //
      // Bug que arregla: `llamar` mueve el pedido a EN_ATENCION, pero NINGUNA
      // pestaña de la consola lo mostraba (esta filtraba REVISADO,
      // `obtenerSinAviso` filtraba REVISADO, `obtenerPedidosListos` filtraba
      // PAGADO|ENVIADO). El operador llamaba a un cliente y el pedido
      // DESAPARECÍA de la consola: no podía hacer el recuento, ni enviarlo a
      // pagar, ni resolver una propuesta. Solo le quedaba "Volver a la lista".
      //
      // Incluirlo aquí es correcto además por semántica: "Por revisar" es la
      // cola de trabajo del operador, y un pedido que ya está atendiendo sigue
      // siendo su trabajo.
      estado: { in: [EstadoPedido.REVISADO, EstadoPedido.EN_ATENCION] },
      // F22: la regla única de presencia (`presencia.util.ts`), la MISMA de la
      // TV y de `llamarSiguiente`. Gate de visibilidad (decisión D5):
      //   - KIOSKO → visible, salvo que el mostrador lo haya descartado (el
      //              cliente se fue).
      //   - WEB    → visible SÓLO si el cliente ya avisó su llegada. Sin ese aviso
      //              el pedido podría estar en casa del cliente; mostrador no
      //              tiene a quién llamar.
      ...wherePresente(),
    };

    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
          // Oct 2026: el folio de VFP, el que el cliente trae en el ticket.
          pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
          ...INCLUDE_ATENCION,
        },
        // F22: "primero llegado, primero atendido". La misma llave que la TV y
        // `llamarSiguiente`; si divergieran, el operador llamaría a alguien que no
        // es el primero de la pantalla.
        orderBy: ORDEN_COLA,
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);

    // Anotar `esperandoDesdeMin` para que la UI muestre "EN TIENDA · hace X min"
    // sin recalcular en cliente (mismo shape que `obtenerPedidosListos`).
    const ahora = Date.now();
    const data = pedidos.map((p) => conAtencion(p, ahora));

    return {
      data,
      meta: {
        total,
        pagina,
        limite,
        totalPaginas: Math.ceil(total / limite),
      },
    };
  }

  /**
   * Pedidos apartados cuyo cliente NO está en la tienda.
   *
   * Es la cara visible del contador `sinCliente` del monitor
   * (`mostrador-monitor.service.ts`). Existe porque el gate de D5 esconde estos
   * pedidos de la cola: un cliente web en `REVISADO` sin aviso es invisible, y si
   * llega a tienda sin teléfono o sin el folio, el operador no tenía forma de
   * encontrarlo ni de hacerlo aparecer.
   *
   * El operador los ve aquí, identifica al cliente, y marca la llegada con
   * `marcarLlegada` — momento en el que el pedido pasa a la cola normal con su
   * badge EN TIENDA.
   *
   * F22 (oct 2026): tres cambios.
   *  - Incluye `ESPERANDO_APROBACION`: el cliente que no contestó su propuesta
   *    tiene la bolsa apartada igual que uno de `REVISADO`, y es el que más
   *    tiempo lleva sin aparecer.
   *  - Incluye kiosko: un pedido de kiosko cuyo cliente se fue (el mostrador lo
   *    descartó) queda aquí, no desaparece.
   *  - Cada fila lleva su ANTIGÜEDAD (`horasEsperando`), si ya se le mandó el
   *    recordatorio y si está VENCIDA. Con `filtro: 'vencidos'` solo las vencidas.
   *    El operador las cancela desde aquí (`cancelarVencidos`).
   *
   * Orden: los más viejos primero. Son los que llevan más tiempo atorados sin
   * que nadie los persiga, así que son los que más urge atender.
   */
  async obtenerSinAviso(
    tiendaId: number,
    pagina = 1,
    limite = 20,
    filtro: 'todos' | 'vencidos' = 'todos',
  ) {
    const skip = (pagina - 1) * limite;
    const umbrales = umbralesSinRecoger(this.config);
    const limiteVencido = new Date(Date.now() - umbrales.vencidoHoras * 3_600_000);

    const base: Prisma.PedidoWhereInput = {
      tiendaId,
      estado: { in: ESTADOS_ESPERA_CLIENTE },
      // Mismo predicado que el contador `sinCliente` del monitor: sin aviso, o
      // con el aviso descartado por el operador (el cliente no estaba).
      ...whereAusente(),
    };
    const where: Prisma.PedidoWhereInput =
      filtro === 'vencidos' ? { ...base, esperaClienteDesdeAt: { lt: limiteVencido } } : base;

    const [pedidos, total, vencidos] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
          // Oct 2026: el folio de VFP, el que el cliente trae en el ticket.
          pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
        },
        orderBy: [
          { esperaClienteDesdeAt: { sort: 'asc', nulls: 'last' } },
          { fechaPedido: 'asc' },
          { id: 'asc' },
        ],
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
      // El total de VENCIDOS va aparte del total de la lista filtrada: la pestaña
      // y el chip "Vencidos" lo muestran aunque se esté viendo "todos".
      this.prisma.pedido.count({ where: { ...base, esperaClienteDesdeAt: { lt: limiteVencido } } }),
    ]);

    const ahora = Date.now();
    const data = pedidos.map((p) => {
      const espera = estadoDeEspera(p.esperaClienteDesdeAt, umbrales, ahora);
      return {
        ...p,
        // Mismo nombre que en el monitor, para que la consola y la TV hablen
        // igual de "cuánto lleva esperando este pedido".
        minutosEsperando: Math.max(0, Math.floor((ahora - p.fechaPedido.getTime()) / 60_000)),
        horasEsperando: espera ? Math.floor(espera.horasEsperando) : null,
        vencido: espera?.vencido ?? false,
        recordatorioEnviado: p.recordatorioRecogerAt !== null,
      };
    });

    return {
      data,
      meta: {
        total,
        pagina,
        limite,
        totalPaginas: Math.ceil(total / limite),
        vencidos,
        // Los plazos, para que la pantalla explique "vence a las 72 h" sin
        // duplicar el número.
        vencidoHoras: umbrales.vencidoHoras,
        recordatorioHoras: umbrales.recordatorioHoras,
      },
    };
  }
}
