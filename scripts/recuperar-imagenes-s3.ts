/**
 * Recupera las imágenes del catálogo cuando la BD referencia keys que no existen
 * en S3.
 *
 * POR QUÉ EXISTE
 *   El seed escribe keys deterministas (`productos/seed/<archivo>.webp`) pero
 *   NUNCA sube los archivos. Si se re-ejecuta el seed sobre una BD cuyas imágenes
 *   ya estaban en S3, las filas quedan apuntando a keys que nadie subió: el
 *   catálogo devuelve URLs que dan 403 y no hay error de build que lo delate.
 *
 *   `migrar-imagenes-s3.ts` NO sirve para este caso: sólo procesa rutas legacy
 *   `/products/` (de las que ya no hay ninguna) y genera UUIDs nuevos, que no
 *   coinciden con las keys que la BD tiene ahora.
 *
 * QUÉ HACE
 *   1. Lee las keys que la BD referencia (`productos_imagenes.url`).
 *   2. Comprueba cuáles faltan en S3.
 *   3. Sube las faltantes desde un directorio local con los `.webp` originales.
 *
 *   NO escribe en la BD: las filas ya apuntan a las keys correctas. Sólo reporta
 *   si `productos.imagen_principal` / `imagenes` divergen de sus filas.
 *
 * SEGURIDAD
 *   - `--dry-run` es el DEFAULT: sin `--apply` no sube nada.
 *   - Idempotente: las keys ya presentes se saltan.
 *   - Nunca sobrescribe un objeto existente (`IfNoneMatch: '*'`).
 *   - Aborta si falta cualquier archivo local, para no dejar el catálogo a medias.
 *   - No borra nada. Los objetos huérfanos se limpian aparte, a mano.
 *
 * SOBRE LA COMPROBACIÓN DE PRESENCIA
 *   La credencial del backend es de mínimo privilegio: sólo `PutObject` /
 *   `DeleteObject`. NO tiene `s3:GetObject` ni `s3:ListBucket`, así que un
 *   `HeadObject` autenticado devuelve AccessDenied tanto para objetos que existen
 *   como para los que no — inservible como sonda. Se usa un HEAD anónimo contra
 *   la URL pública (el bucket es de lectura pública). En este bucket un objeto
 *   ausente responde 403, no 404, porque sin ListBucket S3 no distingue
 *   "no existe" de "no autorizado": 403 se interpreta como ausente.
 *
 * USO
 *   pnpm recuperar:imagenes                 # dry-run: reporta qué falta
 *   pnpm recuperar:imagenes --apply         # sube las faltantes
 *   pnpm recuperar:imagenes --source-dir=/ruta/a/products
 */

import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { readFile, stat } from 'fs/promises';
import { join, extname, resolve } from 'path';

// El proyecto no usa dotenv: los scripts existentes esperan las variables
// exportadas en el shell. Cargar `.env` aquí evita ese paso manual (y el fallo
// silencioso de correr sin credenciales). Si ya vienen del entorno, mandan esas.
try {
  process.loadEnvFile(resolve(process.cwd(), '.env'));
} catch {
  // Sin `.env`: se usan las variables del entorno, o el script falla al pedirlas.
}

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const SOURCE_ARG = process.argv.find((a) => a.startsWith('--source-dir='));
const SOURCE_DIR = SOURCE_ARG
  ? resolve(SOURCE_ARG.split('=')[1])
  : resolve(process.cwd(), '..', 'demo-frontend', 'public', 'products');

/** Prefijo de las keys que escribe el seed. */
const PREFIJO_SEED = 'productos/seed/';

const MIME_POR_EXT: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

function crearS3(): S3Client {
  const { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET } =
    process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      'Faltan AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. Sin credenciales no se ' +
        'puede subir.',
    );
  }
  if (!AWS_S3_BUCKET) {
    throw new Error('Falta AWS_S3_BUCKET.');
  }
  return new S3Client({
    region: AWS_REGION || 'us-west-2',
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5_000,
      requestTimeout: 30_000,
      throwOnRequestTimeout: true,
    }),
  });
}

/** Base pública del bucket, para sondear sin credenciales. */
function urlPublicaBase(): string {
  const explicita = process.env.AWS_S3_PUBLIC_URL;
  if (explicita) return explicita.replace(/\/$/, '');
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION || 'us-west-2';
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

/**
 * ¿Existe el objeto? HEAD anónimo contra la URL pública.
 * 200 = existe. Cualquier otra cosa (403/404) = ausente.
 */
async function existeEnS3(key: string): Promise<boolean> {
  const url = `${urlPublicaBase()}/${key}`;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    // Error de red: tratar como ausente es lo conservador — se intentará subir,
    // y si el objeto ya estaba, `IfNoneMatch` impide sobrescribirlo.
    return false;
  }
}

async function main() {
  const modo = APPLY
    ? '⚠️  APLICAR (sube archivos a S3)'
    : '🔍 DRY-RUN (no sube nada)';
  console.log(`\n${modo}\n`);

  const filas = await prisma.productoImagen.findMany({
    where: { url: { startsWith: PREFIJO_SEED } },
    select: { id: true, productoId: true, url: true },
    orderBy: { id: 'asc' },
  });

  const totalFilas = await prisma.productoImagen.count();
  console.log(`Filas en productos_imagenes      : ${totalFilas}`);
  console.log(`Filas con key ${PREFIJO_SEED}* : ${filas.length}`);
  console.log(`Archivos desde                   : ${SOURCE_DIR}\n`);

  if (filas.length === 0) {
    console.log(
      '✅ Nada que recuperar: ninguna fila usa keys del seed.\n' +
        '   (Si el catálogo está roto, revisa qué prefijo usan las filas.)\n',
    );
    return;
  }

  // ---------------------------------------------------------------
  // Preflight: resolver archivo y presencia en S3 para TODAS las filas
  // antes de subir nada. Migrar a medias deja el catálogo inconsistente.
  // ---------------------------------------------------------------
  const aSubir: Array<{ filaId: number; archivo: string; ruta: string; key: string; bytes: number }> = [];
  const yaPresentes: string[] = [];
  const sinArchivo: string[] = [];

  for (const fila of filas) {
    const archivo = fila.url.slice(PREFIJO_SEED.length);
    const ruta = join(SOURCE_DIR, archivo);

    let bytes: number;
    try {
      bytes = (await stat(ruta)).size;
    } catch {
      sinArchivo.push(`id=${fila.id}: no existe ${ruta}`);
      continue;
    }

    if (await existeEnS3(fila.url)) {
      yaPresentes.push(fila.url);
      continue;
    }

    aSubir.push({ filaId: fila.id, archivo, ruta, key: fila.url, bytes });
  }

  const totalBytes = aSubir.reduce((a, p) => a + p.bytes, 0);
  console.log('Plan:');
  console.log(`  ya presentes en S3 : ${yaPresentes.length}`);
  console.log(`  faltantes a subir  : ${aSubir.length} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  sin archivo local  : ${sinArchivo.length}\n`);

  if (aSubir.length > 0) {
    for (const p of aSubir.slice(0, 5)) {
      console.log(`  ${p.key}  (${(p.bytes / 1024).toFixed(0)} KB)`);
    }
    if (aSubir.length > 5) console.log(`  … y ${aSubir.length - 5} más`);
    console.log('');
  }

  if (sinArchivo.length) {
    console.log(`❌ ${sinArchivo.length} archivos no encontrados en disco:`);
    sinArchivo.slice(0, 10).forEach((e) => console.log(`   ${e}`));
    console.log(
      '\nAbortado: subir sólo una parte dejaría el catálogo a medias.\n' +
        'Recupera los archivos desde git y reintenta:\n' +
        '  git -C ../demo-frontend archive 8bad24a^ public/products | tar -x -C /tmp/ptm-products\n' +
        '  pnpm recuperar:imagenes --source-dir=/tmp/ptm-products/public/products\n',
    );
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log('\n✅ Dry-run OK. Para ejecutar: pnpm recuperar:imagenes --apply\n');
    return;
  }

  // ---------------------------------------------------------------
  // Subir
  // ---------------------------------------------------------------
  const s3 = crearS3();
  const bucket = process.env.AWS_S3_BUCKET!;
  let subidas = 0;
  const fallos: string[] = [];

  for (const p of aSubir) {
    try {
      const body = await readFile(p.ruta);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: p.key,
          Body: body,
          ContentType: MIME_POR_EXT[extname(p.archivo).toLowerCase()] || 'application/octet-stream',
          CacheControl: 'public, max-age=31536000, immutable',
          // Nunca sobrescribir: si el objeto apareció entre el preflight y ahora,
          // la condición falla y no se pisa.
          IfNoneMatch: '*',
        }),
      );
      subidas++;
      if (subidas % 10 === 0) console.log(`  … ${subidas}/${aSubir.length}`);
    } catch (err) {
      const e = err as Error & { name?: string; $metadata?: { httpStatusCode?: number } };
      // PreconditionFailed = el objeto ya existía: no es un fallo real.
      if (e.name === 'PreconditionFailed' || e.$metadata?.httpStatusCode === 412) {
        console.log(`  = ya existía, sin cambios: ${p.key}`);
        continue;
      }
      fallos.push(`${p.key}: ${e.name ?? ''} ${e.message}`);
    }
  }

  console.log(`\n✅ Subidas: ${subidas}/${aSubir.length}`);
  if (fallos.length) {
    console.log(`❌ Fallos: ${fallos.length}`);
    fallos.slice(0, 10).forEach((f) => console.log(`   ${f}`));
  }

  // ---------------------------------------------------------------
  // Verificación: re-sondear y contrastar los campos denormalizados.
  // ---------------------------------------------------------------
  console.log('\nVerificación:');
  let siguenFaltando = 0;
  for (const fila of filas) {
    if (!(await existeEnS3(fila.url))) siguenFaltando++;
  }
  console.log(`  keys del seed alcanzables : ${filas.length - siguenFaltando}/${filas.length}`);

  const productos = await prisma.producto.findMany({
    select: {
      id: true,
      codigo: true,
      imagenPrincipal: true,
      imagenes: true,
      imagenesProducto: { select: { url: true, esPrincipal: true }, orderBy: [{ esPrincipal: 'desc' }, { orden: 'asc' }] },
    },
    orderBy: { id: 'asc' },
  });

  // Se comparan CONJUNTOS, no orden: el seed escribe `producto.imagenes` agrupado
  // por color, mientras que las filas ordenadas por (esPrincipal, orden) las
  // intercalan. Mismo contenido, distinto orden — no es divergencia.
  const divergentes = productos.filter((p) => {
    const deFilas = new Set(p.imagenesProducto.map((i) => i.url));
    const delArray = new Set(p.imagenes);
    const principal = p.imagenesProducto.find((i) => i.esPrincipal)?.url ?? null;
    return (
      p.imagenPrincipal !== principal ||
      deFilas.size !== delArray.size ||
      [...deFilas].some((u) => !delArray.has(u))
    );
  });

  if (divergentes.length === 0) {
    console.log('  campos denormalizados     : consistentes en los 5 productos');
  } else {
    console.log(`  ⚠️  productos con campos denormalizados divergentes: ${divergentes.length}`);
    divergentes.slice(0, 5).forEach((p) =>
      console.log(`     ${p.codigo}: imagenPrincipal=${p.imagenPrincipal} (filas=${p.imagenesProducto.length}, array=${p.imagenes.length})`),
    );
    console.log('     Este script NO los corrige. Re-sincroniza desde el panel ADMIN.');
  }

  if (siguenFaltando === 0) {
    console.log('\n🎉 Recuperación completa: el catálogo ya sirve desde S3.\n');
  } else {
    console.log(`\n⚠️  Quedan ${siguenFaltando} keys sin subir. Re-ejecuta el script.\n`);
  }
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
