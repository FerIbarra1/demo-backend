import { Module } from '@nestjs/common';
import { VentanillasModule } from '../ventanillas/ventanillas.module';
import { MostradoresModule } from '../mostradores/mostradores.module';
import { BodegaPresenciaModule } from './bodega-presencia.module';
import { EstacionesWorker } from './estaciones.worker';

/** Oct 2026: el barrido de estaciones y puestos abandonados (ver `EstacionesWorker`). */
@Module({
  imports: [VentanillasModule, MostradoresModule, BodegaPresenciaModule],
  providers: [EstacionesWorker],
})
export class EstacionesModule {}
