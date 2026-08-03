import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TokenService } from './services/token.service';
import { AuthRepository } from './repositories/auth.repository';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    ConfigModule,

    PassportModule,

    JwtModule.registerAsync({
      inject: [ConfigService],

      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),

        signOptions: {
          expiresIn: config.get<number>('jwt.accessExpiresIn'),
        },
      }),
    }),
  ],

  controllers: [AuthController],

  providers: [AuthService, TokenService, AuthRepository, JwtStrategy],

  exports: [TokenService],
})
export class AuthModule {}
