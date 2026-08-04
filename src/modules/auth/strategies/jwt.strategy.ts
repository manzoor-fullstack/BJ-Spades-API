import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AuthenticatedAdmin } from '../interfaces/authenticated-admin.interface';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { AuthRepository } from '../repositories/auth.repository';

/** Identical message for every rejection, so nothing is leaked by which one fires. */
const SESSION_ENDED = 'Your session has ended. Please sign in again.';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly authRepository: AuthRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('jwt.accessSecret'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedAdmin> {
    // Tokens minted before the session rework carry no `sid`. Rejecting them
    // rather than defaulting keeps logout and refresh from acting on the wrong
    // session.
    if (!payload.sid) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    // One query resolves session, admin, and role together. The previous
    // implementation already made a round trip per request, so this is not a
    // new cost — but it does make revocation take effect immediately.
    const session = await this.authRepository.findSessionWithAdmin(payload.sid);

    if (!session || !session.isActive || session.revokedAt) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    // The token could belong to a different admin than the session if either
    // was tampered with.
    if (session.adminId !== payload.sub) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    if (!session.admin.isActive) {
      throw new UnauthorizedException('Your account has been deactivated.');
    }

    return {
      id: session.admin.id,
      email: session.admin.email,
      role: session.admin.role.name,
      roleId: session.admin.role.id,
      sessionId: session.id,
    };
  }
}
