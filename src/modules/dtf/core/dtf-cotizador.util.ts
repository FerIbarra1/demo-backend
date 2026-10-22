import { Prisma } from '@prisma/client';

/**
 * Impresión DTF — cuánto se cobra por un archivo. Ver PLAN-DTF.md §8.
 *
 * El cliente NO teclea metros: el archivo trae su tamaño y de ahí sale la cotización. La regla de
 * redondeo es de NEGOCIO y todavía no está confirmada con el cliente (la hoja del 02/10 cambia el
 * ingreso hasta 21 % entre "exacto" y "metro completo"), por eso vive en parámetros por tipo
 * (`DtfTipo.pasoCobroCm`, `DtfTipo.minimoCm`) y no en el código:
 *
 *   cmCobrados     = max( minimoCm,  ceil(alto / pasoCobroCm) × pasoCobroCm )
 *   metrosCobrados = cmCobrados × copias / 100
 *   subtotal       = metrosCobrados × precioMetro
 *
 *   pasoCobroCm: 100 = metro completo · 50 = medio metro · 20 = de 20 en 20 · 1 = exacto.
 *
 * Con el default de la demo (Textil: paso 50, mínimo 50) 0.5 → 0.5 m, 0.6 → 1.0 m y 2.6 → 3.0 m:
 * concuerda con "se imprime a partir de medio metro" y con "se cobra el metro aunque hagas 0.6".
 */
export interface ReglasCobro {
  minimoCm: number;
  pasoCobroCm: number;
}

/** El PDF trae 100.0004 cm por redondeo de puntos: se mide a milímetro para no cobrar un paso de más. */
export function redondearCm(cm: number): number {
  return Math.round(cm * 10) / 10;
}

export function cmCobrados(altoCm: number, reglas: ReglasCobro): number {
  const alto = redondearCm(altoCm);
  const paso = Math.max(1, reglas.pasoCobroCm);
  // El epsilon evita que 100 / 50 = 2.0000000000000004 cobre un paso de más.
  const porPaso = Math.ceil(alto / paso - 1e-9) * paso;
  return Math.max(reglas.minimoCm, porPaso);
}

export function metrosCobrados(
  altoCm: number,
  copias: number,
  reglas: ReglasCobro,
): Prisma.Decimal {
  const copiasOk = Math.max(1, Math.floor(copias || 1));
  return new Prisma.Decimal(cmCobrados(altoCm, reglas)).mul(copiasOk).div(100).toDecimalPlaces(2);
}

export function subtotalDtf(
  metros: Prisma.Decimal | number,
  precioMetro: Prisma.Decimal | number,
): Prisma.Decimal {
  return new Prisma.Decimal(metros).mul(new Prisma.Decimal(precioMetro)).toDecimalPlaces(2);
}

export interface CotizacionDtf {
  altoCm: number;
  cmCobrados: number;
  metrosCobrados: Prisma.Decimal;
  precioMetro: Prisma.Decimal;
  subtotal: Prisma.Decimal;
}

export function cotizar(
  altoCm: number,
  copias: number,
  reglas: ReglasCobro,
  precioMetro: Prisma.Decimal | number,
): CotizacionDtf {
  const metros = metrosCobrados(altoCm, copias, reglas);
  const precio = new Prisma.Decimal(precioMetro);
  return {
    altoCm: redondearCm(altoCm),
    cmCobrados: cmCobrados(altoCm, reglas),
    metrosCobrados: metros,
    precioMetro: precio,
    subtotal: subtotalDtf(metros, precio),
  };
}
