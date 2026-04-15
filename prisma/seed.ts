import { PrismaClient, RolUsuario, EstadoPedido, TipoPago, EstadoPago } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed de datos...\n');

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

  const corridaDama = await prisma.corrida.create({
    data: {
      nombre: 'Dama',
      descripcion: 'Tallas exclusivas dama',
      tallas: {
        create: [
          { nombre: 'CH', orden: 1 },
          { nombre: 'M', orden: 2 },
          { nombre: 'G', orden: 3 },
          { nombre: 'XG', orden: 4 },
        ],
      },
    },
    include: { tallas: true },
  });

  const corridaInfantil = await prisma.corrida.create({
    data: {
      nombre: 'Infantil',
      descripcion: 'Tallas para niños',
      tallas: {
        create: [
          { nombre: '4', orden: 1 },
          { nombre: '6', orden: 2 },
          { nombre: '8', orden: 3 },
          { nombre: '10', orden: 4 },
          { nombre: '12', orden: 5 },
          { nombre: '14', orden: 6 },
        ],
      },
    },
    include: { tallas: true },
  });

  console.log(`  ✓ Corrida: ${corridaAdulto.nombre}`);
  console.log(`  ✓ Corrida: ${corridaDama.nombre}`);
  console.log(`  ✓ Corrida: ${corridaInfantil.nombre}\n`);

  // ========== CREAR COLORES ==========
  console.log('🎨 Creando colores...');

  const colores = await prisma.color.createMany({
    data: [
      { codigo: 'BL', nombre: 'Blanco', hex: '#FFFFFF' },
      { codigo: 'NG', nombre: 'Negro', hex: '#000000' },
      { codigo: 'AZ', nombre: 'Azul Marino', hex: '#1B3A5F' },
      { codigo: 'RJ', nombre: 'Rojo', hex: '#CC0000' },
      { codigo: 'GR', nombre: 'Gris', hex: '#808080' },
      { codigo: 'VD', nombre: 'Verde', hex: '#228B22' },
    ],
  });

  const coloresDB = await prisma.color.findMany();
  coloresDB.forEach(c => console.log(`  ✓ Color: ${c.nombre}`));
  console.log('');

  // ========== CREAR PRODUCTOS ==========
  console.log('👕 Creando productos...');

  const producto1 = await prisma.producto.create({
    data: {
      codigo: 'CAM-001',
      nombre: 'Camiseta Básica Algodón',
      descripcion: 'Camiseta clásica 100% algodón peinado, ideal para uso diario. Suave al tacto y duradera.',
      imagenPrincipal: 'https://placehold.co/400x400/1B3A5F/FFFFFF?text=Camiseta+Basica',
      imagenes: [
        'https://placehold.co/400x400/1B3A5F/FFFFFF?text=Azul',
        'https://placehold.co/400x400/000000/FFFFFF?text=Negro',
        'https://placehold.co/400x400/CC0000/FFFFFF?text=Rojo',
      ],
      activo: true,
      categoria: 'Camisetas',
      subcategoria: 'Básicas',
    },
  });

  const producto2 = await prisma.producto.create({
    data: {
      codigo: 'CAM-002',
      nombre: 'Camiseta Polo Clásica',
      descripcion: 'Camiseta tipo polo con cuello, 60% algodón 40% poliéster. Elegante para ocasiones formales.',
      imagenPrincipal: 'https://placehold.co/400x400/FFFFFF/000000?text=Polo+Blanco',
      imagenes: [
        'https://placehold.co/400x400/FFFFFF/000000?text=Blanco',
        'https://placehold.co/400x400/000000/FFFFFF?text=Negro',
        'https://placehold.co/400x400/808080/FFFFFF?text=Gris',
      ],
      activo: true,
      categoria: 'Camisetas',
      subcategoria: 'Polo',
    },
  });

  const producto3 = await prisma.producto.create({
    data: {
      codigo: 'CAM-003',
      nombre: 'Camiseta Deportiva DryFit',
      descripcion: 'Camiseta deportiva tecnología DryFit, absorbe el sudor y permite transpiración.',
      imagenPrincipal: 'https://placehold.co/400x400/228B22/FFFFFF?text=Deportiva',
      imagenes: [
        'https://placehold.co/400x400/228B22/FFFFFF?text=Verde',
        'https://placehold.co/400x400/CC0000/FFFFFF?text=Rojo',
        'https://placehold.co/400x400/1B3A5F/FFFFFF?text=Azul',
      ],
      activo: true,
      categoria: 'Camisetas',
      subcategoria: 'Deportiva',
    },
  });

  console.log(`  ✓ Producto: ${producto1.nombre}`);
  console.log(`  ✓ Producto: ${producto2.nombre}`);
  console.log(`  ✓ Producto: ${producto3.nombre}\n`);

  // ========== CREAR PRECIOS Y STOCK ==========
  console.log('💰 Creando precios y stock...');

  const tiendas = [tiendaCentro, tiendaNorte];
  const productos = [producto1, producto2, producto3];
  const tallasAdulto = corridaAdulto.tallas;

  for (const tienda of tiendas) {
    for (const producto of productos) {
      // Crear relación producto-tienda
      await prisma.productoTienda.create({
        data: {
          productoId: producto.id,
          tiendaId: tienda.id,
          visible: true,
          destacado: producto.codigo === 'CAM-001',
        },
      });

      // Crear precio base
      const precioBase = producto.codigo === 'CAM-001' ? 299.99 :
                        producto.codigo === 'CAM-002' ? 399.99 : 349.99;

      await prisma.precio.create({
        data: {
          productoId: producto.id,
          tiendaId: tienda.id,
          precioBase,
          activo: true,
        },
      });

      // Crear PrecioCO y Stock para cada combinación
      for (const talla of tallasAdulto) {
        for (const color of coloresDB.slice(0, 4)) { // Solo 4 colores por producto
          const sku = `${producto.codigo}-${color.codigo}-${talla.nombre}-T${tienda.id}`;
          const precioVariante = talla.nombre === 'XXL' || talla.nombre === 'XG'
            ? precioBase + 30
            : precioBase;

          const precioCO = await prisma.precioCO.create({
            data: {
              productoId: producto.id,
              tiendaId: tienda.id,
              corridaId: corridaAdulto.id,
              tallaId: talla.id,
              colorId: color.id,
              precio: precioVariante,
              sku,
            },
          });

          // Crear stock aleatorio entre 0 y 50
          const stockCantidad = Math.floor(Math.random() * 51);
          await prisma.stock.create({
            data: {
              precioCOId: precioCO.id,
              tiendaId: tienda.id,
              tallaId: talla.id,
              colorId: color.id,
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
        clienteTelefono: clienteDemo.telefono,
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
  console.log('Usuarios de prueba:');
  console.log('  admin@tienda.com / password123');
  console.log('  bodega@tienda.com / password123');
  console.log('  cajero@tienda.com / password123');
  console.log('  mostrador@tienda.com / password123');
  console.log('  cliente@demo.com / password123');
  console.log('────────────────────────────────────────\n');
}

main()
  .catch((e) => {
    console.error('❌ Error en seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
