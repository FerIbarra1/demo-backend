import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Req,
  Res,
} from '@nestjs/common';
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
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthResponse } from '../../types/user.types';

@ApiTags('Autenticación')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  /** Nombre de la cookie httpOnly que guarda el refresh token. */
  private readonly REFRESH_COOKIE = 'refresh_token';

  /**
   * Atributos de la cookie del refresh token. UNA sola definición para escribirla y para borrarla: si difieren
   * (`path`, `sameSite`, `secure`), el navegador no reconoce la cookie a borrar y la sesión queda "pegada".
   *
   * `SameSite=None` solo cuando el frontend y la API viven en SITIOS distintos (p. ej. `*.vercel.app` → API propia):
   * es la única forma de que viaje en un XHR cross-site, pero Safari y Chrome la bloquean como cookie de terceros.
   * Lo correcto en producción es servir front y API bajo el MISMO dominio registrable (`app.` y `api.`), donde `Lax`
   * funciona y es más seguro. Mientras tanto se respeta lo que había: `None` en producción, `Lax` en desarrollo.
   */
  private opcionesCookie() {
    const isProd = process.env.NODE_ENV === 'production';
    return {
      httpOnly: true,
      secure: isProd,
      sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
      path: '/',
    };
  }

  /**
   * Setea el refresh token en una cookie httpOnly+Secure. El frontend nunca lo ve ni lo persiste en localStorage
   * (cierra el vector XSS). El access token sigue viajando en el body/header (lo necesita axios).
   */
  private setRefreshCookie(res: Response, refreshToken: string): void {
    res.cookie(this.REFRESH_COOKIE, refreshToken, {
      ...this.opcionesCookie(),
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7d, igual que el refresh JWT
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(this.REFRESH_COOKIE, this.opcionesCookie());
  }

  /**
   * Lo que sale en el CUERPO: nunca el refresh token. Antes `login`, `register`, `refresh` y `kiosk-login` lo
   * devolvían también en el JSON, y eso anulaba el sentido de la cookie httpOnly: cualquier script (XSS) podía llamar
   * a `POST /auth/refresh` y LEER el token de la respuesta. El navegador lo recibe solo en la cookie.
   */
  private publica(r: AuthResponse): AuthResponseDto {
    return { accessToken: r.accessToken, expiresIn: r.expiresIn, user: r.user };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar nuevo usuario' })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.authService.register(dto);
    this.setRefreshCookie(res, result.refreshToken);
    return this.publica(result);
  }

  // 20/min por IP: una tienda comparte IP pública y varios empleados abren turno a la vez (con 5, el sexto quedaba
  // fuera). El freno contra adivinar contraseñas es POR CUENTA (`AuthService.login`), no por IP.
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.authService.login(dto);
    this.setRefreshCookie(res, result.refreshToken);
    return this.publica(result);
  }

  // 30/min por IP: cada dispositivo refresca al volver a la pestaña o tras una hora de reposo, y toda una tienda
  // vuelve de la comida a la vez. El token es aleatorio y de un solo uso, así que el tope solo cuida la carga.
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
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
    return this.publica(result);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('kiosk-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Intercambia un kiosk token por sesión completa (usado tras escanear QR)',
  })
  async kioskLogin(
    @Body() dto: KioskLoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.authService.loginByKioskToken(dto);
    this.setRefreshCookie(res, result.refreshToken);
    return this.publica(result);
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
      Number.isInteger(headerTiendaId) && headerTiendaId > 0 ? headerTiendaId : jwtTiendaId;

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
    RolUsuario.MOSTRADOR,
    // F16 (sep 2026): la TV del mostrador también necesita cerrar sesión y
    // consultar su perfil. Faltaba, así que el logout devolvía 403 y el
    // refresh token httpOnly quedaba vivo server-side (el frontend traga el
    // error con .catch, así que el usuario no se enteraba).
    RolUsuario.MOSTRADOR_MONITOR,
    RolUsuario.CAJERO_MONITOR,
    RolUsuario.VENTAS,
    // Oct 2026: Tesorería también inicia/cierra sesión, ve su perfil y cambia su contraseña.
    RolUsuario.TESORERIA,
    RolUsuario.IMPRESION,
    // Oct 2026: el gerente también inicia/cierra sesión, ve su perfil, cambia su contraseña y manda latido.
    RolUsuario.GERENTE,
    RolUsuario.ADMIN,
  )
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cerrar sesión' })
  async logout(
    @CurrentUser('userId') userId: number,
    @CurrentUser('token') token: string,
    @CurrentUser('rol') rol: RolUsuario,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Cierra la sesión de ESTE dispositivo (la familia del refresh token de la cookie), no la de todos.
    const refreshToken = (req.cookies as Record<string, string> | undefined)?.[this.REFRESH_COOKIE];
    this.clearRefreshCookie(res);
    return this.authService.logout(userId, token, rol, refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @Roles(
    RolUsuario.CLIENTE,
    RolUsuario.BODEGA,
    RolUsuario.BODEGA_MONITOR,
    RolUsuario.CAJERO,
    RolUsuario.MOSTRADOR,
    // F16 (sep 2026): la TV del mostrador también necesita cerrar sesión y
    // consultar su perfil. Faltaba, así que el logout devolvía 403 y el
    // refresh token httpOnly quedaba vivo server-side (el frontend traga el
    // error con .catch, así que el usuario no se enteraba).
    RolUsuario.MOSTRADOR_MONITOR,
    RolUsuario.CAJERO_MONITOR,
    RolUsuario.VENTAS,
    // Oct 2026: Tesorería también inicia/cierra sesión, ve su perfil y cambia su contraseña.
    RolUsuario.TESORERIA,
    RolUsuario.IMPRESION,
    // Oct 2026: el gerente también inicia/cierra sesión, ve su perfil, cambia su contraseña y manda latido.
    RolUsuario.GERENTE,
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
    RolUsuario.MOSTRADOR,
    // F16 (sep 2026): la TV del mostrador también necesita cerrar sesión y
    // consultar su perfil. Faltaba, así que el logout devolvía 403 y el
    // refresh token httpOnly quedaba vivo server-side (el frontend traga el
    // error con .catch, así que el usuario no se enteraba).
    RolUsuario.MOSTRADOR_MONITOR,
    RolUsuario.CAJERO_MONITOR,
    RolUsuario.VENTAS,
    // Oct 2026: Tesorería también inicia/cierra sesión, ve su perfil y cambia su contraseña.
    RolUsuario.TESORERIA,
    RolUsuario.IMPRESION,
    // Oct 2026: el gerente también inicia/cierra sesión, ve su perfil, cambia su contraseña y manda latido.
    RolUsuario.GERENTE,
    RolUsuario.ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Actualizar perfil del usuario' })
  async updateProfile(@CurrentUser('userId') userId: number, @Body() dto: UpdateUserDto) {
    return this.authService.updateProfile(userId, dto);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @Roles(
    RolUsuario.CLIENTE,
    RolUsuario.BODEGA,
    RolUsuario.BODEGA_MONITOR,
    RolUsuario.CAJERO,
    RolUsuario.MOSTRADOR,
    // F16 (sep 2026): la TV del mostrador también necesita cerrar sesión y
    // consultar su perfil. Faltaba, así que el logout devolvía 403 y el
    // refresh token httpOnly quedaba vivo server-side (el frontend traga el
    // error con .catch, así que el usuario no se enteraba).
    RolUsuario.MOSTRADOR_MONITOR,
    RolUsuario.CAJERO_MONITOR,
    RolUsuario.VENTAS,
    // Oct 2026: Tesorería también inicia/cierra sesión, ve su perfil y cambia su contraseña.
    RolUsuario.TESORERIA,
    RolUsuario.IMPRESION,
    // Oct 2026: el gerente también inicia/cierra sesión, ve su perfil, cambia su contraseña y manda latido.
    RolUsuario.GERENTE,
    RolUsuario.ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cambiar contraseña del usuario' })
  async changePassword(
    @CurrentUser('userId') userId: number,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    // Cierra las demás sesiones y conserva la de este dispositivo (la familia de la cookie).
    const refreshToken = (req.cookies as Record<string, string> | undefined)?.[this.REFRESH_COOKIE];
    return this.authService.changePassword(userId, dto, refreshToken);
  }

  // F7 (jul 2026): heartbeat del operador. Ping cada 5 min desde la tablet
  // para que el monitor sepa que el bodeguero/cajero/mostrador está en su
  // estación AHORA, no solo que se logueó en las últimas 12h. No permite
  // CLIENTE porque no tiene sentido (no aparece en el monitor).
  @Post('heartbeat')
  @UseGuards(JwtAuthGuard)
  @Roles(
    RolUsuario.BODEGA,
    RolUsuario.BODEGA_MONITOR,
    RolUsuario.CAJERO,
    RolUsuario.MOSTRADOR,
    // F16: el rol de la TV. No aparece en el monitor de bodega (no tiene
    // slots), pero sin él el heartbeat devolvía 403.
    RolUsuario.MOSTRADOR_MONITOR,
    // Oct 2026: faltaba (lo destapó `roles-contrato.spec`): la TV del cajero también monta el
    // `RolShell`, que manda el latido; sin este rol recibía 403 en silencio cada 5 minutos.
    RolUsuario.CAJERO_MONITOR,
    RolUsuario.VENTAS,
    RolUsuario.TESORERIA,
    RolUsuario.IMPRESION,
    // Oct 2026: el gerente también inicia/cierra sesión, ve su perfil, cambia su contraseña y manda latido.
    RolUsuario.GERENTE,
    RolUsuario.ADMIN,
  )
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Heartbeat del operador (cada 5min desde la tablet). Actualiza ultimoHeartbeat.',
  })
  async heartbeat(@CurrentUser('userId') userId: number, @CurrentUser('rol') rol: RolUsuario) {
    return this.authService.heartbeat(userId, rol);
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
