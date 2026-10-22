import { EstadoPagoTransferencia, EstadoPedido, ModoEntrega } from '@prisma/client';

/**
 * Reglas puras del pago por transferencia. Sin Prisma ni Nest: se pueden probar sin nada y las
 * usan tanto el módulo de pagos como los módulos viejos (cajero, cliente, state service).
 */

/** Pago "vivo": ocupa el único lugar activo del pedido (índice parcial en la BD). */
export const ESTADOS_ACTIVOS: readonly EstadoPagoTransferencia[] = [
  EstadoPagoTransferencia.PENDIENTE,
  EstadoPagoTransferencia.EN_REVISION,
  EstadoPagoTransferencia.VERIFICADO,
  EstadoPagoTransferencia.REEMBOLSO_PENDIENTE,
];

/**
 * ¿Hay un pago que ocupe el lugar activo del pedido? Un pago CANCELADO o VENCIDO ya no lo ocupa:
 * se puede emitir otro. Es la misma condición del índice parcial único, para que "se puede pedir
 * los datos" y "la BD acepta el INSERT" nunca digan cosas distintas.
 */
export function hayPagoVivo(pago: { estado: EstadoPagoTransferencia } | null | undefined): boolean {
  return !!pago && ESTADOS_ACTIVOS.includes(pago.estado);
}

/**
 * Estados donde la tienda NO debe cobrar: hay una transferencia en curso y un cobro en caja
 * sería doble pago. En VERIFICADO el dinero ya llegó y lo que toca es registrarlo en VFP.
 */
export const ESTADOS_NO_COBRAR: readonly EstadoPagoTransferencia[] = [
  EstadoPagoTransferencia.PENDIENTE,
  EstadoPagoTransferencia.EN_REVISION,
];

/**
 * Estados donde puede haber dinero del cliente que el sistema no debe ignorar. Un cliente no
 * puede cancelar su pedido mientras esté en uno de estos (primero hay que resolver el dinero).
 */
export const ESTADOS_BLOQUEAN_CANCELACION: readonly EstadoPagoTransferencia[] = [
  EstadoPagoTransferencia.EN_REVISION,
  EstadoPagoTransferencia.VERIFICADO,
];

export const MAX_COMPROBANTES_POR_PAGO = 10;
export const MAX_COMPROBANTES_PENDIENTES = 3;

/**
 * ¿Se puede pagar este pedido por transferencia?
 *
 * ÚNICO punto de control. El 15-oct-2026 los pedidos a DOMICILIO quedaban fuera "mientras se rediseña
 * el flujo de envíos": un domicilio verificado nunca llegaba a PAGADO porque ninguna consola de caja
 * lo mostraba (hallazgo H1). El 19-oct-2026 el dueño decidió que **a domicilio SOLO se paga por
 * transferencia**, y el hueco se cerró en las tres partes que el plan (§18) pedía: (1) el método se
 * fuerza al hacer el pedido (`cliente.service`) y se exige que haya una cuenta bancaria, porque a
 * domicilio NO hay caja de respaldo; (2) las instrucciones salen solas al pasar a pago; (3) la
 * pestaña «Por registrar» de caja incluye los domicilios verificados (`obtenerColaVentanilla`).
 *
 * El frontend no repite la regla: recibe el resultado (`puedePagarPorTransferencia`).
 */
export function transferenciaDisponible(pedido: {
  modoEntrega: ModoEntrega;
  estado: EstadoPedido;
}): {
  disponible: boolean;
  motivo: string | null;
} {
  if (pedido.estado !== EstadoPedido.PENDIENTE_PAGO) {
    // Instrucciones solo cuando el total es firme y el pedido ya existe en VFP (tiene folio):
    // antes, el monto puede cambiar en mostrador y la tienda no podría registrar el cobro.
    return {
      disponible: false,
      motivo:
        pedido.estado === EstadoPedido.CANCELADO
          ? 'Este pedido está cancelado.'
          : 'Podrás pagar por transferencia cuando tu pedido esté listo para pagar.',
    };
  }
  return { disponible: true, motivo: null };
}

/** Motivos con los que Tesorería rechaza un comprobante, y lo que lee el cliente. */
export const MOTIVOS_RECHAZO = {
  ILEGIBLE: 'No pudimos leer el comprobante. Sube una captura o un PDF más claro.',
  NO_REFLEJA_ABONO:
    'No vemos el abono en nuestra cuenta todavía. Si ya lo hiciste, espera unos minutos y vuelve a intentarlo.',
  MONTO_DISTINTO: 'El monto de la transferencia no coincide con el total de tu pedido.',
  CUENTA_DISTINTA: 'La transferencia se hizo a una cuenta distinta a la de las instrucciones.',
  DUPLICADO: 'Este comprobante ya se usó en otro pago.',
  // No repite el título del correo ("No pudimos validar tu comprobante"): la nota de Tesorería, que
  // es lo que importa, se agrega a continuación.
  OTRO: 'Hay algo que aclarar con tu comprobante.',
} as const;

export type MotivoRechazo = keyof typeof MOTIVOS_RECHAZO;
export const CODIGOS_MOTIVO_RECHAZO = Object.keys(MOTIVOS_RECHAZO) as MotivoRechazo[];

/** ¿Es un pedido que se envía por paquetería? Ahí «pagar en tienda» y «recoger» no existen. */
export const esDomicilio = (modoEntrega: ModoEntrega | null | undefined): boolean =>
  modoEntrega === ModoEntrega.DOMICILIO;

/** Lo que ve el cliente por estado. Texto único: el frontend no lo reescribe. */
export function mensajeParaCliente(
  estado: EstadoPagoTransferencia,
  opts: { domicilio?: boolean } = {},
): string {
  const domicilio = !!opts.domicilio;
  switch (estado) {
    case EstadoPagoTransferencia.PENDIENTE:
      return 'Transfiere el monto exacto con los datos de abajo y sube tu comprobante.';
    case EstadoPagoTransferencia.EN_REVISION:
      return 'Recibimos tu comprobante y estamos confirmando que el dinero llegó.';
    case EstadoPagoTransferencia.VERIFICADO:
      // OJO: no dice "pagado". El pedido no lo está hasta que la tienda registra el cobro en VFP.
      return domicilio
        ? 'Recibimos tu transferencia. En cuanto la tienda registre el pago, tu pedido sale a envío.'
        : 'Recibimos tu transferencia. En cuanto la tienda registre el pago podrás recoger tu pedido.';
    case EstadoPagoTransferencia.APLICADO:
      return 'Tu pago por transferencia quedó registrado.';
    case EstadoPagoTransferencia.CANCELADO:
      return domicilio
        ? 'Se canceló el pago por transferencia.'
        : 'Cancelaste el pago por transferencia. Puedes pagar en tienda.';
    case EstadoPagoTransferencia.VENCIDO:
      return domicilio
        ? 'Estas instrucciones de transferencia ya no están activas. Pide unas nuevas.'
        : 'Estas instrucciones de transferencia ya no están activas. Pide unas nuevas o paga en tienda.';
    case EstadoPagoTransferencia.REEMBOLSO_PENDIENTE:
      return 'Vamos a devolverte tu dinero. Te avisaremos por correo cuando lo hagamos.';
    case EstadoPagoTransferencia.REEMBOLSADO:
      return 'Te devolvimos el dinero de tu transferencia.';
  }
}

/**
 * Cuánto lleva esperando un pago `PENDIENTE` (instrucciones emitidas y ningún comprobante). Sin plazo:
 * no vence solo, así que lo único que se le dice a Tesorería y a caja es cuánto lleva, y ellos
 * deciden. `null` en cualquier otro estado: con un comprobante en revisión ya no se espera al cliente.
 *
 * El texto lo arma el servidor (como `mensajeParaCaja`) para que las tres pantallas digan lo mismo.
 */
export function esperaDelPago(
  pago: { estado: EstadoPagoTransferencia; createdAt: Date },
  ahora = new Date(),
): { desde: Date; dias: number; texto: string } | null {
  if (pago.estado !== EstadoPagoTransferencia.PENDIENTE) return null;
  const ms = Math.max(0, ahora.getTime() - pago.createdAt.getTime());
  const horas = Math.floor(ms / 3_600_000);
  const dias = Math.floor(horas / 24);
  const unidad = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
  const texto =
    dias >= 1
      ? `Lleva ${unidad(dias, 'día', 'días')} esperando`
      : horas >= 1
        ? `Lleva ${unidad(horas, 'hora', 'horas')} esperando`
        : 'Lleva menos de una hora esperando';
  return { desde: pago.createdAt, dias, texto };
}

/**
 * Fila de pago que las colas de caja muestran junto a cada pedido. Una sola forma para la cola, "mis
 * pedidos" y el detalle; el texto sale de `mensajeParaCaja`.
 */
export function resumirPagoParaCaja(
  pago:
    | {
        id: number;
        estado: EstadoPagoTransferencia;
        referencia: string;
        montoEsperado: { toString(): string };
        verificadoAt: Date | null;
        requiereRevision: string | null;
        /** Desde cuándo esperan las instrucciones (ver `esperaDelPago`). */
        createdAt: Date;
      }
    | null
    | undefined,
  ahora = new Date(),
) {
  if (!pago) return null;
  return {
    id: pago.id,
    estado: pago.estado,
    referencia: pago.referencia,
    montoEsperado: pago.montoEsperado.toString(),
    verificadoAt: pago.verificadoAt,
    requiereRevision: !!pago.requiereRevision,
    caja: mensajeParaCaja(pago.estado),
    espera: esperaDelPago(pago, ahora),
  };
}

/** Lo que lee el cajero/mostrador. También único y generado en el servidor. */
export function mensajeParaCaja(estado: EstadoPagoTransferencia): {
  accion: 'NO_COBRAR' | 'REGISTRAR_EN_VFP' | null;
  mensaje: string;
} {
  switch (estado) {
    case EstadoPagoTransferencia.PENDIENTE:
      // Sin plazo (decisión del dueño, oct 2026): el bloqueo de caja dura hasta que alguien cierre la
      // transferencia (Tesorería la marca vencida, o caja la pasa a pagar en tienda). Cuánto lleva
      // esperando viaja aparte (`espera`), no en el texto.
      return {
        accion: 'NO_COBRAR',
        mensaje:
          'El cliente va a pagar por TRANSFERENCIA (todavía no la hace). No cobres en caja: es doble pago.',
      };
    case EstadoPagoTransferencia.EN_REVISION:
      return {
        accion: 'NO_COBRAR',
        mensaje:
          'Transferencia en revisión por Tesorería. No cobres en caja hasta que se verifique.',
      };
    case EstadoPagoTransferencia.VERIFICADO:
      return {
        accion: 'REGISTRAR_EN_VFP',
        mensaje:
          'Transferencia VERIFICADA. No cobres de nuevo: registra el pago en el Sistema Comercial como TRANSFERENCIA.',
      };
    case EstadoPagoTransferencia.APLICADO:
      return {
        accion: null,
        mensaje: 'Pagado por transferencia (ya registrado en el Sistema Comercial).',
      };
    case EstadoPagoTransferencia.REEMBOLSO_PENDIENTE:
      return {
        accion: null,
        mensaje: 'Hay una transferencia por reembolsar al cliente (Tesorería).',
      };
    default:
      return { accion: null, mensaje: '' };
  }
}

/** Horas que una transferencia VERIFICADA puede esperar a que la tienda la registre en VFP antes de marcarse "atrasada". */
export const HORAS_SIN_REGISTRAR_POR_DEFECTO = 4;

/**
 * ¿Lleva una transferencia verificada demasiado tiempo sin registrarse en VFP? Es el olvido más
 * probable del flujo (Tesorería verifica y la tienda nunca cobra). No hay proceso que avise: esto
 * se calcula al LEER, y Tesorería ve la marca en su cola, para no depender de que alguien se acuerde.
 */
export function verificadoAtrasado(
  verificadoAt: Date | null | undefined,
  horas: number,
  ahora = new Date(),
): boolean {
  if (!verificadoAt) return false;
  return ahora.getTime() - verificadoAt.getTime() > horas * 3_600_000;
}
