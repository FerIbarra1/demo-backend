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
    const res = await this.call<UploadResponse>(
      'POST',
      '/api/sync/agent/upload',
      {
        data: batch,
        headers: { 'X-Sucursal-Id': String(batch.tiendaId) },
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

export interface UploadResponse {
  procesados: number;
  errores: number;
  checkpointAvanzado: boolean;
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
