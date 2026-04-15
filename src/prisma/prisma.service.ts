import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Conexión a base de datos establecida');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Conexión a base de datos cerrada');
  }

  async cleanDatabase() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('No se puede limpiar la base de datos en producción');
    }

    // Limpiar en orden inverso para respetar FKs
    await this.$transaction([
      this.logActividad.deleteMany(),
      this.historialPedido.deleteMany(),
      this.itemPedido.deleteMany(),
      this.pedido.deleteMany(),
      this.stock.deleteMany(),
      this.precioCO.deleteMany(),
      this.precio.deleteMany(),
      this.productoTienda.deleteMany(),
      this.producto.deleteMany(),
      this.color.deleteMany(),
      this.talla.deleteMany(),
      this.corrida.deleteMany(),
      this.sesion.deleteMany(),
      this.usuario.deleteMany(),
      this.tienda.deleteMany(),
    ]);
  }
}
