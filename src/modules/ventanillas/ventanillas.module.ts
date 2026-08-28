import { Module } from '@nestjs/common';
import { VentanillasService } from './ventanillas.service';
import { VentanillasAdminController } from './ventanillas-admin.controller';
import { VentanillasCajeroController } from './ventanillas-cajero.controller';

@Module({
  controllers: [VentanillasAdminController, VentanillasCajeroController],
  providers: [VentanillasService],
  exports: [VentanillasService],
})
export class VentanillasModule {}
