import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

describe('Auth (integration)', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  const login = async (
    credentials = SEEDED_ADMIN,
  ): Promise<{ status: number; tokens: Tokens }> => {
    const response = await request(server())
      .post('/api/auth/login')
      .set(
        'User-Agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
      )
      .send(credentials);

    // Fail here with the actual response rather than letting an undefined
    // token surface as a confusing TypeError three lines later.
    if (response.status !== 200) {
      throw new Error(
        `login helper expected 200, got ${response.status}: ${JSON.stringify(response.body)}`,
      );
    }

    return {
      status: response.status,
      tokens: (response.body as { data: Tokens }).data,
    };
  };

  describe('POST /api/auth/login', () => {
    it('returns tokens and the admin profile', async () => {
      const response = await request(server())
        .post('/api/auth/login')
        .send(SEEDED_ADMIN)
        .expect(200);

      const body = response.body as {
        success: boolean;
        data: Tokens & { admin: { email: string; permissions: string[] } };
      };

      expect(body.success).toBe(true);
      expect(body.data.accessToken).toBeTruthy();
      expect(body.data.refreshToken).toBeTruthy();
      expect(body.data.expiresIn).toBe(900);
      expect(body.data.admin.email).toBe(SEEDED_ADMIN.email);
      expect(body.data.admin.permissions.length).toBeGreaterThan(0);
    });

    it('never returns the password hash', async () => {
      const response = await request(server())
        .post('/api/auth/login')
        .send(SEEDED_ADMIN)
        .expect(200);

      expect(JSON.stringify(response.body)).not.toMatch(/\$2[aby]\$/);
    });

    it('persists the session with device metadata', async () => {
      await request(server())
        .post('/api/auth/login')
        .set(
          'User-Agent',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        )
        .send(SEEDED_ADMIN)
        .expect(200);

      const session = await testPrisma.session.findFirst({
        orderBy: { createdAt: 'desc' },
      });

      expect(session).toBeTruthy();
      expect(session?.browser).toContain('Chrome');
      expect(session?.os).toContain('Windows');
      expect(session?.device).toBe('Desktop');
    });

    it('stores the refresh token hashed, not in plaintext', async () => {
      const { tokens } = await login();

      const stored = await testPrisma.refreshToken.findFirst({
        orderBy: { createdAt: 'desc' },
      });

      expect(stored?.tokenHash).toHaveLength(64);
      expect(stored?.tokenHash).not.toBe(tokens.refreshToken);
    });

    it('rejects a wrong password with 401', async () => {
      await request(server())
        .post('/api/auth/login')
        .send({ email: SEEDED_ADMIN.email, password: 'WrongPassword1!' })
        .expect(401);
    });

    it('gives an identical message for unknown email and wrong password', async () => {
      const unknown = await request(server())
        .post('/api/auth/login')
        .send({ email: 'nobody@nowhere.com', password: 'WrongPassword1!' })
        .expect(401);

      const wrongPassword = await request(server())
        .post('/api/auth/login')
        .send({ email: SEEDED_ADMIN.email, password: 'WrongPassword1!' })
        .expect(401);

      const messageOf = (res: { body: unknown }) =>
        (res.body as { error: { message: string } }).error.message;

      expect(messageOf(unknown)).toBe(messageOf(wrongPassword));
    });

    it('rejects a malformed email with 400', async () => {
      await request(server())
        .post('/api/auth/login')
        .send({ email: 'not-an-email', password: 'Admin123!' })
        .expect(400);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns the profile for a valid token', async () => {
      const { tokens } = await login();

      const response = await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      const body = response.body as {
        data: { email: string; fullName: string; permissions: string[] };
      };

      expect(body.data.email).toBe(SEEDED_ADMIN.email);
      expect(body.data.fullName).toBe('Super Admin');
    });

    it('returns 401 without a token', async () => {
      await request(server()).get('/api/auth/me').expect(401);
    });

    it('returns 401 for a garbage token', async () => {
      await request(server())
        .get('/api/auth/me')
        .set('Authorization', 'Bearer not.a.jwt')
        .expect(401);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('rotates the refresh token', async () => {
      const { tokens } = await login();

      const response = await request(server())
        .post('/api/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const next = (response.body as { data: Tokens }).data;

      expect(next.refreshToken).not.toBe(tokens.refreshToken);
      expect(next.accessToken).toBeTruthy();
    });

    it('marks the old token revoked and links its successor', async () => {
      const { tokens } = await login();

      await request(server())
        .post('/api/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const tokenRows = await testPrisma.refreshToken.findMany({
        orderBy: { createdAt: 'asc' },
      });

      expect(tokenRows).toHaveLength(2);
      expect(tokenRows[0]?.revokedAt).toBeTruthy();
      expect(tokenRows[0]?.replacedByTokenId).toBe(tokenRows[1]?.id);
      expect(tokenRows[1]?.revokedAt).toBeNull();
    });

    it('revokes the whole session when a rotated token is replayed', async () => {
      const { tokens } = await login();

      const rotated = await request(server())
        .post('/api/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const next = (rotated.body as { data: Tokens }).data;

      // Replay the superseded token — the theft signal.
      await request(server())
        .post('/api/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);

      // The successor must die too, or a thief keeps the session alive.
      await request(server())
        .post('/api/auth/refresh')
        .send({ refreshToken: next.refreshToken })
        .expect(401);

      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${next.accessToken}`)
        .expect(401);

      const session = await testPrisma.session.findFirst({
        orderBy: { createdAt: 'desc' },
      });

      expect(session?.revokedAt).toBeTruthy();
      expect(session?.isActive).toBe(false);
    });

    it('rejects a syntactically invalid token with 400', async () => {
      await request(server())
        .post('/api/auth/refresh')
        .send({ refreshToken: 'nonsense' })
        .expect(400);
    });

    it('rejects an access token used as a refresh token', async () => {
      const { tokens } = await login();

      // Signed with a different secret, so it must not verify here.
      await request(server())
        .post('/api/auth/refresh')
        .send({ refreshToken: tokens.accessToken })
        .expect(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('revokes the session immediately', async () => {
      const { tokens } = await login();

      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      await request(server())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(204);

      // The access token is still cryptographically valid; it must stop
      // working anyway. This is the whole point of the session rework.
      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(401);

      await request(server())
        .post('/api/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
    });

    it('returns 401 without a token', async () => {
      await request(server()).post('/api/auth/logout').expect(401);
    });
  });

  describe('POST /api/auth/logout-all', () => {
    it('ends every other session but keeps the caller signed in', async () => {
      const first = await login();
      const second = await login();
      const third = await login();

      await request(server())
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${third.tokens.accessToken}`)
        .expect(204);

      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${first.tokens.accessToken}`)
        .expect(401);

      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${second.tokens.accessToken}`)
        .expect(401);

      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${third.tokens.accessToken}`)
        .expect(200);
    });
  });

  describe('session revocation cascade', () => {
    it('revoking a session revokes its refresh tokens in the database', async () => {
      const { tokens } = await login();

      await request(server())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(204);

      const live = await testPrisma.refreshToken.count({
        where: { revokedAt: null },
      });

      expect(live).toBe(0);
    });
  });
});
