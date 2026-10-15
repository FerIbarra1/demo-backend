import { Module } from '@nestjs/common';
import { MostradoresService } from './mostradores.service';
import { MostradoresAdminController } from './mostradores-admin.controller';
import { MostradoresOperadorController } from './mostradores-operador.controller';

/**
 * F22 (oct 2026): los mostradores físicos de cada tienda. Espejo de
 * `VentanillasModule`. `RealtimeModule` es @Global, no hace falta importarlo.
 */
@Module({
  controllers: [MostradoresAdminController, MostradoresOperadorController],
  providers: [MostradoresService],
  exports: [MostradoresService],
})
export class MostradoresModule {}
