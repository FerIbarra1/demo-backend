/**
 * Oct 2026: cuenta fallos por clave dentro de una ventana deslizante, EN MEMORIA del proceso.
 *
 * Es la contención de fuerza bruta del login por CUENTA: el límite por IP (`@Throttle`) no ve a un atacante que
 * reparte los intentos entre muchas IP, ni el contrario, a seis empleados tras una misma IP pública que no deben
 * bloquearse entre sí. Dos ejes distintos, dos contadores.
 *
 * En memoria a propósito: no es un dato, es un freno de 10 minutos. Reiniciar el servidor lo limpia, y con varios
 * procesos cada uno cuenta aparte (el tope efectivo se multiplica, no desaparece).
 *
 * Acotada en dos sentidos, porque una clave la controla quien ataca (un correo cualquiera):
 *  - por clave guarda solo las últimas `maximo` marcas (con eso basta para saber si está bloqueada);
 *  - en total guarda `maxClaves`: al llenarse purga las vencidas y, si un ataque las mantiene todas vigentes,
 *    descarta las más antiguas. Es preferible perder el freno de una cuenta vieja a crecer sin tope.
 *
 * Pura (sin Nest ni Prisma) y con reloj inyectable para probarla sin esperar.
 */
export interface OpcionesLimite {
  /** Fallos que se toleran dentro de la ventana; al llegar a este número la clave queda bloqueada. */
  maximo: number;
  ventanaMs: number;
  maxClaves: number;
}

export class LimiteDeIntentos {
  private readonly marcas = new Map<string, number[]>();

  constructor(
    private readonly opciones: OpcionesLimite,
    private readonly reloj: () => number = () => Date.now(),
  ) {}

  /** Claves con fallos en memoria (para comprobar que el mapa no crece sin tope). */
  get claves(): number {
    return this.marcas.size;
  }

  /** ¿Ya no se puede intentar con esta clave? No registra nada. */
  bloqueado(clave: string): boolean {
    return this.vigentes(clave, this.reloj()).length >= this.opciones.maximo;
  }

  /** Segundos hasta que el fallo más antiguo de la ventana caduque y la clave se libere (0 si no está bloqueada). */
  segundosParaLiberar(clave: string): number {
    const ahora = this.reloj();
    const vigentes = this.vigentes(clave, ahora);
    if (vigentes.length < this.opciones.maximo) return 0;
    return Math.max(1, Math.ceil((vigentes[0] + this.opciones.ventanaMs - ahora) / 1000));
  }

  registrarFallo(clave: string): void {
    const ahora = this.reloj();
    this.purgarSiHaceFalta(ahora);
    const nuevas = [...this.vigentes(clave, ahora), ahora].slice(-this.opciones.maximo);
    // delete + set: la clave pasa al final del orden de inserción, que es el que usa la purga forzada.
    this.marcas.delete(clave);
    this.marcas.set(clave, nuevas);
  }

  /**
   * Quita el fallo más reciente. Para quien anota el intento ANTES de comprobarlo (así una ráfaga concurrente no pasa
   * toda el chequeo) y después descubre que no fue un fallo del usuario sino del servidor (la BD se cayó a media
   * comprobación): ese intento no puede contar contra la cuenta.
   */
  deshacerUltimo(clave: string): void {
    const marcas = this.marcas.get(clave);
    if (!marcas) return;
    marcas.pop();
    if (marcas.length === 0) this.marcas.delete(clave);
  }

  /** Un acierto limpia la clave: quien se equivocó dos veces y luego entró no queda castigado. */
  limpiar(clave: string): void {
    this.marcas.delete(clave);
  }

  private vigentes(clave: string, ahora: number): number[] {
    return (this.marcas.get(clave) ?? []).filter((t) => ahora - t < this.opciones.ventanaMs);
  }

  private purgarSiHaceFalta(ahora: number): void {
    const { maxClaves, ventanaMs } = this.opciones;
    if (this.marcas.size < maxClaves) return;
    for (const [k, marcas] of this.marcas) {
      if (!marcas.some((t) => ahora - t < ventanaMs)) this.marcas.delete(k);
    }
    if (this.marcas.size >= maxClaves) {
      const antiguas = [...this.marcas.keys()].slice(0, Math.floor(maxClaves / 2));
      for (const k of antiguas) this.marcas.delete(k);
    }
  }
}
