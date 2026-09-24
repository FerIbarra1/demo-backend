import { Global, Module } from '@nestjs/common';
import { PreciosService } from './precios.service';

/**
 * Fase 0 (sep 2026): resolución de la lista de precios del cliente.
 *
 * `@Global()` porque lo consumen `CatalogoModule`, `PedidosModule` (cliente y
 * propuesta) y —más adelante— el ajuste de mostrador. No tiene estado ni
 * dependencias más allá de `PrismaService` (que ya es global vía
 * `PrismaModule`), así que importarlo módulo por módulo solo agregaría ruido.
 */
@Global()
@Module({
  providers: [PreciosService],
  exports: [PreciosService],
})
export class PreciosModule {}
