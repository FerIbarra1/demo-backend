import 'reflect-metadata';
import { ForbiddenException, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readdirSync, rmSync } from 'fs';
import { AddressInfo } from 'net';
import * as os from 'os';
import { DtfPublicoController } from './dtf.controllers';
import { DtfConfigService } from './dtf-config.service';
import { DtfTrabajoService } from './dtf-trabajo.service';

/**
 * Oct 2026: la subida desde el celular (`POST dtf/movil/:token/archivo`) es PÚBLICA: el token es la autorización.
 *
 * Multer escribe el archivo a disco ANTES de que el handler valide el token, y la limpieza del temporal vive dentro de
 * `subirArchivo` (que un token inválido nunca alcanza). Sin un guard previo, cualquier anónimo podía mandar archivos
 * de hasta 300 MB con un token inventado, recibir 403 y dejar el temporal en `tmpdir()` hasta llenar el disco.
 *
 * Se levanta el controller REAL con Multer real y `os.tmpdir()` redirigido a una carpeta propia del test, para contar
 * los archivos que quedan sin el ruido de otros procesos.
 */
jest.mock('os', () => {
  const real = jest.requireActual('os');
  const fs = jest.requireActual('fs');
  const dir = fs.mkdtempSync(`${real.tmpdir()}/dtf-movil-spec-`);
  return { ...real, tmpdir: () => dir };
});

const CARPETA = os.tmpdir();
const TOKEN_BUENO = 'token-valido';

const subirArchivo = jest.fn(async () => ({
  duplicado: false,
  trabajo: { archivo: null, cotizacion: {} },
}));
const trabajosFalso = {
  actorMovil: (token: string) => {
    if (token !== TOKEN_BUENO) throw new ForbiddenException('Enlace no válido.');
    return { tipo: 'MOVIL', trabajoId: 1, usuarioId: 1 };
  },
  subirArchivo,
};

@Module({
  controllers: [DtfPublicoController],
  providers: [
    { provide: DtfConfigService, useValue: {} },
    { provide: DtfTrabajoService, useValue: trabajosFalso },
  ],
})
class ModuloDePrueba {}

describe('POST dtf/movil/:token/archivo', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create(ModuloDePrueba, { logger: false });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(CARPETA, { recursive: true, force: true });
  });
  beforeEach(() => {
    subirArchivo.mockClear();
    for (const f of readdirSync(CARPETA)) rmSync(`${CARPETA}/${f}`, { force: true });
  });

  const subir = (token: string, conArchivo = true) => {
    const form = new FormData();
    if (conArchivo) {
      form.append(
        'file',
        new Blob([Buffer.alloc(200 * 1024, 1)], { type: 'application/pdf' }),
        'diseno.pdf',
      );
    }
    return fetch(`${base}/dtf/movil/${token}/archivo`, { method: 'POST', body: form });
  };

  it('un token inválido responde 403 y NO deja ningún temporal en disco', async () => {
    const r = await subir('token-inventado');

    expect(r.status).toBe(403);
    expect(readdirSync(CARPETA)).toEqual([]);
    expect(subirArchivo).not.toHaveBeenCalled();
  });

  it('un token inválido sin archivo también es 403 (el token se mira antes que el cuerpo)', async () => {
    const r = await subir('token-inventado', false);
    expect(r.status).toBe(403);
  });

  it('con un token válido el archivo llega al servicio (que es quien borra su temporal)', async () => {
    const r = await subir(TOKEN_BUENO);

    expect(r.status).toBe(201);
    expect(subirArchivo).toHaveBeenCalledTimes(1);
    const [, , archivo, canal] = subirArchivo.mock.calls[0] as unknown as [
      number,
      unknown,
      { path: string; originalname: string; size: number },
      string,
    ];
    expect(canal).toBe('CELULAR_QR');
    expect(archivo.originalname).toBe('diseno.pdf');
    expect(archivo.size).toBe(200 * 1024);
    expect(archivo.path.startsWith(CARPETA)).toBe(true);
  });
});
