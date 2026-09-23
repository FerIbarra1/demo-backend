/** Clave de la tabla `configuracion_sitio` que guarda el logo de los correos. */
export const CLAVE_LOGO = 'logo';

/**
 * Tamaño máximo del logo (2 MB). Más holgado que las imágenes de producto
 * (5 MB) no hace falta: un logo para correo se ve a ~180 px de ancho.
 */
export const LIMITE_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * PR5 (kiosko-profesional): claves de configuración del kiosko. Cada
 * clave corresponde a un valor en `configuracion_sitio.valor`.
 *
 * - kiosko_idle_media: JSON array de keys S3 (prefijo kiosko/idle/).
 *   Cada key se sube con POST /configuracion/kiosko/media y se
 *   resuelve a URL pública con StorageService.resolverImagen.
 * - kiosko_idle_titulo / kiosko_idle_subtitulo: copy del idle.
 * - kiosko_idle_slide_ms: duración de cada slide en ms (default 7000).
 * - app_download_url: URL que se muestra en /kiosko/exito y en el QR
 *   que apunta a la app del cliente.
 */
export const CLAVE_KIOSKO_IDLE_MEDIA = 'kiosko_idle_media';
export const CLAVE_KIOSKO_IDLE_TITULO = 'kiosko_idle_titulo';
export const CLAVE_KIOSKO_IDLE_SUBTITULO = 'kiosko_idle_subtitulo';
export const CLAVE_KIOSKO_IDLE_SLIDE_MS = 'kiosko_idle_slide_ms';
export const CLAVE_APP_DOWNLOAD_URL = 'app_download_url';

/** Prefijo S3 para archivos subidos desde el panel de branding. */
export const PREFIJO_KIOSKO_IDLE = 'kiosko/idle/';

/** Tamaño máximo de cada imagen del slideshow. */
export const LIMITE_KIOSKO_IDLE_BYTES = 5 * 1024 * 1024;
