import axios, { AxiosInstance, AxiosError } from 'axios';
import type { CloudConfig } from './config';
import { Logger } from './logger-types';

/**
 * Cliente HTTP a la nube. Centraliza:
 *   - Headers de autenticación: X-Agent-Key + X-Sucursal-Id.
 *   - Backoff exponencial para errores transitorios (5xx, timeout, ECONNRESET).
 *   - Throws tipados: AuthError (401/403 → no reintentar) vs TransientError.
 */
export class CloudClient {
  private http: AxiosInstance;
  private readonly agentId =
    process.env.AGENT_ID ?? process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'playerytees-agent';

  constructor(private cfg: CloudConfig, private log: Logger) {
    this.http = axios.create({
      baseURL: cfg.baseUrl,
      timeout: cfg.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': cfg.agentKey,
        'User-Agent': 'playerytees-sync-agent/1.0.0',
      },
    });
  }

  getAgentId(): string {
    return this.agentId;
  }

  /**
   * GET /api/sync/agent/poll-pedidos?sucursalId=X&limit=Y
   * Devuelve la cola de pedidos pendientes para la tienda indicada.
   */
  async pollPedidos(
    sucursalIdNube: number,
    limit = 20,
  ): Promise<PedidoCloud[]> {
    const res = await this.call<{ tiendaId: number; pedidos: PedidoCloud[] }>(
      'GET',
      '/api/sync/agent/poll-pedidos',
      {
        params: { limit },
        headers: {
          'X-Sucursal-Id': String(sucursalIdNube),
          'X-Agent-Id': this.agentId,
        },
      },
    );
    return res.data.pedidos ?? [];
  }

  /**
   * POST /api/sync/agent/upload
   * Sube un batch de cambios desde BANDEJA_SYNC. El servidor avanza el
   * checkpoint sólo si la respuesta es 2xx y todos los eventos OK.
   */
  async upload(batch: UploadBatch): Promise<UploadResponse> {
    // Se probó contra el backend real (oct 2026) y el upload NUNCA llegaba:
    //  1. El agente le pegaba a cada evento su `_bandejaId` (marca interna del ciclo de subida) y el backend, con
    //     `forbidNonWhitelisted`, contestaba 400 a TODO lote de BANDEJA_SYNC. Aquí se quita cualquier llave que
    //     empiece con `_`: este es el único punto por el que sale un evento (también el outbox).
    //  2. Un lote de 200 filas completas pesa más de 100 kb (el límite del cuerpo JSON del servidor): 413 en el
    //     bootstrap del catálogo. Se parte por TAMAÑO, no solo por número de eventos.
    const eventos = batch.eventos.map((ev) => limpiarEvento(ev));
    const trozos = partirPorTamano(eventos, MAX_BYTES_POR_POST);

    const total: UploadResponse = { procesados: 0, errores: 0, checkpointAvanzado: true, deadLetters: 0, fallidos: [] };
    for (let i = 0; i < trozos.length; i++) {
      const trozo = trozos[i];
      const ultimo = i === trozos.length - 1;
      const res = await this.call<UploadResponse>(
        'POST',
        '/api/sync/agent/upload',
        {
          // El servidor avanza SU checkpoint hasta `hastaBANDEJAId` al terminar el trozo: solo el último lleva el
          // del lote completo; los demás, hasta donde llegaron.
          data: {
            ...batch,
            hastaBANDEJAId: ultimo ? batch.hastaBANDEJAId : maximoBandeja(trozo, batch.hastaBANDEJAId),
            eventos: trozo,
          },
          headers: { 'X-Sucursal-Id': String(batch.tiendaId) },
        },
      );
      total.procesados += res.data.procesados ?? 0;
      total.errores += res.data.errores ?? 0;
      total.deadLetters = (total.deadLetters ?? 0) + (res.data.deadLetters ?? 0);
      total.fallidos = (total.fallidos ?? []).concat(res.data.fallidos ?? []);
      total.checkpointAvanzado = total.checkpointAvanzado && res.data.checkpointAvanzado === true;
    }
    return total;
  }

  /**
   * GET /api/sync/agent/poll-folios
   * Las solicitudes de FOLIO de la tienda: pedidos cuyo surtido bodega cerró y que necesitan su número del Sistema
   * Comercial (para el ticket y el QR). La nube no puede llamar al agente: aquí se las entrega.
   */
  async pollFolios(sucursalIdNube: number, limit = 20): Promise<SolicitudFolio[]> {
    const res = await this.call<{ tiendaId: number; solicitudes: SolicitudFolio[] }>(
      'GET',
      '/api/sync/agent/poll-folios',
      {
        params: { limit },
        headers: { 'X-Sucursal-Id': String(sucursalIdNube), 'X-Agent-Id': this.agentId },
      },
    );
    return res.data.solicitudes ?? [];
  }

  /**
   * POST /api/sync/agent/folios-ack
   * Los consecutivos que el agente reservó (o por qué no pudo).
   */
  async foliosAck(
    tiendaIdNube: number,
    acks: FolioAck[],
  ): Promise<{ actualizados: number; errores: number }> {
    const res = await this.call<{ actualizados: number; errores: number }>(
      'POST',
      '/api/sync/agent/folios-ack',
      {
        data: { tiendaId: tiendaIdNube, acks },
        headers: { 'X-Sucursal-Id': String(tiendaIdNube) },
      },
    );
    return res.data;
  }

  /**
   * POST /api/sync/agent/pedidos-ack
   * Confirma cuáles pedidos se subieron OK a Firebird y cuáles fallaron.
   */
  async pedidosAck(
    tiendaIdNube: number,
    acks: AckItem[],
  ): Promise<{ actualizados: number; errores: number }> {
    const res = await this.call<{ actualizados: number; errores: number }>(
      'POST',
      '/api/sync/agent/pedidos-ack',
      {
        data: { tiendaId: tiendaIdNube, acks },
        headers: { 'X-Sucursal-Id': String(tiendaIdNube) },
      },
    );
    return res.data;
  }

  /**
   * GET /api/sync/agent/conciliacion?limit=N&despues=ID
   * Los pedidos de la tienda que ya viven en el Sistema Comercial y cuyo estado conviene verificar (paginado).
   */
  async conciliacionPendientes(
    sucursalIdNube: number,
    limit = 200,
    despues = 0,
  ): Promise<ConciliacionPendientes> {
    const res = await this.call<ConciliacionPendientes>('GET', '/api/sync/agent/conciliacion', {
      params: { limit, despues },
      headers: { 'X-Sucursal-Id': String(sucursalIdNube) },
    });
    return res.data;
  }

  /**
   * POST /api/sync/agent/conciliacion
   * El estado REAL (SWCANCEL, FINALIZADA, TTOTAL) de esos pedidos en Firebird. La nube compara y corrige.
   */
  async conciliar(batch: ConciliacionBatch): Promise<ConciliacionResultado> {
    const res = await this.call<ConciliacionResultado>('POST', '/api/sync/agent/conciliacion', {
      data: batch,
      headers: { 'X-Sucursal-Id': String(batch.tiendaId) },
    });
    return res.data;
  }

  /**
   * POST /api/sync/agent/heartbeat
   * Reporta liveness. Llamar cada 30-60s para mantener actualizado el
   * SyncCheckpoint.ultimoHeartbeatAt (la UI admin lo usa para alertar).
   */
  async heartbeat(sucursalIdNube: number, agentVersion: string, hostname?: string) {
    const res = await this.call<{ serverTime: string; config: any }>(
      'POST',
      '/api/sync/agent/heartbeat',
      {
        data: { agentVersion, hostname },
        headers: { 'X-Sucursal-Id': String(sucursalIdNube) },
      },
    );
    return res.data;
  }

  private async call<T>(method: string, url: string, opts: { params?: any; data?: any; headers?: any }): Promise<{ data: T; status: number }> {
    try {
      const res = await this.http.request<T>({
        method,
        url,
        params: opts.params,
        data: opts.data,
        headers: opts.headers,
      });
      return { data: res.data, status: res.status };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 401 || status === 403) {
          throw new AuthError(`Auth rejected (${status}): ${err.response?.data?.message ?? ''}`, status);
        }
        if (status && status >= 500) {
          throw new TransientError(`Server ${status}: ${err.message}`);
        }
        if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
          throw new TransientError(`Network ${err.code}: ${err.message}`);
        }
      }
      throw err;
    }
  }
}

/**
 * Tope de un POST de subida. El cuerpo JSON por defecto del servidor es de 100 kb: se deja holgura para el sobre
 * (`tiendaId`, `hastaBANDEJAId`) y los caracteres que se escapan al serializar.
 */
export const MAX_BYTES_POR_POST = 80_000;

/** Quita las llaves internas del agente (`_bandejaId`…): el servidor rechaza todo campo que no conoce. */
function limpiarEvento(ev: UploadEvent): UploadEvent {
  return Object.fromEntries(Object.entries(ev).filter(([k]) => !k.startsWith('_'))) as unknown as UploadEvent;
}

/** Reparte los eventos en lotes que, serializados, no pasen de `maxBytes`. Un evento solo nunca se parte. */
export function partirPorTamano(eventos: UploadEvent[], maxBytes: number): UploadEvent[][] {
  if (eventos.length === 0) return [[]];
  const trozos: UploadEvent[][] = [];
  let actual: UploadEvent[] = [];
  let bytes = 0;
  for (const ev of eventos) {
    const n = Buffer.byteLength(JSON.stringify(ev), 'utf8') + 1;
    if (actual.length > 0 && bytes + n > maxBytes) {
      trozos.push(actual);
      actual = [];
      bytes = 0;
    }
    actual.push(ev);
    bytes += n;
  }
  if (actual.length > 0) trozos.push(actual);
  return trozos;
}

function maximoBandeja(eventos: UploadEvent[], porDefecto: number): number {
  const ids = eventos.map((e) => e.bandejaId).filter((n) => Number.isFinite(n));
  return ids.length ? Math.max(...ids) : porDefecto;
}

export class AuthError extends Error {
  constructor(msg: string, public status: number) {
    super(msg);
    this.name = 'AuthError';
  }
}

export class TransientError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TransientError';
  }
}

// ---------------- tipos compartidos ----------------

export interface PedidoCloud {
  pedidoId: number;
  tiendaId: number;
  leaseToken: string;
  leaseUntil: string;
  externalIdPEDIDOS: number | null;
  numeroPedido: string;
  /** Oct 2026 (parte B): el folio REAL que la nube ya tiene para el pedido; null = se toma uno al grabarlo. */
  folio?: string | null;
  fechaPedido: string;
  clienteNombre: string;
  clienteEmail: string;
  clienteTelefono: string | null;
  shippingDireccion: string | null;
  shippingColonia: string | null;
  shippingCodigoPostal: string | null;
  shippingPaqueteria: string | null;
  notas: string | null;
  subtotal: number;
  total: number;
  estado: string;
  modoEntrega: string;
  items: PedidoItemCloud[];
}

export interface PedidoItemCloud {
  itemId: number;
  productoCodigo: string;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
  talla: string;
  corridaNombre: string;
  colorNombre: string;
  localPrecioCOId: number | null;
  localProductoId: number | null;
  localCorridaId: number | null;
  localColorId: number | null;
  skip: boolean;
}

export interface UploadBatch {
  tiendaId: number;
  hastaBANDEJAId: number;
  eventos: UploadEvent[];
}

export interface UploadEvent {
  eventId: string;
  bandejaId: number;
  tipo: 'CATALOGO' | 'CLIENTE' | 'PEDIDO' | 'PAGO';
  operacion: 'I' | 'U' | 'D';
  entidad: string; // PRODUCTOS, PRECIOS, PRECIOSCO, CLIENTES, PEDIDOS, etc.
  localId: number;
  localTiendaId?: number;
  datos: Record<string, unknown>;
}

export interface ConciliacionPendientes {
  tiendaId: number;
  pedidos: Array<{ pedidoId: number; externalIdPEDIDOS: number }>;
  /** Cursor para la página siguiente (`despues`), o null si ya no hay más. */
  siguiente: number | null;
}

export interface ConciliacionItem {
  externalIdPEDIDOS: number;
  /** false = el Sistema Comercial ya no tiene esa fila. */
  existe: boolean;
  swcancel: boolean;
  finalizada: boolean;
  total: number | null;
  idfactura: number | null;
}

export interface ConciliacionBatch {
  tiendaId: number;
  pedidos: ConciliacionItem[];
}

export interface ConciliacionResultado {
  revisados: number;
  desconocidos: number;
  curados: number;
  hallazgosAbiertos: number;
  tareasCerradas: number;
}

export interface UploadResponse {
  procesados: number;
  errores: number;
  checkpointAvanzado: boolean;
  /** Eventos que el servidor dio por perdidos tras 5 intentos (no bloquean el checkpoint). */
  deadLetters?: number;
  /** `eventId` de los que fallaron y la nube va a reintentar: el agente los guarda en su outbox. */
  fallidos?: string[];
}

export interface AckItem {
  pedidoId: number;
  agentId: string;
  leaseToken: string;
  externalIdPEDIDOS?: number;
  externalFolio?: string;
  exito: boolean;
  error?: string;
}

/** Oct 2026 (parte B): un pedido que espera su folio del Sistema Comercial. */
export interface SolicitudFolio {
  pedidoId: number;
  numeroPedido: string;
  leaseToken: string;
  leaseUntil: string;
}

export interface FolioAck {
  pedidoId: number;
  agentId: string;
  exito: boolean;
  /** El consecutivo reservado (10 dígitos). Obligatorio si `exito`. */
  folio?: string;
  error?: string;
}
