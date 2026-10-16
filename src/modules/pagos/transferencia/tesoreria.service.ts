import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EstadoComprobante,
  EstadoPagoTransferencia as Estado,
  EstadoPedido,
  Prisma,
  TipoNotificacion,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { UserContext } from '../../../types/pedido.types';
import { ComprobanteStorageService } from './comprobante-storage.service';
import {
  AbonoSinPedidoDto,
  AprobarPagoDto,
  ConciliacionQueryDto,
  GrupoPago,
  ListarPagosQueryDto,
  RechazarPagoDto,
  RegistrarReembolsoDto,
  ReenviarInstruccionesDto,
  ResolverRevisionDto,
} from './dto/pago.dto';
import { ActorPago, CambioPago, emitirCambioDePago, registrarEventoPago } from './hooks';
import {
  PEDIDO_PARA_PAGO,
  aDecimal,
  bloquearPedido,
  claveRastreoNormalizada,
  enmascararEmail,
  fechaDeAbono,
} from './pago-comun';
import { PagoTransferenciaService } from './pago-transferencia.service';
import {
  ESTADOS_ACTIVOS,
  HORAS_SIN_REGISTRAR_POR_DEFECTO,
  MOTIVOS_RECHAZO,
  MotivoRechazo,
  verificadoAtrasado,
} from './reglas';
import {
  FilaConciliacion,
  construirCsv,
  esFechaYmd,
  hoyLocal,
  rangoDeDias,
  sumarDias,
} from './conciliacion.util';

/**
 * Estados desde los que Tesorería puede VERIFICAR un abono. VENCIDO está incluido: un abono tardío
 * (el cliente transfirió después de que vencieron las instrucciones) es dinero real y no se ignora,
 * pero exige una nota que diga qué pasó (ver `aprobar`).
 */
const ESTADOS_QUE_SE_PUEDEN_APROBAR: Estado[] = [
  Estado.PENDIENTE,
  Estado.EN_REVISION,
  Estado.VENCIDO,
];

/** Tope de filas del reporte de conciliación (más allá, se pide un rango menor). */
const MAX_FILAS_CONCILIACION = 5000;
/** Rango máximo del reporte, en días. */
const MAX_DIAS_CONCILIACION = 93;
/** Cuántas vencidas cierra "cerrar vencidas" de una vez. */
const MAX_CIERRE_MASIVO = 200;

/** Desde dónde se puede registrar un abono que llegó cuando el pedido ya no es pagable. */
const ESTADOS_ABONO_SIN_PEDIDO: Estado[] = [
  Estado.PENDIENTE,
  Estado.EN_REVISION,
  Estado.CANCELADO,
  Estado.VENCIDO,
];

const GRUPOS: Record<
  Exclude<GrupoPago, 'requieren-revision' | 'esperando' | 'vencidas'>,
  Estado[]
> = {
  'por-revisar': [Estado.EN_REVISION],
  verificados: [Estado.VERIFICADO],
  reembolsos: [Estado.REEMBOLSO_PENDIENTE],
  historial: [Estado.APLICADO, Estado.REEMBOLSADO, Estado.CANCELADO, Estado.VENCIDO],
};

/**
 * Lo que hace TESORERÍA (multi-tienda): ver la cola de pagos por transferencia, verificar contra
 * el banco, rechazar comprobantes y registrar reembolsos.
 *
 * Reglas que sostienen el diseño:
 *   - Verificar NO cambia el `EstadoPedido` ni marca pagado. La tienda registra el cobro en VFP y
 *     el agente lo sube (`resolverPagoAlCobrarse` lo pasa a APLICADO).
 *   - La fuente de verdad es el estado de cuenta, no la imagen del comprobante: aprobar exige
 *     `confirmoEnBanco` y el MONTO EXACTO.
 *   - Toda transición es una escritura condicional (`updateMany` con el estado esperado en el
 *     `where`): dos tesoreros no pueden aprobar el mismo pago.
 *   - Cada transición escribe su fila de bitácora en la MISMA transacción.
 *   - Los efectos externos (realtime, correo) van DESPUÉS del commit.
 */
@Injectable()
export class TesoreriaService {
  private readonly logger = new Logger(TesoreriaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly storage: ComprobanteStorageService,
    private readonly pagos: PagoTransferenciaService,
    private readonly config: ConfigService,
  ) {}

  /** Horas que una transferencia verificada puede esperar su registro en VFP antes de marcarse atrasada. */
  private get horasSinRegistrar(): number {
    return (
      this.config.get<number>('app.pagos.alertaSinRegistrarHoras') ??
      HORAS_SIN_REGISTRAR_POR_DEFECTO
    );
  }

  private get zonaHoraria(): string {
    return this.config.get<string>('app.pagos.zonaHoraria') ?? 'America/Mexico_City';
  }

  private actorDe(user: UserContext, ip?: string | null): ActorPago {
    return { id: user.userId, rol: user.rol, nombre: user.nombre, ip: ip ?? null };
  }

  private emitir(c: CambioPago | null) {
    if (c) emitirCambioDePago(this.realtime, c);
  }

  // ==================================================================
  // Cola
  // ==================================================================

  private whereDeGrupo(grupo: GrupoPago): Prisma.PedidoPagoTransferenciaWhereInput {
    // "Esperando" y "Vencidas" parten las instrucciones abiertas SIN comprobante por su vigencia:
    // cada pago está en una sola pestaña, y lo vencido es lo que pide una decisión.
    if (grupo === 'esperando') {
      return { estado: Estado.PENDIENTE, venceAt: { gte: new Date() } };
    }
    if (grupo === 'vencidas') {
      return { estado: Estado.PENDIENTE, venceAt: { lt: new Date() } };
    }
    if (grupo === 'requieren-revision') {
      return {
        requiereRevision: { not: null },
        estado: { in: [Estado.PENDIENTE, Estado.EN_REVISION, Estado.VERIFICADO] },
      };
    }
    return { estado: { in: GRUPOS[grupo] } };
  }

  async listar(query: ListarPagosQueryDto) {
    const grupo = query.grupo ?? 'por-revisar';
    const pagina = query.pagina ?? 1;
    const limite = query.limite ?? 20;
    const and: Prisma.PedidoPagoTransferenciaWhereInput[] = [this.whereDeGrupo(grupo)];
    if (query.tiendaId) and.push({ pedido: { tiendaId: query.tiendaId } });
    const q = query.q?.trim();
    if (q) {
      const texto = (): Prisma.StringFilter => ({ contains: q, mode: 'insensitive' });
      const or: Prisma.PedidoPagoTransferenciaWhereInput[] = [
        { referencia: { contains: q } },
        { claveRastreo: { contains: q.toUpperCase() } },
        { pedido: { numeroPedido: texto() } },
        { pedido: { clienteNombre: texto() } },
        { pedido: { clienteEmail: texto() } },
        { pedido: { clienteTelefono: { contains: q } } },
        { pedido: { pendienteEnvio: { externalFolio: texto() } } },
      ];
      if (/^\d+(\.\d{1,2})?$/.test(q)) or.push({ montoEsperado: new Prisma.Decimal(q) });
      and.push({ OR: or });
    }
    const where: Prisma.PedidoPagoTransferenciaWhereInput = { AND: and };

    const [filas, total] = await Promise.all([
      this.prisma.pedidoPagoTransferencia.findMany({
        where,
        // Lo que lleva más tiempo esperando va primero en las colas de trabajo.
        orderBy:
          grupo === 'por-revisar' || grupo === 'esperando'
            ? { updatedAt: 'asc' }
            : grupo === 'vencidas'
              ? { venceAt: 'asc' }
              : // Lo verificado que lleva más tiempo sin registrarse va PRIMERO: es lo que se olvida.
                grupo === 'verificados'
                ? { verificadoAt: 'asc' }
                : { id: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          pedido: {
            select: {
              id: true,
              numeroPedido: true,
              clienteNombre: true,
              estado: true,
              tienda: { select: { id: true, nombre: true } },
              pendienteEnvio: { select: { externalFolio: true } },
            },
          },
          _count: { select: { comprobantes: { where: { estado: EstadoComprobante.PENDIENTE } } } },
        },
      }),
      this.prisma.pedidoPagoTransferencia.count({ where }),
    ]);

    return {
      data: filas.map((p) => ({
        id: p.id,
        estado: p.estado,
        montoEsperado: p.montoEsperado.toString(),
        referencia: p.referencia,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        venceAt: p.venceAt,
        vencido:
          (p.estado === Estado.PENDIENTE || p.estado === Estado.EN_REVISION) &&
          p.venceAt.getTime() < Date.now(),
        requiereRevision: !!p.requiereRevision,
        verificadoAt: p.verificadoAt,
        // Verificada y sin registrar en VFP demasiado tiempo: se calcula al leer, no hay aviso aparte.
        atrasado:
          p.estado === Estado.VERIFICADO &&
          verificadoAtrasado(p.verificadoAt, this.horasSinRegistrar),
        comprobantesPendientes: p._count.comprobantes,
        pedido: {
          id: p.pedido.id,
          numeroPedido: p.pedido.numeroPedido,
          folioVfp: p.pedido.pendienteEnvio?.externalFolio ?? null,
          clienteNombre: p.pedido.clienteNombre,
          estado: p.pedido.estado,
          tienda: p.pedido.tienda,
        },
      })),
      meta: { total, pagina, limite, totalPaginas: Math.ceil(total / limite) },
    };
  }

  /** Contadores de un vistazo. */
  async resumen() {
    const contar = (grupo: GrupoPago) =>
      this.prisma.pedidoPagoTransferencia.count({ where: this.whereDeGrupo(grupo) });
    const [
      porRevisar,
      esperando,
      vencidas,
      verificados,
      verificadosAtrasados,
      reembolsos,
      requierenRevision,
    ] = await Promise.all([
      contar('por-revisar'),
      contar('esperando'),
      contar('vencidas'),
      contar('verificados'),
      this.prisma.pedidoPagoTransferencia.count({
        where: {
          estado: Estado.VERIFICADO,
          verificadoAt: { lt: new Date(Date.now() - this.horasSinRegistrar * 3_600_000) },
        },
      }),
      contar('reembolsos'),
      contar('requieren-revision'),
    ]);
    return {
      porRevisar,
      esperando,
      vencidas,
      verificados,
      verificadosAtrasados,
      reembolsos,
      requierenRevision,
    };
  }

  // ==================================================================
  // Detalle
  // ==================================================================

  private async cargarPago(pagoId: number) {
    const pago = await this.prisma.pedidoPagoTransferencia.findUnique({
      where: { id: pagoId },
      include: {
        comprobantes: {
          orderBy: { id: 'asc' },
          // Quién lo subió: caja puede subirlo en nombre del cliente y Tesorería lo ve marcado.
          include: { subidoPor: { select: { nombre: true, apellido: true, rol: true } } },
        },
        eventos: { orderBy: { id: 'asc' } },
        verificadoPor: { select: { id: true, nombre: true, apellido: true } },
        reembolsadoPor: { select: { id: true, nombre: true, apellido: true } },
        pedido: {
          select: {
            ...PEDIDO_PARA_PAGO,
            tienda: { select: { id: true, nombre: true, telefono: true } },
            usuario: { select: { telefono: true } },
            items: {
              where: { cancelada: false },
              select: {
                productoNombre: true,
                tallaNombre: true,
                colorNombre: true,
                cantidad: true,
                subtotal: true,
              },
              orderBy: { id: 'asc' },
              take: 100,
            },
          },
        },
      },
    });
    if (!pago) throw new NotFoundException('Pago no encontrado');
    return pago;
  }

  async detalle(pagoId: number) {
    let pago = await this.cargarPago(pagoId);
    // Red de seguridad si el enganche del cobro falló (ver `sanarSiYaSeCobro`).
    if ((await this.pagos.sanarSiYaSeCobro(pago, pago.pedido)) !== null) {
      pago = await this.cargarPago(pagoId);
    }
    const pedido = pago.pedido;
    const instrucciones = this.pagos.instruccionesDePago(pago, pedido);

    // ¿Estos archivos / claves ya se usaron en otro pago? Tesorería lo ve ANTES de aprobar.
    const hashes = pago.comprobantes.map((c) => c.sha256);
    const claves = pago.comprobantes
      .map((c) => c.claveRastreoDeclarada)
      .filter((c): c is string => !!c);
    const [mismosArchivos, mismasClaves] = await Promise.all([
      hashes.length
        ? this.prisma.pagoComprobante.findMany({
            where: { sha256: { in: hashes }, pagoId: { not: pagoId } },
            select: { pago: { select: { id: true, pedido: { select: { numeroPedido: true } } } } },
          })
        : [],
      claves.length
        ? this.prisma.pedidoPagoTransferencia.findMany({
            where: {
              claveRastreo: { in: claves },
              id: { not: pagoId },
              estado: {
                in: [
                  Estado.VERIFICADO,
                  Estado.APLICADO,
                  Estado.REEMBOLSO_PENDIENTE,
                  Estado.REEMBOLSADO,
                ],
              },
            },
            select: { id: true, pedido: { select: { numeroPedido: true } } },
          })
        : [],
    ]);

    // Un abono tardío (pago VENCIDO) no se puede verificar si el pedido ya tiene OTRO pago activo:
    // el índice parcial solo admite uno vivo. Se mira aquí para que el botón no sea un 409.
    const otroActivo =
      pago.estado === Estado.VENCIDO
        ? await this.prisma.pedidoPagoTransferencia.findFirst({
            where: {
              pedidoId: pago.pedidoId,
              id: { not: pagoId },
              estado: { in: [...ESTADOS_ACTIVOS] },
            },
            select: { id: true, estado: true },
          })
        : null;

    const advertencias: string[] = [];
    const enCurso = pago.estado === Estado.PENDIENTE || pago.estado === Estado.EN_REVISION;
    if (pago.estado === Estado.VENCIDO) {
      advertencias.push(
        otroActivo
          ? `Estas instrucciones vencieron y el cliente ya pidió otras (pago ${otroActivo.id}, ${otroActivo.estado}). Si el abono de este pago llegó, resuélvelo en ese.`
          : 'Estas instrucciones vencieron. Si el abono llegó después, se puede verificar igual: explica en la nota qué pasó.',
      );
    }
    if (enCurso && pago.venceAt.getTime() < Date.now()) {
      advertencias.push(
        'Las instrucciones ya vencieron. Un abono tardío se puede verificar igual.',
      );
    }
    if (pago.requiereRevision) advertencias.push(pago.requiereRevision);
    if (!pedido.total.equals(pago.montoEsperado) && enCurso) {
      advertencias.push(
        `El total del pedido ($${pedido.total.toString()}) ya no coincide con el monto que se le pidió al cliente ($${pago.montoEsperado.toString()}).`,
      );
    }
    for (const m of mismosArchivos) {
      advertencias.push(
        `Un comprobante idéntico ya se subió en el pago ${m.pago.id} (pedido ${m.pago.pedido.numeroPedido}).`,
      );
    }
    for (const m of mismasClaves) {
      advertencias.push(
        `Esa clave de rastreo ya pagó el pedido ${m.pedido.numeroPedido} (pago ${m.id}).`,
      );
    }
    for (const c of pago.comprobantes) {
      if (c.montoDeclarado && !c.montoDeclarado.equals(pago.montoEsperado)) {
        advertencias.push(
          `El cliente declaró $${c.montoDeclarado.toString()}, pero el pedido es de $${pago.montoEsperado.toString()}.`,
        );
      }
    }

    // Qué puede hacer Tesorería AHORA con este pago. Son las mismas guardas que aplican `aprobar`,
    // `rechazar`, `abonoSinPedido`, `registrarReembolso` y `resolverRevision`; viajan al frontend
    // para que la pantalla no reimplemente el mapa estado→acción (la regla que más fácil se
    // desincroniza al agregar un estado). El servidor sigue validando cada acción por su cuenta.
    const pedidoPagable = pedido.estado === EstadoPedido.PENDIENTE_PAGO;
    const acciones = {
      puedeAprobar:
        ESTADOS_QUE_SE_PUEDEN_APROBAR.includes(pago.estado) &&
        pedidoPagable &&
        !pago.requiereRevision &&
        !otroActivo &&
        pedido.total.equals(pago.montoEsperado),
      // Abono tardío: verificar un pago VENCIDO exige explicar qué pasó.
      aprobarRequiereNota: pago.estado === Estado.VENCIDO,
      // Cerrar por vencimiento: solo instrucciones abiertas SIN comprobante y ya pasadas de vigencia.
      // Con un comprobante en revisión puede haber dinero en camino: ahí se revisa, no se cierra.
      puedeVencer: pago.estado === Estado.PENDIENTE && pago.venceAt.getTime() < Date.now(),
      puedeRechazar: pago.estado === Estado.EN_REVISION,
      puedeRegistrarAbonoSinPedido:
        ESTADOS_ABONO_SIN_PEDIDO.includes(pago.estado) && !pedidoPagable,
      puedeReembolsar: pago.estado === Estado.REEMBOLSO_PENDIENTE,
      puedeResolverRevision: !!pago.requiereRevision && pedidoPagable,
      puedeReenviar: enCurso,
    };

    return {
      id: pago.id,
      estado: pago.estado,
      montoEsperado: pago.montoEsperado.toString(),
      referencia: pago.referencia,
      concepto: pago.concepto,
      cuenta: pago.cuentaSnapshot,
      venceAt: pago.venceAt,
      vencido: enCurso && pago.venceAt.getTime() < Date.now(),
      intentos: pago.intentos,
      requiereRevision: pago.requiereRevision,
      acciones,
      advertencias,
      // El mismo texto del correo y de la pantalla del cliente: para pegarlo en WhatsApp.
      instrucciones,
      pedido: {
        id: pedido.id,
        numeroPedido: pedido.numeroPedido,
        folioVfp: pedido.pendienteEnvio?.externalFolio ?? null,
        estado: pedido.estado,
        total: pedido.total.toString(),
        tienda: pedido.tienda,
        cliente: {
          nombre: pedido.clienteNombre,
          email: pedido.clienteEmail,
          telefono: pedido.clienteTelefono ?? pedido.usuario?.telefono ?? null,
        },
        items: pedido.items.map((i) => ({ ...i, subtotal: i.subtotal.toString() })),
      },
      comprobantes: pago.comprobantes.map((c) => ({
        id: c.id,
        estado: c.estado,
        mime: c.mime,
        bytes: c.bytes,
        createdAt: c.createdAt,
        montoDeclarado: c.montoDeclarado?.toString() ?? null,
        fechaDeclarada: c.fechaDeclarada,
        bancoEmisor: c.bancoEmisor,
        claveRastreoDeclarada: c.claveRastreoDeclarada,
        motivoRechazo: c.motivoRechazo,
        notaRechazo: c.notaRechazo,
        revisadoAt: c.revisadoAt,
        // Oct 2026: la tienda sube el comprobante de quien no puede. Es constancia, no un permiso:
        // sigue siendo Tesorería quien confirma en el banco que el dinero llegó.
        porTienda: c.subidoPor.rol !== 'CLIENTE',
        subidoPorNombre:
          c.subidoPor.rol !== 'CLIENTE'
            ? `${c.subidoPor.nombre}${c.subidoPor.apellido ? ' ' + c.subidoPor.apellido : ''}`
            : null,
      })),
      verificacion: pago.verificadoAt
        ? {
            monto: pago.montoVerificado?.toString() ?? null,
            abonoFecha: pago.abonoFecha,
            claveRastreo: pago.claveRastreo,
            por: pago.verificadoPor,
            at: pago.verificadoAt,
            nota: pago.notaVerificacion,
          }
        : null,
      aplicadoAt: pago.aplicadoAt,
      reembolso:
        pago.estado === Estado.REEMBOLSO_PENDIENTE || pago.estado === Estado.REEMBOLSADO
          ? {
              monto: pago.reembolsoMonto?.toString() ?? null,
              motivo: pago.reembolsoMotivo,
              referencia: pago.reembolsoRef,
              por: pago.reembolsadoPor,
              at: pago.reembolsadoAt,
            }
          : null,
      eventos: pago.eventos.map((e) => ({
        id: e.id,
        tipo: e.tipo,
        de: e.deEstado,
        a: e.aEstado,
        actor: e.actorNombre,
        actorRol: e.actorRol,
        detalle: e.detalle,
        createdAt: e.createdAt,
      })),
    };
  }

  // ==================================================================
  // Vencimiento (MANUAL por ahora)
  // ==================================================================

  /**
   * Cierra por vencimiento unas instrucciones que pasaron su vigencia sin que llegara nada.
   *
   * Es MANUAL a propósito (decisión del dueño, oct 2026): nada las vence solo. Quien lo pide es
   * Tesorería, mirando la pestaña "Vencidas". Cerrarla importa porque, mientras siga PENDIENTE, caja
   * ve "no cobres, hay una transferencia" aunque nadie vaya a transferir; al cerrarla caja puede
   * cobrar y el cliente puede pedir datos nuevos.
   *
   * Solo cierra lo que NO tiene dinero posible: un pago con comprobante (`EN_REVISION`) no se cierra
   * aunque haya pasado su vigencia, porque el dinero puede estar en camino. Un abono que llegue
   * después de cerrada se verifica igual (ver `aprobar`, abono tardío).
   *
   * Todo vive en `cerrarPorVencimiento`, sin nada de HTTP, para que el día que se automatice
   * (un proceso periódico) llame a lo mismo: solo cambia QUIÉN lo dispara.
   */
  async vencer(pagoId: number, user: UserContext, ip?: string | null) {
    const cambio = await this.cerrarPorVencimiento(pagoId, this.actorDe(user, ip));
    this.emitir(cambio);
    return this.detalle(pagoId);
  }

  /** "Cerrar todas las vencidas": cada una en su transacción; las que ya no aplican se omiten. */
  async cerrarVencidas(user: UserContext, ip?: string | null) {
    const candidatas = await this.prisma.pedidoPagoTransferencia.findMany({
      where: this.whereDeGrupo('vencidas'),
      orderBy: { venceAt: 'asc' },
      take: MAX_CIERRE_MASIVO,
      select: { id: true },
    });
    const actor = this.actorDe(user, ip);
    let cerradas = 0;
    let omitidas = 0;
    for (const { id } of candidatas) {
      try {
        this.emitir(await this.cerrarPorVencimiento(id, actor));
        cerradas++;
      } catch (err) {
        // Alguien la resolvió en medio (llegó un comprobante, la cerró otra persona): se omite.
        if (err instanceof ConflictException || err instanceof NotFoundException) {
          omitidas++;
          continue;
        }
        throw err;
      }
    }
    return { cerradas, omitidas, hayMas: candidatas.length === MAX_CIERRE_MASIVO };
  }

  private async cerrarPorVencimiento(pagoId: number, actor: ActorPago): Promise<CambioPago> {
    return this.prisma.$transaction(async (tx) => {
      const previo = await tx.pedidoPagoTransferencia.findUnique({
        where: { id: pagoId },
        select: { pedidoId: true },
      });
      if (!previo) throw new NotFoundException('Pago no encontrado');
      // Serializa con el comprobante que el cliente pueda estar subiendo y con la cancelación.
      await bloquearPedido(tx, previo.pedidoId);
      const pago = await tx.pedidoPagoTransferencia.findUniqueOrThrow({
        where: { id: pagoId },
        include: { pedido: { select: { tiendaId: true } } },
      });
      if (pago.estado === Estado.EN_REVISION) {
        throw new ConflictException(
          'Tiene un comprobante en revisión: puede haber dinero en camino. Revísalo o recházalo antes.',
        );
      }
      if (pago.estado !== Estado.PENDIENTE) {
        throw new ConflictException(`Este pago ya está ${pago.estado}.`);
      }
      const ahora = new Date();
      if (pago.venceAt.getTime() >= ahora.getTime()) {
        throw new ConflictException('Estas instrucciones todavía están vigentes.');
      }
      const r = await tx.pedidoPagoTransferencia.updateMany({
        // El estado y la vigencia van en el `where`: si llegó un comprobante entre la lectura y la
        // escritura, no se cierra (el pago ya no está PENDIENTE).
        where: { id: pagoId, estado: Estado.PENDIENTE, venceAt: { lt: ahora } },
        // Sin dinero posible, lo que decía "revisa si llegó el abono" ya no tiene qué revisar.
        data: { estado: Estado.VENCIDO, requiereRevision: null },
      });
      if (r.count !== 1)
        throw new ConflictException('Otra persona resolvió este pago al mismo tiempo.');
      await registrarEventoPago(tx, pagoId, {
        tipo: 'VENCIDO',
        de: Estado.PENDIENTE,
        a: Estado.VENCIDO,
        actor,
        detalle: { venceAt: pago.venceAt.toISOString(), manual: actor.rol !== 'SISTEMA' },
      });
      return {
        pagoId,
        pedidoId: previo.pedidoId,
        tiendaId: pago.pedido.tiendaId,
        estado: Estado.VENCIDO,
        requiereRevision: false,
      };
    });
  }

  // ==================================================================
  // Conciliación
  // ==================================================================

  /**
   * Reporte para cruzar contra el corte de caja de VFP.
   *
   * La nube no sabe CÓMO registró VFP un cobro (solo `FINALIZADA`), así que no puede detectar que
   * una transferencia verificada se registró como efectivo; este reporte es el cruce humano. Lista
   * cada pago por el día en que Tesorería lo VERIFICÓ (día del negocio, no de UTC), con su folio de
   * VFP, y totaliza por estado: lo que falta registrar en VFP salta a la vista.
   */
  async conciliacion(query: ConciliacionQueryDto) {
    const { desde, hasta, inicio, fin } = this.rangoDeConciliacion(query);
    const filas = await this.prisma.pedidoPagoTransferencia.findMany({
      where: {
        verificadoAt: { gte: inicio, lt: fin },
        ...(query.tiendaId ? { pedido: { tiendaId: query.tiendaId } } : {}),
      },
      orderBy: { verificadoAt: 'asc' },
      take: MAX_FILAS_CONCILIACION + 1,
      include: {
        verificadoPor: { select: { nombre: true, apellido: true } },
        pedido: {
          select: {
            numeroPedido: true,
            clienteNombre: true,
            tienda: { select: { id: true, nombre: true } },
            pendienteEnvio: { select: { externalFolio: true } },
          },
        },
      },
    });
    const truncado = filas.length > MAX_FILAS_CONCILIACION;
    const recorte = truncado ? filas.slice(0, MAX_FILAS_CONCILIACION) : filas;

    const datos: FilaConciliacion[] = recorte.map((p) => ({
      verificadoAt: p.verificadoAt,
      abonoFecha: p.abonoFecha,
      aplicadoAt: p.aplicadoAt,
      tienda: p.pedido.tienda.nombre,
      folioWeb: p.pedido.numeroPedido,
      folioVfp: p.pedido.pendienteEnvio?.externalFolio ?? null,
      cliente: p.pedido.clienteNombre,
      referencia: p.referencia,
      claveRastreo: p.claveRastreo,
      montoEsperado: p.montoEsperado.toFixed(2),
      montoVerificado: p.montoVerificado?.toFixed(2) ?? null,
      estado: p.estado,
      verificadoPor: p.verificadoPor
        ? `${p.verificadoPor.nombre} ${p.verificadoPor.apellido ?? ''}`.trim()
        : null,
    }));

    // Totales con Decimal (nunca number): es dinero.
    const cero = new Prisma.Decimal(0);
    const suma = (estados: Estado[]) =>
      recorte
        .filter((p) => estados.includes(p.estado))
        .reduce((acc, p) => acc.plus(p.montoVerificado ?? cero), cero);
    const porTienda = new Map<
      number,
      { tienda: string; verificado: Prisma.Decimal; sinRegistrar: Prisma.Decimal }
    >();
    for (const p of recorte) {
      const t = porTienda.get(p.pedido.tienda.id) ?? {
        tienda: p.pedido.tienda.nombre,
        verificado: cero,
        sinRegistrar: cero,
      };
      if (p.estado === Estado.VERIFICADO || p.estado === Estado.APLICADO) {
        t.verificado = t.verificado.plus(p.montoVerificado ?? cero);
      }
      if (p.estado === Estado.VERIFICADO)
        t.sinRegistrar = t.sinRegistrar.plus(p.montoVerificado ?? cero);
      porTienda.set(p.pedido.tienda.id, t);
    }

    return {
      desde,
      hasta,
      zonaHoraria: this.zonaHoraria,
      truncado,
      filas: datos.map((f) => ({
        ...f,
        // El JSON viaja con fechas ISO; la pantalla las formatea.
        verificadoAt: f.verificadoAt?.toISOString() ?? null,
        abonoFecha: f.abonoFecha?.toISOString() ?? null,
        aplicadoAt: f.aplicadoAt?.toISOString() ?? null,
      })),
      totales: {
        pagos: recorte.length,
        verificado: suma([Estado.VERIFICADO, Estado.APLICADO]).toFixed(2),
        registradoEnVfp: suma([Estado.APLICADO]).toFixed(2),
        // Lo que Tesorería verificó y la tienda todavía no cobró en VFP: lo que no debe quedarse.
        sinRegistrarEnVfp: suma([Estado.VERIFICADO]).toFixed(2),
        reembolsos: suma([Estado.REEMBOLSO_PENDIENTE, Estado.REEMBOLSADO]).toFixed(2),
      },
      porTienda: [...porTienda.values()].map((t) => ({
        tienda: t.tienda,
        verificado: t.verificado.toFixed(2),
        sinRegistrar: t.sinRegistrar.toFixed(2),
      })),
    };
  }

  /** El mismo reporte como CSV (con BOM, listo para Excel). */
  async conciliacionCsv(query: ConciliacionQueryDto) {
    const r = await this.conciliacion(query);
    const filas: FilaConciliacion[] = r.filas.map((f) => ({
      ...f,
      verificadoAt: f.verificadoAt ? new Date(f.verificadoAt) : null,
      abonoFecha: f.abonoFecha ? new Date(f.abonoFecha) : null,
      aplicadoAt: f.aplicadoAt ? new Date(f.aplicadoAt) : null,
    }));
    return {
      csv: construirCsv(filas, this.zonaHoraria),
      nombre: `conciliacion-${r.desde}_${r.hasta}.csv`,
    };
  }

  /** Valida el rango pedido y aplica los valores por omisión (los últimos 7 días del negocio). */
  private rangoDeConciliacion(q: ConciliacionQueryDto) {
    const zona = this.zonaHoraria;
    const hasta = q.hasta ?? hoyLocal(zona);
    const desde = q.desde ?? sumarDias(hasta, -6);
    if (!esFechaYmd(desde) || !esFechaYmd(hasta)) {
      throw new BadRequestException('Las fechas deben ser reales y con formato YYYY-MM-DD.');
    }
    if (desde > hasta) {
      throw new BadRequestException('"desde" no puede ser posterior a "hasta".');
    }
    if (sumarDias(desde, MAX_DIAS_CONCILIACION) < hasta) {
      throw new BadRequestException(`El rango máximo es de ${MAX_DIAS_CONCILIACION} días.`);
    }
    const { inicio, fin } = rangoDeDias(desde, hasta, zona);
    return { desde, hasta, inicio, fin };
  }

  // ==================================================================
  // Contacto con el cliente
  // ==================================================================

  async instrucciones(pagoId: number) {
    const pago = await this.cargarPago(pagoId);
    return this.pagos.instruccionesDePago(pago, pago.pedido);
  }

  /**
   * "No me llegó el correo". Reenvía las instrucciones al correo del pedido o a uno alterno que
   * dicte el cliente. Queda en la bitácora a qué correo (enmascarado) y quién lo pidió.
   */
  async reenviarInstrucciones(
    pagoId: number,
    dto: ReenviarInstruccionesDto,
    user: UserContext,
    ip?: string | null,
  ) {
    const pago = await this.cargarPago(pagoId);
    if (pago.estado !== Estado.PENDIENTE && pago.estado !== Estado.EN_REVISION) {
      throw new ConflictException('Solo se reenvían las instrucciones de un pago en curso.');
    }
    const destino = dto.email ?? pago.pedido.clienteEmail;
    await registrarEventoPago(this.prisma, pago.id, {
      tipo: 'INSTRUCCIONES_REENVIADAS',
      actor: this.actorDe(user, ip),
      detalle: { destino: enmascararEmail(destino), alterno: !!dto.email },
    });
    await this.pagos.correoInstrucciones(pago.id, dto.email);
    return { enviado: true, destino: enmascararEmail(destino) };
  }

  /** Sirve el archivo del comprobante. Cada vista queda en la bitácora. */
  async archivo(comprobanteId: number, user: UserContext, ip?: string | null) {
    const c = await this.prisma.pagoComprobante.findUnique({ where: { id: comprobanteId } });
    if (!c) throw new NotFoundException('Comprobante no encontrado');
    const { stream, bytes } = await this.storage.leer(c.archivoKey);
    await registrarEventoPago(this.prisma, c.pagoId, {
      tipo: 'COMPROBANTE_VISTO',
      actor: this.actorDe(user, ip),
      detalle: { comprobanteId: c.id },
    });
    return { stream, mime: c.mime, bytes: bytes ?? c.bytes };
  }

  // ==================================================================
  // Verificar
  // ==================================================================

  /**
   * Tesorería VIO el abono en el banco. Exige el monto EXACTO: un monto distinto no se "aprueba
   * con nota", se rechaza con su motivo (y lo que llegó de más o de menos se resuelve aparte).
   */
  async aprobar(pagoId: number, dto: AprobarPagoDto, user: UserContext, ip?: string | null) {
    const monto = aDecimal(dto.montoRecibido, 'montoRecibido');
    const abonoFecha = fechaDeAbono(dto.abonoFecha);
    const clave = claveRastreoNormalizada(dto.claveRastreo);
    let cambio: CambioPago;
    try {
      cambio = await this.prisma.$transaction(async (tx) => {
        const previo = await tx.pedidoPagoTransferencia.findUnique({
          where: { id: pagoId },
          select: { pedidoId: true },
        });
        if (!previo) throw new NotFoundException('Pago no encontrado');
        // Serializa con la cancelación / el cobro del pedido: se decide con el estado de AHORA.
        await bloquearPedido(tx, previo.pedidoId);
        const pago = await tx.pedidoPagoTransferencia.findUniqueOrThrow({
          where: { id: pagoId },
          include: { pedido: { select: { estado: true, total: true, tiendaId: true } } },
        });

        if (!ESTADOS_QUE_SE_PUEDEN_APROBAR.includes(pago.estado)) {
          throw new ConflictException(`Este pago ya está ${pago.estado}; no se puede aprobar.`);
        }
        if (pago.estado === Estado.VENCIDO) {
          if ((dto.nota?.trim().length ?? 0) < 5) {
            throw new BadRequestException(
              'Este pago está vencido: es un abono tardío. Explica en la nota qué pasó (mínimo 5 caracteres).',
            );
          }
          const otro = await tx.pedidoPagoTransferencia.findFirst({
            where: {
              pedidoId: previo.pedidoId,
              id: { not: pagoId },
              estado: { in: [...ESTADOS_ACTIVOS] },
            },
            select: { id: true, estado: true },
          });
          if (otro) {
            throw new ConflictException(
              `El cliente ya pidió otras instrucciones (pago ${otro.id}, ${otro.estado}). Si el abono llegó, verifícalo en ese pago.`,
            );
          }
        }
        if (pago.pedido.estado !== EstadoPedido.PENDIENTE_PAGO) {
          throw new ConflictException(
            `El pedido ya no está pendiente de pago (${pago.pedido.estado}). Si el abono sí llegó, ` +
              'regístralo como "abono sin pedido" para reembolsarlo.',
          );
        }
        if (pago.requiereRevision) {
          throw new ConflictException(
            `Hay algo por aclarar antes de aprobar: ${pago.requiereRevision}`,
          );
        }
        if (!pago.pedido.total.equals(pago.montoEsperado)) {
          throw new ConflictException(
            `El total del pedido ($${pago.pedido.total.toString()}) ya no coincide con el monto que se pidió ($${pago.montoEsperado.toString()}). Revísalo antes de aprobar.`,
          );
        }
        if (!monto.equals(pago.montoEsperado)) {
          throw new BadRequestException(
            `El monto recibido ($${monto.toString()}) no coincide con el esperado ($${pago.montoEsperado.toString()}). ` +
              'Rechaza el comprobante con el motivo "Monto distinto".',
          );
        }

        const r = await tx.pedidoPagoTransferencia.updateMany({
          where: {
            id: pagoId,
            estado: { in: ESTADOS_QUE_SE_PUEDEN_APROBAR },
            requiereRevision: null,
          },
          data: {
            estado: Estado.VERIFICADO,
            montoVerificado: monto,
            abonoFecha,
            claveRastreo: clave,
            verificadoPorId: user.userId,
            verificadoAt: new Date(),
            notaVerificacion: dto.nota ?? null,
          },
        });
        if (r.count !== 1) {
          throw new ConflictException('Otra persona resolvió este pago al mismo tiempo.');
        }
        await tx.pagoComprobante.updateMany({
          where: { pagoId, estado: EstadoComprobante.PENDIENTE },
          data: {
            estado: EstadoComprobante.ACEPTADO,
            revisadoPorId: user.userId,
            revisadoAt: new Date(),
          },
        });
        await registrarEventoPago(tx, pagoId, {
          tipo: 'VERIFICADO',
          de: pago.estado,
          a: Estado.VERIFICADO,
          actor: this.actorDe(user, ip),
          detalle: {
            monto: monto.toString(),
            claveRastreo: clave,
            abonoFecha: abonoFecha.toISOString(),
            ...(pago.estado === Estado.VENCIDO ? { tardio: true } : {}),
          },
        });
        return {
          pagoId,
          pedidoId: previo.pedidoId,
          tiendaId: pago.pedido.tiendaId,
          estado: Estado.VERIFICADO,
          requiereRevision: false,
        };
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(await this.mensajeClaveRepetida(clave));
      }
      throw err;
    }

    this.emitir(cambio);
    void this.correo(cambio.pedidoId, TipoNotificacion.TRANSFERENCIA_VERIFICADA);
    return this.detalle(pagoId);
  }

  private async mensajeClaveRepetida(clave: string | null): Promise<string> {
    const otro = clave
      ? await this.prisma.pedidoPagoTransferencia.findFirst({
          where: { claveRastreo: clave },
          select: { pedido: { select: { numeroPedido: true } } },
        })
      : null;
    return otro
      ? `Esa clave de rastreo ya pagó el pedido ${otro.pedido.numeroPedido}. Un mismo SPEI no puede pagar dos pedidos.`
      : 'Esa clave de rastreo ya se usó en otro pago.';
  }

  // ==================================================================
  // Rechazar
  // ==================================================================

  /**
   * El comprobante no sirve (ilegible, el abono no aparece, el monto no coincide…). Si el pedido
   * sigue pendiente de pago el cliente puede subir otro; si el pedido ya murió o se cobró en
   * caja, el pago se cierra (sin dinero).
   */
  async rechazar(pagoId: number, dto: RechazarPagoDto, user: UserContext, ip?: string | null) {
    if (dto.motivo === 'OTRO' && !dto.nota?.trim()) {
      throw new BadRequestException('Con el motivo "Otro" explica qué pasó en la nota.');
    }
    const resultado = await this.prisma.$transaction(async (tx) => {
      const previo = await tx.pedidoPagoTransferencia.findUnique({
        where: { id: pagoId },
        select: { pedidoId: true },
      });
      if (!previo) throw new NotFoundException('Pago no encontrado');
      await bloquearPedido(tx, previo.pedidoId);
      const pago = await tx.pedidoPagoTransferencia.findUniqueOrThrow({
        where: { id: pagoId },
        include: { pedido: { select: { estado: true, tiendaId: true } } },
      });
      if (pago.estado !== Estado.EN_REVISION) {
        throw new ConflictException(
          pago.estado === Estado.PENDIENTE
            ? 'Este pago no tiene comprobantes por revisar.'
            : `Este pago ya está ${pago.estado}.`,
        );
      }
      const pendientes = await tx.pagoComprobante.findMany({
        where: {
          pagoId,
          estado: EstadoComprobante.PENDIENTE,
          ...(dto.comprobanteId ? { id: dto.comprobanteId } : {}),
        },
        select: { id: true },
      });
      if (pendientes.length === 0) {
        throw new ConflictException('Ese comprobante ya no está por revisar.');
      }
      await tx.pagoComprobante.updateMany({
        where: { id: { in: pendientes.map((c) => c.id) }, estado: EstadoComprobante.PENDIENTE },
        data: {
          estado: EstadoComprobante.RECHAZADO,
          motivoRechazo: dto.motivo,
          notaRechazo: dto.nota ?? null,
          revisadoPorId: user.userId,
          revisadoAt: new Date(),
        },
      });
      const quedan = await tx.pagoComprobante.count({
        where: { pagoId, estado: EstadoComprobante.PENDIENTE },
      });
      const pedidoVivo = pago.pedido.estado === EstadoPedido.PENDIENTE_PAGO;

      let destino: Estado = Estado.EN_REVISION;
      if (quedan === 0) destino = pedidoVivo ? Estado.PENDIENTE : Estado.CANCELADO;

      const r = await tx.pedidoPagoTransferencia.updateMany({
        where: { id: pagoId, estado: Estado.EN_REVISION },
        data: {
          estado: destino,
          intentos: { increment: pendientes.length },
          // Si el pedido ya no existe como pagable, la bandera que decía "revisa si llegó el
          // abono" queda resuelta por esta decisión.
          ...(pedidoVivo ? {} : { requiereRevision: null }),
        },
      });
      if (r.count !== 1)
        throw new ConflictException('Otra persona resolvió este pago al mismo tiempo.');
      await registrarEventoPago(tx, pagoId, {
        tipo: 'COMPROBANTE_RECHAZADO',
        de: Estado.EN_REVISION,
        a: destino,
        actor: this.actorDe(user, ip),
        detalle: {
          motivo: dto.motivo,
          nota: dto.nota ?? null,
          comprobantes: pendientes.map((c) => c.id),
        },
      });
      return {
        cambio: {
          pagoId,
          pedidoId: previo.pedidoId,
          tiendaId: pago.pedido.tiendaId,
          estado: destino,
          requiereRevision: !!pago.requiereRevision && pedidoVivo,
        } as CambioPago,
        pedidoVivo,
      };
    });

    this.emitir(resultado.cambio);
    // Al cliente solo se le avisa si todavía puede hacer algo: subir otro comprobante.
    if (resultado.pedidoVivo) {
      const base = MOTIVOS_RECHAZO[dto.motivo as MotivoRechazo];
      void this.correo(resultado.cambio.pedidoId, TipoNotificacion.TRANSFERENCIA_RECHAZADA, {
        detalle: dto.motivo === 'OTRO' && dto.nota ? `${base} ${dto.nota}` : base,
      });
    }
    return this.detalle(pagoId);
  }

  // ==================================================================
  // Dinero sin pedido
  // ==================================================================

  /**
   * Llegó dinero y el pedido ya no está pendiente de pago (se canceló, se cobró en caja, o el
   * abono llegó tarde). El dinero no se ignora: queda como reembolso pendiente.
   */
  async abonoSinPedido(
    pagoId: number,
    dto: AbonoSinPedidoDto,
    user: UserContext,
    ip?: string | null,
  ) {
    const monto = aDecimal(dto.montoRecibido, 'montoRecibido');
    const abonoFecha = fechaDeAbono(dto.abonoFecha);
    const clave = claveRastreoNormalizada(dto.claveRastreo);
    let cambio: CambioPago;
    try {
      cambio = await this.prisma.$transaction(async (tx) => {
        const previo = await tx.pedidoPagoTransferencia.findUnique({
          where: { id: pagoId },
          select: { pedidoId: true },
        });
        if (!previo) throw new NotFoundException('Pago no encontrado');
        await bloquearPedido(tx, previo.pedidoId);
        const pago = await tx.pedidoPagoTransferencia.findUniqueOrThrow({
          where: { id: pagoId },
          include: { pedido: { select: { estado: true, tiendaId: true } } },
        });
        const origenes = ESTADOS_ABONO_SIN_PEDIDO;
        if (!origenes.includes(pago.estado)) {
          throw new ConflictException(`Este pago ya está ${pago.estado}.`);
        }
        if (pago.pedido.estado === EstadoPedido.PENDIENTE_PAGO) {
          throw new ConflictException(
            'El pedido sigue pendiente de pago: usa "Aprobar" para verificar la transferencia.',
          );
        }
        const r = await tx.pedidoPagoTransferencia.updateMany({
          where: { id: pagoId, estado: { in: origenes } },
          data: {
            estado: Estado.REEMBOLSO_PENDIENTE,
            montoVerificado: monto,
            abonoFecha,
            claveRastreo: clave,
            verificadoPorId: user.userId,
            verificadoAt: new Date(),
            notaVerificacion: dto.nota,
            reembolsoMonto: monto,
            reembolsoMotivo: dto.nota,
            requiereRevision: null,
          },
        });
        if (r.count !== 1)
          throw new ConflictException('Otra persona resolvió este pago al mismo tiempo.');
        await tx.pagoComprobante.updateMany({
          where: { pagoId, estado: EstadoComprobante.PENDIENTE },
          data: {
            estado: EstadoComprobante.ACEPTADO,
            revisadoPorId: user.userId,
            revisadoAt: new Date(),
          },
        });
        await registrarEventoPago(tx, pagoId, {
          tipo: 'ABONO_SIN_PEDIDO',
          de: pago.estado,
          a: Estado.REEMBOLSO_PENDIENTE,
          actor: this.actorDe(user, ip),
          detalle: { monto: monto.toString(), claveRastreo: clave, pedido: pago.pedido.estado },
        });
        return {
          pagoId,
          pedidoId: previo.pedidoId,
          tiendaId: pago.pedido.tiendaId,
          estado: Estado.REEMBOLSO_PENDIENTE,
          requiereRevision: false,
          alerta: 'Hay un abono que reembolsar.',
        };
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        throw new ConflictException(
          (await this.mensajeClaveRepetida(clave)) +
            ' (o el pedido ya tiene otro pago activo que hay que resolver primero).',
        );
      }
      throw err;
    }
    this.emitir(cambio);
    return this.detalle(pagoId);
  }

  /** Se devolvió el dinero. */
  async registrarReembolso(
    pagoId: number,
    dto: RegistrarReembolsoDto,
    user: UserContext,
    ip?: string | null,
  ) {
    const cambio = await this.prisma.$transaction(async (tx) => {
      const pago = await tx.pedidoPagoTransferencia.findUnique({
        where: { id: pagoId },
        include: { pedido: { select: { tiendaId: true } } },
      });
      if (!pago) throw new NotFoundException('Pago no encontrado');
      if (pago.estado !== Estado.REEMBOLSO_PENDIENTE) {
        throw new ConflictException('Este pago no tiene un reembolso pendiente.');
      }
      const r = await tx.pedidoPagoTransferencia.updateMany({
        where: { id: pagoId, estado: Estado.REEMBOLSO_PENDIENTE },
        data: {
          estado: Estado.REEMBOLSADO,
          reembolsoRef: dto.referencia,
          reembolsadoPorId: user.userId,
          reembolsadoAt: new Date(),
        },
      });
      if (r.count !== 1)
        throw new ConflictException('Otra persona resolvió este pago al mismo tiempo.');
      await registrarEventoPago(tx, pagoId, {
        tipo: 'REEMBOLSADO',
        de: Estado.REEMBOLSO_PENDIENTE,
        a: Estado.REEMBOLSADO,
        actor: this.actorDe(user, ip),
        detalle: {
          referencia: dto.referencia,
          nota: dto.nota ?? null,
          monto: pago.reembolsoMonto?.toString() ?? null,
        },
      });
      return {
        pagoId,
        pedidoId: pago.pedidoId,
        tiendaId: pago.pedido.tiendaId,
        estado: Estado.REEMBOLSADO,
        requiereRevision: false,
      } as CambioPago;
    });
    this.emitir(cambio);
    void this.correo(cambio.pedidoId, TipoNotificacion.TRANSFERENCIA_REEMBOLSADA, {
      detalle: `Referencia de la devolución: ${dto.referencia}`,
    });
    return this.detalle(pagoId);
  }

  /**
   * Se aclaró lo que tenía el pago bloqueado (p. ej. el total que cambió en VFP). Solo aplica si
   * el pedido SIGUE pendiente de pago; si ya murió o se cobró, la bandera se resuelve con
   * "rechazar" o "abono sin pedido", que son decisiones sobre el dinero.
   */
  async resolverRevision(
    pagoId: number,
    dto: ResolverRevisionDto,
    user: UserContext,
    ip?: string | null,
  ) {
    const cambio = await this.prisma.$transaction(async (tx) => {
      const previo = await tx.pedidoPagoTransferencia.findUnique({
        where: { id: pagoId },
        select: { pedidoId: true },
      });
      if (!previo) throw new NotFoundException('Pago no encontrado');
      await bloquearPedido(tx, previo.pedidoId);
      const pago = await tx.pedidoPagoTransferencia.findUniqueOrThrow({
        where: { id: pagoId },
        include: { pedido: { select: { estado: true, tiendaId: true } } },
      });
      if (!pago.requiereRevision)
        throw new ConflictException('Este pago no tiene nada por aclarar.');
      if (pago.pedido.estado !== EstadoPedido.PENDIENTE_PAGO) {
        throw new ConflictException(
          'El pedido ya no está pendiente de pago: resuélvelo rechazando el comprobante (si no llegó dinero) o registrando el abono sin pedido (si llegó).',
        );
      }
      const r = await tx.pedidoPagoTransferencia.updateMany({
        where: { id: pagoId, requiereRevision: { not: null } },
        data: { requiereRevision: null },
      });
      if (r.count !== 1) throw new ConflictException('Otra persona resolvió esto al mismo tiempo.');
      await registrarEventoPago(tx, pagoId, {
        tipo: 'REVISION_RESUELTA',
        de: pago.estado,
        a: pago.estado,
        actor: this.actorDe(user, ip),
        detalle: { nota: dto.nota, eraDe: pago.requiereRevision },
      });
      return {
        pagoId,
        pedidoId: previo.pedidoId,
        tiendaId: pago.pedido.tiendaId,
        estado: pago.estado,
        requiereRevision: false,
      } as CambioPago;
    });
    this.emitir(cambio);
    return this.detalle(pagoId);
  }

  // ==================================================================

  private async correo(
    pedidoId: number,
    tipo: Extract<TipoNotificacion, `TRANSFERENCIA_${string}`>,
    datos: { detalle?: string } = {},
  ) {
    try {
      const pedido = await this.prisma.pedido.findUniqueOrThrow({ where: { id: pedidoId } });
      await this.notifications.enviarTransferencia(pedido, tipo, datos);
    } catch (err) {
      this.logger.error(`Correo ${tipo} del pedido ${pedidoId}: ${(err as Error).message}`);
    }
  }
}
