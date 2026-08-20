import { SetMetadata } from '@nestjs/common';

export const IS_API_KEY_AUTH_KEY = 'isApiKeyAuth';
/**
 * Marca un endpoint como accesible vía API key (header `X-Agent-Key`)
 * para integraciones externas (ej. agente que sincroniza con Firebird).
 * Aplicar `@UseGuards(ApiKeyGuard)` a nivel de controller/method además.
 */
export const ApiKeyAuth = () => SetMetadata(IS_API_KEY_AUTH_KEY, true);
