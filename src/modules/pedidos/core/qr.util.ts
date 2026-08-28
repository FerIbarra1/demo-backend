import QRCode from 'qrcode';

/**
 * Genera un data URL (base64 PNG) de un QR para el valor dado.
 * Se usa para embebir el QR del folio VFP en el email y en la web.
 */
export async function generarQrDataUrl(valor: string): Promise<string> {
  return QRCode.toDataURL(valor, { width: 200, margin: 1 });
}
