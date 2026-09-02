import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { RolUsuario } from '@prisma/client';
import {
  CrearUsuarioDto,
  ActualizarUsuarioDto,
  AdminResetPasswordDto,
  ListarUsuariosQueryDto,
  ROLES_EMPLEADO,
} from './dto/usuarios.dto';

/**
 * Gestión de usuarios desde el panel ADMIN.
 *
 * Reglas de negocio:
 *  - Los clientes NO se crean, editan ni eliminan desde aquí (se registran en
 *    la web o vienen de Firebird). Solo se pueden desactivar/activar.
 *  - Los empleados (roles internos) sí se crean/editan. Siempre ligados a una
 *    tienda. Se pueden desactivar, activar y eliminar (soft delete).
 *  - Soft delete: marca `deletedAt` (conserva pedidos/historial). `activo=false`
 *    = desactivado (reactivable). Los clientes nunca se eliminan.
 */
@Injectable()
export class UsuariosService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(query: ListarUsuariosQueryDto) {
    const {
      rol,
      tiendaId,
      busqueda,
      soloEmpleados,
      pagina = 1,
      limite = 20,
    } = query;

    const where: any = { deletedAt: null };
    if (rol) where.rol = rol;
    if (tiendaId) where.tiendaId = tiendaId;
    // `soloEmpleados` llega como string ('true'/'false'); parsear manualmente
    // porque enableImplicitConversion convierte 'false' a true (Boolean('false')).
    const soloEmpleadosBool =
      soloEmpleados === 'true' ? true : soloEmpleados === 'false' ? false : undefined;
    if (soloEmpleadosBool !== undefined) {
      where.rol = soloEmpleadosBool ? { not: RolUsuario.CLIENTE } : RolUsuario.CLIENTE;
    }
    if (busqueda) {
      where.OR = [
        { nombre: { contains: busqueda, mode: 'insensitive' } },
        { apellido: { contains: busqueda, mode: 'insensitive' } },
        { email: { contains: busqueda, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.usuario.findMany({
        where,
        include: {
          tienda: { select: { id: true, nombre: true, ciudad: true } },
          tiendasCliente: {
            select: {
              tienda: { select: { id: true, nombre: true } },
              localClienteId: true,
              listaPrecioCodigo: true,
              activo: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
      }),
      this.prisma.usuario.count({ where }),
    ]);

    return {
      data: data.map((u) => this.formatear(u)),
      meta: { total, pagina, limite, totalPaginas: Math.ceil(total / limite) },
    };
  }

  async obtener(id: number) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id },
      include: {
        tienda: { select: { id: true, nombre: true, ciudad: true } },
        tiendasCliente: {
          select: {
            tienda: { select: { id: true, nombre: true } },
            localClienteId: true,
            listaPrecioCodigo: true,
            activo: true,
          },
        },
      },
    });
    if (!usuario || usuario.deletedAt !== null) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return this.formatear(usuario);
  }

  /** Crea un empleado (rol interno). Rechaza CLIENTE. */
  async crear(dto: CrearUsuarioDto) {
    if (dto.rol === RolUsuario.CLIENTE) {
      throw new BadRequestException(
        'Los clientes no se crean desde el panel. Se registran en la web o vienen de Firebird.',
      );
    }
    const existente = await this.prisma.usuario.findUnique({
      where: { email: dto.email.toLowerCase() },
      select: { id: true },
    });
    if (existente) {
      throw new ConflictException('El email ya está registrado');
    }
    const tienda = await this.prisma.tienda.findUnique({
      where: { id: dto.tiendaId },
      select: { id: true },
    });
    if (!tienda) throw new BadRequestException('La tienda no existe');

    const password = await bcrypt.hash(dto.password, 10);
    const usuario = await this.prisma.usuario.create({
      data: {
        email: dto.email.toLowerCase(),
        password,
        nombre: dto.nombre,
        apellido: dto.apellido,
        telefono: dto.telefono,
        rol: dto.rol,
        tiendaId: dto.tiendaId,
        activo: true,
      },
      include: { tienda: { select: { id: true, nombre: true, ciudad: true } } },
    });
    return this.formatear(usuario);
  }

  /** Edita un empleado. Rechaza cambiar a CLIENTE. */
  async actualizar(id: number, dto: ActualizarUsuarioDto) {
    const usuario = await this.prisma.usuario.findUnique({ where: { id } });
    if (!usuario || usuario.deletedAt !== null) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (usuario.rol === RolUsuario.CLIENTE) {
      throw new ForbiddenException(
        'Los clientes no se editan desde el panel. Sus datos vienen de Firebird o de su registro web.',
      );
    }
    if (dto.rol === RolUsuario.CLIENTE) {
      throw new BadRequestException('No se puede cambiar el rol a CLIENTE desde el panel.');
    }
    if (dto.tiendaId !== undefined) {
      const tienda = await this.prisma.tienda.findUnique({
        where: { id: dto.tiendaId },
        select: { id: true },
      });
      if (!tienda) throw new BadRequestException('La tienda no existe');
    }

    const actualizado = await this.prisma.usuario.update({
      where: { id },
      data: {
        nombre: dto.nombre ?? usuario.nombre,
        apellido: dto.apellido !== undefined ? dto.apellido : usuario.apellido,
        telefono: dto.telefono !== undefined ? dto.telefono : usuario.telefono,
        rol: dto.rol ?? usuario.rol,
        tiendaId: dto.tiendaId ?? usuario.tiendaId,
      },
      include: { tienda: { select: { id: true, nombre: true, ciudad: true } } },
    });
    return this.formatear(actualizado);
  }

  /** Admin define una nueva contraseña para un empleado. */
  async resetPassword(id: number, dto: AdminResetPasswordDto) {
    const usuario = await this.prisma.usuario.findUnique({ where: { id } });
    if (!usuario || usuario.deletedAt !== null) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (usuario.rol === RolUsuario.CLIENTE) {
      throw new ForbiddenException('No puedes cambiar la contraseña de un cliente desde el panel.');
    }
    const password = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.usuario.update({ where: { id }, data: { password } });
    // Revocar sesiones activas para forzar re-login con la nueva contraseña.
    await this.prisma.refreshToken.updateMany({
      where: { usuarioId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { mensaje: 'Contraseña actualizada' };
  }

  /**
   * Desactiva o activa un usuario (empleado o cliente).
   * No rompe Firebird: solo cambia el flag `activo`, que ya bloquea login.
   */
  async cambiarActivo(id: number, activo: boolean) {
    const usuario = await this.prisma.usuario.findUnique({ where: { id } });
    if (!usuario || usuario.deletedAt !== null) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (usuario.rol === RolUsuario.ADMIN && !activo) {
      // Evitar que un admin se desactive a sí mismo / desactive al último admin.
      const admins = await this.prisma.usuario.count({
        where: { rol: RolUsuario.ADMIN, activo: true, deletedAt: null },
      });
      if (admins <= 1) {
        throw new BadRequestException('No se puede desactivar al único administrador activo.');
      }
    }
    const actualizado = await this.prisma.usuario.update({
      where: { id },
      data: { activo },
    });
    // Si se desactiva, revocar sesiones activas.
    if (!activo) {
      await this.prisma.refreshToken.updateMany({
        where: { usuarioId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return this.formatear(actualizado);
  }

  /**
   * Soft delete: solo empleados. Marca `deletedAt` y `activo=false`, pero
   * conserva la fila y sus relaciones (pedidos, historial). Los clientes
   * nunca se eliminan.
   */
  async eliminar(id: number) {
    const usuario = await this.prisma.usuario.findUnique({ where: { id } });
    if (!usuario || usuario.deletedAt !== null) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (usuario.rol === RolUsuario.CLIENTE) {
      throw new ForbiddenException(
        'Los clientes no se eliminan. Puedes desactivarlos para que no inicien sesión.',
      );
    }
    if (usuario.rol === RolUsuario.ADMIN) {
      const admins = await this.prisma.usuario.count({
        where: { rol: RolUsuario.ADMIN, activo: true, deletedAt: null },
      });
      if (admins <= 1) {
        throw new BadRequestException('No se puede eliminar al único administrador activo.');
      }
    }
    await this.prisma.usuario.update({
      where: { id },
      data: { deletedAt: new Date(), activo: false },
    });
    await this.prisma.refreshToken.updateMany({
      where: { usuarioId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { mensaje: 'Usuario eliminado' };
  }

  // ---------------------------------------------------------------

  private formatear(u: any) {
    const { password, ...rest } = u;
    return {
      ...rest,
      // Exponer nombre de tienda + si es cliente de Firebird.
      esDeFirebird:
        u.rol === RolUsuario.CLIENTE &&
        u.tiendasCliente?.some((tc: any) => tc.localClienteId != null),
      tiendas: u.tiendasCliente?.map((tc: any) => ({
        tiendaId: tc.tiendaId,
        tiendaNombre: tc.tienda?.nombre,
        localClienteId: tc.localClienteId,
        listaPrecioCodigo: tc.listaPrecioCodigo,
        activo: tc.activo,
      })),
    };
  }
}
