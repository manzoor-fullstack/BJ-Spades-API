import type { Server } from 'node:http';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { testPrisma } from './setup';

interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/**
 * Phase 0 — proves the integration harness itself works before any feature
 * depends on it: the test database is reachable, migrations applied, reference
 * data survives truncation, and the global pipe/filter/interceptor stack is
 * actually wired into the request path.
 */
describe('Phase 0 — integration harness', () => {
  let app: INestApplication;

  // getHttpServer() is typed `any`; narrow it once here rather than at every
  // call site.
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    // Mirror main.ts so the tests exercise the same request pipeline.
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );

    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('database', () => {
    it('targets the test database, never dev or production', () => {
      expect(process.env.DATABASE_URL).toContain('bjspades_test');
    });

    it('applied migrations', async () => {
      const tables = await testPrisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `;

      const names = tables.map((t) => t.tablename);

      expect(names).toEqual(
        expect.arrayContaining(['Admin', 'Role', 'Permission', 'User']),
      );
    });

    it('preserves seeded reference data across truncation', async () => {
      // setup.ts truncates before every test; roles and permissions are on the
      // preserve list, so they must still be here.
      const roles = await testPrisma.role.count();
      const permissions = await testPrisma.permission.count();

      expect(roles).toBeGreaterThan(0);
      expect(permissions).toBeGreaterThan(0);
    });

    it('truncates volatile tables between tests', async () => {
      await testPrisma.user.create({
        data: {
          firstName: 'Temp',
          lastName: 'User',
          email: 'temp@example.com',
          source: 'ADMIN',
        },
      });

      expect(await testPrisma.user.count()).toBe(1);
    });

    it('the user from the previous test is gone', async () => {
      expect(await testPrisma.user.count()).toBe(0);
    });
  });

  describe('GET /api/health', () => {
    it('returns 200 in the standard envelope', async () => {
      const response = await request(server()).get('/api/health').expect(200);

      expect(response.body as Record<string, unknown>).toMatchObject({
        success: true,
        data: { status: 'ok', database: 'up' },
      });
    });
  });

  describe('global ValidationPipe', () => {
    it('rejects a malformed body with 400, not 500', async () => {
      const response = await request(server())
        .post('/api/auth/login')
        .send({ email: 'not-an-email' })
        .expect(400);

      const body = response.body as ErrorEnvelope;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(body.error.details)).toBe(true);
    });

    it('rejects unknown properties (forbidNonWhitelisted)', async () => {
      await request(server())
        .post('/api/auth/login')
        .send({
          email: 'admin@bjspades.com',
          password: 'Admin123!',
          isSuperUser: true,
        })
        .expect(400);
    });
  });

  describe('global exception filter', () => {
    it('returns a structured 404 for an unknown route', async () => {
      const response = await request(server())
        .get('/api/does-not-exist')
        .expect(404);

      const body = response.body as ErrorEnvelope;
      expect(body.success).toBe(false);
      expect(body.error.requestId).toBeTruthy();
    });

    it('does not leak a stack trace', async () => {
      const response = await request(server())
        .get('/api/does-not-exist')
        .expect(404);

      expect(JSON.stringify(response.body)).not.toContain('at ');
    });
  });
});
