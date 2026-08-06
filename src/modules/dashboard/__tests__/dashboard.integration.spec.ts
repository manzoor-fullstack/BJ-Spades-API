import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import {
  Prisma,
  TournamentStatus,
  TransactionStatus,
  TransactionType,
  UserSource,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { DashboardService } from '../dashboard.service';
import { monthPeriod, quarterPeriod } from '../period.util';

const RESTRICTED_ROLE = 'TEST_NO_DASHBOARD';

const RESTRICTED_ADMIN = {
  email: 'dashboard.restricted@bjspades.com',
  password: 'Admin1234!',
};

interface LoginBody {
  data: { accessToken: string };
}

interface StatsBody {
  success: true;
  data: {
    totalUsers: { value: number; change: number; changeLabel: string };
    totalRevenue: {
      value: string;
      changePercent: number | null;
      changeLabel: string;
    };
    activeTournaments: { value: number; subLabel: string };
    platformGrowth: { value: number | null; changeLabel: string };
  };
}

let fixtureCounter = 0;

/** Mid-month and mid-quarter, so every period boundary is unambiguous. */
const NOW = new Date();

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

async function seedUser(
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  fixtureCounter += 1;

  return testPrisma.user.create({
    data: {
      firstName: 'Test',
      lastName: `User ${fixtureCounter}`,
      email: `dashboard.user.${fixtureCounter}@example.com`,
      source: UserSource.ADMIN,
      ...overrides,
    },
  });
}

describe('Dashboard API (integration)', () => {
  let app: INestApplication;
  let dashboardService: DashboardService;
  let seededAdminId: string;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();
    dashboardService = app.get(DashboardService);

    // Every seeded role holds dashboard.view, so a role without it has to be
    // built here for the 403 case to mean anything.
    const activityView = await testPrisma.permission.findUniqueOrThrow({
      where: { code: 'activity.view' },
    });

    const restrictedRole = await testPrisma.role.upsert({
      where: { name: RESTRICTED_ROLE },
      update: {},
      create: {
        name: RESTRICTED_ROLE,
        displayName: 'Test role without dashboard.view',
      },
    });

    await testPrisma.rolePermission.deleteMany({
      where: { roleId: restrictedRole.id },
    });

    await testPrisma.rolePermission.create({
      data: { roleId: restrictedRole.id, permissionId: activityView.id },
    });

    const password = await bcrypt.hash(RESTRICTED_ADMIN.password, 10);

    await testPrisma.admin.upsert({
      where: { email: RESTRICTED_ADMIN.email },
      update: { password, roleId: restrictedRole.id, isActive: true },
      create: {
        firstName: 'Restricted',
        lastName: 'Admin',
        email: RESTRICTED_ADMIN.email,
        password,
        roleId: restrictedRole.id,
        isActive: true,
      },
    });

    const admin = await testPrisma.admin.findUniqueOrThrow({
      where: { email: SEEDED_ADMIN.email },
      select: { id: true },
    });

    seededAdminId = admin.id;
  });

  afterAll(async () => {
    await testPrisma.admin.deleteMany({
      where: { email: RESTRICTED_ADMIN.email },
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

  /**
   * The figures are cached for 60 seconds by design, which is exactly wrong for
   * a suite that writes rows and immediately asserts on them.
   */
  beforeEach(() => {
    dashboardService.clearCache();
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

  const stats = async (): Promise<StatsBody['data']> => {
    const token = await tokenFor(SEEDED_ADMIN);

    const response = await request(server())
      .get('/api/dashboard/stats')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    return (response.body as StatsBody).data;
  };

  async function seedTournament(
    status: TournamentStatus,
  ): Promise<{ id: string }> {
    fixtureCounter += 1;

    return testPrisma.tournament.create({
      data: {
        name: `Dashboard Cup ${fixtureCounter}`,
        maxPlayers: 16,
        startsAt: new Date(),
        status,
        createdByAdminId: seededAdminId,
      },
    });
  }

  async function seedTransaction(
    amount: string,
    overrides: Partial<Prisma.TransactionUncheckedCreateInput> = {},
  ) {
    const user = await seedUser();

    return testPrisma.transaction.create({
      data: {
        userId: user.id,
        type: TransactionType.ENTRY_FEE,
        status: TransactionStatus.COMPLETED,
        amount: new Prisma.Decimal(amount),
        balanceBefore: new Prisma.Decimal(0),
        balanceAfter: new Prisma.Decimal(0),
        ...overrides,
      },
    });
  }

  describe('authorisation', () => {
    it('returns 401 without a token', async () => {
      await request(server()).get('/api/dashboard/stats').expect(401);
    });

    it('returns 403 for an admin without dashboard.view', async () => {
      const token = await tokenFor(RESTRICTED_ADMIN);

      await request(server())
        .get('/api/dashboard/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  describe('the four cards', () => {
    it('returns the documented shape', async () => {
      const data = await stats();

      expect(Object.keys(data).sort()).toEqual([
        'activeTournaments',
        'platformGrowth',
        'totalRevenue',
        'totalUsers',
      ]);
      expect(data.totalUsers.changeLabel).toBe('this month');
      expect(data.totalRevenue.changeLabel).toBe('from last month');
      expect(data.platformGrowth.changeLabel).toBe('vs. last quarter');
    });

    it('has no Active Games card', async () => {
      // D-03: there is no game engine, so there is no live-game count.
      const data = await stats();

      expect('activeGames' in data).toBe(false);
      expect(data.activeTournaments).toBeDefined();
    });

    it('reports an empty platform honestly rather than with zeroes everywhere', async () => {
      const data = await stats();

      expect(data.totalUsers.value).toBe(0);
      expect(data.totalRevenue.value).toBe('0.00');
      // No prior period to compare against — not "no change".
      expect(data.totalRevenue.changePercent).toBeNull();
      expect(data.platformGrowth.value).toBeNull();
    });
  });

  describe('total users', () => {
    it('matches a direct count of live users', async () => {
      await Promise.all([seedUser(), seedUser(), seedUser()]);

      const data = await stats();
      const direct = await testPrisma.user.count({
        where: { deletedAt: null },
      });

      expect(data.totalUsers.value).toBe(direct);
      expect(data.totalUsers.value).toBe(3);
    });

    it('excludes soft-deleted users', async () => {
      await seedUser();
      await seedUser({ deletedAt: new Date() });

      const data = await stats();

      expect(data.totalUsers.value).toBe(1);
    });

    it('counts this month against a direct query', async () => {
      const thisMonth = monthPeriod(NOW);

      await seedUser();
      // Deliberately outside the current month.
      await seedUser({
        createdAt: new Date(thisMonth.start.getTime() - 86_400_000),
      });

      const data = await stats();

      const direct = await testPrisma.user.count({
        where: {
          deletedAt: null,
          createdAt: { gte: thisMonth.start, lt: thisMonth.end },
        },
      });

      expect(data.totalUsers.change).toBe(direct);
      expect(data.totalUsers.change).toBe(1);
      expect(data.totalUsers.value).toBe(2);
    });
  });

  describe('total revenue', () => {
    it('sums completed entry fees and nothing else', async () => {
      await seedTransaction('100.00');
      await seedTransaction('50.50');
      // Wrong type.
      await seedTransaction('999.00', { type: TransactionType.PRIZE });
      // Wrong status.
      await seedTransaction('999.00', { status: TransactionStatus.PENDING });
      await seedTransaction('999.00', { status: TransactionStatus.FAILED });

      const data = await stats();

      expect(data.totalRevenue.value).toBe('150.50');
    });

    it('reads an entry fee stored as a debit at its magnitude', async () => {
      // `Transaction.amount` is signed from the user's point of view, so an
      // entry fee may arrive negative. Revenue is what the platform took.
      await seedTransaction('-75.00');

      const data = await stats();

      expect(data.totalRevenue.value).toBe('75.00');
    });

    it('compares this month against last as a percentage', async () => {
      const lastMonth = monthPeriod(NOW, 1);

      await seedTransaction('200.00');
      await seedTransaction('100.00', {
        createdAt: new Date(lastMonth.start.getTime() + 86_400_000),
      });

      const data = await stats();

      expect(data.totalRevenue.value).toBe('300.00');
      expect(data.totalRevenue.changePercent).toBe(100);
    });

    it('does not divide by zero when last month had no revenue', async () => {
      await seedTransaction('200.00');

      const data = await stats();

      expect(data.totalRevenue.changePercent).toBeNull();
    });
  });

  describe('active tournaments', () => {
    it('counts only tournaments that are registering or in progress', async () => {
      await seedTournament(TournamentStatus.REGISTERING);
      await seedTournament(TournamentStatus.IN_PROGRESS);
      await seedTournament(TournamentStatus.SCHEDULED);
      await seedTournament(TournamentStatus.COMPLETED);
      await seedTournament(TournamentStatus.CANCELLED);

      const data = await stats();

      const direct = await testPrisma.tournament.count({
        where: {
          status: {
            in: [TournamentStatus.REGISTERING, TournamentStatus.IN_PROGRESS],
          },
        },
      });

      expect(data.activeTournaments.value).toBe(direct);
      expect(data.activeTournaments.value).toBe(2);
      expect(data.activeTournaments.subLabel).toBe('2 tournaments running');
    });
  });

  describe('platform growth', () => {
    it('compares this quarter against the last', async () => {
      const lastQuarter = quarterPeriod(NOW, 1);
      const midLastQuarter = new Date(
        (lastQuarter.start.getTime() + lastQuarter.end.getTime()) / 2,
      );

      await Promise.all([seedUser(), seedUser(), seedUser()]);
      await Promise.all([
        seedUser({ createdAt: midLastQuarter }),
        seedUser({ createdAt: midLastQuarter }),
      ]);

      const data = await stats();

      // Three this quarter against two last: +50%.
      expect(data.platformGrowth.value).toBe(50);
    });

    it('does not divide by zero when the previous quarter added no users', async () => {
      await seedUser();

      const data = await stats();

      expect(data.platformGrowth.value).toBeNull();
    });
  });

  describe('cache', () => {
    it('serves the same figures inside the window', async () => {
      await seedUser();

      const first = await stats();

      await seedUser();

      const second = await stats();

      expect(second.totalUsers.value).toBe(first.totalUsers.value);
      expect(second.totalUsers.value).toBe(1);
    });

    it('picks up the change once the cache is cleared', async () => {
      await seedUser();
      await stats();

      await seedUser();
      dashboardService.clearCache();

      const refreshed = await stats();

      expect(refreshed.totalUsers.value).toBe(2);
    });
  });

  it('ignores rows created before the retention of any period boundary', async () => {
    // A user from well outside every window still counts towards the total,
    // and towards no period.
    await seedUser({ createdAt: daysAgo(500) });

    const data = await stats();

    expect(data.totalUsers.value).toBe(1);
    expect(data.totalUsers.change).toBe(0);
  });
});
