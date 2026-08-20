import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';
import { FavoritosService } from './favoritos.service';

@ApiTags('Favoritos')
@ApiBearerAuth()
@Controller('favoritos')
@Roles(RolUsuario.CLIENTE)
export class FavoritosController {
  constructor(private readonly favoritosService: FavoritosService) {}

  /**
   * Lista los productos favoritos del cliente autenticado.
   * Ordenados por fecha de marcado (más reciente primero).
   * El detalle de precios/variantes se filtra por la tienda del cliente
   * (header X-Tienda-Id o la del JWT).
   */
  @Get()
  @ApiOperation({ summary: 'Mis favoritos' })
  async listar(@CurrentUser() user: any) {
    return this.favoritosService.listar(
      user.userId,
      user.tiendaId ?? user.tiendaIdHeader,
    );
  }

  /** Marca un producto como favorito (idempotente). */
  @Post(':productoId')
  @ApiOperation({ summary: 'Marcar producto como favorito' })
  async agregar(
    @Param('productoId', ParseIntPipe) productoId: number,
    @CurrentUser() user: any,
  ) {
    return this.favoritosService.agregar(user.userId, productoId);
  }

  /** Quita un producto de favoritos (idempotente). */
  @Delete(':productoId')
  @ApiOperation({ summary: 'Quitar producto de favoritos' })
  async quitar(
    @Param('productoId', ParseIntPipe) productoId: number,
    @CurrentUser() user: any,
  ) {
    return this.favoritosService.quitar(user.userId, productoId);
  }
}
