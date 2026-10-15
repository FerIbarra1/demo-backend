import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RolUsuario } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * F22 (oct 2026): los mostradores físicos de la tienda — el equivalente de
 * `VentanillasService` para el operador de mostrador.
 *
 * Reglas (las mismas que las ventanillas del cajero, a propósito: el negocio ya
 * entiende ese modelo y el admin lo configura igual):
 *  - Cada tienda tiene N mostradores numerados (1, 2, 3...). El admin los crea,
 *    renumera y borra desde el panel de tiendas.
 *  - Un mostrador está LIBRE cuando `operadorId = null`, OCUPADO cuando no.
 *  - La asignación operador → mostrador es 1:1. El operador elige el suyo al
 *    entrar; el backend libera el anterior si elige otro.
 *  - No se borra un mostrador ocupado.
 *
 * Cuando el operador llama a un cliente, la TV dice "Pasa al mostrador N". Por
 * eso `llamar` exige tener mostrador elegido — salvo que la tienda no tenga
 * ninguno configurado (una tienda con una sola mesa no necesita decirle al
 * cliente a cuál ir; ver `resolverParaLlamar`).
 *
 * Realtime: `mostrador.asignado` y `mostrador.liberado` a `tienda-{id}`.
 */
@Injectable()
export class MostradoresService {
  private readonly logger = new Logger(MostradoresService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async listarPorTienda(tiendaId: number) {
    return this.prisma.mostrador.findMany({
      where: { tiendaId },
      include: { operador: { select: { id: true, nombre: true, apellido: true } } },
      orderBy: { numero: 'asc' },
    });
  }

  /**
   * Crea `cantidad` mostradores con numeración correlativa a partir del
   * siguiente número disponible de la tienda.
   */
  async crearN(tiendaId: number, cantidad: number) {
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 20) {
      throw new BadRequestException('Cantidad debe ser un entero entre 1 y 20');
    }
    const tienda = await this.prisma.tienda.findUnique({ where: { id: tiendaId } });
    if (!tienda) throw new NotFoundException(`Tienda ${tiendaId} no existe`);

    const ultimo = await this.prisma.mostrador.findFirst({
      where: { tiendaId },
      orderBy: { numero: 'desc' },
    });
    const base = ultimo?.numero ?? 0;
    const numeros = Array.from({ length: cantidad }, (_, i) => base + i + 1);

    const choques = await this.prisma.mostrador.findMany({
      where: { tiendaId, numero: { in: numeros } },
      select: { numero: true },
    });
    if (choques.length > 0) {
      throw new ConflictException(
        `Ya existen mostradores con número ${choques.map((c) => c.numero).join(', ')}`,
      );
    }

    const creados = await this.prisma.$transaction(
      numeros.map((numero) =>
        this.prisma.mostrador.create({
          data: { tiendaId, numero, operadorId: null, activa: true },
        }),
      ),
    );
    this.logger.log(`Tienda ${tiendaId}: creados ${creados.length} mostradores`);
    return creados;
  }

  async renumerar(tiendaId: number, id: number, nuevoNumero: number) {
    const m = await this.prisma.mostrador.findUnique({ where: { id } });
    if (!m || m.tiendaId !== tiendaId) {
      throw new NotFoundException(`Mostrador ${id} no existe en tienda ${tiendaId}`);
    }
    if (!Number.isInteger(nuevoNumero) || nuevoNumero < 1) {
      throw new BadRequestException('Número inválido');
    }
    const choque = await this.prisma.mostrador.findFirst({
      where: { tiendaId, numero: nuevoNumero, NOT: { id } },
    });
    if (choque) {
      throw new ConflictException(`Ya existe el mostrador ${nuevoNumero} en esta tienda`);
    }
    const actualizado = await this.prisma.mostrador.update({
      where: { id },
      data: { numero: nuevoNumero },
    });
    this.logger.log(`Mostrador ${id}: renumerado ${m.numero} → ${nuevoNumero}`);
    return actualizado;
  }

  /** Borra un mostrador libre. Si hay un operador ahí, tira error. */
  async borrar(tiendaId: number, id: number) {
    const m = await this.prisma.mostrador.findUnique({ where: { id } });
    if (!m || m.tiendaId !== tiendaId) {
      throw new NotFoundException(`Mostrador ${id} no existe en tienda ${tiendaId}`);
    }
    if (m.operadorId !== null) {
      throw new ConflictException(
        `El mostrador ${m.numero} está ocupado por un operador. Libéralo antes de borrarlo.`,
      );
    }
    await this.prisma.mostrador.delete({ where: { id } });
    this.logger.log(`Mostrador ${id} borrado`);
    return { ok: true };
  }

  /**
   * El operador elige un mostrador. Libera el que tuviera antes y le asigna el
   * nuevo en una sola transacción; la asignación usa `updateMany` con guarda
   * atómica (libre o ya suyo) para cerrar la carrera entre dos operadores que
   * eligen el mismo a la vez. Idempotente si ya era el suyo.
   */
  async elegir(usuarioId: number, tiendaId: number, mostradorId: number) {
    const usuario = await this.prisma.usuario.findUnique({ where: { id: usuarioId } });
    if (!usuario || usuario.tiendaId !== tiendaId) {
      throw new NotFoundException(`Usuario ${usuarioId} no pertenece a tienda ${tiendaId}`);
    }
    if (usuario.rol !== RolUsuario.MOSTRADOR && usuario.rol !== RolUsuario.ADMIN) {
      throw new BadRequestException('Solo operadores de mostrador pueden elegir mostrador');
    }

    const m = await this.prisma.mostrador.findUnique({ where: { id: mostradorId } });
    if (!m || m.tiendaId !== tiendaId) {
      throw new NotFoundException(`Mostrador ${mostradorId} no existe en tienda ${tiendaId}`);
    }
    if (!m.activa) {
      throw new BadRequestException(`El mostrador ${m.numero} está inactivo`);
    }

    const actualizado = await this.prisma.$transaction(async (tx) => {
      const anterior = await tx.mostrador.findFirst({
        where: { tiendaId, operadorId: usuarioId, NOT: { id: mostradorId } },
      });
      if (anterior) {
        await tx.mostrador.update({ where: { id: anterior.id }, data: { operadorId: null } });
      }

      if (m.operadorId === usuarioId) return m;

      const asignado = await tx.mostrador.updateMany({
        where: { id: mostradorId, OR: [{ operadorId: null }, { operadorId: usuarioId }] },
        data: { operadorId: usuarioId },
      });
      if (asignado.count !== 1) {
        throw new ConflictException(`El mostrador ${m.numero} está ocupado por otro operador`);
      }

      return tx.mostrador.findUnique({
        where: { id: mostradorId },
        include: { operador: { select: { id: true, nombre: true, apellido: true } } },
      });
    });

    if (!actualizado) {
      throw new NotFoundException(`Mostrador ${mostradorId} no existe en tienda ${tiendaId}`);
    }

    if (m.operadorId !== usuarioId) {
      this.realtime.emitToTienda(tiendaId, 'mostrador.asignado', {
        mostradorId: actualizado.id,
        numero: actualizado.numero,
        operadorId: usuario.id,
        operadorNombre: `${usuario.nombre}${usuario.apellido ? ' ' + usuario.apellido : ''}`,
      });
    }

    this.logger.log(
      `Operador ${usuarioId} eligió mostrador ${actualizado.numero} (${actualizado.id}) en tienda ${tiendaId}`,
    );
    return actualizado;
  }

  /** Libera el mostrador del operador (cierre de sesión / cambio de turno). */
  async liberar(usuarioId: number, tiendaId: number, mostradorId?: number) {
    const where = mostradorId
      ? { id: mostradorId, tiendaId, operadorId: usuarioId }
      : { tiendaId, operadorId: usuarioId };
    const m = await this.prisma.mostrador.findFirst({ where });
    if (!m) return { ok: true };
    await this.prisma.mostrador.update({ where: { id: m.id }, data: { operadorId: null } });
    this.realtime.emitToTienda(tiendaId, 'mostrador.liberado', {
      mostradorId: m.id,
      numero: m.numero,
    });
    this.logger.log(`Mostrador ${m.numero} liberado por usuario ${usuarioId}`);
    return { ok: true };
  }

  /** El mostrador donde trabaja el operador (null si no eligió). */
  async delOperador(usuarioId: number, tiendaId: number) {
    return this.prisma.mostrador.findFirst({ where: { tiendaId, operadorId: usuarioId } });
  }

  /**
   * El mostrador desde el que el operador llama a un cliente.
   *
   *  - La tienda tiene mostradores y el operador eligió uno → ese.
   *  - La tienda tiene mostradores y el operador NO eligió → 400. La TV diría
   *    "Pasa al mostrador" sin decir cuál, y con dos operadores el cliente no
   *    sabría a quién acercarse.
   *  - La tienda no tiene ninguno configurado → `null` y se llama sin número.
   *    Es la tienda de un solo mostrador, y exigirle al admin configurar uno solo
   *    para poder usar "Llamar" rompería lo que ya funcionaba.
   */
  async resolverParaLlamar(usuarioId: number, tiendaId: number) {
    const mio = await this.delOperador(usuarioId, tiendaId);
    if (mio) return mio;
    const configurados = await this.prisma.mostrador.count({ where: { tiendaId, activa: true } });
    if (configurados > 0) {
      throw new BadRequestException(
        'Elige tu mostrador antes de llamar a un cliente: la pantalla le dirá a cuál pasar.',
      );
    }
    return null;
  }
}
