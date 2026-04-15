import { Controller, Get, Post, Body, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { CatalogoService } from './catalogo.service';
import { FiltroCatalogoDto } from './dto/filtro-catalogo.dto';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Catálogo')
@Controller('catalogo')
export class CatalogoController {
  constructor(private readonly catalogoService: CatalogoService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Listar productos del catálogo' })
  @ApiQuery({ name: 'tiendaId', required: true, type: Number })
  async obtenerProductos(@Query() filtros: FiltroCatalogoDto) {
    return this.catalogoService.obtenerProductos(filtros);
  }

  @Get('tienda/:tiendaId/producto/:id')
  @Public()
  @ApiOperation({ summary: 'Obtener detalle de un producto' })
  async obtenerProductoDetalle(
    @Param('id', ParseIntPipe) id: number,
    @Param('tiendaId', ParseIntPipe) tiendaId: number,
  ) {
    return this.catalogoService.obtenerProductoDetalle(id, tiendaId);
  }

  @Get('filtros/:tiendaId')
  @Public()
  @ApiOperation({ summary: 'Obtener opciones de filtro disponibles' })
  async obtenerFiltros(@Param('tiendaId', ParseIntPipe) tiendaId: number) {
    return this.catalogoService.obtenerFiltrosDisponibles(tiendaId);
  }

  @Post('verificar-stock')
  @Public()
  @ApiOperation({ summary: 'Verificar disponibilidad de stock' })
  async verificarStock(
    @Body() items: { precioCOId: number; cantidad: number }[],
  ) {
    return this.catalogoService.verificarDisponibilidad(items);
  }
}
