import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import ms, { type StringValue } from 'ms';

import { randomHex } from '../../../common/crypto/token-hash.util';
import type { PlayerJwtPayload } from '../interfaces/player-jwt-payload.interface';

export interface GeneratedPlayerToken {
  token: string;
  expiresAt: Date;
}

@Injectable()
export class PlayerTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async access(payload: PlayerJwtPayload): Promise<GeneratedPlayerToken> {
    const expiresIn = this.config.getOrThrow<StringValue>(
      'playerAuth.accessExpiresIn',
    );
    const token = await this.jwt.signAsync(
      { ...payload, jti: randomHex(16) },
      {
        secret: this.config.getOrThrow<string>('playerAuth.accessSecret'),
        expiresIn,
        audience: 'bj-spades-player',
        issuer: 'bj-spades-api',
      },
    );

    return { token, expiresAt: new Date(Date.now() + ms(expiresIn)) };
  }

  async refresh(payload: PlayerJwtPayload): Promise<GeneratedPlayerToken> {
    const expiresIn = this.config.getOrThrow<StringValue>(
      'playerAuth.refreshExpiresIn',
    );
    const token = await this.jwt.signAsync(
      { ...payload, jti: randomHex(16) },
      {
        secret: this.config.getOrThrow<string>('playerAuth.refreshSecret'),
        expiresIn,
        audience: 'bj-spades-player-refresh',
        issuer: 'bj-spades-api',
      },
    );

    return { token, expiresAt: new Date(Date.now() + ms(expiresIn)) };
  }

  verifyRefresh(token: string): Promise<PlayerJwtPayload> {
    return this.jwt.verifyAsync<PlayerJwtPayload>(token, {
      secret: this.config.getOrThrow<string>('playerAuth.refreshSecret'),
      audience: 'bj-spades-player-refresh',
      issuer: 'bj-spades-api',
    });
  }
}
