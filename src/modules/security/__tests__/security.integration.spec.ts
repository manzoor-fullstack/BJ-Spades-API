import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import { ActivityCategory } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';

/** Holds `settings.manage` but not `security.manage` — the split under test. */
const PLAIN_ADMIN = {
  email: 'security.plain@bjspades.com',
  password: 'Admin1234!',
};

const OTHER_ADMIN = {
  email: 'security.other@bjspades.com',
  password: 'Admin1234!',
};

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface LoginBody {
  data: { accessToken: string };
}

interface SessionRow {
  id: string;
  admin: { id: string; fullName: string; email: string };
  device: string | null;
  browser: string | null;
  os: string | null;
  ipAddress: string | null;
  lastActivity: string;
  expiresAt: string;
  isCurrent: boolean;
}

interface SessionsBody {
  success: true;
  data: SessionRow[];
}

interface StatsBody {
  success: true;
  data: {
    activeSessions: number;
    failedLoginsLast24h: number;
    highPriorityAlertsLast7d: number;
  };
}

interface AlertsBody {
  success: true;
  data: {
    id: string;
    action: string;
    title: string;
    isHighPriority: boolean;
    category: ActivityCategory;
  }[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

describe('Security API (integration)', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();

    const [adminRole, superRole] = await Promise.all([
      testPrisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } }),
      testPrisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } }),
    ]);

    for (const [account, roleId, firstName] of [
      [PLAIN_ADMIN, adminRole.id, 'Plain'],
      [OTHER_ADMIN, superRole.id, 'Other'],
    ] as const) {
      const password = await bcrypt.hash(account.password, 10);

      await testPrisma.admin.upsert({
        where: { email: account.email },
        update: { password, roleId, isActive: true },
        create: {
          firstName,
          lastName: 'Admin',
          email: account.email,
          password,
          roleId,
          isActive: true,
        },
      });
    }
  });

  afterAll(async () => {
    await testPrisma.admin.deleteMany({
      where: { email: { in: [PLAIN_ADMIN.email, OTHER_ADMIN.email] } },
    });
    await app?.close();
  });

  /** Sessions are truncated before every test, so tokens are minted per test. */
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

  const sessions = async (token: string): Promise<SessionRow[]> => {
    const response = await request(server())
      .get('/api/security/sessions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    return (response.body as SessionsBody).data;
  };

  describe('authorisation', () => {
    it('returns 401 without a token', async () => {
      await request(server()).get('/api/security/sessions').expect(401);
      await request(server()).get('/api/security/stats').expect(401);
      await request(server()).get('/api/security/alerts').expect(401);
      await request(server())
        .delete(`/api/security/sessions/${UNKNOWN_ID}`)
        .expect(401);
      await request(server()).delete('/api/security/sessions').expect(401);
    });

    it('returns 403 for an admin without security.manage', async () => {
      const token = await tokenFor(PLAIN_ADMIN);
      const auth = { Authorization: `Bearer ${token}` };

      await request(server())
        .get('/api/security/sessions')
        .set(auth)
        .expect(403);
      await request(server()).get('/api/security/stats').set(auth).expect(403);
      await request(server()).get('/api/security/alerts').set(auth).expect(403);
      await request(server())
        .delete(`/api/security/sessions/${UNKNOWN_ID}`)
        .set(auth)
        .expect(403);
      await request(server())
        .delete('/api/security/sessions')
        .set(auth)
        .expect(403);
    });
  });

  describe('GET /api/security/sessions', () => {
    it('lists live sessions across every admin', async () => {
      const token = await adminToken();
      await tokenFor(OTHER_ADMIN);

      const rows = await sessions(token);

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.admin.email).sort()).toEqual(
        [SEEDED_ADMIN.email, OTHER_ADMIN.email].sort(),
      );
    });

    it("flags the caller's own session and no other", async () => {
      const token = await adminToken();
      await tokenFor(OTHER_ADMIN);

      const rows = await sessions(token);

      expect(rows.filter((row) => row.isCurrent)).toHaveLength(1);
      expect(rows.find((row) => row.isCurrent)?.admin.email).toBe(
        SEEDED_ADMIN.email,
      );
    });

    it('reports the device data recorded at sign-in', async () => {
      await request(server())
        .post('/api/auth/login')
        .set(
          'User-Agent',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        )
        .send(SEEDED_ADMIN)
        .expect(200);

      const token = await adminToken();
      const rows = await sessions(token);
      const chrome = rows.find((row) => row.browser?.startsWith('Chrome'));

      expect(chrome).toMatchObject({ device: 'Desktop' });
      expect(chrome?.os).toContain('Windows');
      expect(chrome?.ipAddress).toBeTruthy();
    });

    it('omits a session that has been revoked', async () => {
      const token = await adminToken();
      const otherToken = await tokenFor(OTHER_ADMIN);

      const target = (await sessions(token)).find((row) => !row.isCurrent);

      await request(server())
        .delete(`/api/security/sessions/${target?.id ?? UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const remaining = await sessions(token);

      expect(remaining.map((row) => row.id)).not.toContain(target?.id);
      expect(otherToken).toBeTruthy();
    });
  });

  describe('DELETE /api/security/sessions/:id', () => {
    it("rejects the revoked session's token on its very next request", async () => {
      // Phase 1.1 made JwtStrategy resolve the session per request, so this is
      // immediate rather than "within 15 minutes". The access token below is
      // still well inside its 15-minute lifetime.
      const token = await adminToken();
      const victimToken = await tokenFor(OTHER_ADMIN);

      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${victimToken}`)
        .expect(200);

      const victim = (await sessions(token)).find(
        (row) => row.admin.email === OTHER_ADMIN.email,
      );

      await request(server())
        .delete(`/api/security/sessions/${victim?.id ?? UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${victimToken}`)
        .expect(401);
    });

    it("revokes the session's refresh tokens with it", async () => {
      const token = await adminToken();
      await tokenFor(OTHER_ADMIN);

      const victim = (await sessions(token)).find(
        (row) => row.admin.email === OTHER_ADMIN.email,
      );

      await request(server())
        .delete(`/api/security/sessions/${victim?.id ?? UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const live = await testPrisma.refreshToken.count({
        where: { sessionId: victim?.id, revokedAt: null },
      });

      expect(live).toBe(0);
    });

    it('writes a security.session_revoked audit entry', async () => {
      const token = await adminToken();
      await tokenFor(OTHER_ADMIN);

      const victim = (await sessions(token)).find(
        (row) => row.admin.email === OTHER_ADMIN.email,
      );

      await request(server())
        .delete(`/api/security/sessions/${victim?.id ?? UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await waitForActivity({ action: 'security.session_revoked' });

      const entry = await testPrisma.activityLog.findFirstOrThrow({
        where: { action: 'security.session_revoked' },
        orderBy: { createdAt: 'desc' },
      });

      expect(entry.category).toBe(ActivityCategory.SECURITY);
      expect(entry.isHighPriority).toBe(true);
      expect(entry.entityId).toBe(victim?.id);
      expect(entry.metadata).toMatchObject({ scope: 'one' });
    });

    it("refuses to revoke the caller's own session", async () => {
      const token = await adminToken();

      const own = (await sessions(token)).find((row) => row.isCurrent);

      await request(server())
        .delete(`/api/security/sessions/${own?.id ?? UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);

      // Still signed in.
      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('404s for a session that does not exist', async () => {
      const token = await adminToken();

      await request(server())
        .delete(`/api/security/sessions/${UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  describe('DELETE /api/security/sessions', () => {
    it('signs every other device out and leaves the caller signed in', async () => {
      const token = await adminToken();
      const otherToken = await tokenFor(OTHER_ADMIN);
      const plainToken = await tokenFor(PLAIN_ADMIN);

      const response = await request(server())
        .delete('/api/security/sessions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        (response.body as { data: { revoked: number } }).data.revoked,
      ).toBe(2);

      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(401);

      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${plainToken}`)
        .expect(401);
    });

    it('leaves exactly one live session behind', async () => {
      const token = await adminToken();
      await tokenFor(OTHER_ADMIN);

      await request(server())
        .delete('/api/security/sessions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rows = await sessions(token);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.isCurrent).toBe(true);
    });
  });

  describe('GET /api/security/stats', () => {
    it('counts live sessions, failed sign-ins and high-priority events', async () => {
      await request(server())
        .post('/api/auth/login')
        .send({ email: SEEDED_ADMIN.email, password: 'WrongPassword1!' })
        .expect(401);

      const token = await adminToken();
      await tokenFor(OTHER_ADMIN);

      const response = await request(server())
        .get('/api/security/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const { data } = response.body as StatsBody;

      expect(data.activeSessions).toBe(2);
      expect(data.failedLoginsLast24h).toBe(1);
      expect(data.highPriorityAlertsLast7d).toBeGreaterThanOrEqual(1);
    });

    it('returns exactly three figures, and no invented ones', async () => {
      // D-04 no security score, D-05 no blocked IPs, D-07 no verified sessions.
      const token = await adminToken();

      const response = await request(server())
        .get('/api/security/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(Object.keys((response.body as StatsBody).data).sort()).toEqual([
        'activeSessions',
        'failedLoginsLast24h',
        'highPriorityAlertsLast7d',
      ]);
    });

    it('does not count an expired session as active', async () => {
      const token = await adminToken();

      await testPrisma.session.create({
        data: {
          adminId: (
            await testPrisma.admin.findUniqueOrThrow({
              where: { email: OTHER_ADMIN.email },
              select: { id: true },
            })
          ).id,
          expiresAt: new Date(Date.now() - 60_000),
        },
      });

      const response = await request(server())
        .get('/api/security/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as StatsBody).data.activeSessions).toBe(1);
    });
  });

  describe('GET /api/security/alerts', () => {
    it('reads real events from the activity log', async () => {
      // D-06: failed sign-ins are recorded by AuthService on the throwing path.
      await request(server())
        .post('/api/auth/login')
        .send({ email: SEEDED_ADMIN.email, password: 'WrongPassword1!' })
        .expect(401);

      const token = await adminToken();

      const response = await request(server())
        .get('/api/security/alerts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as AlertsBody;

      expect(body.meta.total).toBeGreaterThanOrEqual(1);
      expect(body.data.some((row) => row.action === 'auth.login_failed')).toBe(
        true,
      );
    });

    it('covers SECURITY entries as well as high-priority ones elsewhere', async () => {
      const token = await adminToken();

      await testPrisma.activityLog.create({
        data: {
          category: ActivityCategory.SECURITY,
          action: 'security.session_revoked',
          title: 'A routine security entry',
          isHighPriority: false,
        },
      });

      await testPrisma.activityLog.create({
        data: {
          category: ActivityCategory.USER,
          action: 'user.balance_adjusted',
          title: 'A high-priority entry filed elsewhere',
          isHighPriority: true,
        },
      });

      const response = await request(server())
        .get('/api/security/alerts?limit=100')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const titles = (response.body as AlertsBody).data.map((row) => row.title);

      expect(titles).toContain('A routine security entry');
      expect(titles).toContain('A high-priority entry filed elsewhere');
    });

    it('excludes routine activity filed outside SECURITY', async () => {
      const token = await adminToken();

      await testPrisma.activityLog.create({
        data: {
          category: ActivityCategory.USER,
          action: 'user.created',
          title: 'A routine user entry',
          isHighPriority: false,
        },
      });

      const response = await request(server())
        .get('/api/security/alerts?limit=100')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        (response.body as AlertsBody).data.map((row) => row.title),
      ).not.toContain('A routine user entry');
    });

    it('narrows to high priority when asked', async () => {
      const token = await adminToken();

      await testPrisma.activityLog.create({
        data: {
          category: ActivityCategory.SECURITY,
          action: 'security.session_revoked',
          title: 'A routine security entry',
          isHighPriority: false,
        },
      });

      const response = await request(server())
        .get('/api/security/alerts?highPriorityOnly=true&limit=100')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rows = (response.body as AlertsBody).data;

      expect(rows.every((row) => row.isHighPriority)).toBe(true);
      expect(rows.map((row) => row.title)).not.toContain(
        'A routine security entry',
      );
    });

    it('reads ?highPriorityOnly=false as false', async () => {
      const token = await adminToken();

      await testPrisma.activityLog.create({
        data: {
          category: ActivityCategory.SECURITY,
          action: 'security.session_revoked',
          title: 'A routine security entry',
          isHighPriority: false,
        },
      });

      const response = await request(server())
        .get('/api/security/alerts?highPriorityOnly=false&limit=100')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        (response.body as AlertsBody).data.map((row) => row.title),
      ).toContain('A routine security entry');
    });

    it('ignores the SecurityAlert table entirely', async () => {
      // D-06. The table exists in the schema but nothing writes to it, because
      // there is no detection engine to write anything true. A row put there by
      // hand must not surface as though the platform detected something.
      const token = await adminToken();

      await testPrisma.securityAlert.create({
        data: {
          title: 'Unusual transaction pattern detected',
          description: 'Invented by nothing that exists',
          severity: 'HIGH',
        },
      });

      const response = await request(server())
        .get('/api/security/alerts?limit=100')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        (response.body as AlertsBody).data.map((row) => row.title),
      ).not.toContain('Unusual transaction pattern detected');
    });

    it('paginates', async () => {
      const token = await adminToken();

      for (let index = 0; index < 5; index += 1) {
        await testPrisma.activityLog.create({
          data: {
            category: ActivityCategory.SECURITY,
            action: 'security.session_revoked',
            title: `Entry ${index}`,
            isHighPriority: true,
          },
        });
      }

      const response = await request(server())
        .get('/api/security/alerts?page=1&limit=2')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as AlertsBody;

      expect(body.data).toHaveLength(2);
      expect(body.meta).toMatchObject({ page: 1, limit: 2 });
      expect(body.meta.total).toBeGreaterThanOrEqual(5);
    });
  });
});

/**
 * AuditInterceptor writes fire-and-forget, so a 204 does not mean the entry has
 * landed yet.
 */
async function waitForActivity(
  where: { action: string },
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const count = await testPrisma.activityLog.count({ where });

    if (count >= 1) return;

    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for an activity entry matching ${JSON.stringify(where)}.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
