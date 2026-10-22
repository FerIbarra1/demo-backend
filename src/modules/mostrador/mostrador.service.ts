import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { Prisma, EstadoPedido, EstadoPropuesta, EstadoSurtido, RolUsuario } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { PedidoAccessService } from '../pedidos/core/pedido-access.service';
import { ReposicionService } from '../pedidos/reposicion/reposicion.service';
import { RealtimeService } from '../realtime/realtime.service';
import { recalcularTotalesPedido } from '../pedidos/core/totales.util';
import { construirItemPedido } from '../pedidos/core/item-pedido.util';
import {
  datosDeReposicion,
  datosDeRetiroPorDecision,
  sePuedeReponer,
} from '../pedidos/core/cancelacion-linea.util';
import {
  ajusteNecesitaBodega,
  calcularAjusteDeCantidad,
  piezasEnLaBolsa,
} from '../pedidos/core/ajuste-cantidad.util';
import { PreciosService } from '../precios/precios.service';
import { ColumnaLista } from '../precios/precio-lista.util';
import { ItemAjusteDto } from './dto/accion-mostrador.dto';
import { KioskoLlegadaService } from '../kiosko/kiosko-llegada.service';
import { PresenciaService } from '../pedidos/core/presencia.service';
import { MostradoresService } from '../mostradores/mostradores.service';
import { ESTADOS_ACTIVOS } from '../pagos/transferencia/reglas';
import {
  ESTADOS_ESPERA_CLIENTE,
  ORDEN_COLA,
  clientePresenteEnTienda,
  whereAusente,
  wherePresente,
} from '../pedidos/core/presencia.util';
import { umbralesSinRecoger } from '../pedidos/core/sin-recoger.util';
import { ConfigService } from '@nestjs/config';
import { UserContext } from '../../types/pedido.types';
import { turnoCorto } from '../pedidos/core/folio-erp.util';

/**
 * Módulo Mostrador (jul 2026).
 *
 * Responsabilidad: gestionar el paso del pedido por mostrador. Cualquier
 * usuario MOSTRADOR puede operar cualquier pedido de su tienda — no hay
 * asignación 1:1 como en el cajero.
 *
 * F16 (sep 2026): el mostrador pasó de ser la ÚLTIMA parada a ser la
 * penúltima. Antes veía pedidos ya pagados y solo entregaba. Ahora:
 *
 *   1. `REVISADO` — el pedido está apartado y el cliente lo revisa en
 *      tienda. El operador decide:
 *        - `enviarAPagar` → PENDIENTE_PAGO (AQUÍ entra al ERP: Firebird solo ve
 *                       pedidos que el cliente ya confirmó).
 *        - `ajustar`  → EN_REVISION (el cliente pidió cambios; bodega re-surte).
 *        - `cancelar` → CANCELLED + lista de reposición (la mercancía vuelve
 *                       al anaquel).
 *   2. `PAID` / `SHIPPED` — el cliente ya pagó; el operador entrega
 *      (`entregar` → COMPLETED). Esto ya existía y no cambió.
 *
 * Estados que el mostrador ve:
 *   - REVISADO — por revisar con el cliente (nuevo en F16).
 *   - PAID         — pagado, listo para entregar (kiosko/web recoger).
 *   - SHIPPED      — ya enviado por paquetería, el cliente recoge en tienda
 *                    (caso poco común pero soportado por la máquina de estados).
 *
 * Toda transición delega en `PedidoStateService.cambiarEstado` para mantener
 * una sola fuente de verdad de historial, realtime y notificación.
 */
@Injectable()
export class MostradorService {
  private readonly logger = new Logger(MostradorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pedidoState: PedidoStateService,
    private readonly access: PedidoAccessService,
    private readonly reposicion: ReposicionService,
    private readonly realtime: RealtimeService,
    private readonly precios: PreciosService,
    private readonly llegada: KioskoLlegadaService,
    /** F22: descartar aviso, "no se presentó". */
    private readonly presencia: PresenciaService,
    /** F22: el mostrador desde el que el operador llama. */
    private readonly mostradores: MostradoresService,
    private readonly config: ConfigService,
  ) {}

  // ==================================================================
  // F16 (sep 2026): la cola de REVISADO y las tres acciones del operador
  // ==================================================================

  /**
   * `REVISADO → PENDIENTE_PAGO`. El cliente revisó su pedido y está de
   * acuerdo: pasa a caja a pagar.
   *
   * **Aquí entra el pedido al ERP.** Es el punto central del cambio de flujo:
   * con el encolado en este momento, Firebird solo ve pedidos que el cliente
   * ya confirmó, y un ajuste o cancelación en mostrador nunca lo deja
   * desincronizado (el pedido todavía no existe allá).
   *
   * `encolarFirebird: true` es obligatorio: un PENDIENTE_PAGO sin fila en
   * `PedidoPendienteEnvio` es invisible al agente, nunca recibe folio y se
   * queda atascado para siempre.
   */
  async enviarAPagar(pedidoId: number, usuario: UserContext, nota?: string) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    this.exigirEstado(pedido.estado, 'enviar a pagar');

    // Decisión D2 del plan: el operador PUEDE mandar a pagar sin que el cliente haya
    // avisado llegada (sabe más que el sistema). Queda registrado para poder
    // auditar cuántas veces se salta el gate.
    const completo = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        numeroPedido: true,
        folioErp: true,
        tiendaId: true,
        canalOrigen: true,
        llegadaAnunciadaAt: true,
        llegadaDescartadaAt: true,
      },
    });

    // F18 (oct 2026): GUARD de propuesta pendiente.
    //
    // Sin esto el operador podía mandar a pagar un pedido con una propuesta
    // viva: el pedido entraba a Firebird con las cantidades de bodega y la
    // propuesta quedaba PENDIENTE para siempre — bloqueando futuras propuestas
    // por el índice único parcial, y sin que el cliente hubiera decidido nada.
    //
    // El caso real: el pedido quedó incompleto y el cliente NO está. El
    // operador tiene que resolverlo (aceptar lo que hay, ajustar o cancelar)
    // antes de cobrar.
    const propuestaPendiente = await this.prisma.pedidoPropuesta.findFirst({
      where: { pedidoId, estado: EstadoPropuesta.PENDIENTE },
      select: { id: true },
    });
    if (propuestaPendiente) {
      throw new BadRequestException(
        'Este pedido tiene faltantes sin resolver. Resuelve la propuesta con el cliente ' +
          '(aceptar lo que hay, ajustar el pedido o cancelarlo) antes de enviarlo a pagar.',
      );
    }

    // F22: la regla única de presencia. Antes miraba solo el aviso y a TODO pedido
    // de kiosko le escribía "(sin aviso de llegada del cliente)" en el historial,
    // aunque el cliente estuviera de pie en la tienda.
    const clientePresente = completo ? clientePresenteEnTienda(completo) : false;
    const sufijoAviso = clientePresente ? '' : ' (sin aviso de llegada del cliente)';
    const sufijoNota = nota ? ` — ${nota}` : '';

    const actualizado = await this.pedidoState.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.PENDIENTE_PAGO,
        observacion: `Liberado a pago en mostrador por ${usuario.nombre}${sufijoAviso}${sufijoNota}`,
      },
      usuario,
      {
        // Aquí entra al ERP. Ver el comentario del método.
        encolarFirebird: true,
        // La TV de cajero y la de mostrador tienen que recomputar.
        invalidarMonitor: true,
      },
    );

    // Oct 2026: a dónde va el cliente a pagar. La transición ya confirmó: si esto falla, el
    // pedido igual está en PENDIENTE_PAGO y la operadora solo pierde el dato del toast.
    const destinoPago = await this.destinoDePago(pedidoId);
    if (completo) {
      // La TV de mostrador es una pantalla PÚBLICA que ve todo el mundo: el aviso es el mismo
      // para todos ("A pagar → pasa a CAJA") y NO revela cómo paga cada cliente. Una primera
      // versión mandaba `destinoPago` aquí para pintar "Transfiere"; el dueño lo quitó (16-oct):
      // el evento va a la sala de la tienda y lo recibe la TV, así que lo que lleve se ve en la
      // pared. Solo folio.
      this.realtime.emitToTienda(completo.tiendaId, 'pedido.enviado-a-pagar', {
        id: pedidoId,
        numeroPedido: completo.numeroPedido,
        // Oct 2026 (B2): lo que la TV pinta (los últimos dígitos del folio); null = aún sin folio.
        turno: turnoCorto(completo.folioErp),
      });
    }
    // `destinoPago` SÍ viaja en la respuesta HTTP: es para el toast de la operadora, privado.
    return { ...actualizado, destinoPago };
  }

  /**
   * A dónde paga el cliente un pedido que acaba de pasar a PENDIENTE_PAGO: `TRANSFERENCIA` si ya
   * se le emitieron los datos (eligió transferencia al pedir y había cuenta bancaria) y `CAJA` en
   * cualquier otro caso. Solo se le dice a la operadora (respuesta HTTP); nunca a una TV.
   */
  private async destinoDePago(pedidoId: number): Promise<'CAJA' | 'TRANSFERENCIA'> {
    try {
      const pago = await this.prisma.pedidoPagoTransferencia.findFirst({
        where: { pedidoId, estado: { in: [...ESTADOS_ACTIVOS] } },
        select: { id: true },
      });
      return pago ? 'TRANSFERENCIA' : 'CAJA';
    } catch (err) {
      this.logger.warn(
        `Pedido ${pedidoId}: no se pudo consultar el destino de pago (${(err as Error).message})`,
      );
      return 'CAJA';
    }
  }

  /**
   * El cliente quiere cambios. A dónde va el pedido depende de QUÉ cambia
   * (oct 2026, propuestas — decisión 4 del dueño):
   *
   *   - Hay algo que SURTIR (un producto agregado, o una cantidad que sube por
   *     encima de lo que hay en la bolsa) → `EN_REVISION`: vuelve a la cola de
   *     bodega SIN ASIGNAR, que verifica lo nuevo contra el anaquel.
   *   - El cliente solo QUITA o BAJA piezas → se resuelve EN EL LUGAR: el pedido
   *     se queda en el área de entrega (`REVISADO`, o `EN_ATENCION` si ya lo
   *     llamaron) y las piezas quitadas pasan a REPOSICIÓN. El operador las saca de
   *     la bolsa enfrente del cliente; lo que falta es devolverlas al anaquel, y
   *     para eso no hace falta que el pedido pase por la cola de bodega mientras el
   *     cliente espera de pie. Un pedido que esperaba aprobación
   *     (`ESPERANDO_APROBACION`) pasa a `REVISADO`: el cliente ya está enfrente.
   *
   * Antes SIEMPRE iba a bodega, y el bodeguero sacaba las piezas con el checklist
   * de retiro. Esto revierte esa regla solo para mostrador; el ajuste de ventas
   * conserva el checklist (ahí el cliente no está esperando).
   *
   * Si el ajuste además agrega o sube algo, viaja a bodega y las piezas quitadas
   * igual van a reposición: la regla del piso es "lo que quitas, lo sacas tú",
   * sin depender de si la tanda trae otra cosa. `piezasRetiradas` se suma en el
   * momento para que el checklist de bodega no las vuelva a pedir.
   *
   * Sin `items` (solo la nota) el comportamiento es el de la Fase 1: bodega mira el
   * pedido tal cual. Lo mismo si todos los items son `completo`: no hay nada
   * concreto que aplicar, y mandar el pedido a bodega es lo conservador.
   *
   * `asignacion: 'limpiar'` es obligatorio al ir a bodega: el caller es el
   * OPERADOR, no un bodeguero. Con 'caller' el pedido quedaría asignado a un
   * usuario de mostrador, invisible en el monitor de bodega y bloqueado para todos
   * los bodegueros. `cambiarEstado` exige que sea explícito justo por esto.
   *
   * `reloj: 'reanudar'` (no 'pausar'): el pedido vuelve a ser tarea de bodega,
   * así que el reloj de atención arranca un turno nuevo acumulando lo previo.
   * Con 'pausar' el pedido volvería con el reloj congelado y la urgencia
   * mentiría. En el lugar el reloj no se toca: bodega no interviene.
   *
   * Fase 4 (sep 2026): acepta los cambios de items del editor POS. Se aplican
   * DENTRO de la transacción de la transición (`efectos`), así que el pedido no
   * puede quedar en EN_REVISION con los items a medio aplicar — bodega vería un
   * pedido que no coincide con lo que el cliente pidió.
   *
   * Sin `items`, el comportamiento es el de la Fase 1: solo registra la nota y
   * manda el pedido a bodega. Eso permite desplegar el backend antes que el
   * frontend sin romper nada.
   */
  async ajustar(
    pedidoId: number,
    usuario: UserContext,
    nota: string,
    items?: ItemAjusteDto[],
    /**
     * Oct 2026 (destrabar): el GERENTE o el ADMIN quitan productos desde el panel del pedido, con el cliente AUSENTE.
     * Eso cambia tres cosas del ajuste de mostrador, que da por hecho que el cliente está enfrente:
     *  - NO registra su llegada (sería un aviso de presencia falso: bodega lo trataría como "cliente en tienda");
     *  - el historial y la propuesta superada no llevan la `nota` (aquí es el motivo interno, y el cliente lee ambos);
     *  - el historial dice "la tienda", no "mostrador por <operador>".
     */
    opts: { porLaTienda?: boolean } = {},
  ) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    /**
     * F21 (oct 2026): también desde `ESPERANDO_APROBACION`.
     *
     * El caso del negocio: el cliente no vio la propuesta en su app y llega a
     * la tienda. El operador lo tiene enfrente y necesita AJUSTAR — no solo
     * aprobar o rechazar. Antes el pedido estaba en `ESPERANDO_APROBACION`, así
     * que `ajustar` daba 400 y al operador solo le quedaba "El cliente no
     * acepta", que CANCELA el pedido completo.
     *
     * Es el mismo criterio que ya usa `resolverPropuesta` para el operador
     * (`[ESPERANDO_APROBACION, REVISADO, EN_ATENCION]`): si el cliente está
     * físicamente en la tienda, el operador puede resolver en su nombre sin
     * importar en qué punto del ciclo esté el pedido.
     */
    this.exigirEstado(pedido.estado, 'ajustar', [
      EstadoPedido.ESPERANDO_APROBACION,
      EstadoPedido.REVISADO,
      EstadoPedido.EN_ATENCION,
    ]);

    // El pedido completo se necesita ANTES de la transacción: `PreciosService`
    // usa `prisma` (no el `tx`) y la lista de precios del cliente se resuelve
    // fuera. Además los `efectos` corren dentro del tx, donde no se puede
    // llamar a un service que use otra conexión.
    const pedidoCompleto = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: { items: true },
    });
    if (!pedidoCompleto) throw new BadRequestException('Pedido no encontrado');

    const hayCambios = Boolean(items && items.length > 0);

    // Validar ANTES de la transacción para fallar rápido y con mensajes claros.
    if (hayCambios) {
      this.validarAjuste(items!, pedidoCompleto.items);
    }

    // Fase 0: el precio de los productos agregados sale de la lista del cliente
    // que hizo el pedido, no de `pco.precio` (siempre lista1).
    const columnaLista = hayCambios
      ? await this.precios.columnaParaPedido(pedidoCompleto)
      : 'lista1';

    /**
     * A dónde va el pedido (oct 2026): se decide ANTES de la transacción.
     *
     * Hay que saberlo antes porque `cambiarEstado` necesita el destino para abrir la
     * transición, y los `efectos` que aplican los cambios corren dentro de ella —
     * es la misma razón por la que `aprobarPropuestaVentas` termina con dos
     * transiciones en commits separados. `ajusteNecesitaBodega` usa la misma
     * función que `aplicarAjuste` para decidir qué se escribe, así que no puede
     * contradecirse con él.
     */
    const hayCambiosReales = hayCambios && items!.some((i) => i.tipo !== 'completo');
    const vaABodega = !hayCambiosReales || ajusteNecesitaBodega(pedidoCompleto.items, items!);

    // En el lugar: el pedido se queda donde está, salvo el que esperaba aprobación,
    // que pasa a REVISADO (el cliente ya está enfrente). Ver el docblock.
    const estadoActual = pedidoCompleto.estado;
    const destino = vaABodega
      ? EstadoPedido.EN_REVISION
      : estadoActual === EstadoPedido.ESPERANDO_APROBACION
        ? EstadoPedido.REVISADO
        : estadoActual;
    const yaEstaEnDestino = destino === estadoActual;

    /**
     * La observación del historial se construye DESPUÉS de aplicar los cambios.
     *
     * F21 (oct 2026): antes se armaba aquí, con
     * `resumenCambios.length || items!.length` — pero `resumenCambios` se llena
     * dentro de los `efectos`, que corren después. En ese punto siempre estaba
     * vacío, así que el `||` hacía que el historial reportara **siempre**
     * `items.length` (los cambios PROPUESTOS) y nunca los realmente aplicados.
     * Un ajuste que pedía 5 cambios y aplicaba 2 quedaba auditado como 5.
     *
     * Oct 2026: el arreglo de F21 no funcionaba. `observacion` se copiaba al
     * objeto del DTO por VALOR al llamar a `cambiarEstado`, así que la
     * reasignación de los `efectos` nunca llegaba al historial (que se escribe
     * después y lee `dto.observacion`). Ahora el DTO la lee con un getter: la
     * transición la consulta cuando escribe la fila, ya con el conteo real.
     */
    let observacion = opts.porLaTienda
      ? 'Ajuste hecho por la tienda'
      : hayCambios
        ? `Ajuste en mostrador por ${usuario.nombre}: ${nota}`
        : `Ajuste solicitado en mostrador por ${usuario.nombre}: ${nota}`;
    let piezasAReposicion = 0;

    /**
     * F21 (oct 2026): el ajuste de mostrador REGISTRA LA LLEGADA del cliente.
     *
     * Sin esto, el circuito se rompe por una razón que no se ve: el pedido
     * vuelve a bodega, bodega cierra el surtido, y `destinoTrasSurtidoIncompleto`
     * decide a dónde va mirando `clientePresenteEnTienda` — que para un pedido
     * WEB es "hay aviso de llegada vigente". Si el operador ajustó sin que nadie
     * hubiera avisado, el pedido aterriza otra vez en `ESPERANDO_APROBACION`
     * **con el cliente de pie en el mostrador**, esperando una aprobación que
     * nadie va a dar desde la app.
     *
     * El operador que ajusta tiene al cliente enfrente por definición: es la
     * misma premisa que `enNombreDelCliente` en las propuestas. Así que se
     * registra con `CanalLlegada.MOSTRADOR`, el mismo camino que el botón
     * "El cliente está aquí" — idempotente y con su propia auditoría.
     *
     * Va DESPUÉS del commit, no dentro de los efectos: `confirmarDesdeMostrador`
     * usa `prisma` (no el `tx`) y escribe su propio historial y realtime. Dentro
     * de la transacción no se puede, y si el ajuste falla tampoco debe quedar el
     * aviso.
     */
    const resultado = await this.pedidoState.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: destino,
        // Getter, no valor: ver el comentario de `observacion` arriba.
        get observacion() {
          return observacion;
        },
      },
      usuario,
      {
        // A bodega: sin asignar y con el reloj corriendo (ver el docblock). En el
        // lugar bodega no interviene, así que ni la asignación ni el reloj se tocan.
        asignacion: vaABodega ? 'limpiar' : 'mantener',
        reloj: vaABodega ? 'reanudar' : 'mantener',
        invalidarMonitor: true,
        // En el lugar el destino suele ser el estado que el pedido YA tiene
        // (REVISADO o EN_ATENCION): no hay transición, solo `efectos`. Sin esto
        // `cambiarEstado` lanzaba "Transición no permitida: REVISADO → REVISADO".
        // EN_ATENCION → EN_ATENCION además conserva la llamada: ver
        // `ejecutarCambio`, que ya no limpia `llamadoAt` en este camino.
        permitirMismoEstado: !vaABodega,
        // El cliente está de pie en el mostrador: el correo de "tu pedido ya está
        // listo en tienda" (ESPERANDO_APROBACION → REVISADO) sería ruido.
        sinNotificar: !vaABodega,
        // Oct 2026: los efectos corren SIEMPRE, no solo cuando hay cambios de
        // items.
        //
        // El bug que esto arregla: con `efectos: hayCambios ? ... : undefined`,
        // un ajuste SIN items (el operador solo describe lo que el cliente
        // quiere, sin tocar el editor) dejaba la propuesta PENDIENTE. El pedido
        // volvía a bodega con una propuesta viva, y bodega chocaba contra el
        // índice único parcial al cerrar el surtido de la siguiente ronda.
        //
        // El ajuste REEMPLAZA la propuesta en los dos casos: el cliente está
        // enfrente y ya dijo qué quiere.
        efectos: async (tx) => {
          // La propuesta que bodega mandó quedó sin efecto. Si se deja
          // PENDIENTE, bodega choca contra `pedidos_propuestas_pendiente_unica_idx`
          // al cerrar el surtido siguiente, y `enviarAPagar` queda bloqueado para
          // siempre por su guard de propuesta pendiente.
          await tx.pedidoPropuesta.updateMany({
            where: { pedidoId, estado: EstadoPropuesta.PENDIENTE },
            data: {
              estado: EstadoPropuesta.SUPERADA,
              respondidaAt: new Date(),
              notaCliente: opts.porLaTienda ? null : nota,
            },
          });

          // Sin cambios de items no hay nada más que hacer: el pedido ya
          // transicionó a EN_REVISION y bodega lo re-surtirá tal cual.
          if (!hayCambios) return;

          const { cambios, quitadas } = await this.aplicarAjuste(
            tx,
            pedidoCompleto,
            items!,
            columnaLista,
          );
          // F21: el número REAL de cambios aplicados, no los propuestos. Ver el
          // comentario de `observacion` arriba.
          observacion =
            (opts.porLaTienda
              ? 'Ajuste hecho por la tienda'
              : `Ajuste en mostrador por ${usuario.nombre}: ${nota}`) +
            ` (${cambios.length} cambio(s))` +
            (vaABodega ? '' : ' — resuelto en el área de entrega, sin pasar por bodega');

          // Oct 2026 (decisión 4): lo que el operador quitó pasa a REPOSICIÓN. Las
          // sacó él de la bolsa enfrente del cliente y nadie más las va a regresar
          // al anaquel. Va en la misma transacción que el ajuste: o quedan los dos,
          // o ninguno (mercancía fuera de la bolsa sin nadie que la devuelva).
          //
          // Esto revierte para mostrador la regla "un ajuste NO genera
          // reposición". Aquello sigue valiendo para ventas, donde el pedido vuelve
          // a bodega y el bodeguero las saca y las regresa él mismo.
          if (quitadas.length > 0) {
            await this.reposicion.registrarQuitadasEnMostrador(tx, pedidoId, quitadas);
            piezasAReposicion = quitadas.reduce((a, q) => a + q.cantidad, 0);
          }

          // `cambiarEstado` NO escribe historial cuando el estado no cambió, y aquí
          // sí pasó algo que hay que poder auditar: el operador modificó un pedido.
          // Se escribe a mano, con el texto de lo que ocurrió de verdad. Mismo
          // patrón que `aprobarPropuestaBodega`.
          if (yaEstaEnDestino) {
            await tx.historialPedido.create({
              data: {
                pedidoId,
                estadoAnterior: destino,
                estadoNuevo: destino,
                observacion,
                usuarioId: usuario.userId,
                usuarioNombre: usuario.nombre,
              },
            });
          }
        },
      },
    );

    // Ver el comentario de arriba: el cliente está enfrente, así que queda
    // registrado que llegó. Es lo que hace que, cuando bodega cierre el surtido
    // siguiente, el pedido vuelva al área de entrega en vez de a esperar una
    // aprobación por la app.
    //
    // Best-effort a propósito: si el aviso falla, el ajuste YA se aplicó y no se
    // puede deshacer. Tumbar la respuesta dejaría al operador creyendo que nada
    // pasó cuando el pedido ya volvió a bodega — peor que un aviso faltante, que
    // se puede marcar a mano con "El cliente está aquí".
    try {
      if (!opts.porLaTienda) await this.llegada.confirmarDesdeMostrador(pedidoId, usuario);
    } catch (err) {
      this.logger.warn(
        `Pedido ${pedidoId}: el ajuste se aplicó pero no se pudo registrar la llegada ` +
          `(${(err as Error).message}). El pedido podría volver a esperar aprobación.`,
      );
    }

    // Bodega tiene que enterarse de que hay mercancía por devolver al anaquel. La
    // consola de bodega se refresca con `pedido.estado`, pero cuando el pedido se
    // queda donde está (REVISADO → REVISADO, EN_ATENCION → EN_ATENCION) la
    // transición NO lo emite — no hubo cambio de estado — y la lista y el badge de
    // reposición se quedarían con la foto vieja hasta un F5. Por eso el evento
    // propio. Después del commit, como todo lo externo: emitirlo dentro de la
    // transacción avisaría de un ajuste que un rollback podría deshacer.
    //
    // El frontend lo escucha en `bodega/page.tsx` y en `bodega/reposicion/page.tsx`.
    if (piezasAReposicion > 0) {
      this.realtime.emitToTienda(pedidoCompleto.tiendaId, 'reposicion.creada', {
        pedidoId,
        piezas: piezasAReposicion,
      });
    }

    // `vaABodega` y `piezasAReposicion` son lo que el frontend necesita para decir la
    // verdad en el aviso ("enviado a bodega" vs "se aplicó aquí"). Se agregan al
    // pedido en vez de envolverlo para no romper a quien ya lee sus campos.
    return { ...resultado, vaABodega, piezasAReposicion };
  }

  /**
   * Aplica los cambios del editor POS sobre los items del pedido.
   *
   * Reglas por tipo:
   *   - `completo`      → no toca nada (el cliente lo dejó igual).
   *   - `parcial`       → cambia la cantidad del item existente.
   *   - `no-disponible` → cancela el item (el cliente ya no lo quiere).
   *   - `agregado`      → crea una línea nueva en PENDIENTE.
   *
   * El `precioUnitario` de los agregados se resuelve desde `PrecioCO` con la
   * lista del cliente — NUNCA se toma del request (un operador podría mandar 0).
   *
   * Los items nuevos nacen en `PENDIENTE` con `original: false`: nadie los ha
   * verificado contra el anaquel, y ese flag es lo que el monitor de bodega usa
   * para marcar el pedido como "vino con cambios" (§3.7 del plan).
   *
   * Devuelve además las piezas que el operador QUITÓ de la bolsa (`quitadas`): un
   * item que sale del pedido (todo lo que había en la bolsa) o una cantidad que
   * baja (el sobrante). Esas piezas se suman a `piezasRetiradas` AQUÍ, en el mismo
   * update que las quita — son piezas que el operador ya sacó, y sin esto el
   * checklist de retiro de bodega se las volvería a pedir (`piezasPendientesDeRetiro`
   * las vería como "sobrantes por sacar"). El caller las manda a reposición.
   */
  private async aplicarAjuste(
    tx: Prisma.TransactionClient,
    pedido: { id: number; tiendaId: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
    items: ItemAjusteDto[],
    columnaLista: ColumnaLista,
  ): Promise<{ cambios: string[]; quitadas: Array<{ itemId: number; cantidad: number }> }> {
    const cambios: string[] = [];
    const quitadas: Array<{ itemId: number; cantidad: number }> = [];
    const idsActuales = new Set(
      (
        await tx.itemPedido.findMany({
          where: { pedidoId: pedido.id },
          select: { id: true },
        })
      ).map((i) => i.id),
    );

    for (const it of items) {
      if (it.tipo === 'completo') continue;

      if (it.tipo === 'agregado') {
        if (!it.precioCOId) {
          throw new BadRequestException('Un producto agregado requiere precioCOId.');
        }
        const pco = await tx.precioCO.findUnique({
          where: { id: it.precioCOId },
          include: { producto: true, talla: true, color: true, corrida: true },
        });
        if (!pco) {
          throw new BadRequestException(`PrecioCO ${it.precioCOId} no existe`);
        }
        if (pco.tiendaId !== pedido.tiendaId) {
          throw new BadRequestException('El producto agregado pertenece a otra tienda.');
        }

        const cantidad = Math.max(1, it.cantidad ?? 1);
        // Promo de volumen: el precio efectivo lo decide el tamaño FINAL del
        // pedido, no el de este item aislado. `construirItemPedido` congela el
        // par y deja el efectivo en la base; `recalcularTotalesPedido` (que
        // corre al final de este método) lo ajusta al mayoreo si el pedido
        // llega a 12.
        //
        // `original: false` — nadie verificó este producto contra el anaquel.
        // Es la señal que bodega usa para saber que el pedido volvió con
        // cambios.
        await tx.itemPedido.create({
          data: {
            ...construirItemPedido(pco, cantidad, {
              columnaLista,
              original: false,
            }),
            pedidoId: pedido.id,
          },
        });
        cambios.push(`"${pco.producto.nombre}" agregado (${cantidad} pzas)`);
        continue;
      }

      // Tipos que operan sobre un item existente.
      if (it.itemId == null || !idsActuales.has(it.itemId)) {
        throw new BadRequestException(
          `El item ${it.itemId ?? '(sin id)'} no pertenece a este pedido.`,
        );
      }

      if (it.tipo === 'reponer') {
        // Oct 2026 (decisión 3): una línea que bodega no encontró vuelve al pedido.
        // Se vuelve a comprobar DENTRO de la transacción: `validarAjuste` corrió
        // antes y el estado pudo cambiar.
        const previo = await tx.itemPedido.findUnique({
          where: { id: it.itemId },
          select: {
            precioUnitario: true,
            cancelada: true,
            estadoSurtido: true,
            cantidadSurtida: true,
          },
        });
        if (!previo || !sePuedeReponer(previo)) {
          throw new BadRequestException(
            `El item ${it.itemId} no se puede reponer: solo vuelven las líneas que bodega ` +
              'marcó sin existencia.',
          );
        }
        const cantidad = Math.max(1, it.cantidad ?? 1);
        // Nace como una línea que nadie ha visto en el anaquel: bodega la verifica.
        // `cantidadPedida` no se toca (sigue siendo lo que el cliente pidió).
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: {
            ...datosDeReposicion(),
            cantidad,
            subtotal: new Prisma.Decimal(previo.precioUnitario).mul(cantidad),
          },
        });
        cambios.push(`Item #${it.itemId} repuesto (${cantidad} pzas, vuelve a bodega a surtir)`);
        continue;
      }

      if (it.tipo === 'no-disponible') {
        // Se lee el estado físico ANTES de cancelar para conservarlo (F20): el
        // hallazgo de bodega sigue siendo cierto y es lo que el checklist de
        // retiro usa para saber cuánto sacar de la bolsa.
        const previo = await tx.itemPedido.findUnique({
          where: { id: it.itemId },
          select: {
            cantidadSurtida: true,
            cantidad: true,
            estadoSurtido: true,
            piezasRetiradas: true,
          },
        });
        const piezasEnBolsa = previo?.cantidadSurtida ?? 0;
        // Lo que de verdad SIGUE en la bolsa: lo que un ajuste anterior ya sacó no
        // se vuelve a contar (ya está en el anaquel, o en la lista de reposición).
        const piezasQuitadas = piezasEnLaBolsa({
          cantidadSurtida: piezasEnBolsa,
          piezasRetiradas: previo?.piezasRetiradas,
        });

        // F20 (oct 2026): se CONSERVA el estado físico.
        //
        // Antes se limpiaba (`NO_DISPONIBLE` + `cantidadSurtida: 0`) "para
        // normalizar el contrato". El efecto real era borrar el hecho de que el
        // producto SÍ estaba en la bolsa: el cliente que quitó un artículo
        // disponible lo veía en pantalla como "No disponible", como si fuera un
        // faltante de inventario.
        //
        // Ya no hace falta limpiarlo: todos los guards que leen `estadoSurtido`
        // filtran `cancelada` primero (ver `cancelacion-linea.util.ts`).
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: {
            ...datosDeRetiroPorDecision({
              estadoSurtido: previo?.estadoSurtido ?? 'NO_DISPONIBLE',
              cantidadSurtida: piezasEnBolsa,
            }),
            ...(piezasQuitadas > 0 ? { piezasRetiradas: { increment: piezasQuitadas } } : {}),
          },
        });
        if (piezasQuitadas > 0) quitadas.push({ itemId: it.itemId, cantidad: piezasQuitadas });
        cambios.push(`Item #${it.itemId} quitado`);
        continue;
      }

      if (it.tipo === 'parcial') {
        const cantidad = Math.max(1, it.cantidad ?? 1);
        const item = await tx.itemPedido.findUnique({
          where: { id: it.itemId },
          select: {
            precioUnitario: true,
            cantidad: true,
            cantidadSurtida: true,
            piezasRetiradas: true,
            estadoSurtido: true,
          },
        });
        if (!item) {
          throw new BadRequestException(`Item ${it.itemId} no existe.`);
        }

        // F16 (sep 2026): el ajuste de cantidad tiene que dejar el item en un
        // estado COHERENTE con lo que bodega verificó físicamente.
        //
        // Antes esta rama solo escribía `cantidad` y `subtotal`, dejando
        // `estadoSurtido: COMPLETO` con el `cantidadSurtida` viejo. Si el
        // cliente SUBÍA la cantidad (2 → 5), el item quedaba "completo" con 2
        // piezas apartadas: `confirmarSurtido` no lo detectaba (solo bloquea
        // PENDIENTE y faltantes PARCIAL/NO_DISPONIBLE), el pedido avanzaba a
        // pago y el cliente pagaba 5 piezas de las que bodega solo había
        // apartado 2.
        //
        // F21 (oct 2026): la decisión de cuánto se lleva y el hallazgo físico
        // viven en columnas distintas. Antes esta rama escribía
        // `cantidadSurtida: cantidad` al BAJAR, y eso destruía el hecho de que
        // había más: con 3 en el anaquel y una decisión de 1, el item quedaba
        // con `cantidadSurtida: 1` y la pantalla decía "Disponibles 1" — falso.
        // El helper conserva `cantidadSurtida` intacta y reporta cuánto sobra
        // para que vuelva al anaquel. Ver `core/ajuste-cantidad.util.ts`.
        const ajuste = calcularAjusteDeCantidad(item, cantidad);
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: {
            ...ajuste.data,
            // Oct 2026: si BAJA, el sobrante lo saca el operador ahora mismo. Se
            // suma al contador en el mismo update; al SUBIR `ajuste.data` ya lo
            // reinicia a 0 junto con `cantidadSurtida`.
            ...(ajuste.piezasSobrantes > 0
              ? { piezasRetiradas: { increment: ajuste.piezasSobrantes } }
              : {}),
            subtotal: new Prisma.Decimal(item.precioUnitario).mul(cantidad),
          },
        });
        if (ajuste.piezasSobrantes > 0) {
          quitadas.push({ itemId: it.itemId, cantidad: ajuste.piezasSobrantes });
        }
        cambios.push(
          `Item #${it.itemId}: ${item.cantidad} → ${cantidad} pzas` +
            (ajuste.subeLaCantidad ? ' (vuelve a bodega a surtir)' : ''),
        );
      }
    }

    // Guard espejo del de `confirmarSurtido`: un pedido sin items activos no
    // tiene nada que surtir ni cobrar.
    const activos = await tx.itemPedido.count({
      where: { pedidoId: pedido.id, cancelada: false },
    });
    if (activos === 0) {
      throw new BadRequestException(
        'El ajuste dejaría el pedido sin productos. Si el cliente no quiere ' +
          'nada, cancela el pedido en vez de ajustarlo.',
      );
    }

    await recalcularTotalesPedido(tx, pedido);
    return { cambios, quitadas };
  }

  /**
   * Validaciones del ajuste, ANTES de abrir la transacción (fallar rápido y con
   * mensajes claros en vez de reventar a mitad del commit).
   */
  private validarAjuste(
    items: ItemAjusteDto[],
    itemsActuales: Array<{
      id: number;
      cancelada: boolean;
      estadoSurtido: EstadoSurtido;
      cantidadSurtida: number;
    }>,
  ): void {
    const ids = new Set(itemsActuales.map((i) => i.id));

    for (const it of items) {
      if (it.tipo === 'agregado') {
        if (!it.precioCOId) {
          throw new BadRequestException('Un producto agregado requiere precioCOId.');
        }
        continue;
      }
      if (it.tipo === 'completo') continue;

      if (it.itemId == null) {
        throw new BadRequestException(`El tipo "${it.tipo}" requiere itemId.`);
      }
      if (!ids.has(it.itemId)) {
        throw new BadRequestException(`El item ${it.itemId} no pertenece a este pedido.`);
      }
      if (it.tipo === 'parcial' && (it.cantidad == null || it.cantidad < 1)) {
        throw new BadRequestException('Un ajuste parcial requiere una cantidad mayor a 0.');
      }
      if (it.tipo === 'reponer') {
        if (it.cantidad == null || it.cantidad < 1) {
          throw new BadRequestException('Reponer una línea requiere una cantidad mayor a 0.');
        }
        const actual = itemsActuales.find((i) => i.id === it.itemId);
        if (!actual || !sePuedeReponer(actual)) {
          throw new BadRequestException(
            `El item ${it.itemId} no se puede reponer: solo vuelven las líneas que bodega ` +
              'marcó sin existencia.',
          );
        }
      }
    }
  }

  /**
   * `REVISADO → CANCELLED` + lista de reposición.
   *
   * La reposición se crea DENTRO de la misma transacción (`efectos`): si la
   * cancelación se aplica pero la lista falla, quedaría mercancía apartada sin
   * nadie que la devuelva al anaquel. `crearDesdePedido` es idempotente, así
   * que un segundo intento no duplica.
   *
   * No se encola nada a Firebird: el pedido nunca llegó al ERP (con el flujo
   * nuevo el encolado ocurre al enviar a pagar, no al surtir). Si el pedido ya estaba
   * en PENDIENTE_PAGO, la cancelación la sincroniza el agente por `SWCANCEL`.
   */
  async cancelar(pedidoId: number, usuario: UserContext, motivo: string) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    // F21: mismo criterio que `ajustar` — el cliente está enfrente y el pedido
    // puede seguir esperando su aprobación en la app.
    this.exigirEstado(pedido.estado, 'cancelar', [
      EstadoPedido.ESPERANDO_APROBACION,
      EstadoPedido.REVISADO,
      EstadoPedido.EN_ATENCION,
    ]);

    return this.pedidoState.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.CANCELADO,
        observacion: `Cancelado en mostrador por ${usuario.nombre}: ${motivo}`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        invalidarMonitor: true,
        efectos: async (tx) => {
          await this.reposicion.crearDesdePedido(tx, pedidoId, motivo);
        },
      },
    );
  }

  /**
   * F22 (oct 2026): cancela pedidos VENCIDOS — la bolsa lleva días apartada, el
   * cliente no pasó ni contestó el "¿aún lo quieres?".
   *
   * Es `cancelar` en lote con un motivo que el cliente entiende. El motivo es el
   * texto del correo de cancelación (`PedidoReposicion.motivo` se lee como
   * `motivoCancelacion`), así que dice QUÉ pasó, no "vencido".
   *
   * Solo cancela lo que de verdad está vencido y sin cliente. Se revalida CADA
   * pedido en el servidor: la lista que vio el operador pudo envejecer, y entre
   * tanto el cliente pudo haber llegado, confirmado que sigue interesado o
   * cancelado él mismo. Cancelar un pedido cuyo cliente acaba de entrar por la
   * puerta sería peor que no cancelar. Los que ya no aplican se reportan en
   * `omitidas`, con la razón, en vez de fallar el lote entero.
   */
  async cancelarVencidos(usuario: UserContext, ids: number[], motivo?: string) {
    // PLAN-ADMIN-MULTITIENDA §4.5.4: cancelar es destructivo y el ADMIN lo puede hacer en la tienda de
    // cualquiera. El operador puede dejar el texto por defecto ("pasaron más de 3 días…"); el ADMIN debe
    // decir POR QUÉ —es lo que el cliente lee en su correo y lo que queda en el historial—, igual que en
    // "marcar pagado manual". Se exige antes de consultar nada.
    if (usuario.rol === RolUsuario.ADMIN && (motivo?.trim().length ?? 0) < 3) {
      throw new BadRequestException(
        'Escribe el motivo de la cancelación (mínimo 3 caracteres): el cliente lo lee en su correo.',
      );
    }
    const u = umbralesSinRecoger(this.config);
    const limite = new Date(Date.now() - u.vencidoHoras * 3_600_000);
    const dias = Math.max(1, Math.round(u.vencidoHoras / 24));
    const motivoFinal =
      motivo?.trim() ||
      `Pasaron más de ${dias} día${dias === 1 ? '' : 's'} sin que se recogiera tu pedido y no ` +
        'recibimos respuesta a nuestro recordatorio.';

    const unicos = [...new Set(ids)];
    const vigentes = await this.prisma.pedido.findMany({
      where: {
        id: { in: unicos },
        // La tienda sale del JWT, nunca del body. ADMIN opera cualquiera.
        ...(usuario.rol === RolUsuario.ADMIN ? {} : { tiendaId: usuario.tiendaId ?? -1 }),
        estado: { in: ESTADOS_ESPERA_CLIENTE },
        esperaClienteDesdeAt: { lt: limite },
        ...whereAusente(),
      },
      select: { id: true },
    });
    const elegibles = new Set(vigentes.map((p) => p.id));

    const canceladas: number[] = [];
    const omitidas: Array<{ id: number; razon: string }> = [];
    for (const id of unicos) {
      if (!elegibles.has(id)) {
        omitidas.push({
          id,
          razon: 'Ya no está vencido, el cliente ya está en la tienda o no es de tu tienda',
        });
        continue;
      }
      try {
        await this.cancelar(id, usuario, motivoFinal);
        canceladas.push(id);
      } catch (err) {
        omitidas.push({ id, razon: (err as Error).message });
      }
    }

    this.logger.log(
      `Cancelación de vencidos por ${usuario.nombre}: ${canceladas.length} cancelado(s), ` +
        `${omitidas.length} omitido(s)`,
    );
    return { canceladas, omitidas };
  }

  /**
   * F16 (sep 2026): descarta un aviso de llegada falso (el cliente no estaba o ya
   * se fue).
   *
   * F22 (oct 2026): la lógica vive en `PresenciaService.descartar`. Antes estaba
   * aquí y tenía tres huecos: con el pedido ya llamado lo dejaba atascado en
   * `EN_ATENCION` (invisible en la consola y en la TV, que exigen cliente
   * presente), no funcionaba con un pedido de kiosko (exigía `llegadaAnunciadaAt`,
   * que un kiosko nunca tiene) y el cliente no se enteraba de que lo habían quitado
   * de la cola. Ahora funciona en los dos canales, regresa un pedido llamado a
   * `REVISADO` y avisa al cliente.
   */
  async descartarLlegada(pedidoId: number, usuario: UserContext) {
    return this.presencia.descartar(pedidoId, usuario);
  }

  /**
   * F22 (oct 2026): el operador llamó al cliente y no se presentó.
   *
   * No es `devolverACola`: esa es para un error del OPERADOR y conserva el lugar.
   * Esta es para un cliente que tenía turno y no lo usó, y pasa al final de la
   * cola. A la segunda vez se descarta su aviso. Ver `PresenciaService.noSePresento`.
   */
  async noSePresento(pedidoId: number, usuario: UserContext) {
    return this.presencia.noSePresento(pedidoId, usuario);
  }

  /**
   * Oct 2026: el operador marca la llegada EN NOMBRE del cliente.
   *
   * El caso que lo motiva: hay clientes que llegan a tienda y van directo al
   * mostrador, sin teléfono a la mano o sin el folio. Con el gate de D5 su
   * pedido web está OCULTO de la cola hasta que alguien avisa, así que sin esta
   * acción el operador no tenía forma de hacerlo aparecer — el pedido quedaba
   * atrapado aunque el cliente estuviera enfrente.
   *
   * Toda la escritura vive en `KioskoLlegadaService.confirmarDesdeMostrador`
   * (idempotencia, límite de tasa, realtime e historial compartidos con los
   * caminos del kiosko y de la app del cliente). Aquí solo se delega, para que
   * la consola tenga su endpoint junto a las demás acciones del mostrador.
   *
   * NO cambia el estado del pedido: la llegada es ortogonal al ciclo de vida.
   */
  async marcarLlegada(pedidoId: number, usuario: UserContext) {
    // Validación de tienda/rol aquí, no en el servicio de llegada: `KioskoModule`
    // no puede importar `PedidosModule` (sería un ciclo, porque `PedidosModule`
    // ya importa `KioskoModule`).
    await this.access.cargarYValidar(pedidoId, usuario);
    return this.llegada.confirmarDesdeMostrador(pedidoId, usuario);
  }

  /**
   * Oct 2026: deshace un "Llamar por la TV".
   *
   * En cajero, tomar un pedido se puede deshacer (`liberarPedidoCajero` lo
   * devuelve a la cola). En mostrador no había vuelta atrás: `llamar` movía el
   * folio al panel "Atendiendo" de la TV y el pedido se quedaba ahí. Si el
   * operador se equivocaba de folio, el cliente equivocado quedaba anunciado en
   * la pantalla y el correcto ya no estaba en la lista de espera.
   *
   * F17 (oct 2026): ahora es una TRANSICIÓN real (`EN_ATENCION → REVISADO`)
   * en vez de limpiar `llamadoAt` a mano. Antes el estado no cambiaba, así que
   * "llamado" y "en el área de entrega" eran indistinguibles y el panel "Atendiendo"
   * dependía de una columna que cada query tenía que recordar filtrar.
   *
   * NO se llama `liberar` a propósito: en mostrador ese nombre ya significa
   * `REVISADO → PENDIENTE_PAGO` (el pedido entra al ERP). Devolver a la cola es
   * lo contrario de eso.
   *
   * Tampoco asigna el pedido a una persona: el mostrador es una cola lineal por
   * decisión D16, no un modelo de ventanillas 1:1 como el cajero.
   */
  async devolverACola(pedidoId: number, usuario: UserContext) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    // Solo desde EN_ATENCION: un pedido que nunca se llamó ya está en la cola,
    // así que "devolverlo" no significa nada.
    this.exigirEstado(pedido.estado, 'devolver a la cola', [EstadoPedido.EN_ATENCION]);

    const completo = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { numeroPedido: true, tiendaId: true },
    });
    if (!completo) throw new BadRequestException('Pedido no encontrado');

    await this.pedidoState.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.REVISADO,
        observacion: `Devuelto a la cola por ${usuario.nombre}`,
      },
      usuario,
      { invalidarMonitor: true },
    );

    // `llamadoAt` (y quién llamó / desde qué mostrador) los limpia la máquina de
    // estados al salir de EN_ATENCION. Antes se hacía aquí con un `update` aparte.

    this.logger.log(
      `Pedido ${pedidoId} (${completo.numeroPedido}): devuelto a la cola por ${usuario.nombre}`,
    );

    return { ok: true, pedidoId };
  }

  /**
   * Oct 2026: trae al área de entrega un pedido que estaba en asesoría.
   *
   * El caso: el cliente pidió un asesor de ventas, el asesor revisó con él y no
   * había nada que negociar (o el cliente se cansó de esperar y llegó a
   * tienda). El pedido está en `EN_ASESORIA` y el operador lo tiene enfrente.
   *
   * `TRANSICIONES[EN_ASESORIA]` ya incluía `REVISADO`, pero **nadie la
   * disparaba**: el front solo le ofrecía al operador "avisar llegada", que
   * registra la presencia pero NO mueve el pedido a la cola (el gate de
   * visibilidad exige `REVISADO`). Así que el cliente se quedaba de pie
   * esperando un pedido que nunca aparecía en la pantalla del mostrador.
   *
   * `asignacion: 'limpiar'` es explícito y obligatorio: el caller es el
   * OPERADOR, no un bodeguero. Con 'caller' el pedido quedaría asignado a un
   * usuario de mostrador, invisible en el monitor de bodega.
   */
  async traerAEntrega(pedidoId: number, usuario: UserContext, nota?: string) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    // Solo desde EN_ASESORIA: un pedido que ya está en el área de entrega no
    // necesita que nadie lo "traiga", y uno en bodega todavía no existe
    // físicamente para entregarse.
    this.exigirEstado(pedido.estado, 'traer al área de entrega', [EstadoPedido.EN_ASESORIA]);

    const completo = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { numeroPedido: true, tiendaId: true },
    });
    if (!completo) throw new BadRequestException('Pedido no encontrado');

    const sufijoNota = nota ? ` — ${nota}` : '';

    await this.pedidoState.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.REVISADO,
        observacion: `Traído al área de entrega por ${usuario.nombre} (venía de asesoría)${sufijoNota}`,
      },
      usuario,
      {
        // El caller es el operador, no un bodeguero: el pedido vuelve a la cola
        // sin asignar. Ver el comentario del método.
        asignacion: 'limpiar',
        // Ya no es tarea de bodega (venía de ventas, no de surtido).
        reloj: 'detener',
        // La TV de mostrador y la de bodega tienen que recomputar.
        invalidarMonitor: true,
        // F22: el cliente está ENFRENTE. "Tu pedido ya está listo en tienda" por
        // correo a quien está de pie en el mostrador es ruido.
        sinNotificar: true,
      },
    );

    // F22: el cliente está enfrente, así que queda registrado que llegó. Es lo que
    // hace que el pedido APAREZCA en la cola: el gate exige cliente presente, y un
    // pedido web traído desde asesoría sin aviso quedaba oculto en "Sin aviso" con
    // el cliente de pie esperando — justo el caso que esta acción debía resolver.
    // (`ajustar` ya lo hacía; esta acción no.)
    //
    // Best-effort, por la misma razón que en `ajustar`: la transición ya se aplicó
    // y no se puede deshacer; un aviso faltante se marca a mano.
    try {
      await this.llegada.confirmarDesdeMostrador(pedidoId, usuario);
    } catch (err) {
      this.logger.warn(
        `Pedido ${pedidoId}: se trajo al área de entrega pero no se pudo registrar la llegada ` +
          `(${(err as Error).message}). Quedará en "Sin aviso" hasta marcarla a mano.`,
      );
    }

    this.logger.log(
      `Pedido ${pedidoId} (${completo.numeroPedido}): traído al área de entrega desde asesoría ` +
        `por ${usuario.nombre}`,
    );

    return { ok: true, pedidoId, estado: EstadoPedido.REVISADO };
  }

  /**
   * Manda a llamar al SIGUIENTE de la cola (FIFO), sin que el operador tenga
   * que elegir el pedido. Es el espejo de `CajeroService.llamarSiguiente`.
   *
   * Por qué existe: en cajero el operador puede llamar al siguiente o tomar
   * uno específico; en mostrador solo estaba lo segundo. Con un cliente
   * enfrente el operador busca su folio, pero cuando la fila está llena y
   * nadie se acerca, llamar al siguiente es el flujo natural — y era el único
   * caso donde el operador tenía que elegir un pedido a mano.
   *
   * Elige el PRIMERO de la cola de revisión: mismo orden que ve la consola
   * (`fechaPedido asc`), así que "el siguiente" es literalmente la primera
   * fila de la pestaña "Por revisar".
   *
   * Reutiliza `llamar` para no duplicar los efectos (llamadoAt, historial,
   * realtime, invalidación del monitor).
   */
  async llamarSiguiente(usuario: UserContext, tiendaId: number | undefined = usuario.tiendaId) {
    // Oct 2026 (PLAN-ADMIN-MULTITIENDA): la tienda llega resuelta (`@TiendaConsola()`): la del token para
    // un empleado, la que está operando para el ADMIN (que no trae una). Sin ella, el ADMIN no tenía cómo
    // decir de qué cola llamar y recibía "no tiene tienda asignada".
    if (!tiendaId) {
      throw new BadRequestException('Tu usuario no tiene tienda asignada');
    }

    const siguiente = await this.prisma.pedido.findFirst({
      where: {
        tiendaId,
        // F17: solo REVISADO. Un pedido ya llamado está en EN_ATENCION, así que
        // el estado por sí solo lo excluye — el filtro `llamadoAt: null` que
        // hacía falta antes ya no es necesario.
        estado: EstadoPedido.REVISADO,
        // F18 (oct 2026): el MISMO gate de presencia que `obtenerCola`.
        //
        // Sin esto, "Llamar siguiente" podía elegir un pedido WEB **sin aviso
        // de llegada** — que es invisible en la consola. El operador anunciaba
        // en la TV el folio de un cliente que no está en la tienda, y el pedido
        // que sí estaba esperando no se llamaba.
        ...wherePresente(),
      },
      // F22: el MISMO orden que la cola (`ORDEN_COLA`): primero llegado, primero
      // atendido. Antes ordenaba por `llegadaAnunciadaAt nulls last`, así que
      // todo web con aviso pasaba delante de cualquier kiosko.
      orderBy: ORDEN_COLA,
      select: { id: true },
    });
    if (!siguiente) {
      throw new NotFoundException('No hay pedidos en la cola por revisar');
    }

    return this.llamar(siguiente.id, usuario);
  }

  /**
   * Guard de las acciones del operador sobre un pedido que ya está en la mesa.
   *
   * F17 (oct 2026): acepta una LISTA de estados, no uno solo. Antes todas las
   * acciones exigían el estado de área de entrega, pero con `EN_ATENCION` el pedido
   * puede estar en dos puntos de la misma etapa: en el área de entrega esperando al
   * cliente, o ya llamado y siendo atendido. Casi todas las acciones aplican
   * en los dos; `llamar` es la excepción (solo desde REVISADO — no se llama
   * dos veces al mismo cliente).
   *
   * El mensaje nombra el estado real, para que el operador entienda por qué no
   * aplica en vez de recibir un 400 seco.
   */
  private exigirEstado(
    estadoActual: EstadoPedido,
    accion: string,
    permitidos: EstadoPedido[] = [EstadoPedido.REVISADO, EstadoPedido.EN_ATENCION],
  ): void {
    if (!permitidos.includes(estadoActual)) {
      throw new BadRequestException(
        `Solo se puede ${accion} un pedido en ${permitidos.join(' o ')} (actual: ${estadoActual})`,
      );
    }
  }

  /**
   * F16 (sep 2026): el operador manda a llamar a un cliente.
   *
   * NO cambia el estado del pedido — es una señal de cola, igual que el aviso
   * de llegada. Existe porque el monitor de mostrador ES el canal de aviso del
   * flujo (decisión D16): el cliente ve su folio en la pantalla de la tienda y
   * sabe que le toca pasar a revisar su pedido. No hay email.
   *
   * Emite `pedido.llamado-mostrador` a `tienda-{id}` para que la TV muestre la
   * alerta grande y suene. El payload lleva el folio y el nombre del cliente
   * para que se identifique, más el nombre del operador (para que el cliente
   * sepa a quién buscar).
   *
   * Se registra en el historial para poder auditar cuántas veces se llamó a un
   * mismo pedido (útil si el cliente no aparece).
   */
  async llamar(pedidoId: number, usuario: UserContext) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    // Solo desde REVISADO: un pedido ya llamado (EN_ATENCION) no se vuelve a
    // llamar — quedaría pegado en el panel "Atendiendo" y sonaría la alerta de
    // nuevo para un cliente que ya está enfrente.
    this.exigirEstado(pedido.estado, 'llamar', [EstadoPedido.REVISADO]);

    const completo = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        numeroPedido: true,
        folioErp: true,
        clienteNombre: true,
        tiendaId: true,
        canalOrigen: true,
        llegadaAnunciadaAt: true,
        llegadaDescartadaAt: true,
      },
    });
    if (!completo) throw new BadRequestException('Pedido no encontrado');

    // F22: solo se llama a un cliente que está en la tienda.
    //
    // Antes `llamar` no lo comprobaba. Llamar a un pedido web sin aviso lo movía a
    // `EN_ATENCION`, donde la consola y la TV (que exigen cliente presente) ya no
    // lo mostraban: la TV anunciaba un folio de alguien que no estaba y el pedido
    // quedaba atascado sin que ninguna pantalla lo listara. La UI no ofrece el
    // botón, pero la API es frontera de confianza.
    if (!clientePresenteEnTienda(completo)) {
      throw new BadRequestException(
        'Este cliente no ha avisado que está en la tienda. Marca su llegada ' +
          '("El cliente está aquí") antes de llamarlo, o envíalo a pagar directamente ' +
          'si lo tienes enfrente.',
      );
    }

    // F22: desde QUÉ mostrador se llama. La TV dice "Pasa al mostrador N". Con
    // varios operadores, un "pasa a mostrador" a secas deja al cliente sin saber a
    // quién acercarse. Tira 400 si la tienda tiene mostradores y el operador no
    // eligió el suyo; devuelve null en una tienda sin mostradores configurados.
    const mostrador = await this.mostradores.resolverParaLlamar(
      usuario.userId,
      completo.tiendaId,
      usuario.rol === RolUsuario.ADMIN,
    );

    // `UserContext` no trae apellido (viene del JWT), así que el nombre del
    // operador es el que ya está disponible.
    const nombreOperador = usuario.nombre;

    // F17 (oct 2026): llamar es una TRANSICIÓN DE ESTADO, no una columna.
    //
    // Antes esto escribía `llamadoAt` a mano y el panel "Atendiendo" era
    // `llamadoAt IS NOT NULL`. Ese diseño tenía dos problemas: (a) cada query
    // de mostrador tenía que acordarse del filtro, y (b) "llamado" y
    // "atendiendo" eran el mismo dato, así que no se podía distinguir al
    // cliente que ya está enfrente del que todavía no llega.
    //
    // `llamadoAt` se sigue escribiendo, pero ahora es auditoría (cuándo se
    // llamó), no el discriminador del panel.
    //
    // F22: `llamadoAt`, quién llamó y desde qué mostrador se escriben DENTRO de la
    // transición (`efectos`). Antes `llamadoAt` era un `update` aparte después del
    // commit: si fallaba, el pedido quedaba en `EN_ATENCION` sin fecha de llamada.
    await this.pedidoState.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.EN_ATENCION,
        observacion:
          `Llamado a ${mostrador ? `mostrador ${mostrador.numero}` : 'mostrador'} ` +
          `por ${nombreOperador}`,
      },
      usuario,
      {
        // El pedido sigue siendo del mostrador: no se toca la asignación (que
        // ya es null en esta etapa) ni el reloj de bodega (ya está detenido).
        invalidarMonitor: true,
        efectos: async (tx) => {
          await tx.pedido.update({
            where: { id: pedidoId },
            data: {
              llamadoAt: new Date(),
              llamadoPorId: usuario.userId > 0 ? usuario.userId : null,
              llamadoMostradorId: mostrador?.id ?? null,
            },
          });
        },
      },
    );

    // La TV necesita el payload rico (folio + mostrador) para la alerta grande;
    // `pedido.estado` ya se emitió desde la máquina, pero no lleva estos datos.
    this.realtime.emitToTienda(completo.tiendaId, 'pedido.llamado-mostrador', {
      id: pedidoId,
      numeroPedido: completo.numeroPedido,
      turno: turnoCorto(completo.folioErp),
      clienteNombre: completo.clienteNombre,
      operadorId: usuario.userId,
      operadorNombre: nombreOperador,
      mostradorId: mostrador?.id ?? null,
      mostradorNumero: mostrador?.numero ?? null,
    });

    this.logger.log(
      `Pedido ${pedidoId} (${completo.numeroPedido}): llamado a mostrador` +
        `${mostrador ? ` ${mostrador.numero}` : ''} por ${nombreOperador}`,
    );

    return {
      pedidoId,
      numeroPedido: completo.numeroPedido,
      // Con estas dos el servidor decora la respuesta con su `folio` (el toast de la operadora lo usa).
      tiendaId: completo.tiendaId,
      folioErp: completo.folioErp,
      clienteNombre: completo.clienteNombre,
      operadorNombre: nombreOperador,
      mostradorId: mostrador?.id ?? null,
      mostradorNumero: mostrador?.numero ?? null,
    };
  }

  /**
   * Marca un pedido como entregado (PAID|SHIPPED → COMPLETED).
   *
   * Validaciones (defensa en profundidad — el controller también valida rol):
   *   1. El pedido pertenece a la tienda del usuario (ADMIN pasa).
   *   2. El pedido está en PAID o SHIPPED.
   *
   * El frontend ya validó que el operador marcó todos los items como
   * entregados en la UI. Esta capa NO recibe la lista de items
   * confirmados: confía en la decisión humana del mostrador. Si en el
   * futuro se requiere trazabilidad pieza-por-pieza, se puede añadir
   * `itemsVerificados: number[]` al body y persistirlo en
   * `HistorialPedido.observacion`.
   */
  async entregar(pedidoId: number, usuario: UserContext, recogioNombre?: string) {
    // 1. Cargar y validar acceso (ADMIN cross-tienda, MOSTRADOR solo su tienda).
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);

    // 2. Validar estado.
    if (pedido.estado !== EstadoPedido.PAGADO && pedido.estado !== EstadoPedido.ENVIADO) {
      throw new BadRequestException(
        `Solo se pueden entregar pedidos en PAID o SHIPPED (actual: ${pedido.estado})`,
      );
    }

    // 3. Quién recoge. Oct 2026 (16-oct): a la tienda llegan mandaderos y familiares, no solo el
    //    titular, y `entregar` no dejaba constancia de quién se llevó la mercancía. El nombre solo
    //    se guarda si NO es el titular: el del titular ya está en `clienteNombre`, y repetirlo
    //    en el correo ("Recogió: <el mismo>") sería ruido.
    const titular = recogioNombre?.trim()
      ? ((
          await this.prisma.pedido.findUnique({
            where: { id: pedidoId },
            select: { clienteNombre: true },
          })
        )?.clienteNombre ?? '')
      : '';
    const recogio = this.normalizarRecogio(recogioNombre, titular);

    // 4. Delegar al servicio central para transición + historial + realtime
    //    + notificación al cliente (ENTREGADO). La observación incluye el
    //    rol para distinguir en el historial si fue entregado en mostrador
    //    o por bodega en una migración.
    //
    //    `recogioNombre` se escribe en la MISMA transacción que la transición (`efectos`): el correo
    //    de "entregado" relee el pedido DESPUÉS del commit y tiene que encontrarlo ya guardado.
    return this.pedidoState.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.ENTREGADO,
        observacion:
          `Entregado en mostrador por ${usuario.nombre}` +
          (recogio ? ` — lo recogió ${recogio} (no es el titular)` : ''),
      },
      usuario,
      {
        efectos: async (tx) => {
          if (recogio) {
            await tx.pedido.update({ where: { id: pedidoId }, data: { recogioNombre: recogio } });
          }
        },
      },
    );
  }

  /**
   * El nombre de quien recoge, limpio: sin espacios de más, mínimo 3 letras, y `null` si no hay o si
   * es el mismo titular (sin acentos ni mayúsculas, para que "jose perez" no se anote como otra
   * persona que "José Pérez").
   */
  private normalizarRecogio(nombre: string | undefined, titular: string): string | null {
    const limpio = (nombre ?? '').replace(/\s+/g, ' ').trim();
    if (!limpio) return null;
    if (limpio.length < 3) {
      throw new BadRequestException('Escribe el nombre completo de quien recoge el pedido.');
    }
    const plano = (t: string) =>
      t
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
    return plano(limpio) === plano(titular) ? null : limpio;
  }
}
