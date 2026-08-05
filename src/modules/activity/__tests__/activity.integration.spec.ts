import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import { ActivityCategory, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';

/**
 * Every seeded role holds `activity.view` (prisma/seed/role-permissions.seed.ts),
 * so the 403 case needs a role that genuinely lacks it. Created here rather than
 * added to the seed: production has no use for a role whose only purpose is to
 * be refused.
 */
const RESTRICTED_ROLE = 'TEST_NO_ACTIVITY';

const RESTRICTED_ADMIN = {
  email: 'restricted.activity@bjspades.com',
  password: 'Restricted123!',
};

/** Deleted mid-test to prove `onDelete: SetNull`, so it gets its own account. */
const DOOMED_ADMIN = {
  email: 'doomed.activity@bjspades.com',
  password: 'Doomed123!',
};

interface LoginBody {
  data: { accessToken: string };
}

interface ActivityRow {
  id: string;
  category: ActivityCategory;
  action: string;
  title: string;
  description: string | null;
  admin: { id: string; fullName: string } | null;
  entityType: string | null;
  entityId: string | null;
  isHighPriority: boolean;
  createdAt: string;
}

interface ListBody {
  success: true;
  data: ActivityRow[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface RecentBody {
  success: true;
  data: ActivityRow[];
}

interface CreatedUserBody {
  success: true;
  data: { id: string; fullName: string; email: string };
}

let fixtureCounter = 0;

function activityFixture(
  overrides: Partial<Prisma.ActivityLogUncheckedCreateInput> = {},
): Prisma.ActivityLogUncheckedCreateInput {
  fixtureCounter += 1;

  return {
    category: ActivityCategory.USER,
    action: 'user.created',
    title: `Fixture entry ${fixtureCounter}`,
    isHighPriority: false,
    ...overrides,
  };
}

async function seedActivity(
  overrides: Partial<Prisma.ActivityLogUncheckedCreateInput> = {},
) {
  return testPrisma.activityLog.create({ data: activityFixture(overrides) });
}

/**
 * AuditInterceptor writes fire-and-forget, so a 201 does not mean the entry has
 * landed yet. Polling is what the design costs: the alternative is awaiting the
 * insert on the response path, which PHASE-2 rules out.
 */
async function waitForActivity(
  where: Prisma.ActivityLogWhereInput,
  expected = 1,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const count = await testPrisma.activityLog.count({ where });

    if (count >= expected) return;

    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${expected} activity entries matching ${JSON.stringify(where)}; saw ${count}.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('Activity Log API (integration)', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();

    const dashboardView = await testPrisma.permission.findUniqueOrThrow({
      where: { code: 'dashboard.view' },
    });

    const restrictedRole = await testPrisma.role.upsert({
      where: { name: RESTRICTED_ROLE },
      update: {},
      create: {
        name: RESTRICTED_ROLE,
        displayName: 'Test role without activity.view',
      },
    });

    await testPrisma.rolePermission.deleteMany({
      where: { roleId: restrictedRole.id },
    });

    await testPrisma.rolePermission.create({
      data: { roleId: restrictedRole.id, permissionId: dashboardView.id },
    });

    const superAdminRole = await testPrisma.role.findUniqueOrThrow({
      where: { name: 'SUPER_ADMIN' },
    });

    await testPrisma.admin.upsert({
      where: { email: RESTRICTED_ADMIN.email },
      update: {
        password: await bcrypt.hash(RESTRICTED_ADMIN.password, 10),
        roleId: restrictedRole.id,
        isActive: true,
      },
      create: {
        firstName: 'Restricted',
        lastName: 'Viewer',
        email: RESTRICTED_ADMIN.email,
        password: await bcrypt.hash(RESTRICTED_ADMIN.password, 10),
        roleId: restrictedRole.id,
        isActive: true,
      },
    });

    await testPrisma.admin.upsert({
      where: { email: DOOMED_ADMIN.email },
      update: {
        password: await bcrypt.hash(DOOMED_ADMIN.password, 10),
        roleId: superAdminRole.id,
        isActive: true,
      },
      create: {
        firstName: 'Doomed',
        lastName: 'Admin',
        email: DOOMED_ADMIN.email,
        password: await bcrypt.hash(DOOMED_ADMIN.password, 10),
        roleId: superAdminRole.id,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    await testPrisma.admin.deleteMany({
      where: { email: { in: [RESTRICTED_ADMIN.email, DOOMED_ADMIN.email] } },
    });

    const role = await testPrisma.role.findUnique({
      where: { name: RESTRICTED_ROLE },
    });

    if (role) {
      await testPrisma.rolePermission.deleteMany({
        where: { roleId: role.id },
      });
      await testPrisma.role.delete({ where: { id: role.id } });
    }

    await app?.close();
  });

  /** Signed in per test: setup.ts truncates Session before every one. */
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

  describe('authorisation', () => {
    it('returns 401 for GET /api/activity with no token', async () => {
      await request(server()).get('/api/activity').expect(401);
    });

    it('returns 401 for GET /api/activity/recent with no token', async () => {
      await request(server()).get('/api/activity/recent').expect(401);
    });

    it('returns 403 naming activity.view for a role without it', async () => {
      const token = await tokenFor(RESTRICTED_ADMIN);

      const response = await request(server())
        .get('/api/activity')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(JSON.stringify(response.body)).toContain('activity.view');
    });

    it('lets a permitted admin through', async () => {
      const token = await tokenFor(SEEDED_ADMIN);

      await request(server())
        .get('/api/activity')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });
  });

  describe('writing entries', () => {
    it('records exactly one USER entry when a user is created', async () => {
      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fullName: 'Ada Lovelace',
          email: 'ada.activity@example.com',
        })
        .expect(201);

      const created = (response.body as CreatedUserBody).data;

      await waitForActivity({ entityType: 'User', entityId: created.id });

      const entries = await testPrisma.activityLog.findMany({
        where: { entityType: 'User', entityId: created.id },
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        category: ActivityCategory.USER,
        action: 'user.created',
        title: 'New user Ada Lovelace created',
        entityType: 'User',
        entityId: created.id,
        isHighPriority: false,
      });
      expect(entries[0]?.adminId).not.toBeNull();
    });

    it('never writes a password into metadata', async () => {
      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fullName: 'Grace Hopper',
          email: 'grace.activity@example.com',
        })
        .expect(201);

      const created = (response.body as CreatedUserBody).data;

      await waitForActivity({ entityId: created.id });

      const entry = await testPrisma.activityLog.findFirstOrThrow({
        where: { entityId: created.id },
      });

      expect(JSON.stringify(entry.metadata)).not.toMatch(/password/i);
    });

    // The write lives inside the same $transaction as the user, so it has
    // already committed by the time the 200 arrives — no polling needed, and
    // that is exactly the guarantee being asserted.
    it('records a WEBHOOK entry in the same transaction as the user', async () => {
      const secret = process.env.WEBHOOK_SECRET;

      if (!secret) {
        throw new Error('WEBHOOK_SECRET missing — is .env.test loaded?');
      }

      const rawBody = JSON.stringify({
        event: 'user.registration',
        data: {
          fullName: 'David Kim',
          email: 'david.kim.activity@email.com',
        },
      });

      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');

      const response = await request(server())
        .post('/api/webhooks/user-registration')
        .set('Content-Type', 'application/json')
        .set('X-BJS-Signature', `sha256=${signature}`)
        .set('X-BJS-Timestamp', String(timestamp))
        .set('X-BJS-Event-Id', randomUUID())
        .set('X-BJS-Source', 'bjspades-signup-form')
        .send(rawBody)
        .expect(200);

      const userId = (
        response.body as { data: { status: string; userId?: string } }
      ).data.userId;

      expect(userId).toBeDefined();

      const entries = await testPrisma.activityLog.findMany({
        where: { action: 'webhook.user_created' },
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        category: ActivityCategory.WEBHOOK,
        title: 'New user David Kim registered',
        description: 'Created via webhook from bjspades-signup-form',
        entityType: 'User',
        entityId: userId,
        // No admin: the actor is the external signup form.
        adminId: null,
        isHighPriority: false,
      });
    });

    it('records a high-priority WEBHOOK entry when an event fails', async () => {
      const secret = process.env.WEBHOOK_SECRET;

      if (!secret) {
        throw new Error('WEBHOOK_SECRET missing — is .env.test loaded?');
      }

      // Valid signature, unusable payload: stored as FAILED and audited.
      const rawBody = JSON.stringify({ event: 'user.registration', data: {} });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');

      await request(server())
        .post('/api/webhooks/user-registration')
        .set('Content-Type', 'application/json')
        .set('X-BJS-Signature', `sha256=${signature}`)
        .set('X-BJS-Timestamp', String(timestamp))
        .set('X-BJS-Event-Id', randomUUID())
        .set('X-BJS-Source', 'bjspades-signup-form')
        .send(rawBody)
        .expect(200);

      await waitForActivity({ action: 'webhook.failed' });

      const entry = await testPrisma.activityLog.findFirstOrThrow({
        where: { action: 'webhook.failed' },
      });

      expect(entry.isHighPriority).toBe(true);
      expect(entry.entityType).toBe('WebhookEvent');
    });

    it('records a high-priority entry with a null adminId for a failed login', async () => {
      await request(server())
        .post('/api/auth/login')
        .send({ email: SEEDED_ADMIN.email, password: 'DefinitelyWrong1!' })
        .expect(401);

      const entries = await testPrisma.activityLog.findMany({
        where: { action: 'auth.login_failed' },
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        category: ActivityCategory.AUTH,
        isHighPriority: true,
        adminId: null,
      });
      expect(entries[0]?.description).toContain(SEEDED_ADMIN.email);
      expect(JSON.stringify(entries[0])).not.toContain('DefinitelyWrong1!');
    });

    it('records a successful login', async () => {
      await tokenFor(SEEDED_ADMIN);

      const entry = await testPrisma.activityLog.findFirstOrThrow({
        where: { action: 'auth.login' },
      });

      expect(entry.category).toBe(ActivityCategory.AUTH);
      expect(entry.adminId).not.toBeNull();
      expect(entry.title).toContain(SEEDED_ADMIN.email);
    });

    it('records a logout', async () => {
      const token = await tokenFor(SEEDED_ADMIN);

      await request(server())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await waitForActivity({ action: 'auth.logout' });

      const entry = await testPrisma.activityLog.findFirstOrThrow({
        where: { action: 'auth.logout' },
      });

      expect(entry.adminId).not.toBeNull();
    });

    // onDelete: SetNull is what stops removing an admin from erasing the record
    // of what they did.
    it('keeps entries intact with a null adminId when their admin is deleted', async () => {
      const admin = await testPrisma.admin.findUniqueOrThrow({
        where: { email: DOOMED_ADMIN.email },
      });

      await seedActivity({
        adminId: admin.id,
        title: 'Something the doomed admin did',
      });

      await testPrisma.admin.delete({ where: { id: admin.id } });

      const entries = await testPrisma.activityLog.findMany({
        where: { title: 'Something the doomed admin did' },
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]?.adminId).toBeNull();

      // And the API still serves it, with a null admin rather than a crash.
      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get('/api/activity?search=Something the doomed admin did')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rows = (response.body as ListBody).data;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.admin).toBeNull();
    });
  });

  describe('reading entries', () => {
    it('returns the contract row shape with an ISO-8601 createdAt', async () => {
      const admin = await testPrisma.admin.findUniqueOrThrow({
        where: { email: SEEDED_ADMIN.email },
      });

      await seedActivity({
        adminId: admin.id,
        title: 'Shape check',
        description: 'A description',
        entityType: 'User',
        entityId: 'user-abc',
        isHighPriority: true,
      });

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get('/api/activity?search=Shape check')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const row = (response.body as ListBody).data[0];

      expect(row).toEqual({
        id: expect.any(String) as string,
        category: ActivityCategory.USER,
        action: 'user.created',
        title: 'Shape check',
        description: 'A description',
        admin: {
          id: admin.id,
          fullName: `${admin.firstName} ${admin.lastName}`,
        },
        entityType: 'User',
        entityId: 'user-abc',
        isHighPriority: true,
        createdAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        ) as string,
      });
    });

    it('filters by category', async () => {
      await seedActivity({ category: ActivityCategory.USER });
      await seedActivity({
        category: ActivityCategory.TOURNAMENT,
        action: 'tournament.created',
      });
      await seedActivity({
        category: ActivityCategory.TOURNAMENT,
        action: 'tournament.cancelled',
      });

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get('/api/activity?category=TOURNAMENT')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.meta.total).toBe(2);
      expect(
        body.data.every((row) => row.category === ActivityCategory.TOURNAMENT),
      ).toBe(true);
    });

    it('filters by high priority', async () => {
      await seedActivity({ isHighPriority: true, title: 'Urgent' });
      await seedActivity({ isHighPriority: false, title: 'Routine' });

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get('/api/activity?isHighPriority=true')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.data.map((row) => row.title)).toEqual(['Urgent']);
    });

    it('filters by entity', async () => {
      await seedActivity({ entityType: 'User', entityId: 'target-1' });
      await seedActivity({ entityType: 'User', entityId: 'target-2' });

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get('/api/activity?entityType=User&entityId=target-1')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as ListBody).meta.total).toBe(1);
    });

    it('filters by admin', async () => {
      const admin = await testPrisma.admin.findUniqueOrThrow({
        where: { email: SEEDED_ADMIN.email },
      });

      await seedActivity({ adminId: admin.id, title: 'Attributed' });
      await seedActivity({ adminId: null, title: 'Anonymous' });

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get(`/api/activity?adminId=${admin.id}&search=Attributed`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.data.map((row) => row.title)).toEqual(['Attributed']);
    });

    it('searches title and description', async () => {
      await seedActivity({ title: 'Suspected fraud on an account' });
      await seedActivity({
        title: 'Routine change',
        description: 'Reported as FRAUD by support',
      });
      await seedActivity({ title: 'Nothing to see' });

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get('/api/activity?search=fraud')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as ListBody).meta.total).toBe(2);
    });

    // Dates chosen well before "now" so the login entry this test writes cannot
    // drift into the window.
    it('applies a date range inclusively at both ends', async () => {
      await seedActivity({
        title: 'Range start',
        entityType: 'Range',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      await seedActivity({
        title: 'Range middle',
        entityType: 'Range',
        createdAt: new Date('2026-01-02T12:00:00.000Z'),
      });
      await seedActivity({
        title: 'Range end',
        entityType: 'Range',
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
      });
      await seedActivity({
        title: 'Just before',
        entityType: 'Range',
        createdAt: new Date('2025-12-31T23:59:59.999Z'),
      });
      await seedActivity({
        title: 'Just after',
        entityType: 'Range',
        createdAt: new Date('2026-01-03T00:00:00.001Z'),
      });

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get(
          '/api/activity?entityType=Range&from=2026-01-01T00:00:00.000Z&to=2026-01-03T00:00:00.000Z&sortOrder=asc',
        )
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.data.map((row) => row.title)).toEqual([
        'Range start',
        'Range middle',
        'Range end',
      ]);
    });

    it('treats a bare date upper bound as the whole day', async () => {
      await seedActivity({
        title: 'Late in the day',
        entityType: 'Range',
        createdAt: new Date('2026-01-03T23:59:00.000Z'),
      });

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get('/api/activity?entityType=Range&from=2026-01-03&to=2026-01-03')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as ListBody).data.map((row) => row.title)).toEqual([
        'Late in the day',
      ]);
    });

    it('returns newest first by default and paginates', async () => {
      const base = Date.now();

      for (let index = 0; index < 3; index += 1) {
        await seedActivity({
          title: `Ordered ${index}`,
          entityType: 'Ordering',
          createdAt: new Date(base + (index + 1) * 60_000),
        });
      }

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get('/api/activity?entityType=Ordering&limit=2')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.data.map((row) => row.title)).toEqual([
        'Ordered 2',
        'Ordered 1',
      ]);
      expect(body.meta).toEqual({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
    });

    it('rejects a limit above the maximum instead of clamping it', async () => {
      const token = await tokenFor(SEEDED_ADMIN);

      await request(server())
        .get('/api/activity?limit=5000')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });

  describe('GET /api/activity/recent', () => {
    it('returns the five newest entries, newest first', async () => {
      const base = Date.now();

      for (let index = 0; index < 8; index += 1) {
        await seedActivity({
          title: `Recent ${index}`,
          createdAt: new Date(base + (index + 1) * 60_000),
        });
      }

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get('/api/activity/recent?limit=5')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rows = (response.body as RecentBody).data;

      expect(rows).toHaveLength(5);
      expect(rows.map((row) => row.title)).toEqual([
        'Recent 7',
        'Recent 6',
        'Recent 5',
        'Recent 4',
        'Recent 3',
      ]);
    });

    it('defaults to five without a limit', async () => {
      const base = Date.now();

      for (let index = 0; index < 7; index += 1) {
        await seedActivity({
          title: `Default ${index}`,
          createdAt: new Date(base + (index + 1) * 60_000),
        });
      }

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get('/api/activity/recent')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as RecentBody).data).toHaveLength(5);
    });
  });
});
