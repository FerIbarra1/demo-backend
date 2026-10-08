-- Oct 2026: el texto que el cliente escribe al pedir un asesor deja de viajar
-- como nota y pasa a ser el PRIMER MENSAJE del chat con el asesor.
--
-- Por qué se elimina la columna en vez de dejarla: guardaba el mismo dato que
-- ahora vive en `pedidos_mensajes`. Dejarla viva garantizaba que en la próxima
-- ronda alguien la leyera "porque ya estaba ahí" y el asesor volviera a ver un
-- texto congelado en su cola mientras el cliente seguía escribiendo en el chat.
--
-- Qué se pierde: el texto de los pedidos que pidieron asesor ANTES de este
-- cambio. Es aceptable — esos pedidos ya tienen su mensaje de sistema en el
-- chat ("Solicitaste hablar con un asesor de ventas…"), que es lo que el
-- cliente veía. El chat del asesor no se toca.
--
-- Irreversible: no hay down-migration. El dato no se puede recuperar.

ALTER TABLE "pedidos" DROP COLUMN "asesor_solicitud_nota";
