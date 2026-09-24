-- F16 (sep 2026): rol de la TV del mostrador.
--
-- La TV solo LEE la cola de `EN_MOSTRADOR` y muestra la alerta cuando el
-- operador manda a llamar a un cliente. No puede liberar, ajustar ni cancelar:
-- por eso es un rol propio y no reusa MOSTRADOR (una pantalla de pared no debe
-- tener permisos de operador).
--
-- Al final del enum: nada ordena por `RolUsuario` en SQL.
--
-- `ALTER TYPE ... ADD VALUE` no puede correr dentro de una transacción en
-- Postgres < 12; el proyecto usa 18-alpine, que sí lo soporta.

ALTER TYPE "RolUsuario" ADD VALUE 'MOSTRADOR_MONITOR';
