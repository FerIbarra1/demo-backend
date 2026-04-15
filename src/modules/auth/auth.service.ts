import { Injectable, UnauthorizedException, ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { UpdateUserDto, ChangePasswordDto } from './dto/update-user.dto';
import { RolUsuario, Usuario } from '@prisma/client';
import { AuthResponse, JwtPayload } from '../../types/user.types';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const existingUser = await this.prisma.usuario.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('El email ya está registrado');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const usuario = await this.prisma.usuario.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        nombre: dto.nombre,
        apellido: dto.apellido,
        telefono: dto.telefono,
        rol: dto.rol || RolUsuario.CLIENTE,
      },
    });

    this.logger.log(`Usuario registrado: ${usuario.email}`);

    return this.generateTokens(usuario);
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const usuario = await this.prisma.usuario.findUnique({
      where: { email: dto.email },
    });

    if (!usuario) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    if (!usuario.activo) {
      throw new UnauthorizedException('Usuario inactivo');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, usuario.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Actualizar último login
    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: { lastLogin: new Date() },
    });

    // Si el cliente especifica tienda, actualizar
    if (dto.tiendaId && usuario.rol === RolUsuario.CLIENTE) {
      await this.prisma.usuario.update({
        where: { id: usuario.id },
        data: { tiendaId: dto.tiendaId },
      });
      usuario.tiendaId = dto.tiendaId;
    }

    this.logger.log(`Login exitoso: ${usuario.email}`);

    return this.generateTokens(usuario);
  }

  async refreshToken(dto: RefreshTokenDto): Promise<AuthResponse> {
    try {
      const payload = this.jwtService.verify<JwtPayload>(dto.refreshToken, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      const usuario = await this.prisma.usuario.findUnique({
        where: { id: payload.sub },
      });

      if (!usuario || !usuario.activo) {
        throw new UnauthorizedException('Token inválido');
      }

      return this.generateTokens(usuario);
    } catch (error) {
      throw new UnauthorizedException('Token de refresco inválido');
    }
  }

  async logout(userId: number, _token: string): Promise<{ message: string }> {
    this.logger.log(`Logout: usuario ${userId}`);
    return { message: 'Sesión cerrada exitosamente' };
  }

  async getProfile(userId: number): Promise<Omit<Usuario, 'password'>> {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: userId },
      include: { tienda: true },
    });

    if (!usuario) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    const { password: _, ...result } = usuario;
    return result as Omit<Usuario, 'password'>;
  }

  async generateKioskToken(userId: number): Promise<{ kioskToken: string; expiresAt: Date }> {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: userId },
    });

    if (!usuario) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    const payload = {
      sub: usuario.id,
      email: usuario.email,
      type: 'kiosk-login',
    };

    // Token muy corto: 5 minutos
    const kioskToken = this.jwtService.sign(payload, { expiresIn: '5m' });
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 5);

    return { kioskToken, expiresAt };
  }

  async updateProfile(userId: number, dto: UpdateUserDto): Promise<Omit<Usuario, 'password'>> {
    const usuario = await this.prisma.usuario.update({
      where: { id: userId },
      data: {
        nombre: dto.nombre,
        apellido: dto.apellido,
        telefono: dto.telefono,
      },
    });

    const { password: _, ...result } = usuario;
    return result as Omit<Usuario, 'password'>;
  }

  async changePassword(userId: number, dto: ChangePasswordDto): Promise<{ message: string }> {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: userId },
    });

    if (!usuario) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    const isPasswordValid = await bcrypt.compare(dto.oldPassword, usuario.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('La contraseña actual es incorrecta');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.usuario.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    return { message: 'Contraseña actualizada exitosamente' };
  }

  async loginByKioskToken(kioskToken: string): Promise<AuthResponse> {
    try {
      const payload = this.jwtService.verify(kioskToken);

      if (payload.type !== 'kiosk-login') {
        throw new UnauthorizedException('Token de kiosko inválido');
      }

      const usuario = await this.prisma.usuario.findUnique({
        where: { id: payload.sub },
      });

      if (!usuario || !usuario.activo) {
        throw new UnauthorizedException('Usuario no válido o inactivo');
      }

      this.logger.log(`Login por QR exitoso: ${usuario.email}`);
      return this.generateTokens(usuario);
    } catch (error) {
      throw new UnauthorizedException('Token de kiosko expirado o inválido');
    }
  }

  private generateTokens(usuario: Usuario): AuthResponse {
    const payload: JwtPayload = {
      sub: usuario.id,
      email: usuario.email,
      rol: usuario.rol,
      tiendaId: usuario.tiendaId ?? undefined,
    };

    const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN') || '1h';
    const refreshExpiresIn = this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d';

    const accessToken = this.jwtService.sign(payload, { expiresIn: expiresIn as any });
    const refreshToken = this.jwtService.sign(payload, { expiresIn: refreshExpiresIn as any });

    return {
      accessToken,
      refreshToken,
      expiresIn: 3600,
      user: {
        id: usuario.id,
        email: usuario.email,
        nombre: usuario.nombre,
        rol: usuario.rol,
        tiendaId: usuario.tiendaId ?? undefined,
      },
    };
  }
}
