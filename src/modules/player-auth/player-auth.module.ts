import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import {
  PlayerAuthController,
  PlayerSessionController,
} from './player-auth.controller';
import { PlayerAuthService } from './player-auth.service';
import { PlayerCsrfGuard } from './guards/player-csrf.guard';
import { PlayerJwtGuard } from './guards/player-jwt.guard';
import { PlayerOriginGuard } from './guards/player-origin.guard';
import { PlayerAuthRepository } from './repositories/player-auth.repository';
import { PlayerEmailService } from './services/player-email.service';
import {
  HttpPlayerOAuthGateway,
  PLAYER_OAUTH_GATEWAY,
} from './services/player-oauth.gateway';
import { PlayerTokenService } from './services/player-token.service';
import { PlayerJwtStrategy } from './strategies/player-jwt.strategy';

@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [PlayerAuthController, PlayerSessionController],
  providers: [
    PlayerAuthService,
    PlayerAuthRepository,
    PlayerEmailService,
    HttpPlayerOAuthGateway,
    {
      provide: PLAYER_OAUTH_GATEWAY,
      useExisting: HttpPlayerOAuthGateway,
    },
    PlayerTokenService,
    PlayerJwtStrategy,
    PlayerJwtGuard,
    PlayerOriginGuard,
    PlayerCsrfGuard,
  ],
  exports: [PlayerAuthService],
})
export class PlayerAuthModule {}
