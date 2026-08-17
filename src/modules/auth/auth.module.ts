import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { StorageModule } from '../storage/storage.module';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PermissionsGuard } from './guards/permissions.guard';
import { AuthRepository } from './repositories/auth.repository';
import { TokenService } from './services/token.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    ConfigModule,

    PassportModule,

    // Avatar uploads on PATCH /auth/me. Nothing here names a concrete storage
    // backend — see ADR-003.
    StorageModule,

    // Secrets and expiry are passed explicitly per call in TokenService,
    // because access and refresh tokens are signed with different keys.
    // Registering without options avoids implying a single shared secret.
    JwtModule.register({}),
  ],

  controllers: [AuthController],

  providers: [
    AuthService,
    TokenService,
    AuthRepository,
    JwtStrategy,
    PermissionsGuard,
  ],

  // PermissionsGuard is exported rather than instantiated by APP_GUARD so the
  // global guard and anything calling invalidate() share one cache.
  exports: [TokenService, AuthRepository, PermissionsGuard],
})
export class AuthModule {}
