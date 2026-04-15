import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTiendaDto } from './dto/create-tienda.dto';
import { UpdateTiendaDto } from './dto/update-tienda.dto';

@Injectable()
export class TiendasService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.tienda.findMany({
      where: { activa: true },
      orderBy: { nombre: 'asc' },
    });
  }

  async findAllWithFilters(estado?: string, ciudad?: string) {
    const where: any = { activa: true };

    if (estado) {
      where.estado = estado;
    }

    if (ciudad) {
      where.ciudad = ciudad;
    }

    return this.prisma.tienda.findMany({
      where,
      orderBy: [{ estado: 'asc' }, { ciudad: 'asc' }, { nombre: 'asc' }],
    });
  }

  async getEstados(): Promise<string[]> {
    const result = await this.prisma.tienda.findMany({
      where: { activa: true },
      select: { estado: true },
      distinct: ['estado'],
      orderBy: { estado: 'asc' },
    });
    return result.map(t => t.estado);
  }

  async getCiudadesPorEstado(estado: string): Promise<string[]> {
    const result = await this.prisma.tienda.findMany({
      where: { activa: true, estado },
      select: { ciudad: true },
      distinct: ['ciudad'],
      orderBy: { ciudad: 'asc' },
    });
    return result.map(t => t.ciudad);
  }

  async findOne(id: number) {
    const tienda = await this.prisma.tienda.findUnique({
      where: { id },
      include: {
        _count: {
          select: { productosTienda: true },
        },
      },
    });

    if (!tienda) {
      throw new NotFoundException('Tienda no encontrada');
    }

    return tienda;
  }

  async create(dto: CreateTiendaDto) {
    return this.prisma.tienda.create({
      data: dto,
    });
  }

  async update(id: number, dto: UpdateTiendaDto) {
    await this.findOne(id); // Verifica que existe

    return this.prisma.tienda.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number) {
    await this.findOne(id); // Verifica que existe

    // Soft delete - solo desactivar
    return this.prisma.tienda.update({
      where: { id },
      data: { activa: false },
    });
  }
}
