import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TecnologiaDtf } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PreciosService } from '../precios/precios.service';
import { ColumnaLista, precioDeLista } from '../precios/precio-lista.util';

export interface TipoVisible {
  tipoId: number;
  tecnologia: TecnologiaDtf;
  nombre: string;
  descripcion: string | null;
  anchoUtilCm: number;
  toleranciaAnchoCm: number;
  minimoCm: number;
  maxAlturaCm: number;
  pasoCobroCm: number;
  dpiMinimo: number;
  textoMinPt: number;
  precioMetro: number | null;
  maquina: string | null;
  fueraDeServicio: boolean;
  horaCorte: string | null;
}

/**
 * Tarifas, reglas y qué tienda imprime qué tecnología (PLAN-DTF.md D5 y D16). El precio sale del
 * producto-servicio del ERP si el tipo lo tiene (`productoId` → `Precio` de ESA tienda, columna de la
 * lista del cliente) y, si no, de la tarifa manual `precioMetro`.
 */
@Injectable()
export class DtfConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly precios: PreciosService,
  ) {}

  async precioMetro(
    tipo: { productoId: number | null; precioMetro: Prisma.Decimal | null },
    tiendaId: number,
    columna: ColumnaLista,
  ): Promise<Prisma.Decimal | null> {
    if (tipo.productoId) {
      const p = await this.prisma.precio.findFirst({
        where: { productoId: tipo.productoId, tiendaId, activo: true },
      });
      if (p) {
        const v = precioDeLista(p as never, columna);
        if (v.gt(0)) return v;
      }
    }
    return tipo.precioMetro;
  }

  /** Lo que ESTA tienda ofrece, con el precio de ESTE cliente (o la lista 1 si no hay sesión). */
  async tiposDeTienda(tiendaId: number, usuarioId?: number | null): Promise<TipoVisible[]> {
    const columna: ColumnaLista = usuarioId
      ? await this.precios.columnaParaUsuario(usuarioId, tiendaId)
      : 'lista1';
    const filas = await this.prisma.tiendaDtf.findMany({
      where: { tiendaId, activo: true, tipo: { activo: true } },
      include: { tipo: true },
      orderBy: { tipo: { orden: 'asc' } },
    });
    const out: TipoVisible[] = [];
    for (const f of filas) {
      const precio = await this.precioMetro(f.tipo, tiendaId, columna);
      out.push({
        tipoId: f.tipo.id,
        tecnologia: f.tipo.tecnologia,
        nombre: f.tipo.nombre,
        descripcion: f.tipo.descripcion,
        anchoUtilCm: Number(f.tipo.anchoUtilCm),
        toleranciaAnchoCm: Number(f.tipo.toleranciaAnchoCm),
        minimoCm: Number(f.tipo.minimoCm),
        maxAlturaCm: Number(f.tipo.maxAlturaCm),
        pasoCobroCm: f.tipo.pasoCobroCm,
        dpiMinimo: f.tipo.dpiMinimo,
        textoMinPt: Number(f.tipo.textoMinPt),
        precioMetro: precio ? Number(precio) : null,
        maquina: f.maquina,
        fueraDeServicio: f.fueraDeServicio,
        horaCorte: f.horaCorte,
      });
    }
    return out;
  }

  /** La landing pública: qué tiendas ofrecen DTF y a qué precio base (lista 1). */
  async publico() {
    const filas = await this.prisma.tiendaDtf.findMany({
      where: { activo: true, tipo: { activo: true }, tienda: { activa: true } },
      include: { tipo: true, tienda: { select: { id: true, nombre: true, ciudad: true } } },
      orderBy: [{ tipo: { orden: 'asc' } }, { tiendaId: 'asc' }],
    });
    const tipos = new Map<number, Record<string, unknown>>();
    for (const f of filas) {
      const precio = await this.precioMetro(f.tipo, f.tiendaId, 'lista1');
      const t = (tipos.get(f.tipo.id) ?? {
        tipoId: f.tipo.id,
        tecnologia: f.tipo.tecnologia,
        nombre: f.tipo.nombre,
        descripcion: f.tipo.descripcion,
        anchoUtilCm: Number(f.tipo.anchoUtilCm),
        minimoCm: Number(f.tipo.minimoCm),
        maxAlturaCm: Number(f.tipo.maxAlturaCm),
        pasoCobroCm: f.tipo.pasoCobroCm,
        dpiMinimo: f.tipo.dpiMinimo,
        tiendas: [] as unknown[],
      }) as Record<string, unknown> & { tiendas: unknown[] };
      t.tiendas.push({
        id: f.tienda.id,
        nombre: f.tienda.nombre,
        ciudad: f.tienda.ciudad,
        precioMetro: precio ? Number(precio) : null,
        fueraDeServicio: f.fueraDeServicio,
      });
      tipos.set(f.tipo.id, t);
    }
    return Array.from(tipos.values());
  }

  /** ¿Esta tienda imprime este tipo? Devuelve la fila o lanza 409 con el motivo. */
  async exigirTiendaConTipo(tiendaId: number, tipoId: number) {
    const f = await this.prisma.tiendaDtf.findUnique({
      where: { tiendaId_tipoId: { tiendaId, tipoId } },
      include: { tipo: true },
    });
    if (!f || !f.activo || !f.tipo.activo) {
      throw new ConflictException(
        'Esta tienda no ofrece ese tipo de impresión DTF. Elige otra tienda o tecnología.',
      );
    }
    return f;
  }

  // ───────────────────────────── Admin ─────────────────────────────

  async adminListar() {
    const [tipos, tiendas, filas] = await Promise.all([
      this.prisma.dtfTipo.findMany({
        orderBy: { orden: 'asc' },
        include: { producto: { select: { id: true, codigo: true, nombre: true } } },
      }),
      this.prisma.tienda.findMany({
        where: { activa: true },
        orderBy: { id: 'asc' },
        select: { id: true, nombre: true, ciudad: true },
      }),
      this.prisma.tiendaDtf.findMany(),
    ]);
    return {
      tipos: tipos.map((t) => ({
        id: t.id,
        tecnologia: t.tecnologia,
        nombre: t.nombre,
        descripcion: t.descripcion,
        producto: t.producto,
        precioMetro: t.precioMetro ? Number(t.precioMetro) : null,
        anchoUtilCm: Number(t.anchoUtilCm),
        toleranciaAnchoCm: Number(t.toleranciaAnchoCm),
        minimoCm: Number(t.minimoCm),
        maxAlturaCm: Number(t.maxAlturaCm),
        pasoCobroCm: t.pasoCobroCm,
        dpiMinimo: t.dpiMinimo,
        textoMinPt: Number(t.textoMinPt),
        pagoAntes: t.pagoAntes,
        activo: t.activo,
      })),
      tiendas: tiendas.map((tienda) => ({
        ...tienda,
        config: filas
          .filter((f) => f.tiendaId === tienda.id)
          .map((f) => ({
            tipoId: f.tipoId,
            activo: f.activo,
            maquina: f.maquina,
            velocidadMetrosHora: f.velocidadMetrosHora ? Number(f.velocidadMetrosHora) : null,
            horaCorte: f.horaCorte,
            cupoMetrosDia: f.cupoMetrosDia ? Number(f.cupoMetrosDia) : null,
            fueraDeServicio: f.fueraDeServicio,
          })),
      })),
    };
  }

  async adminActualizarTipo(id: number, d: Partial<Record<string, unknown>>) {
    const t = await this.prisma.dtfTipo.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Tipo de DTF no encontrado');
    const num = (v: unknown, nombre: string, min: number, max: number) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max)
        throw new BadRequestException(`${nombre} debe estar entre ${min} y ${max}`);
      return n;
    };
    const data: Prisma.DtfTipoUpdateInput = {};
    if (d.nombre !== undefined) data.nombre = String(d.nombre).trim().slice(0, 60) || t.nombre;
    if (d.descripcion !== undefined)
      data.descripcion = d.descripcion ? String(d.descripcion) : null;
    if (d.precioMetro !== undefined)
      data.precioMetro =
        d.precioMetro === null || d.precioMetro === ''
          ? null
          : new Prisma.Decimal(num(d.precioMetro, 'El precio', 0, 100000));
    if (d.minimoCm !== undefined)
      data.minimoCm = new Prisma.Decimal(num(d.minimoCm, 'El mínimo', 1, 500));
    if (d.maxAlturaCm !== undefined)
      data.maxAlturaCm = new Prisma.Decimal(num(d.maxAlturaCm, 'El alto máximo', 10, 2000));
    if (d.anchoUtilCm !== undefined)
      data.anchoUtilCm = new Prisma.Decimal(num(d.anchoUtilCm, 'El ancho', 10, 500));
    if (d.toleranciaAnchoCm !== undefined)
      data.toleranciaAnchoCm = new Prisma.Decimal(num(d.toleranciaAnchoCm, 'La tolerancia', 0, 10));
    if (d.pasoCobroCm !== undefined)
      data.pasoCobroCm = Math.round(num(d.pasoCobroCm, 'El paso de cobro', 1, 500));
    if (d.dpiMinimo !== undefined)
      data.dpiMinimo = Math.round(num(d.dpiMinimo, 'El DPI', 72, 1200));
    if (d.textoMinPt !== undefined)
      data.textoMinPt = new Prisma.Decimal(num(d.textoMinPt, 'El texto mínimo', 1, 50));
    if (d.pagoAntes !== undefined) data.pagoAntes = Boolean(d.pagoAntes);
    if (d.activo !== undefined) data.activo = Boolean(d.activo);
    return this.prisma.dtfTipo.update({ where: { id }, data });
  }

  async adminGuardarTienda(tiendaId: number, tipoId: number, d: Record<string, unknown>) {
    const [tienda, tipo] = await Promise.all([
      this.prisma.tienda.findUnique({ where: { id: tiendaId } }),
      this.prisma.dtfTipo.findUnique({ where: { id: tipoId } }),
    ]);
    if (!tienda || !tipo) throw new NotFoundException('Tienda o tipo no encontrado');
    const dec = (v: unknown) =>
      v === null || v === undefined || v === '' ? null : new Prisma.Decimal(Number(v));
    if (d.horaCorte && !/^\d{1,2}:\d{2}$/.test(String(d.horaCorte)))
      throw new BadRequestException('La hora de corte debe ser HH:MM');
    const data = {
      activo: d.activo === undefined ? undefined : Boolean(d.activo),
      maquina:
        d.maquina === undefined ? undefined : d.maquina ? String(d.maquina).slice(0, 60) : null,
      velocidadMetrosHora:
        d.velocidadMetrosHora === undefined ? undefined : dec(d.velocidadMetrosHora),
      horaCorte: d.horaCorte === undefined ? undefined : d.horaCorte ? String(d.horaCorte) : null,
      cupoMetrosDia: d.cupoMetrosDia === undefined ? undefined : dec(d.cupoMetrosDia),
      fueraDeServicio: d.fueraDeServicio === undefined ? undefined : Boolean(d.fueraDeServicio),
    };
    return this.prisma.tiendaDtf.upsert({
      where: { tiendaId_tipoId: { tiendaId, tipoId } },
      update: data,
      create: {
        tiendaId,
        tipoId,
        activo: data.activo ?? true,
        maquina: data.maquina ?? null,
        velocidadMetrosHora: data.velocidadMetrosHora ?? null,
        horaCorte: data.horaCorte ?? null,
        cupoMetrosDia: data.cupoMetrosDia ?? null,
        fueraDeServicio: data.fueraDeServicio ?? false,
      },
    });
  }
}
