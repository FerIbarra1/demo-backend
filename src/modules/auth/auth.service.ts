import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { KioskLoginDto } from './dto/kiosk-login.dto';
import { UpdateUserDto, ChangePasswordDto } from './dto/update-user.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';
import { RolUsuario, TipoNotificacion, Usuario } from '@prisma/client';
import { AuthResponse, JwtPayload, KioskTokenPayload } from '../../types/user.types';
import { MailService } from '../mail/mail.service';
import { mailTemplates, mailSubjects } from '../mail/mail.templates';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mail: MailService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const existingUser = await this.prisma.usuario.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('El email ya está registrado');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    // Registro público siempre crea CLIENTE. Roles internos (BODEGA, CAJERO, ADMIN)
    // los asigna un ADMIN desde el panel o seed. Esto previene escalación de privilegios
    // por auto-registro.
    const usuario = await this.prisma.usuario.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        nombre: dto.nombre,
        apellido: dto.apellido,
        telefono: dto.telefono,
        rol: RolUsuario.CLIENTE,
      },
    });

    this.logger.log(`Usuario registrado: ${usuario.email}`);

    // Email de bienvenida: fire-and-forget. Solo se manda a CLIENTE (los
    // usuarios internos los crea el admin y no pasan por aquí normalmente).
    if (usuario.rol === RolUsuario.CLIENTE) {
      setImmediate(() => {
        this.enviarBienvenida(usuario).catch((err) =>
          this.logger.error(`Falló email BIENVENIDA: ${err.message}`),
        );
      });
    }

    return this.generateTokens(usuario);
  }

  private async enviarBienvenida(usuario: Usuario) {
    const logoUrl = this.configService.get<string>('app.mail.logoUrl') ?? '';
    const frontendUrl =
      this.configService.get<string>('app.mail.frontendUrl') ?? '';

    const template = mailTemplates.Bienvenida({
      nombre: usuario.nombre,
      logoUrl,
      frontendUrl,
    });

    await this.mail.sendEmail({
      to: usuario.email,
      subject: mailSubjects.BIENVENIDA,
      template,
      tipoNotificacion: TipoNotificacion.BIENVENIDA,
    });
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const usuario = await this.prisma.usuario.findUnique({
      where: { email: dto.email },
    });

    if (!usuario) throw new UnauthorizedException('Credenciales inválidas');
    if (!usuario.activo) throw new UnauthorizedException('Usuario inactivo');

    const isPasswordValid = await bcrypt.compare(dto.password, usuario.password);
    if (!isPasswordValid) throw new UnauthorizedException('Credenciales inválidas');

    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: { lastLogin: new Date() },
    });

    if (dto.tiendaId && usuario.rol === RolUsuario.CLIENTE) {
      const tienda = await this.prisma.tienda.findFirst({
        where: { id: dto.tiendaId, activa: true },
        select: { id: true },
      });
      if (!tienda) throw new UnauthorizedException('Tienda no disponible');

      const membership = await this.prisma.usuarioTienda.findFirst({
        where: { usuarioId: usuario.id, tiendaId: dto.tiendaId, activo: true },
        select: { id: true },
      });
      if (usuario.tiendaId !== dto.tiendaId && !membership) {
        throw new UnauthorizedException('El usuario no tiene acceso a la tienda');
      }

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

      const usuario = await this.prisma.usuario.findUnique({ where: { id: payload.sub } });
      if (!usuario || !usuario.activo) throw new UnauthorizedException('Token inválido');

      return this.generateTokens(usuario);
    } catch {
      throw new UnauthorizedException('Token de refresco inválido');
    }
  }

  /**
   * Genera un kiosk token firmado (corta duración) que el cliente del kiosko
   * muestra como QR. El token queda ATADO a la tienda actual del cliente
   * (la que está viendo en el catálogo). Si el QR se intercepta y se
   * intenta usar en otra tienda activa, el login falla con 403.
   */
  async getKioskToken(
    usuarioId: number,
    tiendaId: number,
  ): Promise<{ kioskToken: string; expiresAt: string }> {
    const expiresIn = this.configService.get<string>('KIOSK_TOKEN_EXPIRES_IN') || '5m';
    const payload: KioskTokenPayload = { sub: usuarioId, kind: 'kiosk', tiendaId };
    const kioskToken = this.jwtService.sign(payload, {
      expiresIn: expiresIn as any,
    });
    // Decodificar para conocer expiry exacto
    const decoded = this.jwtService.decode(kioskToken) as { exp: number } | null;
    const expiresAt = new Date((decoded?.exp ?? 0) * 1000).toISOString();
    return { kioskToken, expiresAt };
  }

  /**
   * Intercambia un kiosk token por una sesión completa del usuario.
   * El cliente debe estar autenticado para generar el kiosk token; cualquier
   * persona con el kiosk token puede iniciar sesión como ese usuario,
   * pero SOLO en la tienda para la que fue emitido.
   */
  async loginByKioskToken(dto: KioskLoginDto): Promise<AuthResponse> {
    let payload: KioskTokenPayload;
    try {
      payload = this.jwtService.verify<KioskTokenPayload>(dto.kioskToken, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Kiosk token inválido o expirado');
    }

    if (payload.kind !== 'kiosk') {
      throw new BadRequestException('Token no es de kiosco');
    }

    // Defensa: el QR está atado a la tienda donde se generó. Si el
    // atacante intenta canjearlo en otra tienda activa, falla.
    if (payload.tiendaId !== dto.tiendaId) {
      throw new ForbiddenException(
        'Este código QR no es válido para esta tienda. Genera uno nuevo desde la tienda correcta.',
      );
    }

    const tienda = await this.prisma.tienda.findFirst({
      where: { id: dto.tiendaId, activa: true },
    });
    if (!tienda) throw new BadRequestException('Tienda inválida');

    const usuario = await this.prisma.usuario.findUnique({ where: { id: payload.sub } });
    if (!usuario || !usuario.activo) throw new UnauthorizedException('Usuario no disponible');

    if (usuario.rol === RolUsuario.CLIENTE) {
      await this.prisma.usuario.update({
        where: { id: usuario.id },
        data: { tiendaId: dto.tiendaId, lastLogin: new Date() },
      });
      usuario.tiendaId = dto.tiendaId;
    } else {
      await this.prisma.usuario.update({
        where: { id: usuario.id },
        data: { lastLogin: new Date() },
      });
    }

    this.logger.log(`Kiosk login: ${usuario.email} en tienda ${dto.tiendaId}`);

    return this.generateTokens(usuario);
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
    if (!usuario) throw new UnauthorizedException('Usuario no encontrado');
    const { password: _, ...result } = usuario;
    return result as Omit<Usuario, 'password'>;
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
    const usuario = await this.prisma.usuario.findUnique({ where: { id: userId } });
    if (!usuario) throw new UnauthorizedException('Usuario no encontrado');
    const ok = await bcrypt.compare(dto.oldPassword, usuario.password);
    if (!ok) throw new UnauthorizedException('La contraseña actual es incorrecta');
    await this.prisma.usuario.update({
      where: { id: userId },
      data: { password: await bcrypt.hash(dto.newPassword, 10) },
    });
    return { message: 'Contraseña actualizada exitosamente' };
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
    return {
      accessToken: this.jwtService.sign(payload, { expiresIn: expiresIn as any }),
      refreshToken: this.jwtService.sign(payload, { expiresIn: refreshExpiresIn as any }),
      expiresIn: 3600,
      user: {
        id: usuario.id,
        email: usuario.email,
        nombre: usuario.nombre,
        apellido: usuario.apellido ?? undefined,
        rol: usuario.rol,
        tiendaId: usuario.tiendaId ?? undefined,
        telefono: usuario.telefono ?? undefined,
      },
    };
  }

  /**
   * F7 (jul 2026): heartbeat del operador. Sólo actualiza `ultimoHeartbeat`
   * en la fila del Usuario autenticado. Es best-effort: si la fila no existe
   * (caso muy raro de token de un user ya borrado), se ignora silenciosamente
   * porque no queremos spamear logs ni mostrar errores al cliente en cada ping.
   */
  async heartbeat(userId: number): Promise<{ userId: number; ultimoHeartbeat: string }> {
    const now = new Date();
    try {
      await this.prisma.usuario.update({
        where: { id: userId },
        data: { ultimoHeartbeat: now },
        select: { id: true },
      });
    } catch {
      // Usuario no existe: ignorar (token de un user borrado). El polling
      // 5s de auth-store lo refrescará o lo deslogeará automáticamente.
    }
    return { userId, ultimoHeartbeat: now.toISOString() };
  }

  // =====================================================
  // PASSWORD RESET (F8 jul 2026)
  // =====================================================

  /**
   * Solicita un email de recuperación de contraseña. Por seguridad SIEMPRE
   * responde OK con el mismo shape — no filtra si el email existe o no.
   *
   * Si el email existe, genera un token random de 32 bytes, guarda su
   * SHA256 en BD con expiración, y manda el token en claro al usuario por
   * email. Si NO existe, no hace nada (pero el caller recibe el mismo OK).
   */
  async solicitarResetPassword(
    dto: ForgotPasswordDto,
    ipOrigen?: string,
  ): Promise<{ message: string }> {
    const message =
      'Si el email está registrado, te enviaremos un correo con instrucciones para restablecer tu contraseña.';

    const usuario = await this.prisma.usuario.findUnique({
      where: { email: dto.email },
    });
    if (!usuario || !usuario.activo) {
      // No filtrar existencia. Log interno para detectar abuso.
      this.logger.warn(
        `solicitarResetPassword para email no registrado o inactivo: ${dto.email}`,
      );
      return { message };
    }

    // Generar token random (32 bytes → 64 chars hex). Guardamos el hash
    // SHA256 — si la BD se filtra, los tokens en claro no están expuestos.
    const tokenRandom = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(tokenRandom).digest('hex');
    const expiresMin =
      this.configService.get<number>('app.mail.passwordResetExpiresMin') ?? 60;
    const expiresAt = new Date(Date.now() + expiresMin * 60 * 1000);

    await this.prisma.passwordResetToken.create({
      data: {
        usuarioId: usuario.id,
        token: tokenHash,
        expiresAt,
        ipOrigen: ipOrigen ?? null,
      },
    });

    const logoUrl = this.configService.get<string>('app.mail.logoUrl') ?? '';
    const frontendUrl =
      this.configService.get<string>('app.mail.frontendUrl') ?? '';
    const resetUrl = `${frontendUrl}/reset-password?token=${tokenRandom}`;

    const template = mailTemplates.ResetPassword({
      nombre: usuario.nombre,
      resetUrl,
      expiresInMin: expiresMin,
      logoUrl,
      frontendUrl,
    });

    // Fire-and-forget: el caller ya recibió su OK. Si el email falla, el
    // usuario puede intentar de nuevo.
    setImmediate(() => {
      this.mail
        .sendEmail({
          to: usuario.email,
          subject: mailSubjects.RESET_PASSWORD,
          template,
          tipoNotificacion: TipoNotificacion.RESET_PASSWORD,
        })
        .catch((err) =>
          this.logger.error(`Falló email RESET_PASSWORD: ${err.message}`),
        );
    });

    return { message };
  }

  /**
   * Restablece la contraseña usando un token. Valida:
   *   - El token existe (busca por hash SHA256).
   *   - No está usado.
   *   - No está expirado.
   * Si todo OK, hashea la nueva contraseña y la guarda. Marca usedAt.
   *
   * Devuelve OK genérico incluso si el token es inválido (defensa contra
   * enumeración de tokens). El cliente sabrá por la respuesta del frontend
   * (que no redirigirá).
   */
  async resetearPassword(
    dto: ResetPasswordDto,
  ): Promise<{ message: string }> {
    const message =
      'Si el token es válido, tu contraseña ha sido actualizada. Intenta iniciar sesión de nuevo.';

    const tokenHash = createHash('sha256').update(dto.token).digest('hex');
    const registro = await this.prisma.passwordResetToken.findUnique({
      where: { token: tokenHash },
    });

    if (!registro) {
      this.logger.warn('resetearPassword: token no encontrado');
      return { message };
    }
    if (registro.usedAt) {
      this.logger.warn(
        `resetearPassword: token ya usado (usuario ${registro.usuarioId})`,
      );
      return { message };
    }
    if (registro.expiresAt.getTime() < Date.now()) {
      this.logger.warn(
        `resetearPassword: token expirado (usuario ${registro.usuarioId})`,
      );
      return { message };
    }

    const hashedNew = await bcrypt.hash(dto.newPassword, 10);

    // Marcar token como usado + cambiar password en una transacción.
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: registro.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.usuario.update({
        where: { id: registro.usuarioId },
        data: { password: hashedNew },
      }),
    ]);

    this.logger.log(
      `Contraseña restablecida para usuario ${registro.usuarioId}`,
    );

    return { message };
  }
}
