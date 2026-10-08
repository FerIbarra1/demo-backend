import { EstadoPedido } from '@prisma/client';

/**
 * F16 (sep 2026): por qué un pedido volvió a la cola de bodega.
 *
 * Un pedido en `EN_REVISION` sin asignar puede haber llegado ahí por varios
 * caminos, y antes se veían idénticos en el monitor (todos caían en
 * `esLiberado`). Los que traen trabajo real:
 *
 *   LIBERADO         — otro bodeguero lo soltó. Nada nuevo que surtir.
 *   AJUSTE_MOSTRADOR — el cliente cambió algo en tienda. Surtir lo nuevo.
 *   PROPUESTA_VENTAS — el cliente aprobó la contrapropuesta del asesor.
 *                      Surtir lo que el asesor propuso.
 *   ASESORIA         — el asesor devolvió el pedido: revisó con el cliente y el
 *                      pedido original estaba bien. Surtir tal cual.
 *
 * El discriminador sale de datos que ya existen: `ItemPedido.original = false`
 * solo lo setean los caminos que AGREGAN productos (ventas y el ajuste de
 * mostrador), y el último `HistorialPedido.estadoAnterior` dice de dónde vino.
 *
 * Vive aquí (y no en el DTO) porque lo comparten el service y el DTO.
 */
export type MotivoReingreso =
  | 'LIBERADO'
  | 'AJUSTE_MOSTRADOR'
  | 'PROPUESTA_VENTAS'
  | 'ASESORIA';

/** Lo mínimo que la derivación necesita de un pedido. */
export interface PedidoParaMotivo {
  estado: EstadoPedido;
  asignadoAId: number | null;
  /** Items NO cancelados: solo importa `original`. */
  items: Array<{ original: boolean }>;
  /** El último cambio de estado, del más reciente al más viejo. */
  historial: Array<{ estadoAnterior: EstadoPedido | null }>;
}

/**
 * Deriva por qué un pedido está de vuelta en la cola de bodega.
 *
 * F17 (oct 2026): se extrajo del monitor (`monitor.service.ts`) porque ahora la
 * cola de `/bodega` necesita el MISMO cálculo para pintar el badge "Liberado
 * por Ana". Copiarlo habría sido el error que `aplicarCambiosFisicos` vino a
 * corregir: dos implementaciones que divergen sin que nada lo detecte.
 *
 * Devuelve `null` cuando el pedido nunca salió de bodega (es nuevo) o cuando ya
 * está asignado a alguien (en ese caso vive en el slot del bodeguero, no en la
 * cola).
 */
export function derivarMotivoReingreso(pedido: PedidoParaMotivo): MotivoReingreso | null {
  // Solo aplica a lo que está EN LA COLA: sin asignar.
  if (pedido.estado !== EstadoPedido.EN_REVISION || pedido.asignadoAId !== null) {
    return null;
  }

  const itemsNuevos = pedido.items.filter((i) => !i.original).length;
  const estadoAnterior = pedido.historial[0]?.estadoAnterior ?? null;

  if (itemsNuevos > 0 && estadoAnterior === EstadoPedido.REVISADO) {
    return 'AJUSTE_MOSTRADOR';
  }
  if (itemsNuevos > 0 && estadoAnterior === EstadoPedido.ESPERANDO_APROBACION) {
    return 'PROPUESTA_VENTAS';
  }
  // Oct 2026: el asesor devolvió el pedido a bodega. Sin este caso el bodeguero
  // recibía el pedido SIN saber por qué le llegó — y el badge del monitor caía
  // al genérico. No lleva `itemsNuevos` porque el asesor no agregó nada: revisó
  // con el cliente y el pedido original estaba bien.
  if (estadoAnterior === EstadoPedido.EN_ASESORIA) {
    return 'ASESORIA';
  }
  if (estadoAnterior === EstadoPedido.EN_REVISION) {
    return 'LIBERADO';
  }
  return null;
}
