/**
 * Reconciliación de objetos huérfanos entre S3 y la base de datos.
 *
 * POR QUÉ EXISTE
 *   El pipeline sube a S3 ANTES del insert en BD y borra en BD ANTES de S3.
 *   Si un paso falla a medias, queda un objeto en S3 que ninguna fila referencia
 *   (o una fila que apunta a un objeto inexistente). Ambos casos son silenciosos:
 *   nadie se entera hasta que alguien ve una imagen rota o la factura crece.
 *
 * QUÉ REPORTA
 *   1. HUÉRFANOS EN S3  — objetos sin fila en BD. Cuestan dinero.
 *   2. FILAS ROTAS      — filas cuya key no existe en S3. Muestran imagen rota.
 *
 * SEGURIDAD
 *   - `--dry-run` es el DEFAULT: solo reporta.
 *   - `--borrar` elimina los huérfanos de S3 (nunca toca filas de BD).
 *   - Requiere `s3:ListBucket` para enumerar. La política de mínimo privilegio
 *     del backend NO lo incluye, así que este script se corre con credenciales
 *     de administrador (o se añade el permiso temporalmente).
 *
 * USO
 *   pnpm reconciliar:imagenes            # reporta
 *   pnpm reconciliar:imagenes --borrar   # elimina huérfanos de S3
 */

import { PrismaClient } from '@prisma/client';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const prisma = new PrismaClient();
const BORRAR = process.argv.includes('--borrar');

/** Prefijos que el backend gestiona. Fuera de ellos no se toca nada. */
const PREFIJOS_GESTIONADOS = ['productos/', 'branding/', 'tmp/'];

function crearS3(): S3Client {
  const { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET } =
    process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_S3_BUCKET) {
    throw new Error('Faltan AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_S3_BUCKET');
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

async function main() {
  const bucket = process.env.AWS_S3_BUCKET!;
  const s3 = crearS3();

  console.log(`\n${BORRAR ? '⚠️  BORRAR huérfanos' : '🔍 DRY-RUN (solo reporta)'}\n`);

  // 1. Enumerar el bucket.
  const enS3 = new Set<string>();
  let token: string | undefined;
  try {
    do {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key && PREFIJOS_GESTIONADOS.some((p) => o.Key!.startsWith(p))) {
          enS3.add(o.Key);
        }
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  } catch (err) {
    if ((err as { name?: string }).name === 'AccessDenied') {
      console.error(
        '❌ La credencial no puede listar el bucket (s3:ListBucket).\n\n' +
          '   Esto es lo esperado: la política del backend es de mínimo privilegio\n' +
          '   y solo permite PutObject/DeleteObject. Para reconciliar, crea una\n' +
          '   credencial temporal con s3:ListBucket sobre el bucket, o añade el\n' +
          '   permiso a la política, corre el script y quítalo después.\n\n' +
          `   Bucket: ${bucket}\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // 2. Keys referenciadas por la BD.
  const imagenes = await prisma.productoImagen.findMany({ select: { url: true } });
  const config = await prisma.configuracionSitio.findMany({ select: { valor: true } });

  const enBD = new Set<string>();
  for (const i of imagenes) {
    // Solo keys de storage; las rutas legacy no son objetos nuestros.
    if (i.url && !i.url.startsWith('/') && !/^https?:\/\//i.test(i.url)) {
      enBD.add(i.url);
    }
  }
  for (const c of config) {
    if (c.valor && !c.valor.startsWith('/') && !/^https?:\/\//i.test(c.valor)) {
      enBD.add(c.valor);
    }
  }

  // 3. Diferencias.
  const huerfanos = [...enS3].filter((k) => !enBD.has(k));
  const rotas = [...enBD].filter((k) => !enS3.has(k));

  console.log(`Objetos en S3 (prefijos gestionados) : ${enS3.size}`);
  console.log(`Keys referenciadas en BD             : ${enBD.size}`);
  console.log('');

  if (huerfanos.length === 0 && rotas.length === 0) {
    console.log('✅ Consistente: no hay huérfanos ni filas rotas.\n');
    return;
  }

  if (huerfanos.length) {
    console.log(`🗑️  Huérfanos en S3 (${huerfanos.length}) — cuestan dinero:`);
    huerfanos.slice(0, 15).forEach((k) => console.log(`   ${k}`));
    if (huerfanos.length > 15) console.log(`   … y ${huerfanos.length - 15} más`);
    console.log('');
  }

  if (rotas.length) {
    console.log(`💔 Filas rotas (${rotas.length}) — muestran imagen rota:`);
    rotas.slice(0, 15).forEach((k) => console.log(`   ${k}`));
    if (rotas.length > 15) console.log(`   … y ${rotas.length - 15} más`);
    console.log('');
  }

  if (!BORRAR) {
    console.log('Dry-run. Para borrar los huérfanos: pnpm reconciliar:imagenes --borrar\n');
    return;
  }

  // 4. Borrar huérfanos (solo objetos, nunca filas de BD).
  if (huerfanos.length) {
    let borrados = 0;
    for (const key of huerfanos) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        borrados++;
      } catch (err) {
        console.log(`   ✗ ${key}: ${(err as Error).message}`);
      }
    }
    console.log(`✅ Borrados ${borrados}/${huerfanos.length} huérfanos.\n`);
  }

  if (rotas.length) {
    console.log(
      '⚠️  Las filas rotas NO se borran automáticamente: requieren decisión\n' +
        '   (¿re-subir el archivo o quitar la fila?). Revísalas a mano.\n',
    );
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
