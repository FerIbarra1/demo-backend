import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RolUsuario, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Shape mínimo del usuario que viaja en `request.user` (lo construye JwtAuthGuard + JwtStrategy).
 * Cualquier método de service que reciba `user` puede pasar a `verificarAccesoPedido`.
 */
export interface PedidoAccessUser {
  userId: number;
  rol: RolUsuario;
  tiendaId?: number;
  tiendaIdHeader?: number;
}

export interface PedidoAccessOptions {
  /**
   * Roles que pueden ver el pedido aunque sea de OTRA tienda (útil para ADMIN).
   * ADMIN siempre pasa. Por defecto solo ADMIN.
   */
  crossTiendaRoles?: RolUsuario[];
  /**
   * Si true, el bodeguero sólo puede acceder si el pedido está asignado a él.
   * Aplica solo cuando el rol es BODEGA.
   */
  requiereAsignacionBodega?: boolean;
}

export type PedidoParaVerificar = Prisma.PedidoGetPayload<{
  select: {
    id: true;
    usuarioId: true;
    tiendaId: true;
    asignadoAId: true;
    estado: true;
  };
}>;

/**
 * Servicio utilitario compartido por todos los services que operan sobre
 * un pedido. Centraliza la lógica de "este usuario tiene derecho a ver/operar
 * este pedido" para que ningún controller pueda saltarse la verificación.
 *
 * Reglas:
 * - ADMIN: pasa siempre.
 * - CLIENTE: sólo puede ver/operar pedidos donde `pedido.usuarioId === user.userId`.
 * - BODEGA / CAJERO / BODEGA_MONITOR: sólo pueden ver/operar pedidos de su tienda.
 *   Si `requiereAsignacionBodega`, BODEGA también debe tener `pedido.asignadoAId === user.userId`.
 */
@Injectable()
export class PedidoAccessService {
  constructor(private prisma: PrismaService) {}

  async cargar(pedidoId: number): Promise<PedidoParaVerificar> {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        id: true,
        usuarioId: true,
        tiendaId: true,
        asignadoAId: true,
        estado: true,
      },
    });
    if (!pedido) {
      throw new NotFoundException(`Pedido ${pedidoId} no encontrado`);
    }
    return pedido;
  }

  /**
   * Carga el pedido y valida acceso en una sola llamada.
   * Lanza 404 si no existe, 403 si el usuario no tiene derecho.
   */
  async cargarYValidar(
    pedidoId: number,
    user: PedidoAccessUser,
    opciones: PedidoAccessOptions = {},
  ): Promise<PedidoParaVerificar> {
    const pedido = await this.cargar(pedidoId);
    this.validar(pedido, user, opciones);
    return pedido;
  }

  validar(
    pedido: PedidoParaVerificar,
    user: PedidoAccessUser,
    opciones: PedidoAccessOptions = {},
  ): void {
    const crossTiendaRoles = opciones.crossTiendaRoles ?? [RolUsuario.ADMIN];

    // ADMIN y roles cross-tienda pasan sin verificar tienda.
    if (crossTiendaRoles.includes(user.rol)) {
      return;
    }

    // CLIENTE: debe ser el dueño del pedido. La tienda se valida implícitamente
    // porque cada cliente tiene un pedido en su tienda.
    if (user.rol === RolUsuario.CLIENTE) {
      if (pedido.usuarioId !== user.userId) {
        throw new ForbiddenException(
          'No tienes permiso para acceder a este pedido',
        );
      }
      return;
    }

    // BODEGA / CAJERO / BODEGA_MONITOR: el pedido debe pertenecer a su tienda.
    const tiendaEfectiva = user.tiendaIdHeader ?? user.tiendaId;
    if (!tiendaEfectiva) {
      throw new ForbiddenException(
        'Tu usuario no tiene tienda asignada. Contacta al administrador.',
      );
    }
    if (pedido.tiendaId !== tiendaEfectiva) {
      throw new ForbiddenException(
        'Este pedido pertenece a otra tienda',
      );
    }

    // BODEGA: si se requiere asignación, el pedido debe estar asignado a él.
    if (
      opciones.requiereAsignacionBodega &&
      user.rol === RolUsuario.BODEGA
    ) {
      if (pedido.asignadoAId === null) {
        throw new ForbiddenException(
          'Este pedido no está asignado. Tómalo antes de operarlo.',
        );
      }
      if (pedido.asignadoAId !== user.userId) {
        throw new ForbiddenException(
          'Este pedido está asignado a otro bodeguero',
        );
      }
    }
  }
}