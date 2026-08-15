import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import { ItemStatus, RewardCategory } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { SettingsService } from '../settings.service';

const RESTRICTED_ADMIN = {
  email: 'settings.restricted@bjspades.com',
  password: 'Support123!',
};

interface LoginBody {
  data: { accessToken: string };
}

interface SettingsBody {
  success: true;
  data: {
    general: Record<string, string | number | boolean>;
    notifications: Record<string, string | number | boolean>;
    security: Record<string, string | number | boolean>;
  };
}

describe('Settings API (integration)', () => {
  let app: INestApplication;
  let settingsService: SettingsService;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();
    settingsService = app.get(SettingsService);

    // SUPPORT holds settings.read but not settings.manage, which is the split
    // the 403 cases below assert.
    const supportRole = await testPrisma.role.findUniqueOrThrow({
      where: { name: 'SUPPORT' },
    });

    const password = await bcrypt.hash(RESTRICTED_ADMIN.password, 10);

    await testPrisma.admin.upsert({
      where: { email: RESTRICTED_ADMIN.email },
      update: { password, roleId: supportRole.id, isActive: true },
      create: {
        firstName: 'Settings',
        lastName: 'Support',
        email: RESTRICTED_ADMIN.email,
        password,
        roleId: supportRole.id,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    await testPrisma.admin.deleteMany({
      where: { email: RESTRICTED_ADMIN.email },
    });
    await app?.close();
  });

  /**
   * setup.ts truncates `Settings` before every test, but the service holds its
   * snapshot in memory — that is the whole point of the cache. Dropping it here
   * puts the service back in step with the table.
   */
  beforeEach(() => {
    settingsService.invalidate();
  });

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

  describe('authorisation', () => {
    it('returns 401 without a token', async () => {
      await request(server()).get('/api/settings').expect(401);
      await request(server()).put('/api/settings').send({}).expect(401);
    });

    it('returns 403 for an admin without settings.manage', async () => {
      const token = await tokenFor(RESTRICTED_ADMIN);
      const auth = { Authorization: `Bearer ${token}` };

      await request(server()).get('/api/settings').set(auth).expect(403);
      await request(server())
        .put('/api/settings')
        .set(auth)
        .send({ 'company.name': 'Nope' })
        .expect(403);
    });
  });

  describe('GET /api/settings', () => {
    it('returns every key grouped by its card, at its default', async () => {
      const token = await adminToken();

      const response = await request(server())
        .get('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const { data } = response.body as SettingsBody;

      expect(data.general).toEqual({
        'company.name': 'BJ Spades',
        'company.adminEmail': 'admin@bjspades.com',
        'company.timezone': 'America/New_York',
        'inventory.lowStockThreshold': 5,
      });
      expect(data.notifications).toEqual({
        'notifications.newUsers': true,
        'notifications.securityAlerts': true,
        'notifications.largeTransactions': true,
        'notifications.dailySummary': false,
      });
      expect(data.security).toEqual({
        'security.sessionTimeoutMinutes': 10080,
        'activity.retentionDays': 180,
        'payouts.frozen': false,
      });
    });

    it('exposes no two-factor or IP-whitelisting setting', async () => {
      // D-08 / D-09: absent from the API, not merely hidden in the UI.
      const token = await adminToken();

      const response = await request(server())
        .get('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const keys = Object.values((response.body as SettingsBody).data).flatMap(
        (group) => Object.keys(group),
      );

      expect(keys.some((key) => /twoFactor|ipWhitelist/i.test(key))).toBe(
        false,
      );
    });
  });

  describe('PUT /api/settings', () => {
    it('changes only the key supplied', async () => {
      const token = await adminToken();

      const response = await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'company.name': 'Spades Co' })
        .expect(200);

      const { data } = response.body as SettingsBody;

      expect(data.general['company.name']).toBe('Spades Co');
      expect(data.general['company.timezone']).toBe('America/New_York');

      // One key submitted, one row written.
      const rows = await testPrisma.settings.findMany();

      expect(rows.map((row) => row.key)).toEqual(['company.name']);
      expect(rows[0]?.value).toBe('Spades Co');
    });

    it('persists across a reload', async () => {
      const token = await adminToken();

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'company.timezone': 'Europe/London' })
        .expect(200);

      settingsService.invalidate();

      const response = await request(server())
        .get('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        (response.body as SettingsBody).data.general['company.timezone'],
      ).toBe('Europe/London');
    });

    it('records who changed it', async () => {
      const token = await adminToken();

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'company.name': 'Spades Co' })
        .expect(200);

      const admin = await testPrisma.admin.findUniqueOrThrow({
        where: { email: SEEDED_ADMIN.email },
        select: { id: true },
      });

      const row = await testPrisma.settings.findUniqueOrThrow({
        where: { key: 'company.name' },
      });

      expect(row.updatedByAdminId).toBe(admin.id);
      expect(row.category).toBe('general');
    });

    it('writes an audit entry containing the diff', async () => {
      const token = await adminToken();

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'activity.retentionDays': 365 })
        .expect(200);

      const entry = await testPrisma.activityLog.findFirstOrThrow({
        where: { action: 'settings.updated' },
        orderBy: { createdAt: 'desc' },
      });

      expect(entry.category).toBe('SETTINGS');
      expect(entry.isHighPriority).toBe(true);
      expect(entry.metadata).toMatchObject({
        keys: ['activity.retentionDays'],
        changes: { 'activity.retentionDays': { from: 180, to: 365 } },
      });
    });

    it('rejects an unknown key with 400 and stores nothing', async () => {
      const token = await adminToken();

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'company.mascot': 'a spade' })
        .expect(400);

      await expect(testPrisma.settings.count()).resolves.toBe(0);
    });

    it('rejects a two-factor toggle rather than storing it', async () => {
      // D-08. The table could physically hold this key; the API refuses it, so
      // no future reader can find a row implying 2FA is on.
      const token = await adminToken();

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'security.twoFactorAuth': true })
        .expect(400);

      await expect(testPrisma.settings.count()).resolves.toBe(0);
    });

    it('rejects a value below its declared minimum', async () => {
      const token = await adminToken();

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'security.sessionTimeoutMinutes': 5 })
        .expect(400);
    });

    it('rejects a value above its declared maximum', async () => {
      const token = await adminToken();

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'activity.retentionDays': 5000 })
        .expect(400);
    });

    it('rejects a malformed admin email', async () => {
      const token = await adminToken();

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'company.adminEmail': 'not-an-email' })
        .expect(400);
    });

    it('rejects a timezone that is not an IANA identifier', async () => {
      const token = await adminToken();

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'company.timezone': 'Mars/Olympus_Mons' })
        .expect(400);
    });

    it('leaves the other keys alone when several are written at once', async () => {
      const token = await adminToken();

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          'notifications.dailySummary': true,
          'notifications.newUsers': false,
        })
        .expect(200);

      const rows = await testPrisma.settings.findMany({
        orderBy: { key: 'asc' },
      });

      expect(rows.map((row) => [row.key, row.value])).toEqual([
        ['notifications.dailySummary', true],
        ['notifications.newUsers', false],
      ]);
    });
  });

  describe('settings that actually do something', () => {
    it('applies security.sessionTimeoutMinutes to the next login', async () => {
      // D-10: a real duration, not a toggle. JwtStrategy checks expiresAt on
      // every request, so this genuinely shortens the next session.
      const token = await adminToken();

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'security.sessionTimeoutMinutes': 30 })
        .expect(200);

      // Cleared so the session read back below is unambiguously the one the
      // next login creates.
      await testPrisma.session.deleteMany({});

      const before = Date.now();

      await tokenFor(SEEDED_ADMIN);

      const session = await testPrisma.session.findFirstOrThrow({});

      const lifetimeMs = session.expiresAt.getTime() - before;

      // 30 minutes, give or take the round trip — and nowhere near the 7-day
      // refresh window it would have used before.
      expect(lifetimeMs).toBeGreaterThan(29 * 60_000);
      expect(lifetimeMs).toBeLessThan(31 * 60_000);
    });

    it('applies inventory.lowStockThreshold to the low-stock indicator', async () => {
      const token = await adminToken();

      const admin = await testPrisma.admin.findUniqueOrThrow({
        where: { email: SEEDED_ADMIN.email },
        select: { id: true },
      });

      const reward = await testPrisma.reward.create({
        data: {
          name: 'Threshold Probe',
          company: 'BJ Spades',
          category: RewardCategory.GENERAL,
          value: '$10',
          status: ItemStatus.ACTIVE,
          stock: 10,
          createdByAdminId: admin.id,
        },
      });

      // 10 is comfortably above the default threshold of 5.
      const before = await request(server())
        .get(`/api/rewards/${reward.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        (before.body as { data: { isLowStock: boolean } }).data.isLowStock,
      ).toBe(false);

      await request(server())
        .put('/api/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ 'inventory.lowStockThreshold': 20 })
        .expect(200);

      const after = await request(server())
        .get(`/api/rewards/${reward.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        (after.body as { data: { isLowStock: boolean } }).data.isLowStock,
      ).toBe(true);
    });
  });
});
