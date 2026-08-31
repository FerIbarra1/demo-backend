import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        // Mismo valor validado que main.ts (app.jwtSecret). Sin fallback:
        // si falta, el arranque aborta en main.ts.
        const secret = configService.get<string>('app.jwtSecret');
        const expiresIn = configService.get<string>('app.jwtExpiresIn') || '1h';
        return {
          secret,
          signOptions: { expiresIn: expiresIn as any },
        };
      },
      inject: [ConfigService],
    }),
    MailModule,
  ],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
  // Exportamos JwtModule para que otros módulos (ej. CatalogoModule)
  // puedan inyectar JwtService sin duplicar la configuración del secret.
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
