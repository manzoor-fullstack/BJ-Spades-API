import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedPlayer } from '../interfaces/player-jwt-payload.interface';

export const CurrentPlayer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPlayer =>
    context.switchToHttp().getRequest<{ user: AuthenticatedPlayer }>().user,
);
