import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Salud del servicio, para nginx, Docker (`HEALTHCHECK`), el balanceador y el monitor de disponibilidad. Públicos y
 * fuera del límite de peticiones (un monitor que sondea cada pocos segundos no puede agotar el cupo de la IP).
 *
 *  - `GET /api/health`        vivo: el proceso responde. Barato; no toca la BD (si la BD se cae, reiniciar el
 *                             proceso no la arregla, así que NO debe tumbar el contenedor).
 *  - `GET /api/health/ready`  listo: la BD contesta. Es el que debe mirar el balanceador antes de mandar tráfico y
 *                             el que debe correr el despliegue antes de dar por bueno el release.
 */
@ApiTags('Salud')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @SkipThrottle()
  @Get()
  @ApiOperation({ summary: 'El proceso está vivo' })
  vivo() {
    return { status: 'ok', uptimeS: Math.round(process.uptime()) };
  }

  @Public()
  @SkipThrottle()
  @Get('ready')
  @ApiOperation({ summary: 'El servicio puede atender tráfico (la base de datos responde)' })
  async listo() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
  }
}
