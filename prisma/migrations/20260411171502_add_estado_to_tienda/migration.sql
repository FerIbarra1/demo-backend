/*
  Warnings:

  - Added the required column `estado` to the `tiendas` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "tiendas" ADD COLUMN     "estado" VARCHAR(50) NOT NULL;
