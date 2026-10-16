import { formatearClabe } from '../cuentas/clabe.util';

/**
 * UNA sola función arma las instrucciones de transferencia. La usan el correo, la pantalla del
 * cliente y el botón "Copiar" de Tesorería, así que las tres dicen exactamente lo mismo (antes
 * de centralizarlo, cada superficie reescribía sus textos y terminaban distintos).
 */

export interface CuentaSnapshot {
  banco: string;
  titular: string;
  clabe: string;
  cuenta?: string | null;
  instrucciones?: string | null;
}

export interface LineaInstruccion {
  etiqueta: string;
  /** Valor tal cual se debe pegar en la app del banco (la CLABE, sin espacios). */
  valor: string;
  /** Cómo se muestra en pantalla (la CLABE agrupada). Si falta, se muestra `valor`. */
  mostrar?: string;
  /** ¿El cliente lo va a copiar? Pinta el botón "Copiar" al lado. */
  copiable: boolean;
}

export interface InstruccionesTransferencia {
  lineas: LineaInstruccion[];
  /** Avisos que acompañan a los datos. */
  notas: string[];
  /** Todo lo anterior como texto plano, listo para pegar en WhatsApp o dictar por teléfono. */
  texto: string;
}

export interface DatosInstrucciones {
  folio: string;
  monto: number | string | { toString(): string };
  cuenta: CuentaSnapshot;
  referencia: string;
  concepto: string;
  venceAt: Date;
  zonaHoraria: string;
  /** Enlace al pedido, para subir el comprobante. */
  pedidoUrl?: string;
}

export function formatearMonto(monto: number | string | { toString(): string }): string {
  const n = Number(monto.toString());
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n);
}

export function formatearFechaLarga(fecha: Date, zonaHoraria: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: zonaHoraria,
  }).format(fecha);
}

export function construirInstrucciones(d: DatosInstrucciones): InstruccionesTransferencia {
  const montoTxt = formatearMonto(d.monto);
  const lineas: LineaInstruccion[] = [
    { etiqueta: 'Banco', valor: d.cuenta.banco, copiable: false },
    { etiqueta: 'Beneficiario', valor: d.cuenta.titular, copiable: true },
    {
      etiqueta: 'CLABE',
      valor: d.cuenta.clabe,
      mostrar: formatearClabe(d.cuenta.clabe),
      copiable: true,
    },
  ];
  if (d.cuenta.cuenta) {
    lineas.push({ etiqueta: 'Cuenta', valor: d.cuenta.cuenta, copiable: true });
  }
  lineas.push(
    // Sin "$" ni separadores en `valor`: es lo que se pega en la app del banco.
    {
      etiqueta: 'Monto exacto',
      valor: Number(d.monto.toString()).toFixed(2),
      mostrar: `${montoTxt} MXN`,
      copiable: true,
    },
    { etiqueta: 'Referencia', valor: d.referencia, copiable: true },
    { etiqueta: 'Concepto', valor: d.concepto, copiable: true },
  );

  // "12:25 a.m." ya termina en punto: sin esto la nota salía con ".." al final.
  const vence = formatearFechaLarga(d.venceAt, d.zonaHoraria);
  // Las NOTAS son lo que se muestra junto a la tabla de datos (pantalla y correo), así que no
  // repiten lo que la tabla ya dice: antes la primera nota volvía a escribir el monto (que sale en
  // "Monto exacto") y la última mandaba "sube tu comprobante en tu pedido: <enlace>" a quien ya
  // estaba en su pedido y justo debajo de un botón que decía lo mismo. Ese aviso de "sube tu
  // comprobante" solo tiene sentido en el TEXTO copiable (WhatsApp), donde no hay botón.
  const notas = [
    'Transfiere el monto EXACTO indicado: si es distinto no podremos aplicarlo a tu pedido.',
    'Escribe la referencia y el concepto tal cual: así identificamos tu pago.',
    `Estas instrucciones son válidas hasta el ${vence}${vence.endsWith('.') ? '' : '.'}`,
  ];
  if (d.cuenta.instrucciones?.trim()) notas.push(d.cuenta.instrucciones.trim());

  const texto = [
    `Datos para tu transferencia — pedido ${d.folio}`,
    '',
    ...lineas.map(
      (l) => `${l.etiqueta}: ${l.mostrar && l.etiqueta !== 'CLABE' ? l.mostrar : l.valor}`,
    ),
    '',
    ...notas.map((n) => `• ${n}`),
    ...(d.pedidoUrl ? ['', `Cuando termines, sube tu comprobante aquí: ${d.pedidoUrl}`] : []),
  ].join('\n');

  return { lineas, notas, texto };
}
