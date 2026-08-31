import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  ParseIntPipe,
  Query,
  Body,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { ImagenesService } from './imagenes.service';
import { ListarProductosQueryDto } from './dto/listar-productos-query.dto';
import { SubirImagenDto } from './dto/subir-imagen.dto';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('Imágenes de Productos (Admin)')
@ApiBearerAuth()
@Controller('admin/productos')
@Roles(RolUsuario.ADMIN)
export class ImagenesController {
  constructor(private readonly imagenesService: ImagenesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista productos con sus imágenes (Admin)' })
  listarProductos(@Query() query: ListarProductosQueryDto) {
    return this.imagenesService.listarProductos(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un producto con colores e imágenes (Admin)' })
  obtenerProducto(@Param('id', ParseIntPipe) id: number) {
    return this.imagenesService.obtenerProducto(id);
  }

  @Post(':id/imagenes')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Sube una imagen para un producto (Admin)',
    description:
      'Campo multipart `file` (JPG/PNG/WEBP, máx 5 MB) y campo `colorId` opcional. ' +
      'Máximo 4 imágenes por (producto, color).',
  })
  @UseInterceptors(FileInterceptor('file'))
  subirImagen(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubirImagenDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.imagenesService.subirImagen(id, dto.colorId, file);
  }

  @Delete(':id/imagenes/:imagenId')
  @ApiOperation({ summary: 'Elimina una imagen de un producto (Admin)' })
  eliminarImagen(
    @Param('id', ParseIntPipe) id: number,
    @Param('imagenId', ParseIntPipe) imagenId: number,
  ) {
    return this.imagenesService.eliminarImagen(id, imagenId);
  }

  @Post(':id/imagenes/:imagenId/principal')
  @ApiOperation({ summary: 'Marca una imagen como principal (Admin)' })
  marcarPrincipal(
    @Param('id', ParseIntPipe) id: number,
    @Param('imagenId', ParseIntPipe) imagenId: number,
  ) {
    return this.imagenesService.marcarPrincipal(id, imagenId);
  }
}
