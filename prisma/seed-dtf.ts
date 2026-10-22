import { PrismaClient, RolUsuario, TecnologiaDtf } from '@prisma/client';
import * as bcrypt from 'bcrypt';

/**
 * Datos de ejemplo de la impresión DTF (PLAN-DTF.md). IDEMPOTENTE y NO destructivo: solo hace upsert
 * (el seed principal borra pedidos; este no). Se puede correr solo:
 *
 *   npx ts-node prisma/seed-dtf.ts
 *
 * Defaults de la demo [SUPUESTO, se ajustan en /admin/dtf]: Textil $220/m, paso de cobro 50 cm
 * (0.6 m → 1.0 m), mínimo 50 cm; UV $600/m, paso 20 cm, mínimo 20 cm. Ancho útil 57 cm.
 */
export async function seedDtf(prisma: PrismaClient) {
  const textil = await prisma.dtfTipo.upsert({
    where: { tecnologia: TecnologiaDtf.TEXTIL },
    update: {},
    create: {
      tecnologia: TecnologiaDtf.TEXTIL, nombre: 'DTF Textil', orden: 1, precioMetro: 220, minimoCm: 50, pasoCobroCm: 50,
      descripcion: 'Transfer a full color para playeras y telas. Se imprime a partir de medio metro.',
    },
  });
  const uv = await prisma.dtfTipo.upsert({
    where: { tecnologia: TecnologiaDtf.UV },
    update: {},
    create: {
      tecnologia: TecnologiaDtf.UV, nombre: 'DTF UV', orden: 2, precioMetro: 600, minimoCm: 20, pasoCobroCm: 20,
      descripcion: 'Calcomanías UV para vasos, termos y superficies rígidas. Se imprime desde 20 cm.',
    },
  });

  const tiendas = await prisma.tienda.findMany({ where: { activa: true }, orderBy: { id: 'asc' } });
  const mexicali = tiendas.find((t) => t.ciudad === 'Mexicali');
  const obregon = tiendas.find((t) => t.ciudad === 'Ciudad Obregón');
  const habilitar = async (tiendaId: number, tipoId: number, maquina: string, vel: number, corte: string) =>
    prisma.tiendaDtf.upsert({
      where: { tiendaId_tipoId: { tiendaId, tipoId } },
      update: {},
      create: { tiendaId, tipoId, activo: true, maquina, velocidadMetrosHora: vel, horaCorte: corte },
    });
  // Mexicali imprime las dos; Obregón solo Textil; Hermosillo y Monterrey NO imprimen DTF (el ADMIN las enciende).
  if (mexicali) {
    await habilitar(mexicali.id, textil.id, 'Impresora Textil 60 cm', 6, '17:00');
    await habilitar(mexicali.id, uv.id, 'Impresora UV 60 cm', 3, '16:00');
  }
  if (obregon) await habilitar(obregon.id, textil.id, 'Impresora Textil 60 cm', 6, '17:00');

  const passwordHash = await bcrypt.hash('123456', 10);
  const usuario = async (email: string, nombre: string, apellido: string, tiendaId: number) =>
    prisma.usuario.upsert({
      where: { email },
      update: { rol: RolUsuario.IMPRESION, tiendaId, activo: true },
      create: { email, password: passwordHash, nombre, apellido, rol: RolUsuario.IMPRESION, tiendaId, emailVerified: true },
    });
  if (mexicali) {
    await usuario('impresion@puntotextil.com', 'Usuario', 'Impresión', mexicali.id);
    await usuario('impresion2@puntotextil.com', 'Usuario', 'Impresión 2', mexicali.id);
  }
  if (obregon) await usuario('impresion.obregon@puntotextil.com', 'Usuario', 'Impresión Obregón', obregon.id);
  return { tipos: 2, tiendas: [mexicali?.nombre, obregon?.nombre].filter(Boolean) };
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seedDtf(prisma)
    .then((r) => console.log('DTF sembrado:', JSON.stringify(r)))
    .finally(() => prisma.$disconnect());
}
