import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RolUsuario } from '@prisma/client';

/**
 * Lógica del módulo de ventanillas.
 *
 * Reglas:
 *  - Cada tienda tiene N ventanillas físicas (numeradas 1, 2, 3...).
 *  - Una ventanilla está LIBRE cuando cajeroId = null, OCUPADA cuando no.
 *  - La asignación cajero → ventanilla es 1:1 (cajeroId único en ventanillas).
 *  - El admin puede crear/borrar/renumerar, pero NO borrar una que está
 *    ocupada (debe liberar primero o reasignar).
 *  - El cajero elige su ventanilla al iniciar sesión. El backend libera la
 *    anterior automáticamente si elige una nueva.
 *
 * Realtime: emite `ventanilla.asignada` y `ventanilla.liberada` a
 * `tienda-{tiendaId}` para que la TV refleje cambios en <200ms.
 */
@Injectable()
export class VentanillasService {
  private readonly logger = new Logger(VentanillasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async listarPorTienda(tiendaId: number) {
    return this.prisma.ventanilla.findMany({
      where: { tiendaId },
      include: {
        cajero: { select: { id: true, nombre: true, apellido: true } },
      },
      orderBy: { numero: 'asc' },
    });
  }

  /**
   * Crea `cantidad` ventanillas nuevas con numeración correlativa a partir del
   * siguiente número disponible de la tienda. Devuelve las ventanillas creadas.
   */
  async crearN(tiendaId: number, cantidad: number) {
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 20) {
      throw new BadRequestException('Cantidad debe ser un entero entre 1 y 20');
    }
    const tienda = await this.prisma.tienda.findUnique({ where: { id: tiendaId } });
    if (!tienda) throw new NotFoundException(`Tienda ${tiendaId} no existe`);

    const ultima = await this.prisma.ventanilla.findFirst({
      where: { tiendaId },
      orderBy: { numero: 'desc' },
    });
    const base = ultima?.numero ?? 0;
    const numeros = Array.from({ length: cantidad }, (_, i) => base + i + 1);

    // Verificar que ninguno choque con existentes (por si la BD tiene gaps).
    const choques = await this.prisma.ventanilla.findMany({
      where: { tiendaId, numero: { in: numeros } },
      select: { numero: true },
    });
    if (choques.length > 0) {
      throw new ConflictException(
        `Ya existen ventanillas con número ${choques.map((c) => c.numero).join(', ')}`,
      );
    }

    const creadas = await this.prisma.$transaction(
      numeros.map((numero) =>
        this.prisma.ventanilla.create({
          data: { tiendaId, numero, cajeroId: null, activa: true },
        }),
      ),
    );
    this.logger.log(`Tienda ${tiendaId}: creadas ${creadas.length} ventanillas`);
    return creadas;
  }

  /**
   * Cambia el número de una ventanilla. Valida que el nuevo número no choque
   * con otro de la misma tienda.
   */
  async renumerar(tiendaId: number, id: number, nuevoNumero: number) {
    const v = await this.prisma.ventanilla.findUnique({ where: { id } });
    if (!v || v.tiendaId !== tiendaId) {
      throw new NotFoundException(`Ventanilla ${id} no existe en tienda ${tiendaId}`);
    }
    if (!Number.isInteger(nuevoNumero) || nuevoNumero < 1) {
      throw new BadRequestException('Número inválido');
    }
    const choque = await this.prisma.ventanilla.findFirst({
      where: { tiendaId, numero: nuevoNumero, NOT: { id } },
    });
    if (choque) {
      throw new ConflictException(`Ya existe la ventanilla ${nuevoNumero} en esta tienda`);
    }
    const actualizada = await this.prisma.ventanilla.update({
      where: { id },
      data: { numero: nuevoNumero },
    });
    this.logger.log(`Ventanilla ${id}: renumerada ${v.numero} → ${nuevoNumero}`);
    return actualizada;
  }

  /**
   * Borra una ventanilla. Sólo si está libre. Si está ocupada por un cajero,
   * tira error para que el admin primero lo desasigne.
   */
  async borrar(tiendaId: number, id: number) {
    const v = await this.prisma.ventanilla.findUnique({ where: { id } });
    if (!v || v.tiendaId !== tiendaId) {
      throw new NotFoundException(`Ventanilla ${id} no existe en tienda ${tiendaId}`);
    }
    if (v.cajeroId !== null) {
      throw new ConflictException(
        `La ventanilla ${v.numero} está ocupada por un cajero. Libérala antes de borrarla.`,
      );
    }
    await this.prisma.ventanilla.delete({ where: { id } });
    this.logger.log(`Ventanilla ${id} borrada`);
    return { ok: true };
  }

  /**
   * Cajero elige una ventanilla. Libera la que tuviera antes (si era de su
   * tienda) y le asigna la nueva. Si elige la misma que ya tenía, no hace nada.
   * Emite `ventanilla.asignada` al room `tienda-{id}`.
   */
  async elegir(usuarioId: number, tiendaId: number, ventanillaId: number) {
    const usuario = await this.prisma.usuario.findUnique({ where: { id: usuarioId } });
    if (!usuario || usuario.tiendaId !== tiendaId) {
      throw new NotFoundException(`Usuario ${usuarioId} no pertenece a tienda ${tiendaId}`);
    }
    if (usuario.rol !== RolUsuario.CAJERO && usuario.rol !== RolUsuario.ADMIN) {
      throw new BadRequestException('Solo cajeros pueden elegir ventanilla');
    }

    const v = await this.prisma.ventanilla.findUnique({ where: { id: ventanillaId } });
    if (!v || v.tiendaId !== tiendaId) {
      throw new NotFoundException(`Ventanilla ${ventanillaId} no existe en tienda ${tiendaId}`);
    }
    if (!v.activa) {
      throw new BadRequestException(`La ventanilla ${v.numero} está inactiva`);
    }
    if (v.cajeroId !== null && v.cajeroId !== usuarioId) {
      throw new ConflictException(
        `La ventanilla ${v.numero} está ocupada por otro cajero`,
      );
    }

    // Liberar ventanilla anterior del usuario (si era de esta tienda).
    const anterior = await this.prisma.ventanilla.findFirst({
      where: { tiendaId, cajeroId: usuarioId, NOT: { id: ventanillaId } },
    });
    if (anterior) {
      await this.prisma.ventanilla.update({
        where: { id: anterior.id },
        data: { cajeroId: null },
      });
      this.realtime.emitToTienda(tiendaId, 'ventanilla.liberada', {
        ventanillaId: anterior.id,
        numero: anterior.numero,
      });
    }

    // Si ya era la misma, no-op (idempotente).
    if (v.cajeroId === usuarioId) {
      return v;
    }

    const actualizada = await this.prisma.ventanilla.update({
      where: { id: ventanillaId },
      data: { cajeroId: usuarioId },
      include: {
        cajero: { select: { id: true, nombre: true, apellido: true } },
      },
    });

    this.realtime.emitToTienda(tiendaId, 'ventanilla.asignada', {
      ventanillaId: actualizada.id,
      numero: actualizada.numero,
      cajeroId: usuario.id,
      cajeroNombre: `${usuario.nombre}${usuario.apellido ? ' ' + usuario.apellido : ''}`,
    });

    this.logger.log(
      `Cajero ${usuarioId} eligió ventanilla ${actualizada.numero} (${actualizada.id}) en tienda ${tiendaId}`,
    );
    return actualizada;
  }

  /**
   * Libera la ventanilla del cajero (logout / cambio de turno).
   * Si no se pasa ventanillaId, libera la que tenga.
   */
  async liberar(usuarioId: number, tiendaId: number, ventanillaId?: number) {
    const where = ventanillaId
      ? { id: ventanillaId, tiendaId, cajeroId: usuarioId }
      : { tiendaId, cajeroId: usuarioId };
    const v = await this.prisma.ventanilla.findFirst({ where });
    if (!v) {
      // No-op: no tenía ventanilla asignada.
      return { ok: true };
    }
    await this.prisma.ventanilla.update({
      where: { id: v.id },
      data: { cajeroId: null },
    });
    this.realtime.emitToTienda(tiendaId, 'ventanilla.liberada', {
      ventanillaId: v.id,
      numero: v.numero,
    });
    this.logger.log(`Ventanilla ${v.numero} liberada por usuario ${usuarioId}`);
    return { ok: true };
  }

  /** Helper: ventanilla del cajero en una tienda. Null si no tiene. */
  async ventanillaDelCajero(usuarioId: number, tiendaId: number) {
    return this.prisma.ventanilla.findFirst({
      where: { tiendaId, cajeroId: usuarioId },
    });
  }
}
