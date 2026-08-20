import { Module, forwardRef } from '@nestjs/common';
import { PedidosModule } from '../pedidos/pedidos.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { SyncAgentController } from './sync-agent.controller';
import { SyncAgentService } from './sync-agent.service';
import { ExternalRefService } from './external-ref.service';
import { CatalogHandler } from './handlers/catalog.handler';
import { ClienteHandler } from './handlers/cliente.handler';
import { PedidoPagoHandler } from './handlers/pedido-pago.handler';
import { PedidoDescargaHandler } from './handlers/pedido-descarga.handler';

/**
 * SyncModule (F9 ago 2026).
 *
 * Recibe los cambios del agente local (que corre en el servidor central
 * de Firebird) y los aplica a la BD PostgreSQL de la nube. También
 * expone la cola de pedidos nuevos que el agente descarga hacia Firebird.
 *
 * Autenticación: reutiliza ApiKeyGuard + decorador @ApiKeyAuth() que ya
 * están en uso por el webhook de marcar-pagado. Adicional, todos los
 * endpoints de /api/sync/agent/* usan @SkipThrottle() para no ser
 * golpeados por el throttler global (100 req/60s) del API público.
 *
 * Composición:
 *   - sync-agent.controller.ts: 5 endpoints REST (heartbeat, poll-pedidos,
 *     upload, pedidos-ack, pedidos-error).
 *   - sync-agent.service.ts: orquesta el procesamiento de cada evento,
 *     actualiza checkpoint, escribe SyncEventLog.
 *   - external-ref.service.ts: mapeo polimórfico nube↔Firebird.
 *   - handlers/: un handler por tipo de evento (catálogo, cliente,
 *     pedido-pago, pedido-descarga). El pedido-pago delega a
 *     AdminService.marcarComoPagado (que ya hace transición, historial,
 *     realtime y email).
 */
@Module({
  imports: [PrismaModule, forwardRef(() => PedidosModule)],
  controllers: [SyncAgentController],
  providers: [
    SyncAgentService,
    ExternalRefService,
    CatalogHandler,
    ClienteHandler,
    PedidoPagoHandler,
    PedidoDescargaHandler,
  ],
  exports: [SyncAgentService, ExternalRefService],
})
export class SyncModule {}
