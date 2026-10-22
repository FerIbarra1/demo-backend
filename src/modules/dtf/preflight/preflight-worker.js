'use strict';
/**
 * Impresión DTF — MIDE un archivo (PDF o PNG). Ver PLAN-DTF.md §7.4.
 *
 * Corre en un PROCESO HIJO, nunca dentro del API (`preflight.runner.ts` lo lanza con tope de memoria
 * y de tiempo): analizar un PDF ajeno es el punto más frágil de toda la función. Si el PDF es
 * malicioso, enorme o raro, se cae el hijo y el trabajo queda "no concluyente" (lo revisa una
 * persona); el API ni se entera.
 *
 * Es JavaScript plano (CommonJS) y no TypeScript a propósito: `pdfjs-dist` es solo-ESM y desde un
 * módulo CommonJS compilado por Nest solo se puede traer con `import()`, que en un proceso normal de
 * Node funciona y dentro de Jest no. El hijo es un proceso normal.
 *
 * Este archivo solo MIDE. Qué significan las medidas para un tipo de DTF (bloquear, avisar) lo decide
 * `core/dtf-reglas.util.ts`, que es una función pura que se prueba con una tabla.
 *
 * Uso:   node preflight-worker.js <archivo> <pdf|png> <salida-preview.png> '<json config>'
 * Salida: UNA línea JSON en stdout: { ok: true, m: <mediciones> } | { ok: false, error }
 */
const fs = require('fs');

const PT_POR_PULGADA = 72;
const CM_POR_PULGADA = 2.54;

// ───────────────────────────── análisis de píxeles (compartido PDF/PNG) ─────────────────────────────

/**
 * Sobre un buffer RGBA (con transparencia REAL): fondo, semitransparencias y caja del contenido.
 *
 * `fondo`: un fondo opaco que cubre casi todo el borde (≥ 90 %) es lo que la máquina imprimiría.
 * Si ese borde es blanco → "BLANCO"; si no → "COLOR". Un archivo bien hecho tiene el borde
 * transparente (alfa 0) y esto devuelve `null`.
 */
function analizarRgba(rgba, w, h) {
  let opacos = 0;
  let parciales = 0;
  let minx = w;
  let miny = h;
  let maxx = -1;
  let maxy = -1;
  // Franja de borde de 2 px.
  const B = 2;
  let bordeTotal = 0;
  let bordeOpaco = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;

  for (let y = 0; y < h; y++) {
    const filaBorde = y < B || y >= h - B;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3] / 255;
      if (a > 0.98) opacos++;
      else if (a > 0.02) parciales++;
      if (a > 0.05) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
      if (filaBorde || x < B || x >= w - B) {
        bordeTotal++;
        if (a > 0.98) {
          bordeOpaco++;
          sr += rgba[i];
          sg += rgba[i + 1];
          sb += rgba[i + 2];
        }
      }
    }
  }

  const visibles = opacos + parciales;
  let fondo = null;
  if (bordeTotal > 0 && bordeOpaco / bordeTotal >= 0.9) {
    const mr = sr / bordeOpaco;
    const mg = sg / bordeOpaco;
    const mb = sb / bordeOpaco;
    fondo = mr >= 245 && mg >= 245 && mb >= 245 ? 'BLANCO' : 'COLOR';
  }
  return {
    fondo,
    semitransparente: visibles > 0 ? parciales / visibles : 0,
    contenido:
      maxx >= 0
        ? { x0: minx / w, y0: miny / h, x1: (maxx + 1) / w, y1: (maxy + 1) / h }
        : null,
  };
}

// ───────────────────────────────────────────── PNG ─────────────────────────────────────────────

async function medirPng(archivo, previewPath, cfg) {
  const sharp = require('sharp');
  const base = sharp(archivo, { limitInputPixels: 500_000_000, sequentialRead: true });
  const meta = await base.metadata();
  if (!meta.width || !meta.height) throw new Error('PNG sin dimensiones');

  const dpiDeclarado = meta.density && meta.density > 1 ? meta.density : null;
  const dpi = dpiDeclarado || 300;
  const anchoCm = (meta.width / dpi) * CM_POR_PULGADA;
  const altoCm = (meta.height / dpi) * CM_POR_PULGADA;

  const lado = cfg.previewLado || 2400;
  const { data, info } = await sharp(archivo, { limitInputPixels: 500_000_000, sequentialRead: true })
    .resize({ width: lado, height: lado, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = analizarRgba(data, info.width, info.height);
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ compressionLevel: 6 })
    .toFile(previewPath);

  return {
    formato: 'png',
    paginas: 1,
    anchoCm,
    altoCm,
    dpiAsumido: !dpiDeclarado,
    imagenes: 1,
    // El ppi "efectivo" de un PNG es su resolución declarada (o la asumida: ahí manda la regla del ancho).
    dpiEfectivoMin: dpi,
    // PNG siempre es RGB; la regla de color no se le aplica.
    modoColor: 'RGB',
    fondo: px.fondo,
    semitransparente: px.semitransparente,
    contenido: px.contenido,
    hayTexto: false,
    textoMinPt: null,
    seguridad: { javascript: false, adjuntos: false, cifrado: false },
    previewAncho: info.width,
    previewAlto: info.height,
  };
}

// ───────────────────────────────────────────── PDF ─────────────────────────────────────────────

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/** ppi efectivo de cada imagen colocada: píxeles ÷ pulgadas que ocupa (CTM acumulada). */
async function imagenesDelPdf(page, OPS) {
  const ops = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const pila = [];
  const imagenes = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) pila.push(ctm.slice());
    else if (fn === OPS.restore) ctm = pila.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      pila.push(ctm.slice());
      if (Array.isArray(args) && Array.isArray(args[0])) ctm = mul(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = pila.pop() || ctm;
    else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject
    ) {
      // [objId, ancho, alto] para XObject; el objeto de imagen para inline/máscara.
      let w;
      let h;
      if (fn === OPS.paintImageXObject) {
        w = args[1];
        h = args[2];
      } else {
        w = args[0] && args[0].width;
        h = args[0] && args[0].height;
      }
      if (!w || !h) continue;
      const wPt = Math.hypot(ctm[0], ctm[1]);
      const hPt = Math.hypot(ctm[2], ctm[3]);
      if (wPt < 1e-6 || hPt < 1e-6) continue;
      imagenes.push({ ppi: Math.min(w / (wPt / PT_POR_PULGADA), h / (hPt / PT_POR_PULGADA)) });
    }
  }
  return imagenes;
}

/** Tamaño de letra más chico (pt) entre los textos no vacíos. */
async function textoDelPdf(page) {
  const tc = await page.getTextContent();
  let min = null;
  let hay = false;
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    hay = true;
    const t = it.transform || [];
    const tam = Math.hypot(t[2] || 0, t[3] || 0) || it.height || 0;
    if (tam > 0 && (min === null || tam < min)) min = tam;
  }
  return { hayTexto: hay, textoMinPt: min === null ? null : Math.round(min * 10) / 10 };
}

/** Modo de color: se lee del documento (pdf.js convierte todo a RGB al interpretar). */
async function modoColorDelPdf(buf) {
  try {
    if (buf.length > 150 * 1024 * 1024) return 'DESCONOCIDO';
    const { PDFDocument, PDFName, PDFArray, PDFRef, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
    const doc = await PDFDocument.load(buf, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
    let cmyk = 0;
    let rgb = 0;
    const SUBTYPE = PDFName.of('Subtype');
    const clasificar = (cs, prof) => {
      if (prof > 3) return;
      if (cs instanceof PDFRef) cs = doc.context.lookup(cs);
      if (cs instanceof PDFName) {
        const n = cs.asString();
        if (n === '/DeviceCMYK') cmyk++;
        else if (n === '/DeviceRGB' || n === '/CalRGB') rgb++;
      } else if (cs instanceof PDFArray) {
        const tipo = cs.get(0);
        const t = tipo instanceof PDFName ? tipo.asString() : '';
        if (t === '/ICCBased') {
          let perfil = cs.get(1);
          if (perfil instanceof PDFRef) perfil = doc.context.lookup(perfil);
          const n = perfil && perfil.dict && perfil.dict.get(PDFName.of('N'));
          const valor = n && n.asNumber ? n.asNumber() : 0;
          if (valor === 4) cmyk++;
          else if (valor === 3) rgb++;
        } else if (t === '/Indexed') clasificar(cs.get(1), prof + 1);
        else if (t === '/CalRGB') rgb++;
      }
    };
    let leido = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const sub = obj.dict.get(SUBTYPE);
      const esImagen = sub instanceof PDFName && sub.asString() === '/Image';
      if (esImagen) {
        clasificar(obj.dict.get(PDFName.of('ColorSpace')), 0);
        continue;
      }
      // Contenido vectorial (páginas y formularios): operadores de color.
      const esForm = sub instanceof PDFName && sub.asString() === '/Form';
      if (sub && !esForm) continue;
      if (leido > 20 * 1024 * 1024) continue;
      let texto = '';
      try {
        const bytes = decodePDFRawStream(obj).decode();
        leido += bytes.length;
        texto = Buffer.from(bytes).toString('latin1');
      } catch {
        continue;
      }
      cmyk += (texto.match(/[\d.]\s+[kK](?=\s|$)/g) || []).length > 0 ? 1 : 0;
      rgb += (texto.match(/[\d.]\s+(?:rg|RG)(?=\s|$)/g) || []).length > 0 ? 1 : 0;
    }
    if (cmyk > 0 && rgb === 0) return 'CMYK';
    if (rgb > 0 && cmyk === 0) return 'RGB';
    if (rgb > 0 && cmyk > 0) return 'MIXTO';
    return 'GRIS';
  } catch {
    return 'DESCONOCIDO';
  }
}

async function medirPdf(archivo, previewPath, cfg) {
  const { createCanvas } = require('@napi-rs/canvas');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buf = fs.readFileSync(archivo);
  const base = {
    formato: 'pdf',
    paginas: 0,
    anchoCm: null,
    altoCm: null,
    dpiAsumido: false,
    imagenes: 0,
    dpiEfectivoMin: null,
    modoColor: 'DESCONOCIDO',
    fondo: null,
    semitransparente: null,
    contenido: null,
    hayTexto: false,
    textoMinPt: null,
    seguridad: { javascript: false, adjuntos: false, cifrado: false },
  };

  let pdf;
  try {
    pdf = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') {
      return { ...base, seguridad: { javascript: false, adjuntos: false, cifrado: true } };
    }
    throw e;
  }

  const seguridad = { javascript: false, adjuntos: false, cifrado: false };
  try {
    const js = await pdf.getJSActions();
    const js2 = await pdf.getJavaScript();
    seguridad.javascript = Boolean((js && Object.keys(js).length > 0) || (js2 && js2.length > 0));
  } catch {
    /* sin scripts legibles: no se afirma nada */
  }
  try {
    const adj = await pdf.getAttachments();
    seguridad.adjuntos = Boolean(adj && Object.keys(adj).length > 0);
  } catch {
    /* idem */
  }

  const paginas = pdf.numPages;
  const page = await pdf.getPage(1);
  const [x0, y0, x1, y1] = page.view;
  let wPt = x1 - x0;
  let hPt = y1 - y0;
  if (page.rotate === 90 || page.rotate === 270) [wPt, hPt] = [hPt, wPt];
  const unidad = page.userUnit || 1;
  const anchoCm = (wPt / PT_POR_PULGADA) * CM_POR_PULGADA * unidad;
  const altoCm = (hPt / PT_POR_PULGADA) * CM_POR_PULGADA * unidad;

  // Imágenes (ppi efectivo) y texto.
  const imagenes = await imagenesDelPdf(page, pdfjs.OPS);
  const txt = await textoDelPdf(page);
  const dpiMin = imagenes.length ? Math.min(...imagenes.map((i) => i.ppi)) : null;

  // Fondo / transparencias: se renderiza dos veces (fondo blanco y fondo negro). Lo que NO cambia de
  // una a otra es contenido opaco; lo que cambia es transparente (o semitransparente). Con las dos
  // se reconstruye el PNG con transparencia REAL para la vista previa.
  const lado = cfg.previewLado || 2400;
  const vp0 = page.getViewport({ scale: 1 });
  const escala = lado / Math.max(vp0.width, vp0.height);
  const vp = page.getViewport({ scale: escala });
  // `floor` y no `ceil`: con `ceil` la última fila/columna queda sin pintar (la página no llena ese
  // pixel fraccionario), parece transparente y un fondo blanco real caía bajo el umbral del borde.
  const w = Math.max(1, Math.floor(vp.width));
  const h = Math.max(1, Math.floor(vp.height));
  const render = async (fondo) => {
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp, background: fondo }).promise;
    return ctx.getImageData(0, 0, w, h).data;
  };
  const sobreBlanco = await render('rgb(255,255,255)');
  const sobreNegro = await render('rgb(0,0,0)');
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    const dif = (sobreBlanco[i] - sobreNegro[i]) + (sobreBlanco[i + 1] - sobreNegro[i + 1]) + (sobreBlanco[i + 2] - sobreNegro[i + 2]);
    let a = 1 - dif / (3 * 255);
    if (a < 0) a = 0;
    if (a > 1) a = 1;
    if (a < 0.004) continue; // transparente: 0,0,0,0
    rgba[i] = Math.min(255, Math.round(sobreNegro[i] / a));
    rgba[i + 1] = Math.min(255, Math.round(sobreNegro[i + 1] / a));
    rgba[i + 2] = Math.min(255, Math.round(sobreNegro[i + 2] / a));
    rgba[i + 3] = Math.round(a * 255);
  }
  const px = analizarRgba(rgba, w, h);
  const sharp = require('sharp');
  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .png({ compressionLevel: 6 })
    .toFile(previewPath);

  const modoColor = await modoColorDelPdf(buf);

  return {
    ...base,
    paginas,
    anchoCm,
    altoCm,
    imagenes: imagenes.length,
    dpiEfectivoMin: dpiMin,
    modoColor,
    fondo: px.fondo,
    semitransparente: px.semitransparente,
    contenido: px.contenido,
    hayTexto: txt.hayTexto,
    textoMinPt: txt.textoMinPt,
    seguridad,
    previewAncho: w,
    previewAlto: h,
  };
}

// ───────────────────────────────────────────── main ─────────────────────────────────────────────

async function main() {
  const [, , archivo, formato, previewPath, cfgJson] = process.argv;
  if (!archivo || !formato || !previewPath) throw new Error('Uso: preflight-worker <archivo> <pdf|png> <preview.png>');
  const cfg = cfgJson ? JSON.parse(cfgJson) : {};
  const t0 = Date.now();
  let m;
  if (formato === 'pdf') m = await medirPdf(archivo, previewPath, cfg);
  else if (formato === 'png') m = await medirPng(archivo, previewPath, cfg);
  else throw new Error(`Formato no soportado: ${formato}`);
  m.ms = Date.now() - t0;
  process.stdout.write(JSON.stringify({ ok: true, m }) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }) + '\n');
  process.exit(0);
});
