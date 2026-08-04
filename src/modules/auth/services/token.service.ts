import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import ms, { StringValue } from 'ms';

import { randomHex } from '../../../common/crypto/token-hash.util';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { GeneratedToken } from '../interfaces/token-pair.interface';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async generateAccessToken(payload: JwtPayload): Promise<string> {
    return this.jwtService.signAsync(
      { ...payload, jti: randomHex(16) },
      {
        secret: this.configService.getOrThrow<StringValue>('jwt.accessSecret'),
        expiresIn: this.configService.getOrThrow<StringValue>(
          'jwt.accessExpiresIn',
        ),
      },
    );
  }

  /**
   * Every refresh token carries a unique `jti`.
   *
   * Without it, signing the same payload twice within the same second produces
   * a byte-identical JWT — `iat` has one-second resolution — so its SHA-256
   * collides with the row already stored and rotation fails on the unique
   * constraint. The nonce guarantees each issued token is distinct.
   */
  async generateRefreshToken(payload: JwtPayload): Promise<GeneratedToken> {
    const expiresIn = this.configService.getOrThrow<StringValue>(
      'jwt.refreshExpiresIn',
    );

    const token = await this.jwtService.signAsync(
      { ...payload, jti: randomHex(16) },
      {
        secret: this.configService.getOrThrow<StringValue>('jwt.refreshSecret'),
        expiresIn,
      },
    );

    return {
      token,
      expiresAt: new Date(Date.now() + ms(expiresIn)),
    };
  }

  async verifyAccessToken(token: string): Promise<JwtPayload> {
    return this.jwtService.verifyAsync<JwtPayload>(token, {
      secret: this.configService.getOrThrow<StringValue>('jwt.accessSecret'),
    });
  }

  async verifyRefreshToken(token: string): Promise<JwtPayload> {
    return this.jwtService.verifyAsync<JwtPayload>(token, {
      secret: this.configService.getOrThrow<StringValue>('jwt.refreshSecret'),
    });
  }
}
