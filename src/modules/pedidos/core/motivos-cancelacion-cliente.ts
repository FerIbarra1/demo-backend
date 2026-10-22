import { BadRequestException } from '@nestjs/common';

/**
 * Oct 2026 — el catálogo de motivos con los que el CLIENTE puede explicar por qué cancela (opcional, como Amazon/Uber).
 *
 * Es para el negocio (analítica): se guarda en `PedidoCancelacionCliente` y lo ve el gerente/admin en el detalle del
 * pedido. NUNCA va al historial ni al correo del cliente. Vive en el servidor y el frontend lo pide
 * (`GET cliente/pedidos/motivos-cancelacion`) en vez de copiarlo: si mañana cambia una etiqueta, cambia en un solo sitio.
 *
 * Los códigos son slugs en una columna `String` (no un enum de la BD): el catálogo puede crecer sin migración, igual que
 * `PedidoIntervencion.tipo`. Lo que sí es estable es el CÓDIGO: la analítica agrupa por él, así que una etiqueta se puede
 * reescribir pero un código no se reutiliza para otra cosa.
 */
export interface MotivoCancelacion {
  codigo: string;
  /** Lo que lee el cliente en la lista corta. */
  etiqueta: string;
  /** Pide un texto libre (solo «Otro»). */
  pideDetalle: boolean;
}

export const MOTIVOS_CANCELACION_CLIENTE: readonly MotivoCancelacion[] = [
  { codigo: 'CAMBIE_DE_OPINION', etiqueta: 'Cambié de opinión', pideDetalle: false },
  { codigo: 'ME_EQUIVOQUE', etiqueta: 'Me equivoqué de pedido', pideDetalle: false },
  { codigo: 'TARDO_MUCHO', etiqueta: 'Tardó mucho', pideDetalle: false },
  { codigo: 'MEJOR_PRECIO', etiqueta: 'Encontré un mejor precio', pideDetalle: false },
  { codigo: 'OTRO', etiqueta: 'Otro motivo', pideDetalle: true },
];

export const CODIGOS_MOTIVO_CANCELACION: readonly string[] = MOTIVOS_CANCELACION_CLIENTE.map(
  (m) => m.codigo,
);

/** Largo máximo del texto libre de «Otro» (la columna es `VarChar(200)`). */
export const MAX_DETALLE_MOTIVO = 200;

export function etiquetaDeMotivo(codigo: string): string {
  return MOTIVOS_CANCELACION_CLIENTE.find((m) => m.codigo === codigo)?.etiqueta ?? codigo;
}

/**
 * Lo que el cliente mandó, ya limpio, o `null` si omitió el motivo (que es lo normal: es opcional).
 *
 * El servicio es frontera de confianza propia (lo llaman también las pruebas): aunque el DTO ya validó el formato,
 * las combinaciones se comprueban aquí.
 *   · texto sin motivo → 400 (¿de qué es el texto?).
 *   · texto con un motivo que no es «Otro» → 400 (la pantalla solo lo pide con «Otro»; aceptarlo en silencio guardaría
 *     algo que el cliente no vio asociado a ese motivo).
 *   · «Otro» sin texto → vale: elegirlo ya es un dato.
 * Un texto de puros espacios cuenta como omitido.
 */
export function motivoElegido(dto: {
  motivo?: string | null;
  detalle?: string | null;
}): { motivo: string; detalle: string | null } | null {
  const detalle = (dto.detalle ?? '').replace(/\s+/g, ' ').trim();
  if (!dto.motivo) {
    if (detalle) {
      throw new BadRequestException('Elige un motivo para poder guardar tu comentario.');
    }
    return null;
  }
  const def = MOTIVOS_CANCELACION_CLIENTE.find((m) => m.codigo === dto.motivo);
  if (!def) throw new BadRequestException('Ese motivo no está en la lista.');
  if (detalle && !def.pideDetalle) {
    throw new BadRequestException('Solo puedes escribir un comentario si eliges «Otro motivo».');
  }
  if (detalle.length > MAX_DETALLE_MOTIVO) {
    throw new BadRequestException(
      `Tu comentario es muy largo (máximo ${MAX_DETALLE_MOTIVO} caracteres).`,
    );
  }
  return { motivo: def.codigo, detalle: detalle || null };
}
