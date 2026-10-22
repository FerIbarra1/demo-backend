import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { KioskLoginDto } from './dto/kiosk-login.dto';
import { UpdateUserDto, ChangePasswordDto } from './dto/update-user.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';
import { Prisma, RolUsuario, TipoNotificacion, Usuario } from '@prisma/client';
import { AuthResponse, JwtPayload, KioskTokenPayload } from '../../types/user.types';
import { MailService } from '../mail/mail.service';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import { mailTemplates, mailSubjects } from '../mail/mail.templates';
import { CuentaDesactivadaException } from './exceptions/cuenta-desactivada.exception';
import { BodegaPresenciaService } from '../estaciones/bodega-presencia.service';
import { LoginBloqueoService } from './login-bloqueo.service';

/**
 * Ventana en la que un refresh token YA ROTADO se tolera una vez más. Dos pestañas (o un reintento de red, o un
 * doble `useEffect`) pueden presentar el mismo token con milisegundos de diferencia: la primera lo rota y la segunda
 * llega con un token "ya usado". Sin gracia, eso se leía como ROBO y se revocaba la familia entera (la persona
 * perdía la sesión sin haber hecho nada). Pasada la ventana, reutilizar un token rotado sí es señal de robo.
 * Solo aplica a tokens rotados, NUNCA a los revocados por logout o por familia (ver `refreshToken`).
 */
const GRACIA_REFRESH_MS = 10_000;

/**
 * Hash bcrypt (coste 10, el de las cuentas reales) de un texto aleatorio que se descartó al generarlo: no hay
 * contraseña que lo abra. Sirve para que el login de un correo que NO existe pague el mismo `bcrypt.compare` que el de
 * uno que sí: sin él, "no existe" respondía en ~1 ms y "existe" en ~60 ms, y el tiempo decía qué correos tienen cuenta.
 */
const HASH_SENUELO = '$2b$10$SwsIM.q/0eoPVBFWWrhY6.iIcdX6OU3jLXcXVLP3zWxWZgZ0VwqWO';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mail: MailService,
    private readonly configuracion: ConfiguracionService,
    private readonly bodegaPresencia: BodegaPresenciaService,
    private readonly bloqueo: LoginBloqueoService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const existingUser = await this.prisma.usuario.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException(
        'Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.',
      );
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
    const logoUrl = await this.configuracion.obtenerLogoUrl();
    const frontendUrl = this.configService.get<string>('app.mail.frontendUrl') ?? '';

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
    // Antes de tocar la BD ni gastar un bcrypt: una cuenta bloqueada no distingue contraseñas buenas de malas.
    if (this.bloqueo.bloqueado(dto.email)) {
      const espera = this.bloqueo.segundosParaLiberar(dto.email);
      const minutos = Math.max(1, Math.ceil(espera / 60));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Demasiados intentos fallidos. Vuelve a intentarlo en ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}.`,
          error: 'Too Many Requests',
          reintentarEnSegundos: espera,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // El intento se ANOTA ya, antes de esperar a la BD y a bcrypt, y se da por fallido hasta que se demuestre lo
    // contrario. Sin esto, 50 peticiones simultáneas pasaban TODAS el chequeo de arriba (nadie había anotado todavía)
    // y daban 50 adivinanzas antes de que el bloqueo entrara. El chequeo y la anotación van seguidos, sin `await`.
    this.bloqueo.registrarIntento(dto.email);

    let usuario: Usuario | null;
    let isPasswordValid: boolean;
    try {
      usuario = await this.prisma.usuario.findUnique({ where: { email: dto.email } });
      // El `compare` corre SIEMPRE, exista o no el correo (ver `HASH_SENUELO`).
      isPasswordValid = await bcrypt.compare(dto.password, usuario?.password ?? HASH_SENUELO);
    } catch (err) {
      this.bloqueo.deshacerIntento(dto.email); // un fallo de la BD no es una contraseña equivocada
      throw err;
    }
    if (!usuario || !isPasswordValid) throw new UnauthorizedException('Credenciales inválidas');
    this.bloqueo.limpiar(dto.email);

    // El estado de la cuenta solo se revela a quien YA demostró que la contraseña es suya. Antes se comprobaba
    // primero y cualquiera podía preguntar "¿existe y está desactivada?" sin conocer nada de la cuenta, pese al
    // comentario que decía lo contrario. El frontend detecta `codigo` para mostrar "contacta a soporte".
    // `deletedAt` además de `activo`: `eliminar()` marca los dos, pero la baja no debe depender de que alguien
    // recuerde apagar el otro (mismo criterio que `JwtStrategy`).
    if (!usuario.activo || usuario.deletedAt !== null) throw new CuentaDesactivadaException();

    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: { lastLogin: new Date() },
    });
    await this.marcarEntrada(usuario);

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

  async refreshToken(dto: RefreshTokenDto, ipOrigen?: string): Promise<AuthResponse> {
    const refreshToken = dto.refreshToken;
    if (!refreshToken) {
      throw new UnauthorizedException('Token de refresco inválido');
    }
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.configService.get<string>('app.jwtSecret'),
      });
    } catch {
      throw new UnauthorizedException('Token de refresco inválido');
    }

    if (!payload.jti) {
      // Token legado sin jti (emitido antes de F12): no es revocable. Lo
      // rechazamos para forzar re-login y migrar a la nueva cadena.
      throw new UnauthorizedException('Token de refresco inválido');
    }

    const tokenHash = this.hashToken(refreshToken);
    const registro = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    // Token no existe en BD (revocado, expirado o forjado).
    if (!registro) throw new UnauthorizedException('Token de refresco inválido');
    if (registro.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Token de refresco inválido');
    }

    // `deletedAt` además de `activo`, igual que `JwtStrategy`: la baja lógica no debe depender de que alguien
    // recuerde apagar los dos flags (antes un usuario dado de baja podía seguir renovando su sesión).
    const usuario = await this.prisma.usuario.findUnique({ where: { id: payload.sub } });
    if (!usuario || !usuario.activo || usuario.deletedAt !== null) {
      throw new UnauthorizedException('Token inválido');
    }

    // Rotación ATÓMICA. Antes: se leía `revokedAt`, se emitía el par nuevo y SOLO DESPUÉS se marcaba el token usado:
    // dos refresh simultáneos con el mismo token pasaban ambos la comprobación y emitían dos descendientes (la
    // familia se bifurcaba, y cualquier reutilización posterior ya no era detectable). Ahora el reclamo
    // (`updateMany … where revokedAt is null`) y la emisión del sucesor ocurren en UNA transacción: la petición que
    // llega segunda espera el candado de la fila y, al entrar, ya ve el token rotado Y su sucesor registrado.
    const rotado = await this.prisma.$transaction(async (tx) => {
      const reclamo = await tx.refreshToken.updateMany({
        where: { id: registro.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (reclamo.count === 0) return null;
      const nuevo = await this.generateTokens(usuario, {
        familyId: registro.familyId,
        ipOrigen,
        tx,
      });
      await tx.refreshToken.update({
        where: { id: registro.id },
        data: { replacedBy: nuevo.refreshTokenId },
      });
      return nuevo;
    });
    if (rotado) return rotado;

    // Perdió la carrera, o el token ya estaba revocado. Se relee para saber QUÉ pasó.
    const actual = await this.prisma.refreshToken.findUnique({ where: { id: registro.id } });
    const hace = actual?.revokedAt ? Date.now() - actual.revokedAt.getTime() : Infinity;
    if (actual && actual.replacedBy !== null && hace <= GRACIA_REFRESH_MS) {
      // Fue ROTADO hace instantes (la otra pestaña / el reintento): carrera legítima. Se emite otro sucesor de la
      // MISMA familia sin tocarla. Un token revocado por logout o por familia tiene `replacedBy` nulo y NO entra
      // aquí: sin esa distinción, un refresh en vuelo al cerrar sesión "resucitaría" la sesión recién cerrada.
      //
      // Pero el token presentado puede ser el VIEJO (T0, rotado a T1) y el logout haber cerrado a T1 DESPUÉS: T0 sigue
      // con `replacedBy` y dentro de los 10 s, y entraba por aquí a abrir una sesión nueva en una familia cerrada. En
      // una familia viva todo token está sin revocar o rotado (revocado + `replacedBy`); uno revocado SIN `replacedBy`
      // es un cierre deliberado (logout, `revocarFamilia`, cambio de contraseña): la familia no se reabre.
      const cerradaAPropósito = await this.prisma.refreshToken.count({
        where: { familyId: registro.familyId, revokedAt: { not: null }, replacedBy: null },
      });
      if (cerradaAPropósito === 0) {
        return this.generateTokens(usuario, { familyId: registro.familyId, ipOrigen });
      }
    }

    // Reutilización de un token ya rotado fuera de la ventana (o revocado a propósito) → posible robo. Se revoca
    // toda la familia para invalidar cualquier token derivado.
    await this.revocarFamilia(registro.familyId);
    throw new UnauthorizedException('Token de refresco inválido');
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
    const expiresIn = this.configService.get<string>('app.kioskTokenExpiresIn') || '5m';
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
        secret: this.configService.get<string>('app.jwtSecret'),
      });
    } catch {
      throw new UnauthorizedException('El código QR venció o no es válido. Genera uno nuevo.');
    }

    if (payload.kind !== 'kiosk') {
      throw new BadRequestException('Ese código no es de un kiosko.');
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
      await this.marcarEntrada(usuario);
    }

    this.logger.log(`Kiosk login: ${usuario.email} en tienda ${dto.tiendaId}`);

    return this.generateTokens(usuario);
  }

  /**
   * Oct 2026: entrar pone al bodeguero EN LÍNEA en la TV de bodega en el momento (antes aparecía
   * hasta el siguiente movimiento de otro pedido). Los demás roles no tienen presencia propia:
   * caja y mostrador la tienen en su estación.
   */
  private async marcarEntrada(usuario: Pick<Usuario, 'id' | 'rol' | 'tiendaId'>) {
    if (usuario.rol !== RolUsuario.BODEGA) return;
    await this.bodegaPresencia.entro(usuario.id, usuario.tiendaId);
  }

  /**
   * Cierra la sesión DE ESTE DISPOSITIVO: revoca la familia del refresh token que el navegador presenta (la cookie
   * httpOnly). Antes revocaba los refresh tokens de TODOS los dispositivos del usuario: cerrar sesión en la tablet
   * cerraba también el portátil y el teléfono. Sin cookie (o con una que no es suya) se cae al valor SEGURO: revocar
   * todos. El access token expira solo (1 h).
   */
  async logout(
    userId: number,
    _token: string,
    rol?: RolUsuario,
    refreshToken?: string,
  ): Promise<{ message: string }> {
    const familyId = refreshToken ? await this.familiaDe(refreshToken, userId) : null;
    await this.prisma.refreshToken.updateMany({
      where: familyId
        ? { usuarioId: userId, familyId, revokedAt: null }
        : { usuarioId: userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Oct 2026: un bodeguero que sale deja la TV y regresa a la cola lo que traía. Va DESPUÉS de
    // revocar los tokens (así un latido rezagado no lo revive) y nunca impide cerrar sesión: si
    // falla, el latido sigue guardado y el barrido de inactividad lo saca igual.
    // F3.5: el ADMIN que cubrió un puesto en bodega también devuelve a la cola lo que traía.
    //
    // Solo si no queda OTRA sesión viva: el cierre es por dispositivo, y un bodeguero que surte en la tablet B y
    // cierra el teléfono A no se fue; sacarlo devolvía a la cola, sin asignar, lo que sigue surtiendo en B.
    if (rol === RolUsuario.BODEGA || rol === RolUsuario.ADMIN) {
      await this.bodegaPresencia
        .haySesionViva(userId)
        .then((otra) => (otra ? undefined : this.bodegaPresencia.salio(userId)))
        .catch((err: Error) =>
          this.logger.error(`Salida de bodega falló (usuario ${userId}): ${err.message}`),
        );
    }
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

  /**
   * Cambia la contraseña y CIERRA las demás sesiones: quien tenía una sesión robada la conservaba (cada rotación renueva
   * 7 días) después de que la víctima cambiara su clave justo para sacarlo. Se conserva la de ESTE dispositivo (la
   * familia de la cookie): si no, quien cambia su clave en Configuración se encontraría sin sesión a la hora siguiente.
   * Sin cookie válida se cierran todas (valor seguro). El access token de los otros dispositivos vence solo (1 h).
   */
  async changePassword(
    userId: number,
    dto: ChangePasswordDto,
    refreshToken?: string,
  ): Promise<{ message: string }> {
    const usuario = await this.prisma.usuario.findUnique({ where: { id: userId } });
    if (!usuario) throw new UnauthorizedException('Usuario no encontrado');
    const ok = await bcrypt.compare(dto.oldPassword, usuario.password);
    // 400 y no 401: el usuario SÍ está autenticado; es un dato inválido. Con 401 el cliente lo leía como «token vencido»,
    // rotaba el refresh token y reintentaba antes de mostrar el mensaje (y con un fallo de red mostraba otro).
    if (!ok) throw new BadRequestException('La contraseña actual es incorrecta');
    await this.prisma.usuario.update({
      where: { id: userId },
      data: { password: await bcrypt.hash(dto.newPassword, 10) },
    });
    const esteDispositivo = refreshToken ? await this.familiaDe(refreshToken, userId) : null;
    await this.prisma.refreshToken.updateMany({
      where: {
        usuarioId: userId,
        revokedAt: null,
        ...(esteDispositivo ? { NOT: { familyId: esteDispositivo } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return { message: 'Contraseña actualizada exitosamente' };
  }

  private async generateTokens(
    usuario: Usuario,
    opts?: { familyId?: string; ipOrigen?: string; tx?: Prisma.TransactionClient },
  ): Promise<AuthResponse> {
    const expiresIn = this.configService.get<string>('app.jwtExpiresIn') || '1h';
    const refreshExpiresIn = this.configService.get<string>('app.jwtRefreshExpiresIn') || '7d';
    const refreshExpiresMs = this.segundosDeExpiración(refreshExpiresIn) * 1000;

    // Generar un refresh token con jti único y persistirlo en BD (hash).
    const jti = randomUUID();
    const refreshToken = this.jwtService.sign(
      {
        sub: usuario.id,
        email: usuario.email,
        rol: usuario.rol,
        tiendaId: usuario.tiendaId ?? undefined,
        jti,
      },
      { expiresIn: refreshExpiresIn as any },
    );
    const familyId = opts?.familyId ?? randomUUID();
    const creado = await (opts?.tx ?? this.prisma).refreshToken.create({
      data: {
        usuarioId: usuario.id,
        tokenHash: this.hashToken(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + refreshExpiresMs),
        ipOrigen: opts?.ipOrigen ?? null,
      },
    });

    const payload: JwtPayload = {
      sub: usuario.id,
      email: usuario.email,
      rol: usuario.rol,
      tiendaId: usuario.tiendaId ?? undefined,
    };
    return {
      accessToken: this.jwtService.sign(payload, { expiresIn: expiresIn as any }),
      refreshToken,
      // El frontend necesita el id del refresh token para poder revocarlo
      // explícitamente (logout) y para saber qué token rotar.
      refreshTokenId: creado.id,
      // Segundos de validez del access token, derivados de la misma config
      // que se usa para firmar (evita divergencia con el valor real).
      expiresIn: this.segundosDeExpiración(expiresIn),
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

  /** La familia de un refresh token SI es de este usuario; `null` en cualquier otro caso (no se revoca a ciegas). */
  private async familiaDe(refreshToken: string, userId: number): Promise<string | null> {
    const registro = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
      select: { familyId: true, usuarioId: true },
    });
    return registro && registro.usuarioId === userId ? registro.familyId : null;
  }

  /** SHA256 del token en claro. Se guarda el hash, no el token. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Revoca todos los tokens de una familia (detección de reutilización/robo). */
  private async revocarFamilia(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * F7 (jul 2026): heartbeat del operador. Solo actualiza `ultimoHeartbeat`
   * en la fila del Usuario autenticado. Es best-effort: si la fila no existe
   * (caso muy raro de token de un user ya borrado), se ignora silenciosamente
   * porque no queremos spamear logs ni mostrar errores al cliente en cada ping.
   */
  async heartbeat(
    userId: number,
    rol?: RolUsuario,
  ): Promise<{ userId: number; ultimoHeartbeat: string }> {
    const now = new Date();
    try {
      if (rol === RolUsuario.BODEGA) {
        // El bodeguero tiene presencia propia (la TV de bodega): ver `BodegaPresenciaService`.
        await this.bodegaPresencia.latido(userId, now);
      } else {
        await this.prisma.usuario.update({
          where: { id: userId },
          data: { ultimoHeartbeat: now },
          select: { id: true },
        });
      }
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
      this.logger.warn(`solicitarResetPassword para email no registrado o inactivo: ${dto.email}`);
      return { message };
    }

    // Generar token random (32 bytes → 64 chars hex). Guardamos el hash
    // SHA256 — si la BD se filtra, los tokens en claro no están expuestos.
    const tokenRandom = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(tokenRandom).digest('hex');
    const expiresMin = this.configService.get<number>('app.mail.passwordResetExpiresMin') ?? 60;
    const expiresAt = new Date(Date.now() + expiresMin * 60 * 1000);

    await this.prisma.passwordResetToken.create({
      data: {
        usuarioId: usuario.id,
        token: tokenHash,
        expiresAt,
        ipOrigen: ipOrigen ?? null,
      },
    });

    const logoUrl = await this.configuracion.obtenerLogoUrl();
    const frontendUrl = this.configService.get<string>('app.mail.frontendUrl') ?? '';
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
        .catch((err) => this.logger.error(`Falló email RESET_PASSWORD: ${err.message}`));
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
  async resetearPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
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
      this.logger.warn(`resetearPassword: token ya usado (usuario ${registro.usuarioId})`);
      return { message };
    }
    if (registro.expiresAt.getTime() < Date.now()) {
      this.logger.warn(`resetearPassword: token expirado (usuario ${registro.usuarioId})`);
      return { message };
    }

    const hashedNew = await bcrypt.hash(dto.newPassword, 10);

    // Marcar token como usado + cambiar password en una transacción.
    const [, actualizado] = await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: registro.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.usuario.update({
        where: { id: registro.usuarioId },
        data: { password: hashedNew },
      }),
      // Se restablece justo cuando se perdió el control de la cuenta: toda sesión abierta (la de un ladrón incluida)
      // se cierra. El usuario inicia sesión con la clave nueva.
      this.prisma.refreshToken.updateMany({
        where: { usuarioId: registro.usuarioId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    // Quien restablece su contraseña con el token del correo es el dueño: se libera el bloqueo por intentos fallidos.
    if (actualizado?.email) this.bloqueo.limpiar(actualizado.email);

    this.logger.log(`Contraseña restablecida para usuario ${registro.usuarioId}`);

    return { message };
  }

  /**
   * Convierte una expiración tipo '1h' / '7d' / '3600' a segundos, para
   * devolver al cliente el valor real de validez del access token.
   */
  private segundosDeExpiración(exp: string): number {
    const m = exp.trim().match(/^(\d+)([smhd])?$/);
    if (!m) return 3600;
    const n = parseInt(m[1], 10);
    switch (m[2]) {
      case 's':
        return n;
      case 'm':
        return n * 60;
      case 'h':
        return n * 3600;
      case 'd':
        return n * 86400;
      default:
        return n;
    }
  }
}
