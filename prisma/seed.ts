import { PrismaClient, RolUsuario, EstadoPedido, TipoPago, EstadoPago } from '@prisma/client';
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
  await prisma.itemPedido.deleteMany({});
  await prisma.historialPedido.deleteMany({});
  await prisma.logActividad.deleteMany({});
  await prisma.pedido.deleteMany({});
  await prisma.stock.deleteMany({});
  await prisma.precioCO.deleteMany({});
  await prisma.precio.deleteMany({});
  await prisma.productoTienda.deleteMany({});
  await prisma.producto.deleteMany({});
  await prisma.talla.deleteMany({});
  await prisma.corrida.deleteMany({});
  await prisma.color.deleteMany({});
  await prisma.sesion.deleteMany({});
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
  await prisma.$executeRaw`ALTER SEQUENCE "stock_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "pedidos_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "items_pedido_id_seq" RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE "historial_pedidos_id_seq" RESTART WITH 1`;

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
  const tiendaCentro = await prisma.tienda.create({
    data: {
      nombre: 'Sucursal Centro',
      direccion: 'Calle Principal 123, Centro',
      ciudad: 'Ciudad de México',
      estado: 'Ciudad de México',
      telefono: '555-0100',
      email: 'centro@tienda.com',
    },
  });

  const tiendaNorte = await prisma.tienda.create({
    data: {
      nombre: 'Sucursal Guadalajara',
      direccion: 'Av. Chapultepec 789, Juárez',
      ciudad: 'Guadalajara',
      estado: 'Jalisco',
      telefono: '333-0200',
      email: 'guadalajara@tienda.com',
    },
  });

  console.log(`  ✓ Tienda: ${tiendaCentro.nombre}`);
  console.log(`  ✓ Tienda: ${tiendaNorte.nombre}\n`);

  // ========== CREAR USUARIOS ==========
  console.log('👤 Creando usuarios...');
  const passwordHash = await bcrypt.hash('password123', 10);

  const admin = await prisma.usuario.create({
    data: {
      email: 'admin@tienda.com',
      password: passwordHash,
      nombre: 'Administrador',
      apellido: 'Sistema',
      rol: RolUsuario.ADMIN,
      activo: true,
    },
  });

  const usuarioBodega = await prisma.usuario.create({
    data: {
      email: 'bodega@tienda.com',
      password: passwordHash,
      nombre: 'Usuario',
      apellido: 'Bodega',
      rol: RolUsuario.BODEGA,
      tiendaId: tiendaCentro.id,
      activo: true,
    },
  });

  const usuarioCajero = await prisma.usuario.create({
    data: {
      email: 'cajero@tienda.com',
      password: passwordHash,
      nombre: 'Usuario',
      apellido: 'Cajero',
      rol: RolUsuario.CAJERO,
      tiendaId: tiendaCentro.id,
      activo: true,
    },
  });

  const usuarioMostrador = await prisma.usuario.create({
    data: {
      email: 'mostrador@tienda.com',
      password: passwordHash,
      nombre: 'Usuario',
      apellido: 'Mostrador',
      rol: RolUsuario.MOSTRADOR,
      tiendaId: tiendaCentro.id,
      activo: true,
    },
  });

  const clienteDemo = await prisma.usuario.create({
    data: {
      email: 'cliente@demo.com',
      password: passwordHash,
      nombre: 'Cliente',
      apellido: 'Demo',
      rol: RolUsuario.CLIENTE,
      activo: true,
    },
  });

  console.log(`  ✓ Admin: ${admin.email} / password123`);
  console.log(`  ✓ Bodega: ${usuarioBodega.email} / password123`);
  console.log(`  ✓ Cajero: ${usuarioCajero.email} / password123`);
  console.log(`  ✓ Mostrador: ${usuarioMostrador.email} / password123`);
  console.log(`  ✓ Cliente: ${clienteDemo.email} / password123\n`);

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

  // ========== CREAR PRECIOS Y STOCK ==========
  console.log('💰 Creando precios y stock...');

  const tiendas = [tiendaCentro, tiendaNorte];
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

      // Crear PrecioCO y Stock para cada combinación talla/color
      for (const talla of tallasAdulto) {
        for (const colorConfig of producto.colores) {
          const colorDB = coloresDB.find(c => c.nombre === colorConfig.nombre);
          if (!colorDB) continue;

          const sku = `${producto.codigo}-${colorDB.codigo}-${talla.nombre}-T${tienda.id}`;
          const precioVariante = talla.nombre === 'XXL' || talla.nombre === 'XG'
            ? producto.precioBase + 30
            : producto.precioBase;

          const precioCO = await prisma.precioCO.create({
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

          // Stock aleatorio entre 5 y 50 (mínimo 5 para poder comprar)
          const stockCantidad = Math.floor(Math.random() * 46) + 5;
          await prisma.stock.create({
            data: {
              precioCOId: precioCO.id,
              tiendaId: tienda.id,
              tallaId: talla.id,
              colorId: colorDB.id,
              cantidad: stockCantidad,
              cantidadReservada: 0,
            },
          });
        }
      }
    }
    console.log(`  ✓ Precios y stock creados para ${tienda.nombre}`);
  }
  console.log('');

  // ========== CREAR PEDIDO DE EJEMPLO ==========
  console.log('📦 Creando pedido de ejemplo...');

  const precioCOEjemplo = await prisma.precioCO.findFirst({
    where: { tiendaId: tiendaCentro.id },
    include: { producto: true, talla: true, color: true, corrida: true },
  });

  if (precioCOEjemplo) {
    const numeroPedido = `PD-${new Date().getFullYear()}-000001`;

    const pedido = await prisma.pedido.create({
      data: {
        numeroPedido,
        usuarioId: clienteDemo.id,
        tiendaId: tiendaCentro.id,
        estado: EstadoPedido.PENDIENTE,
        tipoPago: TipoPago.TRANSFERENCIA,
        estadoPago: EstadoPago.PENDIENTE,
        subtotal: precioCOEjemplo.precio,
        total: precioCOEjemplo.precio,
        clienteNombre: `${clienteDemo.nombre} ${clienteDemo.apellido}`,
        clienteEmail: clienteDemo.email,
        items: {
          create: {
            productoId: precioCOEjemplo.productoId,
            precioCOId: precioCOEjemplo.id,
            cantidad: 1,
            precioUnitario: precioCOEjemplo.precio,
            subtotal: precioCOEjemplo.precio,
            productoNombre: precioCOEjemplo.producto.nombre,
            productoCodigo: precioCOEjemplo.producto.codigo,
            corridaNombre: precioCOEjemplo.corrida.nombre,
            tallaNombre: precioCOEjemplo.talla.nombre,
            colorNombre: precioCOEjemplo.color.nombre,
          },
        },
        historial: {
          create: {
            estadoNuevo: EstadoPedido.PENDIENTE,
            observacion: 'Pedido creado desde seed',
            usuarioId: clienteDemo.id,
            usuarioNombre: `${clienteDemo.nombre} ${clienteDemo.apellido}`,
          },
        },
      },
    });

    console.log(`  ✓ Pedido creado: ${pedido.numeroPedido}`);
  }

  console.log('\n✅ Seed completado exitosamente!\n');
  console.log('────────────────────────────────────────');
  console.log(`Productos creados: ${productosCreados.length}`);
  console.log(`Colores creados: ${coloresDB.length}`);
  console.log(`Tallas por color: ${tallasAdulto.length}`);
  console.log(`Variantes totales: ${productosCreados.length * coloresDB.length * tallasAdulto.length * tiendas.length}`);
  console.log('');
  console.log('Usuarios de prueba:');
  console.log('  admin@tienda.com / password123');
  console.log('  bodega@tienda.com / password123');
  console.log('  cajero@tienda.com / password123');
  console.log('  mostrador@tienda.com / password123');
  console.log('  cliente@demo.com / password123');
  console.log('────────────────────────────���───────────');
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
