import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt } from 'crypto';
import {
  EstadoComprobante,
  EstadoPagoTransferencia as Estado,
  EstadoPedido,
  MetodoPago,
  Prisma,
  RolUsuario,
  TipoNotificacion,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PedidoAccessService } from '../../pedidos/core/pedido-access.service';
import { yaFueCobrado } from '../../pedidos/core/cobro.util';
import { UserContext } from '../../../types/pedido.types';
import { CuentasBancariasService } from '../cuentas/cuentas-bancarias.service';
import { ComprobanteStorageService } from './comprobante-storage.service';
import { SubirComprobanteDto } from './dto/pago.dto';
import {
  ActorPago,
  CambioPago,
  emitirCambioDePago,
  pagoActivoDe,
  registrarEventoPago,
  resolverPagoAlCobrarse,
  ACTOR_SISTEMA,
} from './hooks';
import {
  ConfigPagos,
  PEDIDO_PARA_PAGO,
  PedidoParaPago,
  aDecimal,
  bloquearPedido,
  instruccionesDeUnPago,
  lineasParaCorreo,
} from './pago-comun';
import {
  ESTADOS_ACTIVOS,
  MAX_COMPROBANTES_PENDIENTES,
  MAX_COMPROBANTES_POR_PAGO,
  MOTIVOS_RECHAZO,
  MotivoRechazo,
  hayPagoVivo,
  mensajeParaCaja,
  mensajeParaCliente,
  transferenciaDisponible,
} from './reglas';
import { detectarMimeComprobante } from './validar-comprobante.util';

const nombreCompleto = (u: { nombre: string; apellido: string | null }) =>
  `${u.nombre}${u.apellido ? ' ' + u.apellido : ''}`;

const PAGO_CON_COMPROBANTES = {
  comprobantes: {
    orderBy: { id: 'asc' as const },
    // Quién lo subió: la tienda puede subirlo en nombre del cliente (oct 2026), y Tesorería y la
    // propia caja deben poder distinguirlo del que subió el cliente.
    include: { subidoPor: { select: { nombre: true, apellido: true, rol: true } } },
  },
};

/**
 * Pago por transferencia: lo que hacen el CLIENTE y la TIENDA (emitir instrucciones, subir un
 * comprobante, cambiar a pago en tienda, ver el estado). Lo que hace TESORERÍA vive en
 * `TesoreriaService`.
 *
 * Principio rector (ver PLAN-PAGOS-TRANSFERENCIA.md): `PAGADO` sigue naciendo SOLO de VFP. Nada de
 * aquí cambia el `EstadoPedido`, ni toca la cola hacia Firebird.
 */
@Injectable()
export class PagoTransferenciaService {
  private readonly logger = new Logger(PagoTransferenciaService.name);
  readonly cfg: ConfigPagos;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly access: PedidoAccessService,
    private readonly cuentas: CuentasBancariasService,
    private readonly storage: ComprobanteStorageService,
  ) {
    this.cfg = {
      zonaHoraria: this.config.get<string>('app.pagos.zonaHoraria') ?? 'America/Mexico_City',
      frontendUrl: this.config.get<string>('app.mail.frontendUrl') ?? '',
      venceHoras: this.config.get<number>('app.pagos.transferenciaVenceHoras') ?? 48,
    };
  }

  // ==================================================================
  // Acceso
  // ==================================================================

  /**
   * El cliente solo ve SU pedido (404, no 403: no se confirma que exista el de otro). El
   * personal pasa por `PedidoAccessService` (tienda del JWT; ADMIN cualquiera).
   */
  private async pedidoAccesible(pedidoId: number, user: UserContext): Promise<PedidoParaPago> {
    if (user.rol === RolUsuario.CLIENTE) {
      const p = await this.prisma.pedido.findFirst({
        where: { id: pedidoId, usuarioId: user.userId },
        select: PEDIDO_PARA_PAGO,
      });
      if (!p) throw new NotFoundException('Pedido no encontrado');
      return p;
    }
    await this.access.cargarYValidar(pedidoId, user);
    return this.pedidoPorId(pedidoId);
  }

  private async pedidoPorId(pedidoId: number): Promise<PedidoParaPago> {
    const p = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: PEDIDO_PARA_PAGO,
    });
    if (!p) throw new NotFoundException('Pedido no encontrado');
    return p;
  }

  private actorDe(user: UserContext, ip?: string | null): ActorPago {
    return { id: user.userId || null, rol: user.rol, nombre: user.nombre, ip: ip ?? null };
  }

  private emitir(cambio: CambioPago | null) {
    if (cambio) emitirCambioDePago(this.realtime, cambio);
  }

  /** El pago vivo, o si no hay, el más reciente (para mostrar APLICADO / CANCELADO / REEMBOLSADO). */
  private async pagoRelevante(pedidoId: number) {
    const include = PAGO_CON_COMPROBANTES;
    const activo = await this.prisma.pedidoPagoTransferencia.findFirst({
      where: { pedidoId, estado: { in: [...ESTADOS_ACTIVOS] } },
      include,
    });
    if (activo) return activo;
    // Un pago APLICADO no es "activo" (el pedido ya está pagado) pero es el que hay que mostrar.
    return this.prisma.pedidoPagoTransferencia.findFirst({
      where: { pedidoId },
      orderBy: { id: 'desc' },
      include,
    });
  }

  // ==================================================================
  // Lectura
  // ==================================================================

  /**
   * ¿Se pueden emitir instrucciones ahora? Pedido transferible, sin un pago vivo, y con una cuenta
   * bancaria activa (la de la tienda o la global). Una sola decisión para el cliente y la tienda.
   * Solo consulta las cuentas si todo lo demás ya dio que sí.
   */
  private async puedeEmitir(
    pedido: Pick<PedidoParaPago, 'tiendaId'>,
    disp: { disponible: boolean },
    pago: { estado: Estado } | null,
  ): Promise<{ puede: boolean; motivo: string | null }> {
    if (!disp.disponible || hayPagoVivo(pago)) return { puede: false, motivo: null };
    if (!(await this.cuentas.hayCuentaVigente(pedido.tiendaId))) {
      return {
        puede: false,
        motivo: 'El pago por transferencia todavía no está configurado. Paga en tienda.',
      };
    }
    return { puede: true, motivo: null };
  }

  /** Lo que ve el CLIENTE en su pedido. */
  async obtenerParaCliente(pedidoId: number, user: UserContext) {
    const pedido = await this.pedidoAccesible(pedidoId, user);
    const pago = await this.pagoRelevante(pedidoId);
    const disp = transferenciaDisponible(pedido);
    const vigente = pago ? this.vistaCliente(pago, pedido) : null;
    const emision = await this.puedeEmitir(pedido, disp, pago);
    return {
      pedidoId,
      metodoPagoPreferido: pedido.metodoPagoPreferido,
      // El frontend NO repite la regla: la decide este endpoint.
      puedePagarPorTransferencia: disp.disponible || !!vigente?.instrucciones,
      // ¿Se pueden pedir los datos AHORA? Distinto de lo anterior: con un pago ya VERIFICADO el
      // pedido sigue siendo "transferible" pero pedir datos no tiene sentido (devolvería el mismo
      // pago). Sí se puede de nuevo tras cambiar a tienda o cuando venció, porque ya no hay pago
      // vivo. Y no se ofrece si no hay cuenta bancaria activa: sería un botón que da 409.
      puedePedirDatos: emision.puede,
      // ¿El cliente está pagando por transferencia AHORA? (instrucciones abiertas, comprobante en
      // revisión o dinero ya verificado). Lo usa el detalle del pedido para no decirle "pasa a
      // caja a pagar" a quien ya está transfiriendo: el frontend no deduce esto del estado.
      transferenciaEnCurso: hayPagoVivo(pago),
      motivoNoDisponible: vigente ? null : (emision.motivo ?? disp.motivo),
      pago: vigente,
    };
  }

  private vistaCliente(
    pago: Prisma.PedidoPagoTransferenciaGetPayload<{ include: typeof PAGO_CON_COMPROBANTES }>,
    pedido: PedidoParaPago,
  ) {
    const enCurso = pago.estado === Estado.PENDIENTE || pago.estado === Estado.EN_REVISION;
    const pendientes = pago.comprobantes.filter((c) => c.estado === EstadoComprobante.PENDIENTE);
    const pedidoPagable = pedido.estado === EstadoPedido.PENDIENTE_PAGO;
    return {
      id: pago.id,
      estado: pago.estado,
      mensaje: mensajeParaCliente(pago.estado),
      montoEsperado: pago.montoEsperado.toString(),
      referencia: pago.referencia,
      concepto: pago.concepto,
      venceAt: pago.venceAt,
      vencido: enCurso && pago.venceAt.getTime() < Date.now(),
      // Las instrucciones se ven mientras haya algo que pagar.
      instrucciones: enCurso ? instruccionesDeUnPago(pago, pedido, this.cfg) : null,
      comprobantes: pago.comprobantes.map((c) => ({
        id: c.id,
        estado: c.estado,
        mime: c.mime,
        createdAt: c.createdAt,
        motivoRechazo: c.motivoRechazo ? this.textoMotivo(c.motivoRechazo, c.notaRechazo) : null,
      })),
      puedeSubirComprobante:
        enCurso && pedidoPagable && pendientes.length < MAX_COMPROBANTES_PENDIENTES,
      puedeCambiarATienda: pago.estado === Estado.PENDIENTE && pedidoPagable,
    };
  }

  private textoMotivo(codigo: string, nota?: string | null): string {
    const base = MOTIVOS_RECHAZO[codigo as MotivoRechazo] ?? MOTIVOS_RECHAZO.OTRO;
    return nota?.trim() && codigo === 'OTRO' ? `${base} ${nota.trim()}` : base;
  }

  /**
   * Lo que ven CAJA y MOSTRADOR de un pedido de su tienda: qué hacer con el cobro. El texto lo
   * decide el servidor (`mensajeParaCaja`) para que el frontend no lo reescriba.
   */
  async resumenParaTienda(pedidoId: number, user: UserContext) {
    const pedido = await this.pedidoAccesible(pedidoId, user);
    let pago = await this.pagoRelevante(pedidoId);
    pago = (await this.sanarSiYaSeCobro(pago, pedido)) ?? pago;
    const disp = transferenciaDisponible(pedido);
    const emision = await this.puedeEmitir(pedido, disp, pago);
    const enCurso =
      !!pago && (pago.estado === Estado.PENDIENTE || pago.estado === Estado.EN_REVISION);
    const pedidoPagable = pedido.estado === EstadoPedido.PENDIENTE_PAGO;
    const pendientes = (pago?.comprobantes ?? []).filter(
      (c) => c.estado === EstadoComprobante.PENDIENTE,
    );
    return {
      pedidoId,
      metodoPagoPreferido: pedido.metodoPagoPreferido,
      // Antes `!pago?.estado`: tras "pagar en tienda" (pago CANCELADO) o un vencimiento, el
      // mostrador ya no podía dar los datos aunque `emitirInstrucciones` sí crea uno nuevo.
      // Lo que bloquea es un pago VIVO, no que haya habido alguno.
      puedeEnviarDatos: emision.puede,
      motivoNoDisponible: emision.motivo ?? (disp.disponible ? null : disp.motivo),
      pago: pago
        ? {
            id: pago.id,
            estado: pago.estado,
            montoEsperado: pago.montoEsperado.toString(),
            referencia: pago.referencia,
            venceAt: pago.venceAt,
            vencido:
              (pago.estado === Estado.PENDIENTE || pago.estado === Estado.EN_REVISION) &&
              pago.venceAt.getTime() < Date.now(),
            requiereRevision: !!pago.requiereRevision,
            verificadoAt: pago.verificadoAt,
            folioVfp: pedido.pendienteEnvio?.externalFolio ?? null,
            caja: mensajeParaCaja(pago.estado, { vencido: pago.venceAt.getTime() < Date.now() }),
            // Mismas guardas que `cambiarATienda`: solo mientras no haya comprobante (dinero en
            // camino) y el pedido siga por pagarse. La pantalla no ofrece un botón que daría 409.
            puedeCambiarATienda:
              pago.estado === Estado.PENDIENTE && pedido.estado === EstadoPedido.PENDIENTE_PAGO,
            // Oct 2026: la cajera sube el comprobante en nombre del cliente (foto con la tablet).
            // Misma guarda que `subirComprobante`: transferencia abierta, pedido por pagarse y sin
            // tres comprobantes ya esperando revisión. El servidor lo dice; la pantalla no lo deduce.
            puedeSubirComprobante:
              enCurso && pedidoPagable && pendientes.length < MAX_COMPROBANTES_PENDIENTES,
            // Los comprobantes ya subidos (sin el archivo: solo cuántos, de quién y en qué van), para que
            // la cajera vea "ya hay uno en revisión" y no suba el mismo dos veces.
            comprobantes: pago.comprobantes.map((c) => ({
              id: c.id,
              estado: c.estado,
              createdAt: c.createdAt,
              porTienda: c.subidoPor.rol !== RolUsuario.CLIENTE,
              subidoPorNombre:
                c.subidoPor.rol !== RolUsuario.CLIENTE ? nombreCompleto(c.subidoPor) : null,
            })),
            // Los datos para transferir (banco, titular, CLABE, monto exacto, referencia), para que
            // la cajera los MUESTRE o DICTE a quien no tiene el correo —el mandadero, el cliente sin
            // internet—. Antes solo existían en el correo. Solo se dan mientras haya algo que pagar.
            // NUNCA va a una TV: esta vista es autenticada y solo de CAJERO.
            datosParaTransferir: enCurso ? instruccionesDeUnPago(pago, pedido, this.cfg) : null,
          }
        : null,
    };
  }

  /**
   * Red de seguridad: si el pedido ya está cobrado pero su pago sigue VERIFICADO (el enganche del
   * cobro falló, o el evento llegó mientras se reiniciaba el servidor), se corrige al mirarlo en
   * vez de mostrar una contradicción. Nunca lanza.
   */
  async sanarSiYaSeCobro<T extends { id: number; estado: Estado; pedidoId: number }>(
    pago: T | null,
    pedido: Pick<PedidoParaPago, 'estado'>,
  ): Promise<T | null> {
    if (!pago || pago.estado !== Estado.VERIFICADO || !yaFueCobrado(pedido.estado)) return null;
    try {
      const cambio = await resolverPagoAlCobrarse(this.prisma, pago.pedidoId, ACTOR_SISTEMA);
      this.emitir(cambio);
      if (cambio) return { ...pago, estado: cambio.estado };
    } catch (err) {
      this.logger.warn(`No se pudo sanar el pago ${pago.id}: ${(err as Error).message}`);
    }
    return null;
  }

  // ==================================================================
  // Emitir instrucciones
  // ==================================================================

  /**
   * Da las instrucciones de transferencia de un pedido `PENDIENTE_PAGO`. Idempotente: si ya hay
   * un pago vivo, lo devuelve (dos clics, o cliente y mostrador a la vez, dan el mismo pago).
   * Lo pueden pedir el cliente o el personal de la tienda a su nombre.
   */
  async emitirInstrucciones(pedidoId: number, user: UserContext, ip?: string | null) {
    const pedido = await this.pedidoAccesible(pedidoId, user);

    const existente = await pagoActivoDe(this.prisma, pedidoId);
    if (existente) return this.obtenerParaCliente(pedidoId, user);

    const disp = transferenciaDisponible(pedido);
    if (!disp.disponible) throw new BadRequestException(disp.motivo);

    const cuenta = await this.cuentas.cuentaVigenteParaTienda(pedido.tiendaId);
    const actor = this.actorDe(user, ip);
    const concepto = pedido.numeroPedido.replace(/[^A-Za-z0-9]/g, '').slice(0, 30);

    for (let intento = 0; intento < 5; intento++) {
      try {
        const pago = await this.prisma.$transaction(async (tx) => {
          // Serializa con la cancelación del pedido (ver `bloquearPedido`).
          await bloquearPedido(tx, pedidoId);
          const vivo = await tx.pedido.findUniqueOrThrow({
            where: { id: pedidoId },
            select: { estado: true },
          });
          if (vivo.estado !== EstadoPedido.PENDIENTE_PAGO) {
            throw new ConflictException('El pedido cambió de estado. Actualiza la pantalla.');
          }
          const creado = await tx.pedidoPagoTransferencia.create({
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
              referencia: String(randomInt(1_000_000, 10_000_000)),
              concepto,
              venceAt: new Date(Date.now() + this.cfg.venceHoras * 3_600_000),
              creadoPorId: user.userId || null,
              creadoPorRol: user.rol,
            },
          });
          await registrarEventoPago(tx, creado.id, {
            tipo: 'INSTRUCCIONES_EMITIDAS',
            a: Estado.PENDIENTE,
            actor,
            detalle: {
              cuentaId: cuenta.id,
              monto: pedido.total.toString(),
              enNombreDelCliente: user.rol !== RolUsuario.CLIENTE,
            },
          });
          // Es la preferencia más reciente y verdadera del cliente.
          await tx.pedido.update({
            where: { id: pedidoId },
            data: { metodoPagoPreferido: MetodoPago.TRANSFERENCIA },
          });
          return creado;
        });

        this.emitir({
          pagoId: pago.id,
          pedidoId,
          tiendaId: pedido.tiendaId,
          estado: pago.estado,
          requiereRevision: false,
        });
        void this.correoInstrucciones(pago.id).catch((e) =>
          this.logger.error(`Correo de instrucciones del pago ${pago.id}: ${e.message}`),
        );
        return this.obtenerParaCliente(pedidoId, user);
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
        // P2002 es: otro proceso emitió primero (índice de pago único activo) o la referencia al
        // azar chocó (1 en 9 millones). En el primer caso se devuelve el que ganó; en el
        // segundo se reintenta con otra referencia.
        const ganador = await pagoActivoDe(this.prisma, pedidoId);
        if (ganador) return this.obtenerParaCliente(pedidoId, user);
      }
    }
    throw new ConflictException('No se pudo generar una referencia única. Inténtalo de nuevo.');
  }

  /** Correo con las instrucciones (al emitir, o al reenviarlas desde Tesorería). */
  async correoInstrucciones(pagoId: number, destinatario?: string) {
    const pago = await this.prisma.pedidoPagoTransferencia.findUniqueOrThrow({
      where: { id: pagoId },
    });
    const pedido = await this.pedidoPorId(pago.pedidoId);
    const pedidoCompleto = await this.prisma.pedido.findUniqueOrThrow({ where: { id: pedido.id } });
    const i = instruccionesDeUnPago(pago, pedido, this.cfg);
    await this.notifications.enviarTransferencia(
      pedidoCompleto,
      TipoNotificacion.TRANSFERENCIA_INSTRUCCIONES,
      { lineas: lineasParaCorreo(i), notas: i.notas, destinatario, textFallback: i.texto },
    );
  }

  // ==================================================================
  // Cambiar a pago en tienda
  // ==================================================================

  /**
   * "Mejor pago en tienda". Solo mientras NO haya dinero en juego: con un comprobante enviado,
   * la transferencia pudo llegar y cobrar en caja sería doble pago.
   */
  async cambiarATienda(pedidoId: number, user: UserContext, ip?: string | null) {
    const pedido = await this.pedidoAccesible(pedidoId, user);
    const pago = await pagoActivoDe(this.prisma, pedidoId);
    if (!pago) {
      throw new BadRequestException('Este pedido no tiene una transferencia en curso.');
    }
    if (pago.estado === Estado.EN_REVISION) {
      throw new ConflictException(
        'Ya enviaste un comprobante. Tesorería está confirmando si el abono llegó; hasta entonces no se puede cambiar la forma de pago.',
      );
    }
    if (pago.estado === Estado.VERIFICADO) {
      throw new ConflictException(
        'Tu transferencia ya fue verificada, así que el pedido se pagará con ella. Si necesitas pagarlo de otra forma, pide en mostrador que revisen tu caso con Tesorería.',
      );
    }
    if (pago.estado !== Estado.PENDIENTE) {
      throw new ConflictException('Este pago ya no se puede cambiar.');
    }

    await this.prisma.$transaction(async (tx) => {
      const r = await tx.pedidoPagoTransferencia.updateMany({
        where: { id: pago.id, estado: Estado.PENDIENTE },
        data: { estado: Estado.CANCELADO },
      });
      // Si alguien subió un comprobante en este instante, ya hay dinero en juego: no se cancela.
      if (r.count !== 1) {
        throw new ConflictException(
          'El pago cambió mientras lo procesábamos. Actualiza la pantalla.',
        );
      }
      await registrarEventoPago(tx, pago.id, {
        tipo: 'CAMBIO_A_PAGO_EN_TIENDA',
        de: Estado.PENDIENTE,
        a: Estado.CANCELADO,
        actor: this.actorDe(user, ip),
      });
      await tx.pedido.update({
        where: { id: pedidoId },
        data: { metodoPagoPreferido: MetodoPago.EN_TIENDA },
      });
    });
    this.emitir({
      pagoId: pago.id,
      pedidoId,
      tiendaId: pedido.tiendaId,
      estado: Estado.CANCELADO,
      requiereRevision: false,
    });
    return this.obtenerParaCliente(pedidoId, user);
  }

  // ==================================================================
  // Comprobantes
  // ==================================================================

  /**
   * Sube un comprobante: el CLIENTE desde su pedido, o la CAJERA en su nombre (oct 2026: llegan
   * clientes sin internet, que no saben subirlo, o a quienes les manda su patrón; la cajera le toma
   * foto a su comprobante con la tablet). Es una ayuda para Tesorería, no una prueba: el dinero lo
   * confirma el banco, y NI la cajera NI el cliente verifican nada: el pago pasa a `EN_REVISION` y
   * Tesorería lo resuelve. Queda anotado QUIÉN lo subió (`subidoPorId` y el evento del pago), y
   * Tesorería lo ve marcado como "subido por la tienda".
   *
   * Solo `CAJERO` (y ADMIN, que pasa siempre): MOSTRADOR no maneja el cobro (decisión del dueño).
   * La respuesta es la vista del que sube, para que su pantalla se refresque con lo suyo.
   */
  async subirComprobante(
    pedidoId: number,
    user: UserContext,
    archivo: Express.Multer.File | undefined,
    dto: SubirComprobanteDto,
    ip?: string | null,
  ) {
    const porTienda = user.rol === RolUsuario.CAJERO || user.rol === RolUsuario.ADMIN;
    if (user.rol !== RolUsuario.CLIENTE && !porTienda) {
      throw new ForbiddenException('Solo el cliente o la cajera de la tienda suben comprobantes.');
    }
    const pedido = await this.pedidoAccesible(pedidoId, user);
    // La respuesta es la vista de quien sube (cliente → la suya; tienda → la de caja).
    const vista = () =>
      porTienda ? this.resumenParaTienda(pedidoId, user) : this.obtenerParaCliente(pedidoId, user);
    if (!archivo?.buffer?.length) throw new BadRequestException('Falta el archivo del comprobante');
    const maxBytes = this.config.get<number>('app.pagos.comprobantes.maxBytes') ?? 8 * 1024 * 1024;
    if (archivo.buffer.length > maxBytes) {
      throw new BadRequestException(
        `El archivo pesa demasiado (máximo ${Math.round(maxBytes / 1024 / 1024)} MB)`,
      );
    }
    // Por la firma del archivo, no por el `mimetype` ni la extensión que declara el cliente.
    const mime = detectarMimeComprobante(archivo.buffer);
    if (!mime) {
      throw new BadRequestException(
        'El comprobante debe ser una imagen (JPG, PNG, WEBP) o un PDF.',
      );
    }

    const pago = await pagoActivoDe(this.prisma, pedidoId);
    if (!pago || (pago.estado !== Estado.PENDIENTE && pago.estado !== Estado.EN_REVISION)) {
      throw new BadRequestException(
        'Este pedido no tiene una transferencia esperando comprobante.',
      );
    }
    if (pedido.estado !== EstadoPedido.PENDIENTE_PAGO) {
      throw new ConflictException('El pedido ya no está pendiente de pago.');
    }

    const sha256 = createHash('sha256').update(archivo.buffer).digest('hex');
    const previos = await this.prisma.pagoComprobante.findMany({
      where: { pagoId: pago.id },
      select: { id: true, sha256: true, estado: true },
    });
    // Reintento del mismo archivo (doble clic, red lenta): idempotente.
    if (previos.some((c) => c.sha256 === sha256 && c.estado !== EstadoComprobante.RECHAZADO)) {
      return vista();
    }
    if (previos.length >= MAX_COMPROBANTES_POR_PAGO) {
      throw new ConflictException(
        porTienda
          ? 'Este pago ya tiene muchos comprobantes. Pide a Tesorería que lo revise.'
          : 'Ya subiste muchos comprobantes para este pago. Contacta a la tienda para que Tesorería lo revise.',
      );
    }
    if (
      previos.filter((c) => c.estado === EstadoComprobante.PENDIENTE).length >=
      MAX_COMPROBANTES_PENDIENTES
    ) {
      throw new ConflictException(
        porTienda
          ? 'Ya hay comprobantes en revisión. Espera a que Tesorería los revise antes de subir otro.'
          : 'Ya tienes comprobantes en revisión. Espera a que los revisemos antes de subir otro.',
      );
    }

    const key = await this.storage.guardar(archivo.buffer, mime, pago.id);
    try {
      await this.prisma.$transaction(async (tx) => {
        const c = await tx.pagoComprobante.create({
          data: {
            pagoId: pago.id,
            subidoPorId: user.userId,
            archivoKey: key,
            mime,
            bytes: archivo.buffer.length,
            sha256,
            montoDeclarado:
              dto.montoDeclarado != null ? aDecimal(dto.montoDeclarado, 'montoDeclarado') : null,
            fechaDeclarada: dto.fechaDeclarada ? new Date(dto.fechaDeclarada) : null,
            bancoEmisor: dto.bancoEmisor ?? null,
            claveRastreoDeclarada: dto.claveRastreoDeclarada
              ? dto.claveRastreoDeclarada.replace(/[\s-]/g, '').toUpperCase()
              : null,
          },
        });
        // Guarda atómica: el pago sigue en un estado que admite comprobantes. Si Tesorería lo
        // verificó justo ahora, no se agrega un comprobante a un pago ya resuelto.
        const r = await tx.pedidoPagoTransferencia.updateMany({
          where: { id: pago.id, estado: { in: [Estado.PENDIENTE, Estado.EN_REVISION] } },
          data: { estado: Estado.EN_REVISION },
        });
        if (r.count !== 1) {
          throw new ConflictException('El pago cambió mientras subías el comprobante.');
        }
        await registrarEventoPago(tx, pago.id, {
          tipo: 'COMPROBANTE_SUBIDO',
          de: pago.estado,
          a: Estado.EN_REVISION,
          actor: this.actorDe(user, ip),
          // `porTienda`: lo subió la cajera en nombre del cliente (el actor ya dice quién).
          detalle: { comprobanteId: c.id, mime, bytes: archivo.buffer.length, porTienda },
        });
      });
    } catch (err) {
      // El archivo ya se subió pero no quedó registrado: se borra para no dejar basura con datos
      // bancarios sin dueño.
      await this.storage.eliminar(key);
      throw err;
    }

    this.emitir({
      pagoId: pago.id,
      pedidoId,
      tiendaId: pedido.tiendaId,
      estado: Estado.EN_REVISION,
      requiereRevision: !!pago.requiereRevision,
    });
    void this.prisma.pedido
      .findUniqueOrThrow({ where: { id: pedidoId } })
      .then((p) =>
        this.notifications.enviarTransferencia(
          p,
          TipoNotificacion.TRANSFERENCIA_COMPROBANTE_RECIBIDO,
        ),
      )
      .catch((e) => this.logger.error(`Correo de comprobante recibido: ${e.message}`));
    return vista();
  }

  /** Para el texto copiable cuando solo se tiene el pago (Tesorería). */
  instruccionesDePago(pago: Parameters<typeof instruccionesDeUnPago>[0], pedido: PedidoParaPago) {
    return instruccionesDeUnPago(pago, pedido, this.cfg);
  }
}
