/**
 * Motivos predefinidos de "pedir corrección" y de "rechazar". Son códigos ESTABLES (se guardan en
 * `PedidoDtf.correccionMotivos` / `rechazoMotivo`) con el texto que lee el CLIENTE ya redactado:
 * Impresión elige chips en lugar de escribir lo mismo veinte veces al día, y el cliente recibe una
 * explicación clara en lugar de "tu archivo está mal". La nota libre se suma a estos.
 */
export interface MotivoDtf {
  codigo: string;
  /** Etiqueta corta para el chip del encargado. */
  etiqueta: string;
  /** Lo que lee el cliente. */
  texto: string;
}

export const MOTIVOS_CORRECCION: MotivoDtf[] = [
  {
    codigo: 'FONDO',
    etiqueta: 'Tiene fondo',
    texto:
      'El archivo trae fondo (blanco o de color). La máquina lo imprimiría. Expórtalo con fondo transparente.',
  },
  {
    codigo: 'MEDIDAS',
    etiqueta: 'Medidas incorrectas',
    texto:
      'Las medidas no son las correctas. Debe medir 57 cm de ancho y, de alto, al menos el mínimo del tipo de DTF; todo en tamaño real.',
  },
  {
    codigo: 'RESOLUCION',
    etiqueta: 'Resolución baja',
    texto:
      'La imagen tiene poca resolución y se vería pixelada. Necesitamos 300 DPI en tamaño real.',
  },
  {
    codigo: 'TEXTO_CHICO',
    etiqueta: 'Letra muy chica',
    texto:
      'Hay letras o líneas muy pequeñas que se pierden al imprimir. Agrándalas o engrosa el trazo.',
  },
  {
    codigo: 'COLOR',
    etiqueta: 'Modo de color',
    texto: 'El archivo está en RGB. Expórtalo en CMYK para que los colores salgan como esperas.',
  },
  {
    codigo: 'TRANSPARENCIAS',
    etiqueta: 'Sombras / transparencias',
    texto:
      'Hay sombras o degradados con transparencia que dejan halos blancos al imprimir. Conviértelos en color sólido.',
  },
  {
    codigo: 'ARCHIVO_DANADO',
    etiqueta: 'No abre / dañado',
    texto: 'El archivo no se puede abrir o está dañado. Súbelo de nuevo.',
  },
  {
    codigo: 'OTRO',
    etiqueta: 'Otro',
    texto: 'Hay un detalle que necesitamos que revises (lo explicamos abajo).',
  },
];

export const MOTIVOS_RECHAZO: MotivoDtf[] = [
  {
    codigo: 'NO_SE_PUEDE',
    etiqueta: 'No se puede imprimir',
    texto: 'Este diseño no se puede imprimir con la calidad que necesita.',
  },
  {
    codigo: 'CONTENIDO',
    etiqueta: 'Contenido no permitido',
    texto: 'No podemos imprimir este contenido (marca registrada o derechos de autor).',
  },
  {
    codigo: 'ARCHIVO_INVALIDO',
    etiqueta: 'Archivo inválido',
    texto: 'El archivo no es válido y no se pudo recuperar.',
  },
  {
    codigo: 'OTRO',
    etiqueta: 'Otro',
    texto: 'No pudimos procesar este trabajo (el motivo está abajo).',
  },
];

export const MOTIVOS_REIMPRESION = [
  { codigo: 'FALLA_MAQUINA', etiqueta: 'Falla de la máquina' },
  { codigo: 'PELICULA', etiqueta: 'Película dañada' },
  { codigo: 'COLOR', etiqueta: 'Color fuera de tono' },
  { codigo: 'DEFECTO_ENTREGA', etiqueta: 'Defecto hallado al entregar' },
  { codigo: 'OTRO', etiqueta: 'Otro' },
] as const;

const porCodigo = (lista: MotivoDtf[]) => new Map(lista.map((m) => [m.codigo, m]));
const CORRECCION = porCodigo(MOTIVOS_CORRECCION);
const RECHAZO = porCodigo(MOTIVOS_RECHAZO);

export function motivoCorreccionValido(codigo: string): boolean {
  return CORRECCION.has(codigo);
}
export function motivoRechazoValido(codigo: string): boolean {
  return RECHAZO.has(codigo);
}
export function textoMotivoCorreccion(codigo: string): string {
  return CORRECCION.get(codigo)?.texto ?? codigo;
}
export function textoMotivoRechazo(codigo: string): string {
  return RECHAZO.get(codigo)?.texto ?? codigo;
}
