import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ExternalRefService } from '../external-ref.service';
import type { SyncEventoDto } from '../dto/upload-batch.dto';

/**
 * CatalogHandler: procesa eventos CATALOGO de BANDEJA_SYNC.
 *
 * Entidades soportadas (los 13 triggers TRG_*_SYNC):
 *   - PRODUCTOS, CORRIDAS, CORRIDASREN, COLORES, LINEAS, SUBLINEAS
 *     → entidades globales, sin tienda local.
 *   - PRECIOS, PRECIOSCO
 *     → tienen localTiendaId. Las 6 listas (PRECIO1..6) se mapean a
 *       Precio.lista1..6 / PrecioCO.lista1..6. precioBase/precio siguen
 *       siendo sinónimo de lista1.
 *
 * Idempotencia: el handler hace upsert sobre la clave natural
 * (codigo/talla/color/etc.). Si la entidad ya existe, actualiza;
 * si no, crea. El ExternalRef se mantiene en ambos sentidos.
 */
@Injectable()
export class CatalogHandler {
  private readonly logger = new Logger(CatalogHandler.name);

  constructor(
    private prisma: PrismaService,
    private externalRefs: ExternalRefService,
  ) {}

  async procesar(evento: SyncEventoDto): Promise<{ ok: boolean; mensaje?: string }> {
    try {
      switch (evento.entidad) {
        case 'PRODUCTOS':
          return await this.procesarProducto(evento);
        case 'CORRIDAS':
          return await this.procesarCorrida(evento);
        case 'CORRIDASREN':
          return await this.procesarCorridaRen(evento);
        case 'COLORES':
          return await this.procesarColor(evento);
        case 'LINEAS':
          return await this.procesarLinea(evento);
        case 'SUBLINEAS':
          return await this.procesarSublinea(evento);
        case 'PRECIOS':
          return await this.procesarPrecio(evento);
        case 'PRECIOSCO':
          return await this.procesarPrecioCO(evento);
        case 'TIENDAS':
          return await this.procesarTienda(evento);
        default:
          // Entidades sin handler (p.ej. CONFTIENDAS) se marcan como
          // procesadas para que el checkpoint global nunca se bloquee.
          return { ok: true, mensaje: `Entidad ${evento.entidad} sin handler: ignorada` };
      }
    } catch (err) {
      this.logger.error(
        `Error procesando ${evento.entidad}/${evento.localId}: ${(err as Error).message}`,
      );
      return { ok: false, mensaje: (err as Error).message };
    }
  }

  // -------------------- PRODUCTOS --------------------

  private async procesarProducto(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    const d = evento.datos as {
      CODIGO?: string;
      DESCRIP?: string;
      ACTIVO?: string;
      IDLINEA?: number;
      IDSUBLINEA?: number;
      IMPUESTO?: number;
      CODIGOBARRAS?: string;
    };
    const codigo = (d.CODIGO ?? '').trim();
    if (!codigo) return { ok: false, mensaje: 'PRODUCTOS sin CODIGO' };

    const activo = (d.ACTIVO ?? 'S').trim().startsWith('S');

    if (evento.operacion === 'D') {
      // Soft-delete: marcar inactivo en lugar de borrar (preserva historial de pedidos)
      await this.prisma.producto.updateMany({
        where: { codigo },
        data: { activo: false },
      });
      return { ok: true };
    }

    const actualizado = await this.prisma.producto.upsert({
      where: { codigo },
      update: {
        nombre: (d.DESCRIP ?? '').trim(),
        activo,
        // categoria/subcategoria no vienen en Firebird (vienen de LINEA/SUBLINEA en PG,
        // que se mantienen via CatalogHandler.procesarLinea/Sublinea).
      },
      create: {
        codigo,
        nombre: (d.DESCRIP ?? '').trim(),
        activo,
      },
    });

    await this.externalRefs.upsert({
      systemEntity: 'PRODUCTO',
      systemId: actualizado.id,
      localEntity: 'PRODUCTOS',
      localId: evento.localId,
    });

    return { ok: true };
  }

  // -------------------- CORRIDAS --------------------

  private async procesarCorrida(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    const d = evento.datos as { DESCRIP?: string; TALLAS?: string };
    const nombre = (d.DESCRIP ?? '').trim();
    if (!nombre) return { ok: false, mensaje: 'CORRIDAS sin DESCRIP' };

    // Corrida no tiene unique en `nombre` en el schema, así que hacemos
    // findFirst + create (idempotente por ExternalRef).
    let corrida = await this.prisma.corrida.findFirst({ where: { nombre } });
    if (!corrida) {
      corrida = await this.prisma.corrida.create({
        data: { nombre, activa: true },
      });
    }

    // Si viene la lista CSV de tallas, añadimos las que falten (no borrar nunca).
    if (d.TALLAS && typeof d.TALLAS === 'string') {
      const tallas = d.TALLAS.split(',').map((t) => t.trim()).filter(Boolean);
      for (let i = 0; i < tallas.length; i++) {
        const t = tallas[i];
        await this.prisma.talla.upsert({
          where: { corridaId_nombre: { corridaId: corrida.id, nombre: t } },
          update: { orden: i },
          create: { corridaId: corrida.id, nombre: t, orden: i },
        });
      }
    }

    await this.externalRefs.upsert({
      systemEntity: 'CORRIDA',
      systemId: corrida.id,
      localEntity: 'CORRIDAS',
      localId: evento.localId,
    });

    return { ok: true };
  }

  // -------------------- CORRIDASREN (tallas individuales de la corrida) --------------------

  private async procesarCorridaRen(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    const d = evento.datos as { IDCORRIDA?: number; TALLA?: string };
    const localCorridaId = d.IDCORRIDA ?? null;
    const nombre = (d.TALLA ?? '').trim();
    if (!localCorridaId || !nombre) return { ok: true };

    const corridaSystemId = await this.externalRefs.findSystemId(
      'CORRIDAS',
      localCorridaId,
    );
    if (!corridaSystemId) {
      // La corrida padre aún no se ha sincronizado. Se procesará en su
      // próximo evento. Skip silencioso.
      return { ok: true };
    }

    await this.prisma.talla.upsert({
      where: { corridaId_nombre: { corridaId: corridaSystemId, nombre } },
      update: {},
      create: { corridaId: corridaSystemId, nombre, orden: 0 },
    });

    return { ok: true };
  }

  // -------------------- COLORES --------------------

  private async procesarColor(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    const d = evento.datos as { IDCOLOR?: number; DESCRIP?: string; COLOR?: number };
    const codigo = String(d.IDCOLOR ?? evento.localId);
    const nombre = (d.DESCRIP ?? '').trim();
    if (!nombre) return { ok: false, mensaje: 'COLORES sin DESCRIP' };

    const color = await this.prisma.color.upsert({
      where: { codigo },
      update: { nombre, activo: true },
      create: { codigo, nombre, activo: true },
    });

    await this.externalRefs.upsert({
      systemEntity: 'COLOR',
      systemId: color.id,
      localEntity: 'COLORES',
      localId: evento.localId,
    });

    return { ok: true };
  }

  // -------------------- LINEAS --------------------

  private async procesarLinea(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    const d = evento.datos as { DESCRIP?: string };
    const nombre = (d.DESCRIP ?? '').trim();
    if (!nombre) return { ok: false, mensaje: 'LINEAS sin DESCRIP' };

    // LINEAS no tiene modelo dedicado en el schema actual y no se persiste
    // ningún mapeo. Se marca como procesado para no bloquear el checkpoint.
    return { ok: true, mensaje: 'LINEAS: sin modelo PG, ignorado' };
  }

  private async procesarSublinea(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    return { ok: true, mensaje: 'SUBLINEAS: sin modelo PG, ignorado' };
  }

  // -------------------- PRECIOS (producto × tienda, 6 listas) --------------------

  private async procesarPrecio(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    const d = evento.datos as {
      IDPRODUCTO?: number;
      IDTIENDA?: number;
      PRECIO1?: number;
      PRECIO2?: number;
      PRECIO3?: number;
      PRECIO4?: number;
      PRECIO5?: number;
      PRECIO6?: number;
    };
    const localProductoId = d.IDPRODUCTO;
    const localTiendaId = d.IDTIENDA ?? evento.localTiendaId;
    if (!localProductoId || !localTiendaId) {
      return { ok: false, mensaje: 'PRECIOS sin IDPRODUCTO/IDTIENDA' };
    }

    const productoSystemId = await this.externalRefs.findSystemId(
      'PRODUCTOS',
      localProductoId,
    );
    if (!productoSystemId) {
      // Producto aún no sincronizado: skip (se procesará cuando el evento
      // PRODUCTOS llegue).
      return { ok: true, mensaje: 'PRECIOS skipped: producto padre no sincronizado' };
    }

    // Necesitamos el systemId de la tienda (Tienda.id en PG ↔ TIENDAS.IDTIENDA en FB).
    const tienda = await this.prisma.tienda.findFirst({
      where: { externalId: localTiendaId },
      select: { id: true },
    });
    if (!tienda) {
      return { ok: false, mensaje: `Tienda con externalId=${localTiendaId} no encontrada` };
    }

    const lista1 = Number(d.PRECIO1 ?? 0);
    const lista2 = Number(d.PRECIO2 ?? 0);
    const lista3 = Number(d.PRECIO3 ?? 0);
    const lista4 = Number(d.PRECIO4 ?? 0);
    const lista5 = Number(d.PRECIO5 ?? 0);
    const lista6 = Number(d.PRECIO6 ?? 0);

    if (evento.operacion === 'D') {
      // Soft-delete (preserva historial). En la nube se desactiva el precio.
      await this.prisma.precio.updateMany({
        where: { productoId: productoSystemId, tiendaId: tienda.id },
        data: { activo: false },
      });
      return { ok: true };
    }

    const upserted = await this.prisma.precio.upsert({
      where: {
        productoId_tiendaId: {
          productoId: productoSystemId,
          tiendaId: tienda.id,
        },
      },
      update: {
        precioBase: lista1,
        lista1, lista2, lista3, lista4, lista5, lista6,
        activo: true,
      },
      create: {
        productoId: productoSystemId,
        tiendaId: tienda.id,
        precioBase: lista1,
        lista1, lista2, lista3, lista4, lista5, lista6,
        activo: true,
      },
    });

    await this.externalRefs.upsert({
      systemEntity: 'PRECIO',
      systemId: upserted.id,
      localEntity: 'PRECIOS',
      localId: evento.localId,
      localTiendaId,
    });

    return { ok: true };
  }

  // -------------------- PRECIOSCO (variante × 6 listas) --------------------

  private async procesarPrecioCO(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    const d = evento.datos as {
      IDPRODUCTO?: number;
      IDTIENDA?: number;
      IDCORRIDA?: number;
      IDCOLOR?: number;
      TALLA?: string;
      PRECIO1?: number;
      PRECIO2?: number;
      PRECIO3?: number;
      PRECIO4?: number;
      PRECIO5?: number;
      PRECIO6?: number;
      CODIGOBARRAS?: string;
      SKU?: string;
    };
    const localProductoId = d.IDPRODUCTO;
    const localTiendaId = d.IDTIENDA ?? evento.localTiendaId;
    if (!localProductoId || !localTiendaId) {
      return { ok: false, mensaje: 'PRECIOSCO sin IDPRODUCTO/IDTIENDA' };
    }

    const productoSystemId = await this.externalRefs.findSystemId(
      'PRODUCTOS',
      localProductoId,
    );
    const tienda = await this.prisma.tienda.findFirst({
      where: { externalId: localTiendaId },
      select: { id: true },
    });
    const corridaSystemId = d.IDCORRIDA
      ? await this.externalRefs.findSystemId('CORRIDAS', d.IDCORRIDA)
      : null;
    const colorSystemId = d.IDCOLOR
      ? await this.externalRefs.findSystemId('COLORES', d.IDCOLOR)
      : null;

    if (!productoSystemId || !tienda || !corridaSystemId || !colorSystemId) {
      return {
        ok: true,
        mensaje:
          'PRECIOSCO skipped: dependencias no sincronizadas aún (producto/tienda/corrida/color)',
      };
    }

    // Resolver Talla por nombre dentro de la corrida.
    const tallaNombre = (d.TALLA ?? '').trim();
    if (!tallaNombre) {
      return { ok: false, mensaje: 'PRECIOSCO sin TALLA' };
    }
    const talla = await this.prisma.talla.upsert({
      where: { corridaId_nombre: { corridaId: corridaSystemId, nombre: tallaNombre } },
      update: {},
      create: { corridaId: corridaSystemId, nombre: tallaNombre, orden: 0 },
    });

    const lista1 = Number(d.PRECIO1 ?? 0);
    const lista2 = Number(d.PRECIO2 ?? 0);
    const lista3 = Number(d.PRECIO3 ?? 0);
    const lista4 = Number(d.PRECIO4 ?? 0);
    const lista5 = Number(d.PRECIO5 ?? 0);
    const lista6 = Number(d.PRECIO6 ?? 0);
    const sku = (d.SKU ?? '').trim() || null;

    const upserted = await this.prisma.precioCO.upsert({
      where: {
        productoId_tiendaId_corridaId_tallaId_colorId: {
          productoId: productoSystemId,
          tiendaId: tienda.id,
          corridaId: corridaSystemId,
          tallaId: talla.id,
          colorId: colorSystemId,
        },
      },
      update: {
        precio: lista1,
        lista1, lista2, lista3, lista4, lista5, lista6,
        sku,
      },
      create: {
        productoId: productoSystemId,
        tiendaId: tienda.id,
        corridaId: corridaSystemId,
        tallaId: talla.id,
        colorId: colorSystemId,
        precio: lista1,
        lista1, lista2, lista3, lista4, lista5, lista6,
        sku,
      },
    });

    await this.externalRefs.upsert({
      systemEntity: 'PRECIOCO',
      systemId: upserted.id,
      localEntity: 'PRECIOSCO',
      localId: evento.localId,
      localTiendaId,
    });

    return { ok: true };
  }

  // -------------------- TIENDAS --------------------

  private async procesarTienda(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    const d = evento.datos as {
      NOMBRE?: string;
      DIRECCION?: string;
      CIUDAD?: string;
      TELEFONO?: string;
      EMAIL?: string;
      ACTIVO?: string;
    };
    const externalId = evento.localId;
    if (!externalId) return { ok: false, mensaje: 'TIENDAS sin IDTIENDA' };

    const nombre = (d.NOMBRE ?? '').trim();
    const activa = (d.ACTIVO ?? 'S').trim().toUpperCase().startsWith('S');

    if (evento.operacion === 'D') {
      // Soft-delete (preserva pedidos históricos).
      await this.prisma.tienda.updateMany({
        where: { externalId },
        data: { activa: false },
      });
      return { ok: true };
    }

    const tienda = await this.prisma.tienda.upsert({
      where: { externalId },
      update: {
        ...(nombre ? { nombre } : {}),
        ...(d.DIRECCION ? { direccion: d.DIRECCION.trim() } : {}),
        ...(d.CIUDAD ? { ciudad: d.CIUDAD.trim() } : {}),
        ...(d.TELEFONO ? { telefono: d.TELEFONO.trim() } : {}),
        ...(d.EMAIL ? { email: d.EMAIL.trim() } : {}),
        activa,
      },
      create: {
        externalId,
        nombre: nombre || `Tienda ${externalId}`,
        direccion: (d.DIRECCION ?? '').trim() || 'Sin dirección',
        ciudad: (d.CIUDAD ?? '').trim() || 'Sin ciudad',
        estado: '',
        telefono: (d.TELEFONO ?? '').trim() || null,
        email: (d.EMAIL ?? '').trim() || null,
        activa,
      },
    });

    await this.externalRefs.upsert({
      systemEntity: 'TIENDA',
      systemId: tienda.id,
      localEntity: 'TIENDAS',
      localId: evento.localId,
    });

    return { ok: true };
  }
}
