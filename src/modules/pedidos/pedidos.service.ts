import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePedidoDto } from './dto/create-pedido.dto';
import { CambiarEstadoDto } from './dto/cambiar-estado.dto';
import { VerificarPagoDto } from './dto/verificar-pago.dto';
import { UpdatePedidoDto } from './dto/update-pedido.dto';
import { EstadoPedido, EstadoPago, TipoPago, RolUsuario, Prisma } from '@prisma/client';
import { UserContext, ItemPedidoData } from '../../types/pedido.types';

@Injectable()
export class PedidosService {
  constructor(private prisma: PrismaService) {}

  // ========== CLIENTE ==========

  async crearPedido(dto: CreatePedidoDto, usuario: UserContext) {
    if (!usuario.tiendaId) {
      throw new BadRequestException('Debe seleccionar una tienda para crear el pedido');
    }

    const tienda = await this.prisma.tienda.findFirst({
      where: { id: usuario.tiendaId, activa: true },
    });

    if (!tienda) {
      throw new BadRequestException('La tienda seleccionada no está disponible');
    }

    const preciosCO = await this.prisma.precioCO.findMany({
      where: {
        id: { in: dto.items.map((i) => i.precioCOId) },
        tiendaId: usuario.tiendaId,
      },
      include: {
        producto: true,
        talla: true,
        color: true,
        corrida: true,
        stock: true,
      },
    });

    if (preciosCO.length !== dto.items.length) {
      throw new BadRequestException('Algunos productos no están disponibles en esta tienda');
    }

    for (const item of dto.items) {
      const pco = preciosCO.find((p) => p.id === item.precioCOId);
      if (!pco) {
        throw new BadRequestException('Producto no encontrado');
      }
      const stockDisponible = pco.stock
        ? pco.stock.cantidad - pco.stock.cantidadReservada
        : 0;

      if (stockDisponible < item.cantidad) {
        throw new BadRequestException(
          `Stock insuficiente para ${pco.producto.nombre} - ${pco.color.nombre} - Talla ${pco.talla.nombre}. Disponible: ${stockDisponible}`
        );
      }
    }

    let subtotal = 0;
    const itemsData: ItemPedidoData[] = dto.items.map((item) => {
      const pco = preciosCO.find((p) => p.id === item.precioCOId);
      if (!pco) {
        throw new BadRequestException('Producto no encontrado');
      }
      const itemSubtotal = Number(pco.precio) * item.cantidad;
      subtotal += itemSubtotal;

      return {
        productoId: pco.productoId,
        precioCOId: pco.id,
        cantidad: item.cantidad,
        precioUnitario: Number(pco.precio),
        subtotal: itemSubtotal,
        productoNombre: pco.producto.nombre,
        productoCodigo: pco.producto.codigo,
        corridaNombre: pco.corrida.nombre,
        tallaNombre: pco.talla.nombre,
        colorNombre: pco.color.nombre,
      };
    });

    const total = subtotal;
    const numeroPedido = await this.generarNumeroPedido();
    const estadoPagoInicial = EstadoPago.PENDIENTE;
    const tiendaId = usuario.tiendaId;

    const pedido = await this.prisma.$transaction(async (tx) => {
      const nuevoPedido = await tx.pedido.create({
        data: {
          numeroPedido,
          usuarioId: usuario.userId,
          tiendaId,
          estado: EstadoPedido.PENDIENTE,
          tipoPago: dto.tipoPago,
          estadoPago: estadoPagoInicial,
          subtotal,
          total,
          clienteNombre: usuario.nombre,
          clienteEmail: '',
          notas: dto.notas,
          referenciaPago: dto.referenciaPago,
          items: { create: itemsData },
          historial: {
            create: {
              estadoNuevo: EstadoPedido.PENDIENTE,
              observacion: 'Pedido creado por cliente',
              usuarioId: usuario.userId,
              usuarioNombre: usuario.nombre,
            },
          },
        },
        include: {
          items: true,
          tienda: true,
        },
      });

      for (const item of dto.items) {
        const pco = preciosCO.find((p) => p.id === item.precioCOId);
        if (pco?.stock) {
          await tx.stock.update({
            where: { id: pco.stock.id },
            data: {
              cantidadReservada: {
                increment: item.cantidad,
              },
            },
          });
        }
      }

      return nuevoPedido;
    });

    return {
      ...pedido,
      mensaje: 'Pedido creado exitosamente',
    };
  }

  async obtenerMisPedidos(usuarioId: number, pagina = 1, limite = 10) {
    const skip = (pagina - 1) * limite;

    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where: { usuarioId },
        include: {
          items: {
            select: {
              id: true,
              productoNombre: true,
              tallaNombre: true,
              colorNombre: true,
              cantidad: true,
              precioUnitario: true,
            },
          },
          tienda: {
            select: { nombre: true },
          },
          _count: {
            select: { historial: true },
          },
        },
        orderBy: { fechaPedido: 'desc' },
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where: { usuarioId } }),
    ]);

    return {
      data: pedidos,
      meta: {
        total,
        pagina,
        limite,
        totalPaginas: Math.ceil(total / limite),
      },
    };
  }

  async obtenerMiPedido(pedidoId: number, usuarioId: number) {
    const pedido = await this.prisma.pedido.findFirst({
      where: {
        id: pedidoId,
        usuarioId,
      },
      include: {
        items: true,
        tienda: true,
        historial: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    return pedido;
  }

  async cancelarPedido(pedidoId: number, usuarioId: number, usuario: UserContext) {
    const pedido = await this.prisma.pedido.findFirst({
      where: {
        id: pedidoId,
        usuarioId,
      },
      include: { items: true },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    if (pedido.estado !== EstadoPedido.PENDIENTE) {
      throw new BadRequestException('Solo se pueden cancelar pedidos en estado PENDIENTE');
    }

    return this.cambiarEstado(pedidoId, {
      nuevoEstado: EstadoPedido.CANCELADO,
      observacion: 'Cancelado por el cliente',
    }, usuario);
  }

  // ========== BODEGA ==========

  async obtenerPedidosBodega(tiendaId?: number, estado?: EstadoPedido) {
    const where: Prisma.PedidoWhereInput = {};

    if (tiendaId) {
      where.tiendaId = tiendaId;
    }

    if (estado) {
      where.estado = estado;
    } else {
      where.estado = { in: [EstadoPedido.PENDIENTE, EstadoPedido.EN_BODEGA] };
    }

    return this.prisma.pedido.findMany({
      where,
      include: {
        items: {
          include: {
            precioCO: {
              include: {
                stock: true,
              },
            },
          },
        },
        tienda: true,
        usuario: {
          select: { nombre: true, telefono: true },
        },
      },
      orderBy: { fechaPedido: 'asc' },
    });
  }

  async verificarStockPedido(pedidoId: number, usuario: UserContext) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: {
        items: {
          include: {
            precioCO: {
              include: {
                stock: true,
              },
            },
          },
        },
      },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    const verificacion = pedido.items.map((item) => {
      const stockDisponible = item.precioCO.stock
        ? item.precioCO.stock.cantidad - item.precioCO.stock.cantidadReservada + item.cantidad
        : 0;

      return {
        itemId: item.id,
        producto: item.productoNombre,
        talla: item.tallaNombre,
        color: item.colorNombre,
        cantidadSolicitada: item.cantidad,
        stockDisponible,
        suficiente: stockDisponible >= item.cantidad,
      };
    });

    const todosSuficientes = verificacion.every((v) => v.suficiente);

    return {
      pedidoId: pedido.id,
      numeroPedido: pedido.numeroPedido,
      estado: pedido.estado,
      verificacion,
      stockSuficiente: todosSuficientes,
    };
  }

  async marcarEnBodega(pedidoId: number, usuario: UserContext) {
    return this.cambiarEstado(pedidoId, {
      nuevoEstado: EstadoPedido.EN_BODEGA,
      observacion: 'Pedido recibido en bodega',
    }, usuario);
  }

  async marcarListoParaEntrega(pedidoId: number, usuario: UserContext) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    if (pedido.estadoPago !== EstadoPago.VERIFICADO && pedido.tipoPago !== TipoPago.EFECTIVO) {
      throw new BadRequestException('El pedido debe estar pagado antes de marcarlo como listo');
    }

    return this.cambiarEstado(pedidoId, {
      nuevoEstado: EstadoPedido.LISTO_PARA_ENTREGA,
      observacion: 'Pedido preparado y listo para entrega',
    }, usuario);
  }

  async actualizarNotasBodega(pedidoId: number, notas: string, usuario: UserContext) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    return this.prisma.pedido.update({
      where: { id: pedidoId },
      data: { notasBodega: notas },
    });
  }

  // ========== CAJERO ==========

  async obtenerPedidosPendientesPago(tiendaId?: number) {
    const where: Prisma.PedidoWhereInput = {
      estadoPago: EstadoPago.PENDIENTE,
      estado: { not: EstadoPedido.CANCELADO },
    };

    if (tiendaId) {
      where.tiendaId = tiendaId;
    }

    return this.prisma.pedido.findMany({
      where,
      include: {
        items: true,
        tienda: true,
        usuario: {
          select: { nombre: true, telefono: true },
        },
      },
      orderBy: { fechaPedido: 'asc' },
    });
  }

  async verificarPago(pedidoId: number, dto: VerificarPagoDto, usuario: UserContext) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    if (dto.aprobado) {
      await this.prisma.pedido.update({
        where: { id: pedidoId },
        data: {
          estadoPago: EstadoPago.VERIFICADO,
          fechaPago: new Date(),
        },
      });

      return {
        mensaje: 'Pago verificado exitosamente',
        pedidoId,
        estadoPago: EstadoPago.VERIFICADO,
      };
    } else {
      await this.prisma.pedido.update({
        where: { id: pedidoId },
        data: {
          estadoPago: EstadoPago.RECHAZADO,
        },
      });

      return {
        mensaje: 'Pago rechazado',
        pedidoId,
        estadoPago: EstadoPago.RECHAZADO,
      };
    }
  }

  async marcarPagadoEnTienda(pedidoId: number, usuario: UserContext) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    if (pedido.tipoPago !== TipoPago.EFECTIVO) {
      throw new BadRequestException('Esta función solo aplica para pagos en efectivo');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          estadoPago: EstadoPago.VERIFICADO,
          fechaPago: new Date(),
        },
      });

      if (pedido.estado === EstadoPedido.EN_BODEGA) {
        await tx.pedido.update({
          where: { id: pedidoId },
          data: {
            estado: EstadoPedido.LISTO_PARA_ENTREGA,
            fechaListo: new Date(),
          },
        });

        await tx.historialPedido.create({
          data: {
            pedidoId,
            estadoAnterior: EstadoPedido.EN_BODEGA,
            estadoNuevo: EstadoPedido.LISTO_PARA_ENTREGA,
            observacion: 'Pagado en tienda y listo para entrega',
            usuarioId: usuario.userId,
            usuarioNombre: usuario.nombre,
          },
        });
      }
    });

    return {
      mensaje: 'Pedido pagado y actualizado exitosamente',
      pedidoId,
    };
  }

  // ========== MOSTRADOR ==========

  async obtenerPedidosListos(tiendaId?: number) {
    const where: Prisma.PedidoWhereInput = {
      estado: EstadoPedido.LISTO_PARA_ENTREGA,
    };

    if (tiendaId) {
      where.tiendaId = tiendaId;
    }

    return this.prisma.pedido.findMany({
      where,
      include: {
        items: true,
        tienda: true,
        usuario: {
          select: { nombre: true, telefono: true, email: true },
        },
      },
      orderBy: { fechaListo: 'asc' },
    });
  }

  async buscarPedidoPorNumero(numeroPedido: string) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { numeroPedido },
      include: {
        items: true,
        tienda: true,
        usuario: {
          select: { nombre: true, telefono: true, email: true },
        },
        historial: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    return pedido;
  }

  async entregarPedido(pedidoId: number, usuario: UserContext) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: { items: true },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    if (pedido.estado !== EstadoPedido.LISTO_PARA_ENTREGA) {
      throw new BadRequestException('El pedido debe estar en estado LISTO_PARA_ENTREGA');
    }

    return this.prisma.$transaction(async (tx) => {
      const pedidoActualizado = await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          estado: EstadoPedido.ENTREGADO,
          fechaEntrega: new Date(),
          entregadoPor: usuario.userId,
        },
      });

      for (const item of pedido.items) {
        const stock = await tx.stock.findUnique({
          where: { precioCOId: item.precioCOId },
        });

        if (stock) {
          await tx.stock.update({
            where: { id: stock.id },
            data: {
              cantidad: {
                decrement: item.cantidad,
              },
              cantidadReservada: {
                decrement: item.cantidad,
              },
            },
          });
        }
      }

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: EstadoPedido.LISTO_PARA_ENTREGA,
          estadoNuevo: EstadoPedido.ENTREGADO,
          observacion: `Pedido entregado por ${usuario.nombre}`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      return pedidoActualizado;
    });
  }

  // ========== ADMIN ==========

  async obtenerTodosPedios(filtros?: {
    tiendaId?: number;
    estado?: EstadoPedido;
    estadoPago?: EstadoPago;
    pagina?: number;
    limite?: number;
  }) {
    const { tiendaId, estado, estadoPago, pagina = 1, limite = 20 } = filtros || {};
    const skip = (pagina - 1) * limite;

    const where: Prisma.PedidoWhereInput = {};

    if (tiendaId) where.tiendaId = tiendaId;
    if (estado) where.estado = estado;
    if (estadoPago) where.estadoPago = estadoPago;

    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: {
            select: {
              id: true,
              productoNombre: true,
              cantidad: true,
              precioUnitario: true,
            },
          },
          tienda: {
            select: { nombre: true },
          },
          usuario: {
            select: { nombre: true, email: true },
          },
          _count: {
            select: { historial: true },
          },
        },
        orderBy: { fechaPedido: 'desc' },
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);

    return {
      data: pedidos,
      meta: {
        total,
        pagina,
        limite,
        totalPaginas: Math.ceil(total / limite),
      },
    };
  }

  async obtenerPedidoCompleto(pedidoId: number) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: {
        items: true,
        tienda: true,
        usuario: {
          select: { id: true, nombre: true, email: true, telefono: true },
        },
        historial: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    return pedido;
  }

  async obtenerHistorialPedido(pedidoId: number) {
    const historial = await this.prisma.historialPedido.findMany({
      where: { pedidoId },
      orderBy: { createdAt: 'asc' },
    });

    return historial;
  }

  // ========== UTILIDADES ==========

  private async generarNumeroPedido(): Promise<string> {
    const year = new Date().getFullYear();

    const ultimoPedido = await this.prisma.pedido.findFirst({
      where: {
        numeroPedido: {
          startsWith: `PD-${year}-`,
        },
      },
      orderBy: { id: 'desc' },
    });

    let secuencial = 1;

    if (ultimoPedido) {
      const partes = ultimoPedido.numeroPedido.split('-');
      const ultimoNumero = parseInt(partes[2], 10);
      if (!isNaN(ultimoNumero)) {
        secuencial = ultimoNumero + 1;
      }
    }

    return `PD-${year}-${secuencial.toString().padStart(6, '0')}`;
  }

  private async cambiarEstado(
    pedidoId: number,
    dto: CambiarEstadoDto,
    usuario: UserContext,
  ) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    const estadoAnterior = pedido.estado;
    const estadoNuevo = dto.nuevoEstado;

    const transicionesPermitidas: Record<EstadoPedido, EstadoPedido[]> = {
      [EstadoPedido.PENDIENTE]: [EstadoPedido.EN_BODEGA, EstadoPedido.CANCELADO],
      [EstadoPedido.EN_BODEGA]: [EstadoPedido.LISTO_PARA_ENTREGA, EstadoPedido.CANCELADO],
      [EstadoPedido.LISTO_PARA_ENTREGA]: [EstadoPedido.ENTREGADO],
      [EstadoPedido.ENTREGADO]: [],
      [EstadoPedido.CANCELADO]: [],
    };

    const permitidas = transicionesPermitidas[estadoAnterior];
    if (!permitidas.includes(estadoNuevo)) {
      throw new BadRequestException(
        `No se puede cambiar de estado ${estadoAnterior} a ${estadoNuevo}`
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const datosActualizar: Prisma.PedidoUpdateInput = { estado: estadoNuevo };

      if (estadoNuevo === EstadoPedido.EN_BODEGA) {
        datosActualizar.fechaPreparacion = new Date();
        datosActualizar.preparadoPor = usuario.userId;
      } else if (estadoNuevo === EstadoPedido.LISTO_PARA_ENTREGA) {
        datosActualizar.fechaListo = new Date();
      } else if (estadoNuevo === EstadoPedido.ENTREGADO) {
        datosActualizar.fechaEntrega = new Date();
        datosActualizar.entregadoPor = usuario.userId;
      } else if (estadoNuevo === EstadoPedido.CANCELADO) {
        const items = await tx.itemPedido.findMany({
          where: { pedidoId },
        });

        for (const item of items) {
          const stock = await tx.stock.findUnique({
            where: { precioCOId: item.precioCOId },
          });

          if (stock) {
            await tx.stock.update({
              where: { id: stock.id },
              data: {
                cantidadReservada: {
                  decrement: item.cantidad,
                },
              },
            });
          }
        }
      }

      const pedidoActualizado = await tx.pedido.update({
        where: { id: pedidoId },
        data: datosActualizar,
      });

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior,
          estadoNuevo,
          observacion: dto.observacion || `Cambio de estado por ${usuario.nombre}`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      return pedidoActualizado;
    });
  }
}
