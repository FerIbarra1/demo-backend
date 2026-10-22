import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EstadoPagoTransferencia, EstadoPedido, ModoEntrega } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ImpresionService } from '../dtf/impresion.service';
import { UserContext } from '../../types/pedido.types';
import {
  armarSemaforo,
  esperaDeLaMasVieja,
  esperaMasLarga,
  minutosDesde,
  type Espera,
  type EtapaEspera,
  type MotivoSemaforo,
  type Nivel,
} from './torre-control.util';

/** Lo que la torre cuenta por etapa. Ver `construirTienda` para qué estados entran en cada número. */
export interface TorreTienda {
  tienda: { id: number; nombre: string; ciudad: string };
  semaforo: { nivel: Nivel; motivos: MotivoSemaforo[] };
  /** La espera más larga de cualquier etapa, aunque la tienda esté en verde ("Caja · 6 min"). */
  masViejo: { etapa: EtapaEspera; minutos: number; referencia: string | null } | null;
  etapas: {
    bodega: { enCola: number; surtiendo: number };
    ventas: { enAsesoria: number; esperandoCliente: number };
    mostrador: { enArea: number; esperandoEnTienda: number; atendiendo: number };
    dtf: { enDtf: number };
    caja: { enFila: number; atendiendo: number };
    porEntregar: { pagados: number; enviados: number };
  };
  transferencias: { porVerificar: number; sinRegistrar: number };
  dtf: {
    porRevisar: number;
    correccion: number;
    imprimir: number;
    imprimiendo: number;
    listos: number;
    metrosHoy: number;
  };
}

export interface TorreControl {
  generadoAt: string;
  tiendas: TorreTienda[];
}

const ESTADOS_ACTIVOS: EstadoPedido[] = [
  EstadoPedido.SOLICITADO,
  EstadoPedido.EN_REVISION,
  EstadoPedido.EN_ASESORIA,
  EstadoPedido.ESPERANDO_APROBACION,
  EstadoPedido.REVISADO,
  EstadoPedido.EN_ATENCION,
  EstadoPedido.EN_DTF,
  EstadoPedido.PENDIENTE_PAGO,
  EstadoPedido.PAGADO,
  EstadoPedido.ENVIADO,
];

/**
 * N1 (PLAN-ADMIN-MULTITIENDA §10, oct 2026): la TORRE DE CONTROL — una tarjeta por tienda con lo que importa HOY, para
 * responder "¿cómo va cada tienda?" sin entrar a cuatro consolas. Es la ÚNICA vista multi-tienda del ADMIN (D1: las
 * colas siguen siendo de una tienda).
 *
 * Por qué NO llama a los monitores de TV: cada uno arma el snapshot completo de UNA tienda (columnas, sugerencias,
 * fichas) y son pantallas públicas con su propia forma. Aquí se hacen pocas consultas para TODAS las tiendas a la vez
 * (un `groupBy`, un `findMany` de lo que espera, uno de transferencias y uno de DTF); solo el resumen de DTF (y sus
 * metros del día) se pide por tienda a `ImpresionService.resumen`, para que el número de la torre sea EXACTAMENTE el de
 * la consola de Impresión y la regla del "día del negocio" no tenga una segunda copia.
 *
 * Lo que mide el semáforo es la ESPERA, no el volumen (ver `torre-control.util.ts`).
 */
@Injectable()
export class TorreControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly impresion: ImpresionService,
  ) {}

  /**
   * `tiendaId`: acota la torre a UNA tienda (la del GERENTE, que sale de su token en `gerencia/torre-control`).
   * Sin él, una tarjeta por tienda activa (la torre del ADMIN). Es la misma consulta y el mismo semáforo: una
   * sola definición de "cómo va una tienda", sin una segunda copia para el gerente.
   */
  async obtener(
    user: UserContext,
    ahora: Date = new Date(),
    tiendaId?: number,
  ): Promise<TorreControl> {
    const tiendas = await this.prisma.tienda.findMany({
      where: { activa: true, ...(tiendaId ? { id: tiendaId } : {}) },
      orderBy: { id: 'asc' },
      select: { id: true, nombre: true, ciudad: true },
    });
    if (tiendas.length === 0) return { generadoAt: ahora.toISOString(), tiendas: [] };
    const ids = tiendas.map((t) => t.id);

    const [conteos, esperando, pagos, dtfRecibidos, resumenesDtf] = await Promise.all([
      // Cuántos hay en cada estado activo, por tienda.
      this.prisma.pedido.groupBy({
        by: ['tiendaId', 'estado'],
        where: { tiendaId: { in: ids }, estado: { in: ESTADOS_ACTIVOS } },
        _count: true,
      }),
      // Solo lo que ESPERA al personal (hace falta la fecha desde la que espera). Las demás etapas se cuentan arriba.
      this.prisma.pedido.findMany({
        where: {
          tiendaId: { in: ids },
          OR: [
            { estado: EstadoPedido.SOLICITADO },
            { estado: EstadoPedido.EN_REVISION },
            { estado: EstadoPedido.EN_ASESORIA },
            // Un REVISADO solo espera al personal si el cliente YA está en tienda; si no, espera al cliente.
            { estado: EstadoPedido.REVISADO, presenteDesdeAt: { not: null } },
            // Domicilio no se cobra en ventanilla: no es la fila de caja.
            { estado: EstadoPedido.PENDIENTE_PAGO, modoEntrega: { not: ModoEntrega.DOMICILIO } },
          ],
        },
        select: {
          tiendaId: true,
          estado: true,
          numeroPedido: true,
          fechaPedido: true,
          asignadoAId: true,
          asignadoAt: true,
          cajeroAsignadoId: true,
          colaCajaDesdeAt: true,
          presenteDesdeAt: true,
          // Cuándo entró a EN_REVISION / EN_ASESORIA (la última fila de historial hacia esos estados: un pedido
          // que bodega LIBERÓ también escribe la suya, así que mide la espera desde que quedó libre).
          historial: {
            where: { estadoNuevo: { in: [EstadoPedido.EN_REVISION, EstadoPedido.EN_ASESORIA] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { createdAt: true },
          },
        },
      }),
      this.prisma.pedidoPagoTransferencia.findMany({
        where: {
          estado: {
            in: [EstadoPagoTransferencia.EN_REVISION, EstadoPagoTransferencia.VERIFICADO],
          },
          pedido: { tiendaId: { in: ids } },
        },
        select: {
          estado: true,
          updatedAt: true,
          verificadoAt: true,
          pedido: { select: { tiendaId: true, numeroPedido: true } },
        },
      }),
      this.prisma.pedidoDtf.groupBy({
        by: ['tiendaId'],
        where: { tiendaId: { in: ids }, estado: 'RECIBIDO' },
        _min: { recibidoAt: true },
      }),
      Promise.all(tiendas.map((t) => this.impresion.resumen(user, t.id))),
    ]);

    const horasSinRegistrar = this.config.get<number>('app.pagos.alertaSinRegistrarHoras') ?? 4;

    return {
      generadoAt: ahora.toISOString(),
      tiendas: tiendas.map((t, i) => {
        const cuenta = (e: EstadoPedido) =>
          conteos.find((c) => c.tiendaId === t.id && c.estado === e)?._count ?? 0;
        const delaTienda = esperando.filter((p) => p.tiendaId === t.id);
        const pagosTienda = pagos.filter((p) => p.pedido.tiendaId === t.id);
        const resumen = resumenesDtf[i];

        const libres = delaTienda.filter(
          (p) =>
            p.estado === EstadoPedido.SOLICITADO ||
            (p.estado === EstadoPedido.EN_REVISION && p.asignadoAId === null),
        );
        const surtiendo = delaTienda.filter(
          (p) => p.estado === EstadoPedido.EN_REVISION && p.asignadoAId !== null,
        );
        const enAsesoria = delaTienda.filter((p) => p.estado === EstadoPedido.EN_ASESORIA);
        const enTienda = delaTienda.filter((p) => p.estado === EstadoPedido.REVISADO);
        const caja = delaTienda.filter((p) => p.estado === EstadoPedido.PENDIENTE_PAGO);
        const enFila = caja.filter((p) => p.cajeroAsignadoId === null);
        const porVerificar = pagosTienda.filter(
          (p) => p.estado === EstadoPagoTransferencia.EN_REVISION,
        );
        const sinRegistrar = pagosTienda.filter(
          (p) => p.estado === EstadoPagoTransferencia.VERIFICADO,
        );
        const dtfRecibido = dtfRecibidos.find((d) => d.tiendaId === t.id);

        const esperas: Partial<Record<EtapaEspera, Espera | null>> = {
          // SOLICITADO espera desde que se hizo; un EN_REVISION libre, desde que quedó libre.
          bodega: esperaDeLaMasVieja(
            libres.map((p) => ({
              desde:
                p.estado === EstadoPedido.SOLICITADO
                  ? p.fechaPedido
                  : (p.historial[0]?.createdAt ?? p.fechaPedido),
              referencia: p.numeroPedido,
            })),
            ahora,
          ),
          surtido: esperaDeLaMasVieja(
            surtiendo.map((p) => ({
              desde: p.asignadoAt ?? p.fechaPedido,
              referencia: p.numeroPedido,
            })),
            ahora,
          ),
          ventas: esperaDeLaMasVieja(
            enAsesoria.map((p) => ({
              desde: p.historial[0]?.createdAt ?? p.fechaPedido,
              referencia: p.numeroPedido,
            })),
            ahora,
          ),
          mostrador: esperaDeLaMasVieja(
            enTienda.map((p) => ({ desde: p.presenteDesdeAt, referencia: p.numeroPedido })),
            ahora,
          ),
          caja: esperaDeLaMasVieja(
            enFila.map((p) => ({
              desde: p.colaCajaDesdeAt ?? p.fechaPedido,
              referencia: p.numeroPedido,
            })),
            ahora,
          ),
          transferencias: esperaDeLaMasVieja(
            porVerificar.map((p) => ({ desde: p.updatedAt, referencia: p.pedido.numeroPedido })),
            ahora,
          ),
          sinRegistrar: esperaDeLaMasVieja(
            sinRegistrar.map((p) => ({ desde: p.verificadoAt, referencia: p.pedido.numeroPedido })),
            ahora,
          ),
          dtf: dtfRecibido?._min.recibidoAt
            ? { minutos: minutosDesde(dtfRecibido._min.recibidoAt, ahora) ?? 0, referencia: null }
            : null,
        };

        return {
          tienda: t,
          semaforo: armarSemaforo(esperas, horasSinRegistrar),
          masViejo: esperaMasLarga(esperas),
          etapas: {
            bodega: { enCola: libres.length, surtiendo: surtiendo.length },
            ventas: {
              enAsesoria: cuenta(EstadoPedido.EN_ASESORIA),
              esperandoCliente: cuenta(EstadoPedido.ESPERANDO_APROBACION),
            },
            mostrador: {
              enArea: cuenta(EstadoPedido.REVISADO),
              esperandoEnTienda: enTienda.length,
              atendiendo: cuenta(EstadoPedido.EN_ATENCION),
            },
            dtf: { enDtf: cuenta(EstadoPedido.EN_DTF) },
            caja: { enFila: enFila.length, atendiendo: caja.length - enFila.length },
            porEntregar: {
              pagados: cuenta(EstadoPedido.PAGADO),
              enviados: cuenta(EstadoPedido.ENVIADO),
            },
          },
          transferencias: { porVerificar: porVerificar.length, sinRegistrar: sinRegistrar.length },
          dtf: {
            porRevisar: resumen.tabs.revisar,
            correccion: resumen.tabs.correccion,
            imprimir: resumen.tabs.imprimir,
            imprimiendo: resumen.tabs.imprimiendo,
            listos: resumen.tabs.listos,
            metrosHoy: resumen.hoy.metros,
          },
        };
      }),
    };
  }
}
