import { EstadoDtf, Prisma } from '@prisma/client';

/**
 * Impresión DTF (oct 2026) — estados del TRABAJO (`PedidoDtf`). Ver PLAN-DTF.md §5.1.
 *
 * Es una máquina APARTE de `EstadoPedido`: el pedido solo sabe si le queda DTF por imprimir
 * (`EN_DTF`); el detalle de cada archivo vive aquí. Sin imports de servicios a propósito: la usa
 * `PedidoStateService` (módulo de pedidos) y el módulo `dtf`, y un import cruzado sería un ciclo.
 */

/** Estados que MANTIENEN al pedido esperando su DTF (aún no hay película lista). */
export const ESTADOS_DTF_PENDIENTES: EstadoDtf[] = [
  EstadoDtf.ARCHIVO_PENDIENTE,
  EstadoDtf.RECIBIDO,
  EstadoDtf.EN_REVISION,
  EstadoDtf.NECESITA_CORRECCION,
  EstadoDtf.APROBADO,
  EstadoDtf.EN_IMPRESION,
];

/** Estados de un trabajo que ya no pueden cambiar (la entrega es del pedido). */
export const ESTADOS_DTF_TERMINALES: EstadoDtf[] = [
  EstadoDtf.IMPRESO,
  EstadoDtf.RECHAZADO,
  EstadoDtf.CANCELADO,
  EstadoDtf.EXPIRADO,
];

/** Estados que cuentan para el total del pedido (los rechazados/cancelados/expirados no se cobran). */
export const ESTADOS_DTF_QUE_SE_COBRAN: EstadoDtf[] = [
  ...ESTADOS_DTF_PENDIENTES,
  EstadoDtf.IMPRESO,
];

/** Estados en los que el cliente todavía puede cambiar o quitar su trabajo (antes de gastar película). */
export const ESTADOS_DTF_EDITABLES_POR_CLIENTE: EstadoDtf[] = [
  EstadoDtf.BORRADOR,
  EstadoDtf.ARCHIVO_PENDIENTE,
  EstadoDtf.RECIBIDO,
  EstadoDtf.EN_REVISION,
  EstadoDtf.NECESITA_CORRECCION,
  EstadoDtf.APROBADO,
];

/** Estados en los que Impresión tiene el trabajo en su cola de revisión. */
export const ESTADOS_DTF_POR_REVISAR: EstadoDtf[] = [EstadoDtf.RECIBIDO, EstadoDtf.EN_REVISION];

/**
 * Estados en los que Impresión puede corregir el alto (y con él los metros y el precio): antes de que
 * la película exista. Es la guarda de `ajustarMedidas` Y de la bandera `puedeAjustarMedidas` de la vista:
 * una sola lista para que la pantalla ofrezca exactamente lo que el servidor acepta.
 */
export const ESTADOS_DTF_MEDIDAS_AJUSTABLES: EstadoDtf[] = [
  EstadoDtf.RECIBIDO,
  EstadoDtf.EN_REVISION,
  EstadoDtf.NECESITA_CORRECCION,
  EstadoDtf.APROBADO,
];

/** Estados en los que tiene sentido prometer (y ajustar) una hora de entrega. Guarda de `horaEstimada` y de `puedeAjustarHora`. */
export const ESTADOS_DTF_CON_HORA: EstadoDtf[] = [
  EstadoDtf.RECIBIDO,
  EstadoDtf.EN_REVISION,
  EstadoDtf.APROBADO,
  EstadoDtf.EN_IMPRESION,
];

export const TRANSICIONES_DTF: Record<EstadoDtf, EstadoDtf[]> = {
  [EstadoDtf.BORRADOR]: [
    EstadoDtf.RECIBIDO,
    EstadoDtf.ARCHIVO_PENDIENTE,
    EstadoDtf.CANCELADO,
    EstadoDtf.EXPIRADO,
  ],
  [EstadoDtf.ARCHIVO_PENDIENTE]: [EstadoDtf.RECIBIDO, EstadoDtf.CANCELADO],
  [EstadoDtf.RECIBIDO]: [
    EstadoDtf.EN_REVISION,
    EstadoDtf.APROBADO,
    EstadoDtf.NECESITA_CORRECCION,
    EstadoDtf.RECHAZADO,
    EstadoDtf.CANCELADO,
  ],
  [EstadoDtf.EN_REVISION]: [
    EstadoDtf.RECIBIDO, // soltar / llegó una versión nueva
    EstadoDtf.APROBADO,
    EstadoDtf.NECESITA_CORRECCION,
    EstadoDtf.RECHAZADO,
    EstadoDtf.CANCELADO,
  ],
  // El cliente sube la versión nueva y vuelve a la cola CONSERVANDO su lugar (`recibidoAt`).
  [EstadoDtf.NECESITA_CORRECCION]: [EstadoDtf.RECIBIDO, EstadoDtf.RECHAZADO, EstadoDtf.CANCELADO],
  [EstadoDtf.APROBADO]: [
    EstadoDtf.EN_IMPRESION,
    EstadoDtf.RECIBIDO, // llegó una versión nueva después de aprobar
    EstadoDtf.NECESITA_CORRECCION,
    EstadoDtf.CANCELADO,
  ],
  // IMPRESO → EN_IMPRESION es "reimprimir" (falla de la máquina o defecto hallado al entregar).
  [EstadoDtf.EN_IMPRESION]: [EstadoDtf.IMPRESO, EstadoDtf.EN_IMPRESION, EstadoDtf.CANCELADO],
  [EstadoDtf.IMPRESO]: [EstadoDtf.EN_IMPRESION],
  [EstadoDtf.RECHAZADO]: [],
  [EstadoDtf.CANCELADO]: [],
  [EstadoDtf.EXPIRADO]: [],
};

export function transicionDtfPermitida(de: EstadoDtf, a: EstadoDtf): boolean {
  return TRANSICIONES_DTF[de].includes(a);
}

type DbConPedidoDtf = { pedidoDtf: Prisma.TransactionClient['pedidoDtf'] };

/**
 * ¿Cuántos trabajos DTF mantienen a este pedido esperando? Es LA pregunta del gate (PLAN-DTF.md D13):
 * se calcula, no se guarda en un contador del pedido que pueda desincronizarse.
 */
export async function contarDtfPendientes(db: DbConPedidoDtf, pedidoId: number): Promise<number> {
  return db.pedidoDtf.count({
    where: { pedidoId, estado: { in: ESTADOS_DTF_PENDIENTES } },
  });
}

/** Suma de los trabajos que se cobran. Es lo que `recalcularTotalesPedido` agrega al total. */
export async function sumarDtfDelPedido(
  db: DbConPedidoDtf,
  pedidoId: number,
): Promise<Prisma.Decimal> {
  const filas = await db.pedidoDtf.findMany({
    where: { pedidoId, estado: { in: ESTADOS_DTF_QUE_SE_COBRAN } },
    select: { subtotal: true },
  });
  return filas.reduce((acc, f) => acc.plus(f.subtotal), new Prisma.Decimal(0));
}
