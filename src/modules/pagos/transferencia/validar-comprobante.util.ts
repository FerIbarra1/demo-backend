import { detectarMimeImagen } from '../../imagenes/validar-imagen.util';

export type MimeComprobante = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

const EXTENSION: Record<MimeComprobante, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * Tipo REAL del archivo, por su firma binaria y no por el `mimetype` que declara el cliente (que
 * es libre). Imágenes por `detectarMimeImagen` + PDF, que es lo que exportan las apps de banco.
 * Devuelve null si no es ninguno: un `.html` o `.svg` renombrado a `.jpg` no pasa.
 */
export function detectarMimeComprobante(buffer: Buffer): MimeComprobante | null {
  if (!buffer || buffer.length < 12) return null;
  const imagen = detectarMimeImagen(buffer);
  if (imagen) return imagen;
  // "%PDF-" en el offset 0.
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return 'application/pdf';
  }
  return null;
}

export function extensionDeMime(mime: MimeComprobante): string {
  return EXTENSION[mime];
}
