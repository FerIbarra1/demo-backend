import { EstadoPedido } from '@prisma/client';

/**
 * Oct 2026: ¿la mercancía de este pedido está en las MANOS de bodega?
 *
 * Decide si una cancelación genera lista de reposición. La regla del negocio:
 *
 *   La reposición es para la mercancía que YA salió de las manos del bodeguero
 *   (la bolsa quedó en el área de entrega y alguien tiene que devolverla al
 *   anaquel). Si el pedido se cancela mientras bodega lo tiene — sin surtir o a
 *   medias — el bodeguero lo trae en las manos, ve el aviso de cancelación y lo
 *   regresa al anaquel él mismo. Una lista de trabajo ahí le pediría confirmar
 *   algo que ya hizo.
 *
 * Tres casos son "en las manos de bodega":
 *
 *   SOLICITADO                    nadie ha tocado el anaquel.
 *   EN_REVISION con bodeguero     lo está surtiendo (o ajustando) ahora mismo.
 *   EN_REVISION sin bodeguero,    en la cola y nunca se cerró un surtido:
 *   nunca surtido                 no hay bolsa en ningún lado (p. ej. lo liberó
 *                                 otro bodeguero a medias).
 *
 * Y uno NO lo es, aunque el estado sea EN_REVISION: el pedido que VOLVIÓ del área
 * de entrega por un ajuste y espera en la cola sin que nadie lo tome. Su bolsa
 * sigue en la mesa, y si se cancela hay que devolverla. Se distingue porque
 * alguna vez salió de EN_REVISION hacia un estado posterior al surtido.
 *
 * Se evalúa ANTES de cancelar y lo decide quien cancela, no `crearDesdePedido`:
 * la máquina de estados corre los `efectos` DESPUÉS de escribir el estado nuevo
 * y de limpiar la asignación, así que desde adentro ya no se puede saber.
 */
export async function bolsaEnManosDeBodega(
  prisma: {
    historialPedido: {
      findFirst(args: {
        where: {
          pedidoId: number;
          estadoAnterior: EstadoPedido;
          estadoNuevo: { in: EstadoPedido[] };
        };
        select: { id: true };
      }): Promise<{ id: number } | null>;
    };
  },
  pedido: { id: number; estado: EstadoPedido; asignadoAId: number | null },
): Promise<boolean> {
  if (pedido.estado === EstadoPedido.SOLICITADO) return true;
  if (pedido.estado !== EstadoPedido.EN_REVISION) return false;
  if (pedido.asignadoAId != null) return true;

  const cerroSurtidoAntes = await prisma.historialPedido.findFirst({
    where: {
      pedidoId: pedido.id,
      estadoAnterior: EstadoPedido.EN_REVISION,
      estadoNuevo: {
        in: [
          EstadoPedido.REVISADO,
          EstadoPedido.ESPERANDO_APROBACION,
          EstadoPedido.PENDIENTE_PAGO,
          // Un pedido con DTF por imprimir cierra el surtido hacia EN_DTF (el gate de la máquina de estados redirige el
          // REVISADO / PENDIENTE_PAGO): ESE es su cierre. Sin él, un mixto que volvió a bodega por un ajuste parecía
          // «nunca surtido», se contaba como «en las manos de bodega» y su cancelación no generaba reposición aunque la
          // bolsa seguía en la mesa.
          EstadoPedido.EN_DTF,
        ],
      },
    },
    select: { id: true },
  });
  return cerroSurtidoAntes == null;
}
