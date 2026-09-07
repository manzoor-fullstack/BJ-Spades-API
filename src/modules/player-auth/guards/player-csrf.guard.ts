import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { PLAYER_CSRF_COOKIE, readCookie } from '../player-cookies';
import { PlayerOriginGuard } from './player-origin.guard';

@Injectable()
export class PlayerCsrfGuard implements CanActivate {
  constructor(private readonly origin: PlayerOriginGuard) {}

  canActivate(context: ExecutionContext): boolean {
    this.origin.canActivate(context);
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;

    const cookie = readCookie(request, PLAYER_CSRF_COOKIE);
    const header = request.get('x-csrf-token');

    if (!cookie || !header) {
      throw new ForbiddenException('CSRF validation failed.');
    }

    const cookieBytes = Buffer.from(cookie);
    const headerBytes = Buffer.from(header);
    if (
      cookieBytes.length !== headerBytes.length ||
      !timingSafeEqual(cookieBytes, headerBytes)
    ) {
      throw new ForbiddenException('CSRF validation failed.');
    }

    return true;
  }
}
