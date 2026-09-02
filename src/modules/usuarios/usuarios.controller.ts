import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '@prisma/client';
import { UsuariosService } from './usuarios.service';
import {
  CrearUsuarioDto,
  ActualizarUsuarioDto,
  AdminResetPasswordDto,
  CambiarActivoDto,
  ListarUsuariosQueryDto,
} from './dto/usuarios.dto';

/**
 * Gestión de usuarios desde el panel ADMIN.
 *  - Empleados: crear, editar, cambiar contraseña, desactivar/activar, eliminar (soft delete).
 *  - Clientes: solo desactivar/activar (no se crean, editan ni eliminan desde aquí).
 */
@ApiTags('Usuarios (Admin)')
@ApiBearerAuth()
@Controller('admin/usuarios')
@Roles(RolUsuario.ADMIN)
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) {}

  @Get()
  @ApiOperation({ summary: 'Listar usuarios con filtros (Admin)' })
  listar(@Query() query: ListarUsuariosQueryDto) {
    return this.usuariosService.listar(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un usuario (Admin)' })
  obtener(@Param('id', ParseIntPipe) id: number) {
    return this.usuariosService.obtener(id);
  }

  @Post()
  @ApiOperation({ summary: 'Crear un empleado (Admin). No permite CLIENTE.' })
  crear(@Body() dto: CrearUsuarioDto) {
    return this.usuariosService.crear(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Editar un empleado (Admin). No permite cambiar a CLIENTE.' })
  actualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ActualizarUsuarioDto,
  ) {
    return this.usuariosService.actualizar(id, dto);
  }

  @Post(':id/password')
  @ApiOperation({ summary: 'Cambiar la contraseña de un empleado (Admin)' })
  resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdminResetPasswordDto,
  ) {
    return this.usuariosService.resetPassword(id, dto);
  }

  @Patch(':id/activo')
  @ApiOperation({ summary: 'Desactivar/activar un usuario (empleado o cliente)' })
  cambiarActivo(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CambiarActivoDto,
  ) {
    return this.usuariosService.cambiarActivo(id, dto.activo);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar un empleado (soft delete). Los clientes no se eliminan.' })
  eliminar(@Param('id', ParseIntPipe) id: number) {
    return this.usuariosService.eliminar(id);
  }
}
