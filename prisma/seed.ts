import { PrismaClient, RolUsuario } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// ============================================
// CONFIGURACIÓN DE PRODUCTOS POR IMÁGENES
// ============================================
// Las imágenes están en: public/products/
// Formato: {producto}-{num-img}-{color}.webp
// Ejemplo: manga-corta-1-naranja.webp
//
// IMPORTANTE: Se usan rutas relativas (/products/...) para evitar
// problemas de CORS cuando el frontend corre en otro puerto.

const PRODUCTOS_CONFIG = [
  {
    codigo: 'CAM-MC-001',
    nombre: 'Camiseta Manga Corta',
    descripcion: 'Camiseta manga corta 100% algodón premium. Diseño clásico con acabados de calidad. Disponible en colores vibrantes.',
    categoria: 'Camisetas',
    subcategoria: 'Manga Corta',
    precioBase: 299.99,
    colores: [
      { nombre: 'Naranja', hex: '#FF8C00', imagen1: 'manga-corta-1-naranja.webp', imagen2: 'manga-corta-2-naranja.webp' },
      { nombre: 'Verde', hex: '#228B22', imagen1: 'manga-corta-1-verde.webp', imagen2: 'manga-corta-2-verde.webp' },
      { nombre: 'Salmon', hex: '#FA8072', imagen1: 'manga-corta-1-salmon.webp', imagen2: 'manga-corta-salmon-2.webp' },
    ],
  },
  {
    codigo: 'CAM-ML-001',
    nombre: 'Camiseta Manga Larga',
    descripcion: 'Camiseta manga larga de algodón suave. Perfecta para climas frescos. Corte moderno y confortable.',
    categoria: 'Camisetas',
    subcategoria: 'Manga Larga',
    precioBase: 349.99,
    colores: [
      { nombre: 'Azul', hex: '#1E90FF', imagen1: 'manga-larga-1-azul.webp', imagen2: 'manga-larga-2-azul.webp' },
      { nombre: 'Cafe', hex: '#8B4513', imagen1: 'manga-larga-1-cafe.webp', imagen2: 'manga-larga-2-cafe.webp' },
      { nombre: 'Naranja', hex: '#FF8C00', imagen1: 'manga-larga-1-naranja.webp', imagen2: 'manga-larga-2-naranja.webp' },
    ],
  },
  {
    codigo: 'POLO-001',
    nombre: 'Polo Clásico',
    descripcion: 'Polo clásico con cuello y botones. 60% algodón 40% poliéster. Ideal para ocasiones semi-formales.',
    categoria: 'Polos',
    subcategoria: 'Clásico',
    precioBase: 399.99,
    colores: [
      { nombre: 'Blanco', hex: '#FFFFFF', imagen1: 'polo-1-blanco.webp', imagen2: 'polo-2-blanco.webp' },
      { nombre: 'Negro', hex: '#000000', imagen1: 'polo-1-negro.webp', imagen2: 'polo-2-negro.webp' },
    ],
  },
];

async function limpiarBaseDeDatos() {
  console.log('🗑️  Eliminando datos existentes...');

  // Borrar en orden para respetar foreign keys
  await prisma.notificacion.deleteMany({});
  await prisma.pedidoMensaje.deleteMany({});
  await prisma.pedidoRevisionItem.deleteMany({});
  await prisma.pedidoRevision.deleteMany({});
  await prisma.itemPedido.deleteMany({});
  await prisma.historialPedido.deleteMany({});
  await prisma.logActividad.deleteMany({});
  await prisma.pedido.deleteMany({});
  await prisma.precioCO.deleteMany({});
  await prisma.precio.deleteMany({});
  await prisma.productoTienda.deleteMany({});
  await prisma.producto.deleteMany({});
  await prisma.talla.deleteMany({});
  await prisma.corrida.deleteMany({});
  await prisma.color.deleteMany({});
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
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_revisiones_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_revisiones_items_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_mensajes_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "notificaciones_id_seq" RESTART WITH 1`;
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
    'Naranja': 'NA', 'Verde': 'VD', 'Salmon': 'SL',
    'Azul': 'AZ', 'Cafe': 'CF', 'Blanco': 'BL', 'Negro': 'NG',
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
    const todasImagenes = config.colores.flatMap(c => [
      getImagenUrl(c.imagen1),
      getImagenUrl(c.imagen2),
    ]);

    // Imagen principal = primera imagen del primer color
    const imagenPrincipal = getImagenUrl(config.colores[0].imagen1);

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
          destacado: producto.codigo === 'CAM-MC-001',
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
