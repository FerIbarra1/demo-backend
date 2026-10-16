-- Oct 2026: `pedidos.espera_validacion_desde_at` — "regresar a la cola hasta que se valide".
--
-- El problema que resuelve: a una ventanilla puede llegar un cliente con una transferencia SIN
-- validar (el dinero aún no está verificado por Tesorería). La cajera no puede cobrarle en caja
-- (sería doble pago) y puede preferir no esperarlo ahí. "Devolver a la cola" lo dejaba primero
-- y "Llamar siguiente" lo volvía a llamar al instante, y otra vez.
--
-- Esta marca le dice a "Llamar siguiente" que lo salte MIENTRAS la transferencia siga sin
-- verificar. El lugar en la fila no cambia (`cola_caja_desde_at` no se toca).
--
-- ADITIVA y nullable: sin marca = comportamiento de siempre. No hace falta rellenar nada.
ALTER TABLE "pedidos"
    ADD COLUMN "espera_validacion_desde_at" TIMESTAMP(3);
