/**
 * Tipo compartido para el logger del agente.
 * Compatible con la interfaz de pino.
 */
export interface Logger {
  debug(obj: any, msg?: string): void;
  info(obj: any, msg?: string): void;
  warn(obj: any, msg?: string): void;
  error(obj: any, msg?: string): void;
  fatal(obj: any, msg?: string): void;
  child(bindings: any): Logger;
}
