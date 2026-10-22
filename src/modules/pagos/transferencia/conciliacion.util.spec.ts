import {
  FilaConciliacion,
  celdaSegura,
  construirCsv,
  esFechaYmd,
  fechaCsv,
  hoyLocal,
  medianocheLocal,
  rangoDeDias,
  sumarDias,
} from './conciliacion.util';

describe('esFechaYmd', () => {
  it('acepta fechas reales y rechaza formatos raros y días que no existen', () => {
    expect(esFechaYmd('2026-10-16')).toBe(true);
    expect(esFechaYmd('2028-02-29')).toBe(true); // bisiesto
    expect(esFechaYmd('2026-02-29')).toBe(false);
    expect(esFechaYmd('2026-02-31')).toBe(false);
    expect(esFechaYmd('2026-13-01')).toBe(false);
    expect(esFechaYmd('16/10/2026')).toBe(false);
    expect(esFechaYmd('2026-10-16T00:00:00Z')).toBe(false);
    expect(esFechaYmd('')).toBe(false);
  });
});

describe('medianocheLocal / rangoDeDias (el día es del NEGOCIO, no de UTC)', () => {
  it('Ciudad de México (UTC-6 todo el año desde 2022): la medianoche local son las 06:00Z', () => {
    expect(medianocheLocal('2026-10-16', 'America/Mexico_City').toISOString()).toBe(
      '2026-10-16T06:00:00.000Z',
    );
  });

  it('Tijuana con horario de verano (UTC-7 en octubre) y sin él (UTC-8 en diciembre)', () => {
    expect(medianocheLocal('2026-10-16', 'America/Tijuana').toISOString()).toBe(
      '2026-10-16T07:00:00.000Z',
    );
    expect(medianocheLocal('2026-12-16', 'America/Tijuana').toISOString()).toBe(
      '2026-12-16T08:00:00.000Z',
    );
  });

  it('el día en que cambia el horario no se desfasa (Tijuana, fin del horario de verano 2026-11-01)', () => {
    // Esa noche el reloj se atrasa una hora: la medianoche del 1° aún es UTC-7 y la del 2° ya UTC-8.
    expect(medianocheLocal('2026-11-01', 'America/Tijuana').toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
    expect(medianocheLocal('2026-11-02', 'America/Tijuana').toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
  });

  it('el rango incluye el día `hasta` ENTERO: termina en la medianoche del siguiente', () => {
    const { inicio, fin } = rangoDeDias('2026-10-15', '2026-10-16', 'America/Mexico_City');
    expect(inicio.toISOString()).toBe('2026-10-15T06:00:00.000Z');
    expect(fin.toISOString()).toBe('2026-10-17T06:00:00.000Z');
  });

  it('un cobro de las 9 p.m. del día 15 en México cae en el día 15 aunque en UTC ya sea el 16', () => {
    const cobro = new Date('2026-10-16T03:00:00.000Z'); // 21:00 del 15 en México
    const { inicio, fin } = rangoDeDias('2026-10-15', '2026-10-15', 'America/Mexico_City');
    expect(cobro >= inicio && cobro < fin).toBe(true);
    const otroDia = rangoDeDias('2026-10-16', '2026-10-16', 'America/Mexico_City');
    expect(cobro >= otroDia.inicio && cobro < otroDia.fin).toBe(false);
  });
});

describe('sumarDias / hoyLocal', () => {
  it('suma por calendario, cruzando mes y año', () => {
    expect(sumarDias('2026-10-31', 1)).toBe('2026-11-01');
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDias('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('hoy es el del negocio, no el de UTC', () => {
    const casiMedianocheUtc = new Date('2026-10-16T02:00:00.000Z'); // 20:00 del 15 en México
    expect(hoyLocal('America/Mexico_City', casiMedianocheUtc)).toBe('2026-10-15');
    expect(hoyLocal('UTC', casiMedianocheUtc)).toBe('2026-10-16');
  });
});

describe('celdaSegura (inyección de fórmulas en Excel)', () => {
  it('antepone una comilla a lo que empieza con = + - @ tab o retorno', () => {
    expect(celdaSegura('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`);
    expect(celdaSegura('+52 686 123')).toBe(`'+52 686 123`);
    expect(celdaSegura('-cmd')).toBe(`'-cmd`);
    expect(celdaSegura('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(celdaSegura('\tx')).toBe(`'\tx`);
  });

  it('deja intacto el texto normal y los nulos', () => {
    expect(celdaSegura('María López')).toBe('María López');
    expect(celdaSegura('Ref = 123')).toBe('Ref = 123'); // el = no está al inicio
    expect(celdaSegura(null)).toBe('');
    expect(celdaSegura(undefined)).toBe('');
  });
});

describe('construirCsv', () => {
  const zona = 'America/Mexico_City';
  const fila = (extra: Partial<FilaConciliacion> = {}): FilaConciliacion => ({
    verificadoAt: new Date('2026-10-16T21:30:00.000Z'), // 15:30 en México
    abonoFecha: new Date('2026-10-16T21:00:00.000Z'),
    aplicadoAt: null,
    tienda: 'Punto Textil Mexicali',
    folioWeb: 'PD2026000123',
    folioVfp: 'F123',
    cliente: 'Juan Pérez',
    referencia: '3340781',
    claveRastreo: 'MBAN01002610160123456789',
    montoEsperado: '2340.50',
    montoVerificado: '2340.50',
    estado: 'VERIFICADO',
    verificadoPor: 'Tesorera Uno',
    ...extra,
  });

  it('empieza con BOM (los acentos de Excel), trae el encabezado y usa CRLF', () => {
    const csv = construirCsv([fila()], zona);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lineas = csv.slice(1).split('\r\n');
    expect(lineas[0]).toBe(
      'Verificada,Abono reflejado,Registrada en el Sistema Comercial,Tienda,Folio web,Folio Sistema Comercial,Cliente,Referencia,Clave de rastreo,Monto esperado,Monto verificado,Estado,Verificó',
    );
    expect(lineas).toHaveLength(3); // encabezado, fila, y la línea vacía del CRLF final
  });

  it('las fechas van en la zona del negocio y los montos son números sin símbolo', () => {
    const [, datos] = construirCsv([fila()], zona).slice(1).split('\r\n');
    expect(datos.startsWith('2026-10-16 15:30,2026-10-16 15:00,,')).toBe(true);
    expect(datos).toContain(',2340.50,2340.50,VERIFICADO,');
    expect(datos).not.toContain('$');
  });

  it('escapa comas, comillas y saltos de línea dentro de una celda', () => {
    const [, datos] = construirCsv([fila({ cliente: 'Pérez, "El Güero"\nJr.' })], zona)
      .slice(1)
      .split('\r\n');
    expect(datos).toContain('"Pérez, ""El Güero""\nJr."');
  });

  it('neutraliza una fórmula en un campo de texto libre', () => {
    const csv = construirCsv([fila({ cliente: '=1+1' })], zona);
    expect(csv).toContain(`'=1+1`);
    expect(csv).not.toContain(',=1+1,');
  });

  it('sin filas devuelve solo el encabezado', () => {
    expect(construirCsv([], zona).slice(1).split('\r\n')).toHaveLength(2);
  });

  it('fechaCsv de null es vacío', () => {
    expect(fechaCsv(null, zona)).toBe('');
  });
});
