import { Controller, Post, Body, Get, UseGuards, HttpCode, HttpStatus, BadRequestException, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
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

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar nuevo usuario' })
  async register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión' })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refrescar token de acceso' })
  async refreshToken(@Body() dto: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.authService.refreshToken(dto);
  }

  @Public()
  @Post('kiosk-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Intercambia un kiosk token por sesión completa (usado tras escanear QR)',
  })
  async kioskLogin(@Body() dto: KioskLoginDto): Promise<AuthResponseDto> {
    return this.authService.loginByKioskToken(dto);
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
    @CurrentUser('tiendaId') tiendaId: number | null,
  ) {
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
  ) {
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
