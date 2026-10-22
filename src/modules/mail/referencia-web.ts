import type { PrismaClient } from '@prisma/client';

/**
 * Oct 2026 — el puente entre los dos números que el cliente ve de su pedido.
 *
 * El correo de "recibido" (y el kiosko) le dicen `PD-2026-000018`. Cuando bodega cierra el surtido el pedido recibe su
 * folio del Sistema Comercial (`HMO-0000152573`), que es el que lleva el ticket y el que le piden en mostrador; desde ese
 * momento los correos y la pantalla lo llaman así. Sin una palabra de por medio, el cliente ve dos números distintos y no
 * sabe si es el mismo pedido.
 *
 * Por eso el PRIMER correo que ya lleva el folio añade una línea: "Pedido en línea: PD-2026-000018". Solo el primero: los
 * correos no repiten datos (`correos.spec`) y el cliente ya hizo la conexión. La pantalla del pedido sí lo deja siempre.
 *
 * "Primero" = ningún correo exitoso de este pedido desde que se asignó el folio (`PedidoFolioSolicitud.asignadoAt`). Un
 * pedido cuyo folio es anterior a ese registro (los que la migración ya trajo con folio) no tiene fecha de asignación y
 * no lleva la línea: no se sabría cuál fue el primero.
 */
export async function referenciaWebDelPrimerCorreo(
  db: Pick<PrismaClient, 'pedidoFolioSolicitud' | 'notificacion'>,
  pedido: { id: number; numeroPedido: string; folioErp?: string | null },
): Promise<string | null> {
  if (!pedido.folioErp) return null;
  const solicitud = await db.pedidoFolioSolicitud.findUnique({
    where: { pedidoId: pedido.id },
    select: { asignadoAt: true },
  });
  if (!solicitud?.asignadoAt) return null;
  const previos = await db.notificacion.count({
    where: {
      pedidoId: pedido.id,
      canal: 'EMAIL',
      exitosa: true,
      enviadaAt: { gte: solicitud.asignadoAt },
    },
  });
  return previos === 0 ? pedido.numeroPedido : null;
}
