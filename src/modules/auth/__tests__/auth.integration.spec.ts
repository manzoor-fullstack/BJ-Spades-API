import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import sharp from 'sharp';

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

  describe('Admin.avatar relation', () => {
    it('loads an admin together with its avatar asset', async () => {
      const admin = await testPrisma.admin.findFirst({
        where: { email: SEEDED_ADMIN.email },
        include: { avatar: true },
      });

      expect(admin).not.toBeNull();
      // Nothing has been uploaded, so the relation resolves to null rather
      // than being absent — which is what proves the column exists.
      expect(admin?.avatar).toBeNull();
      expect(admin?.avatarId).toBeNull();
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

    it('includes avatarUrl, null when no picture has been uploaded', async () => {
      const { tokens } = await login();

      const response = await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      const body = response.body as { data: { avatarUrl: string | null } };

      // The key must be present and explicitly null — an absent key would let
      // the client render a broken <img src="undefined">.
      expect(body.data).toHaveProperty('avatarUrl');
      expect(body.data.avatarUrl).toBeNull();
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

  describe('PATCH /api/auth/me', () => {
    // The seeded admin's real name, restored after each test so later specs
    // (and the E2E suite) are not left looking at "Renamed".
    let originalName: { firstName: string; lastName: string };

    // prisma/seed only creates one Admin. The "leaves the other admin
    // untouched" case below needs a second row to prove untouched, so one is
    // created here and torn down after — the same approach
    // security.integration.spec.ts uses for its OTHER_ADMIN, rather than
    // adding a permanent second admin to the shared seed.
    const OTHER_ADMIN_EMAIL = 'profile.other@bjspades.com';

    beforeAll(async () => {
      const admin = await testPrisma.admin.findUniqueOrThrow({
        where: { email: SEEDED_ADMIN.email },
        select: { firstName: true, lastName: true },
      });
      originalName = admin;

      const adminRole = await testPrisma.role.findUniqueOrThrow({
        where: { name: 'ADMIN' },
      });

      await testPrisma.admin.upsert({
        where: { email: OTHER_ADMIN_EMAIL },
        update: {},
        create: {
          firstName: 'Other',
          lastName: 'Admin',
          email: OTHER_ADMIN_EMAIL,
          password: 'unused-in-this-suite',
          roleId: adminRole.id,
          isActive: true,
        },
      });
    });

    afterAll(async () => {
      await testPrisma.admin.deleteMany({
        where: { email: OTHER_ADMIN_EMAIL },
      });
    });

    afterEach(async () => {
      await testPrisma.admin.update({
        where: { email: SEEDED_ADMIN.email },
        data: originalName,
      });
    });

    it('updates the caller’s own first and last name', async () => {
      const { tokens } = await login();

      const response = await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .field('firstName', 'Renamed')
        .field('lastName', 'Admin')
        .expect(200);

      const body = response.body as {
        data: { firstName: string; lastName: string; fullName: string };
      };

      expect(body.data.firstName).toBe('Renamed');
      expect(body.data.lastName).toBe('Admin');
      expect(body.data.fullName).toBe('Renamed Admin');
    });

    it('accepts one field on its own', async () => {
      const { tokens } = await login();

      const response = await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .field('firstName', 'OnlyFirst')
        .expect(200);

      const body = response.body as {
        data: { firstName: string; lastName: string };
      };

      expect(body.data.firstName).toBe('OnlyFirst');
      expect(body.data.lastName).toBe(originalName.lastName);
    });

    it('trims surrounding whitespace', async () => {
      const { tokens } = await login();

      const response = await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .field('firstName', '  Spaced  ')
        .expect(200);

      expect(
        (response.body as { data: { firstName: string } }).data.firstName,
      ).toBe('Spaced');
    });

    it('rejects a blank name', async () => {
      const { tokens } = await login();

      await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .field('firstName', '   ')
        .expect(400);
    });

    it('rejects an unknown field rather than ignoring it', async () => {
      const { tokens } = await login();

      // forbidNonWhitelisted. `role` is the field that matters: silently
      // dropping it would look like a successful self-promotion.
      await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .field('role', 'SUPER_ADMIN')
        .expect(400);
    });

    it('rejects a body-supplied id and leaves the other admin untouched', async () => {
      const { tokens } = await login();

      const other = await testPrisma.admin.findFirst({
        where: { email: { not: SEEDED_ADMIN.email } },
        select: { id: true, firstName: true },
      });

      if (!other) {
        throw new Error(
          'This test needs a second seeded admin; check prisma/seed.ts',
        );
      }

      // `id` is not on the DTO, so forbidNonWhitelisted rejects it outright.
      // That is the desired outcome: there is no path where it is honoured.
      await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .field('id', other.id)
        .field('firstName', 'Hijacked')
        .expect(400);

      const unchanged = await testPrisma.admin.findUniqueOrThrow({
        where: { id: other.id },
        select: { firstName: true },
      });

      expect(unchanged.firstName).toBe(other.firstName);
    });

    it('requires authentication', async () => {
      await request(server())
        .patch('/api/auth/me')
        .field('firstName', 'Nope')
        .expect(401);
    });

    const pngBytes = async (width: number, height: number): Promise<Buffer> =>
      sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: 20, g: 10, b: 40 },
        },
      })
        .png()
        .toBuffer();

    afterEach(async () => {
      // Undo any avatar left behind, so the suite is order-independent.
      const admin = await testPrisma.admin.findUniqueOrThrow({
        where: { email: SEEDED_ADMIN.email },
        select: { avatarId: true },
      });

      if (admin.avatarId) {
        await testPrisma.admin.update({
          where: { email: SEEDED_ADMIN.email },
          data: { avatarId: null },
        });
        await testPrisma.mediaAsset.delete({ where: { id: admin.avatarId } });
      }
    });

    it('stores an uploaded avatar as a square webp and returns its url', async () => {
      const { tokens } = await login();

      const response = await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .attach('image', await pngBytes(1000, 600), 'me.png')
        .expect(200);

      const body = response.body as { data: { avatarUrl: string | null } };

      // LocalDiskStorageService always serves from `${PUBLIC_URL}/uploads/<key>`
      // (see its class doc), so the URL is absolute rather than
      // root-relative — matched here without anchoring to the start of the
      // string so the assertion holds regardless of PUBLIC_URL's value.
      expect(body.data.avatarUrl).toMatch(/\/uploads\/avatars\/.+\.webp$/);

      const asset = await testPrisma.mediaAsset.findFirstOrThrow({
        where: { url: body.data.avatarUrl ?? '' },
      });

      expect(asset.mimeType).toBe('image/webp');
      expect(asset.width).toBe(512);
      expect(asset.height).toBe(512);
    });

    it('replaces an avatar and deletes the previous asset', async () => {
      const { tokens } = await login();

      const first = await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .attach('image', await pngBytes(800, 800), 'first.png')
        .expect(200);

      const firstUrl = (first.body as { data: { avatarUrl: string } }).data
        .avatarUrl;
      const firstAsset = await testPrisma.mediaAsset.findFirstOrThrow({
        where: { url: firstUrl },
      });

      const second = await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .attach('image', await pngBytes(800, 800), 'second.png')
        .expect(200);

      const secondUrl = (second.body as { data: { avatarUrl: string } }).data
        .avatarUrl;

      expect(secondUrl).not.toBe(firstUrl);

      const gone = await testPrisma.mediaAsset.findUnique({
        where: { id: firstAsset.id },
      });

      expect(gone).toBeNull();
    });

    it('clears the avatar on removeAvatar=true', async () => {
      const { tokens } = await login();

      await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .attach('image', await pngBytes(400, 400), 'me.png')
        .expect(200);

      const response = await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .field('removeAvatar', 'true')
        .expect(200);

      expect(
        (response.body as { data: { avatarUrl: null } }).data.avatarUrl,
      ).toBeNull();
    });

    it('refuses a file that is not really an image', async () => {
      const { tokens } = await login();

      // Declared image/png, actually text. The magic-byte check is the one
      // that cannot be lied to.
      await request(server())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .attach('image', Buffer.from('#!/bin/sh\necho pwned'), {
          filename: 'evil.png',
          contentType: 'image/png',
        })
        .expect(400);
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

  describe('POST /api/auth/change-password', () => {
    const NEW_PASSWORD = 'ChangedByTest123!';

    // Restores the seeded password by going through the endpoint itself, so a
    // failure here cannot leave the seeded admin locked out of later specs.
    const restore = async () => {
      const { tokens } = await login({
        email: SEEDED_ADMIN.email,
        password: NEW_PASSWORD,
      });

      await request(server())
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({
          currentPassword: NEW_PASSWORD,
          newPassword: SEEDED_ADMIN.password,
        })
        .expect(200);
    };

    it('rejects a wrong current password with 401', async () => {
      const { tokens } = await login();

      await request(server())
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ currentPassword: 'not-it', newPassword: 'Whatever123!' })
        .expect(401);

      // The old password still works, i.e. nothing was written.
      await login();
    });

    it('rejects a new password under 8 characters', async () => {
      const { tokens } = await login();

      await request(server())
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ currentPassword: SEEDED_ADMIN.password, newPassword: 'short1' })
        .expect(400);
    });

    it('changes the password and reports the sessions it ended', async () => {
      // Two sessions: the one that changes the password, and one that should
      // be killed by it.
      const doomed = await login();
      const current = await login();

      const response = await request(server())
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${current.tokens.accessToken}`)
        .send({
          currentPassword: SEEDED_ADMIN.password,
          newPassword: NEW_PASSWORD,
        })
        .expect(200);

      const body = response.body as { data: { sessionsEnded: number } };

      expect(body.data.sessionsEnded).toBeGreaterThanOrEqual(1);

      // The other device is out.
      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${doomed.tokens.accessToken}`)
        .expect(401);

      // This one is still in.
      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${current.tokens.accessToken}`)
        .expect(200);

      // And the new password is the one that works now.
      await request(server())
        .post('/api/auth/login')
        .send({ email: SEEDED_ADMIN.email, password: SEEDED_ADMIN.password })
        .expect(401);

      await restore();
    });

    it('requires authentication', async () => {
      await request(server())
        .post('/api/auth/change-password')
        .send({ currentPassword: 'a', newPassword: 'BrandNew123!' })
        .expect(401);
    });
  });
});
