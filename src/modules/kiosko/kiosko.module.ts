import { Module } from '@nestjs/common';
import { KioskoController } from './kiosko.controller';
import { KioskoPairingController } from './kiosko-pairing.controller';
import {
  KioskoLlegadaController,
  PedidoLlegoQrController,
} from './kiosko-llegada.controller';
import { KioskoLlegadaService } from './kiosko-llegada.service';
import { KioskoService } from './kiosko.service';
import { KioskoPairingService } from './kiosko-pairing.service';
import { KioskoAlertasWorker } from './kiosko-alertas.worker';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RealtimeModule],
  controllers: [
    KioskoController,
    KioskoPairingController,
    KioskoLlegadaController,
    PedidoLlegoQrController,
  ],
  providers: [KioskoService, KioskoLlegadaService, KioskoPairingService, KioskoAlertasWorker],
  exports: [KioskoService, KioskoLlegadaService, KioskoPairingService],
})
export class KioskoModule {}
