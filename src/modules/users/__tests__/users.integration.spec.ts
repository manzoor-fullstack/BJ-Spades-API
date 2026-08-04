import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import { Prisma, UserSource, UserStatus, UserTier } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';

const SUPPORT_ADMIN = {
  email: 'support.users@bjspades.com',
  password: 'Support123!',
};

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface LoginBody {
  data: { accessToken: string };
}

interface UserRow {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  initials: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  tier: UserTier;
  source: UserSource;
  balance: string;
  country: string | null;
  createdAt: string;
}

interface ListBody {
  success: true;
  data: UserRow[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface ItemBody {
  success: true;
  data: UserRow & Record<string, unknown>;
}

interface StatsBody {
  success: true;
  data: {
    total: number;
    active: number;
    suspended: number;
    pending: number;
    newThisMonth: number;
    bySource: Record<string, number>;
    byTier: Record<string, number>;
  };
}

interface BalanceBody {
  success: true;
  data: {
    userId: string;
    balance: string;
    previousBalance?: string;
    amount?: string;
    reason?: string;
  };
}

/**
 * setup.ts truncates the User table before every test, so nothing here relies
 * on the 50 seeded users — each test builds exactly the rows it asserts on.
 */
let fixtureCounter = 0;

function userFixture(
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
): Prisma.UserUncheckedCreateInput {
  fixtureCounter += 1;

  return {
    firstName: `First${fixtureCounter}`,
    lastName: `Last${fixtureCounter}`,
    email: `user${fixtureCounter}@example.com`,
    phone: `+1555000${String(fixtureCounter).padStart(4, '0')}`,
    status: UserStatus.ACTIVE,
    tier: UserTier.PLAYER,
    source: UserSource.WEBHOOK,
    balance: new Prisma.Decimal(0),
    ...overrides,
  };
}

async function seedUser(
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  return testPrisma.user.create({ data: userFixture(overrides) });
}

describe('Users API (integration)', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();

    const supportRole = await testPrisma.role.findUniqueOrThrow({
      where: { name: 'SUPPORT' },
    });

    const password = await bcrypt.hash(SUPPORT_ADMIN.password, 10);

    // SUPPORT holds users.view but not users.manage — the exact split the 403
    // cases below depend on.
    await testPrisma.admin.upsert({
      where: { email: SUPPORT_ADMIN.email },
      update: { password, roleId: supportRole.id, isActive: true },
      create: {
        firstName: 'Users',
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
   * Logged in inside each test rather than once: setup.ts truncates Session
   * before every test and JwtStrategy rejects a token whose session is gone.
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

  const adminToken = () => tokenFor(SEEDED_ADMIN);
  const supportToken = () => tokenFor(SUPPORT_ADMIN);

  describe('GET /api/users', () => {
    it('returns 401 without a token', async () => {
      await request(server()).get('/api/users').expect(401);
    });

    it('returns rows with computed fullName, initials and a string balance', async () => {
      await seedUser({
        firstName: 'John',
        lastName: 'Mitchell',
        email: 'john.mitchell@email.com',
        balance: new Prisma.Decimal('12450.5'),
        tier: UserTier.VIP,
        country: 'United States',
      });

      const token = await adminToken();
      const response = await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toEqual(
        expect.objectContaining({
          firstName: 'John',
          lastName: 'Mitchell',
          fullName: 'John Mitchell',
          initials: 'JM',
          // A string, not a float: 12450.5 would round-trip badly as JSON.
          balance: '12450.50',
          tier: UserTier.VIP,
          country: 'United States',
        }),
      );
      expect(body.meta).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    });

    it('page 2 returns the correct slice, not a repeat of page 1', async () => {
      for (let index = 0; index < 25; index += 1) {
        await seedUser({
          email: `paged${String(index).padStart(2, '0')}@example.com`,
          phone: `+1666000${String(index).padStart(4, '0')}`,
        });
      }

      const token = await adminToken();

      const page1 = await request(server())
        .get('/api/users?sortBy=email&sortOrder=asc&limit=10&page=1')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const page2 = await request(server())
        .get('/api/users?sortBy=email&sortOrder=asc&limit=10&page=2')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const emailsOf = (body: ListBody) => body.data.map((row) => row.email);

      expect(emailsOf(page1.body as ListBody)[0]).toBe('paged00@example.com');
      expect(emailsOf(page2.body as ListBody)).toEqual([
        'paged10@example.com',
        'paged11@example.com',
        'paged12@example.com',
        'paged13@example.com',
        'paged14@example.com',
        'paged15@example.com',
        'paged16@example.com',
        'paged17@example.com',
        'paged18@example.com',
        'paged19@example.com',
      ]);
      expect((page2.body as ListBody).meta).toEqual({
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
      });
    });

    it('rejects limit=500 with 400 instead of silently clamping', async () => {
      const token = await adminToken();

      await request(server())
        .get('/api/users?limit=500')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it.each([
      ['firstName', 'MITCH'],
      ['lastName', 'chell'],
      ['email', 'MITCHELL@EMA'],
      ['phone', '5559876'],
    ])('search matches %s case-insensitively', async (_field, term) => {
      await seedUser({
        firstName: 'Mitchell',
        lastName: 'Mitchell',
        email: 'target.mitchell@email.com',
        phone: '+15559876543',
      });
      await seedUser({
        firstName: 'Zoe',
        lastName: 'Adams',
        email: 'zoe@example.com',
        phone: '+14440001111',
      });

      const token = await adminToken();
      const response = await request(server())
        .get(`/api/users?search=${encodeURIComponent(term)}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.email).toBe('target.mitchell@email.com');
    });

    it('excludes soft-deleted users by default and shows them for status=DELETED', async () => {
      await seedUser({ email: 'alive@example.com' });
      await seedUser({
        email: 'gone@example.com',
        status: UserStatus.DELETED,
        deletedAt: new Date(),
      });

      const token = await adminToken();

      const defaultList = await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        (defaultList.body as ListBody).data.map((row) => row.email),
      ).toEqual(['alive@example.com']);

      const deletedList = await request(server())
        .get('/api/users?status=DELETED')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        (deletedList.body as ListBody).data.map((row) => row.email),
      ).toEqual(['gone@example.com']);
    });

    it('applies status, tier and source filters in combination', async () => {
      await seedUser({
        email: 'match@example.com',
        status: UserStatus.SUSPENDED,
        tier: UserTier.VIP,
        source: UserSource.ADMIN,
      });
      await seedUser({
        email: 'wrong-tier@example.com',
        status: UserStatus.SUSPENDED,
        tier: UserTier.PLAYER,
        source: UserSource.ADMIN,
      });
      await seedUser({
        email: 'wrong-source@example.com',
        status: UserStatus.SUSPENDED,
        tier: UserTier.VIP,
        source: UserSource.WEBHOOK,
      });

      const token = await adminToken();
      const response = await request(server())
        .get('/api/users?status=SUSPENDED&tier=VIP&source=ADMIN')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.meta.total).toBe(1);
      expect(body.data[0]?.email).toBe('match@example.com');
    });

    it('filters on a createdAt range, treating createdTo as the whole day', async () => {
      await seedUser({
        email: 'january@example.com',
        createdAt: new Date('2026-01-15T12:00:00.000Z'),
      });
      await seedUser({
        email: 'march@example.com',
        createdAt: new Date('2026-03-31T23:30:00.000Z'),
      });
      await seedUser({
        email: 'april@example.com',
        createdAt: new Date('2026-04-02T00:00:00.000Z'),
      });

      const token = await adminToken();
      const response = await request(server())
        .get('/api/users?createdFrom=2026-02-01&createdTo=2026-03-31')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as ListBody).data.map((row) => row.email)).toEqual([
        'march@example.com',
      ]);
    });

    it('rejects an unknown status value with 400', async () => {
      const token = await adminToken();

      await request(server())
        .get('/api/users?status=BANNED')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('ignores a sortBy outside the allowlist rather than failing', async () => {
      await seedUser();

      const token = await adminToken();
      const response = await request(server())
        .get('/api/users?sortBy=password')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as ListBody).data).toHaveLength(1);
    });

    it('is reachable by SUPPORT, which holds users.view', async () => {
      const token = await supportToken();

      await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });
  });

  describe('GET /api/users/stats', () => {
    it('returns 401 without a token', async () => {
      await request(server()).get('/api/users/stats').expect(401);
    });

    it('is matched as its own route, not as /users/:id', async () => {
      await seedUser({ status: UserStatus.ACTIVE, tier: UserTier.VIP });
      await seedUser({ status: UserStatus.SUSPENDED, tier: UserTier.PLAYER });
      await seedUser({ status: UserStatus.PENDING, source: UserSource.ADMIN });
      await seedUser({
        status: UserStatus.DELETED,
        deletedAt: new Date(),
      });

      const token = await adminToken();
      const response = await request(server())
        .get('/api/users/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const { data } = response.body as StatsBody;

      // Soft-deleted rows are excluded from every figure.
      expect(data.total).toBe(3);
      expect(data.active).toBe(1);
      expect(data.suspended).toBe(1);
      expect(data.pending).toBe(1);
      expect(data.newThisMonth).toBe(3);
      expect(data.bySource).toEqual({ ADMIN: 1, WEBHOOK: 2 });
      expect(data.byTier).toEqual({ PLAYER: 2, PREMIUM: 0, VIP: 1 });
    });
  });

  describe('GET /api/users/:id', () => {
    it('returns 401 without a token', async () => {
      await request(server()).get(`/api/users/${UNKNOWN_ID}`).expect(401);
    });

    it('returns the user', async () => {
      const user = await seedUser({
        firstName: 'Sarah',
        lastName: 'Chen',
        balance: new Prisma.Decimal('25.5'),
      });

      const token = await adminToken();
      const response = await request(server())
        .get(`/api/users/${user.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as ItemBody).data).toEqual(
        expect.objectContaining({
          id: user.id,
          fullName: 'Sarah Chen',
          initials: 'SC',
          balance: '25.50',
        }),
      );
    });

    it('returns 404 for an unknown id', async () => {
      const token = await adminToken();

      await request(server())
        .get(`/api/users/${UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns 400 for an id that is not a UUID', async () => {
      const token = await adminToken();

      await request(server())
        .get('/api/users/not-a-uuid')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });

  describe('POST /api/users', () => {
    const payload = {
      fullName: 'John Mitchell',
      email: 'john.mitchell@email.com',
      mobileNumber: '+15555551234',
      tier: UserTier.PREMIUM,
      initialBalance: 100,
      addressLine1: '123 Main St',
      addressLine2: 'Apt 4B',
      city: 'New York',
      state: 'NY',
      postalCode: '10001',
      country: 'United States',
    };

    it('returns 401 without a token', async () => {
      await request(server()).post('/api/users').send(payload).expect(401);
    });

    it('returns 403 for an admin without users.manage', async () => {
      const token = await supportToken();

      const response = await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send(payload)
        .expect(403);

      expect(JSON.stringify(response.body)).toContain('users.manage');
    });

    it('creates the user and writes the split name, source and audit fields', async () => {
      const token = await adminToken();

      const response = await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send(payload)
        .expect(201);

      const { data } = response.body as ItemBody;

      expect(data).toEqual(
        expect.objectContaining({
          firstName: 'John',
          lastName: 'Mitchell',
          fullName: 'John Mitchell',
          initials: 'JM',
          source: UserSource.ADMIN,
          status: UserStatus.ACTIVE,
          tier: UserTier.PREMIUM,
          balance: '100.00',
        }),
      );

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: data.id },
      });

      expect(stored.firstName).toBe('John');
      expect(stored.lastName).toBe('Mitchell');
      expect(stored.email).toBe('john.mitchell@email.com');
      expect(stored.phone).toBe('+15555551234');
      expect(stored.source).toBe(UserSource.ADMIN);
      expect(stored.balance.toFixed(2)).toBe('100.00');
      expect(stored.city).toBe('New York');
      expect(stored.createdByAdminId).not.toBeNull();
    });

    it('keeps everything after the first space as the last name', async () => {
      const token = await adminToken();

      const response = await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send({ fullName: 'Mary Jane Watson', email: 'mary@example.com' })
        .expect(201);

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: (response.body as ItemBody).data.id },
      });

      expect(stored.firstName).toBe('Mary');
      expect(stored.lastName).toBe('Jane Watson');
    });

    it('accepts a single-word name and stores an empty last name', async () => {
      const token = await adminToken();

      const response = await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send({ fullName: 'Cher', email: 'cher@example.com' })
        .expect(201);

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: (response.body as ItemBody).data.id },
      });

      expect(stored.firstName).toBe('Cher');
      expect(stored.lastName).toBe('');
    });

    it.each([
      ['a missing fullName', { email: 'a@example.com' }],
      ['a malformed email', { fullName: 'John M', email: 'not-an-email' }],
      [
        'a negative initialBalance',
        { fullName: 'John M', email: 'a@example.com', initialBalance: -1 },
      ],
      [
        'an unknown tier',
        { fullName: 'John M', email: 'a@example.com', tier: 'LEGEND' },
      ],
      [
        'an unknown property',
        { fullName: 'John M', email: 'a@example.com', status: 'ACTIVE' },
      ],
      [
        'an attempt to set source directly',
        { fullName: 'John M', email: 'a@example.com', source: 'WEBHOOK' },
      ],
      [
        'an attempt to set balance directly',
        { fullName: 'John M', email: 'a@example.com', balance: 1000 },
      ],
    ])('returns 400 for %s', async (_label, body) => {
      const token = await adminToken();

      await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);

      expect(await testPrisma.user.count()).toBe(0);
    });

    it('returns 409 for a duplicate email, case-insensitively', async () => {
      await seedUser({ email: 'taken@example.com' });

      const token = await adminToken();

      await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send({ fullName: 'John Mitchell', email: 'TAKEN@example.com' })
        .expect(409);

      expect(await testPrisma.user.count()).toBe(1);
    });

    it('returns 409 for a duplicate phone', async () => {
      await seedUser({ phone: '+15551110000' });

      const token = await adminToken();

      await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fullName: 'John Mitchell',
          email: 'fresh@example.com',
          mobileNumber: '+15551110000',
        })
        .expect(409);

      expect(await testPrisma.user.count()).toBe(1);
    });
  });

  describe('PATCH /api/users/:id', () => {
    it('returns 401 without a token', async () => {
      await request(server())
        .patch(`/api/users/${UNKNOWN_ID}`)
        .send({ city: 'Chicago' })
        .expect(401);
    });

    it('returns 403 for an admin without users.manage', async () => {
      const user = await seedUser();
      const token = await supportToken();

      await request(server())
        .patch(`/api/users/${user.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ city: 'Chicago' })
        .expect(403);
    });

    it('updates the record and persists the change', async () => {
      const user = await seedUser({ firstName: 'Old', lastName: 'Name' });
      const token = await adminToken();

      await request(server())
        .patch(`/api/users/${user.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ fullName: 'New Name Here', city: 'Chicago', tier: 'VIP' })
        .expect(200);

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(stored.firstName).toBe('New');
      expect(stored.lastName).toBe('Name Here');
      expect(stored.city).toBe('Chicago');
      expect(stored.tier).toBe(UserTier.VIP);
    });

    it('returns 400 when asked to change status, balance or source', async () => {
      const user = await seedUser();
      const token = await adminToken();

      for (const body of [
        { status: UserStatus.SUSPENDED },
        { balance: 5000 },
        { source: UserSource.WEBHOOK },
      ]) {
        await request(server())
          .patch(`/api/users/${user.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send(body)
          .expect(400);
      }

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(stored.status).toBe(UserStatus.ACTIVE);
      expect(stored.balance.toFixed(2)).toBe('0.00');
      expect(stored.source).toBe(UserSource.WEBHOOK);
    });

    it('returns 404 for an unknown id', async () => {
      const token = await adminToken();

      await request(server())
        .patch(`/api/users/${UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ city: 'Chicago' })
        .expect(404);
    });

    it('returns 409 when the new email belongs to someone else', async () => {
      const [first, second] = await Promise.all([
        seedUser({ email: 'first@example.com' }),
        seedUser({ email: 'second@example.com' }),
      ]);

      const token = await adminToken();

      await request(server())
        .patch(`/api/users/${first.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ email: second.email })
        .expect(409);
    });
  });

  describe('PATCH /api/users/:id/suspend', () => {
    it('returns 401 without a token', async () => {
      await request(server())
        .patch(`/api/users/${UNKNOWN_ID}/suspend`)
        .send({ reason: 'Suspected fraudulent activity' })
        .expect(401);
    });

    it('returns 403 for an admin without users.manage', async () => {
      const user = await seedUser();
      const token = await supportToken();

      await request(server())
        .patch(`/api/users/${user.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Suspected fraudulent activity' })
        .expect(403);
    });

    it('suspends the user', async () => {
      const user = await seedUser();
      const token = await adminToken();

      const response = await request(server())
        .patch(`/api/users/${user.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Suspected fraudulent activity' })
        .expect(200);

      expect((response.body as ItemBody).data.status).toBe(
        UserStatus.SUSPENDED,
      );

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(stored.status).toBe(UserStatus.SUSPENDED);
    });

    it.each([
      ['a missing reason', {}],
      ['a reason under three characters', { reason: 'no' }],
    ])('returns 400 for %s', async (_label, body) => {
      const user = await seedUser();
      const token = await adminToken();

      await request(server())
        .patch(`/api/users/${user.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(stored.status).toBe(UserStatus.ACTIVE);
    });

    it('returns 404 for an unknown id', async () => {
      const token = await adminToken();

      await request(server())
        .patch(`/api/users/${UNKNOWN_ID}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Suspected fraudulent activity' })
        .expect(404);
    });
  });

  describe('PATCH /api/users/:id/activate', () => {
    it('returns 401 without a token', async () => {
      await request(server())
        .patch(`/api/users/${UNKNOWN_ID}/activate`)
        .expect(401);
    });

    it('returns 403 for an admin without users.manage', async () => {
      const user = await seedUser({ status: UserStatus.SUSPENDED });
      const token = await supportToken();

      await request(server())
        .patch(`/api/users/${user.id}/activate`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('returns a suspended user to ACTIVE', async () => {
      const user = await seedUser({ status: UserStatus.SUSPENDED });
      const token = await adminToken();

      await request(server())
        .patch(`/api/users/${user.id}/activate`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(stored.status).toBe(UserStatus.ACTIVE);
    });

    it('returns 422 when the user was soft-deleted', async () => {
      const user = await seedUser({
        status: UserStatus.DELETED,
        deletedAt: new Date(),
      });
      const token = await adminToken();

      await request(server())
        .patch(`/api/users/${user.id}/activate`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);
    });

    it('returns 404 for an unknown id', async () => {
      const token = await adminToken();

      await request(server())
        .patch(`/api/users/${UNKNOWN_ID}/activate`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  describe('DELETE /api/users/:id', () => {
    it('returns 401 without a token', async () => {
      await request(server()).delete(`/api/users/${UNKNOWN_ID}`).expect(401);
    });

    it('returns 403 for an admin without users.manage', async () => {
      const user = await seedUser();
      const token = await supportToken();

      await request(server())
        .delete(`/api/users/${user.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('soft-deletes with 204: the row survives with deletedAt and status set', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('75.00') });
      const token = await adminToken();

      await request(server())
        .delete(`/api/users/${user.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const stored = await testPrisma.user.findUnique({
        where: { id: user.id },
      });

      expect(stored).not.toBeNull();
      expect(stored?.status).toBe(UserStatus.DELETED);
      expect(stored?.deletedAt).toBeInstanceOf(Date);
      // Financial history is exactly what the soft delete exists to protect.
      expect(stored?.balance.toFixed(2)).toBe('75.00');

      const list = await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((list.body as ListBody).data).toHaveLength(0);
    });

    it('returns 404 for an unknown id', async () => {
      const token = await adminToken();

      await request(server())
        .delete(`/api/users/${UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  describe('GET /api/users/:id/balance', () => {
    it('returns 401 without a token', async () => {
      await request(server())
        .get(`/api/users/${UNKNOWN_ID}/balance`)
        .expect(401);
    });

    it('returns the balance as a two-decimal string', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('1234.5') });
      const token = await adminToken();

      const response = await request(server())
        .get(`/api/users/${user.id}/balance`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as BalanceBody).data).toEqual({
        userId: user.id,
        balance: '1234.50',
      });
    });

    it('is readable by SUPPORT, which holds users.view', async () => {
      const user = await seedUser();
      const token = await supportToken();

      await request(server())
        .get(`/api/users/${user.id}/balance`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('returns 404 for an unknown id', async () => {
      const token = await adminToken();

      await request(server())
        .get(`/api/users/${UNKNOWN_ID}/balance`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  describe('POST /api/users/:id/balance/adjust', () => {
    it('returns 401 without a token', async () => {
      await request(server())
        .post(`/api/users/${UNKNOWN_ID}/balance/adjust`)
        .send({ amount: 10, reason: 'Goodwill credit' })
        .expect(401);
    });

    it('returns 403 for an admin without users.manage', async () => {
      const user = await seedUser();
      const token = await supportToken();

      await request(server())
        .post(`/api/users/${user.id}/balance/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 10, reason: 'Goodwill credit' })
        .expect(403);
    });

    it('credits a positive amount and persists it', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('100.00') });
      const token = await adminToken();

      const response = await request(server())
        .post(`/api/users/${user.id}/balance/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 50.25, reason: 'Goodwill credit' })
        .expect(200);

      expect((response.body as BalanceBody).data).toEqual(
        expect.objectContaining({
          previousBalance: '100.00',
          amount: '50.25',
          balance: '150.25',
        }),
      );

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(stored.balance.toFixed(2)).toBe('150.25');
    });

    it('debits a negative amount and persists it', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('1000.00') });
      const token = await adminToken();

      await request(server())
        .post(`/api/users/${user.id}/balance/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: -500, reason: 'Chargeback on deposit #1234' })
        .expect(200);

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(stored.balance.toFixed(2)).toBe('500.00');
    });

    it('returns 422 when the result would go below zero, leaving the balance untouched', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('100.00') });
      const token = await adminToken();

      await request(server())
        .post(`/api/users/${user.id}/balance/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: -100.01, reason: 'Chargeback on deposit #1234' })
        .expect(422);

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(stored.balance.toFixed(2)).toBe('100.00');
    });

    it('allows a debit that lands exactly on zero', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('100.00') });
      const token = await adminToken();

      await request(server())
        .post(`/api/users/${user.id}/balance/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: -100, reason: 'Full refund' })
        .expect(200);

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(stored.balance.toFixed(2)).toBe('0.00');
    });

    it.each([
      ['a missing reason', { amount: 10 }],
      ['a missing amount', { reason: 'Goodwill credit' }],
      ['a reason under three characters', { amount: 10, reason: 'no' }],
      [
        'more than two decimal places',
        { amount: 1.005, reason: 'Rounding error' },
      ],
    ])('returns 400 for %s', async (_label, body) => {
      const user = await seedUser({ balance: new Prisma.Decimal('10.00') });
      const token = await adminToken();

      await request(server())
        .post(`/api/users/${user.id}/balance/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(stored.balance.toFixed(2)).toBe('10.00');
    });

    it('returns 404 for an unknown id', async () => {
      const token = await adminToken();

      await request(server())
        .post(`/api/users/${UNKNOWN_ID}/balance/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 10, reason: 'Goodwill credit' })
        .expect(404);
    });
  });

  describe('GET /api/users/export', () => {
    it('returns 401 without a token', async () => {
      await request(server()).get('/api/users/export').expect(401);
    });

    it('returns CSV outside the JSON envelope, with a download filename', async () => {
      await seedUser({
        firstName: 'John',
        lastName: 'Mitchell',
        email: 'john.mitchell@email.com',
        balance: new Prisma.Decimal('12450.5'),
      });

      const token = await adminToken();
      const response = await request(server())
        .get('/api/users/export')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/csv/);
      expect(response.headers['content-disposition']).toMatch(
        /attachment; filename="users-export-\d{4}-\d{2}-\d{2}\.csv"/,
      );

      const lines = response.text.trim().split('\n');

      expect(lines[0]).toContain('"id","firstName","lastName","fullName"');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('"John"');
      expect(lines[1]).toContain('"John Mitchell"');
      expect(lines[1]).toContain('"12450.50"');
      // Raw CSV, never { success: true, data: ... }
      expect(response.text).not.toContain('"success"');
    });

    it('honours the same filters as GET /users', async () => {
      await seedUser({
        email: 'suspended@example.com',
        status: UserStatus.SUSPENDED,
      });
      await seedUser({ email: 'active1@example.com' });
      await seedUser({ email: 'active2@example.com' });

      const token = await adminToken();
      const response = await request(server())
        .get('/api/users/export?status=SUSPENDED')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const lines = response.text.trim().split('\n');

      expect(lines).toHaveLength(2);
      expect(response.text).toContain('suspended@example.com');
      expect(response.text).not.toContain('active1@example.com');
    });

    it('excludes soft-deleted users, as the list does', async () => {
      await seedUser({ email: 'alive@example.com' });
      await seedUser({
        email: 'gone@example.com',
        status: UserStatus.DELETED,
        deletedAt: new Date(),
      });

      const token = await adminToken();
      const response = await request(server())
        .get('/api/users/export')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.text).toContain('alive@example.com');
      expect(response.text).not.toContain('gone@example.com');
    });

    it('is matched as its own route, not as /users/:id', async () => {
      const token = await adminToken();

      const response = await request(server())
        .get('/api/users/export')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/csv/);
    });

    it('is reachable by SUPPORT, which holds users.view', async () => {
      const token = await supportToken();

      await request(server())
        .get('/api/users/export')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('returns 400 for an invalid filter', async () => {
      const token = await adminToken();

      await request(server())
        .get('/api/users/export?status=BANNED')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });
});
