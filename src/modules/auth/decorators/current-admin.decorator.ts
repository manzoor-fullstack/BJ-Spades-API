import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { AuthenticatedAdmin } from '../interfaces/authenticated-admin.interface';
import { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';

/**
 * Injects the authenticated admin attached to the request by JwtStrategy.
 *
 * Only valid on routes behind the JwtAuthGuard — on a @Public() route there is
 * no `user` on the request.
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedAdmin => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();

    return request.user;
  },
);
