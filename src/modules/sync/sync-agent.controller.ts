import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { ApiKeyAuth } from '../../common/decorators/api-key.decorator';
import { SkipThrottle } from '@nestjs/throttler';
import { SyncAgentService } from './sync-agent.service';
import { ConciliacionService } from './conciliacion.service';
import { ConciliacionDto } from './dto/conciliacion.dto';
import { HeartbeatDto } from './dto/heartbeat.dto';
import { UploadBatchDto } from './dto/upload-batch.dto';
import { PedidosAckDto } from './dto/pedidos-ack.dto';
import { FoliosAckDto } from './dto/folios-ack.dto';

/**
 * Controller del agente de sincronización (F9 ago 2026).
 *
 * Autenticación: ApiKeyGuard valida X-Agent-Key contra AGENT_API_KEY
 * (igual que el webhook de marcar-pagado). El header X-Sucursal-Id
 * identifica la tienda.
 *
 * Throttler: @SkipThrottle() en todos los endpoints para que el agente
 * no compita con el rate limit del API público (100 req/60s).
 */
@ApiTags('Sync - Agent')
@Controller('sync/agent')
@UseGuards(ApiKeyGuard)
@ApiKeyAuth()
@SkipThrottle()
export class SyncAgentController {
  constructor(
    private readonly service: SyncAgentService,
    private readonly conciliacion: ConciliacionService,
  ) {}

  @Post('heartbeat')
  @ApiOperation({
    summary: 'Heartbeat del agente. Actualiza ultimoHeartbeatAt del checkpoint.',
  })
  async heartbeat(@Body() dto: HeartbeatDto, @Headers('x-sucursal-id') sucursalIdHeader: string) {
    const tiendaId = this.parseTiendaId(sucursalIdHeader);
    return this.service.heartbeat(tiendaId, dto);
  }

  @Get('poll-pedidos')
  @ApiOperation({
    summary: 'Cola de pedidos pendientes para bajar a Firebird. Query: ?sucursalId=X&limit=N',
  })
  async pollPedidos(
    @Headers('x-sucursal-id') sucursalIdHeader: string,
    @Headers('x-agent-id') agentIdHeader: string,
    @Query('limit') limitRaw?: string,
  ) {
    const tiendaId = this.parseTiendaId(sucursalIdHeader);
    const agentId = agentIdHeader?.trim();
    if (!agentId) {
      throw new BadRequestException('Header X-Agent-Id es obligatorio');
    }
    const limit = Math.min(parseInt(limitRaw ?? '20', 10) || 20, 100);
    const data = await this.service.pollPedidos(tiendaId, limit, agentId);
    return { tiendaId, pedidos: data };
  }

  @Get('poll-folios')
  @ApiOperation({
    summary:
      'Oct 2026 (parte B): solicitudes de FOLIO de la tienda. El agente reserva un consecutivo de CONSECUTIVOS por cada una y contesta en folios-ack. Query: ?limit=N',
  })
  async pollFolios(
    @Headers('x-sucursal-id') sucursalIdHeader: string,
    @Headers('x-agent-id') agentIdHeader: string,
    @Query('limit') limitRaw?: string,
  ) {
    const tiendaId = this.parseTiendaId(sucursalIdHeader);
    const agentId = agentIdHeader?.trim();
    if (!agentId) {
      throw new BadRequestException('Header X-Agent-Id es obligatorio');
    }
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '20', 10) || 20, 1), 100);
    const data = await this.service.pollFolios(tiendaId, limit, agentId);
    return { tiendaId, solicitudes: data };
  }

  @Post('folios-ack')
  @ApiOperation({
    summary:
      'Oct 2026 (parte B): el agente reservó el consecutivo (o falló). La nube guarda el folio en el pedido y avisa a las pantallas.',
  })
  async foliosAck(@Body() dto: FoliosAckDto, @Headers('x-sucursal-id') sucursalIdHeader: string) {
    const tiendaId = this.parseTiendaId(sucursalIdHeader);
    if (dto.tiendaId !== tiendaId) {
      throw new BadRequestException('tiendaId no coincide con X-Sucursal-Id');
    }
    return this.service.procesarFoliosAck(dto);
  }

  @Post('upload')
  @ApiOperation({
    summary:
      'Batch de cambios desde Firebird (catálogo/clientes/pagos). Avanza checkpoint a hastaBANDEJAId si todos OK.',
  })
  async upload(@Body() dto: UploadBatchDto, @Headers('x-sucursal-id') sucursalIdHeader: string) {
    const tiendaId = this.parseTiendaId(sucursalIdHeader);
    if (dto.tiendaId !== tiendaId) {
      throw new BadRequestException('tiendaId no coincide con X-Sucursal-Id');
    }
    return this.service.procesarUpload(dto);
  }

  @Post('pedidos-ack')
  @ApiOperation({
    summary:
      'Confirmación del agente: pedidos subidos a Firebird o errores. Marca PedidoPendienteEnvio.',
  })
  async pedidosAck(@Body() dto: PedidosAckDto, @Headers('x-sucursal-id') sucursalIdHeader: string) {
    const tiendaId = this.parseTiendaId(sucursalIdHeader);
    if (dto.tiendaId !== tiendaId) {
      throw new BadRequestException('tiendaId no coincide con X-Sucursal-Id');
    }
    return this.service.procesarPedidosAck(dto);
  }

  @Get('conciliacion')
  @ApiOperation({
    summary:
      'Oct 2026: los pedidos de la tienda que conviene VERIFICAR contra el Sistema Comercial (ya viven allá y su estado puede diverger). Paginado por pedidoId (?despues=).',
  })
  async conciliacionPendientes(
    @Headers('x-sucursal-id') sucursalIdHeader: string,
    @Query('limit') limitRaw?: string,
    @Query('despues') despuesRaw?: string,
  ) {
    const tiendaId = this.parseTiendaId(sucursalIdHeader);
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '200', 10) || 200, 1), 500);
    const despues = Math.max(parseInt(despuesRaw ?? '0', 10) || 0, 0);
    return this.conciliacion.pendientes(tiendaId, limit, despues);
  }

  @Post('conciliacion')
  @ApiOperation({
    summary:
      'Oct 2026: el estado REAL (SWCANCEL, FINALIZADA, TTOTAL) de esos pedidos en Firebird. La nube compara, corrige el cobro/cancelación que no supo y registra lo demás.',
  })
  async conciliar(
    @Body() dto: ConciliacionDto,
    @Headers('x-sucursal-id') sucursalIdHeader: string,
  ) {
    const tiendaId = this.parseTiendaId(sucursalIdHeader);
    if (dto.tiendaId !== tiendaId) {
      throw new BadRequestException('tiendaId no coincide con X-Sucursal-Id');
    }
    return this.conciliacion.aplicar(dto);
  }

  @Post('pedidos-error')
  @ApiOperation({
    summary: 'Reporte de error transitorio en un pedido (incrementa intentos).',
  })
  async pedidosError(
    @Body()
    body: {
      pedidoId: number;
      error: string;
      tiendaId: number;
      agentId: string;
      leaseToken: string;
    },
    @Headers('x-sucursal-id') sucursalIdHeader: string,
  ) {
    const tiendaId = this.parseTiendaId(sucursalIdHeader);
    if (body.tiendaId !== tiendaId) {
      throw new BadRequestException('tiendaId no coincide con X-Sucursal-Id');
    }
    return this.service.procesarPedidosAck({
      tiendaId,
      acks: [
        {
          pedidoId: body.pedidoId,
          agentId: body.agentId,
          leaseToken: body.leaseToken,
          exito: false,
          error: body.error,
        },
      ],
    });
  }

  private parseTiendaId(header: string | undefined): number {
    const v = parseInt(header ?? '', 10);
    if (!Number.isFinite(v) || v <= 0) {
      throw new BadRequestException('Header X-Sucursal-Id es obligatorio y debe ser numérico');
    }
    return v;
  }
}
