import { detectarMimeComprobante, extensionDeMime } from './validar-comprobante.util';

const relleno = Buffer.alloc(32, 1);

describe('detectarMimeComprobante', () => {
  it('reconoce JPEG, PNG y WEBP por su firma', () => {
    expect(
      detectarMimeComprobante(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), relleno])),
    ).toBe('image/jpeg');
    expect(
      detectarMimeComprobante(
        Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), relleno]),
      ),
    ).toBe('image/png');
    expect(
      detectarMimeComprobante(
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.from([1, 2, 3, 4]),
          Buffer.from('WEBP'),
          relleno,
        ]),
      ),
    ).toBe('image/webp');
  });

  it('reconoce PDF (lo que exportan las apps de banco)', () => {
    expect(detectarMimeComprobante(Buffer.concat([Buffer.from('%PDF-1.7\n'), relleno]))).toBe(
      'application/pdf',
    );
  });

  it('rechaza lo que se hace pasar por otra cosa', () => {
    expect(
      detectarMimeComprobante(Buffer.from('<html><script>alert(1)</script></html>')),
    ).toBeNull();
    expect(
      detectarMimeComprobante(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    ).toBeNull();
    // un .wav empieza con RIFF pero no es WEBP
    expect(
      detectarMimeComprobante(
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.from([1, 2, 3, 4]),
          Buffer.from('WAVE'),
          relleno,
        ]),
      ),
    ).toBeNull();
    // "PDF" a media frase no es un PDF
    expect(detectarMimeComprobante(Buffer.concat([Buffer.from('xx%PDF-1.7'), relleno]))).toBeNull();
  });

  it('rechaza vacíos y archivos demasiado cortos', () => {
    expect(detectarMimeComprobante(Buffer.alloc(0))).toBeNull();
    expect(detectarMimeComprobante(Buffer.from('%PDF-'))).toBeNull();
  });

  it('la extensión sale del tipo detectado, nunca del nombre que mande el cliente', () => {
    expect(extensionDeMime('application/pdf')).toBe('pdf');
    expect(extensionDeMime('image/jpeg')).toBe('jpg');
  });
});
