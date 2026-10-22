import { EstadoDtf, EstadoPreflight, Prisma } from '@prisma/client';
import {
  ESTADOS_DTF_CON_HORA,
  ESTADOS_DTF_EDITABLES_POR_CLIENTE,
  ESTADOS_DTF_MEDIDAS_AJUSTABLES,
  ESTADOS_DTF_POR_REVISAR,
} from './core/dtf-estado.util';
import { textoMotivoCorreccion, textoMotivoRechazo } from './core/dtf-motivos';
import { esFolioErp, formatearFolio } from '../pedidos/core/folio-erp.util';

/** Lo que se carga de un trabajo para construir cualquier vista. */
export const INCLUDE_TRABAJO = {
  tipo: true,
  archivos: { orderBy: { version: 'asc' as const } },
  asignadoA: { select: { id: true, nombre: true, apellido: true } },
  usuario: { select: { id: true, nombre: true, apellido: true, email: true, telefono: true } },
  pedido: {
    select: {
      id: true,
      numeroPedido: true,
      folioErp: true,
      estado: true,
      modoEntrega: true,
      tiendaId: true,
      clienteNombre: true,
      total: true,
      pendienteEnvio: { select: { externalFolio: true } },
      tienda: { select: { serie: true } },
    },
  },
} satisfies Prisma.PedidoDtfInclude;

export type TrabajoCompleto = Prisma.PedidoDtfGetPayload<{ include: typeof INCLUDE_TRABAJO }>;

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d));

export interface VistaOpts {
  /** Quién mira: define qué botones se ofrecen. El SERVIDOR decide; la pantalla no deduce nada. */
  mira: 'cliente' | 'impresion';
  userId?: number;
  esAdmin?: boolean;
  etaProvisional?: Date | null;
  mensajesNuevos?: number;
}

export function vistaTrabajo(t: TrabajoCompleto, o: VistaOpts) {
  const vigente = t.archivos.find((a) => a.version === t.versionVigente) ?? null;
  const pf = (vigente?.preflight ?? null) as null | {
    reglas?: unknown[];
    bloquea?: boolean;
    avisos?: number;
  };
  const editableCliente = ESTADOS_DTF_EDITABLES_POR_CLIENTE.includes(t.estado);
  const porRevisar = ESTADOS_DTF_POR_REVISAR.includes(t.estado);
  const hayArchivo = Boolean(vigente);
  const bloqueado = vigente?.preflightEstado === EstadoPreflight.BLOQUEADO;
  const mio = t.asignadoAId != null && t.asignadoAId === o.userId;

  return {
    id: t.id,
    pedidoId: t.pedidoId,
    estado: t.estado,
    nombre: t.nombre,
    notaCliente: t.notaCliente,
    copias: t.copias,
    tipo: {
      id: t.tipo.id,
      tecnologia: t.tipo.tecnologia,
      nombre: t.tipo.nombre,
      anchoUtilCm: Number(t.tipo.anchoUtilCm),
      minimoCm: Number(t.tipo.minimoCm),
      maxAlturaCm: Number(t.tipo.maxAlturaCm),
      pasoCobroCm: t.tipo.pasoCobroCm,
    },
    cotizacion: {
      anchoCm: num(t.anchoCm),
      altoCm: num(t.altoCm),
      metrosCobrados: num(t.metrosCobrados),
      precioMetro: Number(t.precioMetro),
      subtotal: Number(t.subtotal),
      // Sin medidas (análisis no concluyente) se cotiza el mínimo hasta que Impresión confirme.
      provisional: hayArchivo && t.altoCm == null,
    },
    versionVigente: t.versionVigente,
    archivo: vigente
      ? {
          id: vigente.id,
          version: vigente.version,
          nombreOriginal: vigente.nombreOriginal,
          bytes: vigente.bytes,
          mime: vigente.mime,
          canal: vigente.canal,
          subidoPorRol: vigente.subidoPorRol,
          preflightEstado: vigente.preflightEstado,
          reglas: pf?.reglas ?? [],
          bloquea: pf?.bloquea ?? false,
          avisos: pf?.avisos ?? 0,
          tienePreview: Boolean(vigente.previewKey),
          createdAt: vigente.createdAt,
        }
      : null,
    versiones: t.archivos.map((a) => ({
      version: a.version,
      nombreOriginal: a.nombreOriginal,
      canal: a.canal,
      preflightEstado: a.preflightEstado,
      createdAt: a.createdAt,
    })),
    // `motivos`/`motivo` son los CÓDIGOS (los usa la consola de Impresión); `textos`/`texto` ya traen lo
    // que lee el cliente, redactado aquí. Antes la vista solo llevaba los códigos y la pantalla del
    // cliente habría tenido que copiar los textos: dos lugares que se desincronizan al editar uno.
    correccion:
      t.estado === EstadoDtf.NECESITA_CORRECCION
        ? {
            motivos: t.correccionMotivos ?? [],
            textos: ((t.correccionMotivos ?? []) as unknown[])
              .filter((m): m is string => typeof m === 'string')
              .map(textoMotivoCorreccion),
            nota: t.correccionNota,
          }
        : null,
    rechazo:
      t.estado === EstadoDtf.RECHAZADO
        ? {
            motivo: t.rechazoMotivo,
            texto: t.rechazoMotivo ? textoMotivoRechazo(t.rechazoMotivo) : null,
            nota: t.rechazoNota,
          }
        : null,
    aceptoRiesgo: t.aceptoRiesgo,
    reimpresiones: t.reimpresiones,
    asignadoA: t.asignadoA
      ? {
          id: t.asignadoA.id,
          nombre: `${t.asignadoA.nombre}${t.asignadoA.apellido ? ' ' + t.asignadoA.apellido : ''}`,
        }
      : null,
    // Línea de tiempo para el cliente y la consola.
    fechas: {
      creado: t.createdAt,
      recibido: t.recibidoAt,
      aprobado: t.aprobadoAt,
      imprimiendo: t.imprimiendoAt,
      impreso: t.impresoAt,
    },
    horaEstimadaAt: t.horaEstimadaAt ?? o.etaProvisional ?? null,
    horaEstimadaProvisional: !t.horaEstimadaAt && Boolean(o.etaProvisional),
    mensajesNuevos: o.mensajesNuevos ?? 0,
    pedido: t.pedido
      ? {
          id: t.pedido.id,
          numeroPedido: t.pedido.numeroPedido,
          // Oct 2026 (B2): el folio del Sistema Comercial con la serie de su tienda (el que lleva el ticket de la bolsa).
          folio: t.pedido.folioErp
            ? formatearFolio(t.pedido.tienda?.serie, t.pedido.folioErp)
            : esFolioErp(t.pedido.pendienteEnvio?.externalFolio)
              ? t.pedido.pendienteEnvio.externalFolio
              : t.pedido.numeroPedido,
          estado: t.pedido.estado,
          modoEntrega: t.pedido.modoEntrega,
          clienteNombre: t.pedido.clienteNombre,
        }
      : null,
    // El servidor decide qué botones caben.
    acciones: {
      // Cliente
      puedeSubirVersion: o.mira === 'cliente' ? editableCliente : false,
      puedeCancelar: o.mira === 'cliente' ? editableCliente : false,
      puedeEditar: o.mira === 'cliente' ? editableCliente && t.estado !== 'APROBADO' : false,
      puedeAgregarAlPedido:
        o.mira === 'cliente' && t.estado === 'BORRADOR' && hayArchivo && !bloqueado,
      puedeEscribir: t.pedidoId != null && !['CANCELADO', 'EXPIRADO'].includes(t.estado),
      // Impresión
      puedeTomar: o.mira === 'impresion' && t.estado === 'RECIBIDO' && !t.asignadoAId,
      puedeSoltar:
        o.mira === 'impresion' && t.estado === 'EN_REVISION' && (mio || Boolean(o.esAdmin)),
      puedeAprobar: o.mira === 'impresion' && porRevisar && hayArchivo && !bloqueado,
      puedePedirCorreccion:
        o.mira === 'impresion' && (porRevisar || t.estado === 'APROBADO') && hayArchivo,
      puedeRechazar: o.mira === 'impresion' && (porRevisar || t.estado === 'NECESITA_CORRECCION'),
      puedeImprimir: o.mira === 'impresion' && t.estado === 'APROBADO',
      puedeMarcarImpreso: o.mira === 'impresion' && t.estado === 'EN_IMPRESION',
      puedeReimprimir:
        o.mira === 'impresion' && (t.estado === 'EN_IMPRESION' || t.estado === 'IMPRESO'),
      puedeAdjuntar:
        o.mira === 'impresion' &&
        ['ARCHIVO_PENDIENTE', 'RECIBIDO', 'EN_REVISION', 'NECESITA_CORRECCION'].includes(t.estado),
      // Mismas listas que las guardas de `ajustarMedidas` y `horaEstimada`: la pantalla ofrece lo que el servidor acepta.
      puedeAjustarMedidas:
        o.mira === 'impresion' && hayArchivo && ESTADOS_DTF_MEDIDAS_AJUSTABLES.includes(t.estado),
      puedeAjustarHora: o.mira === 'impresion' && ESTADOS_DTF_CON_HORA.includes(t.estado),
    },
  };
}

/** Los trabajos DTF de un pedido (para el detalle del cliente, caja, mostrador y admin). Sin borradores. */
export async function dtfDelPedido(
  db: { pedidoDtf: Prisma.TransactionClient['pedidoDtf'] },
  pedidoId: number,
  mira: 'cliente' | 'impresion',
  userId?: number,
) {
  const filas = await db.pedidoDtf.findMany({
    where: { pedidoId, estado: { notIn: ['BORRADOR', 'EXPIRADO'] } },
    include: INCLUDE_TRABAJO,
    orderBy: { id: 'asc' },
  });
  return filas.map((t) => vistaTrabajo(t, { mira, userId }));
}
