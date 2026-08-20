import * as fs from 'fs';
import * as path from 'path';

export interface CloudConfig {
  baseUrl: string;
  agentKey: string;
  sucursalIds: number[];
  timeoutMs: number;
}

export interface FirebirdConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  charset: string;
  poolSize: number;
}

export interface SyncConfig {
  pollIntervalMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  batchSize: number;
  checkpointBatch: number;
  queueRetentionDays: number;
  expirationHours: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface ServiceConfig {
  name: string;
  description: string;
}

export interface AgentConfig {
  cloud: CloudConfig;
  firebird: FirebirdConfig;
  sync: SyncConfig;
  service: ServiceConfig;
}

/**
 * Carga agent.config.json desde el directorio del binario (o cwd).
 * Si no existe, loguea y aborta con instrucciones claras.
 */
export function loadConfig(): AgentConfig {
  const candidates = [
    process.env.AGENT_CONFIG_PATH,
    path.join(process.cwd(), 'agent.config.json'),
    path.join(path.dirname(process.execPath), 'agent.config.json'),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as AgentConfig;
      validateConfig(parsed);
      return parsed;
    }
  }

  throw new Error(
    `No se encontro agent.config.json. Probé:\n  - ${candidates.join('\n  - ')}\n` +
    `Copia agent.config.example.json a agent.config.json y rellena los valores.`,
  );
}

function validateConfig(cfg: AgentConfig): void {
  if (!cfg.cloud?.baseUrl || !cfg.cloud?.agentKey) {
    throw new Error('cloud.baseUrl y cloud.agentKey son obligatorios');
  }
  if (!cfg.cloud.sucursalIds?.length) {
    throw new Error('cloud.sucursalIds no puede estar vacío');
  }
  if (!cfg.firebird?.database) {
    throw new Error('firebird.database es obligatorio');
  }
}
