/**
 * Migra las imágenes de producto de rutas legacy del frontend a keys de storage.
 *
 * QUÉ HACE
 *   1. Lee las filas de `productos_imagenes` cuya `url` es una ruta legacy
 *      (`/products/x.webp`).
 *   2. Sube el archivo desde `public/products/` del frontend a S3 con la key
 *      `productos/{productoId}/color-{colorId}/{uuid}.{ext}`.
 *   3. Actualiza las TRES fuentes en una transacción: `productos_imagenes.url`,
 *      `productos.imagen_principal` y `productos.imagenes[]`. Si se migra solo
 *      una, el resto sigue devolviendo rutas legacy y el catálogo queda roto sin
 *      error de build.
 *
 * SEGURIDAD
 *   - `--dry-run` es el DEFAULT: sin `--apply` no escribe nada.
 *   - Idempotente: si la fila ya tiene una key (no legacy), se salta.
 *   - Los archivos NO se borran del frontend aquí; eso es la Fase 5, después de
 *     confirmar que el catálogo sirve desde S3.
 *
 * USO
 *   pnpm migrar:imagenes              # dry-run: reporta qué haría
 *   pnpm migrar:imagenes --apply      # ejecuta
 *   pnpm migrar:imagenes --apply --limite=3   # solo 3 filas (prueba)
 */

import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { randomUUID } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { join, resolve, extname } from 'path';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const LIMITE_ARG = process.argv.find((a) => a.startsWith('--limite='));
const LIMITE = LIMITE_ARG ? parseInt(LIMITE_ARG.split('=')[1], 10) : Infinity;

const PREFIJO_LEGACY = '/products/';

/** Directorio del frontend donde viven los .webp. Configurable por env. */
const FRONTEND_PUBLIC_DIR =
  process.env.FRONTEND_PUBLIC_DIR ||
  resolve(process.cwd(), '..', 'demo-frontend', 'public');

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
        'puede migrar: el script sube archivos reales, no simula el destino.',
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

/** `C0200-caribe-1.webp` → `productos/7/color-3/<uuid>.webp` */
function keyDestino(productoId: number, colorId: number | null, archivo: string) {
  const ext = extname(archivo).toLowerCase() || '.webp';
  const carpeta = colorId ? `color-${colorId}` : 'general';
  return `productos/${productoId}/${carpeta}/${randomUUID()}${ext}`;
}

interface Fila {
  id: number;
  productoId: number;
  colorId: number | null;
  url: string;
}

async function main() {
  const modo = APPLY ? '⚠️  APLICAR (escribe en S3 y en la BD)' : '🔍 DRY-RUN (no escribe nada)';
  console.log(`\n${modo}\n`);

  if (!process.env.AWS_S3_BUCKET) {
    // Permite dry-run sin credenciales: solo reporta el plan.
    console.log('Sin AWS_S3_BUCKET: dry-run informativo, no se sube nada.\n');
  }

  const filas = (await prisma.productoImagen.findMany({
    where: { url: { startsWith: PREFIJO_LEGACY } },
    select: { id: true, productoId: true, colorId: true, url: true },
    orderBy: { id: 'asc' },
  })) as Fila[];

  const total = await prisma.productoImagen.count();
  console.log(`Filas en productos_imagenes : ${total}`);
  console.log(`Filas legacy a migrar       : ${filas.length}`);
  console.log(`Archivos desde              : ${FRONTEND_PUBLIC_DIR}\n`);

  if (filas.length === 0) {
    console.log('✅ Nada que migrar: todas las filas ya tienen key de storage.\n');
    return;
  }

  const s3 = APPLY && process.env.AWS_S3_BUCKET ? crearS3() : null;
  const bucket = process.env.AWS_S3_BUCKET || '';

  const plan: Array<{ fila: Fila; archivo: string; key: string; bytes: number }> = [];
  const errores: string[] = [];

  for (const fila of filas.slice(0, LIMITE)) {
    const archivo = fila.url.slice(PREFIJO_LEGACY.length);
    const ruta = join(FRONTEND_PUBLIC_DIR, 'products', archivo);
    try {
      const st = await stat(ruta);
      plan.push({
        fila,
        archivo,
        key: keyDestino(fila.productoId, fila.colorId, archivo),
        bytes: st.size,
      });
    } catch {
      errores.push(`id=${fila.id}: no existe ${ruta}`);
    }
  }

  const totalBytes = plan.reduce((a, p) => a + p.bytes, 0);
  console.log(`Plan: ${plan.length} archivos, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  if (LIMITE !== Infinity) console.log(`(limitado a ${LIMITE} filas por --limite)`);
  console.log('');

  for (const p of plan.slice(0, 5)) {
    console.log(`  ${p.fila.url}`);
    console.log(`    → ${p.key}  (${(p.bytes / 1024).toFixed(0)} KB)`);
  }
  if (plan.length > 5) console.log(`  … y ${plan.length - 5} más`);

  if (errores.length) {
    console.log(`\n❌ ${errores.length} archivos faltantes:`);
    errores.slice(0, 10).forEach((e) => console.log(`   ${e}`));
    console.log('\nAbortado: migrar a medias dejaría el catálogo inconsistente.\n');
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log('\n✅ Dry-run OK. Para ejecutar: pnpm migrar:imagenes --apply\n');
    return;
  }

  // ---------------------------------------------------------------
  // Aplicar
  // ---------------------------------------------------------------
  let subidas = 0;
  const fallos: string[] = [];

  for (const p of plan) {
    try {
      const body = await readFile(join(FRONTEND_PUBLIC_DIR, 'products', p.archivo));
      await s3!.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: p.key,
          Body: body,
          ContentType: MIME_POR_EXT[extname(p.archivo).toLowerCase()] || 'application/octet-stream',
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );

      // La fila y los campos legacy del producto se actualizan juntos: si se
      // actualiza solo la fila, `imagenPrincipal`/`imagenes` quedan apuntando a
      // rutas que ya no existen.
      await prisma.$transaction(async (tx) => {
        await tx.productoImagen.update({
          where: { id: p.fila.id },
          data: { url: p.key },
        });

        const delProducto = await tx.productoImagen.findMany({
          where: { productoId: p.fila.productoId },
          orderBy: [{ esPrincipal: 'desc' }, { orden: 'asc' }],
          select: { url: true, esPrincipal: true },
        });
        const principal =
          delProducto.find((i) => i.esPrincipal) || delProducto[0];
        await tx.producto.update({
          where: { id: p.fila.productoId },
          data: {
            imagenPrincipal: principal?.url || null,
            imagenes: delProducto.map((i) => i.url),
          },
        });
      });

      subidas++;
      if (subidas % 10 === 0) console.log(`  … ${subidas}/${plan.length}`);
    } catch (err) {
      fallos.push(`id=${p.fila.id} (${p.archivo}): ${(err as Error).message}`);
    }
  }

  console.log(`\n✅ Migradas: ${subidas}/${plan.length}`);
  if (fallos.length) {
    console.log(`❌ Fallos: ${fallos.length}`);
    fallos.slice(0, 10).forEach((f) => console.log(`   ${f}`));
  }

  // Verificación: ninguna columna debe seguir con el prefijo legacy.
  const restantes = await prisma.productoImagen.count({
    where: { url: { startsWith: PREFIJO_LEGACY } },
  });
  const productosLegacy = await prisma.producto.count({
    where: { imagenPrincipal: { startsWith: PREFIJO_LEGACY } },
  });
  console.log(`\nVerificación:`);
  console.log(`  productos_imagenes con ruta legacy : ${restantes}`);
  console.log(`  productos.imagen_principal legacy  : ${productosLegacy}`);
  if (restantes === 0 && productosLegacy === 0) {
    console.log('\n🎉 Migración completa. El catálogo ya sirve desde S3.\n');
  } else {
    console.log('\n⚠️  Quedan rutas legacy. Re-ejecuta el script (es idempotente).\n');
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
