import { PrismaClient, RolUsuario } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// ============================================
// CONFIGURACIÓN DE PRODUCTOS POR IMÁGENES
// ============================================
// Las imágenes están en: public/products/
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

async function limpiarBaseDeDatos() {
  console.log('🗑️  Eliminando datos existentes...');

  // Borrar en orden para respetar foreign keys.
  // Primero las tablas que referencian a usuarios/tiendas/productos.
  await prisma.notificacion.deleteMany({});
  await prisma.pedidoMensaje.deleteMany({});
  // F12 (sep 2026): las propuestas y la cola de envío a Firebird referencian
  // a pedidos — borrarlas antes de pedidos.
  await prisma.pedidoPropuesta.deleteMany({});
  await prisma.pedidoPendienteEnvio.deleteMany({});
  await prisma.itemPedido.deleteMany({});
  await prisma.historialPedido.deleteMany({});
  await prisma.logActividad.deleteMany({});
  await prisma.pedido.deleteMany({});
  await prisma.precioCO.deleteMany({});
  await prisma.precio.deleteMany({});
  await prisma.productoTienda.deleteMany({});
  await prisma.productoImagen.deleteMany({});
  await prisma.producto.deleteMany({});
  await prisma.talla.deleteMany({});
  await prisma.corrida.deleteMany({});
  await prisma.color.deleteMany({});
  // Tablas que referencian a usuarios (FK) — borrar antes de usuarios.
  await prisma.ventanilla.deleteMany({});
  await prisma.refreshToken.deleteMany({});
  await prisma.passwordResetToken.deleteMany({});
  await prisma.usuarioTienda.deleteMany({});
  await prisma.externalRef.deleteMany({});
  await prisma.favorito.deleteMany({});
  // kiosko tiene FK activado_por_id → usuarios. Hay que borrarlo ANTES.
  // F11 (ago 2026): tabla kioskos no existe todavía en la BD (modelo en
  // schema.prisma sin migración que la cree). Comento el deleteMany para
  // no romper el seed; re-activar cuando se cree la migración de kioskos.
  // await prisma.kiosko.deleteMany({});
  await prisma.usuario.deleteMany({});
  await prisma.tienda.deleteMany({});

  // Resetear secuencias
  await prisma.$executeRaw`ALTER SEQUENCE "tiendas_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "usuarios_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "corridas_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "tallas_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "colores_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "productos_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "productos_tienda_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "precios_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "preciosco_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "items_pedido_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "historial_pedidos_id_seq" RESTART WITH 1`;
  // F12 (sep 2026): secuencias de propuestas y cola de envío a Firebird.
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_propuestas_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_pendientes_envio_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_mensajes_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "notificaciones_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "ventanillas_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "productos_imagenes_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "refresh_tokens_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "password_reset_tokens_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "usuarios_tiendas_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "external_refs_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "favoritos_id_seq" RESTART WITH 1`;
  // F11 (ago 2026): kioskos_id_seq comentado — tabla kioskos no existe aún.
  // await prisma.$executeRaw`ALTER SEQUENCE "kioskos_id_seq" RESTART WITH 1`;

  console.log('  ✓ Base de datos limpiada\n');
}

// Devuelve ruta relativa para evitar problemas de CORS
function getImagenUrl(nombreArchivo: string): string {
  return `/products/${nombreArchivo}`;
}

async function main() {
  console.log('🌱 Iniciando seed de datos...\n');

  // ========== LIMPIAR TODO PRIMERO ==========
  await limpiarBaseDeDatos();

  // ========== CREAR TIENDAS ==========
  console.log('🏪 Creando tiendas...');

  const tiendaMexicali = await prisma.tienda.create({
    data: {
      nombre: 'Punto Textil Mexicali',
      direccion: 'Blvd. Lázaro Cárdenas 481, Ex-Ejido Coahuila, C.P. 21360',
      ciudad: 'Mexicali',
      estado: 'Baja California',
      telefono: '686-000-0001',
      email: 'mexicali@puntotextil.com',
    },
  });

  const tiendaObregon = await prisma.tienda.create({
    data: {
      nombre: 'Punto Textil Mayoreo Cd Obregón',
      direccion: 'Calle Nicolás Bravo 700 B, Col. Centro (Urb. No. 1), C.P. 85000',
      ciudad: 'Ciudad Obregón',
      estado: 'Sonora',
      telefono: '644-000-0002',
      email: 'obregon@puntotextil.com',
    },
  });

  const tiendaHermosillo = await prisma.tienda.create({
    data: {
      nombre: 'Distribuidora Punto Textil Hermosillo',
      direccion: 'Boulevard Luis Encinas J. N°573, Col. Pimentel, C.P. 83188',
      ciudad: 'Hermosillo',
      estado: 'Sonora',
      telefono: '662-000-0003',
      email: 'hermosillo@puntotextil.com',
    },
  });

  const tiendaMonterrey = await prisma.tienda.create({
    data: {
      nombre: 'Distribuidora Punto Textil Monterrey Tec',
      direccion: 'Av. Eugenio Garza Sada Sur N° 2620, Col. Tecnológico, C.P. 64700',
      ciudad: 'Monterrey',
      estado: 'Nuevo León',
      telefono: '81-0000-0004',
      email: 'monterrey@puntotextil.com',
    },
  });

  console.log(`  ✓ Tienda: ${tiendaMexicali.nombre}`);
  console.log(`  ✓ Tienda: ${tiendaObregon.nombre}`);
  console.log(`  ✓ Tienda: ${tiendaHermosillo.nombre}`);
  console.log(`  ✓ Tienda: ${tiendaMonterrey.nombre}\n`);

  // ========== CREAR USUARIOS ==========
  console.log('👤 Creando usuarios...');
  const passwordHash = await bcrypt.hash('123456', 10);

  const admin = await prisma.usuario.create({
    data: {
      email: 'admin@puntotextil.com',
      password: passwordHash,
      nombre: 'Administrador',
      apellido: 'Sistema',
      rol: RolUsuario.ADMIN,
      activo: true,
    },
  });

  const usuarioBodega = await prisma.usuario.create({
    data: {
      email: 'bodega@puntotextil.com',
      password: passwordHash,
      nombre: 'Usuario',
      apellido: 'Bodega',
      rol: RolUsuario.BODEGA,
      tiendaId: tiendaMexicali.id,
      activo: true,
    },
  });

  const usuarioCajero = await prisma.usuario.create({
    data: {
      email: 'cajero@puntotextil.com',
      password: passwordHash,
      nombre: 'Usuario',
      apellido: 'Cajero',
      rol: RolUsuario.CAJERO,
      tiendaId: tiendaMexicali.id,
      activo: true,
    },
  });

  // Usuarios dedicados al monitor de bodega (uno por tienda).
  // Pensados para dejarse logueados en TVs de la bodega.
  // Rol BODEGA_MONITOR: login redirige a /bodega-monitor; no puede tomar pedidos.
  await prisma.usuario.create({
    data: {
      email: 'monitor.mexicali@puntotextil.com',
      password: passwordHash,
      nombre: 'Monitor',
      apellido: 'Mexicali',
      rol: RolUsuario.BODEGA_MONITOR,
      tiendaId: tiendaMexicali.id,
      activo: true,
    },
  });

  await prisma.usuario.create({
    data: {
      email: 'monitor.mty@puntotextil.com',
      password: passwordHash,
      nombre: 'Monitor',
      apellido: 'Monterrey',
      rol: RolUsuario.BODEGA_MONITOR,
      tiendaId: tiendaMonterrey.id,
      activo: true,
    },
  });

  // Cajero MONITOR: TV de ventanillas de la tienda Mexicali.
  // Rol CAJERO_MONITOR. Login redirige a /cajero-monitor.
  await prisma.usuario.create({
    data: {
      email: 'cajero.tv.mexicali@puntotextil.com',
      password: passwordHash,
      nombre: 'TV',
      apellido: 'Cajas Mexicali',
      rol: RolUsuario.CAJERO_MONITOR,
      tiendaId: tiendaMexicali.id,
      activo: true,
    },
  });

  const clienteDemo = await prisma.usuario.create({
    data: {
      email: 'cliente@puntotextil.com',
      password: passwordHash,
      nombre: 'Cliente',
      apellido: 'Demo',
      telefono: '+525512345678',
      rol: RolUsuario.CLIENTE,
      activo: true,
    },
  });

  // Mostrador: usuario que entrega pedidos ya pagados en tienda.
  // Rol MOSTRADOR. Login redirige a /mostrador.
  const usuarioMostrador = await prisma.usuario.create({
    data: {
      email: 'mostrador@puntotextil.com',
      password: passwordHash,
      nombre: 'Usuario',
      apellido: 'Mostrador',
      rol: RolUsuario.MOSTRADOR,
      tiendaId: tiendaMexicali.id,
      activo: true,
    },
  });

  console.log(`  ✓ Admin: ${admin.email} / 123456`);
  console.log(`  ✓ Bodega: ${usuarioBodega.email} / 123456 (${tiendaMexicali.nombre})`);
  console.log(`  ✓ Cajero: ${usuarioCajero.email} / 123456 (${tiendaMexicali.nombre})`);
  console.log(`  ✓ Mostrador: ${usuarioMostrador.email} / 123456 (${tiendaMexicali.nombre})`);
  console.log(`  ✓ Cliente: ${clienteDemo.email} / 123456\n`);
  console.log(`  ✓ TV Monitor Bodega (Mexicali): monitor.mexicali@puntotextil.com / 123456`);
  console.log(`  ✓ TV Monitor Bodega (Monterrey): monitor.mty@puntotextil.com / 123456`);
  console.log(`  ✓ TV Monitor Cajas (Mexicali): cajero.tv.mexicali@puntotextil.com / 123456\n`);

  // ========== CREAR VENTANILLAS (F11 ago 2026) ==========
  console.log('🪟 Creando ventanillas...');
  // Mexicali: 3 ventanillas. La 1 ya está asignada al cajero demo.
  const vMex1 = await prisma.ventanilla.create({
    data: { tiendaId: tiendaMexicali.id, numero: 1, cajeroId: usuarioCajero.id, activa: true },
  });
  await prisma.ventanilla.create({
    data: { tiendaId: tiendaMexicali.id, numero: 2, cajeroId: null, activa: true },
  });
  await prisma.ventanilla.create({
    data: { tiendaId: tiendaMexicali.id, numero: 3, cajeroId: null, activa: true },
  });
  // Monterrey: 2 ventanillas libres.
  await prisma.ventanilla.create({
    data: { tiendaId: tiendaMonterrey.id, numero: 1, cajeroId: null, activa: true },
  });
  await prisma.ventanilla.create({
    data: { tiendaId: tiendaMonterrey.id, numero: 2, cajeroId: null, activa: true },
  });
  console.log(`  ✓ ${tiendaMexicali.nombre}: 3 ventanillas (1 ocupada por ${usuarioCajero.nombre})`);
  console.log(`  ✓ ${tiendaMonterrey.nombre}: 2 ventanillas libres\n`);
  void vMex1;

  // ========== CREAR KIOSKO DEMO ==========
  // F11 (ago 2026): comentado porque la tabla kioskos no existe aún en la
  // BD (modelo en schema.prisma sin migración). Re-activar cuando se cree.
  // console.log('📱 Creando kiosko demo...');
  // await prisma.kiosko.upsert({
  //   where: { tiendaId_nombre: { tiendaId: tiendaMexicali.id, nombre: 'Kiosko Entrada' } },
  //   update: {},
  //   create: {
  //     tiendaId: tiendaMexicali.id,
  //     nombre: 'Kiosko Entrada',
  //     estado: 'ACTIVO',
  //     activadoPorId: admin.id,
  //   },
  // });
  // console.log(`  ✓ Kiosko: "Kiosko Entrada" en ${tiendaMexicali.nombre}\n`);

  // ========== CREAR CORRIDAS Y TALLAS ==========
  console.log('📏 Creando corridas y tallas...');

  const corridaAdulto = await prisma.corrida.create({
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

  const coloresData = Array.from(coloresUnicos.values()).map((c) => ({
    codigo: colorCodes[c.nombre] || c.nombre.substring(0, 2).toUpperCase(),
    nombre: c.nombre,
    hex: c.hex,
  }));

  await prisma.color.createMany({
    data: coloresData,
  });

  const coloresDB = await prisma.color.findMany();
  coloresDB.forEach(c => console.log(`  ✓ Color: ${c.nombre} (${c.hex})`));
  console.log('');

  // ========== CREAR PRODUCTOS CON IMÁGENES REALES ==========
  console.log('👕 Creando productos con imágenes reales...');

  const productosCreados: { id: number; codigo: string; nombre: string; precioBase: number; colores: typeof PRODUCTOS_CONFIG[0]['colores'] }[] = [];

  for (const config of PRODUCTOS_CONFIG) {
    // Todas las imágenes del producto (para el array de imágenes)
    const todasImagenes = config.colores.flatMap(c => c.imagenes.map(getImagenUrl));

    // Imagen principal = primera imagen del primer color
    const imagenPrincipal = getImagenUrl(config.colores[0].imagenes[0]);

    const producto = await prisma.producto.create({
      data: {
        codigo: config.codigo,
        nombre: config.nombre,
        descripcion: config.descripcion,
        imagenPrincipal,
        imagenes: todasImagenes,
        activo: true,
        categoria: config.categoria,
        subcategoria: config.subcategoria,
      },
    });

    // Filas ProductoImagen con colorId: asocian cada imagen a su color para
    // que catálogo/carrito/pedidos puedan mostrar la imagen del color elegido.
    // esPrincipal en la primera imagen del primer color.
    let esPrincipalYa = false;
    for (const colorConfig of config.colores) {
      const colorDB = coloresDB.find(c => c.nombre === colorConfig.nombre);
      if (!colorDB) continue;
      for (let i = 0; i < colorConfig.imagenes.length; i++) {
        await prisma.productoImagen.create({
          data: {
            productoId: producto.id,
            colorId: colorDB.id,
            url: getImagenUrl(colorConfig.imagenes[i]),
            orden: i,
            esPrincipal: !esPrincipalYa && i === 0,
          },
        });
        if (!esPrincipalYa && i === 0) esPrincipalYa = true;
      }
    }

    productosCreados.push({
      id: producto.id,
      codigo: producto.codigo,
      nombre: producto.nombre,
      precioBase: config.precioBase,
      colores: config.colores,
    });

    console.log(`  ✓ Producto: ${producto.nombre} (${producto.codigo})`);
    console.log(`     Imagen principal: ${imagenPrincipal}`);
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
      await prisma.productoTienda.create({
        data: {
          productoId: producto.id,
          tiendaId: tienda.id,
          visible: true,
          destacado: producto.codigo === 'C0200',
        },
      });

      // Crear precio base
      await prisma.precio.create({
        data: {
          productoId: producto.id,
          tiendaId: tienda.id,
          precioBase: producto.precioBase,
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
          const precioVariante = talla.nombre === 'XXL' || talla.nombre === 'XG'
            ? producto.precioBase + 30
            : producto.precioBase;

          await prisma.precioCO.create({
            data: {
              productoId: producto.id,
              tiendaId: tienda.id,
              corridaId: corridaAdulto.id,
              tallaId: talla.id,
              colorId: colorDB.id,
              precio: precioVariante,
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
  console.log(`Productos creados: ${productosCreados.length}`);
  console.log(`Colores creados: ${coloresDB.length}`);
  console.log(`Tiendas creadas: 4 (Mexicali, Cd Obregón, Hermosillo, Monterrey Tec)`);
  console.log(`Tallas por color: ${tallasAdulto.length}`);
  console.log(`Variantes totales: ${productosCreados.length * coloresDB.length * tallasAdulto.length * tiendas.length}`);
  console.log('');
  console.log('Usuarios de prueba (password = 123456):');
  console.log('  admin@puntotextil.com');
  console.log('  bodega@puntotextil.com              (Mexicali)');
  console.log('  cajero@puntotextil.com              (Mexicali)');
  console.log('  mostrador@puntotextil.com           (Mexicali)');
  console.log('  cliente@puntotextil.com');
  console.log('  monitor.mexicali@puntotextil.com    (TV monitor Mexicali, rol BODEGA_MONITOR)');
  console.log('  monitor.mty@puntotextil.com         (TV monitor Monterrey, rol BODEGA_MONITOR)');
  console.log('────────────────────────────────────────');
  console.log('\nLas imágenes usan rutas relativas (/products/...)');
  console.log('El navegador las resolverá automáticamente según el dominio del frontend');
}

main()
  .catch((e) => {
    console.error('❌ Error en seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
