import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EstadoDtf, Prisma, RolUsuario } from '@prisma/client';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { open, unlink, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { DTF_MAX_BYTES } from '../../config/app.config';
import { PrismaService } from '../../prisma/prisma.service';
import { UserContext } from '../../types/pedido.types';
import { PreciosService } from '../precios/precios.service';
import { recalcularTotalesPedido } from '../pedidos/core/totales.util';
import { DtfConfigService } from './dtf-config.service';
import { DtfEmisor, ActorDtf } from './dtf-emisor.service';
import { DtfPedidoService } from './dtf-pedido.service';
import { DtfStorageService } from './storage/dtf-storage.service';
import { PreflightRunner } from './preflight/preflight.runner';
import { INCLUDE_TRABAJO, TrabajoCompleto, vistaTrabajo } from './dtf-vista';
import { cotizar } from './core/dtf-cotizador.util';
import { evaluarPreflight, preflightNoConcluyente, ParametrosTipo } from './core/dtf-reglas.util';
import { detectarFormatoDtf } from './core/dtf-formato.util';
import { ESTADOS_DTF_EDITABLES_POR_CLIENTE } from './core/dtf-estado.util';
import { firmarSubidaMovil, verificarSubidaMovil } from './core/dtf-token.util';

/** Un archivo ya recibido en disco (multer lo deja en un temporal; nunca en memoria). */
export interface ArchivoRecibido {
  path: string;
  originalname: string;
  size: number;
}

export type ActorSubida =
  | { tipo: 'USUARIO'; user: UserContext }
  | { tipo: 'MOVIL'; trabajoId: number; usuarioId: number };

const ESPERA_PREFLIGHT_MS = 25_000;

/**
 * El lado del CLIENTE (y de quien sube en su nombre): borradores, archivos y versiones, cotización,
 * hilo con Impresión, QR del celular. Ver PLAN-DTF.md §7 y §10.
 */
@Injectable()
export class DtfTrabajoService {
  private readonly logger = new Logger(DtfTrabajoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cfg: DtfConfigService,
    private readonly precios: PreciosService,
    private readonly storage: DtfStorageService,
    private readonly runner: PreflightRunner,
    private readonly emisor: DtfEmisor,
    private readonly pedidos: DtfPedidoService,
  ) {}

  // ───────────────────────────── lectura ─────────────────────────────

  async cargar(id: number): Promise<TrabajoCompleto> {
    const t = await this.prisma.pedidoDtf.findUnique({ where: { id }, include: INCLUDE_TRABAJO });
    if (!t) throw new NotFoundException('Trabajo DTF no encontrado');
    return t;
  }

  /** Dueño del trabajo, o personal de SU tienda (Impresión/ADMIN). */
  exigirAcceso(t: { usuarioId: number; tiendaId: number }, user: UserContext) {
    if (user.rol === RolUsuario.ADMIN) return;
    if (user.rol === RolUsuario.CLIENTE) {
      if (t.usuarioId !== user.userId) throw new NotFoundException('Trabajo DTF no encontrado');
      return;
    }
    if (user.rol === RolUsuario.IMPRESION && user.tiendaId === t.tiendaId) return;
    throw new ForbiddenException('No tienes acceso a este trabajo');
  }

  async vistaCliente(id: number, user: UserContext) {
    const t = await this.cargar(id);
    this.exigirAcceso(t, user);
    return vistaTrabajo(t, {
      mira: user.rol === RolUsuario.CLIENTE ? 'cliente' : 'impresion',
      userId: user.userId,
      esAdmin: user.rol === RolUsuario.ADMIN,
    });
  }

  /** Mis borradores de esta tienda (lo que hay en el "carrito DTF"). */
  async misBorradores(user: UserContext, tiendaId: number) {
    const filas = await this.prisma.pedidoDtf.findMany({
      where: {
        usuarioId: user.userId,
        tiendaId,
        estado: 'BORRADOR',
        OR: [{ expiraAt: null }, { expiraAt: { gt: new Date() } }],
      },
      include: INCLUDE_TRABAJO,
      orderBy: { createdAt: 'asc' },
    });
    return filas.map((t) => vistaTrabajo(t, { mira: 'cliente', userId: user.userId }));
  }

  // ───────────────────────────── borradores ─────────────────────────────

  async crearBorrador(
    user: UserContext,
    tiendaId: number,
    dto: { tipoId: number; nombre: string; copias?: number; notaCliente?: string },
  ) {
    const nombre = (dto.nombre ?? '').trim();
    if (nombre.length < 2)
      throw new BadRequestException('Ponle un nombre a tu diseño (por ejemplo "Cáncer de mama").');
    const f = await this.cfg.exigirTiendaConTipo(tiendaId, dto.tipoId);
    if (f.fueraDeServicio)
      throw new ConflictException(
        'La impresora de esta tienda está fuera de servicio por ahora. Inténtalo más tarde.',
      );
    const columna = await this.precios.columnaParaUsuario(user.userId, tiendaId);
    const precio = await this.cfg.precioMetro(f.tipo, tiendaId, columna);
    if (!precio) throw new ConflictException('Este tipo de DTF aún no tiene precio configurado.');
    const horas = this.config.get<number>('app.dtf.borradorHoras') ?? 24;
    const t = await this.prisma.pedidoDtf.create({
      data: {
        usuarioId: user.userId,
        tiendaId,
        tipoId: f.tipo.id,
        nombre: nombre.slice(0, 80),
        notaCliente: dto.notaCliente?.trim() || null,
        copias: Math.min(Math.max(Math.floor(dto.copias ?? 1), 1), 50),
        precioMetro: precio,
        expiraAt: new Date(Date.now() + horas * 3_600_000),
      },
      include: INCLUDE_TRABAJO,
    });
    await this.emisor.evento(this.prisma, t.id, 'BORRADOR_CREADO', {
      id: user.userId,
      rol: user.rol,
      nombre: user.nombre,
    });
    return vistaTrabajo(t, { mira: 'cliente', userId: user.userId });
  }

  async actualizar(
    id: number,
    user: UserContext,
    dto: { nombre?: string; copias?: number; notaCliente?: string; aceptoRiesgo?: boolean },
  ) {
    const t = await this.cargar(id);
    this.exigirAcceso(t, user);
    if (!ESTADOS_DTF_EDITABLES_POR_CLIENTE.includes(t.estado) || t.estado === 'APROBADO')
      throw new ConflictException('Este trabajo ya no se puede editar.');
    const data: Prisma.PedidoDtfUpdateInput = {};
    if (dto.nombre !== undefined) {
      if (dto.nombre.trim().length < 2) throw new BadRequestException('El nombre es muy corto.');
      data.nombre = dto.nombre.trim().slice(0, 80);
    }
    if (dto.notaCliente !== undefined) data.notaCliente = dto.notaCliente.trim() || null;
    if (dto.aceptoRiesgo !== undefined) data.aceptoRiesgo = dto.aceptoRiesgo;
    let recotizar = false;
    if (dto.copias !== undefined) {
      data.copias = Math.min(Math.max(Math.floor(dto.copias), 1), 50);
      recotizar = true;
    }
    await this.prisma.pedidoDtf.update({ where: { id }, data });
    if (recotizar) await this.recotizar(id);
    const nuevo = await this.cargar(id);
    this.emisor.estado(nuevo);
    return vistaTrabajo(nuevo, {
      mira: user.rol === 'CLIENTE' ? 'cliente' : 'impresion',
      userId: user.userId,
      esAdmin: user.rol === 'ADMIN',
    });
  }

  async cancelar(id: number, user: UserContext) {
    const t = await this.cargar(id);
    this.exigirAcceso(t, user);
    if (!ESTADOS_DTF_EDITABLES_POR_CLIENTE.includes(t.estado)) {
      throw new ConflictException(
        'Este DTF ya se está imprimiendo o ya está impreso: no se puede cancelar desde aquí. Habla con la tienda.',
      );
    }
    if (t.estado === 'BORRADOR') {
      for (const a of t.archivos) {
        await this.storage.eliminar(a.archivoKey);
        if (a.previewKey) await this.storage.eliminar(a.previewKey);
      }
      await this.prisma.pedidoDtf.delete({ where: { id } });
      return { ok: true };
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.pedidoDtf.update({
        where: { id },
        data: { estado: 'CANCELADO', asignadoAId: null, asignadoAt: null },
      });
      await this.emisor.evento(
        tx,
        id,
        'CANCELADO',
        { id: user.userId, rol: user.rol, nombre: user.nombre },
        { de: t.estado, a: 'CANCELADO' },
      );
    });
    this.emisor.estado({ ...t, estado: 'CANCELADO' });
    if (t.pedidoId) await this.pedidos.resolver(t.pedidoId, user);
    return { ok: true };
  }

  // ───────────────────────────── archivos ─────────────────────────────

  /**
   * Recibe un archivo (nueva versión). Valida por FIRMA, calcula sha256, lo guarda en el almacenamiento
   * privado y lanza la revisión automática. Espera el resultado hasta `ESPERA_PREFLIGHT_MS`; si tarda
   * más responde ya y el resultado llega por `dtf.preflight`.
   */
  async subirArchivo(
    trabajoId: number,
    actor: ActorSubida,
    archivo: ArchivoRecibido,
    canal: 'WEB' | 'CELULAR_QR' | 'ASISTIDO',
  ) {
    try {
      const t = await this.cargar(trabajoId);
      let quien: ActorDtf;
      if (actor.tipo === 'MOVIL') {
        if (actor.trabajoId !== t.id || actor.usuarioId !== t.usuarioId)
          throw new ForbiddenException('Este enlace no es de este trabajo');
        quien = { id: null, rol: 'CELULAR', nombre: 'Celular del cliente' };
      } else {
        this.exigirAcceso(t, actor.user);
        quien = { id: actor.user.userId, rol: actor.user.rol, nombre: actor.user.nombre };
      }
      if (
        ![
          'BORRADOR',
          'ARCHIVO_PENDIENTE',
          'RECIBIDO',
          'EN_REVISION',
          'NECESITA_CORRECCION',
          'APROBADO',
        ].includes(t.estado)
      ) {
        throw new ConflictException(
          'Este trabajo ya no admite archivos nuevos (se está imprimiendo o ya terminó).',
        );
      }
      const maxBytes = this.config.get<number>('app.dtf.maxBytes') ?? DTF_MAX_BYTES;
      if (archivo.size <= 0) throw new BadRequestException('El archivo está vacío.');
      if (archivo.size > maxBytes)
        throw new BadRequestException(
          `El archivo pesa ${(archivo.size / 1048576).toFixed(0)} MB y el máximo es ${(maxBytes / 1048576).toFixed(0)} MB.`,
        );

      const fh = await open(archivo.path, 'r');
      const cab = Buffer.alloc(1100);
      const { bytesRead } = await fh.read(cab, 0, 1100, 0);
      await fh.close();
      const formato = detectarFormatoDtf(cab.subarray(0, bytesRead));
      if (!formato) throw new BadRequestException('Solo recibimos archivos PDF o PNG.');

      const hash = createHash('sha256');
      await pipeline(
        createReadStream(archivo.path),
        async function* (src) {
          for await (const chunk of src) hash.update(chunk as Buffer);
          yield Buffer.alloc(0);
        },
        async function (src) {
          for await (const _ of src) void _;
        },
      );
      const sha256 = hash.digest('hex');

      // Idempotencia: el mismo archivo otra vez no crea otra versión.
      const vigente = t.archivos.find((a) => a.version === t.versionVigente);
      if (vigente && vigente.sha256 === sha256)
        return { duplicado: true, trabajo: await this.vistaPara(trabajoId, actor) };

      const version = t.versionVigente + 1;
      const key = await this.storage.guardarDesdeRuta(archivo.path, t.id, version, formato);
      const ahora = new Date();
      const nuevoEstado: EstadoDtf = t.estado === 'BORRADOR' ? 'BORRADOR' : 'RECIBIDO';
      const a = await this.prisma
        .$transaction(async (tx) => {
          const fila = await tx.pedidoDtfArchivo.create({
            data: {
              dtfId: t.id,
              version,
              archivoKey: key,
              nombreOriginal: archivo.originalname.slice(0, 200),
              mime: formato === 'pdf' ? 'application/pdf' : 'image/png',
              bytes: archivo.size,
              sha256,
              canal,
              subidoPorId: actor.tipo === 'USUARIO' ? actor.user.userId : null,
              subidoPorRol: actor.tipo === 'USUARIO' ? actor.user.rol : 'CELULAR',
            },
          });
          await tx.pedidoDtf.update({
            where: { id: t.id },
            data: {
              versionVigente: version,
              estado: nuevoEstado,
              altoCm: null,
              anchoCm: null,
              metrosCobrados: null,
              subtotal: 0,
              asignadoAId: null,
              asignadoAt: null,
              aprobadoAt: null,
              horaEstimadaAt: null,
              correccionMotivos: Prisma.DbNull,
              correccionNota: null,
              aceptoRiesgo: false,
              ...(t.estado !== 'BORRADOR' && !t.recibidoAt ? { recibidoAt: ahora } : {}),
            },
          });
          await this.emisor.evento(
            tx,
            t.id,
            version === 1 ? 'ARCHIVO_SUBIDO' : 'VERSION_NUEVA',
            quien,
            {
              de: t.estado,
              a: nuevoEstado,
              detalle: { version, nombre: archivo.originalname, bytes: archivo.size, canal },
            },
          );
          return fila;
        })
        .catch(async (err: unknown) => {
          // El archivo YA está en el almacenamiento privado y la BD no lo registró: sin esto queda huérfano para siempre.
          await this.storage.eliminar(key);
          // Dos subidas al mismo borrador a la vez (web y celular por QR, un doble clic) calculan la misma versión desde
          // una lectura sin bloqueo; la segunda choca con `@@unique([dtfId, version])`. Es una carrera, no un 500.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new ConflictException(
              'Se acaba de subir otro archivo a este trabajo al mismo tiempo. Vuelve a intentarlo.',
            );
          }
          throw err;
        });
      this.emisor.archivoRecibido(t, version);
      this.emisor.estado({ ...t, estado: nuevoEstado });

      const analisis = this.analizar(a.id);
      let temporizador: NodeJS.Timeout | undefined;
      const espera = new Promise<'tarde'>((r) => {
        temporizador = setTimeout(() => r('tarde'), ESPERA_PREFLIGHT_MS);
      });
      try {
        await Promise.race([analisis, espera]);
      } finally {
        // Sin esto cada subida dejaba un temporizador vivo 25 s (con la fila del trabajo en su cierre) aunque el
        // análisis terminara antes.
        clearTimeout(temporizador);
      }
      return { duplicado: false, trabajo: await this.vistaPara(trabajoId, actor) };
    } finally {
      await unlink(archivo.path).catch(() => undefined);
    }
  }

  private async vistaPara(id: number, actor: ActorSubida) {
    const t = await this.cargar(id);
    const esCliente = actor.tipo === 'MOVIL' || actor.user.rol === 'CLIENTE';
    return vistaTrabajo(t, {
      mira: esCliente ? 'cliente' : 'impresion',
      userId: actor.tipo === 'USUARIO' ? actor.user.userId : undefined,
      esAdmin: actor.tipo === 'USUARIO' && actor.user.rol === 'ADMIN',
    });
  }

  /** Corre el motor sobre la versión y guarda el semáforo + la cotización. Nunca lanza. */
  async analizar(archivoId: number): Promise<void> {
    try {
      const a = await this.prisma.pedidoDtfArchivo.findUnique({
        where: { id: archivoId },
        include: { trabajo: { include: { tipo: true } } },
      });
      if (!a) return;
      const t = a.trabajo;
      const dir = await mkdtemp(join(tmpdir(), 'dtf-an-'));
      try {
        const { stream } = await this.storage.leer(a.archivoKey);
        const ruta = join(dir, `archivo.${a.mime === 'application/pdf' ? 'pdf' : 'png'}`);
        const { createWriteStream } = await import('fs');
        await pipeline(stream, createWriteStream(ruta));
        const previewTmp = join(dir, 'preview.png');
        const med = await this.runner.medir(
          ruta,
          a.mime === 'application/pdf' ? 'pdf' : 'png',
          previewTmp,
        );

        const params: ParametrosTipo = {
          anchoUtilCm: Number(t.tipo.anchoUtilCm),
          toleranciaAnchoCm: Number(t.tipo.toleranciaAnchoCm),
          minimoCm: Number(t.tipo.minimoCm),
          maxAlturaCm: Number(t.tipo.maxAlturaCm),
          dpiMinimo: t.tipo.dpiMinimo,
          textoMinPt: Number(t.tipo.textoMinPt),
          pasoCobroCm: t.tipo.pasoCobroCm,
          precioMetro: Number(t.precioMetro),
        };
        const res = med.ok ? evaluarPreflight(med.m, params) : preflightNoConcluyente(med.error);
        let previewKey: string | null = null;
        if (med.ok) {
          try {
            previewKey = await this.storage.guardarPreview(previewTmp, t.id, a.version);
          } catch (e) {
            this.logger.warn(`Sin vista previa de ${t.id}: ${(e as Error).message}`);
          }
        }
        await this.prisma.$transaction(async (tx) => {
          await tx.pedidoDtfArchivo.update({
            where: { id: a.id },
            data: {
              preflightEstado: res.estado,
              previewKey,
              preflight: {
                reglas: res.reglas,
                bloquea: res.bloquea,
                avisos: res.avisos,
                mediciones: med.ok ? med.m : null,
                error: med.ok ? null : med.error,
              } as unknown as Prisma.InputJsonValue,
            },
          });
          const vigente = await tx.pedidoDtf.findUnique({
            where: { id: t.id },
            select: { versionVigente: true, copias: true, pedidoId: true },
          });
          if (vigente && vigente.versionVigente === a.version) {
            // Sin medidas (no concluyente) se cotiza el mínimo hasta que Impresión confirme el alto.
            const alto = med.ok && med.m.altoCm != null ? med.m.altoCm : Number(t.tipo.minimoCm);
            const q = cotizar(
              alto,
              vigente.copias,
              { minimoCm: Number(t.tipo.minimoCm), pasoCobroCm: t.tipo.pasoCobroCm },
              t.precioMetro,
            );
            await tx.pedidoDtf.update({
              where: { id: t.id },
              data: {
                anchoCm:
                  med.ok && med.m.anchoCm != null
                    ? new Prisma.Decimal(med.m.anchoCm).toDecimalPlaces(1)
                    : null,
                altoCm:
                  med.ok && med.m.altoCm != null
                    ? new Prisma.Decimal(med.m.altoCm).toDecimalPlaces(1)
                    : null,
                metrosCobrados: q.metrosCobrados,
                subtotal: q.subtotal,
              },
            });
            if (vigente.pedidoId) {
              const p = await tx.pedido.findUnique({
                where: { id: vigente.pedidoId },
                select: { id: true, descuento: true, impuestos: true },
              });
              if (p) await recalcularTotalesPedido(tx, p);
            }
          }
          await this.emisor.evento(
            tx,
            t.id,
            'REVISION_AUTOMATICA',
            { id: null, rol: 'SISTEMA', nombre: 'Revisión automática' },
            { detalle: { version: a.version, estado: res.estado, avisos: res.avisos } },
          );
        });
        this.emisor.preflight(t, a.version, res.estado);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (e) {
      this.logger.error(`analizar(${archivoId}) falló: ${(e as Error).message}`);
    }
  }

  /** Recalcula la cotización con las medidas ya guardadas (cambió `copias` o el alto confirmado). */
  async recotizar(id: number, altoCm?: number) {
    const t = await this.prisma.pedidoDtf.findUnique({ where: { id }, include: { tipo: true } });
    if (!t) return;
    const alto = altoCm ?? (t.altoCm ? Number(t.altoCm) : null);
    if (alto == null) return;
    const q = cotizar(
      alto,
      t.copias,
      { minimoCm: Number(t.tipo.minimoCm), pasoCobroCm: t.tipo.pasoCobroCm },
      t.precioMetro,
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.pedidoDtf.update({
        where: { id },
        data: {
          altoCm: new Prisma.Decimal(alto).toDecimalPlaces(1),
          metrosCobrados: q.metrosCobrados,
          subtotal: q.subtotal,
        },
      });
      if (t.pedidoId) {
        const p = await tx.pedido.findUnique({
          where: { id: t.pedidoId },
          select: { id: true, descuento: true, impuestos: true },
        });
        if (p) await recalcularTotalesPedido(tx, p);
      }
    });
  }

  // ───────────────────────────── descargas ─────────────────────────────

  /** El original (para el RIP) o su vista previa. Solo dueño / Impresión de la tienda / ADMIN; el original deja bitácora. */
  async archivoParaDescargar(
    trabajoId: number,
    version: number | null,
    user: UserContext,
    preview: boolean,
  ) {
    const t = await this.cargar(trabajoId);
    this.exigirAcceso(t, user);
    const a = t.archivos.find((x) => x.version === (version ?? t.versionVigente));
    if (!a) throw new NotFoundException('Ese archivo no existe');
    const key = preview ? a.previewKey : a.archivoKey;
    if (!key) throw new NotFoundException('Todavía no hay vista previa');
    if (!preview)
      await this.emisor.evento(
        this.prisma,
        t.id,
        'ARCHIVO_DESCARGADO',
        { id: user.userId, rol: user.rol, nombre: user.nombre },
        { detalle: { version: a.version } },
      );
    const f = await this.storage.leer(key);
    // Nombre estándar para el RIP: elimina el "pon tu nombre en el archivo".
    const folio =
      t.pedido?.folioErp ??
      t.pedido?.pendienteEnvio?.externalFolio ??
      t.pedido?.numeroPedido ??
      `BORRADOR-${t.id}`;
    const seguro = (s: string) =>
      s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const metros = t.metrosCobrados ? `${Number(t.metrosCobrados).toFixed(2)}m` : 'sin-medir';
    const ext = preview ? 'png' : a.mime === 'application/pdf' ? 'pdf' : 'png';
    return {
      ...f,
      mime: preview ? 'image/png' : a.mime,
      nombre: `${seguro(folio)}_${seguro(t.pedido?.clienteNombre ?? t.usuario.nombre)}_${seguro(t.nombre)}_${t.tipo.tecnologia}_${metros}.${ext}`,
    };
  }

  // ───────────────────────────── QR del celular ─────────────────────────────

  enlaceSubida(trabajoId: number, usuarioId: number) {
    const secreto = this.config.get<string>('app.kioskoQrSecret') as string;
    const min = this.config.get<number>('app.dtf.subidaMovilMin') ?? 15;
    const { token, expiraAt } = firmarSubidaMovil(trabajoId, usuarioId, secreto, {
      vigenciaMin: min,
    });
    const base = (
      this.config.get<string>('app.mail.frontendUrl') ?? 'http://localhost:3001'
    ).replace(/\/$/, '');
    return { token, expiraAt, url: `${base}/dtf/subir?t=${encodeURIComponent(token)}` };
  }

  /** Verifica el token del celular y devuelve SOLO lo mínimo para pintar la página de subida. */
  async infoMovil(token: string) {
    const secreto = this.config.get<string>('app.kioskoQrSecret') as string;
    const v = verificarSubidaMovil(token, secreto);
    if (!v.valido)
      throw new ForbiddenException(
        v.motivo === 'EXPIRADO'
          ? 'Este enlace ya venció. Pide uno nuevo en la pantalla.'
          : 'Enlace no válido.',
      );
    const t = await this.prisma.pedidoDtf.findUnique({
      where: { id: v.trabajoId },
      include: { tipo: true },
    });
    if (!t || t.usuarioId !== v.usuarioId) throw new NotFoundException('Trabajo no encontrado');
    if (!ESTADOS_DTF_EDITABLES_POR_CLIENTE.includes(t.estado))
      throw new ConflictException('Este trabajo ya no admite archivos.');
    return {
      trabajoId: t.id,
      nombre: t.nombre,
      tecnologia: t.tipo.tecnologia,
      tipoNombre: t.tipo.nombre,
      anchoUtilCm: Number(t.tipo.anchoUtilCm),
      minimoCm: Number(t.tipo.minimoCm),
      maxAlturaCm: Number(t.tipo.maxAlturaCm),
      expiraAt: v.expiraAt,
      maxBytes: this.config.get<number>('app.dtf.maxBytes'),
    };
  }

  actorMovil(token: string): ActorSubida {
    const secreto = this.config.get<string>('app.kioskoQrSecret') as string;
    const v = verificarSubidaMovil(token, secreto);
    if (!v.valido)
      throw new ForbiddenException(
        v.motivo === 'EXPIRADO'
          ? 'Este enlace ya venció. Pide uno nuevo en la pantalla.'
          : 'Enlace no válido.',
      );
    return { tipo: 'MOVIL', trabajoId: v.trabajoId, usuarioId: v.usuarioId };
  }

  // ───────────────────────────── hilo con Impresión ─────────────────────────────

  async mensajes(trabajoId: number, user: UserContext) {
    const t = await this.cargar(trabajoId);
    this.exigirAcceso(t, user);
    const filas = await this.prisma.pedidoDtfMensaje.findMany({
      where: { dtfId: trabajoId },
      orderBy: { createdAt: 'asc' },
      include: { autor: { select: { nombre: true } } },
    });
    return filas.map((m) => ({
      id: m.id,
      autorRol: m.autorRol,
      autorNombre: m.autor.nombre,
      contenido: m.contenido,
      createdAt: m.createdAt,
      mio: m.autorId === user.userId,
    }));
  }

  async escribir(trabajoId: number, user: UserContext, contenido: string) {
    const t = await this.cargar(trabajoId);
    this.exigirAcceso(t, user);
    const texto = (contenido ?? '').trim();
    if (!texto) throw new BadRequestException('Escribe un mensaje.');
    if (!t.pedidoId)
      throw new ConflictException('El chat se abre cuando el trabajo ya está en un pedido.');
    const m = await this.prisma.pedidoDtfMensaje.create({
      data: {
        dtfId: trabajoId,
        autorId: user.userId,
        autorRol: user.rol,
        contenido: texto.slice(0, 2000),
      },
    });
    this.emisor.mensaje(t);
    return { id: m.id };
  }
}
