import pino from 'pino';
import type { AgentConfig } from './config';

/**
 * Logger pino. Cuando el agente corre como servicio Windows, NO usa
 * pino-pretty (no hay consola). Pretty solo se activa en dev local.
 */
export function createLogger(config: AgentConfig) {
  const isDev = process.env.NODE_ENV !== 'production' && !process.env.SERVICE_MODE;
  return pino({
    level: config.sync.logLevel,
    base: { service: config.service.name, hostname: process.env.COMPUTERNAME },
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        }
      : undefined,
  });
}
