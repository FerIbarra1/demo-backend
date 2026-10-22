import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  construirInstrucciones,
  type CuentaSnapshot,
  type InstruccionesTransferencia,
} from './instrucciones.util';
import { esFolioErp, formatearFolio } from '../../pedidos/core/folio-erp.util';

/** Lo que el módulo de pagos necesita saber de un pedido. */
export const PEDIDO_PARA_PAGO = {
  id: true,
  numeroPedido: true,
  // Oct 2026 (B2): el folio del Sistema Comercial y la serie de su tienda: es el ID que ve el cliente y la caja.
  folioErp: true,
  estado: true,
  modoEntrega: true,
  total: true,
  usuarioId: true,
  tiendaId: true,
  clienteNombre: true,
  clienteEmail: true,
  clienteTelefono: true,
  metodoPagoPreferido: true,
  pendienteEnvio: { select: { externalFolio: true } },
  tienda: { select: { serie: true } },
} satisfies Prisma.PedidoSelect;

// `tienda` es OPCIONAL en el tipo: quien arma un pedido para pagos a mano (o con otro `select`) no tiene por qué traer la
// serie; sin ella el folio se muestra solo ("0000152573"), que es también lo que entiende el Sistema Comercial.
export type PedidoParaPago = Omit<
  Prisma.PedidoGetPayload<{ select: typeof PEDIDO_PARA_PAGO }>,
  'tienda'
> & { tienda?: { serie?: string | null; [otro: string]: unknown } | null };

/**
 * El folio que ve el cliente: el del Sistema Comercial con la serie de su tienda (`HMO-0000152573`) en cuanto existe; antes,
 * el que dejó la bandeja de envío, y si no el número interno.
 */
export function folioDe(
  p: Pick<PedidoParaPago, 'numeroPedido' | 'pendienteEnvio'> &
    Partial<Pick<PedidoParaPago, 'folioErp' | 'tienda'>>,
): string {
  if (p.folioErp) return formatearFolio(p.tienda?.serie, p.folioErp);
  // Un folio de bandeja que no sea de 10 dígitos (el "PD-2026-00" del agente anterior) no es un folio: se cae al número.
  const deBandeja = p.pendienteEnvio?.externalFolio;
  return esFolioErp(deBandeja) ? deBandeja : p.numeroPedido;
}

/**
 * Bloquea la fila del pedido hasta el fin de la transacción.
 *
 * Emitir instrucciones, aprobar y cancelar el pedido tocan al mismo tiempo el pedido y su pago.
 * Sin esto, un pago podía nacer o verificarse JUSTO después de que el pedido se canceló (el hook
 * de cancelación ya había mirado y no vio nada). Con el bloqueo se serializan: o la cancelación
 * ve el pago, o el pago ve la cancelación.
 */
export async function bloquearPedido(
  tx: Prisma.TransactionClient | PrismaClient,
  pedidoId: number,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM pedidos WHERE id = ${pedidoId} FOR UPDATE`;
}

/** Pesos con a lo más 2 decimales y mayores que cero → Decimal exacto (nunca flotantes en BD). */
export function aDecimal(valor: number, campo: string): Prisma.Decimal {
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new BadRequestException(`${campo} debe ser mayor que cero`);
  }
  return new Prisma.Decimal(valor.toFixed(2));
}

/** "mban 0100-2610" → "MBAN01002610" (null si viene vacía). */
export function claveRastreoNormalizada(raw?: string | null): string | null {
  const limpia = (raw ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (!limpia) return null;
  if (!/^[A-Z0-9]{5,40}$/.test(limpia)) {
    throw new BadRequestException('La clave de rastreo debe tener de 5 a 40 letras o números');
  }
  return limpia;
}

/** Fecha de un abono: ni en el futuro ni de hace más de 45 días. */
export function fechaDeAbono(iso: string, ahora = new Date()): Date {
  const f = new Date(iso);
  if (Number.isNaN(f.getTime())) throw new BadRequestException('abonoFecha no es una fecha válida');
  if (f.getTime() > ahora.getTime() + 5 * 60_000) {
    throw new BadRequestException('La fecha del abono no puede estar en el futuro');
  }
  if (f.getTime() < ahora.getTime() - 45 * 86_400_000) {
    throw new BadRequestException('La fecha del abono es de hace más de 45 días: revisa el dato');
  }
  return f;
}

export function enmascararEmail(email: string): string {
  const [usuario, dominio] = email.split('@');
  if (!dominio) return '***';
  return `${usuario.slice(0, 2)}***@${dominio}`;
}

export interface ConfigPagos {
  frontendUrl: string;
}

/** Las instrucciones de un pago ya emitido, reconstruidas desde su SNAPSHOT. */
export function instruccionesDeUnPago(
  pago: {
    montoEsperado: Prisma.Decimal;
    cuentaSnapshot: Prisma.JsonValue;
    referencia: string;
    concepto: string;
  },
  pedido: PedidoParaPago,
  cfg: ConfigPagos,
): InstruccionesTransferencia {
  return construirInstrucciones({
    folio: folioDe(pedido),
    monto: pago.montoEsperado,
    cuenta: pago.cuentaSnapshot as unknown as CuentaSnapshot,
    referencia: pago.referencia,
    concepto: pago.concepto,
    pedidoUrl: `${cfg.frontendUrl}/pedidos/${pedido.id}`,
  });
}

export function lineasParaCorreo(i: InstruccionesTransferencia) {
  return i.lineas.map((l) => ({ etiqueta: l.etiqueta, mostrar: l.mostrar ?? l.valor }));
}
