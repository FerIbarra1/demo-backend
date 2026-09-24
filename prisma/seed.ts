import { PrismaClient, RolUsuario } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// ============================================
// CONFIGURACIÓN DE PRODUCTOS POR IMÁGENES
// ============================================
// Las imágenes viven en S3 (ver getImagenUrl más abajo).
// Formato: {modelo}-{color}-{num-img}.webp
// Ejemplo: C0200-caribe-1.webp
//
// IMPORTANTE: Se usan rutas relativas (/products/...) para evitar
// problemas de CORS cuando el frontend corre en otro puerto.
//
// Los productos provienen del catálogo de Yazbek (yazbek.com.mx).
// Cada modelo (código C/D/N/J/B + número) tiene varios colores; aquí se
// agrupa un modelo con 5 de sus colores. Precios en MXN de la tienda.

const PRODUCTOS_CONFIG = [
  {
    codigo: 'C0200',
    nombre: 'Playera Cuello Redondo Manga Corta para Caballero · 100% Algodón',
    descripcion: 'Peso 155 gr/m², tejido chifón, composición 100% algodón.',
    categoria: 'Playeras',
    subcategoria: 'Manga Corta',
    precioBase: 60.0,
    colores: [
      { nombre: 'Caribe', hex: '#0E7C7B', imagenes: ['C0200-caribe-1.webp', 'C0200-caribe-2.webp', 'C0200-caribe-3.webp'] },
      { nombre: 'Negro', hex: '#000000', imagenes: ['C0200-negro-1.webp', 'C0200-negro-2.webp', 'C0200-negro-3.webp'] },
      { nombre: 'Marino', hex: '#1F2A44', imagenes: ['C0200-marino-1.webp', 'C0200-marino-2.webp', 'C0200-marino-3.webp'] },
      { nombre: 'Blanco', hex: '#FFFFFF', imagenes: ['C0200-blanco-1.webp', 'C0200-blanco-2.webp', 'C0200-blanco-3.webp'] },
      { nombre: 'Arena', hex: '#C2B280', imagenes: ['C0200-arena-1.webp', 'C0200-arena-2.webp', 'C0200-arena-3.webp'] },
    ],
  },
  {
    codigo: 'C0300',
    nombre: 'Playera Peso Completo Cuello Redondo Manga Corta para Caballero · 100% Algodón',
    descripcion: 'Peso 195 gr/m², tejido chifón, composición 100% algodón.',
    categoria: 'Playeras',
    subcategoria: 'Peso Completo Manga Corta',
    precioBase: 65.0,
    colores: [
      { nombre: 'Blanco', hex: '#FFFFFF', imagenes: ['C0300-blanco-1.webp', 'C0300-blanco-2.webp', 'C0300-blanco-3.webp'] },
      { nombre: 'Negro', hex: '#000000', imagenes: ['C0300-negro-1.webp', 'C0300-negro-2.webp', 'C0300-negro-3.webp'] },
      { nombre: 'Marino', hex: '#1F2A44', imagenes: ['C0300-marino-1.webp', 'C0300-marino-2.webp', 'C0300-marino-3.webp'] },
      { nombre: 'Marrón', hex: '#6B4226', imagenes: ['C0300-marron-1.webp', 'C0300-marron-2.webp', 'C0300-marron-3.webp'] },
      { nombre: 'Jade', hex: '#00A86B', imagenes: ['C0300-jade-1.webp', 'C0300-jade-2.webp', 'C0300-jade-3.webp'] },
    ],
  },
  {
    codigo: 'D0200',
    nombre: 'Playera Cuello Redondo Manga Corta para Dama · 100% Algodón',
    descripcion: 'Peso 155 gr/m², tejido chifón, composición 100% algodón.',
    categoria: 'Playeras',
    subcategoria: 'Manga Corta Dama',
    precioBase: 60.0,
    colores: [
      { nombre: 'Lavanda', hex: '#B57EDC', imagenes: ['D0200-lavanda-1.webp', 'D0200-lavanda-2.webp', 'D0200-lavanda-3.webp'] },
      { nombre: 'Fucsia', hex: '#FF00FF', imagenes: ['D0200-fucsia-1.webp', 'D0200-fucsia-2.webp', 'D0200-fucsia-3.webp'] },
      { nombre: 'Marino', hex: '#1F2A44', imagenes: ['D0200-marino-1.webp', 'D0200-marino-2.webp', 'D0200-marino-3.webp'] },
      { nombre: 'Blanco', hex: '#FFFFFF', imagenes: ['D0200-blanco-1.webp', 'D0200-blanco-2.webp', 'D0200-blanco-3.webp'] },
      { nombre: 'Arena', hex: '#C2B280', imagenes: ['D0200-arena-1.webp', 'D0200-arena-2.webp', 'D0200-arena-3.webp'] },
    ],
  },
  {
    codigo: 'D0300',
    nombre: 'Playera Peso Completo Cuello Redondo Manga Corta con Silueta para Dama · 100% Algodón',
    descripcion: 'Peso 195 gr/m², tejido chifón, composición 100% algodón.',
    categoria: 'Playeras',
    subcategoria: 'Peso Completo Manga Corta Dama',
    precioBase: 65.0,
    colores: [
      { nombre: 'Negro', hex: '#000000', imagenes: ['D0300-negro-1.webp', 'D0300-negro-2.webp', 'D0300-negro-3.webp'] },
      { nombre: 'Turquesa', hex: '#40E0D0', imagenes: ['D0300-turquesa-1.webp', 'D0300-turquesa-2.webp', 'D0300-turquesa-3.webp'] },
      { nombre: 'Marino', hex: '#1F2A44', imagenes: ['D0300-marino-1.webp', 'D0300-marino-2.webp', 'D0300-marino-3.webp'] },
      { nombre: 'Fucsia', hex: '#FF00FF', imagenes: ['D0300-fucsia-1.webp', 'D0300-fucsia-2.webp', 'D0300-fucsia-3.webp'] },
      { nombre: 'Rojo', hex: '#FF0000', imagenes: ['D0300-rojo-1.webp', 'D0300-rojo-2.webp', 'D0300-rojo-3.webp'] },
    ],
  },
  {
    codigo: 'C1302',
    nombre: 'Playera Cuello Redondo Manga Corta para Caballero · 100% Poliéster',
    descripcion: 'Peso 150 gr/m², tejido mesh, composición 100% poliéster.',
    categoria: 'Playeras',
    subcategoria: 'Manga Corta Poliéster',
    precioBase: 100.0,
    colores: [
      { nombre: 'Negro', hex: '#000000', imagenes: ['C1302-negro-1.webp', 'C1302-negro-2.webp', 'C1302-negro-3.webp'] },
      { nombre: 'Rojo', hex: '#FF0000', imagenes: ['C1302-rojo-1.webp', 'C1302-rojo-2.webp', 'C1302-rojo-3.webp'] },
      { nombre: 'Marino', hex: '#1F2A44', imagenes: ['C1302-marino-1.webp', 'C1302-marino-2.webp', 'C1302-marino-3.webp'] },
      { nombre: 'Verde Neón', hex: '#39FF14', imagenes: ['C1302-verde-neon-1.webp', 'C1302-verde-neon-2.webp', 'C1302-verde-neon-3.webp'] },
      { nombre: 'Amarillo Neón', hex: '#FFFF00', imagenes: ['C1302-amarillo-neon-1.webp', 'C1302-amarillo-neon-2.webp', 'C1302-amarillo-neon-3.webp'] },
    ],
  },
];

// ============================================
// LISTAS DE PRECIOS (Firebird CLIENTES.LISPRE 1..6)
// ============================================
// La lista 1 es el precio de menudeo (el más caro) y la 6 el de mayoreo (el
// más barato): a mayor volumen, menor precio. `precioBase` y `PrecioCO.precio`
// siguen siendo sinónimo de lista1, así que la lista 1 va con factor 1.0.
//
// El seed puebla las 6 listas porque Firebird todavía no está conectado: sin
// esto todas las listas quedan en 0 y `precioDeLista` cae siempre a su fallback
// (`pco.precio`), con lo que todos los clientes ven el mismo precio sin
// importar su `listaPrecioCodigo`. Cuando el sync real traiga PRECIO1..6 de
// Firebird, estos valores se sobrescriben.
const FACTOR_LISTA: Record<number, number> = {
  1: 1.0,
  2: 0.95,
  3: 0.9,
  4: 0.85,
  5: 0.8,
  6: 0.75,
};

/** Las 6 listas para un precio base, redondeadas a centavos. */
function preciosDeListas(precioBase: number) {
  const conFactor = (lista: number) =>
    Math.round(precioBase * FACTOR_LISTA[lista] * 100) / 100;
  return {
    lista1: conFactor(1),
    lista2: conFactor(2),
    lista3: conFactor(3),
    lista4: conFactor(4),
    lista5: conFactor(5),
    lista6: conFactor(6),
  };
}

// ============================================
// LIMPIEZA
// ============================================
// El seed es IDEMPOTENTE: no borra el catálogo ni los usuarios, los actualiza
// por su clave natural (código / email). Antes hacía `deleteMany` de ~25 tablas
// y reiniciaba secuencias, lo que obligaba a recrear productos y con ellos las
// filas de `productos_imagenes` (cascada). Eso dejaba las imágenes del admin
// huérfanas en S3 y obligaba a re-subirlas cada vez.
//
// Lo que SÍ se borra son los datos TRANSACCIONALES de prueba (pedidos y su
// rastro). Los pedidos apuntan a productos/usuarios por FK, así que recrearlos
// es la única forma de partir de un estado limpio sin tocar el catálogo.
//
// `configuracion_sitio` (el logo de los correos) NUNCA se toca: no está en
// esta lista a propósito.
async function limpiarDatosTransaccionales() {
  console.log('🗑️  Eliminando datos transaccionales (pedidos, kioskos)...');

  // Orden por dependencias FK: primero lo que referencia a pedidos/usuarios.
  await prisma.notificacion.deleteMany({});
  await prisma.pedidoMensaje.deleteMany({});
  await prisma.pedidoPropuesta.deleteMany({});
  await prisma.pedidoReposicion.deleteMany({});
  await prisma.pedidoPendienteEnvio.deleteMany({});
  await prisma.itemPedido.deleteMany({});
  await prisma.historialPedido.deleteMany({});
  await prisma.logActividad.deleteMany({});
  await prisma.pedido.deleteMany({});
  await prisma.favorito.deleteMany({});
  // Kioskos: se recrean abajo. `kiosko_pairings` cae en cascada.
  await prisma.kiosko.deleteMany({});
  // Ventanillas: se recrean abajo (referencian usuarios).
  await prisma.ventanilla.deleteMany({});
  await prisma.refreshToken.deleteMany({});
  await prisma.passwordResetToken.deleteMany({});

  // Secuencias de lo que se recrea. Las de catálogo/usuarios NO se reinician:
  // sus IDs deben seguir siendo estables para no romper referencias externas.
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "items_pedido_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "historial_pedidos_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_propuestas_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_reposicion_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_pendientes_envio_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_mensajes_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "notificaciones_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "ventanillas_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "refresh_tokens_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "password_reset_tokens_id_seq" RESTART WITH 1`;

  console.log('  ✓ Datos transaccionales eliminados\n');
}

// Las imágenes viven en S3 desde sep 2026. El seed escribe la KEY de storage
// (no una URL): el borde de la API la resuelve con StorageService.resolverImagen.
//
// Antes escribía `/products/${archivo}`, una ruta relativa a public/ del
// frontend. Esa carpeta ya no existe, así que esas rutas daban 404.
//
// El seed NO sube los archivos: asume que ya están en el bucket. Para subir los
// que falten usa `pnpm recuperar:imagenes`. NO uses `pnpm migrar:imagenes`: ese
// convierte rutas legacy `/products/` y genera UUIDs, que no coinciden con estas
// keys.
function getImagenUrl(nombreArchivo: string): string {
  return `productos/seed/${nombreArchivo}`;
}

// ============================================
// CAMPOS LEGACY DE IMÁGENES
// ============================================

/**
 * Recalcula `Producto.imagenPrincipal` e `imagenes` desde TODAS sus filas.
 *
 * Escribir esos campos desde PRODUCTOS_CONFIG descartaría las imágenes del
 * admin, que viven en las mismas filas. Replica el orden que usa
 * `imagenes.service.ts` (esPrincipal desc, orden asc).
 */
async function sincronizarCamposLegacy(productoId: number): Promise<void> {
  const filas = await prisma.productoImagen.findMany({
    where: { productoId },
    orderBy: [{ esPrincipal: 'desc' }, { orden: 'asc' }],
    select: { url: true, esPrincipal: true },
  });
  const principal =
    filas.find((f) => f.esPrincipal)?.url ?? filas[0]?.url ?? null;
  await prisma.producto.update({
    where: { id: productoId },
    data: { imagenPrincipal: principal, imagenes: filas.map((f) => f.url) },
  });
}

// ============================================
// HELPERS DE UPSERT
// ============================================
// El seed es idempotente: busca por clave natural y sólo crea si falta. Los
// `update` van vacíos a propósito — el seed no debe pisar lo que el admin
// cambió desde el panel (nombre de tienda, datos de un usuario, etc.).

type DatosTienda = {
  direccion: string;
  ciudad: string;
  estado: string;
  telefono: string;
  email: string;
};

/** Busca la tienda por nombre y la crea si no existe. */
async function upsertTienda(nombre: string, datos: DatosTienda) {
  const existente = await prisma.tienda.findFirst({ where: { nombre } });
  if (existente) return existente;
  return prisma.tienda.create({ data: { nombre, ...datos } });
}

type DatosUsuario = {
  password: string;
  nombre: string;
  apellido?: string;
  telefono?: string;
  rol: RolUsuario;
  tiendaId?: number;
  listaPrecioCodigo?: string;
};

/**
 * Busca el usuario por email y lo crea si no existe.
 *
 * `email` es `@unique` en el schema, así que es la clave natural. El `update`
 * va vacío: re-ejecutar el seed no debe resetear la contraseña ni el perfil que
 * el usuario haya cambiado.
 */
async function upsertUsuario(email: string, datos: DatosUsuario) {
  const existente = await prisma.usuario.findUnique({ where: { email } });
  if (existente) return existente;
  return prisma.usuario.create({ data: { email, ...datos } });
}

async function main() {
  // El seed borra los datos transaccionales (pedidos, kioskos, ventanillas) y
  // reinicia sus secuencias. Es una herramienta de desarrollo: correrlo contra
  // producción destruye pedidos reales.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'El seed es destructivo y no puede ejecutarse con NODE_ENV=production.',
    );
  }
  // Segunda guardia: si DATABASE_URL no apunta a localhost, es una BD remota.
  const dbUrl = process.env.DATABASE_URL || '';
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
    throw new Error(
      'El seed sólo puede ejecutarse contra una base de datos local. ' +
        'DATABASE_URL no apunta a localhost.',
    );
  }

  console.log('🌱 Iniciando seed de datos...\n');

  // ========== LIMPIAR TRANSACCIONAL ==========
  await limpiarDatosTransaccionales();

  // ========== CREAR TIENDAS ==========
  // Las tiendas no tienen clave natural única en el schema, pero `nombre` lo es
  // en la práctica (el seed es su único escritor). Se busca por nombre y sólo
  // se crea si falta, para no cambiar los IDs que referencian pedidos y kioskos.
  console.log('🏪 Creando tiendas...');

  const tiendaMexicali = await upsertTienda('Punto Textil Mexicali', {
    direccion: 'Blvd. Lázaro Cárdenas 481, Ex-Ejido Coahuila, C.P. 21360',
    ciudad: 'Mexicali',
    estado: 'Baja California',
    telefono: '686-000-0001',
    email: 'mexicali@puntotextil.com',
  });

  const tiendaObregon = await upsertTienda('Punto Textil Mayoreo Cd Obregón', {
    direccion: 'Calle Nicolás Bravo 700 B, Col. Centro (Urb. No. 1), C.P. 85000',
    ciudad: 'Ciudad Obregón',
    estado: 'Sonora',
    telefono: '644-000-0002',
    email: 'obregon@puntotextil.com',
  });

  const tiendaHermosillo = await upsertTienda(
    'Distribuidora Punto Textil Hermosillo',
    {
      direccion: 'Boulevard Luis Encinas J. N°573, Col. Pimentel, C.P. 83188',
      ciudad: 'Hermosillo',
      estado: 'Sonora',
      telefono: '662-000-0003',
      email: 'hermosillo@puntotextil.com',
    },
  );

  const tiendaMonterrey = await upsertTienda(
    'Distribuidora Punto Textil Monterrey Tec',
    {
      direccion: 'Av. Eugenio Garza Sada Sur N° 2620, Col. Tecnológico, C.P. 64700',
      ciudad: 'Monterrey',
      estado: 'Nuevo León',
      telefono: '81-0000-0004',
      email: 'monterrey@puntotextil.com',
    },
  );

  console.log(`  ✓ Tienda: ${tiendaMexicali.nombre}`);
  console.log(`  ✓ Tienda: ${tiendaObregon.nombre}`);
  console.log(`  ✓ Tienda: ${tiendaHermosillo.nombre}`);
  console.log(`  ✓ Tienda: ${tiendaMonterrey.nombre}\n`);

  // ========== CREAR USUARIOS ==========
  console.log('👤 Creando usuarios...');
  const passwordHash = await bcrypt.hash('123456', 10);

  const admin = await upsertUsuario('admin@puntotextil.com', {
    password: passwordHash,
    nombre: 'Administrador',
    apellido: 'Sistema',
    rol: RolUsuario.ADMIN,
  });

  const usuarioBodega = await upsertUsuario('bodega@puntotextil.com', {
    password: passwordHash,
    nombre: 'Usuario',
    apellido: 'Bodega',
    rol: RolUsuario.BODEGA,
    tiendaId: tiendaMexicali.id,
  });

  const usuarioCajero = await upsertUsuario('cajero@puntotextil.com', {
    password: passwordHash,
    nombre: 'Usuario',
    apellido: 'Cajero',
    rol: RolUsuario.CAJERO,
    tiendaId: tiendaMexicali.id,
  });

  // F13 (sep 2026): asesor de ventas. Uno por tienda; atiende la cola de
  // pedidos que los clientes escalan desde una propuesta de bodega.
  const usuarioVentas = await upsertUsuario('ventas@puntotextil.com', {
    password: passwordHash,
    nombre: 'Usuario',
    apellido: 'Ventas',
    rol: RolUsuario.VENTAS,
    tiendaId: tiendaMexicali.id,
  });

  // Usuarios dedicados al monitor de bodega (uno por tienda).
  // Pensados para dejarse logueados en TVs de la bodega.
  // Rol BODEGA_MONITOR: login redirige a /bodega-monitor; no puede tomar pedidos.
  await upsertUsuario('monitor.mexicali@puntotextil.com', {
    password: passwordHash,
    nombre: 'Monitor',
    apellido: 'Mexicali',
    rol: RolUsuario.BODEGA_MONITOR,
    tiendaId: tiendaMexicali.id,
  });

  await upsertUsuario('monitor.mty@puntotextil.com', {
    password: passwordHash,
    nombre: 'Monitor',
    apellido: 'Monterrey',
    rol: RolUsuario.BODEGA_MONITOR,
    tiendaId: tiendaMonterrey.id,
  });

  // Cajero MONITOR: TV de ventanillas de la tienda Mexicali.
  // Rol CAJERO_MONITOR. Login redirige a /cajero-monitor.
  await upsertUsuario('cajero.tv.mexicali@puntotextil.com', {
    password: passwordHash,
    nombre: 'TV',
    apellido: 'Cajas Mexicali',
    rol: RolUsuario.CAJERO_MONITOR,
    tiendaId: tiendaMexicali.id,
  });

  // Mostrador: usuario que entrega pedidos ya pagados en tienda.
  // Rol MOSTRADOR. Login redirige a /mostrador.
  const usuarioMostrador = await upsertUsuario('mostrador@puntotextil.com', {
    password: passwordHash,
    nombre: 'Usuario',
    apellido: 'Mostrador',
    rol: RolUsuario.MOSTRADOR,
    tiendaId: tiendaMexicali.id,
  });

  // F16 (sep 2026): TV del mostrador. Rol MOSTRADOR_MONITOR — solo lee la cola
  // y muestra la alerta cuando el operador manda a llamar a un cliente. No
  // puede liberar/ajustar/cancelar (por eso es un rol propio).
  // Login redirige a /mostrador-monitor.
  await upsertUsuario('mostrador.tv.mexicali@puntotextil.com', {
    password: passwordHash,
    nombre: 'TV',
    apellido: 'Mostrador Mexicali',
    rol: RolUsuario.MOSTRADOR_MONITOR,
    tiendaId: tiendaMexicali.id,
  });

  // ========== CLIENTES CON LISTA DE PRECIOS ==========
  // Un cliente por lista (1..6) para poder probar que cada uno ve SU precio.
  // La lista vive en `Usuario.listaPrecioCodigo` (global) y, cuando el cliente
  // tiene una lista distinta en una sucursal, en
  // `UsuarioTienda.listaPrecioCodigo` — que tiene precedencia.
  //
  // `cliente@puntotextil.com` queda sin lista (null) a propósito: así se prueba
  // el camino de "cliente sin lista asignada", que cae a lista1.
  const clienteDemo = await upsertUsuario('cliente@puntotextil.com', {
    password: passwordHash,
    nombre: 'Cliente',
    apellido: 'Demo',
    telefono: '+525512345678',
    rol: RolUsuario.CLIENTE,
  });

  const clientesPorLista = [
    { email: 'cliente2@puntotextil.com', lista: '2', nombre: 'Cliente Dos' },
    { email: 'cliente3@puntotextil.com', lista: '3', nombre: 'Cliente Tres' },
    { email: 'cliente4@puntotextil.com', lista: '4', nombre: 'Cliente Cuatro' },
    { email: 'cliente5@puntotextil.com', lista: '5', nombre: 'Cliente Cinco' },
    { email: 'cliente6@puntotextil.com', lista: '6', nombre: 'Cliente Seis' },
  ];

  for (const c of clientesPorLista) {
    await upsertUsuario(c.email, {
      password: passwordHash,
      nombre: c.nombre,
      rol: RolUsuario.CLIENTE,
      listaPrecioCodigo: c.lista,
    });
  }

  // ========== LISTA POR SUCURSAL (precedencia) ==========
  // `cliente4` tiene lista 4 global, pero en Mexicali se le asignó lista 2.
  // Sirve para verificar que `UsuarioTienda` gana sobre `Usuario` — la regla de
  // `resolverColumnaLista`. Se hace upsert por la clave compuesta
  // (usuarioId, tiendaId) para no duplicar la membresía al re-ejecutar.
  const cliente4 = await prisma.usuario.findUnique({
    where: { email: 'cliente4@puntotextil.com' },
    select: { id: true },
  });
  if (cliente4) {
    await prisma.usuarioTienda.upsert({
      where: {
        usuarioId_tiendaId: {
          usuarioId: cliente4.id,
          tiendaId: tiendaMexicali.id,
        },
      },
      update: { listaPrecioCodigo: '2', activo: true },
      create: {
        usuarioId: cliente4.id,
        tiendaId: tiendaMexicali.id,
        listaPrecioCodigo: '2',
        activo: true,
      },
    });
  }

  console.log(`  ✓ Admin: ${admin.email} / 123456`);
  console.log(`  ✓ Bodega: ${usuarioBodega.email} / 123456 (${tiendaMexicali.nombre})`);
  console.log(`  ✓ Cajero: ${usuarioCajero.email} / 123456 (${tiendaMexicali.nombre})`);
  console.log(`  ✓ Ventas: ${usuarioVentas.email} / 123456 (${tiendaMexicali.nombre})`);
  console.log(`  ✓ Mostrador: ${usuarioMostrador.email} / 123456 (${tiendaMexicali.nombre})`);
  console.log(`  ✓ TV Monitor Bodega (Mexicali): monitor.mexicali@puntotextil.com / 123456`);
  console.log(`  ✓ TV Monitor Bodega (Monterrey): monitor.mty@puntotextil.com / 123456`);
  console.log(`  ✓ TV Monitor Cajas (Mexicali): cajero.tv.mexicali@puntotextil.com / 123456`);
  console.log(`  ✓ TV Monitor Mostrador (Mexicali): mostrador.tv.mexicali@puntotextil.com / 123456`);
  console.log(`  ✓ Cliente sin lista (lista1): ${clienteDemo.email} / 123456`);
  for (const c of clientesPorLista) {
    console.log(`  ✓ Cliente lista ${c.lista}: ${c.email} / 123456`);
  }
  console.log(
    `  ✓ Cliente lista 4 global → lista 2 en ${tiendaMexicali.nombre}: cliente4@puntotextil.com\n`,
  );

  // ========== CREAR VENTANILLAS (F11 ago 2026) ==========
  console.log('🪟 Creando ventanillas...');
  // Mexicali: 3 ventanillas. La 1 ya está asignada al cajero demo.
  // `(tiendaId, numero)` es único, así que el upsert es idempotente.
  const ventanillas = [
    { tiendaId: tiendaMexicali.id, numero: 1, cajeroId: usuarioCajero.id },
    { tiendaId: tiendaMexicali.id, numero: 2, cajeroId: null },
    { tiendaId: tiendaMexicali.id, numero: 3, cajeroId: null },
    { tiendaId: tiendaMonterrey.id, numero: 1, cajeroId: null },
    { tiendaId: tiendaMonterrey.id, numero: 2, cajeroId: null },
  ];
  for (const v of ventanillas) {
    await prisma.ventanilla.upsert({
      where: { tiendaId_numero: { tiendaId: v.tiendaId, numero: v.numero } },
      update: {},
      create: { ...v, activa: true },
    });
  }
  console.log(`  ✓ ${tiendaMexicali.nombre}: 3 ventanillas (1 ocupada por ${usuarioCajero.nombre})`);
  console.log(`  ✓ ${tiendaMonterrey.nombre}: 2 ventanillas libres\n`);

  // ========== CREAR CORRIDAS Y TALLAS ==========
  console.log('📏 Creando corridas y tallas...');

  // Corrida sin clave natural única: se busca por nombre.
  let corridaAdulto = await prisma.corrida.findFirst({
    where: { nombre: 'Adulto Unisex' },
    include: { tallas: true },
  });
  if (!corridaAdulto) {
    corridaAdulto = await prisma.corrida.create({
      data: {
        nombre: 'Adulto Unisex',
        descripcion: 'Tallas para adulto unisex',
        tallas: {
          create: [
            { nombre: 'XS', orden: 1 },
            { nombre: 'S', orden: 2 },
            { nombre: 'M', orden: 3 },
            { nombre: 'L', orden: 4 },
            { nombre: 'XL', orden: 5 },
            { nombre: 'XXL', orden: 6 },
          ],
        },
      },
      include: { tallas: true },
    });
  }

  console.log(`  ✓ Corrida: ${corridaAdulto.nombre}\n`);

  // ========== CREAR COLORES BASADOS EN IMÁGENES ==========
  console.log('🎨 Creando colores basados en imágenes...');

  // Extraer colores únicos de la configuración de productos
  const coloresUnicos = new Map<string, { nombre: string; hex: string }>();
  for (const producto of PRODUCTOS_CONFIG) {
    for (const color of producto.colores) {
      if (!coloresUnicos.has(color.nombre)) {
        coloresUnicos.set(color.nombre, { nombre: color.nombre, hex: color.hex });
      }
    }
  }

  // Generar códigos de color únicos
  const colorCodes: Record<string, string> = {
    'Caribe': 'CA', 'Negro': 'NG', 'Marino': 'MA', 'Blanco': 'BL', 'Arena': 'AR',
    'Marrón': 'MR', 'Jade': 'JD', 'Lavanda': 'LV', 'Fucsia': 'FU', 'Turquesa': 'TU',
    'Rojo': 'RO', 'Verde Neón': 'VN', 'Amarillo Neón': 'AN',
  };

  // `codigo` es @unique: upsert para no duplicar colores ni cambiar su ID
  // (los `productos_imagenes.color_id` apuntan ahí).
  for (const c of coloresUnicos.values()) {
    const codigo = colorCodes[c.nombre] || c.nombre.substring(0, 2).toUpperCase();
    await prisma.color.upsert({
      where: { codigo },
      update: {},
      create: { codigo, nombre: c.nombre, hex: c.hex },
    });
  }

  const coloresDB = await prisma.color.findMany();
  coloresDB.forEach(c => console.log(`  ✓ Color: ${c.nombre} (${c.hex})`));
  console.log('');

  // ========== CREAR PRODUCTOS CON IMÁGENES REALES ==========
  console.log('👕 Creando productos con imágenes reales...');

  const productosCreados: { id: number; codigo: string; nombre: string; precioBase: number; colores: typeof PRODUCTOS_CONFIG[0]['colores'] }[] = [];

  for (const config of PRODUCTOS_CONFIG) {
    // Upsert por `codigo` (@unique): el producto conserva su ID entre corridas
    // del seed, así que `productos_imagenes` no se recrea ni se pierde el
    // trabajo del panel ADMIN. `imagenPrincipal`/`imagenes` se recalculan al
    // final desde las filas.
    const producto = await prisma.producto.upsert({
      where: { codigo: config.codigo },
      update: {},
      create: {
        codigo: config.codigo,
        nombre: config.nombre,
        descripcion: config.descripcion,
        activo: true,
        categoria: config.categoria,
        subcategoria: config.subcategoria,
      },
    });

    // Filas ProductoImagen con colorId: asocian cada imagen a su color para
    // que catálogo/carrito/pedidos puedan mostrar la imagen del color elegido.
    // esPrincipal en la primera imagen del primer color.
    //
    // No hay clave natural (productoId+colorId+url), así que se busca antes de
    // crear: sin esto cada corrida del seed duplicaría las 75 filas.
    let esPrincipalYa = false;
    for (const colorConfig of config.colores) {
      const colorDB = coloresDB.find(c => c.nombre === colorConfig.nombre);
      if (!colorDB) continue;
      for (let i = 0; i < colorConfig.imagenes.length; i++) {
        const url = getImagenUrl(colorConfig.imagenes[i]);
        const existente = await prisma.productoImagen.findFirst({
          where: { productoId: producto.id, colorId: colorDB.id, url },
          select: { id: true },
        });
        if (existente) {
          if (!esPrincipalYa && i === 0) esPrincipalYa = true;
          continue;
        }
        await prisma.productoImagen.create({
          data: {
            productoId: producto.id,
            colorId: colorDB.id,
            url,
            orden: i,
            esPrincipal: !esPrincipalYa && i === 0,
          },
        });
        if (!esPrincipalYa && i === 0) esPrincipalYa = true;
      }
    }

    await sincronizarCamposLegacy(producto.id);

    productosCreados.push({
      id: producto.id,
      codigo: producto.codigo,
      nombre: producto.nombre,
      precioBase: config.precioBase,
      colores: config.colores,
    });

    console.log(`  ✓ Producto: ${producto.nombre} (${producto.codigo})`);
    console.log(`     Colores: ${config.colores.length}`);
  }
  console.log('');

  // ========== CREAR PRECIOS ==========
  console.log('💰 Creando precios y variantes (PrecioCO)...');

  const tiendas = [tiendaMexicali, tiendaObregon, tiendaHermosillo, tiendaMonterrey];
  const tallasAdulto = corridaAdulto.tallas;

  for (const tienda of tiendas) {
    for (const producto of productosCreados) {
      // Crear relación producto-tienda
      await prisma.productoTienda.upsert({
        where: {
          productoId_tiendaId: { productoId: producto.id, tiendaId: tienda.id },
        },
        update: {},
        create: {
          productoId: producto.id,
          tiendaId: tienda.id,
          visible: true,
          destacado: producto.codigo === 'C0200',
        },
      });

      // Precio por producto con las 6 listas. `precioBase` sigue siendo
      // sinónimo de lista1 (ver FACTOR_LISTA).
      const listasProducto = preciosDeListas(producto.precioBase);
      await prisma.precio.upsert({
        where: {
          productoId_tiendaId: { productoId: producto.id, tiendaId: tienda.id },
        },
        update: { ...listasProducto, precioBase: listasProducto.lista1, activo: true },
        create: {
          productoId: producto.id,
          tiendaId: tienda.id,
          precioBase: listasProducto.lista1,
          ...listasProducto,
          activo: true,
        },
      });

      // Crear PrecioCO para cada combinación talla/color
      // (Stock eliminado en refactor B2B: no manejamos inventario confiable)
      for (const talla of tallasAdulto) {
        for (const colorConfig of producto.colores) {
          const colorDB = coloresDB.find(c => c.nombre === colorConfig.nombre);
          if (!colorDB) continue;

          const sku = `${producto.codigo}-${colorDB.codigo}-${talla.nombre}-T${tienda.id}`;
          // Las tallas grandes cuestan más: el sobreprecio se aplica a la base
          // y las 6 listas se derivan de ahí, para que el orden entre listas se
          // mantenga en todas las tallas.
          const precioVariante = talla.nombre === 'XXL' || talla.nombre === 'XG'
            ? producto.precioBase + 30
            : producto.precioBase;
          const listasVariante = preciosDeListas(precioVariante);

          await prisma.precioCO.upsert({
            where: {
              productoId_tiendaId_corridaId_tallaId_colorId: {
                productoId: producto.id,
                tiendaId: tienda.id,
                corridaId: corridaAdulto.id,
                tallaId: talla.id,
                colorId: colorDB.id,
              },
            },
            update: { ...listasVariante, precio: listasVariante.lista1, sku },
            create: {
              productoId: producto.id,
              tiendaId: tienda.id,
              corridaId: corridaAdulto.id,
              tallaId: talla.id,
              colorId: colorDB.id,
              precio: listasVariante.lista1,
              ...listasVariante,
              sku,
            },
          });
        }
      }
    }
    console.log(`  ✓ Precios creados para ${tienda.nombre}`);
  }
  console.log('');

  // ========== PEDIDOS ==========
  // (jul 2026: ya no se crea un pedido demo en el seed. Los pedidos se crean
  // manualmente desde la app — kiosko, web o por el admin — para probar el
  // flujo completo de bodega/cajero/mostrador. Si necesitas datos de prueba,
  // créalos desde la UI con los usuarios listados al final de este script.)

  console.log('\n✅ Seed completado exitosamente!\n');
  console.log('────────────────────────────────────────');
  console.log(`Productos: ${productosCreados.length}`);
  console.log(`Colores: ${coloresDB.length}`);
  console.log(`Tiendas: 4 (Mexicali, Cd Obregón, Hermosillo, Monterrey Tec)`);
  console.log(`Tallas por corrida: ${tallasAdulto.length}`);
  console.log(`Variantes: ${productosCreados.length * coloresDB.length * tallasAdulto.length * tiendas.length}`);
  console.log(`Listas de precios por variante: 6 (factores ${Object.values(FACTOR_LISTA).join(', ')})`);
  console.log('');
  console.log('Usuarios de prueba (password = 123456):');
  console.log('  admin@puntotextil.com');
  console.log('  bodega@puntotextil.com              (Mexicali)');
  console.log('  cajero@puntotextil.com              (Mexicali)');
  console.log('  ventas@puntotextil.com              (Mexicali, rol VENTAS)');
  console.log('  mostrador@puntotextil.com           (Mexicali)');
  console.log('  monitor.mexicali@puntotextil.com    (TV monitor Mexicali, rol BODEGA_MONITOR)');
  console.log('  monitor.mty@puntotextil.com         (TV monitor Monterrey, rol BODEGA_MONITOR)');
  console.log('');
  console.log('Clientes por lista de precios:');
  console.log('  cliente@puntotextil.com             (sin lista → lista1)');
  console.log('  cliente2@puntotextil.com            (lista 2)');
  console.log('  cliente3@puntotextil.com            (lista 3)');
  console.log('  cliente4@puntotextil.com            (lista 4 global, lista 2 en Mexicali)');
  console.log('  cliente5@puntotextil.com            (lista 5)');
  console.log('  cliente6@puntotextil.com            (lista 6)');
  console.log('────────────────────────────────────────');
  console.log('\nLas imágenes usan keys de storage (productos/seed/...)');
  console.log('El backend las resuelve a URLs de S3 al servirlas.');
  console.log('Si alguna falta en el bucket: pnpm recuperar:imagenes');
}

main()
  .catch((e) => {
    console.error('❌ Error en seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
