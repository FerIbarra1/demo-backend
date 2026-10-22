import 'reflect-metadata';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Module,
} from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AddressInfo } from 'net';
import { AppModule } from '../../app.module';
import { UserThrottlerGuard } from './user-throttler.guard';

/**
 * Oct 2026: el tope de peticiones es POR PERSONA con sesión y por IP sin ella.
 *
 * Se levanta un Nest real (el `ThrottlerModule` y el guard de verdad, con el tope en 3 para no hacer 300 llamadas)
 * y se mira lo que un mock no puede: que dos usuarios que salen por la MISMA IP no se descuenten entre sí, que los
 * anónimos sí compartan, y que una cabecera que escribe el cliente no cambie de cubo a nadie.
 *
 * `FalsoJwt` hace el papel de `JwtAuthGuard`: corre primero y puebla `req.user` (con la forma real: `userId`).
 */
class FalsoJwt implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers['x-test-user'];
    if (id) req.user = { userId: Number(id) };
    return true;
  }
}

@Controller('ping')
class PingController {
  @Get()
  general() {
    return { ok: true };
  }

  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @Get('estricto')
  estricto() {
    return { ok: true };
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 3 }])],
  controllers: [PingController],
  providers: [
    { provide: APP_GUARD, useClass: FalsoJwt },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
})
class ModuloDePrueba {}

describe('UserThrottlerGuard', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create(ModuloDePrueba, { logger: false });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => app.close());

  const pegar = async (ruta: string, cabeceras: Record<string, string> = {}) =>
    (await fetch(base + ruta, { headers: cabeceras })).status;
  const rafaga = async (n: number, ruta: string, cabeceras: Record<string, string> = {}) => {
    const r: number[] = [];
    for (let i = 0; i < n; i++) r.push(await pegar(ruta, cabeceras));
    return r;
  };

  it('dos usuarios con sesión tras la MISMA IP no se descuentan entre sí', async () => {
    expect(await rafaga(4, '/ping', { 'x-test-user': '101' })).toEqual([200, 200, 200, 429]);
    // Mismo socket, misma IP: el usuario 102 conserva su cubo completo.
    expect(await rafaga(4, '/ping', { 'x-test-user': '102' })).toEqual([200, 200, 200, 429]);
  });

  it('los anónimos tras una misma IP comparten cubo (no hay otra cosa que contar)', async () => {
    expect(await rafaga(4, '/ping')).toEqual([200, 200, 200, 429]);
  });

  it('el cubo anónimo agotado NO le quita nada a quien tiene sesión', async () => {
    expect(await pegar('/ping', { 'x-test-user': '103' })).toBe(200);
  });

  it('una cabecera que escribe el cliente no cambia de cubo (no se puede esquivar el tope rotándola)', async () => {
    // Ruta propia (tope 2) para no depender de lo que gastaron los otros tests. Se agota como anónimo y después se
    // rota cada cabecera que el cliente controla: X-Kiosko-Id / X-Tienda-Id / X-Forwarded-For no lo liberan.
    expect(await rafaga(2, '/ping/estricto')).toEqual([200, 200]);
    const r: number[] = [];
    for (const n of ['1', '2', '3']) {
      r.push(
        await pegar('/ping/estricto', {
          'x-kiosko-id': n,
          'x-tienda-id': n,
          'x-forwarded-for': `10.0.0.${n}`,
        }),
      );
    }
    expect(r).toEqual([429, 429, 429]);
  });

  it('un @Throttle propio de la ruta también cuenta por usuario', async () => {
    expect(await rafaga(3, '/ping/estricto', { 'x-test-user': '201' })).toEqual([200, 200, 429]);
    expect(await rafaga(3, '/ping/estricto', { 'x-test-user': '202' })).toEqual([200, 200, 429]);
  });
});

describe('cableado en AppModule', () => {
  it('el guard global de peticiones es UserThrottlerGuard, no el ThrottlerGuard de fábrica (que cuenta por IP)', () => {
    const providers: Array<{ provide?: unknown; useClass?: unknown }> =
      Reflect.getMetadata('providers', AppModule) ?? [];
    const guards = providers.filter((p) => p.provide === APP_GUARD).map((p) => p.useClass);

    expect(guards).toContain(UserThrottlerGuard);
    expect(guards).not.toContain(ThrottlerGuard);
  });
});
