import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, ParseIntPipe, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TiendasService } from './tiendas.service';
import { CreateTiendaDto } from './dto/create-tienda.dto';
import { UpdateTiendaDto } from './dto/update-tienda.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Tiendas')
@Controller('tiendas')
export class TiendasController {
  constructor(private readonly tiendasService: TiendasService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Listar todas las tiendas activas' })
  findAll(
    @Query('estado') estado?: string,
    @Query('ciudad') ciudad?: string,
  ) {
    if (estado || ciudad) {
      return this.tiendasService.findAllWithFilters(estado, ciudad);
    }
    return this.tiendasService.findAll();
  }

  @Get('estados')
  @Public()
  @ApiOperation({ summary: 'Obtener lista de estados con tiendas' })
  getEstados() {
    return this.tiendasService.getEstados();
  }

  @Get('ciudades')
  @Public()
  @ApiOperation({ summary: 'Obtener ciudades por estado' })
  getCiudadesPorEstado(@Query('estado') estado: string) {
    return this.tiendasService.getCiudadesPorEstado(estado);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Obtener detalle de una tienda' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.tiendasService.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RolUsuario.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Crear nueva tienda (Admin)' })
  create(@Body() dto: CreateTiendaDto) {
    return this.tiendasService.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RolUsuario.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Actualizar tienda (Admin)' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTiendaDto) {
    return this.tiendasService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RolUsuario.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Desactivar tienda (Admin)' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.tiendasService.remove(id);
  }
}
