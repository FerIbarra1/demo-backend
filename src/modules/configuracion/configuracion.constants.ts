/** Clave de la tabla `configuracion_sitio` que guarda el logo de los correos. */
export const CLAVE_LOGO = 'logo';

/**
 * Tamaño máximo del logo (2 MB). Más holgado que las imágenes de producto
 * (5 MB) no hace falta: un logo para correo se ve a ~180 px de ancho.
 */
export const LIMITE_LOGO_BYTES = 2 * 1024 * 1024;
