import { digitoControlClabe, esClabeValida, formatearClabe, normalizarClabe } from './clabe.util';

describe('clabe.util', () => {
  it('acepta CLABEs con dígito de control correcto', () => {
    // La primera es el ejemplo de la documentación pública de Banxico; la segunda es la de demo del seed.
    expect(esClabeValida('002010077777777771')).toBe(true);
    expect(esClabeValida('012180001234567899')).toBe(true);
  });

  it('rechaza un dígito de control equivocado', () => {
    expect(esClabeValida('002010077777777772')).toBe(false);
    expect(esClabeValida('012180001234567890')).toBe(false);
  });

  it('atrapa el error de dedo más común: un dígito cambiado o dos intercambiados', () => {
    const buena = '002010077777777771';
    // un dígito distinto
    expect(esClabeValida(buena.replace('2010', '2011'))).toBe(false);
    // dos dígitos intercambiados (posiciones con pesos distintos)
    expect(esClabeValida('002010077777777717')).toBe(false);
  });

  it('rechaza longitud incorrecta y caracteres que no son dígitos', () => {
    expect(esClabeValida('')).toBe(false);
    expect(esClabeValida('00201007777777777')).toBe(false); // 17
    expect(esClabeValida('0020100777777777711')).toBe(false); // 19
    expect(esClabeValida('00201007777777777A')).toBe(false);
  });

  it('acepta espacios y guiones al capturar', () => {
    expect(esClabeValida('0020 1007 7777 7777 71')).toBe(true);
    expect(esClabeValida('002-010-07777777777-1')).toBe(true);
    expect(normalizarClabe(' 002 010-07777777777 1 ')).toBe('002010077777777771');
  });

  it('calcula el dígito de control', () => {
    expect(digitoControlClabe('00201007777777777')).toBe(1);
    expect(() => digitoControlClabe('123')).toThrow();
  });

  it('formatea para mostrar', () => {
    expect(formatearClabe('012180001234567899')).toBe('012 180 00123456789 9');
    expect(formatearClabe('123')).toBe('123');
  });
});
