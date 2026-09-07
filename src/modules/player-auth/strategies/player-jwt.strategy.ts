import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { UserStatus } from '@prisma/client';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';

import type {
  AuthenticatedPlayer,
  PlayerJwtPayload,
} from '../interfaces/player-jwt-payload.interface';
import { PLAYER_ACCESS_COOKIE, readCookie } from '../player-cookies';
import { PlayerAuthRepository } from '../repositories/player-auth.repository';

const SESSION_ENDED = 'Your session has ended. Please sign in again.';

@Injectable()
export class PlayerJwtStrategy extends PassportStrategy(
  Strategy,
  'player-jwt',
) {
  constructor(
    config: ConfigService,
    private readonly repository: PlayerAuthRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request) => readCookie(request, PLAYER_ACCESS_COOKIE) ?? null,
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('playerAuth.accessSecret'),
      audience: 'bj-spades-player',
      issuer: 'bj-spades-api',
    });
  }

  async validate(payload: PlayerJwtPayload): Promise<AuthenticatedPlayer> {
    if (payload.type !== 'player' || !payload.sid) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    const session = await this.repository.findSession(payload.sid);
    if (
      !session ||
      !session.isActive ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.userId !== payload.sub ||
      session.user.status !== UserStatus.ACTIVE ||
      session.user.deletedAt ||
      !session.user.emailVerified ||
      !session.user.credential
    ) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    return {
      id: session.user.id,
      sessionId: session.id,
      email: session.user.email,
      username: session.user.credential.username,
    };
  }
}
