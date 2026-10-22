import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  FALLOS_POR_FOLIO,
  LimiteIntentosLlegada,
  VENTANA_INTENTOS_MS,
  telefonoCoincide,
  ultimos4,
} from './kiosko-llegada-intentos';
import { ResolverLlegadaDto } from './dto/llegada.dto';

/** Las mismas opciones que el `ValidationPipe` de `main.ts`. */
function errores(dto: object): string[] {
  const e = validateSync(plainToInstance(ResolverLlegadaDto, dto), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return e.flatMap((x) => Object.values(x.constraints ?? {}));
}

describe('ultimos4 / telefonoCoincide', () => {
  it.each([
    ['+526621234567', '4567'],
    ['+52 662 123 4567', '4567'],
    ['(662) 123-4567', '4567'],
    ['4567', '4567'],
  ])('"%s" → %s', (tel, esperado) => {
    expect(ultimos4(tel)).toBe(esperado);
  });

  it.each([null, undefined, '', '123', 'sin telefono'])('%p no tiene 4 dígitos', (tel) => {
    expect(ultimos4(tel as string | null | undefined)).toBeNull();
  });

  it('coincide con cualquiera de los candidatos', () => {
    expect(telefonoCoincide('4567', '+526621234567', '+526629990000')).toBe(true);
    expect(telefonoCoincide('0000', '+526621234567', '+526629990000')).toBe(true);
    expect(telefonoCoincide('1111', '+526621234567', '+526629990000')).toBe(false);
  });

  it('un candidato nulo no coincide con nada (ni con "0000")', () => {
    expect(telefonoCoincide('0000', null, undefined)).toBe(false);
  });

  it.each(['', '123', '12345', 'abcd', '12 4', '١٢٣٤'])(
    'los 4 dígitos mal formados ("%s") nunca coinciden',
    (t) => {
      expect(telefonoCoincide(t, '+526621234567')).toBe(false);
    },
  );
});

describe('LimiteIntentosLlegada', () => {
  function limite() {
    let ahora = 5_000;
    return { l: new LimiteIntentosLlegada(() => ahora), avanzar: (ms: number) => (ahora += ms) };
  }

  it('no bloquea hasta llegar al tope', () => {
    const { l } = limite();
    for (let i = 0; i < FALLOS_POR_FOLIO - 1; i++) l.registrarFallo(1, 'f');
    expect(l.bloqueado(1, 'f')).toBe(false);
    l.registrarFallo(1, 'f');
    expect(l.bloqueado(1, 'f')).toBe(true);
  });

  it('los fallos caducan: justo al cumplirse la ventana ya no cuentan', () => {
    const { l, avanzar } = limite();
    for (let i = 0; i < FALLOS_POR_FOLIO; i++) l.registrarFallo(1, 'f');
    avanzar(VENTANA_INTENTOS_MS - 1);
    expect(l.bloqueado(1, 'f')).toBe(true);
    avanzar(1);
    expect(l.bloqueado(1, 'f')).toBe(false);
  });

  it('el acierto limpia el folio pero no el tope del kiosko', () => {
    const { l } = limite();
    for (let i = 0; i < FALLOS_POR_FOLIO; i++) l.registrarFallo(1, 'f');
    l.registrarAcierto(1, 'f');
    expect(l.bloqueado(1, 'f')).toBe(false);
  });

  it('no crece sin tope bajo un ataque con miles de folios distintos', () => {
    const { l } = limite();
    for (let i = 0; i < 6000; i++) l.registrarFallo(i % 50, `folio-${i}`);
    expect(l.claves).toBeLessThanOrEqual(2000);
  });
});

describe('ResolverLlegadaDto — la frontera del aviso de llegada', () => {
  it('un folio tecleado exige los 4 dígitos', () => {
    expect(errores({ folio: '0000152573' })).toEqual(
      expect.arrayContaining([expect.stringContaining('telefono4')]),
    );
    expect(errores({ folio: '0000152573', telefono4: '12' })).not.toEqual([]);
    expect(errores({ folio: '0000152573', telefono4: '12a4' })).not.toEqual([]);
    expect(errores({ folio: '0000152573', telefono4: '4567' })).toEqual([]);
  });

  it('el QR no necesita teléfono', () => {
    expect(errores({ qr: 'PT1.abc.def' })).toEqual([]);
  });

  it('un campo de más es 400 (antes un tipo inline dejaba pasar cualquier cosa)', () => {
    expect(errores({ qr: 'PT1.abc.def', extra: 1 })).not.toEqual([]);
    expect(errores({ folio: '0000152573', telefono4: '4567', pedidoId: 9 })).not.toEqual([]);
  });

  it('largos razonables: ni un QR ni un folio de megabytes', () => {
    expect(errores({ qr: 'x'.repeat(701) })).not.toEqual([]);
    expect(errores({ folio: 'x'.repeat(33), telefono4: '4567' })).not.toEqual([]);
  });

  it('los tipos importan: un folio numérico o un arreglo no pasan', () => {
    expect(errores({ folio: ['1', '2'], telefono4: '4567' })).not.toEqual([]);
    expect(errores({ qr: { a: 1 } })).not.toEqual([]);
  });
});
