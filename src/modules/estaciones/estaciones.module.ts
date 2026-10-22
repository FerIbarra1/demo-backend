import { Module } from '@nestjs/common';
import { VentanillasModule } from '../ventanillas/ventanillas.module';
import { MostradoresModule } from '../mostradores/mostradores.module';
import { BodegaPresenciaModule } from './bodega-presencia.module';
import { EstacionesWorker } from './estaciones.worker';
import { EstacionesController } from './estaciones.controller';

/** Oct 2026: el barrido de estaciones y puestos abandonados (ver `EstacionesWorker`). */
@Module({
  imports: [VentanillasModule, MostradoresModule, BodegaPresenciaModule],
  controllers: [EstacionesController],
  providers: [EstacionesWorker],
})
export class EstacionesModule {}
