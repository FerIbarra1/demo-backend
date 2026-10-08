import { Prisma, RolUsuario } from '@prisma/client';

/**
 * Oct 2026: ¿cuántos mensajes no ha leído cada lado?
 *
 * El badge de "mensajes nuevos" de las listas vivía en un contador de Zustand
 * persistido en `localStorage` (`stores/notificacionesCliente.ts`). Eso tenía
 * tres problemas:
 *
 * 1. **Era por dispositivo.** Abrías el pedido en el celular y la laptop seguía
 *    mostrando el badge. El dato real (el watermark) vive en la BD.
 * 2. **Se perdía.** Limpiar el navegador, o entrar desde otro equipo, borraba
 *    los no leídos.
 * 3. **No existía en la cola de ventas.** El asesor no tenía forma de saber qué
 *    pedidos tenían mensajes del cliente sin abrirlos uno por uno.
 *
 * Ahora se deriva del watermark, que ya existía y ya se mantiene bien
 * (`MessagesService.marcarLeido`). Un mensaje está sin leer si:
 *
 *   - es del OTRO lado (los míos no cuentan como no leídos),
 *   - su id supera mi watermark,
 *   - y (para el cliente) es visible para él.
 *
 * **Por qué SQL crudo y no Prisma.** El umbral es una columna del PADRE
 * (`pedidos.cliente_ultimo_mensaje_leido_id`) y Prisma no puede referenciar la
 * fila padre desde un `_count` filtrado. Las alternativas eran N+1 consultas o
 * traer todos los mensajes de todos los pedidos a memoria. Una subconsulta
 * correlacionada es un solo round-trip, y el índice
 * `pedidos_mensajes_pedido_id_created_at_idx` ya existe.
 *
 * El `COALESCE(..., 0)` es lo que hace que un pedido con mensajes sin leer y
 * SIN watermark (nunca se abrió) cuente todos sus mensajes del otro lado, que
 * es lo correcto.
 */

/** Lado del chat desde el que se mira la lista. */
export type LadoLista = 'cliente' | 'tienda';

/**
 * Devuelve un mapa `pedidoId → mensajes sin leer` para los pedidos indicados.
 *
 * @param ids Los pedidos de la página que se está listando. Acotar por id es lo
 *   que mantiene la subconsulta barata: sin él se evaluaría para toda la tabla.
 * @param lado Quién mira. Decide qué autorRol cuenta como "del otro lado".
 */
export async function contarMensajesNoLeidos(
  prisma: Prisma.TransactionClient | { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  ids: number[],
  lado: LadoLista,
): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();

  // El cliente solo cuenta lo visible para él; el lado tienda ve todo.
  //
  // El rol que cuenta como "del otro lado" es el complemento: para el cliente
  // son los mensajes de empleados (cualquier rol que no sea CLIENTE); para la
  // tienda, los del cliente.
  const esCliente = lado === 'cliente';
  const filtroRol = esCliente
    ? Prisma.sql`m.autor_rol <> ${RolUsuario.CLIENTE}::"RolUsuario"`
    : Prisma.sql`m.autor_rol = ${RolUsuario.CLIENTE}::"RolUsuario"`;
  const filtroVisible = esCliente ? Prisma.sql`AND m.visible_para_cliente = true` : Prisma.empty;
  const campoWatermark = esCliente
    ? Prisma.sql`p.cliente_ultimo_mensaje_leido_id`
    : Prisma.sql`p.tienda_ultimo_mensaje_leido_id`;

  const filas = await prisma.$queryRaw<Array<{ pedido_id: number; no_leidos: bigint }>>(
    Prisma.sql`
      SELECT p.id AS pedido_id,
             COUNT(m.id) AS no_leidos
      FROM pedidos p
      LEFT JOIN pedidos_mensajes m
        ON m.pedido_id = p.id
       AND m.id > COALESCE(${campoWatermark}, 0)
       AND ${filtroRol}
       ${filtroVisible}
      WHERE p.id IN (${Prisma.join(ids)})
      GROUP BY p.id
    `,
  );

  return new Map(filas.map((f) => [f.pedido_id, Number(f.no_leidos)]));
}
