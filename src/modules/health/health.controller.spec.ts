import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('/health responde sin tocar la base de datos', () => {
    const prisma = { $queryRaw: jest.fn() };
    const r = new HealthController(prisma as never).vivo();
    expect(r.status).toBe('ok');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('/health/ready consulta la BD y responde ok', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    await expect(new HealthController(prisma as never).listo()).resolves.toEqual({
      status: 'ok',
      db: 'ok',
    });
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('/health/ready da 503 si la BD no responde (el balanceador no debe mandar tráfico)', async () => {
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error('conexión rechazada')) };
    await expect(new HealthController(prisma as never).listo()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
