/** Formato REAL por firma binaria, no por la extensión ni el `mimetype` que declara el cliente. Solo PDF y PNG. */
export type FormatoDtf = 'pdf' | 'png';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectarFormatoDtf(cabecera: Buffer): FormatoDtf | null {
  if (!cabecera || cabecera.length < 8) return null;
  if (PNG.every((b, i) => cabecera[i] === b)) return 'png';
  // "%PDF-" casi siempre en el offset 0; la especificación tolera basura en el primer KB.
  const idx = cabecera.subarray(0, 1024).indexOf('%PDF-');
  if (idx >= 0 && idx < 1024) return 'pdf';
  return null;
}

export const MIME_DTF: Record<FormatoDtf, string> = { pdf: 'application/pdf', png: 'image/png' };
