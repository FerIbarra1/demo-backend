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
 * F21 (oct 2026): de dónde volvió el pedido, a partir del estado anterior.
 *
 * Es la fuente única de la procedencia. La usan los dos consumidores:
 *   - `derivarMotivoReingreso` (el monitor y la cola de bodega), que además
 *     exige que el pedido esté en la cola y sin asignar.
 *   - `obtenerAjustesEntrega` (la tarjeta de ajustes), que ya sabe qué hay que
 *     mover y solo necesita la procedencia para redactar la línea.
 *
 * El caso que arregla: un pedido que vuelve de `ESPERANDO_APROBACION` porque el
 * asesor quitó mercancía de la bolsa caía a `null`, y la tarjeta le decía al
 * bodeguero "El cliente aprobó una propuesta del asesor" — que describe una
 * aprobación, no un retiro. Decirle lo que de verdad tiene que hacer es la
 * diferencia entre que mire la bolsa o no.
 *
 * Devuelve `null` cuando no se puede saber de dónde vino (un pedido que nunca
 * salió de bodega). El caller decide qué copy usar en ese caso.
 */
export function motivoDeReingreso(
  estadoAnterior: EstadoPedido | null,
): MotivoReingreso | null {
  switch (estadoAnterior) {
    case EstadoPedido.REVISADO:
      return 'AJUSTE_MOSTRADOR';
    case EstadoPedido.ESPERANDO_APROBACION:
      return 'PROPUESTA_VENTAS';
    case EstadoPedido.EN_ASESORIA:
      return 'ASESORIA';
    case EstadoPedido.EN_REVISION:
      return 'LIBERADO';
    default:
      return null;
  }
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

  /**
   * F21 (oct 2026): la procedencia la resuelve `motivoDeReingreso`, la MISMA
   * función que usa la tarjeta de ajustes del área de entrega.
   *
   * Antes esta función tenía su propia copia de la cadena de `if`, y exigía
   * `itemsNuevos > 0` para `AJUSTE_MOSTRADOR` y `PROPUESTA_VENTAS`. Eso dejaba
   * fuera un caso que el negocio SÍ produce: **un ajuste que solo quita
   * productos o baja cantidades no crea ninguna línea nueva**, así que
   * `itemsNuevos` daba 0 y el badge caía a `null` — el bodeguero recibía el
   * pedido sin saber por qué le llegó.
   *
   * `items` ya no participa en la derivación. Se conserva en la interfaz porque
   * el monitor lo necesita para otras cosas (marcar el pedido como "vino con
   * cambios"), pero la procedencia sale solo del estado anterior — que es el
   * dato que de verdad la determina.
   */
  return motivoDeReingreso(pedido.historial[0]?.estadoAnterior ?? null);
}

