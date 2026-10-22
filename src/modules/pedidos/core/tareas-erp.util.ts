import { EstadoTareaErp, Prisma, TipoTareaErp } from '@prisma/client';

/**
 * Oct 2026 — lo que la nube hizo y el Sistema Comercial (el ERP) todavía NO sabe.
 *
 * Cuando un pedido que YA tiene folio en el Sistema Comercial se cancela, o se marca pagado a mano, desde la nube, el
 * ERP no se entera solo: alguien (el cajero, que es quien opera el Sistema Comercial) tiene que reflejarlo allá. Estas
 * funciones puras sobre Prisma crean y cierran esa lista de pendientes (`TareaSistemaComercial`).
 *
 * Son funciones y no un servicio inyectable porque las llaman la máquina de estados (`cambiarEstado`), el cobro manual
 * (`AdminService`), el ACK del agente y el handler del ERP: módulos que no pueden importar `DestrabarModule` sin crear un
 * ciclo (mismo motivo que `pagos/transferencia/hooks.ts`). Todas aceptan el cliente de Prisma o la transacción.
 *
 * "Ya está en el ERP" = su fila de `PedidoPendienteEnvio` está PROCESADO (el agente grabó el pedido y devolvió su
 * IDPEDIDO). Antes de eso el ERP no lo conoce y no hay nada que reflejar.
 */

type Db = Prisma.TransactionClient;

/** Quién provoca el cambio. `id` null/0 = el sistema o el agente (el ERP ya lo sabe: nunca genera tarea). */
export interface ActorTarea {
  id: number | null;
  rol: string;
  nombre: string;
}

const esElSistema = (a: ActorTarea) => !a.id;

/** Estados de la fila de envío en los que el pedido AÚN NO llegó al ERP y tampoco está en vuelo. */
const ENVIO_SIN_ENTREGAR = ['PENDIENTE', 'RETRY', 'ERROR', 'EXPIRADO'];

export interface DatosTarea {
  pedidoId: number;
  tiendaId: number;
  tipo: TipoTareaErp;
  motivo: string;
  actor: ActorTarea;
  folio?: string | null;
  erpIdPedido?: number | null;
  intervencionId?: number | null;
}

/**
 * Abre una tarea. UNA sola abierta por pedido y tipo (índice parcial en la BD): si ya hay una, devuelve esa.
 * Busca antes de crear en vez de capturar el error del índice: en Postgres un `INSERT` fallido aborta la transacción
 * completa y la cancelación que la rodea se perdería.
 */
export async function abrirTareaErp(db: Db, d: DatosTarea) {
  const abierta = await db.tareaSistemaComercial.findFirst({
    where: { pedidoId: d.pedidoId, tipo: d.tipo, estado: EstadoTareaErp.PENDIENTE },
  });
  if (abierta) return abierta;
  return db.tareaSistemaComercial.create({
    data: {
      pedidoId: d.pedidoId,
      tiendaId: d.tiendaId,
      tipo: d.tipo,
      folio: d.folio ?? null,
      erpIdPedido: d.erpIdPedido ?? null,
      motivo: d.motivo,
      creadaPorId: d.actor.id || null,
      creadaPorRol: d.actor.rol,
      creadaPorNombre: d.actor.nombre,
      intervencionId: d.intervencionId ?? null,
    },
  });
}

/**
 * El pedido se CANCELÓ en la nube. Dice qué pasa con su fila hacia el ERP:
 *
 *  - Ya PROCESADO (tiene folio): el ERP lo sigue teniendo vivo → se abre una tarea `CANCELAR_EN_ERP`.
 *  - Todavía sin entregar al agente (PENDIENTE/RETRY/ERROR/EXPIRADO): el poll del agente ya ignora los pedidos
 *    cancelados, así que nunca llegará. La fila se marca CANCELADO para que la salud no la cuente como "atorada".
 *  - En vuelo (PROCESSING): el agente lo está grabando AHORA. No se toca: lo resuelve el ACK
 *    (`procesarPedidosAck`), que al ver el pedido cancelado abre esta misma tarea con el folio que le devuelve el ERP.
 *  - Sin fila (nunca se encoló) o ya CANCELADO: nada.
 *  - Lo cancela el sistema/agente (`SWCANCEL`): el ERP ya lo sabe, no hay nada que reflejar.
 *
 * `opts.yaCobrado` (etapa 2): el pedido se cancela estando PAGADO o ENVIADO. En el ERP ya está cobrado, así que la
 * tarea no es "cancelarlo" sino ANULAR LA VENTA y devolver el dinero (`ANULAR_VENTA_EN_ERP`). Un pedido cobrado ya
 * tiene fila PROCESADO (el cobro llegó o se marcó sobre un pedido que pasó por el agente); si no la tiene, no hay nada
 * que reflejar.
 *
 * Va DENTRO de la transacción de la cancelación: o quedan las dos cosas o ninguna.
 */
export async function reflejarCancelacionEnErp(
  db: Db,
  pedidoId: number,
  actor: ActorTarea,
  motivo: string,
  opts: { yaCobrado?: boolean } = {},
): Promise<{ tarea: Awaited<ReturnType<typeof abrirTareaErp>> | null; retirada: boolean }> {
  if (esElSistema(actor)) return { tarea: null, retirada: false };

  const envio = await db.pedidoPendienteEnvio.findUnique({
    where: { pedidoId },
    select: { estado: true, externalIdPEDIDOS: true, externalFolio: true },
  });
  if (!envio) return { tarea: null, retirada: false };

  if (envio.estado === 'PROCESADO') {
    const pedido = await db.pedido.findUniqueOrThrow({
      where: { id: pedidoId },
      select: { tiendaId: true },
    });
    const tarea = await abrirTareaErp(db, {
      pedidoId,
      tiendaId: pedido.tiendaId,
      tipo: opts.yaCobrado ? TipoTareaErp.ANULAR_VENTA_EN_ERP : TipoTareaErp.CANCELAR_EN_ERP,
      motivo,
      actor,
      folio: envio.externalFolio,
      erpIdPedido: envio.externalIdPEDIDOS,
    });
    return { tarea, retirada: false };
  }

  if (ENVIO_SIN_ENTREGAR.includes(envio.estado)) {
    await db.pedidoPendienteEnvio.update({
      where: { pedidoId },
      data: {
        estado: 'CANCELADO',
        claimedBy: null,
        leaseToken: null,
        leaseUntil: null,
        processedAt: new Date(),
        ultimoErrorCode: 'PEDIDO_CANCELADO',
        ultimoError: 'Pedido cancelado en la nube antes de llegar al Sistema Comercial',
      },
    });
    return { tarea: null, retirada: true };
  }

  return { tarea: null, retirada: false };
}

/**
 * El pedido se marcó PAGADO a mano en la nube. Si ya está en el ERP, el cobro no existe allá: tarea
 * `REGISTRAR_COBRO_EN_ERP`. Lo hace un humano (`actor` con id); el cobro que llega DEL ERP (agente) no pasa por aquí.
 */
export async function reflejarCobroManualEnErp(
  db: Db,
  pedidoId: number,
  actor: ActorTarea,
  motivo: string,
  intervencionId?: number | null,
) {
  if (esElSistema(actor)) return null;
  const envio = await db.pedidoPendienteEnvio.findUnique({
    where: { pedidoId },
    select: { estado: true, externalIdPEDIDOS: true, externalFolio: true },
  });
  if (!envio || envio.estado !== 'PROCESADO') return null;
  const pedido = await db.pedido.findUniqueOrThrow({
    where: { id: pedidoId },
    select: { tiendaId: true },
  });
  return abrirTareaErp(db, {
    pedidoId,
    tiendaId: pedido.tiendaId,
    tipo: TipoTareaErp.REGISTRAR_COBRO_EN_ERP,
    motivo,
    actor,
    folio: envio.externalFolio,
    erpIdPedido: envio.externalIdPEDIDOS,
    intervencionId,
  });
}

/**
 * El ERP confirmó lo que la tarea pedía (llegó `SWCANCEL=true` o `FINALIZADA=true` por el agente): se cierra sola.
 * Idempotente: el evento llega más de una vez y sin tarea abierta no hace nada.
 */
export async function cerrarTareasConfirmadasPorEl(
  db: Pick<Db, 'tareaSistemaComercial'>,
  pedidoId: number,
  tipo: TipoTareaErp,
): Promise<number> {
  const r = await db.tareaSistemaComercial.updateMany({
    where: { pedidoId, tipo, estado: EstadoTareaErp.PENDIENTE },
    data: {
      estado: EstadoTareaErp.HECHA,
      resueltaAt: new Date(),
      resueltaVia: 'ERP',
      resueltaPorNombre: 'Sistema Comercial',
    },
  });
  return r.count;
}

/** Lo que ve el personal de cada tipo de tarea, ya redactado: la pantalla no lo reescribe. */
export function textoDeTarea(t: { tipo: TipoTareaErp; folio: string | null }): {
  titulo: string;
  instruccion: string;
} {
  const folio = t.folio ? `el folio ${t.folio}` : 'el pedido';
  switch (t.tipo) {
    case TipoTareaErp.CANCELAR_EN_ERP:
      return {
        titulo: 'Cancelar en el Sistema Comercial',
        instruccion: `Cancela ${folio} en el Sistema Comercial: en la web ya está cancelado y allá sigue vivo.`,
      };
    case TipoTareaErp.REGISTRAR_COBRO_EN_ERP:
      return {
        titulo: 'Registrar el cobro en el Sistema Comercial',
        instruccion: `Registra el cobro de ${folio} en el Sistema Comercial: en la web ya está pagado y allá no hay cobro.`,
      };
    case TipoTareaErp.ANULAR_VENTA_EN_ERP:
      return {
        titulo: 'Anular la venta en el Sistema Comercial',
        instruccion:
          `Anula la venta de ${folio} en el Sistema Comercial y devuelve al cliente lo que pagó: en la web el pedido ya ` +
          'está cancelado y allá sigue cobrado. Si pagó por transferencia, el reembolso lo hace Tesorería.',
      };
  }
}
