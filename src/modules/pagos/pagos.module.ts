import { Module } from '@nestjs/common';
import { PedidosModule } from '../pedidos/pedidos.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CuentasBancariasController } from './cuentas/cuentas-bancarias.controller';
import { CuentasBancariasService } from './cuentas/cuentas-bancarias.service';
import { ComprobanteStorageService } from './transferencia/comprobante-storage.service';
import { PagoClienteController } from './transferencia/pago-cliente.controller';
import { PagoTiendaController } from './transferencia/pago-tienda.controller';
import { PagoTransferenciaService } from './transferencia/pago-transferencia.service';
import { TesoreriaController } from './transferencia/tesoreria.controller';
import { TesoreriaService } from './transferencia/tesoreria.service';

/**
 * Pagos por transferencia (oct 2026). Ver PLAN-PAGOS-TRANSFERENCIA.md.
 *
 * Depende de `PedidosModule` (control de acceso por tienda) y NO al revés: los módulos viejos
 * que necesitan reaccionar a un pago (máquina de estados, cobro de VFP, cancelación, cajero)
 * usan las funciones puras de `transferencia/hooks.ts`, sin importar este módulo. Un servicio
 * inyectado allá sería un ciclo de dependencias.
 *
 * `RealtimeModule` es @Global().
 */
@Module({
  imports: [PedidosModule, NotificationsModule],
  controllers: [
    CuentasBancariasController,
    PagoClienteController,
    PagoTiendaController,
    TesoreriaController,
  ],
  providers: [
    CuentasBancariasService,
    ComprobanteStorageService,
    PagoTransferenciaService,
    TesoreriaService,
  ],
  // `TesoreriaService`: el módulo de destrabar marca vencida una transferencia por la misma vía que Tesorería.
  exports: [PagoTransferenciaService, TesoreriaService],
})
export class PagosModule {}
