import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { GhlTokenGuard } from '../guards/ghl-token.guard';

const TOKEN = 'a4f1c9e2b7d84a6f91c3e5b8d0a2f4c6';

function contextWith(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(configured: string | undefined): GhlTokenGuard {
  const config = {
    get: jest.fn(() => configured),
  } as unknown as ConfigService;

  return new GhlTokenGuard(config);
}

describe('GhlTokenGuard', () => {
  it('admits a request carrying the configured token', () => {
    const guard = guardWith(TOKEN);

    expect(
      guard.canActivate(contextWith({ authorization: `Bearer ${TOKEN}` })),
    ).toBe(true);
  });

  it('rejects a wrong token', () => {
    const guard = guardWith(TOKEN);

    expect(() =>
      guard.canActivate(contextWith({ authorization: 'Bearer wrong-token' })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a missing Authorization header', () => {
    const guard = guardWith(TOKEN);

    expect(() => guard.canActivate(contextWith({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token sent without the Bearer scheme', () => {
    const guard = guardWith(TOKEN);

    expect(() =>
      guard.canActivate(contextWith({ authorization: TOKEN })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects every request when no token is configured', () => {
    // Fails closed. GHL_WEBHOOK_TOKEN is optional at boot so existing
    // deployments keep starting, which means an unconfigured endpoint must
    // refuse everything rather than admit everything.
    const guard = guardWith('');

    expect(() =>
      guard.canActivate(contextWith({ authorization: 'Bearer anything' })),
    ).toThrow(UnauthorizedException);
  });
});
