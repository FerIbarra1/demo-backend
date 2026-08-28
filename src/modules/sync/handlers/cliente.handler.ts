import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ExternalRefService } from '../external-ref.service';
import type { SyncEventoDto } from '../dto/upload-batch.dto';

/**
 * ClienteHandler: procesa eventos de CLIENTES / CLIENTESCXC / CLITIEN
 * / CLITIENCXC / VENDEDORES.
 *
 * Reglas:
 *   - Si el email del cliente Firebird ya existe como Usuario.email en
 *     la nube → REUSA el Usuario existente (preserva pedidos y favoritos).
 *     Solo crea el ExternalRef y actualiza datos auxiliares.
 *   - Si el email no existe → crea un Usuario (rol CLIENTE, password
 *     random unusable). El cliente luego puede "registrarse" desde la
 *     web; el DTO de register detecta el email existente y le pide
 *     login.
 *   - Actualiza `listaPrecioCodigo` con `CLIENTES.LISPRE` ('1'..'6').
 *   - El campo `telefono` se trunca a 20 chars (límite del schema nube).
 */
@Injectable()
export class ClienteHandler {
  private readonly logger = new Logger(ClienteHandler.name);

  constructor(
    private prisma: PrismaService,
    private externalRefs: ExternalRefService,
  ) {}

  async procesar(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    try {
      switch (evento.entidad) {
        case 'CLIENTES':
        case 'CLIENTESCXC':
          return await this.procesarCliente(evento);
        case 'CLITIEN':
        case 'CLITIENCXC':
          return await this.procesarClienteTienda(evento);
        case 'VENDEDORES':
          return await this.procesarVendedor(evento);
        default:
          return { ok: false, mensaje: `Entidad ${evento.entidad} sin handler de cliente` };
      }
    } catch (err) {
      this.logger.error(
        `Error procesando ${evento.entidad}/${evento.localId}: ${(err as Error).message}`,
      );
      return { ok: false, mensaje: (err as Error).message };
    }
  }

  // -------------------- CLIENTES / CLIENTESCXC --------------------

  private async procesarCliente(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    const d = evento.datos as {
      NOMBRE?: string;
      EMAIL?: string;
      TELEFONO?: string;
      LISPRE?: string;
      SUSPENDIDO?: string | boolean;
    };

    const email = (d.EMAIL ?? '').trim().toLowerCase();
    const nombre = (d.NOMBRE ?? '').trim() || 'Sin nombre';
    const telefono = (d.TELEFONO ?? '').trim().slice(0, 20) || null;
    const listaPrecioCodigo = (d.LISPRE ?? '').trim() || null;
    const localTiendaId = evento.localTiendaId;

    if (!email) {
      // Sin email no podemos hacer match. Se loguea y se omite.
      return { ok: true, mensaje: 'Cliente sin EMAIL: omitido' };
    }

    // Buscar por email en la nube (case-insensitive).
    const existente = await this.prisma.usuario.findFirst({
      where: { email },
    });

    let usuarioId: number;
    if (existente) {
      // Reusar. NO actualizar email (es UNIQUE).
      await this.prisma.usuario.update({
        where: { id: existente.id },
        data: {
          // Solo actualizamos datos auxiliares. No tocamos password ni rol.
          nombre: existente.nombre || nombre,
          telefono: telefono ?? existente.telefono,
          listaPrecioCodigo: localTiendaId
            ? undefined
            : listaPrecioCodigo ?? existente.listaPrecioCodigo,
        },
      });
      usuarioId = existente.id;
    } else {
      // Crear nuevo Usuario con password random unusable.
      const passwordHash = await bcryptRandom();
      const nuevo = await this.prisma.usuario.create({
        data: {
          email,
          password: passwordHash,
          nombre,
          telefono,
          rol: 'CLIENTE',
          activo: true,
          listaPrecioCodigo,
        },
      });
      usuarioId = nuevo.id;
    }

    if (localTiendaId) {
      const tienda = await this.prisma.tienda.findFirst({
        where: { externalId: localTiendaId },
        select: { id: true },
      });
      if (!tienda) {
        return { ok: false, mensaje: `Tienda Firebird ${localTiendaId} no sincronizada` };
      }
      await this.prisma.usuarioTienda.upsert({
        where: {
          usuarioId_tiendaId: { usuarioId, tiendaId: tienda.id },
        },
        update: {
          localClienteId: evento.localId,
          listaPrecioCodigo,
          activo: true,
        },
        create: {
          usuarioId,
          tiendaId: tienda.id,
          localClienteId: evento.localId,
          listaPrecioCodigo,
        },
      });
    }

    // Mantener ExternalRef(USUARIO, systemId, CLIENTES/CLIENTESCXC, localTiendaId).
    await this.externalRefs.upsert({
      systemEntity: 'USUARIO',
      systemId: usuarioId,
      localEntity: evento.entidad,
      localId: evento.localId,
      localTiendaId: localTiendaId ?? null,
    });

    return { ok: true };
  }

  private async procesarClienteTienda(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    const d = evento.datos as {
      IDCLIENTE?: number;
      IDTIENDA?: number;
      ACTIVO?: string | boolean;
      LISPRE?: string;
    };
    const localClienteId = d.IDCLIENTE;
    const localTiendaId = d.IDTIENDA ?? evento.localTiendaId;
    if (!localClienteId || !localTiendaId) {
      return { ok: false, mensaje: 'CLITIEN sin IDCLIENTE/IDTIENDA' };
    }

    const usuarioRef = await this.prisma.externalRef.findFirst({
      where: {
        localEntity: 'CLIENTES',
        localId: localClienteId,
        localTiendaId,
      },
      select: { systemId: true },
    });
    if (!usuarioRef) {
      return { ok: false, mensaje: `Cliente ${localClienteId} aún no sincronizado` };
    }

    const tienda = await this.prisma.tienda.findFirst({
      where: { externalId: localTiendaId },
      select: { id: true },
    });
    if (!tienda) {
      return { ok: false, mensaje: `Tienda Firebird ${localTiendaId} no sincronizada` };
    }

    await this.prisma.usuarioTienda.upsert({
      where: {
        usuarioId_tiendaId: { usuarioId: usuarioRef.systemId, tiendaId: tienda.id },
      },
      update: {
        localClienteId,
        listaPrecioCodigo: (d.LISPRE ?? '').trim() || undefined,
        activo: this.isActive(d.ACTIVO),
      },
      create: {
        usuarioId: usuarioRef.systemId,
        tiendaId: tienda.id,
        localClienteId,
        listaPrecioCodigo: (d.LISPRE ?? '').trim() || null,
        activo: this.isActive(d.ACTIVO),
      },
    });

    return { ok: true };
  }

  private isActive(value: string | boolean | undefined): boolean {
    if (typeof value === 'boolean') return value;
    return !value || value.trim().toUpperCase().startsWith('S');
  }

  // -------------------- VENDEDORES --------------------

  private async procesarVendedor(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    // VENDEDORES no tiene modelo dedicado en la nube. Se persiste sólo
    // como ExternalRef por si en el futuro se necesita mapear pedidos
    // con un vendedor específico.
    return { ok: true, mensaje: 'VENDEDORES: ExternalRef no implementado en esta fase' };
  }
}

/**
 * Genera un hash bcrypt con un secret random. La contraseña nunca va a
 * coincidir con ningún input real, por lo que el cliente debe usar el
 * flujo de "forgot password" para establecer una real.
 */
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
async function bcryptRandom(): Promise<string> {
  const random = randomBytes(32).toString('hex');
  return bcrypt.hash(random, 10);
}
