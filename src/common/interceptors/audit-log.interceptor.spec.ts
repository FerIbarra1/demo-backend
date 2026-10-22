import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { AuditLogInterceptor } from './audit-log.interceptor';

/**
 * Oct 2026: el agente de Firebird (ApiKeyGuard, `userId` 0) no es un `Usuario`. Auditar sus peticiones fallaba por la
 * llave foránea en CADA heartbeat y, de funcionar, habría guardado cada lote de filas de clientes en `log_actividades`.
 */
describe('AuditLogInterceptor', () => {
  const crear = jest.fn().mockResolvedValue({});
  const interceptor = new AuditLogInterceptor({ logActividad: { create: crear } } as never);

  const correr = async (req: object) => {
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of('ok') };
    await lastValueFrom(interceptor.intercept(ctx, next));
    // `registrar` corre sin esperar: se deja pasar un turno del bucle de eventos.
    await new Promise((r) => setImmediate(r));
  };
  const base = (over: object) => ({
    method: 'POST',
    originalUrl: '/api/pedidos/5/destrabar/X',
    headers: {},
    socket: { remoteAddress: '1.1.1.1' },
    body: { a: 1 },
    params: {},
    query: {},
    ...over,
  });

  beforeEach(() => crear.mockClear());

  it('NO audita las rutas del agente (heartbeat, upload, ack): ni la FK ni el cuerpo con filas de clientes', async () => {
    for (const url of [
      '/api/sync/agent/heartbeat',
      '/api/sync/agent/upload',
      '/api/sync/agent/pedidos-ack',
    ]) {
      await correr(base({ originalUrl: url, user: { userId: 0, nombre: 'AGENT_EXTERNAL' } }));
    }
    expect(crear).not.toHaveBeenCalled();
  });

  it('el sistema (userId 0) en otra ruta se audita SIN usuario, no con un id que la FK rechaza', async () => {
    await correr(
      base({
        originalUrl: '/api/admin/pedidos/5/marcar-pagado',
        user: { userId: 0, nombre: 'AGENT_EXTERNAL' },
      }),
    );
    expect(crear).toHaveBeenCalledTimes(1);
    expect(crear.mock.calls[0][0].data.usuarioId).toBeUndefined();
  });

  it('un usuario normal se audita con su id; una lectura (GET) no se audita', async () => {
    await correr(base({ user: { userId: 7, nombre: 'Ana' } }));
    expect(crear.mock.calls[0][0].data.usuarioId).toBe(7);
    crear.mockClear();
    await correr(base({ method: 'GET', user: { userId: 7, nombre: 'Ana' } }));
    expect(crear).not.toHaveBeenCalled();
  });
});
