import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';

const SUPPORT_ADMIN = {
  email: 'support.rbac@bjspades.com',
  password: 'Support123!',
};

interface LoginBody {
  data: { accessToken: string };
}

describe('RBAC (integration)', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();

    const supportRole = await testPrisma.role.findUniqueOrThrow({
      where: { name: 'SUPPORT' },
    });

    const password = await bcrypt.hash(SUPPORT_ADMIN.password, 10);

    await testPrisma.admin.upsert({
      where: { email: SUPPORT_ADMIN.email },
      update: { password, roleId: supportRole.id, isActive: true },
      create: {
        firstName: 'Rbac',
        lastName: 'Support',
        email: SUPPORT_ADMIN.email,
        password,
        roleId: supportRole.id,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    await testPrisma.admin.deleteMany({
      where: { email: SUPPORT_ADMIN.email },
    });
    await app?.close();
  });

  /**
   * Logged in per test, not once in beforeAll: setup.ts truncates Session
   * before every test, and JwtStrategy rejects a token whose session is gone.
   */
  const tokenFor = async (credentials: {
    email: string;
    password: string;
  }): Promise<string> => {
    const response = await request(server())
      .post('/api/auth/login')
      .send(credentials);

    if (response.status !== 200) {
      throw new Error(
        `login expected 200, got ${response.status}: ${JSON.stringify(response.body)}`,
      );
    }

    return (response.body as LoginBody).data.accessToken;
  };

  describe('unauthenticated requests', () => {
    it.each(['/api/users', '/api/admins', '/api/roles'])(
      'returns 401 for GET %s with no token',
      async (path) => {
        await request(server()).get(path).expect(401);
      },
    );

    it('returns 401 for a malformed token', async () => {
      await request(server())
        .get('/api/users')
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
    });
  });

  describe('public routes', () => {
    it('GET /api/health stays public', async () => {
      await request(server()).get('/api/health').expect(200);
    });

    it('POST /api/auth/login stays public', async () => {
      await request(server())
        .post('/api/auth/login')
        .send(SEEDED_ADMIN)
        .expect(200);
    });

    it('POST /api/auth/refresh stays public', async () => {
      const response = await request(server())
        .post('/api/auth/refresh')
        .send({ refreshToken: 'nope' });

      // 400 from the validation pipe proves the request got past the guards:
      // pipes only run once every guard has allowed the request through.
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toMatch(/refreshToken/i);
    });
  });

  describe('SUPER_ADMIN', () => {
    it.each(['/api/users', '/api/admins', '/api/roles'])(
      'reaches GET %s',
      async (path) => {
        const token = await tokenFor(SEEDED_ADMIN);

        await request(server())
          .get(path)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      },
    );
  });

  describe('SUPPORT', () => {
    it('reaches GET /api/users (users.view)', async () => {
      const token = await tokenFor(SUPPORT_ADMIN);

      await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('is refused POST /api/users with 403 naming users.manage', async () => {
      const token = await tokenFor(SUPPORT_ADMIN);

      const response = await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(403);

      expect(JSON.stringify(response.body)).toContain('users.manage');
    });

    it.each([
      ['/api/admins', 'admins.manage'],
      ['/api/roles', 'roles.manage'],
    ])('is refused GET %s with 403 naming %s', async (path, code) => {
      const token = await tokenFor(SUPPORT_ADMIN);

      const response = await request(server())
        .get(path)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(JSON.stringify(response.body)).toContain(code);
    });

    it('/api/auth/me needs no permission', async () => {
      const token = await tokenFor(SUPPORT_ADMIN);

      const response = await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as {
        data: { role: string; permissions: string[] };
      };

      expect(body.data.role).toBe('SUPPORT');
      expect(body.data.permissions).toEqual(
        expect.arrayContaining(['users.view']),
      );
      expect(body.data.permissions).not.toContain('users.manage');
    });
  });
});
