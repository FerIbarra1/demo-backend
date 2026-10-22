'use strict';
/**
 * Genera archivos de ejemplo de DTF (PDF y PNG), unos bien hechos y otros con los errores típicos que
 * el encargado ve a diario: fondo blanco, ancho incorrecto, baja resolución, letra chica, demasiado
 * largo, RGB con sombras, varias páginas.
 *
 * Sirven para (1) probar el motor de revisión automática (`preflight.runner.spec.ts`) y (2) la demo:
 * cada archivo cuenta una historia distinta en el semáforo.
 *
 *   node scripts/dtf-ejemplos.js [carpeta]        → por defecto ./storage-demo/dtf-ejemplos
 *
 * Todo en tamaño real: 1 cm = 72 / 2.54 puntos.
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, cmyk } = require('pdf-lib');
const sharp = require('sharp');

const cm = (v) => (v / 2.54) * 72;

// Paleta CMYK (lo que pide el negocio) y su par RGB para el ejemplo "mal modo de color".
const ROSA = cmyk(0, 0.85, 0.1, 0);
const ROSA_OSC = cmyk(0, 0.95, 0.25, 0.15);
const AZUL = cmyk(0.9, 0.55, 0, 0);
const AMARILLO = cmyk(0, 0.1, 0.95, 0);
const NEGRO = cmyk(0, 0, 0, 1);
const BLANCO = cmyk(0, 0, 0, 0);

async function nuevoPdf(anchoCm, altoCm) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([cm(anchoCm), cm(altoCm)]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, page, bold, normal };
}

/** Texto centrado horizontalmente. */
function centrado(page, texto, font, size, y, color, anchoPag) {
  const w = font.widthOfTextAtSize(texto, size);
  page.drawText(texto, { x: (anchoPag - w) / 2, y, size, font, color });
}

/** Listón rosa de cáncer de mama (vectorial). */
function liston(page, cx, cy, escala, color) {
  const r = cm(6) * escala;
  page.drawCircle({ x: cx - r * 0.45, y: cy + r * 0.45, size: r * 0.55, borderColor: color, borderWidth: r * 0.28 });
  page.drawCircle({ x: cx + r * 0.45, y: cy + r * 0.45, size: r * 0.55, borderColor: color, borderWidth: r * 0.28 });
  page.drawSvgPath('M 0 0 L 90 150 L 130 120 L 40 -20 Z', { x: cx - r * 0.55, y: cy + r * 0.2, scale: escala * 1.5, color });
  page.drawSvgPath('M 0 0 L -90 150 L -130 120 L -40 -20 Z', { x: cx + r * 0.55, y: cy + r * 0.2, scale: escala * 1.5, color });
}

async function guardar(dir, nombre, bytes) {
  const ruta = path.join(dir, nombre);
  fs.writeFileSync(ruta, bytes);
  return ruta;
}

async function generarEjemplos(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = {};

  // 01 — BIEN: 57 × 62 cm, vectorial, CMYK, sin fondo, texto grande.
  {
    const { doc, page, bold } = await nuevoPdf(57, 62);
    liston(page, cm(28.5), cm(40), 1.6, ROSA);
    centrado(page, 'CÁNCER', bold, 110, cm(22), ROSA_OSC, cm(57));
    centrado(page, 'DE MAMA', bold, 110, cm(11), ROSA_OSC, cm(57));
    out.cancerOk = await guardar(dir, '01-cancer-de-mama-OK.pdf', await doc.save());
  }

  // 02 — BIEN: 57 × 100 cm con varios logos (1.0 m).
  {
    const { doc, page, bold } = await nuevoPdf(57, 100);
    const emblemas = [
      ['ÁGUILAS', AZUL, 0],
      ['TIGRES', AMARILLO, 1],
      ['HALCONES', ROSA, 2],
      ['LOBOS', NEGRO, 3],
    ];
    emblemas.forEach(([t, color, i]) => {
      const col = i % 2;
      const fila = Math.floor(i / 2);
      const cx = cm(14 + col * 29);
      const cy = cm(76 - fila * 40);
      page.drawCircle({ x: cx, y: cy, size: cm(11), color });
      page.drawCircle({ x: cx, y: cy, size: cm(9), borderColor: BLANCO, borderWidth: 6 });
      const w = bold.widthOfTextAtSize(t, 34);
      page.drawText(t, { x: cx - w / 2, y: cy - 12, size: 34, font: bold, color: t === 'TIGRES' ? NEGRO : BLANCO });
    });
    out.logosOk = await guardar(dir, '02-logos-equipos-OK.pdf', await doc.save());
  }

  // 03 — FONDO BLANCO: un rectángulo blanco cubre todo el lienzo (el error más común).
  {
    const { doc, page, bold } = await nuevoPdf(57, 50);
    page.drawRectangle({ x: 0, y: 0, width: cm(57), height: cm(50), color: BLANCO });
    page.drawCircle({ x: cm(28.5), y: cm(25), size: cm(18), color: AZUL });
    centrado(page, 'MEXICALI', bold, 90, cm(21), BLANCO, cm(57));
    out.fondoBlanco = await guardar(dir, '03-fondo-blanco.pdf', await doc.save());
  }

  // 04 — ANCHO INCORRECTO: 61 × 80 cm.
  {
    const { doc, page, bold } = await nuevoPdf(61, 80);
    page.drawCircle({ x: cm(30.5), y: cm(40), size: cm(22), color: ROSA });
    centrado(page, 'VERANO', bold, 100, cm(36), BLANCO, cm(61));
    out.anchoMal = await guardar(dir, '04-ancho-incorrecto.pdf', await doc.save());
  }

  // 05 — BAJA RESOLUCIÓN: una foto de 400 × 400 px colocada a 30 × 30 cm (≈ 34 ppi).
  {
    const { doc, page, bold } = await nuevoPdf(57, 60);
    const foto = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 30, g: 110, b: 200 } },
    })
      .composite([{ input: Buffer.from(`<svg width="400" height="400"><circle cx="200" cy="200" r="150" fill="#ffd23f"/></svg>`), top: 0, left: 0 }])
      .png()
      .toBuffer();
    const img = await doc.embedPng(foto);
    page.drawImage(img, { x: cm(13.5), y: cm(15), width: cm(30), height: cm(30) });
    centrado(page, 'FOTO DEL EQUIPO', bold, 60, cm(7), NEGRO, cm(57));
    out.bajaRes = await guardar(dir, '05-baja-resolucion.pdf', await doc.save());
  }

  // 06 — LETRA CHICA: 4 pt debajo del mínimo.
  {
    const { doc, page, bold, normal } = await nuevoPdf(57, 50);
    liston(page, cm(28.5), cm(33), 1.3, ROSA);
    centrado(page, 'CAMINATA POR LA VIDA', bold, 70, cm(14), ROSA_OSC, cm(57));
    centrado(page, 'sábado 25 de octubre · parque central · inscripciones abiertas', normal, 4, cm(8), NEGRO, cm(57));
    out.letraChica = await guardar(dir, '06-letra-chica.pdf', await doc.save());
  }

  // 07 — DEMASIADO LARGO: 57 × 270 cm.
  {
    const { doc, page, bold } = await nuevoPdf(57, 270);
    page.drawCircle({ x: cm(28.5), y: cm(135), size: cm(25), color: AZUL });
    centrado(page, 'ENORME', bold, 160, cm(125), BLANCO, cm(57));
    out.muyLargo = await guardar(dir, '07-muy-largo.pdf', await doc.save());
  }

  // 08 — RGB + SOMBRAS: colores RGB y una sombra semitransparente enorme.
  {
    const { doc, page, bold } = await nuevoPdf(57, 60);
    for (let i = 0; i < 6; i++) {
      page.drawCircle({ x: cm(28.5), y: cm(30), size: cm(20 - i * 1.2), color: rgb(0.1, 0.4, 0.9), opacity: 0.14 });
    }
    page.drawCircle({ x: cm(28.5), y: cm(30), size: cm(11), color: rgb(1, 0.2, 0.4) });
    centrado(page, 'NEÓN', bold, 120, cm(25), rgb(1, 1, 1), cm(57));
    out.rgbSombras = await guardar(dir, '08-rgb-con-sombras.pdf', await doc.save());
  }

  // 09 — UV BIEN: 57 × 20 cm con nombres (mínimo UV).
  {
    const { doc, page, bold } = await nuevoPdf(57, 20);
    ['SOFÍA', 'MATEO', 'VALERIA', 'DIEGO'].forEach((n, i) => {
      page.drawRectangle({ x: cm(1 + i * 14), y: cm(4), width: cm(13), height: cm(12), color: i % 2 ? AZUL : ROSA, borderColor: NEGRO, borderWidth: 1 });
      const w = bold.widthOfTextAtSize(n, 24);
      page.drawText(n, { x: cm(1 + i * 14 + 6.5) - w / 2, y: cm(9.5), size: 24, font: bold, color: BLANCO });
    });
    out.nombresUv = await guardar(dir, '09-nombres-UV-OK.pdf', await doc.save());
  }

  // 10 — PNG SIN TRANSPARENCIA: fondo blanco sólido (a 100 ppi: 57 × 50 cm = 2244 × 1969 px).
  {
    const w = 2244;
    const h = 1969;
    const svg = `<svg width="${w}" height="${h}"><rect width="100%" height="100%" fill="white"/><circle cx="${w / 2}" cy="${h / 2}" r="700" fill="#e11d74"/><text x="${w / 2}" y="${h / 2 + 40}" text-anchor="middle" font-size="200" font-family="Helvetica" font-weight="bold" fill="white">VERANO</text></svg>`;
    const png = await sharp(Buffer.from(svg)).withMetadata({ density: 100 }).png().toBuffer();
    out.pngFondo = await guardar(dir, '10-png-fondo-blanco.png', png);
  }

  // 11 — PNG BIEN: transparente, 57 × 60 cm a 300 ppi = 6732 × 7087 px (solo contenido; comprime bien).
  {
    const w = 6732;
    const h = 7087;
    const svg = `<svg width="${w}" height="${h}"><circle cx="${w / 2}" cy="${h / 2 - 300}" r="2400" fill="#1d4ed8"/><circle cx="${w / 2}" cy="${h / 2 - 300}" r="2000" fill="none" stroke="white" stroke-width="60"/><text x="${w / 2}" y="${h / 2 + 150}" text-anchor="middle" font-size="720" font-family="Helvetica" font-weight="bold" fill="white">HALCONES</text></svg>`;
    const png = await sharp(Buffer.from(svg)).withMetadata({ density: 300 }).png({ compressionLevel: 9 }).toBuffer();
    out.pngOk = await guardar(dir, '11-png-transparente-OK.png', png);
  }

  // 12 — OCUPA POCO: lienzo de 250 cm con un diseño que ocupa los primeros 40 cm ("podrías ahorrar").
  {
    const { doc, page, bold } = await nuevoPdf(57, 250);
    page.drawCircle({ x: cm(28.5), y: cm(228), size: cm(18), color: ROSA });
    centrado(page, 'LOGO', bold, 120, cm(222), BLANCO, cm(57));
    out.ocupaPoco = await guardar(dir, '12-ocupa-poco-lienzo-largo.pdf', await doc.save());
  }

  // 13 — DOS PÁGINAS.
  {
    const { doc, page, bold } = await nuevoPdf(57, 50);
    centrado(page, 'PÁGINA 1', bold, 80, cm(24), NEGRO, cm(57));
    const p2 = doc.addPage([cm(57), cm(50)]);
    p2.drawText('PÁGINA 2', { x: cm(10), y: cm(24), size: 80, font: bold, color: NEGRO });
    out.dosPaginas = await guardar(dir, '13-dos-paginas.pdf', await doc.save());
  }

  // 14 — "PDF" que en realidad es texto.
  out.noEsPdf = await guardar(dir, '14-no-es-un-pdf.pdf', Buffer.from('esto es un documento de texto renombrado\n'));

  return out;
}

module.exports = { generarEjemplos };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(process.cwd(), 'storage-demo', 'dtf-ejemplos'));
  generarEjemplos(dir).then((r) => {
    console.log(`Archivos de ejemplo en ${dir}:`);
    for (const ruta of Object.values(r)) console.log('  ' + path.basename(ruta));
  });
}
