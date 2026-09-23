/**
 * Validación por firma binaria (magic bytes) en vez del `mimetype` que declara
 * el cliente. Un `.svg` o `.html` renombrado a `.jpg` llega con
 * `mimetype: "image/jpeg"` pero su contenido no lo es; si ese valor se usa como
 * `ContentType` en un bucket público, el atacante controla cómo lo sirve S3.
 *
 * Se implementa a mano en vez de usar `file-type` porque esa librería es
 * ESM-only desde la v17 y este proyecto compila a CommonJS.
 */

export type MimeImagen = 'image/jpeg' | 'image/png' | 'image/webp';

/** Firmas soportadas. `offset` es la posición donde debe empezar la secuencia. */
const FIRMAS: Array<{ mime: MimeImagen; offset: number; bytes: number[] }> = [
  // JPEG: FF D8 FF
  { mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  {
    mime: 'image/png',
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  // WEBP: "RIFF" en 0 y "WEBP" en 8 (contenedor RIFF)
  { mime: 'image/webp', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
];

/**
 * Devuelve el MIME real detectado por firma, o `null` si no coincide con
 * ninguno de los formatos permitidos.
 */
export function detectarMimeImagen(buffer: Buffer): MimeImagen | null {
  if (!buffer || buffer.length < 12) return null;

  for (const firma of FIRMAS) {
    const coincide = firma.bytes.every(
      (b, i) => buffer[firma.offset + i] === b,
    );
    if (!coincide) continue;

    // WEBP necesita además "WEBP" en el offset 8: un .wav también empieza
    // con "RIFF" y sin esta comprobación pasaría como imagen.
    if (firma.mime === 'image/webp') {
      const esWebp =
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50;
      if (!esWebp) continue;
    }

    return firma.mime;
  }

  return null;
}
