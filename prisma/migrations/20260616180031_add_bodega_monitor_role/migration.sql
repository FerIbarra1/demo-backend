-- Añadir BODEGA_MONITOR al enum RolUsuario.
-- PostgreSQL >= 10 soporta ALTER TYPE ... ADD VALUE de forma no transaccional.
ALTER TYPE "RolUsuario" ADD VALUE IF NOT EXISTS 'BODEGA_MONITOR';
