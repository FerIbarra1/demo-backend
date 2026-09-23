import { Global, Module } from '@nestjs/common';
import {
  ConfiguracionController,
  ConfiguracionPublicController,
} from './configuracion.controller';
import { ConfiguracionService } from './configuracion.service';

/**
 * `@Global` para que `NotificationsService`, `AuthService` y
 * `MessagesService` lean el logo sin repetir el import en cada módulo.
 */
@Global()
@Module({
  controllers: [ConfiguracionController, ConfiguracionPublicController],
  providers: [ConfiguracionService],
  exports: [ConfiguracionService],
})
export class ConfiguracionModule {}
