import { Module } from '@nestjs/common';
import { KioskoController } from './kiosko.controller';
import {
  KioskoLlegadaController,
  PedidoLlegoQrController,
} from './kiosko-llegada.controller';
import { KioskoLlegadaService } from './kiosko-llegada.service';
import { KioskoService } from './kiosko.service';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RealtimeModule],
  controllers: [
    KioskoController,
    KioskoLlegadaController,
    PedidoLlegoQrController,
  ],
  providers: [KioskoService, KioskoLlegadaService],
  exports: [KioskoService, KioskoLlegadaService],
})
export class KioskoModule {}
