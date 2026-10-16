/**
 * CLABE interbancaria (18 dígitos): 3 de banco, 3 de plaza, 11 de cuenta y 1 de control.
 *
 * El dígito de control se calcula con los pesos 3-7-1 repetidos sobre los primeros 17 dígitos:
 * cada dígito se multiplica por su peso y se queda con el último dígito del producto; se suman
 * y el control es `(10 - suma % 10) % 10`.
 *
 * Por qué se valida: la CLABE es el dato que un atacante querría cambiar para desviar pagos, y
 * un error de dedo de un administrador manda el dinero de los clientes a un lugar equivocado.
 * El dígito de control atrapa casi todos los errores de captura.
 */
const PESOS = [3, 7, 1] as const;

/** Quita espacios y guiones: se captura "0121 8000 1234 5678 99" y se guarda sin ellos. */
export function normalizarClabe(entrada: string): string {
  return (entrada ?? '').replace(/[\s-]/g, '');
}

/** Dígito de control de los primeros 17 dígitos (lanza si no son 17 dígitos). */
export function digitoControlClabe(primeros17: string): number {
  if (!/^\d{17}$/.test(primeros17)) {
    throw new Error('Se necesitan exactamente 17 dígitos');
  }
  let suma = 0;
  for (let i = 0; i < 17; i++) {
    suma += (Number(primeros17[i]) * PESOS[i % 3]) % 10;
  }
  return (10 - (suma % 10)) % 10;
}

/** ¿Es una CLABE válida (18 dígitos y control correcto)? Acepta espacios y guiones. */
export function esClabeValida(entrada: string): boolean {
  const clabe = normalizarClabe(entrada);
  if (!/^\d{18}$/.test(clabe)) return false;
  return digitoControlClabe(clabe.slice(0, 17)) === Number(clabe[17]);
}

/** "012180001234567899" → "012 180 00123456789 9" (solo para mostrar; se copia sin espacios). */
export function formatearClabe(clabe: string): string {
  const c = normalizarClabe(clabe);
  if (c.length !== 18) return c;
  return `${c.slice(0, 3)} ${c.slice(3, 6)} ${c.slice(6, 17)} ${c.slice(17)}`;
}
