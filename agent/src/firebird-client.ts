// node-firebird v2.x es CommonJS puro: NO tiene `default` export. Si
// usamos `import Firebird from 'node-firebird'` con esModuleInterop,
// TypeScript genera `node_firebird_1.default.pool(...)` y truena en
// runtime porque `default` es undefined. Hay que importar el namespace.
import * as Firebird from 'node-firebird';
import type {
  ConnectionPool,
  Database,
  Options,
  SupportedCharacterSet,
  Transaction,
} from 'node-firebird';
import type { FirebirdConfig } from './config';

/**
 * Cliente Firebird basado en node-firebird v2.x (API con promesas nativas).
 *
 * Cambios vs v0.x:
 *   - Antes: cada query envolvía un callback manual, y manteníamos un
 *     pool casero con colas (acquire/release). Mucho código frágil.
 *   - Ahora: Firebird.pool(max, opts) hace eso por nosotros, y db
 *     expone queryAsync() / withTransaction() / detachAsync().
 *
 * Por qué un pool y no una sola conexión global:
 *   Firebird permite múltiples statements simultáneos sobre una misma
 *   conexión (algo así como "multi-statement"), pero cuando una query
 *   tira un error o se hace rollback en mitad de una transacción,
 *   queda en estado inconsistente hasta cerrar. Con pool de N (default
 *   4), si una conexión se "ensucia", simplemente la cerramos y las
 *   demás siguen sirviendo.
 *
 * Requisito de runtime: fbclient.dll (Firebird Client) debe estar
 * instalado en la máquina donde corre el agente. Como el agente corre
 * en el servidor central de Firebird, ya está ahí.
 *
 * Charset:
 *   La BD original se creó con WIN1252 / ISO8859_1 (caracteres latinos
 *   con acentos). Si cfg.charset está configurado, lo respetamos; si
 *   no, usamos UTF-8 (default del driver v2.x).
 */

const SUPPORTED_CHARSETS: readonly SupportedCharacterSet[] = [
  'NONE', 'CP943C', 'DOS737', 'DOS775', 'DOS858', 'DOS862', 'DOS864',
  'DOS866', 'DOS869', 'GB18030', 'GBK', 'ISO8859_1', 'ISO8859_2',
  'ISO8859_3', 'ISO8859_4', 'ISO8859_5', 'ISO8859_6', 'ISO8859_7',
  'ISO8859_8', 'ISO8859_9', 'ISO8859_13', 'KOI8R', 'KOI8U', 'TIS620',
  'UTF8', 'WIN1251', 'WIN1252', 'WIN1253', 'WIN1254', 'WIN1255',
  'WIN1256', 'WIN1257', 'WIN1258',
];

export interface TxClient {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  callScalar<T = any>(sql: string, params?: any[]): Promise<T | null>;
}

export class FirebirdClient {
  private pool: ConnectionPool;

  constructor(private cfg: FirebirdConfig) {
    const options: Options = {
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
    };

    // Solo pasamos `encoding` si el charset configurado es soportado
    // por el driver. Si alguien puso "WIN-1252" (con guion) en config,
    // caemos al default UTF-8 silenciosamente.
    if (cfg.charset) {
      const upper = cfg.charset.toUpperCase().replace(/-/g, '') as SupportedCharacterSet;
      if (SUPPORTED_CHARSETS.includes(upper)) {
        options.encoding = upper;
      }
    }

    this.pool = Firebird.pool(cfg.poolSize, options);
  }

  /**
   * Verifica que el pool puede abrir al menos una conexión. Llamar
   * una sola vez al arrancar; si falla, no tiene sentido seguir.
   */
  async init(): Promise<void> {
    await this.withConnection(async () => {
      // Pool listo — la conexión se devuelve automáticamente.
    });
  }

  async close(): Promise<void> {
    await this.pool.destroyAsync();
  }

  /**
   * Obtiene una conexión del pool, ejecuta `work(db)` y la devuelve.
   * Equivalente a acquire/release manual, pero sin fugas posibles.
   *
   * `work` recibe una `Database` con todos los métodos disponibles
   * (queryAsync, executeAsync, withTransaction, etc.).
   */
  async withConnection<T>(work: (db: Database) => Promise<T> | T): Promise<T> {
    return await this.pool.withConnection(async (db) => {
      try {
        return await work(db);
      } finally {
        // withConnection devuelve la conexión al pool, pero NO la cierra.
        // Si la conexión quedó en mal estado (transacción huérfana,
        // error no recuperado), detachAsync la cierra y el pool abrirá
        // una nueva la próxima vez.
        try {
          await db.detachAsync();
        } catch {
          /* ignorar */
        }
      }
    });
  }

  /**
   * Query simple (SELECT o DML sin transacción explícita). Cada llamada
   * corre dentro de su propia transacción implícita de Firebird que se
   * auto-confirma al terminar.
   */
  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return await this.withConnection(async (db) => {
      return (await db.queryAsync(sql, params)) as T[];
    });
  }

  /**
   * Igual que query() pero devuelve solo la primera fila (o null).
   * Útil para SPs que retornan un escalar (GRABAR_PEDIDOS devuelve
   * un row con PEDIDO_ID, PEDIDO_FOLIO, CMENSAJEERROR).
   */
  async callScalar<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  /**
   * Ejecuta `work(txClient)` dentro de una transacción Firebird real.
   * Garantiza commit si work resuelve OK, o rollback si lanza.
   * La conexión vuelve al pool al terminar.
   *
   * `work` recibe un TxClient (no la Database cruda) porque dentro de
   * una transacción no se pueden abrir nuevas transacciones ni detach.
   * El TxClient expone solo `query` y `callScalar` que ejecutan sobre
   * el `Transaction` de Firebird (mismas reglas que el viejo
   * `tx.query(sql, params, cb)`).
   */
  async transaction<T>(work: (tx: TxClient) => Promise<T>): Promise<T> {
    return await this.withConnection(async (db) => {
      // withTransaction maneja commit/rollback automático basado en si
      // el callback resuelve o rechaza. Si rechaza, rollback; si no,
      // commit. Mucho más simple que el viejo conn.transaction + tx.commit.
      return await db.withTransaction(async (tx: Transaction) => {
        const txClient: TxClient = {
          query: <U = any>(sql: string, params: any[] = []) =>
            tx.queryAsync(sql, params) as Promise<U[]>,
          callScalar: async <U = any>(
            sql: string,
            params: any[] = [],
          ): Promise<U | null> => {
            const rows = await tx.queryAsync(sql, params);
            return (rows[0] as U) ?? null;
          },
        };
        return await work(txClient);
      });
    });
  }
}