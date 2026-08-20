import type { FirebirdClient } from './firebird-client';
import type { UploadEvent } from './cloud-client';

/**
 * Resuelve el IDTIENDA de Firebird para cada entidad.
 *
 * Como la BD Firebird centralizada diferencia las tiendas por la columna
 * IDTIENDA, este helper deduce el IDTIENDA de cada evento de BANDEJA_SYNC.
 *
 * Reglas (basadas en el schema real de DATOSINV.FDB):
 *   - PRECIOS, PRECIOSCO, PEDIDOS, MOVPED, VENDEDORES
 *     → tienen columna IDTIENDA directa en el registro.
 *   - PRODUCTOS, CORRIDAS, CORRIDASREN, COLORES, LINEAS, SUBLINEAS
 *     → entidades GLOBALES. No tienen tienda. Devuelve null (se sincronizan
 *       una sola vez por toda la red de tiendas).
 *   - CLIENTES, CLIENTESCXC
 *     → no tienen IDTIENDA directamente. Hay que joinear con
 *       CLITIEN / CLITIENCXC. Si el cliente no está dado de alta en
 *       ninguna tienda, se ignora (no aplica para sincronización nube).
 *
 * El resolver ANTES del upload es importante porque el backend nube
 * (PostgreSQL) requiere `localTiendaId` para resolver `Tienda.id`
 * (cada Tienda tiene su `externalId` único). Sin este dato, no se
 * puede mapear el precio ni el pedido a una tienda nube.
 */
export class TiendaResolver {
  constructor(private fb: FirebirdClient) {}

  /**
   * Devuelve el IDTIENDA para un evento, o null si es global / no aplica.
   * Hace UNA query a Firebird (cheapest possible) si la entidad lo requiere.
   */
  async resolver(evento: UploadEvent): Promise<number | null> {
    switch (evento.entidad) {
      case 'PRECIOS':
      case 'PRECIOSCO':
      case 'PEDIDOS':
      case 'MOVPED':
      case 'VENDEDORES':
        // La columna IDTIENDA viene en `datos` (el agente la carga al
        // sondear BANDEJA_SYNC). Si no está, es un bug del agente.
        return (evento.datos as any).IDTIENDA ?? null;

      case 'CLITIEN':
      case 'CLITIENCXC':
        return (evento.datos as any).IDTIENDA ?? null;

      case 'PRODUCTOS':
      case 'CORRIDAS':
      case 'CORRIDASREN':
      case 'COLORES':
      case 'LINEAS':
      case 'SUBLINEAS':
        // Globales — sin tienda. Nube los sincroniza una sola vez.
        return null;

      case 'CLIENTES':
      case 'CLIENTESCXC': {
        // No tienen IDTIENDA directo. Joinear con CLITIEN/CLITIENCXC.
        // Si el cliente está en varias tiendas, se emite UN evento
        // por tienda (el bucle principal del up-processor hace fan-out).
        const tabla = evento.entidad === 'CLIENTES' ? 'CLITIEN' : 'CLITIENCXC';
        const idCampo = 'IDCLIENTE';
        const rows = await this.fb.query<{ IDTIENDA: number }>(
          `SELECT IDTIENDA FROM ${tabla} WHERE ${idCampo} = ?`,
          [evento.localId],
        );
        return rows[0]?.IDTIENDA ?? null;
      }

      default:
        return null;
    }
  }
}
