import { Controller, Post, Body, Get, UseGuards, HttpCode, HttpStatus, BadRequestException, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { KioskLoginDto } from './dto/kiosk-login.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { UpdateUserDto, ChangePasswordDto } from './dto/update-user.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import {
  RolUsuario,
} from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('Autenticación')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  /** Nombre de la cookie httpOnly que guarda el refresh token. */
  private readonly REFRESH_COOKIE = 'refresh_token';

  /**
   * Setea el refresh token en una cookie httpOnly+Secure. El frontend nunca
   * lo ve ni lo persiste en localStorage (cierra el vector XSS). El access
   * token sigue viajando en el body/header (lo necesita axios).
   */
  private setRefreshCookie(res: Response, refreshToken: string): void {
    const secure = process.env.NODE_ENV === 'production';
    res.cookie(this.REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7d, igual que el refresh JWT
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(this.REFRESH_COOKIE, { path: '/' });
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar nuevo usuario' })
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response): Promise<AuthResponseDto> {
    const result = await this.authService.register(dto);
    this.setRefreshCookie(res, result.refreshToken);
    return result;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response): Promise<AuthResponseDto> {
    const result = await this.authService.login(dto);
    this.setRefreshCookie(res, result.refreshToken);
    return result;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refrescar token de acceso' })
  async refreshToken(
    @Body() dto: RefreshTokenDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const ip = (req?.ip as string | undefined) ?? req?.socket?.remoteAddress;
    // El refresh token viaja en la cookie httpOnly (no en el body). Si el
    // cliente lo manda en el body (legado), lo aceptamos como fallback.
    const refreshToken = req?.cookies?.[this.REFRESH_COOKIE] ?? dto.refreshToken;
    const result = await this.authService.refreshToken({ refreshToken }, ip);
    this.setRefreshCookie(res, result.refreshToken);
    return result;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('kiosk-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Intercambia un kiosk token por sesión completa (usado tras escanear QR)',
  })
  async kioskLogin(@Body() dto: KioskLoginDto, @Res({ passthrough: true }) res: Response): Promise<AuthResponseDto> {
    const result = await this.authService.loginByKioskToken(dto);
    this.setRefreshCookie(res, result.refreshToken);
    return result;
  }

  @Get('kiosk-token')
  @UseGuards(JwtAuthGuard)
  @Roles(RolUsuario.CLIENTE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Genera un kiosk token (QR) de corta duración para el cliente actual',
    description:
      'SOLO clientes pueden generar su propio kiosk token. ' +
      'ADMIN queda excluido por seguridad: si ADMIN genera un token y ' +
      'lo expone (pantalla compartida, screenshot), cualquier cliente ' +
      'que escanee ese QR se loguea como ADMIN con todos sus privilegios.',
  })
  async getKioskToken(
    @CurrentUser('userId') userId: number,
    @CurrentUser('tiendaId') jwtTiendaId: number | null,
    @Req() req: Request,
  ) {
    // La tienda activa del cliente viaja en el header X-Tienda-Id (el interceptor
    // axios del frontend la manda con la tienda que el cliente tiene seleccionada
    // en el navbar). El JWT puede traer tiendaId null si el cliente se logueó sin
    // elegir tienda, así que damos prioridad al header. Esto mantiene el QR atado
    // a la tienda que el cliente está viendo.
    const header = req.headers['x-tienda-id'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const headerTiendaId = Number(headerValue);
    const tiendaId =
      Number.isInteger(headerTiendaId) && headerTiendaId > 0
        ? headerTiendaId
        : jwtTiendaId;

    if (!tiendaId) {
      throw new BadRequestException(
        'Necesitas tener una tienda seleccionada para generar el código QR. Elige una tienda en el catálogo primero.',
      );
    }
    return this.authService.getKioskToken(userId, tiendaId);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @Roles(
    RolUsuario.CLIENTE,
    RolUsuario.BODEGA,
    RolUsuario.BODEGA_MONITOR,
    RolUsuario.CAJERO,
    RolUsuario.ADMIN,
  )
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cerrar sesión' })
  async logout(
    @CurrentUser('userId') userId: number,
    @CurrentUser('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.clearRefreshCookie(res);
    return this.authService.logout(userId, token);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @Roles(
    RolUsuario.CLIENTE,
    RolUsuario.BODEGA,
    RolUsuario.BODEGA_MONITOR,
    RolUsuario.CAJERO,
    RolUsuario.ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Obtener perfil del usuario actual' })
  async getProfile(@CurrentUser('userId') userId: number) {
    return this.authService.getProfile(userId);
  }

  @Post('update-profile')
  @UseGuards(JwtAuthGuard)
  @Roles(
    RolUsuario.CLIENTE,
    RolUsuario.BODEGA,
    RolUsuario.BODEGA_MONITOR,
    RolUsuario.CAJERO,
    RolUsuario.ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Actualizar perfil del usuario' })
  async updateProfile(
    @CurrentUser('userId') userId: number,
    @Body() dto: UpdateUserDto,
  ) {
    return this.authService.updateProfile(userId, dto);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @Roles(
    RolUsuario.CLIENTE,
    RolUsuario.BODEGA,
    RolUsuario.BODEGA_MONITOR,
    RolUsuario.CAJERO,
    RolUsuario.ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cambiar contraseña del usuario' })
  async changePassword(
    @CurrentUser('userId') userId: number,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(userId, dto);
  }

  // F7 (jul 2026): heartbeat del operador. Ping cada 5 min desde la tablet
  // para que el monitor sepa que el bodeguero/cajero/mostrador está en su
  // estación AHORA, no sólo que se logueó en las últimas 12h. No permite
  // CLIENTE porque no tiene sentido (no aparece en el monitor).
  @Post('heartbeat')
  @UseGuards(JwtAuthGuard)
  @Roles(
    RolUsuario.BODEGA,
    RolUsuario.BODEGA_MONITOR,
    RolUsuario.CAJERO,
    RolUsuario.MOSTRADOR,
    RolUsuario.ADMIN,
  )
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Heartbeat del operador (cada 5min desde la tablet). Actualiza ultimoHeartbeat.',
  })
  async heartbeat(@CurrentUser('userId') userId: number) {
    return this.authService.heartbeat(userId);
  }

  // =====================================================
  // PASSWORD RESET (F8 jul 2026)
  // =====================================================

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Solicitar email para restablecer contraseña. Siempre devuelve 200 (no filtra si el email existe).',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: any) {
    const ip = (req?.ip as string | undefined) ?? req?.socket?.remoteAddress;
    return this.authService.solicitarResetPassword(dto, ip);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Restablecer contraseña con el token recibido por email. Siempre devuelve 200 (defensa contra enumeración).',
  })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetearPassword(dto);
  }
}
