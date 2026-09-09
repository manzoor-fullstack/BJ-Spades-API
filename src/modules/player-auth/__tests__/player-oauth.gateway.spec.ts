import { ConfigService } from '@nestjs/config';
import { PlayerAuthProvider } from '@prisma/client';

import { HttpPlayerOAuthGateway } from '../services/player-oauth.gateway';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpPlayerOAuthGateway', () => {
  const config = new ConfigService({
    playerAuth: {
      googleClientId: 'google-id',
      googleClientSecret: 'google-secret',
      githubClientId: 'github-id',
      githubClientSecret: 'github-secret',
    },
  });
  const gateway = new HttpPlayerOAuthGateway(config);

  afterEach(() => jest.restoreAllMocks());

  it('builds a Google authorization request with state, callback, and PKCE', () => {
    const result = new URL(
      gateway.authorizationUrl({
        provider: PlayerAuthProvider.GOOGLE,
        state: 'random-state',
        codeChallenge: 'pkce-challenge',
        callbackUrl: 'https://api.example.com/callback',
      }),
    );
    expect(result.origin + result.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(Object.fromEntries(result.searchParams)).toMatchObject({
      client_id: 'google-id',
      redirect_uri: 'https://api.example.com/callback',
      response_type: 'code',
      state: 'random-state',
      code_challenge: 'pkce-challenge',
      code_challenge_method: 'S256',
      scope: 'openid email profile',
    });
  });

  it('exchanges a Google code and requires the provider verification signal', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'google-token' }))
      .mockResolvedValueOnce(
        jsonResponse({
          sub: 'google-42',
          email: 'Verified@Example.com',
          email_verified: true,
          given_name: 'Verified',
          family_name: 'Player',
        }),
      );
    await expect(
      gateway.exchange({
        provider: PlayerAuthProvider.GOOGLE,
        code: 'authorization-code',
        codeVerifier: 'verifier',
        callbackUrl: 'https://api.example.com/callback',
      }),
    ).resolves.toEqual({
      provider: PlayerAuthProvider.GOOGLE,
      providerUserId: 'google-42',
      email: 'verified@example.com',
      emailVerified: true,
      firstName: 'Verified',
      lastName: 'Player',
    });
    const tokenRequest = fetchMock.mock.calls[0];
    expect(tokenRequest?.[0]).toBe('https://oauth2.googleapis.com/token');
    const body = (tokenRequest?.[1] as RequestInit).body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('code_verifier')).toBe('verifier');
  });

  it('uses only GitHub primary verified email and the durable numeric user id', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'github-token' }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 9876, login: 'card_shark', name: 'Card Shark' }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            email: 'unverified@example.com',
            primary: false,
            verified: false,
          },
          { email: 'primary@example.com', primary: true, verified: true },
        ]),
      );
    await expect(
      gateway.exchange({
        provider: PlayerAuthProvider.GITHUB,
        code: 'authorization-code',
        codeVerifier: 'verifier',
        callbackUrl: 'https://api.example.com/callback',
      }),
    ).resolves.toMatchObject({
      provider: PlayerAuthProvider.GITHUB,
      providerUserId: '9876',
      email: 'primary@example.com',
      emailVerified: true,
      username: 'card_shark',
    });
  });

  it('rejects GitHub identities without a primary verified email', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'github-token' }))
      .mockResolvedValueOnce(jsonResponse({ id: 9876, login: 'card_shark' }))
      .mockResolvedValueOnce(
        jsonResponse([
          { email: 'hidden@example.com', primary: true, verified: false },
        ]),
      );
    await expect(
      gateway.exchange({
        provider: PlayerAuthProvider.GITHUB,
        code: 'authorization-code',
        codeVerifier: 'verifier',
        callbackUrl: 'https://api.example.com/callback',
      }),
    ).rejects.toThrow('A verified provider email is required');
  });
});
