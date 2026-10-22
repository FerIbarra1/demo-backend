import { Prisma } from '@prisma/client';
import { cmCobrados, cotizar, metrosCobrados, redondearCm } from './dtf-cotizador.util';

const TEXTIL = { minimoCm: 50, pasoCobroCm: 50 };
const TEXTIL_METRO = { minimoCm: 50, pasoCobroCm: 100 };
const UV = { minimoCm: 20, pasoCobroCm: 20 };

describe('cotizador DTF', () => {
  describe('cmCobrados — la regla de redondeo es configurable', () => {
    it.each([
      // [alto, paso medio metro, paso metro completo]
      [50, 50, 100],
      [62, 100, 100],
      [100, 100, 100],
      [120, 150, 200],
      [260, 300, 300],
      [30, 50, 100], // por debajo del mínimo se cobra el mínimo
    ])('alto %s cm → %s (medio metro) / %s (metro completo)', (alto, medio, metro) => {
      expect(cmCobrados(alto, TEXTIL)).toBe(medio);
      expect(cmCobrados(alto, TEXTIL_METRO)).toBe(metro);
    });

    it('UV: de 20 en 20 y mínimo 20 cm', () => {
      expect(cmCobrados(20, UV)).toBe(20);
      expect(cmCobrados(25, UV)).toBe(40);
      expect(cmCobrados(5, UV)).toBe(20);
    });

    it('no cobra un paso de más por el ruido de punto flotante de un PDF de 1 m exacto', () => {
      expect(redondearCm(100.0004)).toBe(100);
      expect(cmCobrados(100.0004, TEXTIL)).toBe(100);
      expect(cmCobrados(150.04, TEXTIL)).toBe(150);
    });
  });

  describe('la hoja del 02/10: lo que sale con el default de la demo (medio metro)', () => {
    // Metros reales de los 16 trabajos Textil de la hoja (alto del archivo = metros × 100).
    const textil = [0.6, 1, 0.6, 0.5, 0.5, 4.5, 0.5, 2.5, 1, 1, 2, 2, 1.5, 1, 2.6, 0.5];
    const suma = (reglas: typeof TEXTIL) =>
      textil.reduce((acc, m) => acc + cmCobrados(m * 100, reglas) / 100, 0);

    it('exacto 22.3 m · medio metro 23.5 m · metro completo 27 m', () => {
      expect(Number(textil.reduce((a, m) => a + m, 0).toFixed(1))).toBe(22.3);
      expect(suma(TEXTIL)).toBeCloseTo(23.5, 5);
      expect(suma(TEXTIL_METRO)).toBeCloseTo(27, 5);
    });

    it('a $220 el metro: $5,170 con medio metro y $5,940 con metro completo', () => {
      expect(suma(TEXTIL) * 220).toBeCloseTo(5170, 5);
      expect(suma(TEXTIL_METRO) * 220).toBeCloseTo(5940, 5);
    });
  });

  describe('metros y subtotal', () => {
    it('las copias multiplican los metros cobrados', () => {
      expect(metrosCobrados(62, 1, TEXTIL).toString()).toBe('1');
      expect(metrosCobrados(62, 3, TEXTIL).toString()).toBe('3');
      expect(metrosCobrados(62, 0, TEXTIL).toString()).toBe('1'); // copias inválidas → 1
    });

    it('cotizar devuelve Decimal exacto, sin error de punto flotante', () => {
      const c = cotizar(120, 1, TEXTIL, new Prisma.Decimal('220'));
      expect(c.cmCobrados).toBe(150);
      expect(c.metrosCobrados.toString()).toBe('1.5');
      expect(c.subtotal.toString()).toBe('330');
      // 0.2 m a $600 (UV) = $120, no 119.99999
      const uv = cotizar(20, 1, UV, 600);
      expect(uv.subtotal.toString()).toBe('120');
    });
  });
});
