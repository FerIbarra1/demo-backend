/**
 * Oct 2026 (B3): el segundo factor del aviso de llegada en el kiosko.
 *
 * El folio del Sistema Comercial es consecutivo y público (sale en el ticket, en la TV de pared los
 * últimos 4 dígitos), así que por sí solo no demuestra que quien teclea es el dueño del pedido: con la
 * tablet de la tienda cualquiera podía "avisar" pedidos ajenos y ver nombre, artículos y total. Quien
 * TECLEA un folio también teclea los últimos 4 dígitos del teléfono con el que pidió. El QR firmado no
 * lo necesita: la firma ya es la prueba.
 *
 * Dos piezas puras (sin Prisma ni Nest) para poder probarlas con un reloj falso:
 *  - `ultimos4` / `telefonoCoincide`: la comparación.
 *  - `LimiteIntentosLlegada`: cuántos fallos aguanta un folio y un kiosko antes de mandar al cliente a
 *    mostrador.
 */

/** Últimos 4 dígitos de un teléfono ("+52 662 123 4567" → "4567"); `null` si no hay 4 dígitos. */
export function ultimos4(telefono: string | null | undefined): string | null {
  const digitos = (telefono ?? '').replace(/\D/g, '');
  return digitos.length >= 4 ? digitos.slice(-4) : null;
}

/**
 * ¿Los 4 dígitos tecleados son los últimos del teléfono de ALGUNO de los candidatos?
 *
 * El pedido guarda `clienteTelefono` (el que escribió al pedir) y el usuario tiene el suyo en su perfil:
 * cualquiera de los dos vale, porque el cliente puede recordar uno u otro. Un pedido sin ningún teléfono
 * nunca coincide: no hay forma de verificarlo y el cliente pasa a mostrador (el operador marca la llegada).
 */
export function telefonoCoincide(
  telefono4: string,
  ...candidatos: Array<string | null | undefined>
): boolean {
  if (!/^\d{4}$/.test(telefono4)) return false;
  return candidatos.some((c) => ultimos4(c) === telefono4);
}

/** Cuántos fallos aguanta UN folio en UN kiosko antes de bloquearse. */
export const FALLOS_POR_FOLIO = 5;
/** Tope de fallos de UN kiosko (cualquier folio): contiene el barrido de folios con teléfono al azar. */
export const FALLOS_POR_KIOSKO = 30;
/** Ventana en la que cuentan los fallos. */
export const VENTANA_INTENTOS_MS = 10 * 60 * 1000;

/** Claves de memoria máximas antes de purgar las vencidas (un kiosko real genera un puñado). */
const MAX_CLAVES = 2000;

/**
 * Cuenta los intentos fallidos de aviso por folio, EN MEMORIA del proceso.
 *
 * En memoria a propósito: es una contención de fuerza bruta de 10 minutos, no un dato. Reiniciar el
 * servidor la limpia, y con varios procesos cada uno cuenta aparte (el límite efectivo se multiplica, no
 * desaparece). Un acierto limpia el contador de ese folio: el cliente que se equivocó dos veces y luego
 * lo logró no queda castigado.
 *
 * La clave del folio es el folio NORMALIZADO que teclearon, no el pedido que resolvió: "no existe" y
 * "el teléfono no coincide" tienen que contar igual, o el contador sería un oráculo de qué folios existen.
 */
export class LimiteIntentosLlegada {
  private readonly porFolio = new Map<string, number[]>();
  private readonly porKiosko = new Map<number, number[]>();

  constructor(private readonly reloj: () => number = () => Date.now()) {}

  /** Folios con fallos en memoria (para comprobar que el mapa no crece sin tope). */
  get claves(): number {
    return this.porFolio.size;
  }

  /** ¿Ya no se puede intentar con este folio (o desde este kiosko)? No registra nada. */
  bloqueado(kioskoId: number, folio: string): boolean {
    const ahora = this.reloj();
    return (
      this.vigentes(this.porFolio.get(this.clave(kioskoId, folio)), ahora).length >=
        FALLOS_POR_FOLIO ||
      this.vigentes(this.porKiosko.get(kioskoId), ahora).length >= FALLOS_POR_KIOSKO
    );
  }

  /** Anota un fallo (folio inexistente o teléfono distinto). */
  registrarFallo(kioskoId: number, folio: string): void {
    const ahora = this.reloj();
    this.purgarSiHaceFalta(ahora);
    const k = this.clave(kioskoId, folio);
    this.porFolio.set(k, [...this.vigentes(this.porFolio.get(k), ahora), ahora]);
    this.porKiosko.set(kioskoId, [...this.vigentes(this.porKiosko.get(kioskoId), ahora), ahora]);
  }

  /**
   * Un acierto limpia el contador del folio. El del kiosko NO se toca: es el tope contra el barrido, y
   * un atacante que acierta uno de cada 20 no debe reiniciarlo.
   */
  registrarAcierto(kioskoId: number, folio: string): void {
    this.porFolio.delete(this.clave(kioskoId, folio));
  }

  private clave(kioskoId: number, folio: string): string {
    return `${kioskoId}:${folio}`;
  }

  private vigentes(marcas: number[] | undefined, ahora: number): number[] {
    return (marcas ?? []).filter((t) => ahora - t < VENTANA_INTENTOS_MS);
  }

  private purgarSiHaceFalta(ahora: number): void {
    if (this.porFolio.size < MAX_CLAVES) return;
    for (const [k, marcas] of this.porFolio) {
      if (this.vigentes(marcas, ahora).length === 0) this.porFolio.delete(k);
    }
    // Si TODAS siguen vigentes (un ataque en curso) se descartan las más viejas: preferible a crecer sin tope.
    if (this.porFolio.size >= MAX_CLAVES) {
      const primeras = [...this.porFolio.keys()].slice(0, Math.floor(MAX_CLAVES / 2));
      for (const k of primeras) this.porFolio.delete(k);
    }
  }
}
