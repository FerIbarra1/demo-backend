import { Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { SyncAgentService } from './sync-agent.service';

@ApiTags('Sync - Admin')
@Controller('sync/admin')
@Roles(RolUsuario.ADMIN)
@ApiBearerAuth()
export class SyncAdminController {
  constructor(private readonly service: SyncAgentService) {}

  @Post('events/:eventId/replay')
  @ApiOperation({ summary: 'Reprogramar un evento de sincronización fallido' })
  replay(@Param('eventId') eventId: string) {
    return this.service.reprogramarEvento(eventId);
  }
}
