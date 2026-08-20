import { Controller, Get, Post, Body, Param, ParseIntPipe, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { CatalogoService } from './catalogo.service';
import { FiltroCatalogoDto } from './dto/filtro-catalogo.dto';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Catálogo')
@Controller('catalogo')
export class CatalogoController {
  constructor(
    private readonly catalogoService: CatalogoService,
    private readonly jwtService: JwtService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Listar productos del catálogo' })
  @ApiQuery({ name: 'tiendaId', required: true, type: Number })
  async obtenerProductos(
    @Query() filtros: FiltroCatalogoDto,
    @Req() req: Request,
  ) {
    // El endpoint es @Public. Si el cliente envía JWT, lo leemos para
    // inyectar esFavorito por producto. Si no viene o es inválido, no falla.
    const userId = this.leerUserIdOpcional(req);
    return this.catalogoService.obtenerProductos(filtros, userId);
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

  @Get('precios')
  @Public()
  @ApiOperation({
    summary: 'Resuelve un set de precioCOIds a { producto, variante, precio }',
  })
  @ApiQuery({ name: 'ids', required: true, type: String, example: '1,2,3' })
  async obtenerPreciosPorIds(@Query('ids') ids: string) {
    const parsed = ids
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return this.catalogoService.obtenerPreciosPorIds(parsed);
  }

  /**
   * Lee el JWT del header Authorization y devuelve el userId.
   * Si no hay token o es inválido, devuelve undefined (no falla).
   */
  private leerUserIdOpcional(req: Request): number | undefined {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return undefined;
    const token = auth.slice('Bearer '.length).trim();
    try {
      const payload = this.jwtService.verify<{ sub: number }>(token);
      return payload.sub;
    } catch {
      return undefined;
    }
  }
}
