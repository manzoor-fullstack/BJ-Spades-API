import type { INestApplication } from '@nestjs/common';
import {
  PlayerAuthProvider,
  PlayerEmailTokenPurpose,
  UserSource,
  UserStatus,
} from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { PlayerEmailService } from '../services/player-email.service';
import {
  PLAYER_OAUTH_GATEWAY,
  type PlayerOAuthGateway,
  type PlayerOAuthProfile,
} from '../services/player-oauth.gateway';

const ORIGIN = 'http://127.0.0.1:4173';

class CapturingEmailService {
  verificationMessages: { email: string; token: string }[] = [];
  resetMessages: { email: string; token: string }[] = [];

  verification(email: string, token: string): Promise<void> {
    this.verificationMessages.push({ email, token });
    return Promise.resolve();
  }

  passwordReset(email: string, token: string): Promise<void> {
    this.resetMessages.push({ email, token });
    return Promise.resolve();
  }

  reset(): void {
    this.verificationMessages = [];
    this.resetMessages = [];
  }
}

class FakeOAuthGateway implements PlayerOAuthGateway {
  profile: PlayerOAuthProfile = {
    provider: PlayerAuthProvider.GOOGLE,
    providerUserId: 'google-123',
    email: 'oauth@example.com',
    emailVerified: true,
    username: 'oauth_player',
    firstName: 'OAuth',
    lastName: 'Player',
  };

  authorizationUrl(input: {
    provider: PlayerAuthProvider;
    state: string;
    codeChallenge: string;
    callbackUrl: string;
  }): string {
    const url = new URL('https://provider.test/authorize');
    url.searchParams.set('provider', input.provider);
    url.searchParams.set('state', input.state);
    url.searchParams.set('challenge', input.codeChallenge);
    url.searchParams.set('callback', input.callbackUrl);
    return url.toString();
  }

  exchange(input: {
    provider: PlayerAuthProvider;
    code: string;
    codeVerifier: string;
    callbackUrl: string;
  }): Promise<PlayerOAuthProfile> {
    return Promise.resolve({ ...this.profile, provider: input.provider });
  }

  reset(): void {
    this.profile = {
      provider: PlayerAuthProvider.GOOGLE,
      providerUserId: 'google-123',
      email: 'oauth@example.com',
      emailVerified: true,
      username: 'oauth_player',
      firstName: 'OAuth',
      lastName: 'Player',
    };
  }
}

function setCookies(response: request.Response): string[] {
  const value = response.headers['set-cookie'];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function cookieValue(response: request.Response, name: string): string {
  const cookie = setCookies(response).find((value) =>
    value.startsWith(`${name}=`),
  );
  if (!cookie) throw new Error(`Missing ${name} cookie`);
  return decodeURIComponent(cookie.split(';', 1)[0]!.slice(name.length + 1));
}

function cookieHeader(response: request.Response): string {
  return setCookies(response)
    .map((value) => value.split(';', 1)[0])
    .join('; ');
}

describe('Player authentication API (integration)', () => {
  let app: INestApplication;
  const email = new CapturingEmailService();
  const oauth = new FakeOAuthGateway();

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [
        { provide: PlayerEmailService, useValue: email },
        { provide: PLAYER_OAUTH_GATEWAY, useValue: oauth },
      ],
    });
  });

  beforeEach(() => {
    email.reset();
    oauth.reset();
  });

  afterAll(async () => app?.close());

  const server = (): Server => app.getHttpServer() as Server;

  function register(
    agent: ReturnType<typeof request.agent>,
    overrides: Partial<{
      username: string;
      email: string;
      password: string;
    }> = {},
  ) {
    return agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: 'table_master',
        email: 'player@example.com',
        password: 'StrongPass123',
        ...overrides,
      });
  }

  async function verifiedPlayer(
    agent: ReturnType<typeof request.agent>,
    overrides: Partial<{
      username: string;
      email: string;
      password: string;
    }> = {},
  ) {
    const signup = await register(agent, overrides).expect(202);
    expect((signup.body as { data: unknown }).data).toEqual({
      message:
        'If this address can be registered, a verification link has been sent.',
    });
    const token = email.verificationMessages.at(-1)?.token;
    expect(token).toHaveLength(64);
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token })
      .expect(200);
    return {
      email: overrides.email ?? 'player@example.com',
      password: overrides.password ?? 'StrongPass123',
    };
  }

  function login(
    agent: ReturnType<typeof request.agent>,
    credentials: { email: string; password: string },
    rememberMe = false,
  ) {
    return agent
      .post('/api/player/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ ...credentials, rememberMe });
  }

  async function beginOAuth(
    provider: 'google' | 'github' = 'google',
    rememberMe = false,
  ): Promise<string> {
    const started = await request(server())
      .get(`/api/player/v1/auth/oauth/${provider}/start`)
      .query({ rememberMe, redirect: '/tournaments?tab=live' })
      .expect(302);
    const target = new URL(started.headers.location as string);
    expect(target.origin).toBe('https://provider.test');
    expect(target.searchParams.get('challenge')).toHaveLength(43);
    return target.searchParams.get('state')!;
  }

  it('registers, verifies once, signs in with HttpOnly cookies, and reads /me', async () => {
    const agent = request.agent(server());
    await register(agent).expect(202);

    const stored = await testPrisma.user.findUniqueOrThrow({
      where: { email: 'player@example.com' },
      include: { credential: true },
    });
    expect(stored.source).toBe(UserSource.PLAYER);
    expect(stored.status).toBe(UserStatus.PENDING);
    expect(stored.emailVerified).toBe(false);
    expect(stored.credential?.passwordHash).not.toBe('StrongPass123');

    await login(agent, {
      email: 'player@example.com',
      password: 'StrongPass123',
    }).expect(403);

    const token = email.verificationMessages[0]?.token;
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token })
      .expect(200);
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token })
      .expect(401);

    const signedIn = await login(agent, {
      email: 'player@example.com',
      password: 'StrongPass123',
    }).expect(200);
    const cookies = setCookies(signedIn);
    expect(
      cookies.some((value) => /bjs_player_access=.*HttpOnly/i.test(value)),
    ).toBe(true);
    expect(
      cookies.some((value) => /bjs_player_refresh=.*HttpOnly/i.test(value)),
    ).toBe(true);
    expect(cookies.some((value) => value.startsWith('bjs_player_csrf='))).toBe(
      true,
    );
    expect(JSON.stringify(signedIn.body)).not.toContain('accessToken');
    expect(JSON.stringify(signedIn.body)).not.toContain('refreshToken');

    await agent
      .get('/api/player/v1/me')
      .expect(200)
      .expect(({ body }) => {
        expect((body as { data: unknown }).data).toMatchObject({
          username: 'table_master',
          email: 'player@example.com',
          emailVerified: true,
        });
      });
  });

  it('claims an existing webhook profile without replacing its identity', async () => {
    const existing = await testPrisma.user.create({
      data: {
        firstName: 'Existing',
        lastName: 'Player',
        email: 'claim@example.com',
        source: UserSource.WEBHOOK,
        status: UserStatus.PENDING,
      },
    });
    const agent = request.agent(server());
    await register(agent, {
      username: 'claimed_player',
      email: existing.email,
    }).expect(202);
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token: email.verificationMessages[0]?.token })
      .expect(200);

    await expect(
      testPrisma.user.findUniqueOrThrow({
        where: { id: existing.id },
        include: { credential: true },
      }),
    ).resolves.toMatchObject({
      firstName: 'Existing',
      lastName: 'Player',
      source: UserSource.WEBHOOK,
      status: UserStatus.ACTIVE,
      emailVerified: true,
      credential: { username: 'claimed_player' },
    });
  });

  it('does not overwrite an existing password and keeps registration responses generic', async () => {
    const agent = request.agent(server());
    const first = await register(agent).expect(202);
    const second = await register(agent, {
      username: 'another_name',
      password: 'DifferentPass456',
    }).expect(202);
    expect(second.body).toEqual(first.body);

    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token: email.verificationMessages.at(-1)?.token })
      .expect(200);
    await login(agent, {
      email: 'player@example.com',
      password: 'StrongPass123',
    }).expect(200);
    await login(request.agent(server()), {
      email: 'player@example.com',
      password: 'DifferentPass456',
    }).expect(401);
  });

  it('uses the same login error for an unknown email and a wrong password', async () => {
    const agent = request.agent(server());
    const credentials = await verifiedPlayer(agent);
    const unknown = await login(request.agent(server()), {
      email: 'unknown@example.com',
      password: credentials.password,
    }).expect(401);
    const wrong = await login(request.agent(server()), {
      email: credentials.email,
      password: 'WrongPass999',
    }).expect(401);
    const unknownError = unknown.body as { error: { message: string } };
    const wrongError = wrong.body as { error: { message: string } };
    expect(unknownError.error.message).toBe('Invalid email or password.');
    expect(wrongError.error.message).toBe(unknownError.error.message);
  });

  it('rejects cross-origin mutations and missing CSRF on refresh', async () => {
    await request(server())
      .post('/api/player/v1/auth/register')
      .send({
        username: 'table_master',
        email: 'player@example.com',
        password: 'StrongPass123',
      })
      .expect(403);
    await request(server())
      .post('/api/player/v1/auth/register')
      .set('Origin', 'https://evil.example')
      .send({
        username: 'table_master',
        email: 'player@example.com',
        password: 'StrongPass123',
      })
      .expect(403);

    const agent = request.agent(server());
    const credentials = await verifiedPlayer(agent);
    await login(agent, credentials).expect(200);
    await agent
      .post('/api/player/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .expect(403);
  });

  it('rotates refresh tokens atomically and keeps the winning session active', async () => {
    const agent = request.agent(server());
    const credentials = await verifiedPlayer(agent);
    const signedIn = await login(agent, credentials, true).expect(200);
    const cookies = cookieHeader(signedIn);
    const csrf = cookieValue(signedIn, 'bjs_player_csrf');

    const refresh = () =>
      request(server())
        .post('/api/player/v1/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Cookie', cookies)
        .set('x-csrf-token', csrf);
    const responses = await Promise.all([refresh(), refresh()]);
    expect(responses.map((value) => value.status).sort()).toEqual([200, 401]);

    const winner = responses.find((value) => value.status === 200)!;
    await request(server())
      .get('/api/player/v1/me')
      .set('Cookie', cookieHeader(winner))
      .expect(200);
    await expect(testPrisma.playerSession.count()).resolves.toBe(1);
    await expect(testPrisma.playerRefreshToken.count()).resolves.toBe(2);
  });

  it('revokes the session when an old refresh token is replayed after grace', async () => {
    const agent = request.agent(server());
    const credentials = await verifiedPlayer(agent);
    const signedIn = await login(agent, credentials, true).expect(200);
    const oldCookies = cookieHeader(signedIn);
    const oldCsrf = cookieValue(signedIn, 'bjs_player_csrf');
    const rotated = await request(server())
      .post('/api/player/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', oldCookies)
      .set('x-csrf-token', oldCsrf)
      .expect(200);
    await testPrisma.playerRefreshToken.updateMany({
      where: { revokedAt: { not: null } },
      data: { revokedAt: new Date(Date.now() - 6_000) },
    });

    await request(server())
      .post('/api/player/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', oldCookies)
      .set('x-csrf-token', oldCsrf)
      .expect(401);
    await request(server())
      .get('/api/player/v1/me')
      .set('Cookie', cookieHeader(rotated))
      .expect(401);
  });

  it('logout revokes the server session and clears all player cookies', async () => {
    const agent = request.agent(server());
    const credentials = await verifiedPlayer(agent);
    const signedIn = await login(agent, credentials).expect(200);
    const csrf = cookieValue(signedIn, 'bjs_player_csrf');

    const loggedOut = await agent
      .post('/api/player/v1/auth/logout')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', csrf)
      .expect(204);
    const cleared = setCookies(loggedOut).filter((value) =>
      /^bjs_player_(access|refresh|csrf)=/.test(value),
    );
    expect(cleared).toHaveLength(3);
    expect(
      cleared.every((value) => /Expires=Thu, 01 Jan 1970/i.test(value)),
    ).toBe(true);
    await agent.get('/api/player/v1/me').expect(401);
    await expect(
      testPrisma.playerSession.findFirstOrThrow(),
    ).resolves.toMatchObject({ isActive: false });
  });

  it('password reset is generic, single-use, and revokes existing sessions', async () => {
    const agent = request.agent(server());
    const credentials = await verifiedPlayer(agent);
    await login(agent, credentials).expect(200);

    const unknown = await request(server())
      .post('/api/player/v1/auth/password/request')
      .set('Origin', ORIGIN)
      .send({ email: 'unknown@example.com' })
      .expect(202);
    const known = await request(server())
      .post('/api/player/v1/auth/password/request')
      .set('Origin', ORIGIN)
      .send({ email: credentials.email })
      .expect(202);
    expect(known.body).toEqual(unknown.body);

    const token = email.resetMessages[0]?.token;
    await request(server())
      .post('/api/player/v1/auth/password/reset')
      .set('Origin', ORIGIN)
      .send({ token, newPassword: 'ChangedPass456' })
      .expect(200);
    await request(server())
      .post('/api/player/v1/auth/password/reset')
      .set('Origin', ORIGIN)
      .send({ token, newPassword: 'AnotherPass789' })
      .expect(401);

    await agent.get('/api/player/v1/me').expect(401);
    await login(request.agent(server()), credentials).expect(401);
    await login(request.agent(server()), {
      email: credentials.email,
      password: 'ChangedPass456',
    }).expect(200);
    await expect(
      testPrisma.playerEmailToken.count({
        where: { purpose: PlayerEmailTokenPurpose.PASSWORD_RESET },
      }),
    ).resolves.toBe(1);
  });

  it('uses session cookies unless remember me is selected', async () => {
    const agent = request.agent(server());
    const credentials = await verifiedPlayer(agent);
    const temporary = await login(agent, credentials, false).expect(200);
    const temporaryRefresh = setCookies(temporary).find((value) =>
      value.startsWith('bjs_player_refresh='),
    );
    expect(temporaryRefresh).not.toMatch(/Expires=/i);

    const persistent = await login(
      request.agent(server()),
      credentials,
      true,
    ).expect(200);
    const persistentRefresh = setCookies(persistent).find((value) =>
      value.startsWith('bjs_player_refresh='),
    );
    expect(persistentRefresh).toMatch(/Expires=/i);
  });

  it('rejects an admin access token as a player session', async () => {
    const admin = await request(server())
      .post('/api/auth/login')
      .send({ email: 'admin@bjspades.com', password: 'Admin123!' })
      .expect(200);
    const accessToken = (admin.body as { data: { accessToken: string } }).data
      .accessToken;
    await request(server())
      .get('/api/player/v1/me')
      .set('Cookie', `bjs_player_access=${accessToken}`)
      .expect(401);
  });

  it('ends an authenticated player session after suspension', async () => {
    const agent = request.agent(server());
    const credentials = await verifiedPlayer(agent);
    await login(agent, credentials).expect(200);
    await testPrisma.user.update({
      where: { email: credentials.email },
      data: { status: UserStatus.SUSPENDED },
    });
    await agent.get('/api/player/v1/me').expect(401);
  });

  it('creates a player from a verified OAuth identity and consumes state once', async () => {
    const state = await beginOAuth('google', true);
    const callback = await request(server())
      .get('/api/player/v1/auth/oauth/google/callback')
      .query({ state, code: 'valid-code' })
      .expect(302);
    expect(callback.headers.location).toBe(
      'http://127.0.0.1:4173/tournaments?tab=live&oauth=success',
    );
    expect(
      setCookies(callback).some((value) =>
        value.startsWith('bjs_player_access='),
      ),
    ).toBe(true);
    await request(server())
      .get('/api/player/v1/me')
      .set('Cookie', cookieHeader(callback))
      .expect(200);
    await expect(
      testPrisma.playerOAuthAccount.findUniqueOrThrow({
        where: {
          provider_providerUserId: {
            provider: PlayerAuthProvider.GOOGLE,
            providerUserId: 'google-123',
          },
        },
      }),
    ).resolves.toMatchObject({ emailAtLink: 'oauth@example.com' });

    const reused = await request(server())
      .get('/api/player/v1/auth/oauth/google/callback')
      .query({ state, code: 'valid-code' })
      .expect(302);
    expect(reused.headers.location).toBe('http://127.0.0.1:4173/?oauth=error');
  });

  it('links a verified OAuth identity to the existing email profile', async () => {
    const existing = await testPrisma.user.create({
      data: {
        firstName: 'Existing',
        lastName: 'Profile',
        email: 'oauth@example.com',
        source: UserSource.WEBHOOK,
        status: UserStatus.PENDING,
      },
    });
    const state = await beginOAuth();
    await request(server())
      .get('/api/player/v1/auth/oauth/google/callback')
      .query({ state, code: 'valid-code' })
      .expect(302);
    await expect(
      testPrisma.user.findUniqueOrThrow({
        where: { id: existing.id },
        include: { credential: true, oauthAccounts: true },
      }),
    ).resolves.toMatchObject({
      firstName: 'Existing',
      source: UserSource.WEBHOOK,
      status: UserStatus.ACTIVE,
      emailVerified: true,
      oauthAccounts: [{ provider: PlayerAuthProvider.GOOGLE }],
    });
  });

  it('rejects provider mismatch, unverified email, and suspended OAuth linking', async () => {
    const mismatchState = await beginOAuth('google');
    const mismatch = await request(server())
      .get('/api/player/v1/auth/oauth/github/callback')
      .query({ state: mismatchState, code: 'valid-code' })
      .expect(302);
    expect(mismatch.headers.location).toContain('oauth=error');

    oauth.profile.emailVerified = false;
    const unverifiedState = await beginOAuth('google');
    await request(server())
      .get('/api/player/v1/auth/oauth/google/callback')
      .query({ state: unverifiedState, code: 'valid-code' })
      .expect(302);
    await expect(testPrisma.user.count()).resolves.toBe(0);

    oauth.profile.emailVerified = true;
    await testPrisma.user.create({
      data: {
        firstName: 'Suspended',
        lastName: 'Player',
        email: 'oauth@example.com',
        source: UserSource.PLAYER,
        status: UserStatus.SUSPENDED,
      },
    });
    const suspendedState = await beginOAuth('google');
    await request(server())
      .get('/api/player/v1/auth/oauth/google/callback')
      .query({ state: suspendedState, code: 'valid-code' })
      .expect(302);
    await expect(testPrisma.playerOAuthAccount.count()).resolves.toBe(0);
  });
});
