import { IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';

/** Roles que el admin puede asignar al crear/editar un empleado. Excluye CLIENTE. */
export const ROLES_EMPLEADO = [
  RolUsuario.ADMIN,
  RolUsuario.BODEGA,
  RolUsuario.BODEGA_MONITOR,
  RolUsuario.CAJERO,
  RolUsuario.CAJERO_MONITOR,
  RolUsuario.MOSTRADOR,
] as const;

export class CrearUsuarioDto {
  @ApiProperty({ example: 'juan@tienda.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Juan' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  nombre: string;

  @ApiPropertyOptional({ example: 'Pérez' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  apellido?: string;

  @ApiPropertyOptional({ example: '+525512345678', description: 'Formato E.164' })
  @IsOptional()
  @IsString()
  @Matches(/^\+\d{6,15}$/, { message: 'telefono debe tener formato E.164 (+<6-15 dígitos>)' })
  telefono?: string;

  @ApiProperty({ enum: ROLES_EMPLEADO, description: 'Rol interno. No se permite CLIENTE aquí.' })
  @IsIn(ROLES_EMPLEADO as unknown as string[])
  rol: RolUsuario;

  @ApiProperty({ example: 1, description: 'Tienda a la que pertenece el empleado (obligatoria).' })
  @Type(() => Number)
  @IsInt()
  tiendaId: number;

  @ApiProperty({ description: 'Contraseña inicial definida por el admin.', minLength: 6 })
  @IsString()
  @MinLength(6)
  password: string;
}

export class ActualizarUsuarioDto {
  @ApiPropertyOptional({ example: 'Juan' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  nombre?: string;

  @ApiPropertyOptional({ example: 'Pérez' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  apellido?: string;

  @ApiPropertyOptional({ example: '+525512345678' })
  @IsOptional()
  @IsString()
  @Matches(/^\+\d{6,15}$/, { message: 'telefono debe tener formato E.164 (+<6-15 dígitos>)' })
  telefono?: string;

  @ApiPropertyOptional({ enum: ROLES_EMPLEADO })
  @IsOptional()
  @IsIn(ROLES_EMPLEADO as unknown as string[])
  rol?: RolUsuario;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tiendaId?: number;
}

export class AdminResetPasswordDto {
  @ApiProperty({ minLength: 6 })
  @IsString()
  @MinLength(6)
  newPassword: string;
}

export class CambiarActivoDto {
  @ApiProperty({ description: 'true = activar, false = desactivar' })
  @IsIn([true, false])
  activo: boolean;
}

export class ListarUsuariosQueryDto {
  @ApiPropertyOptional({ description: 'Filtrar por rol' })
  @IsOptional()
  @IsIn(Object.values(RolUsuario))
  rol?: RolUsuario;

  @ApiPropertyOptional({ description: 'Filtrar por tienda' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tiendaId?: number;

  @ApiPropertyOptional({ description: 'Búsqueda por nombre o email' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  busqueda?: string;

  @ApiPropertyOptional({
    description: "'true' = solo empleados, 'false' = solo clientes",
    example: 'true',
  })
  @IsOptional()
  @IsString()
  soloEmpleados?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pagina?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limite?: number;
}
