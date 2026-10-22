import { BadRequestException } from '@nestjs/common';
import {
  CODIGOS_MOTIVO_CANCELACION,
  etiquetaDeMotivo,
  MAX_DETALLE_MOTIVO,
  MOTIVOS_CANCELACION_CLIENTE,
  motivoElegido,
} from './motivos-cancelacion-cliente';

/**
 * Oct 2026 — el motivo OPCIONAL con el que el cliente explica por qué cancela (como Amazon/Uber).
 * Omitirlo es lo normal y no debe dejar nada; las combinaciones raras se rechazan en el servidor.
 */
describe('el catálogo de motivos', () => {
  it('es corto, con códigos únicos y solo «Otro» pide texto', () => {
    expect(MOTIVOS_CANCELACION_CLIENTE.length).toBeGreaterThanOrEqual(4);
    expect(MOTIVOS_CANCELACION_CLIENTE.length).toBeLessThanOrEqual(6);
    expect(new Set(CODIGOS_MOTIVO_CANCELACION).size).toBe(CODIGOS_MOTIVO_CANCELACION.length);
    const piden = MOTIVOS_CANCELACION_CLIENTE.filter((m) => m.pideDetalle).map((m) => m.codigo);
    expect(piden).toEqual(['OTRO']);
  });

  it('lo que cabe en la BD: el código en VarChar(30)', () => {
    for (const c of CODIGOS_MOTIVO_CANCELACION) expect(c.length).toBeLessThanOrEqual(30);
  });

  it('las etiquetas las lee el cliente: sin jerga interna', () => {
    for (const m of MOTIVOS_CANCELACION_CLIENTE) {
      expect(m.etiqueta).not.toMatch(/bodega|administrador|sistema comercial|vfp|erp|#\d/i);
    }
  });

  it('etiquetaDeMotivo traduce el código y, si ya no existe, devuelve el código tal cual', () => {
    expect(etiquetaDeMotivo('TARDO_MUCHO')).toBe('Tardó mucho');
    expect(etiquetaDeMotivo('MOTIVO_VIEJO')).toBe('MOTIVO_VIEJO');
  });
});

describe('motivoElegido', () => {
  it('omitir el motivo es lo normal: no hay nada que guardar', () => {
    expect(motivoElegido({})).toBeNull();
    expect(motivoElegido({ motivo: undefined, detalle: undefined })).toBeNull();
    expect(motivoElegido({ motivo: null, detalle: null })).toBeNull();
    expect(motivoElegido({ motivo: '', detalle: '   ' })).toBeNull();
  });

  it('un motivo de la lista se guarda sin texto', () => {
    expect(motivoElegido({ motivo: 'CAMBIE_DE_OPINION' })).toEqual({
      motivo: 'CAMBIE_DE_OPINION',
      detalle: null,
    });
  });

  it('«Otro» lleva su texto, limpio de espacios de más', () => {
    expect(motivoElegido({ motivo: 'OTRO', detalle: '  Me  quedé  sin\npresupuesto ' })).toEqual({
      motivo: 'OTRO',
      detalle: 'Me quedé sin presupuesto',
    });
  });

  it('«Otro» sin texto también vale: elegirlo ya es un dato', () => {
    expect(motivoElegido({ motivo: 'OTRO' })).toEqual({ motivo: 'OTRO', detalle: null });
    expect(motivoElegido({ motivo: 'OTRO', detalle: '   ' })).toEqual({
      motivo: 'OTRO',
      detalle: null,
    });
  });

  it('un texto sin motivo es un 400', () => {
    expect(() => motivoElegido({ detalle: 'hola' })).toThrow(BadRequestException);
  });

  it('un texto con un motivo que no es «Otro» es un 400 (no se guarda algo que el cliente no asoció)', () => {
    expect(() => motivoElegido({ motivo: 'TARDO_MUCHO', detalle: 'hola' })).toThrow(
      /solo puedes escribir un comentario/i,
    );
  });

  it('un motivo fuera de la lista es un 400', () => {
    expect(() => motivoElegido({ motivo: 'PORQUE_SI' })).toThrow(BadRequestException);
  });

  it('un texto de más de 200 caracteres es un 400', () => {
    expect(() =>
      motivoElegido({ motivo: 'OTRO', detalle: 'x'.repeat(MAX_DETALLE_MOTIVO + 1) }),
    ).toThrow(BadRequestException);
    expect(
      motivoElegido({ motivo: 'OTRO', detalle: 'x'.repeat(MAX_DETALLE_MOTIVO) })!.detalle,
    ).toHaveLength(MAX_DETALLE_MOTIVO);
  });
});
