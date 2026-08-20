import { Module } from '@nestjs/common';
import { KioskoController } from './kiosko.controller';
import { KioskoService } from './kiosko.service';

@Module({
  controllers: [KioskoController],
  providers: [KioskoService],
  exports: [KioskoService],
})
export class KioskoModule {}
