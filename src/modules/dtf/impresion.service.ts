import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EstadoDtf, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { resolverTiendaDeConsola } from '../../common/tienda-consola';
import { UserContext } from '../../types/pedido.types';
import { DtfEmisor } from './dtf-emisor.service';
import { DtfPedidoService } from './dtf-pedido.service';
import { DtfTrabajoService } from './dtf-trabajo.service';
import { INCLUDE_TRABAJO, TrabajoCompleto, vistaTrabajo } from './dtf-vista';
import { estimarHoraEntrega, horaLocal } from './core/dtf-eta.util';
import {
  MOTIVOS_CORRECCION,
  MOTIVOS_RECHAZO,
  MOTIVOS_REIMPRESION,
  motivoCorreccionValido,
  motivoRechazoValido,
} from './core/dtf-motivos';
import {
  ESTADOS_DTF_CON_HORA,
  ESTADOS_DTF_MEDIDAS_AJUSTABLES,
  transicionDtfPermitida,
} from './core/dtf-estado.util';
import { DtfCorreosService } from './dtf-correos.service';

export type TabCola = 'revisar' | 'correccion' | 'imprimir' | 'imprimiendo' | 'listos';
const ESTADOS_TAB: Record<TabCola, EstadoDtf[]> = {
  revisar: ['RECIBIDO', 'EN_REVISION'],
  correccion: ['NECESITA_CORRECCION', 'ARCHIVO_PENDIENTE'],
  imprimir: ['APROBADO'],
  imprimiendo: ['EN_IMPRESION'],
  listos: ['IMPRESO'],
};

/** Lo que hace el encargado de Impresión. El servidor decide qué botones caben (`acciones` de la vista). */
@Injectable()
export class ImpresionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly emisor: DtfEmisor,
    private readonly trabajos: DtfTrabajoService,
    private readonly pedidos: DtfPedidoService,
    private readonly correos: DtfCorreosService,
  ) {}

  /** La regla vive en un solo sitio (`common/tienda-consola.ts`): este fue su modelo y ya no la copia. */
  private tienda(user: UserContext, tiendaId?: number): number {
    return resolverTiendaDeConsola(user, tiendaId);
  }

  private zona(): string {
    return this.config.get<string>('app.pagos.zonaHoraria') || 'America/Mexico_City';
  }

  private actor(u: UserContext) {
    return { id: u.userId, rol: u.rol as string, nombre: u.nombre };
  }

  // ───────────────────────────── cola y resumen ─────────────────────────────

  async resumen(user: UserContext, tiendaId?: number) {
    const tid = this.tienda(user, tiendaId);
    const grupos = await this.prisma.pedidoDtf.groupBy({
      by: ['estado'],
      where: {
        tiendaId: tid,
        estado: {
          in: [
            'RECIBIDO',
            'EN_REVISION',
            'NECESITA_CORRECCION',
            'ARCHIVO_PENDIENTE',
            'APROBADO',
            'EN_IMPRESION',
          ],
        },
      },
      _count: true,
    });
    const n = (...e: EstadoDtf[]) =>
      grupos.filter((g) => e.includes(g.estado)).reduce((a, g) => a + g._count, 0);
    const { desde, hasta } = this.rangoDelDia(new Date());
    const hoy = await this.prisma.pedidoDtf.findMany({
      where: {
        tiendaId: tid,
        OR: [{ recibidoAt: { gte: desde, lt: hasta } }],
        estado: { notIn: ['BORRADOR', 'CANCELADO', 'EXPIRADO', 'RECHAZADO'] },
      },
      select: { metrosCobrados: true, tipo: { select: { tecnologia: true } } },
    });
    const metros = { TEXTIL: 0, UV: 0 } as Record<string, number>;
    for (const h of hoy) metros[h.tipo.tecnologia] += Number(h.metrosCobrados ?? 0);
    const listos = await this.prisma.pedidoDtf.count({
      where: {
        tiendaId: tid,
        estado: 'IMPRESO',
        pedido: {
          estado: { in: ['EN_DTF', 'REVISADO', 'EN_ATENCION', 'PENDIENTE_PAGO', 'PAGADO'] },
        },
      },
    });
    return {
      tabs: {
        revisar: n('RECIBIDO', 'EN_REVISION'),
        correccion: n('NECESITA_CORRECCION', 'ARCHIVO_PENDIENTE'),
        imprimir: n('APROBADO'),
        imprimiendo: n('EN_IMPRESION'),
        listos,
      },
      hoy: {
        metrosTextil: Number(metros.TEXTIL.toFixed(2)),
        metrosUv: Number(metros.UV.toFixed(2)),
        metros: Number((metros.TEXTIL + metros.UV).toFixed(2)),
        trabajos: hoy.length,
      },
    };
  }

  async cola(
    user: UserContext,
    q: { tab?: TabCola; tecnologia?: string; q?: string; tiendaId?: number },
  ) {
    const tid = this.tienda(user, q.tiendaId);
    const tab = (q.tab && ESTADOS_TAB[q.tab] ? q.tab : 'revisar') as TabCola;
    const busca = (q.q ?? '').trim();
    const where: Prisma.PedidoDtfWhereInput = {
      tiendaId: tid,
      estado: { in: ESTADOS_TAB[tab] },
      ...(tab === 'listos'
        ? {
            pedido: {
              estado: { in: ['EN_DTF', 'REVISADO', 'EN_ATENCION', 'PENDIENTE_PAGO', 'PAGADO'] },
            },
          }
        : {}),
      ...(q.tecnologia === 'TEXTIL' || q.tecnologia === 'UV'
        ? { tipo: { tecnologia: q.tecnologia } }
        : {}),
      ...(busca
        ? {
            OR: [
              { nombre: { contains: busca, mode: 'insensitive' } },
              { usuario: { nombre: { contains: busca, mode: 'insensitive' } } },
              { pedido: { numeroPedido: { contains: busca, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const filas = await this.prisma.pedidoDtf.findMany({
      where,
      include: INCLUDE_TRABAJO,
      // La cola es FIFO por llegada (el lugar se conserva al subir versiones); el orden manual manda.
      orderBy: [
        { ordenCola: { sort: 'asc', nulls: 'last' } },
        { recibidoAt: 'asc' },
        { id: 'asc' },
      ],
      take: 200,
    });
    const etas = await this.etasProvisionales(tid, filas);
    return filas.map((t) =>
      vistaTrabajo(t, {
        mira: 'impresion',
        userId: user.userId,
        esAdmin: user.rol === 'ADMIN',
        etaProvisional: etas.get(t.id) ?? null,
      }),
    );
  }

  async detalle(user: UserContext, id: number) {
    const t = await this.trabajos.cargar(id);
    this.trabajos.exigirAcceso(t, user);
    const eta = (await this.etasProvisionales(t.tiendaId, [t])).get(t.id) ?? null;
    const [eventos, mensajes, previos, otros] = await Promise.all([
      this.prisma.pedidoDtfEvento.findMany({ where: { dtfId: id }, orderBy: { createdAt: 'asc' } }),
      this.trabajos.mensajes(id, user),
      // ¿Este mismo diseño ya se aprobó/imprimió antes para este cliente? (mismo sha256)
      this.prisma.pedidoDtfArchivo.findMany({
        where: {
          sha256: { in: t.archivos.map((a) => a.sha256) },
          dtfId: { not: id },
          trabajo: {
            usuarioId: t.usuarioId,
            estado: { in: ['APROBADO', 'EN_IMPRESION', 'IMPRESO'] },
          },
        },
        select: { dtfId: true, trabajo: { select: { nombre: true, impresoAt: true } } },
        take: 3,
      }),
      this.prisma.pedidoDtf.count({
        where: {
          usuarioId: t.usuarioId,
          tiendaId: t.tiendaId,
          estado: { in: ['IMPRESO', 'EN_IMPRESION', 'APROBADO'] },
        },
      }),
    ]);
    const base = vistaTrabajo(t, {
      mira: 'impresion',
      userId: user.userId,
      esAdmin: user.rol === 'ADMIN',
      etaProvisional: eta,
    });
    return {
      ...base,
      cliente: {
        id: t.usuario.id,
        nombre: `${t.usuario.nombre}${t.usuario.apellido ? ' ' + t.usuario.apellido : ''}`,
        email: t.usuario.email,
        telefono: t.usuario.telefono,
        trabajosPrevios: otros,
      },
      disenoYaAprobado: previos.length
        ? { trabajo: previos[0].trabajo.nombre, fecha: previos[0].trabajo.impresoAt }
        : null,
      eventos: eventos.map((e) => ({
        id: e.id,
        tipo: e.tipo,
        de: e.deEstado,
        a: e.aEstado,
        actor: e.actorNombre,
        rol: e.actorRol,
        detalle: e.detalle,
        createdAt: e.createdAt,
      })),
      mensajes,
      motivos: {
        correccion: MOTIVOS_CORRECCION.map(({ codigo, etiqueta }) => ({ codigo, etiqueta })),
        rechazo: MOTIVOS_RECHAZO.map(({ codigo, etiqueta }) => ({ codigo, etiqueta })),
        reimpresion: MOTIVOS_REIMPRESION,
      },
    };
  }

  // ───────────────────────────── hora estimada ─────────────────────────────

  /** Metros que van antes en la cola de la misma tecnología (aprobados / imprimiendo). */
  private async metrosPorDelante(
    tiendaId: number,
    tipoId: number,
    excluirId: number,
    antesDe?: Date | null,
  ): Promise<number> {
    const filas = await this.prisma.pedidoDtf.findMany({
      where: {
        tiendaId,
        tipoId,
        id: { not: excluirId },
        estado: { in: ['APROBADO', 'EN_IMPRESION'] },
        ...(antesDe ? { OR: [{ estado: 'EN_IMPRESION' }, { aprobadoAt: { lt: antesDe } }] } : {}),
      },
      select: { metrosCobrados: true },
    });
    return filas.reduce((a, f) => a + Number(f.metrosCobrados ?? 0), 0);
  }

  private async etasProvisionales(
    tiendaId: number,
    filas: TrabajoCompleto[],
  ): Promise<Map<number, Date>> {
    const out = new Map<number, Date>();
    const ahora = new Date();
    const cfgs = await this.prisma.tiendaDtf.findMany({ where: { tiendaId } });
    for (const t of filas) {
      if (t.horaEstimadaAt || !['RECIBIDO', 'EN_REVISION', 'APROBADO'].includes(t.estado)) continue;
      const vel = cfgs.find((c) => c.tipoId === t.tipoId)?.velocidadMetrosHora;
      const delante = await this.metrosPorDelante(tiendaId, t.tipoId, t.id, null);
      const eta = estimarHoraEntrega({
        ahora,
        metrosPorDelante: delante,
        metros: Number(t.metrosCobrados ?? 0),
        velocidadMetrosHora: vel ? Number(vel) : null,
      });
      if (eta) out.set(t.id, eta);
    }
    return out;
  }

  // ───────────────────────────── acciones ─────────────────────────────

  /**
   * Cambio de estado con guarda atómica (`updateMany` con el estado y la versión que se leyeron). Ojo: `updateMany`
   * solo admite campos ESCALARES. Antes varias acciones pasaban `asignadoA: { connect/disconnect }` y Prisma lo
   * rechazaba, así que aprobar, pedir corrección, rechazar, imprimir y soltar respondían 500; se usa `asignadoAId`.
   */
  private async cambiar(
    id: number,
    user: UserContext,
    a: EstadoDtf,
    tipoEvento: string,
    data: Prisma.PedidoDtfUncheckedUpdateManyInput,
    detalle?: Prisma.InputJsonValue,
    guarda?: (t: TrabajoCompleto) => void,
  ) {
    const t = await this.trabajos.cargar(id);
    this.trabajos.exigirAcceso(t, user);
    if (!transicionDtfPermitida(t.estado, a))
      throw new ConflictException(`No se puede pasar de ${t.estado} a ${a}.`);
    guarda?.(t);
    const r = await this.prisma.pedidoDtf.updateMany({
      where: { id, estado: t.estado, versionVigente: t.versionVigente },
      data: { ...data, estado: a },
    });
    if (r.count !== 1)
      throw new ConflictException(
        'El trabajo cambió mientras lo procesabas. Actualiza la pantalla.',
      );
    await this.emisor.evento(this.prisma, id, tipoEvento, this.actor(user), {
      de: t.estado,
      a,
      detalle,
    });
    const nuevo = await this.trabajos.cargar(id);
    this.emisor.estado(nuevo);
    return { antes: t, nuevo };
  }

  async tomar(id: number, user: UserContext) {
    const t = await this.trabajos.cargar(id);
    this.trabajos.exigirAcceso(t, user);
    const r = await this.prisma.pedidoDtf.updateMany({
      where: { id, estado: 'RECIBIDO', asignadoAId: null },
      data: { estado: 'EN_REVISION', asignadoAId: user.userId, asignadoAt: new Date() },
    });
    if (r.count !== 1) {
      const actual = await this.trabajos.cargar(id);
      throw new ConflictException(
        actual.asignadoA
          ? `Lo está revisando ${actual.asignadoA.nombre}.`
          : 'Este trabajo ya no está en la cola de revisión.',
      );
    }
    await this.emisor.evento(this.prisma, id, 'TOMADO', this.actor(user), {
      de: 'RECIBIDO',
      a: 'EN_REVISION',
    });
    this.emisor.estado({ ...t, estado: 'EN_REVISION' });
    return this.detalle(user, id);
  }

  async soltar(id: number, user: UserContext) {
    await this.cambiar(
      id,
      user,
      'RECIBIDO',
      'SOLTADO',
      { asignadoAId: null, asignadoAt: null },
      undefined,
      (t) => {
        if (t.asignadoAId !== user.userId && user.rol !== 'ADMIN')
          throw new ForbiddenException('Solo quien lo tiene puede soltarlo.');
      },
    );
    return this.detalle(user, id);
  }

  async aprobar(id: number, user: UserContext, dto: { planoBlanco?: boolean; nota?: string }) {
    const ahora = new Date();
    const { antes } = await this.cambiar(
      id,
      user,
      'APROBADO',
      'APROBADO',
      {
        aprobadoAt: ahora,
        planoBlancoAt: dto.planoBlanco ? ahora : null,
        asignadoAId: user.userId,
        asignadoAt: ahora,
        correccionMotivos: Prisma.DbNull,
        correccionNota: null,
      },
      { nota: dto.nota ?? null, planoBlanco: Boolean(dto.planoBlanco) },
      (t) => {
        if (!t.archivos.length) throw new ConflictException('Todavía no hay archivo que aprobar.');
        if (t.archivos.find((a) => a.version === t.versionVigente)?.preflightEstado === 'BLOQUEADO')
          throw new ConflictException(
            'El archivo tiene errores que impiden imprimirlo: pide una corrección.',
          );
      },
    );
    // La hora estimada se fija al aprobar (queda editable).
    const cfg = await this.prisma.tiendaDtf.findUnique({
      where: { tiendaId_tipoId: { tiendaId: antes.tiendaId, tipoId: antes.tipoId } },
    });
    const delante = await this.metrosPorDelante(antes.tiendaId, antes.tipoId, id, ahora);
    const eta = estimarHoraEntrega({
      ahora,
      metrosPorDelante: delante,
      metros: Number(antes.metrosCobrados ?? 0),
      velocidadMetrosHora: cfg?.velocidadMetrosHora ? Number(cfg.velocidadMetrosHora) : null,
    });
    if (eta) await this.prisma.pedidoDtf.update({ where: { id }, data: { horaEstimadaAt: eta } });
    void this.correos.enviar(id, 'DTF_APROBADO');
    return this.detalle(user, id);
  }

  async pedirCorreccion(id: number, user: UserContext, dto: { motivos?: string[]; nota?: string }) {
    const motivos = (dto.motivos ?? []).filter(motivoCorreccionValido);
    const nota = (dto.nota ?? '').trim();
    if (!motivos.length && !nota)
      throw new BadRequestException('Elige al menos un motivo o escribe una nota.');
    await this.cambiar(
      id,
      user,
      'NECESITA_CORRECCION',
      'CORRECCION_PEDIDA',
      {
        correccionMotivos: motivos,
        correccionNota: nota || null,
        asignadoAId: null,
        asignadoAt: null,
        aprobadoAt: null,
        horaEstimadaAt: null,
      },
      { motivos, nota: nota || null },
    );
    void this.correos.enviar(id, 'DTF_NECESITA_CORRECCION');
    return this.detalle(user, id);
  }

  async rechazar(id: number, user: UserContext, dto: { motivo: string; nota?: string }) {
    if (!motivoRechazoValido(dto.motivo))
      throw new BadRequestException('Elige el motivo del rechazo.');
    const { antes } = await this.cambiar(
      id,
      user,
      'RECHAZADO',
      'RECHAZADO',
      {
        rechazoMotivo: dto.motivo,
        rechazoNota: (dto.nota ?? '').trim() || null,
        asignadoAId: null,
        asignadoAt: null,
        horaEstimadaAt: null,
      },
      { motivo: dto.motivo, nota: dto.nota ?? null },
    );
    void this.correos.enviar(id, 'DTF_RECHAZADO');
    if (antes.pedidoId) await this.pedidos.resolver(antes.pedidoId, user);
    return this.detalle(user, id);
  }

  async imprimir(id: number, user: UserContext) {
    await this.cambiar(id, user, 'EN_IMPRESION', 'IMPRIMIENDO', {
      imprimiendoAt: new Date(),
      asignadoAId: user.userId,
      asignadoAt: new Date(),
    });
    return this.detalle(user, id);
  }

  async marcarImpreso(id: number, user: UserContext) {
    const { antes } = await this.cambiar(id, user, 'IMPRESO', 'IMPRESO', { impresoAt: new Date() });
    if (antes.pedidoId) await this.pedidos.resolver(antes.pedidoId, user);
    return this.detalle(user, id);
  }

  async loteImpreso(ids: number[], user: UserContext) {
    const hechos: number[] = [];
    for (const id of ids.slice(0, 50)) {
      try {
        await this.marcarImpreso(id, user);
        hechos.push(id);
      } catch {
        /* uno que ya cambió no frena al resto */
      }
    }
    return { impresos: hechos.length, omitidos: ids.length - hechos.length };
  }

  /** Falla de impresión (misma película) o defecto hallado al entregar (el pedido vuelve a esperar). */
  async reimprimir(id: number, user: UserContext, dto: { motivo: string; nota?: string }) {
    if (!MOTIVOS_REIMPRESION.some((m) => m.codigo === dto.motivo))
      throw new BadRequestException('Elige el motivo de la reimpresión.');
    const t = await this.trabajos.cargar(id);
    this.trabajos.exigirAcceso(t, user);
    if (t.estado !== 'EN_IMPRESION' && t.estado !== 'IMPRESO')
      throw new ConflictException(
        'Solo se reimprime un trabajo que se está imprimiendo o ya impreso.',
      );
    const eraImpreso = t.estado === 'IMPRESO';
    await this.prisma.pedidoDtf.update({
      where: { id },
      data: {
        estado: 'EN_IMPRESION',
        impresoAt: null,
        imprimiendoAt: new Date(),
        reimpresiones: { increment: 1 },
      },
    });
    await this.emisor.evento(this.prisma, id, 'REIMPRESION', this.actor(user), {
      de: t.estado,
      a: 'EN_IMPRESION',
      detalle: { motivo: dto.motivo, nota: dto.nota ?? null },
    });
    if (eraImpreso && t.pedidoId) await this.pedidos.reabrir(t.pedidoId, user, dto.motivo);
    this.emisor.estado({ ...t, estado: 'EN_IMPRESION' });
    return this.detalle(user, id);
  }

  async ajustarMedidas(id: number, user: UserContext, altoCm: number) {
    const t = await this.trabajos.cargar(id);
    this.trabajos.exigirAcceso(t, user);
    if (!ESTADOS_DTF_MEDIDAS_AJUSTABLES.includes(t.estado))
      throw new ConflictException('Ya no se pueden cambiar las medidas de este trabajo.');
    if (!Number.isFinite(altoCm) || altoCm < 1 || altoCm > Number(t.tipo.maxAlturaCm))
      throw new BadRequestException('Alto inválido.');
    await this.trabajos.recotizar(id, altoCm);
    await this.emisor.evento(this.prisma, id, 'MEDIDAS_AJUSTADAS', this.actor(user), {
      detalle: { altoCm },
    });
    this.emisor.estado(t);
    return this.detalle(user, id);
  }

  async horaEstimada(id: number, user: UserContext, hora: string | null) {
    const t = await this.trabajos.cargar(id);
    this.trabajos.exigirAcceso(t, user);
    if (!ESTADOS_DTF_CON_HORA.includes(t.estado))
      throw new ConflictException('Este trabajo ya no tiene hora de entrega que ajustar.');
    const fecha = hora ? new Date(hora) : null;
    if (hora && isNaN(fecha!.getTime())) throw new BadRequestException('Hora inválida.');
    await this.prisma.pedidoDtf.update({ where: { id }, data: { horaEstimadaAt: fecha } });
    await this.emisor.evento(this.prisma, id, 'HORA_AJUSTADA', this.actor(user), {
      detalle: { hora },
    });
    this.emisor.estado(t);
    return this.detalle(user, id);
  }

  // ───────────────────────────── la hoja del día (el Excel) ─────────────────────────────

  private rangoDelDia(ref: Date, fecha?: string) {
    const zona = this.zona();
    const base = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? new Date(`${fecha}T12:00:00Z`) : ref;
    const { h, m } = horaLocal(base, zona);
    // Inicio del día en la zona del negocio: se retrocede lo transcurrido desde la medianoche local.
    const inicio = new Date(base.getTime() - (h * 60 + m) * 60_000);
    inicio.setSeconds(0, 0);
    return { desde: inicio, hasta: new Date(inicio.getTime() + 24 * 3_600_000) };
  }

  async hoja(user: UserContext, q: { fecha?: string; tiendaId?: number }) {
    const tid = this.tienda(user, q.tiendaId);
    const { desde, hasta } = this.rangoDelDia(new Date(), q.fecha);
    const filas = await this.prisma.pedidoDtf.findMany({
      where: {
        tiendaId: tid,
        recibidoAt: { gte: desde, lt: hasta },
        estado: { notIn: ['BORRADOR', 'CANCELADO', 'EXPIRADO'] },
      },
      include: {
        tipo: { select: { tecnologia: true } },
        usuario: { select: { nombre: true, apellido: true } },
        pedido: { select: { clienteNombre: true } },
      },
      orderBy: { recibidoAt: 'asc' },
    });
    const fmtHora = (d: Date | null) => {
      if (!d) return '';
      const { h, m } = horaLocal(d, this.zona());
      return `${h}:${String(m).padStart(2, '0')}`;
    };
    const rows = filas.map((f) => ({
      fecha: f.recibidoAt,
      nombre: f.pedido?.clienteNombre ?? `${f.usuario.nombre} ${f.usuario.apellido ?? ''}`.trim(),
      descripcion: f.nombre,
      metros: Number(f.metrosCobrados ?? 0),
      hora: fmtHora(f.horaEstimadaAt ?? f.impresoAt),
      tecnologia: f.tipo.tecnologia,
      estado: f.estado,
    }));
    const total = (t: string) =>
      Number(
        rows
          .filter((r) => r.tecnologia === t && r.estado !== 'RECHAZADO')
          .reduce((a, r) => a + r.metros, 0)
          .toFixed(2),
      );
    return {
      fecha: desde,
      filas: rows,
      totales: {
        textil: total('TEXTIL'),
        uv: total('UV'),
        metros: Number((total('TEXTIL') + total('UV')).toFixed(2)),
      },
    };
  }

  async hojaCsv(user: UserContext, q: { fecha?: string; tiendaId?: number }) {
    const h = await this.hoja(user, q);
    const esc = (v: unknown) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutraliza fórmulas (CSV injection)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const dia = h.fecha.toISOString().slice(0, 10);
    const lineas = [['FECHA', 'NOMBRE', 'DESCRIPCION', 'MTS', 'HORA', 'TECNOLOGIA'].join(',')];
    for (const r of h.filas)
      lineas.push(
        [dia, r.nombre, r.descripcion, r.metros.toFixed(2), r.hora, r.tecnologia]
          .map(esc)
          .join(','),
      );
    lineas.push(['', '', 'TOTAL', h.totales.metros.toFixed(2), '', ''].join(','));
    return { nombre: `hoja-dtf-${dia}.csv`, contenido: '﻿' + lineas.join('\r\n') };
  }
}
