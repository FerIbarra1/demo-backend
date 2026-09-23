import { Global, Module } from '@nestjs/common';
import { ImagenesController } from './imagenes.controller';
import { ImagenesService } from './imagenes.service';
import { StorageService } from './storage.service';

/**
 * `@Global` a propósito: `StorageService` es la capa de resolución de imágenes
 * que usan catálogo, favoritos, pedidos, notificaciones y el propio panel admin.
 * Registrarlo global evita repetir `imports: [ImagenesModule]` en cada módulo
 * consumidor (el mismo patrón que ya usa PrismaModule).
 */
@Global()
@Module({
  controllers: [ImagenesController],
  providers: [ImagenesService, StorageService],
  exports: [ImagenesService, StorageService],
})
export class ImagenesModule {}
