import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

@Injectable()
export class PlayerOriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;

    const origin = request.get('origin');
    const allowed = new Set(
      this.config
        .getOrThrow<string>('playerAuth.allowedOrigins')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );

    if (!origin || !allowed.has(origin)) {
      throw new ForbiddenException('Request origin is not allowed.');
    }

    return true;
  }
}
