import { LimiteDeIntentos } from './limite-intentos';

const MIN = 60_000;

function limite(opciones: Partial<ConstructorParameters<typeof LimiteDeIntentos>[0]> = {}) {
  let ahora = 1_000_000;
  const l = new LimiteDeIntentos(
    { maximo: 3, ventanaMs: 10 * MIN, maxClaves: 50, ...opciones },
    () => ahora,
  );
  return { l, avanzar: (ms: number) => (ahora += ms) };
}

describe('LimiteDeIntentos', () => {
  it('no bloquea antes del tope y bloquea al llegar a él', () => {
    const { l } = limite();
    l.registrarFallo('a');
    l.registrarFallo('a');
    expect(l.bloqueado('a')).toBe(false);
    l.registrarFallo('a');
    expect(l.bloqueado('a')).toBe(true);
  });

  it('cuenta por clave: bloquear una no toca a las demás', () => {
    const { l } = limite();
    for (let i = 0; i < 3; i++) l.registrarFallo('a');
    expect(l.bloqueado('a')).toBe(true);
    expect(l.bloqueado('b')).toBe(false);
  });

  it('la ventana es deslizante: se libera cuando el fallo MÁS VIEJO caduca, no todo de golpe', () => {
    const { l, avanzar } = limite();
    l.registrarFallo('a'); // t=0
    avanzar(4 * MIN);
    l.registrarFallo('a'); // t=4
    avanzar(4 * MIN);
    l.registrarFallo('a'); // t=8 → bloqueada
    expect(l.bloqueado('a')).toBe(true);

    // Falta lo que tarda en caducar el MÁS VIEJO (t=0 → vence en t=10), no el más reciente.
    expect(l.segundosParaLiberar('a')).toBe(2 * 60);

    avanzar(1 * MIN + 1); // t=9: el de t=0 aún vive (vence en t=10)
    expect(l.bloqueado('a')).toBe(true);
    avanzar(1 * MIN); // t=10: caduca el primero → quedan 2 fallos
    expect(l.bloqueado('a')).toBe(false);
  });

  it('segundosParaLiberar dice cuánto falta y es 0 si no está bloqueada', () => {
    const { l, avanzar } = limite();
    expect(l.segundosParaLiberar('a')).toBe(0);
    for (let i = 0; i < 3; i++) l.registrarFallo('a');
    expect(l.segundosParaLiberar('a')).toBe(600);
    avanzar(5 * MIN);
    expect(l.segundosParaLiberar('a')).toBe(300);
    avanzar(5 * MIN);
    expect(l.segundosParaLiberar('a')).toBe(0);
  });

  it('limpiar (un acierto) reinicia la cuenta', () => {
    const { l } = limite();
    l.registrarFallo('a');
    l.registrarFallo('a');
    l.limpiar('a');
    l.registrarFallo('a');
    l.registrarFallo('a');
    expect(l.bloqueado('a')).toBe(false);
  });

  describe('memoria acotada (la clave la controla quien ataca)', () => {
    it('purga las claves vencidas al llenarse', () => {
      const { l, avanzar } = limite({ maxClaves: 10 });
      for (let i = 0; i < 10; i++) l.registrarFallo(`viejo-${i}`);
      expect(l.claves).toBe(10);
      avanzar(11 * MIN); // todas vencen
      l.registrarFallo('nuevo');
      expect(l.claves).toBe(1);
    });

    it('si TODAS siguen vigentes (ataque en curso) descarta las más antiguas y no crece sin tope', () => {
      const { l } = limite({ maxClaves: 10 });
      for (let i = 0; i < 1000; i++) l.registrarFallo(`atacante-${i}`);
      expect(l.claves).toBeLessThanOrEqual(10);
      // La más reciente sobrevive; la primera ya fue descartada.
      l.registrarFallo('atacante-1000');
      expect(l.claves).toBeLessThanOrEqual(10);
    });

    it('pasado el tope, "cuánto falta" sigue siendo exacto (por clave solo se guardan las últimas `maximo` marcas)', () => {
      const { l, avanzar } = limite();
      // 5 fallos espaciados 1 min (maximo=3): t=0,1,2,3,4. Queda libre cuando el conteo baja de 3, o sea cuando
      // caduca el de t=2 → t=12. Con t=4 en el reloj faltan 8 min. Si se guardaran todas las marcas se anunciaría
      // la caducidad del primero (t=10) y el cliente reintentaría 2 minutos antes de poder.
      for (let i = 0; i < 5; i++) {
        l.registrarFallo('a');
        if (i < 4) avanzar(MIN);
      }
      expect(l.segundosParaLiberar('a')).toBe(8 * 60);

      avanzar(8 * MIN - 1);
      expect(l.bloqueado('a')).toBe(true);
      avanzar(1);
      expect(l.bloqueado('a')).toBe(false);
    });
  });
});
