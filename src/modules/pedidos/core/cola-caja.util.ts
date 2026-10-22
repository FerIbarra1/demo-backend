import { EstadoPagoTransferencia, EstadoPedido, ModoEntrega, Prisma } from '@prisma/client';
import { ESTADOS_NO_COBRAR } from '../../pagos/transferencia/reglas';

/**
 * Oct 2026: LA fila de caja — una sola definición de "quién sigue" para la consola de caja,
 * "Llamar siguiente" y la TV de ventanillas.
 *
 * Antes cada una armaba lo suyo y divergían: las tres ordenaban por `fechaPedido` —cuándo se HIZO
 * el pedido— en vez de por cuándo llegó a caja.
 */

/**
 * Pedidos que se cobran en ventanilla y ningún cajero ha tomado.
 *
 * `incluirDomicilio` es SOLO para la pestaña «Por registrar»: un pedido a DOMICILIO no se cobra en ventanilla (el cliente
 * no va a la tienda: ni "Llamar siguiente" ni la TV lo ven), pero SU transferencia, una vez verificada por Tesorería,
 * la tienda tiene que registrarla en el Sistema Comercial. Sin verla en alguna parte, un domicilio pagado nunca llegaría
 * a `PAGADO` ni a `ENVIADO` (hallazgo H1 del plan de pagos). Desde el 19-oct-2026 a domicilio solo se paga por transferencia.
 */
export function whereFilaDeCaja(
  tiendaId?: number,
  opts: { incluirDomicilio?: boolean } = {},
): Prisma.PedidoWhereInput {
  return {
    estado: EstadoPedido.PENDIENTE_PAGO,
    cajeroAsignadoId: null,
    ...(opts.incluirDomicilio ? {} : { modoEntrega: { not: ModoEntrega.DOMICILIO } }),
    ...(tiendaId ? { tiendaId } : {}),
  };
}

/**
 * De la fila, los que "Llamar siguiente" puede tomar: todos MENOS quien la cajera regresó a la
 * cola "hasta que se valide" (`esperaValidacionDesdeAt`) y sigue con la transferencia sin
 * verificar. Las dos condiciones juntas: en cuanto Tesorería verifica, el filtro deja de
 * excluirlo sin que nadie tenga que limpiar la marca.
 *
 * Antes (`WHERE_COBRABLE`) "Llamar siguiente" saltaba a TODA transferencia sin verificar. El dueño
 * lo revirtió el 16-oct: hay clientes que van a la ventanilla sin haber pagado porque un patrón o
 * un familiar les va a transferir, sin internet, o sin saber subir el comprobante, y justo ahí
 * necesitan que la cajera les ayude; saltarlos los dejaba viendo su folio "primero" en la TV sin
 * que nadie los llamara nunca. Todos se llaman por orden de llegada, con la misma importancia.
 * Si la cajera no quiere esperarlo en su ventanilla, lo regresa con la marca y SOLO entonces se salta.
 */
export const WHERE_LLAMABLE: Prisma.PedidoWhereInput = {
  NOT: {
    esperaValidacionDesdeAt: { not: null },
    pagosTransferencia: { some: { estado: { in: [...ESTADOS_NO_COBRAR] } } },
  },
};

/** Lo mínimo que hace falta de cada pedido para ordenar la fila y marcar la que espera validación. */
export const SELECT_ORDEN_COLA_CAJA = {
  id: true,
  fechaPedido: true,
  colaCajaDesdeAt: true,
  esperaValidacionDesdeAt: true,
  // La transferencia viva del pedido (a lo más una: índice parcial único). Solo importa su ESTADO:
  // PENDIENTE / EN_REVISION = NO se cobra todavía; VERIFICADO = a caja solo le falta registrarla en VFP.
  pagosTransferencia: {
    where: {
      estado: {
        in: [
          EstadoPagoTransferencia.VERIFICADO,
          EstadoPagoTransferencia.PENDIENTE,
          EstadoPagoTransferencia.EN_REVISION,
        ],
      },
    },
    select: { id: true, estado: true },
    take: 1,
  },
} satisfies Prisma.PedidoSelect;

export interface FilaOrdenable {
  id: number;
  fechaPedido: Date;
  colaCajaDesdeAt: Date | null;
}

/** Lo único que hace falta saber del pago para decidir si se cobra: su estado. */
interface ConEstadoDePago {
  pagosTransferencia?: ReadonlyArray<
    { estado?: EstadoPagoTransferencia } | null | undefined
  > | null;
}

/** ¿Hay una transferencia abierta (sin verificar)? A ese cliente NO se le cobra en caja. */
export function esNoCobrar(fila: ConEstadoDePago): boolean {
  return (
    fila.pagosTransferencia?.some(
      (p) =>
        p?.estado === EstadoPagoTransferencia.PENDIENTE ||
        p?.estado === EstadoPagoTransferencia.EN_REVISION,
    ) ?? false
  );
}

/**
 * ¿La cajera lo regresó a la cola "hasta que se valide" y la transferencia sigue sin verificar?
 * Es lo que "Llamar siguiente" salta (ver `WHERE_LLAMABLE`) y lo que la consola marca. Cuando se
 * verifica, deja de serlo solo.
 */
export function esperandoValidacion(
  fila: ConEstadoDePago & { esperaValidacionDesdeAt?: Date | null },
): boolean {
  return !!fila.esperaValidacionDesdeAt && esNoCobrar(fila);
}

/**
 * El orden de la fila de caja — el MISMO en la consola, en "Llamar siguiente" y en la TV:
 * **primero llegado a CAJA, primero atendido**, por `colaCajaDesdeAt` (cuándo mostrador lo mandó a
 * pagar, o cuándo se le pasó el turno). Si falta —pedidos anteriores a la columna—, el de la fecha
 * del pedido; `id` como desempate estable.
 *
 * Y NADA más: ni una transferencia verificada pasa adelante, ni una sin verificar se manda al final
 * (decisión del dueño, 16-oct: "orden de llegada, y la misma importancia para todos"). Antes las
 * verificadas se atendían primero (registrarlas en VFP toma segundos) y las sin verificar iban al
 * final y "Llamar siguiente" las saltaba, pero el cliente que necesita ayuda para transferir —o a quien
 * le va a pagar un tercero— llega a la ventanilla igual y no se le debe pasar por encima. Quien se
 * regresó "hasta que se valide" CONSERVA su `colaCajaDesdeAt`: al verificarse vuelve a ser llamable en
 * su lugar de siempre, delante de quien llegó después, sin una regla de prioridad aparte.
 *
 * Lo único que "Llamar siguiente" se salta es lo que la cajera regresó "hasta que se valide"
 * (`WHERE_LLAMABLE`); sigue en su lugar en la lista y en la TV, y la consola lo marca.
 *
 * Devuelve una copia; no muta la entrada.
 */
export function ordenarFilaDeCaja<T extends FilaOrdenable>(filas: readonly T[]): T[] {
  const llegada = (f: FilaOrdenable) => (f.colaCajaDesdeAt ?? f.fechaPedido).getTime();
  return [...filas].sort((a, b) => {
    const d = llegada(a) - llegada(b);
    return d !== 0 ? d : a.id - b.id;
  });
}
