import { Module } from '@nestjs/common';
import { CatalogoService } from './catalogo.service';
import { CatalogoController } from './catalogo.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule exporta JwtModule, que el controller necesita para leer el
  // JWT opcional del header Authorization (sin requerir auth obligatoria).
  imports: [AuthModule],
  controllers: [CatalogoController],
  providers: [CatalogoService],
  exports: [CatalogoService],
})
export class CatalogoModule {}