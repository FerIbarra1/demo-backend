-- Oct 2026 (propuestas, 3c): `pedidos_propuestas.vista_at` — cuándo el CLIENTE abrió
-- la propuesta por primera vez.
--
-- El problema que arregla: el operador de mostrador con una propuesta pendiente solo
-- podía decir "sin respuesta". Pero "no contestó" y "ni siquiera la abrió" piden
-- acciones distintas: el segundo es el cliente que no se enteró (nunca vio el aviso) y
-- está parado en el mostrador, y no hay que insistirle por la app sino explicársela.
--
-- NULL = nunca la ha visto. ADITIVA y nullable: las propuestas existentes quedan en
-- NULL, que para las ya resueltas no significa nada y para las pendientes es la lectura
-- conservadora ("no la ha abierto") hasta que el cliente la abra. No reinterpreta ni
-- pierde un solo dato.
ALTER TABLE "pedidos_propuestas"
    ADD COLUMN "vista_at" TIMESTAMP(3);
