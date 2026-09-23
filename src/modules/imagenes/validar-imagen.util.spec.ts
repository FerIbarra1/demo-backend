import { detectarMimeImagen } from './validar-imagen.util';

/** Construye un buffer con la firma indicada y relleno hasta 16 bytes. */
const conFirma = (bytes: number[], relleno = 0x00): Buffer =>
  Buffer.concat([Buffer.from(bytes), Buffer.alloc(16 - bytes.length, relleno)]);

describe('detectarMimeImagen', () => {
  it('detecta JPEG por su firma FF D8 FF', () => {
    expect(detectarMimeImagen(conFirma([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
  });

  it('detecta PNG por su firma de 8 bytes', () => {
    const png = conFirma([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectarMimeImagen(png)).toBe('image/png');
  });

  it('detecta WEBP por RIFF + WEBP', () => {
    const webp = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // tamaño
      Buffer.from([0x57, 0x45, 0x42, 0x50]), // WEBP
      Buffer.alloc(8),
    ]);
    expect(detectarMimeImagen(webp)).toBe('image/webp');
  });

  it('rechaza un WAV, que también empieza con RIFF', () => {
    const wav = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46]),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x57, 0x41, 0x56, 0x45]), // WAVE
      Buffer.alloc(8),
    ]);
    expect(detectarMimeImagen(wav)).toBeNull();
  });

  it('rechaza un SVG disfrazado de imagen', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(detectarMimeImagen(svg)).toBeNull();
  });

  it('rechaza HTML disfrazado de imagen', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect(detectarMimeImagen(html)).toBeNull();
  });

  it('rechaza buffers demasiado cortos para tener firma', () => {
    expect(detectarMimeImagen(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('rechaza un buffer vacío', () => {
    expect(detectarMimeImagen(Buffer.alloc(0))).toBeNull();
  });
});
