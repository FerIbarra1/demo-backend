import { Module } from '@nestjs/common';
import { BodegaPresenciaService } from './bodega-presencia.service';

/**
 * Presencia del bodeguero (ver `BodegaPresenciaService`). Va en un módulo propio, sin imports, porque
 * lo usan `AuthModule` (entrar, salir, latido) y `EstacionesModule` (el barrido): meterlo en
 * `EstacionesModule` haría que auth dependiera de ventanillas y mostradores.
 */
@Module({
  providers: [BodegaPresenciaService],
  exports: [BodegaPresenciaService],
})
export class BodegaPresenciaModule {}
