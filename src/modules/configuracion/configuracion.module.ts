import { Global, Module } from '@nestjs/common';
import { ConfiguracionController } from './configuracion.controller';
import { ConfiguracionService } from './configuracion.service';

/**
 * `@Global` para que `NotificationsService`, `AuthService` y
 * `MessagesService` lean el logo sin repetir el import en cada módulo.
 */
@Global()
@Module({
  controllers: [ConfiguracionController],
  providers: [ConfiguracionService],
  exports: [ConfiguracionService],
})
export class ConfiguracionModule {}
