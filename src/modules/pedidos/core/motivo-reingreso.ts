/**
 * F16 (sep 2026): por qué un pedido volvió a la cola de bodega.
 *
 * Un pedido en `REVIEWING` sin asignar puede haber llegado ahí por tres
 * caminos, y antes se veían idénticos en el monitor (todos caían en
 * `esLiberado`). Dos de ellos traen trabajo real:
 *
 *   LIBERADO         — otro bodeguero lo soltó. Nada nuevo que surtir.
 *   AJUSTE_MOSTRADOR — el cliente cambió algo en tienda. Surtir lo nuevo.
 *   PROPUESTA_VENTAS — el cliente aprobó la contrapropuesta del asesor.
 *                      Surtir lo que el asesor propuso.
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
  | 'PROPUESTA_VENTAS';
