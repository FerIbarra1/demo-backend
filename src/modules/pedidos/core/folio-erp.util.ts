import { EstadoPedido, ModoEntrega, Prisma } from '@prisma/client';

/**
 * Oct 2026 (parte B) — el FOLIO del Sistema Comercial como ID del pedido.
 *
 * El folio del ERP es un consecutivo de 10 dígitos POR TIENDA (`CONSECUTIVOS`, TIPO='PEDIDOS', `LPAD(…,10,'0')`):
 * el mismo número existe en cada tienda, así que la llave de un folio es `(tienda, folio)`. Lo que ve la gente es
 * `SERIE-folio` ("HMO-0000152573", con `TIENDAS.SERIE` de prefijo): el prefijo es solo visual, en la BD el folio queda
 * de 10 dígitos tal cual lo guarda Firebird.
 *
 * Funciones puras sobre Prisma (no un servicio) por el mismo motivo que `tareas-erp.util`: las llaman la máquina de
 * estados y el módulo de sync, que no pueden importarse entre sí sin crear un ciclo.
 */

type Db = Prisma.TransactionClient;

/** Un folio del ERP: exactamente 10 dígitos. */
export const FOLIO_ERP_REGEX = /^\d{10}$/;

export function esFolioErp(valor: unknown): valor is string {
  return typeof valor === 'string' && FOLIO_ERP_REGEX.test(valor);
}

/**
 * `SERIE-folio` para mostrar. Sin serie (la tienda aún no sincroniza `TIENDAS.SERIE`) se muestra el folio solo: es lo
 * correcto y lo que entiende el Sistema Comercial.
 */
export function formatearFolio(serie: string | null | undefined, folio: string): string {
  const s = (serie ?? '').trim().toUpperCase();
  return s ? `${s}-${folio}` : folio;
}

/**
 * Lo que se muestra como ID del pedido: el folio del ERP si ya llegó; si no, el número interno (`PD-…`), que es lo
 * único que existe mientras el agente contesta.
 */
export function etiquetaDelPedido(
  pedido: { folioErp?: string | null; numeroPedido: string },
  serie: string | null | undefined,
): string {
  return pedido.folioErp ? formatearFolio(serie, pedido.folioErp) : pedido.numeroPedido;
}

/**
 * Cuántos dígitos del final del folio se dicen en voz alta y se pintan en las TV de pared (decisión del dueño, 18-oct:
 * las TV son públicas y de espacio chico, así que muestran los últimos dígitos y no el folio completo). Cuatro bastan:
 * el consecutivo es por tienda y avanza de uno en uno, así que dos pedidos que esperan a la vez en una misma tienda
 * (decenas al día) no pueden coincidir en sus últimos cuatro dígitos a menos que los separen 10 000 pedidos.
 * Es la ÚNICA constante: cambiar a 6 es cambiar este número.
 */
export const DIGITOS_DE_TURNO = 4;

/**
 * El "turno" que se muestra donde el folio completo no cabe o no debe verse: los últimos `DIGITOS_DE_TURNO` dígitos, con
 * sus ceros ("0000152573" → "2573", "0000000611" → "0611") para que coincidan con el final del folio impreso en el ticket.
 * `null` si el pedido aún no tiene folio.
 */
export function turnoCorto(folio: string | null | undefined): string | null {
  return esFolioErp(folio) ? folio.slice(-DIGITOS_DE_TURNO) : null;
}

/**
 * Los estados en que un pedido sale en las TV de pared de la tienda: la fila de mostrador (`REVISADO`, con el cliente
 * presente), su llamada (`EN_ATENCION`) y la fila de caja (`PENDIENTE_PAGO`). Antes y después no hay quién lo llame.
 */
const ESTADOS_QUE_SALEN_EN_PANTALLA: ReadonlySet<EstadoPedido> = new Set([
  EstadoPedido.REVISADO,
  EstadoPedido.EN_ATENCION,
  EstadoPedido.PENDIENTE_PAGO,
]);

/**
 * El turno que ve el CLIENTE en su pedido ("Tu turno en pantalla: 2573"), o `null` si no aplica. Las TV muestran solo los
 * últimos dígitos del folio (`turnoCorto`) y, sin decirle cuáles, el cliente no sabe qué buscar. Lo decide el servidor,
 * como el resto de lo que se ofrece en pantalla: sin folio todavía, a domicilio (no pasa por ventanilla) o en un estado
 * en que ya no sale en ninguna TV, no hay turno que mostrar.
 */
export function turnoParaElCliente(pedido: {
  folioErp?: string | null;
  estado: EstadoPedido;
  modoEntrega?: ModoEntrega | null;
}): string | null {
  if (pedido.modoEntrega === ModoEntrega.DOMICILIO) return null;
  if (!ESTADOS_QUE_SALEN_EN_PANTALLA.has(pedido.estado)) return null;
  return turnoCorto(pedido.folioErp);
}

/**
 * Lo que alguien teclea o escanea → `{ serie?, folio }`. Acepta "HMO-0000152573", "0000152573" (lo que lleva el QR
 * para el lector del Sistema Comercial) y "152573" (sin los ceros: así lo dice la gente). `null` si no parece un folio.
 *
 * El folio solo identifica un pedido junto con su tienda: quien lo usa debe acotar por la tienda del empleado (o, si
 * no la hay, mostrar todos los que coincidan).
 */
export function interpretarFolio(texto: string): { serie: string | null; folio: string } | null {
  const limpio = (texto ?? '').trim().toUpperCase();
  const m = /^(?:([A-Z]{2,10})\s*[-\s]\s*)?(\d{1,10})$/.exec(limpio);
  if (!m) return null;
  return { serie: m[1] ?? null, folio: m[2].padStart(10, '0') };
}

/**
 * Estados en los que el pedido todavía NO pidió su folio (la bodega no ha cerrado el surtido) o ya no lo necesita.
 * Todo lo demás —REVISADO, ESPERANDO_APROBACION, EN_DTF, PENDIENTE_PAGO… — es "después del surtido".
 */
const SIN_FOLIO_AUN = new Set<EstadoPedido>([
  EstadoPedido.SOLICITADO,
  EstadoPedido.EN_REVISION,
  EstadoPedido.CANCELADO,
]);

/**
 * ¿Un pedido que llega a `estadoNuevo` necesita su folio del ERP?
 *
 * Se pide cuando bodega CIERRA el surtido (la transición que sale de `EN_REVISION`), y como red de seguridad en
 * cualquier otro camino que lo deje "después del surtido" sin folio (un atajo del admin, un pedido anterior a este
 * cambio, el agente caído al cerrar): así NINGÚN pedido llega a caja sin haberlo pedido. Un ajuste que regresa el
 * pedido a bodega no pide otro: la solicitud es única por pedido.
 */
export function necesitaFolio(estadoNuevo: EstadoPedido): boolean {
  return !SIN_FOLIO_AUN.has(estadoNuevo);
}

/**
 * Deja la solicitud de folio en la cola del agente. Idempotente: UNA por pedido, y no hace nada si el pedido ya tiene
 * folio. `createMany` + `skipDuplicates` (y no un `create` capturando el error) porque en Postgres un INSERT fallido
 * aborta la transacción completa y la transición que lo rodea se perdería.
 *
 * Va DENTRO de la transacción de la transición: o queda el pedido en su estado nuevo CON su solicitud, o no cambia nada.
 */
export async function asegurarSolicitudDeFolio(
  db: Db,
  pedido: { id: number; tiendaId: number; folioErp: string | null },
): Promise<void> {
  if (pedido.folioErp) return;
  await db.pedidoFolioSolicitud.createMany({
    data: [{ pedidoId: pedido.id, tiendaId: pedido.tiendaId }],
    skipDuplicates: true,
  });
}

export type ResultadoDeGuardarFolio =
  /** El pedido no tenía folio y ahora lo tiene. */
  | 'ASIGNADO'
  /** Ya tenía ESE folio (el ACK se repitió): nada que hacer. */
  | 'YA_TENIA_ESE'
  /** Ya tenía OTRO folio y ese manda (la nube se adelantó): el folio recibido se "quemó" en el ERP. */
  | 'YA_TENIA_OTRO'
  /** Otro pedido de la MISMA tienda ya tiene ese folio: el consecutivo del ERP retrocedió o se duplicó. */
  | 'FOLIO_EN_USO'
  /** El pedido cambió mientras se guardaba: se reintenta con el ACK siguiente. */
  | 'CONFLICTO';

/**
 * Guarda el folio que dio el ERP y cierra la solicitud. Lo usan los DOS caminos por los que llega un folio:
 *   · `folios-ack`  — el agente reservó el consecutivo a petición de la nube (`elErpManda: false`: si el pedido ya
 *                     tiene otro, ese gana y el reservado queda como hueco, que está aceptado).
 *   · `pedidos-ack` — `GRABAR_PEDIDOS` escribió el pedido en Firebird con ese folio (`elErpManda: true`): lo que
 *                     está en el ERP es la verdad, y la nube se ajusta a él.
 *
 * Nunca lanza por un folio repetido: un INSERT/UPDATE que viola el índice aborta la transacción completa de Postgres
 * y el ACK del agente se reintentaría para siempre. Se MIRA antes.
 */
export async function guardarFolioDelPedido(
  db: Db,
  pedido: { id: number; tiendaId: number; folioErp: string | null },
  folio: string,
  opts: { elErpManda: boolean },
): Promise<ResultadoDeGuardarFolio> {
  if (!esFolioErp(folio)) throw new Error(`Folio inválido: ${folio}`);

  let resultado: ResultadoDeGuardarFolio;
  if (pedido.folioErp === folio) {
    resultado = 'YA_TENIA_ESE';
  } else if (pedido.folioErp && !opts.elErpManda) {
    resultado = 'YA_TENIA_OTRO';
  } else {
    const enUso = await db.pedido.findFirst({
      where: { tiendaId: pedido.tiendaId, folioErp: folio, id: { not: pedido.id } },
      select: { id: true },
    });
    if (enUso) return 'FOLIO_EN_USO';
    const { count } = await db.pedido.updateMany({
      where: { id: pedido.id, folioErp: pedido.folioErp },
      data: { folioErp: folio },
    });
    if (count !== 1) return 'CONFLICTO';
    resultado = 'ASIGNADO';
  }

  // La solicitud se cierra siempre que el pedido ya tenga folio, venga de donde venga.
  await db.pedidoFolioSolicitud.updateMany({
    where: { pedidoId: pedido.id, estado: { not: 'ASIGNADO' } },
    data: {
      estado: 'ASIGNADO',
      asignadoAt: new Date(),
      claimedBy: null,
      leaseToken: null,
      leaseUntil: null,
      ultimoError: null,
    },
  });
  return resultado;
}
