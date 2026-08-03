import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

import { AuthRepository } from '../repositories/auth.repository';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

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

  async validate(payload: JwtPayload) {
    const admin = await this.authRepository.findAdminById(payload.sub);

    if (!admin) {
      throw new UnauthorizedException('Admin not found.');
    }

    if (!admin.isActive) {
      throw new UnauthorizedException('Account is inactive.');
    }

    return {
      id: admin.id,
      email: admin.email,
      role: admin.role.name,
      roleId: admin.role.id,
    };
  }
}
