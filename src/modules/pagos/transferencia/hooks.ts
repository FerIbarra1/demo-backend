import { randomInt } from 'crypto';
import {
  EstadoPagoTransferencia as Estado,
  EstadoPedido,
  MetodoPago,
  Prisma,
  PrismaClient,
  RolUsuario,
} from '@prisma/client';
import type { RealtimeService } from '../../realtime/realtime.service';
import { ESTADOS_ACTIVOS, ESTADOS_BLOQUEAN_CANCELACION, transferenciaDisponible } from './reglas';

/**
 * Enganches del pago por transferencia que usan los módulos que YA existían (máquina de estados,
 * cobro de VFP, cancelación del cliente, cajero).
 *
 * Son funciones PURAS sobre un cliente de Prisma, no un servicio de Nest, a propósito:
 *   - `PedidosModule` no puede importar `PagosModule` (el segundo necesita al primero para el
 *     control de acceso): un servicio inyectado aquí sería un ciclo de dependencias.
 *   - Se componen dentro de la transacción del llamador cuando hace falta (`tx`).
 *
 * Contrato: lo que pasa con el DINERO nunca se decide por omisión. Un pago con dinero (o con un
 * comprobante que podría serlo) cuyo pedido se cancela o se cobra en otro lado no se descarta:
 * pasa a reembolso o queda marcado para que Tesorería lo resuelva.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface ActorPago {
  id: number | null;
  /** Un `RolUsuario`, o 'AGENT' / 'SISTEMA' (no son usuarios). */
  rol: string;
  nombre: string;
  ip?: string | null;
}

export const ACTOR_AGENTE: ActorPago = { id: null, rol: 'AGENT', nombre: 'AGENT_EXTERNAL' };
export const ACTOR_SISTEMA: ActorPago = { id: null, rol: 'SISTEMA', nombre: 'SISTEMA' };

/** Lo que cambió, para que quien llama avise a las pantallas DESPUÉS de confirmar. */
export interface CambioPago {
  pagoId: number;
  pedidoId: number;
  tiendaId: number;
  estado: Estado;
  requiereRevision: boolean;
  /** Algo que Tesorería debe ver ya (se emite como `pago.alerta`). */
  alerta?: string;
}

export interface EventoPago {
  tipo: string;
  de?: Estado | null;
  a?: Estado | null;
  actor: ActorPago;
  detalle?: Prisma.InputJsonValue;
}

/** La bitácora es de SOLO AGREGAR: aquí solo existe el `create`. */
export async function registrarEventoPago(db: Db, pagoId: number, e: EventoPago): Promise<void> {
  await db.pagoTransferenciaEvento.create({
    data: {
      pagoId,
      tipo: e.tipo,
      deEstado: e.de ?? null,
      aEstado: e.a ?? null,
      actorId: e.actor.id,
      actorRol: e.actor.rol,
      actorNombre: e.actor.nombre,
      ip: e.actor.ip ?? null,
      detalle: e.detalle ?? Prisma.JsonNull,
    },
  });
}

/** El pago vivo de un pedido (a lo más uno: índice parcial único en la BD). */
export async function pagoActivoDe(db: Db, pedidoId: number) {
  return db.pedidoPagoTransferencia.findFirst({
    where: { pedidoId, estado: { in: [...ESTADOS_ACTIVOS] } },
  });
}

/**
 * ¿Hay una transferencia que impide que el CLIENTE cancele su pedido? Sí si hay un comprobante
 * por revisar (puede haber dinero en camino) o dinero ya verificado.
 */
export async function pagoBloqueaCancelacion(db: Db, pedidoId: number) {
  return db.pedidoPagoTransferencia.findFirst({
    where: { pedidoId, estado: { in: [...ESTADOS_BLOQUEAN_CANCELACION] } },
    select: { id: true, estado: true },
  });
}

/**
 * Oct 2026: el estado del pago que decide si el CLIENTE puede cancelar, de varios pedidos con UNA sola consulta
 * (la lista de «Mis pedidos» pide una página entera). Lo lee `decidirCancelacionDelCliente`.
 *
 * Cuentan los tres que cambian la respuesta: PENDIENTE (dinero posiblemente en camino: el diálogo pregunta «¿ya
 * transferiste?»), EN_REVISION y VERIFICADO (bloquean). A lo más hay UN pago vivo por pedido (índice parcial único);
 * si por algún dato sucio hubiera más de uno, gana el que más protege el dinero.
 */
const PRIORIDAD_PAGO_PARA_CANCELAR: Record<string, number> = {
  [Estado.VERIFICADO]: 3,
  [Estado.EN_REVISION]: 2,
  [Estado.PENDIENTE]: 1,
};

export async function pagosParaCancelar(db: Db, pedidoIds: number[]): Promise<Map<number, Estado>> {
  const mapa = new Map<number, Estado>();
  if (pedidoIds.length === 0) return mapa;
  const pagos = await db.pedidoPagoTransferencia.findMany({
    where: {
      pedidoId: { in: pedidoIds },
      estado: { in: [Estado.PENDIENTE, ...ESTADOS_BLOQUEAN_CANCELACION] },
    },
    select: { pedidoId: true, estado: true },
  });
  for (const p of pagos) {
    const actual = mapa.get(p.pedidoId);
    if (!actual || PRIORIDAD_PAGO_PARA_CANCELAR[p.estado] > PRIORIDAD_PAGO_PARA_CANCELAR[actual]) {
      mapa.set(p.pedidoId, p.estado);
    }
  }
  return mapa;
}

/**
 * El pedido se CANCELÓ (cliente, mostrador, propuesta o `SWCANCEL` de VFP). Se llama DENTRO de la
 * transacción de la cancelación: o quedan las dos cosas o ninguna. Dejar un pago con dinero sin
 * resolver porque falló el segundo paso sería perder el rastro de un dinero ajeno.
 *
 *   PENDIENTE            → CANCELADO (nunca hubo comprobante; no hay dinero).
 *   EN_REVISION          → se queda y se MARCA: hay un comprobante y puede que el abono sí
 *                          llegara. Tesorería decide (rechazar si no llegó, abono sin pedido si sí).
 *   VERIFICADO/APLICADO  → REEMBOLSO_PENDIENTE: el dinero llegó y el pedido ya no existe.
 */
export async function resolverPagoAlCancelarse(
  tx: Db,
  pedidoId: number,
  actor: ActorPago,
): Promise<CambioPago | null> {
  const pago = await tx.pedidoPagoTransferencia.findFirst({
    where: {
      pedidoId,
      estado: { in: [Estado.PENDIENTE, Estado.EN_REVISION, Estado.VERIFICADO, Estado.APLICADO] },
    },
    include: { pedido: { select: { tiendaId: true } } },
  });
  if (!pago) return null;
  const base = { pagoId: pago.id, pedidoId, tiendaId: pago.pedido.tiendaId };

  if (pago.estado === Estado.PENDIENTE) {
    const r = await tx.pedidoPagoTransferencia.updateMany({
      where: { id: pago.id, estado: Estado.PENDIENTE },
      data: { estado: Estado.CANCELADO },
    });
    if (r.count !== 1) return null; // alguien lo movió en medio (subió un comprobante): la siguiente lectura lo ve
    await registrarEventoPago(tx, pago.id, {
      tipo: 'PEDIDO_CANCELADO',
      de: Estado.PENDIENTE,
      a: Estado.CANCELADO,
      actor,
      detalle: { motivo: 'El pedido se canceló sin que hubiera comprobante.' },
    });
    return { ...base, estado: Estado.CANCELADO, requiereRevision: false };
  }

  if (pago.estado === Estado.EN_REVISION) {
    const motivo =
      'El pedido se CANCELÓ teniendo un comprobante en revisión. Verifica si el abono llegó: ' +
      'si no llegó, rechaza el comprobante; si llegó, regístralo como abono sin pedido para reembolsarlo.';
    await tx.pedidoPagoTransferencia.update({
      where: { id: pago.id },
      data: { requiereRevision: motivo },
    });
    await registrarEventoPago(tx, pago.id, {
      tipo: 'PEDIDO_CANCELADO_CON_COMPROBANTE',
      de: Estado.EN_REVISION,
      a: Estado.EN_REVISION,
      actor,
    });
    return { ...base, estado: Estado.EN_REVISION, requiereRevision: true, alerta: motivo };
  }

  // VERIFICADO o APLICADO: el dinero llegó.
  const r = await tx.pedidoPagoTransferencia.updateMany({
    where: { id: pago.id, estado: pago.estado },
    data: {
      estado: Estado.REEMBOLSO_PENDIENTE,
      reembolsoMonto: pago.montoVerificado,
      reembolsoMotivo: 'El pedido se canceló después de verificar la transferencia.',
    },
  });
  if (r.count !== 1) return null;
  await registrarEventoPago(tx, pago.id, {
    tipo: 'PEDIDO_CANCELADO_CON_DINERO',
    de: pago.estado,
    a: Estado.REEMBOLSO_PENDIENTE,
    actor,
    detalle: { monto: pago.montoVerificado?.toString() ?? null },
  });
  return {
    ...base,
    estado: Estado.REEMBOLSO_PENDIENTE,
    requiereRevision: false,
    alerta: 'Pedido cancelado con una transferencia verificada: hay que reembolsar.',
  };
}

/**
 * VFP COBRÓ el pedido (`FINALIZADA`). Se llama DESPUÉS del commit del cobro y con sus propios
 * errores contenidos por quien llama: si esto falla, el cobro de VFP ya quedó registrado y no
 * debe deshacerse.
 *
 *   VERIFICADO → APLICADO (el caso feliz: Tesorería verificó, la tienda registró).
 *   PENDIENTE  → CANCELADO (el cliente pagó en tienda y nunca transfirió).
 *   EN_REVISION→ se queda y se MARCA: pagó en tienda teniendo un comprobante. Si el abono llegó,
 *                hubo doble pago y hay que reembolsarlo.
 */
export async function resolverPagoAlCobrarse(
  prisma: PrismaClient,
  pedidoId: number,
  actor: ActorPago,
): Promise<CambioPago | null> {
  return prisma.$transaction(async (tx) => {
    const pago = await tx.pedidoPagoTransferencia.findFirst({
      where: {
        pedidoId,
        estado: { in: [Estado.PENDIENTE, Estado.EN_REVISION, Estado.VERIFICADO] },
      },
      include: { pedido: { select: { tiendaId: true } } },
    });
    if (!pago) return null;
    const base = { pagoId: pago.id, pedidoId, tiendaId: pago.pedido.tiendaId };

    if (pago.estado === Estado.VERIFICADO) {
      const r = await tx.pedidoPagoTransferencia.updateMany({
        where: { id: pago.id, estado: Estado.VERIFICADO },
        data: { estado: Estado.APLICADO, aplicadoAt: new Date() },
      });
      if (r.count !== 1) return null;
      await registrarEventoPago(tx, pago.id, {
        tipo: 'COBRO_EN_VFP',
        de: Estado.VERIFICADO,
        a: Estado.APLICADO,
        actor,
      });
      return { ...base, estado: Estado.APLICADO, requiereRevision: false };
    }

    if (pago.estado === Estado.PENDIENTE) {
      const r = await tx.pedidoPagoTransferencia.updateMany({
        where: { id: pago.id, estado: Estado.PENDIENTE },
        data: { estado: Estado.CANCELADO },
      });
      if (r.count !== 1) return null;
      await registrarEventoPago(tx, pago.id, {
        tipo: 'COBRADO_EN_TIENDA',
        de: Estado.PENDIENTE,
        a: Estado.CANCELADO,
        actor,
        detalle: { motivo: 'El pedido se cobró en caja; nunca hubo comprobante.' },
      });
      return { ...base, estado: Estado.CANCELADO, requiereRevision: false };
    }

    // EN_REVISION: pagó en tienda con un comprobante en revisión.
    const motivo =
      'El pedido se COBRÓ en caja teniendo un comprobante en revisión. Verifica si el abono ' +
      'llegó: si no llegó, rechaza el comprobante; si llegó hubo doble pago, regístralo como ' +
      'abono sin pedido para reembolsarlo.';
    await tx.pedidoPagoTransferencia.update({
      where: { id: pago.id },
      data: { requiereRevision: motivo },
    });
    await registrarEventoPago(tx, pago.id, {
      tipo: 'COBRADO_EN_TIENDA_CON_COMPROBANTE',
      de: Estado.EN_REVISION,
      a: Estado.EN_REVISION,
      actor,
    });
    return { ...base, estado: Estado.EN_REVISION, requiereRevision: true, alerta: motivo };
  });
}

/**
 * Algo se desfasó entre VFP y la nube y Tesorería debe verlo antes de aprobar (p. ej. cambió el
 * total en VFP después de dar las instrucciones). Bloquea `aprobar` hasta que se resuelva.
 */
export async function marcarPagoRequiereRevision(
  db: Db,
  pedidoId: number,
  motivo: string,
  actor: ActorPago,
): Promise<CambioPago | null> {
  const pago = await db.pedidoPagoTransferencia.findFirst({
    where: { pedidoId, estado: { in: [Estado.PENDIENTE, Estado.EN_REVISION, Estado.VERIFICADO] } },
    include: { pedido: { select: { tiendaId: true } } },
  });
  if (!pago) return null;
  // No se pisa una revisión ya abierta con otra igual: cada evento de VFP repetiría la fila.
  if (pago.requiereRevision === motivo) return null;
  await db.pedidoPagoTransferencia.update({
    where: { id: pago.id },
    data: { requiereRevision: motivo },
  });
  await registrarEventoPago(db, pago.id, {
    tipo: 'REQUIERE_REVISION',
    de: pago.estado,
    a: pago.estado,
    actor,
    detalle: { motivo },
  });
  return {
    pagoId: pago.id,
    pedidoId,
    tiendaId: pago.pedido.tiendaId,
    estado: pago.estado,
    requiereRevision: true,
    alerta: motivo,
  };
}

/**
 * Avisa a las pantallas. UN solo evento (`pago.estado`) para todo cambio de un pago, más
 * `pago.alerta` cuando Tesorería tiene que mirar algo ya. (Los nombres de evento son strings
 * sueltos: un typo falla en silencio, así que cuantos menos nombres, mejor.)
 */
export function emitirCambioDePago(
  realtime: Pick<RealtimeService, 'emitToPedido' | 'emitToTienda' | 'emitToTesoreria'>,
  cambio: CambioPago,
): void {
  const payload = {
    pagoId: cambio.pagoId,
    pedidoId: cambio.pedidoId,
    estado: cambio.estado,
    requiereRevision: cambio.requiereRevision,
  };
  realtime.emitToPedido(cambio.pedidoId, 'pago.estado', payload);
  realtime.emitToTienda(cambio.tiendaId, 'pago.estado', payload);
  realtime.emitToTesoreria('pago.estado', payload);
  if (cambio.alerta) {
    realtime.emitToTesoreria('pago.alerta', { ...payload, mensaje: cambio.alerta });
  }
}

/**
 * ¿La tienda tiene una cuenta bancaria activa (la suya o la global) a la que el cliente pueda transferir? Misma
 * regla que `CuentasBancariasService.hayCuentaVigente` y que `emitirTransferenciaAlPasarAPago`; vive aquí como función
 * pura porque `PedidosModule` no puede inyectar el módulo de pagos (ciclo).
 *
 * A DOMICILIO es una condición para ACEPTAR el pedido: ahí la transferencia es el único medio de pago y no hay caja
 * que cobre de respaldo; sin cuenta el pedido llegaría a `PENDIENTE_PAGO` sin ninguna forma de pagarse.
 */
export async function hayCuentaParaTienda(
  db: Pick<Db, 'cuentaBancaria'>,
  tiendaId: number,
): Promise<boolean> {
  const cuenta =
    (await db.cuentaBancaria.findFirst({ where: { tiendaId, activa: true }, select: { id: true } })) ??
    (await db.cuentaBancaria.findFirst({ where: { tiendaId: null, activa: true }, select: { id: true } }));
  return !!cuenta;
}

/**
 * El cliente ELIGIÓ transferencia al hacer su pedido (`metodoPagoPreferido`): al pasar a
 * `PENDIENTE_PAGO` —cuando el total ya es firme y el pedido existe en VFP— se le crea el pago con
 * sus datos, SIN que nadie tenga que pedirlos. Así el pedido nunca queda como "de transferencia" sin
 * pago (caja y Tesorería lo ven desde ese momento y no se cobra en efectivo por error), y el cliente
 * no recibe un segundo correo con los datos: le llegan en el de "listo para pagar".
 *
 * Va DENTRO de la transacción del cambio de estado (como `resolverPagoAlCancelarse`) y es una
 * función pura sobre Prisma: `PedidosModule` no puede inyectar el módulo de pagos (ciclo).
 *
 * Nunca bloquea mandar a pagar: si no aplica (domicilio, sin cuenta bancaria activa, ya hay un pago
 * vivo) devuelve `null` y el pedido sigue su camino; el cliente verá que la transferencia no está
 * configurada y caja puede cobrar normal. Solo se omite en silencio lo que NO es un error del flujo.
 */
export async function emitirTransferenciaAlPasarAPago(
  tx: Db,
  pedidoId: number,
  actor: ActorPago,
): Promise<CambioPago | null> {
  const pedido = await tx.pedido.findUnique({
    where: { id: pedidoId },
    select: {
      id: true,
      numeroPedido: true,
      total: true,
      tiendaId: true,
      modoEntrega: true,
      metodoPagoPreferido: true,
    },
  });
  if (!pedido || pedido.metodoPagoPreferido !== MetodoPago.TRANSFERENCIA) return null;
  if (
    !transferenciaDisponible({
      modoEntrega: pedido.modoEntrega,
      estado: EstadoPedido.PENDIENTE_PAGO,
    }).disponible
  ) {
    return null;
  }
  const yaHay = await tx.pedidoPagoTransferencia.findFirst({
    where: { pedidoId, estado: { in: [...ESTADOS_ACTIVOS] } },
    select: { id: true },
  });
  if (yaHay) return null;

  const cuenta =
    (await tx.cuentaBancaria.findFirst({ where: { tiendaId: pedido.tiendaId, activa: true } })) ??
    (await tx.cuentaBancaria.findFirst({ where: { tiendaId: null, activa: true } }));
  if (!cuenta) return null;

  // Un `P2002` dentro de una transacción de Postgres la ABORTA entera: no se puede insertar y
  // reintentar como hace el servicio. Se elige una referencia libre ANTES de insertar.
  let referencia = '';
  for (let i = 0; i < 8 && !referencia; i++) {
    const candidata = String(randomInt(1_000_000, 10_000_000));
    const usada = await tx.pedidoPagoTransferencia.findFirst({
      where: { referencia: candidata },
      select: { id: true },
    });
    if (!usada) referencia = candidata;
  }
  if (!referencia) return null;

  const pago = await tx.pedidoPagoTransferencia.create({
    data: {
      pedidoId,
      estado: Estado.PENDIENTE,
      montoEsperado: pedido.total,
      cuentaSnapshot: {
        banco: cuenta.banco,
        titular: cuenta.titular,
        clabe: cuenta.clabe,
        cuenta: cuenta.cuenta ?? null,
        instrucciones: cuenta.instrucciones ?? null,
      },
      referencia,
      concepto: pedido.numeroPedido.replace(/[^A-Za-z0-9]/g, '').slice(0, 30),
      creadoPorId: actor.id,
      // `actor.rol` también puede ser 'AGENT' o 'SISTEMA', que no son un `RolUsuario`.
      creadoPorRol: Object.values(RolUsuario).includes(actor.rol as RolUsuario)
        ? (actor.rol as RolUsuario)
        : null,
    },
  });
  await registrarEventoPago(tx, pago.id, {
    tipo: 'INSTRUCCIONES_EMITIDAS',
    a: Estado.PENDIENTE,
    actor,
    detalle: { automatico: true, cuentaId: cuenta.id, monto: pedido.total.toString() },
  });
  return {
    pagoId: pago.id,
    pedidoId,
    tiendaId: pedido.tiendaId,
    estado: Estado.PENDIENTE,
    requiereRevision: false,
  };
}
