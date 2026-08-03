import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import ms, { StringValue } from 'ms';

import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { GeneratedToken } from '../interfaces/token-pair.interface';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async generateAccessToken(
    payload: JwtPayload,
  ): Promise<string> {
    return this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<StringValue>(
        'jwt.accessSecret',
      ),
      expiresIn: this.configService.getOrThrow<StringValue>(
        'jwt.accessExpiresIn',
      ),
    });
  }

  async generateRefreshToken(
    payload: JwtPayload,
  ): Promise<GeneratedToken> {
    const expiresIn = this.configService.getOrThrow<StringValue>(
      'jwt.refreshExpiresIn',
    );

    const token = await this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<StringValue>(
        'jwt.refreshSecret',
      ),
      expiresIn,
    });

    return {
      token,
      expiresAt: new Date(Date.now() + ms(expiresIn)),
    };
  }

  async verifyAccessToken(
    token: string,
  ): Promise<JwtPayload> {
    return this.jwtService.verifyAsync<JwtPayload>(token, {
      secret: this.configService.getOrThrow<StringValue>(
        'jwt.accessSecret',
      ),
    });
  }

  async verifyRefreshToken(
    token: string,
  ): Promise<JwtPayload> {
    return this.jwtService.verifyAsync<JwtPayload>(token, {
      secret: this.configService.getOrThrow<StringValue>(
        'jwt.refreshSecret',
      ),
    });
  }
}