import { Module } from '@nestjs/common';
import { ImagenesController } from './imagenes.controller';
import { ImagenesService } from './imagenes.service';
import { StorageService } from './storage.service';

@Module({
  controllers: [ImagenesController],
  providers: [ImagenesService, StorageService],
  exports: [ImagenesService, StorageService],
})
export class ImagenesModule {}
