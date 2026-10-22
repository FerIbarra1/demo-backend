import { construirInstrucciones, formatearMonto } from './instrucciones.util';

const base = {
  folio: 'PD-2026-000123',
  monto: '1500.5',
  cuenta: {
    banco: 'BBVA',
    titular: 'PUNTO TEXTIL SA DE CV',
    clabe: '012180001234567899',
  },
  referencia: '4821907',
  concepto: 'PD2026000123',
};

describe('construirInstrucciones', () => {
  const r = construirInstrucciones(base);
  const valorDe = (etiqueta: string) => r.lineas.find((l) => l.etiqueta === etiqueta);

  it('trae todos los datos que el cliente necesita, en el orden en que los captura', () => {
    expect(r.lineas.map((l) => l.etiqueta)).toEqual([
      'Banco',
      'Beneficiario',
      'CLABE',
      'Monto exacto',
      'Referencia',
      'Concepto',
    ]);
  });

  it('la CLABE se COPIA sin espacios y se MUESTRA agrupada', () => {
    expect(valorDe('CLABE')).toMatchObject({
      valor: '012180001234567899',
      mostrar: '012 180 00123456789 9',
      copiable: true,
    });
  });

  it('el monto a copiar no lleva "$" ni separadores; el que se muestra sí', () => {
    expect(valorDe('Monto exacto')?.valor).toBe('1500.50');
    expect(valorDe('Monto exacto')?.mostrar).toMatch(/1,500\.50/);
  });

  it('la referencia es la de 7 dígitos y el concepto el alfanumérico', () => {
    expect(valorDe('Referencia')?.valor).toBe('4821907');
    expect(valorDe('Concepto')?.valor).toBe('PD2026000123');
  });

  it('el texto plano contiene todo y se puede pegar tal cual', () => {
    expect(r.texto).toContain('pedido PD-2026-000123');
    expect(r.texto).toContain('CLABE: 012180001234567899');
    expect(r.texto).toContain('Referencia: 4821907');
    expect(r.texto).toContain('EXACTO');
    // sin HTML ni marcas
    expect(r.texto).not.toMatch(/<|&nbsp;/);
  });

  it('incluye la cuenta solo si existe, y las instrucciones extra del negocio', () => {
    expect(valorDe('Cuenta')).toBeUndefined();
    const con = construirInstrucciones({
      ...base,
      cuenta: {
        ...base.cuenta,
        cuenta: '0123456789',
        instrucciones: ' Solo desde banca en línea. ',
      },
    });
    expect(con.lineas.find((l) => l.etiqueta === 'Cuenta')?.valor).toBe('0123456789');
    expect(con.notas[con.notas.length - 1]).toBe('Solo desde banca en línea.');
  });

  it('con enlace al pedido lo menciona para subir el comprobante', () => {
    const con = construirInstrucciones({ ...base, pedidoUrl: 'https://tienda.test/pedidos/9' });
    expect(con.texto).toContain('https://tienda.test/pedidos/9');
  });

  it('formatea pesos mexicanos', () => {
    expect(formatearMonto(1500)).toMatch(/1,500\.00/);
    expect(formatearMonto('99.9')).toMatch(/99\.90/);
  });
});
