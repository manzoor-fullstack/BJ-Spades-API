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

function guardWith(
  configured: string | undefined,
  authDisabled = false,
): GhlTokenGuard {
  const values: Record<string, unknown> = {
    'ghl.webhookToken': configured,
    'ghl.authDisabled': authDisabled,
  };

  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;

  return new GhlTokenGuard(config);
}

describe('GhlTokenGuard', () => {
  /**
   * RFC 7235 makes the auth scheme case-insensitive, and senders take that
   * literally — GoHighLevel among them. Rejecting `bearer` produced a 401 that
   * looked like a wrong token and cost an afternoon.
   */
  it.each(['Bearer', 'bearer', 'BEARER', 'BeArEr'])(
    'admits the configured token behind a `%s` scheme',
    (scheme) => {
      const guard = guardWith(TOKEN);

      expect(
        guard.canActivate(contextWith({ authorization: `${scheme} ${TOKEN}` })),
      ).toBe(true);
    },
  );

  /**
   * Some senders reserve `Authorization` for their own auth config and drop or
   * overwrite anything put there. This is the way out that does not need them
   * to change platforms.
   */
  it('admits the token supplied in X-BJS-Token instead', () => {
    const guard = guardWith(TOKEN);

    expect(guard.canActivate(contextWith({ 'x-bjs-token': TOKEN }))).toBe(true);
  });

  it('rejects a wrong token in X-BJS-Token', () => {
    const guard = guardWith(TOKEN);

    expect(() =>
      guard.canActivate(contextWith({ 'x-bjs-token': 'nonsense' })),
    ).toThrow(UnauthorizedException);
  });

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

  /**
   * An escape hatch for the window where the sender cannot be made to send the
   * header at all. It is an env flag rather than a code change so turning auth
   * back on is a restart, not a redeploy — and every admitted request is logged
   * as a warning, because an endpoint that creates users must not sit open
   * quietly.
   */
  describe('when auth is explicitly disabled', () => {
    it('admits a request with no Authorization header', () => {
      const guard = guardWith(TOKEN, true);

      expect(guard.canActivate(contextWith({}))).toBe(true);
    });

    it('admits a request carrying a wrong token', () => {
      const guard = guardWith(TOKEN, true);

      expect(
        guard.canActivate(contextWith({ authorization: 'Bearer nonsense' })),
      ).toBe(true);
    });

    it('admits even when no token is configured either', () => {
      const guard = guardWith('', true);

      expect(guard.canActivate(contextWith({}))).toBe(true);
    });
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
