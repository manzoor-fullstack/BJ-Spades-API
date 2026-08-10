import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import {
  PayoutStatus,
  Prisma,
  StripeAccountStatus,
  TournamentStatus,
  TransactionType,
  UserSource,
  UserStatus,
  UserTier,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { STRIPE_GATEWAY } from '../../stripe/stripe.interface';
import type {
  CreateTransferParams,
  StripeGateway,
  StripeWebhookEvent,
} from '../../stripe/stripe.interface';
import { TransactionsService } from '../../transactions/transactions.service';

const SUPPORT_ADMIN = {
  email: 'support.payouts@bjspades.com',
  password: 'Support123!',
};

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface LoginBody {
  data: { accessToken: string };
}

interface PayoutRow {
  id: string;
  amount: string;
  status: PayoutStatus;
  stripeTransferId: string | null;
  failureReason: string | null;
  isPayable: boolean;
  user: { id: string; fullName: string; stripeAccountStatus: string };
  tournament: { id: string; name: string } | null;
}

interface ItemBody {
  success: true;
  data: PayoutRow;
}

interface ListBody {
  success: true;
  data: PayoutRow[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/** The envelope AllExceptionsFilter produces (ADR-006). */
interface ErrorBody {
  success: false;
  error: { code: string; message: string; requestId: string };
}

interface TrackerBody {
  status: string;
  advanceAction: string | null;
  steps: { key: string; state: string }[];
}

interface TrackerStatsBody {
  activePayouts: number;
  inProcessing: number;
  completed: number;
  awaitingAction: number;
}

interface PrizeDistributionBody {
  placement: number;
  prizeWon: string;
  status: string;
}

interface StatsBody {
  success: true;
  data: {
    totalPrizePool: string;
    paidOut: string;
    pendingPayouts: string;
    readyToSend: string;
    blocked: string;
    pendingReview: number;
    owedToPlayers: string;
    playersAwaiting: number;
  };
}

/**
 * The Stripe SDK boundary, replaced wholesale.
 *
 * Every test in this file runs against this object, so nothing here can reach
 * api.stripe.com even if a key were configured. `transfers` records what was
 * asked for, which is how the concurrency test proves exactly one transfer was
 * made — the assertion that matters most in this suite.
 */
class FakeStripe implements StripeGateway {
  configured = true;

  transfers: CreateTransferParams[] = [];

  /** Set to make `createTransfer` reject, standing in for a declined transfer. */
  transferError: Error | null = null;

  /** Milliseconds the transfer takes; widens the window for the race test. */
  transferDelayMs = 0;

  webhookEvent: StripeWebhookEvent | null = null;

  webhookError: Error | null = null;

  private counter = 0;

  reset(): void {
    this.configured = true;
    this.transfers = [];
    this.transferError = null;
    this.transferDelayMs = 0;
    this.webhookEvent = null;
    this.webhookError = null;
    this.counter = 0;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async createTransfer(params: CreateTransferParams) {
    this.transfers.push(params);

    if (this.transferDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.transferDelayMs));
    }

    if (this.transferError) {
      throw this.transferError;
    }

    this.counter += 1;

    return {
      id: `tr_fake_${this.counter}`,
      amount: Math.round(Number(params.amount) * 100),
      currency: params.currency,
      destination: params.destination,
    };
  }

  createConnectAccount(params: { email: string; userId: string }) {
    this.counter += 1;

    return Promise.resolve({
      id: `acct_fake_${this.counter}_${params.userId.slice(0, 4)}`,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    });
  }

  retrieveConnectAccount(accountId: string) {
    return Promise.resolve({
      id: accountId,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
  }

  createAccountLink() {
    return Promise.resolve({
      url: 'https://connect.stripe.com/setup/s/fake',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
  }

  constructWebhookEvent(): StripeWebhookEvent {
    if (this.webhookError) {
      throw this.webhookError;
    }

    if (!this.webhookEvent) {
      throw new Error('No signatures found matching the expected signature');
    }

    return this.webhookEvent;
  }
}

const stripe = new FakeStripe();

let fixtureCounter = 0;

async function seedUser(
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  fixtureCounter += 1;

  return testPrisma.user.create({
    data: {
      firstName: `Winner${fixtureCounter}`,
      lastName: `Test${fixtureCounter}`,
      email: `payout${fixtureCounter}@example.com`,
      status: UserStatus.ACTIVE,
      tier: UserTier.PLAYER,
      source: UserSource.ADMIN,
      balance: new Prisma.Decimal(0),
      stripeConnectAccountId: `acct_seed_${fixtureCounter}`,
      stripeAccountStatus: StripeAccountStatus.VERIFIED,
      ...overrides,
    },
  });
}

async function seedTournament(
  adminId: string,
  overrides: Partial<Prisma.TournamentUncheckedCreateInput> = {},
) {
  fixtureCounter += 1;

  return testPrisma.tournament.create({
    data: {
      name: `Payout Tournament ${fixtureCounter}`,
      entryFee: new Prisma.Decimal('10.00'),
      prizePool: new Prisma.Decimal('500.00'),
      maxPlayers: 16,
      startsAt: new Date('2026-09-01T18:00:00.000Z'),
      status: TournamentStatus.IN_PROGRESS,
      createdByAdminId: adminId,
      ...overrides,
    },
  });
}

async function seedPayout(
  userId: string,
  overrides: Partial<Prisma.PayoutUncheckedCreateInput> = {},
) {
  return testPrisma.payout.create({
    data: {
      userId,
      amount: new Prisma.Decimal('750.25'),
      status: PayoutStatus.PENDING,
      ...overrides,
    },
  });
}

const balanceOf = async (userId: string): Promise<string> =>
  (
    await testPrisma.user.findUniqueOrThrow({ where: { id: userId } })
  ).balance.toFixed(2);

/**
 * Polls for an audit row.
 *
 * AuditInterceptor deliberately does not await its write — a mutation must not
 * fail because the audit log did (docs/phases/PHASE-2.md) — so the row lands
 * shortly after the response. Same pattern as the activity and security suites.
 */
async function waitForActivity(action: string, entityId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const entry = await testPrisma.activityLog.findFirst({
      where: { action, entityId },
    });

    if (entry) {
      return entry;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`No activity entry for ${action} / ${entityId}`);
}

/**
 * A user whose opening balance came through the ledger.
 *
 * Seeding `balance` directly is exactly the Phase 1 state the backfill exists
 * to repair — it leaves the column ahead of the ledger, so
 * `verifyLedgerIntegrity` would fail for a reason that has nothing to do with
 * the test. Tests that assert integrity fund their users this way instead.
 */
async function seedFundedUser(
  transactions: TransactionsService,
  opening: string,
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  const user = await seedUser({ ...overrides, balance: new Prisma.Decimal(0) });

  await transactions.record({
    userId: user.id,
    type: TransactionType.ADJUSTMENT,
    amount: opening,
    description: 'Opening balance',
  });

  return user;
}

describe('Payouts API (integration)', () => {
  let app: INestApplication;
  let transactions: TransactionsService;
  let seededAdminId: string;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: STRIPE_GATEWAY, useValue: stripe }],
    });

    transactions = app.get(TransactionsService);

    const supportRole = await testPrisma.role.findUniqueOrThrow({
      where: { name: 'SUPPORT' },
    });

    const password = await bcrypt.hash(SUPPORT_ADMIN.password, 10);

    // SUPPORT holds payouts.view but not payouts.manage — exactly the split
    // the contract requires the write routes to enforce.
    await testPrisma.admin.upsert({
      where: { email: SUPPORT_ADMIN.email },
      update: { password, roleId: supportRole.id, isActive: true },
      create: {
        firstName: 'Payout',
        lastName: 'Support',
        email: SUPPORT_ADMIN.email,
        password,
        roleId: supportRole.id,
        isActive: true,
      },
    });

    const admin = await testPrisma.admin.findUniqueOrThrow({
      where: { email: SEEDED_ADMIN.email },
      select: { id: true },
    });

    seededAdminId = admin.id;
  });

  beforeEach(() => {
    stripe.reset();
  });

  afterAll(async () => {
    await testPrisma.admin.deleteMany({
      where: { email: SUPPORT_ADMIN.email },
    });
    await app?.close();
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
  const supportToken = () => tokenFor(SUPPORT_ADMIN);

  describe('authorisation', () => {
    it('returns 401 without a token', async () => {
      await request(server()).get('/api/payouts').expect(401);
      await request(server()).get('/api/payouts/stats').expect(401);
      await request(server()).get(`/api/payouts/${UNKNOWN_ID}`).expect(401);
      await request(server())
        .post(`/api/payouts/${UNKNOWN_ID}/approve`)
        .expect(401);
      await request(server())
        .post(`/api/payouts/${UNKNOWN_ID}/process`)
        .expect(401);
      await request(server())
        .post(`/api/payouts/${UNKNOWN_ID}/cancel`)
        .send({ reason: 'Nope' })
        .expect(401);
      await request(server())
        .post(`/api/payouts/stripe/onboard/${UNKNOWN_ID}`)
        .expect(401);
    });

    it('lets an admin with only payouts.view read', async () => {
      const token = await supportToken();

      await request(server())
        .get('/api/payouts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await request(server())
        .get('/api/payouts/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('returns 403 on every write route for an admin with only payouts.view', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id);
      const token = await supportToken();

      await request(server())
        .post(`/api/payouts/${payout.id}/approve`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      await request(server())
        .post(`/api/payouts/${payout.id}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      await request(server())
        .post(`/api/payouts/${payout.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Not allowed' })
        .expect(403);

      await request(server())
        .post(`/api/payouts/stripe/onboard/${user.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      // Nothing moved.
      await expect(
        testPrisma.payout.findUniqueOrThrow({ where: { id: payout.id } }),
      ).resolves.toMatchObject({ status: PayoutStatus.PENDING });
    });
  });

  describe('GET /api/payouts', () => {
    it('lists payouts with the recipient, tournament and a string amount', async () => {
      const user = await seedUser({ firstName: 'Ada', lastName: 'Lovelace' });
      const tournament = await seedTournament(seededAdminId);

      await seedPayout(user.id, {
        amount: new Prisma.Decimal('1200.5'),
        tournamentId: tournament.id,
        placement: 1,
      });

      const token = await adminToken();

      const response = await request(server())
        .get('/api/payouts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.meta.total).toBe(1);
      expect(body.data[0]).toEqual(
        expect.objectContaining({
          amount: '1200.50',
          status: PayoutStatus.PENDING,
        }),
      );
      expect(body.data[0]?.user.fullName).toBe('Ada Lovelace');
      expect(body.data[0]?.tournament?.id).toBe(tournament.id);
    });

    it('filters by status, method, user and tournament', async () => {
      const [alice, bob] = await Promise.all([seedUser(), seedUser()]);
      const tournament = await seedTournament(seededAdminId);

      await seedPayout(alice.id, {
        status: PayoutStatus.APPROVED,
        tournamentId: tournament.id,
      });
      await seedPayout(bob.id, { status: PayoutStatus.PENDING });

      const token = await adminToken();

      const byStatus = await request(server())
        .get('/api/payouts')
        .query({ status: PayoutStatus.APPROVED })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((byStatus.body as ListBody).meta.total).toBe(1);

      const byUser = await request(server())
        .get('/api/payouts')
        .query({ userId: bob.id })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((byUser.body as ListBody).data[0]?.user.id).toBe(bob.id);

      const byTournament = await request(server())
        .get('/api/payouts')
        .query({ tournamentId: tournament.id })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((byTournament.body as ListBody).meta.total).toBe(1);

      const byMethod = await request(server())
        .get('/api/payouts')
        .query({ method: 'STRIPE_CONNECT' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((byMethod.body as ListBody).meta.total).toBe(2);
    });

    it('searches across the recipient and the tournament name', async () => {
      const user = await seedUser({
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace.payouts@example.com',
      });
      const tournament = await seedTournament(seededAdminId, {
        name: 'Midnight Marathon',
      });

      await seedPayout(user.id, { tournamentId: tournament.id });
      await seedPayout((await seedUser()).id);

      const token = await adminToken();

      const byName = await request(server())
        .get('/api/payouts')
        .query({ search: 'hopper' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((byName.body as ListBody).meta.total).toBe(1);

      const byTournament = await request(server())
        .get('/api/payouts')
        .query({ search: 'midnight' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((byTournament.body as ListBody).meta.total).toBe(1);
    });

    it('paginates', async () => {
      const user = await seedUser();

      for (let i = 0; i < 5; i += 1) {
        await seedPayout(user.id, {
          amount: new Prisma.Decimal(`${i + 1}.00`),
        });
      }

      const token = await adminToken();

      const response = await request(server())
        .get('/api/payouts')
        .query({ page: 2, limit: 2 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ListBody;

      expect(body.data).toHaveLength(2);
      expect(body.meta).toMatchObject({
        page: 2,
        limit: 2,
        total: 5,
        totalPages: 3,
      });
    });
  });

  describe('GET /api/payouts/stats', () => {
    it('reports every aggregate, money as two-decimal strings', async () => {
      const [alice, bob] = await Promise.all([seedUser(), seedUser()]);

      await seedTournament(seededAdminId, {
        prizePool: new Prisma.Decimal('12000.00'),
      });

      await seedPayout(alice.id, {
        amount: new Prisma.Decimal('7500.00'),
        status: PayoutStatus.PAID,
      });
      await seedPayout(alice.id, {
        amount: new Prisma.Decimal('1000.00'),
        status: PayoutStatus.APPROVED,
      });
      await seedPayout(bob.id, {
        amount: new Prisma.Decimal('250.50'),
        status: PayoutStatus.PENDING_REVIEW,
      });

      const token = await adminToken();

      const response = await request(server())
        .get('/api/payouts/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as StatsBody).data).toEqual({
        totalPrizePool: '12000.00',
        paidOut: '7500.00',
        // Approved and in flight; there is no escrow account (D-12).
        pendingPayouts: '1000.00',
        // Alice's approved payout: verified recipient, no transfer, positive.
        readyToSend: '1000.00',
        // Bob's, held for review.
        blocked: '250.50',
        pendingReview: 1,
        owedToPlayers: '1250.50',
        playersAwaiting: 2,
      });
    });

    it('excludes an approved payout to an unverified recipient from readyToSend', async () => {
      const unverified = await seedUser({
        stripeAccountStatus: StripeAccountStatus.PENDING,
      });

      await seedPayout(unverified.id, {
        amount: new Prisma.Decimal('3500.00'),
        status: PayoutStatus.APPROVED,
      });

      const token = await adminToken();

      const response = await request(server())
        .get('/api/payouts/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const data = (response.body as StatsBody).data;

      expect(data.readyToSend).toBe('0.00');
      expect(data.owedToPlayers).toBe('3500.00');
    });

    it('counts a blockerReason as blocked even when the status is not PENDING_REVIEW', async () => {
      const user = await seedUser();

      await seedPayout(user.id, {
        amount: new Prisma.Decimal('1650.00'),
        status: PayoutStatus.PENDING,
        blockerReason: 'KYC incomplete',
      });

      const token = await adminToken();

      const response = await request(server())
        .get('/api/payouts/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const data = (response.body as StatsBody).data;

      expect(data.blocked).toBe('1650.00');
      expect(data.readyToSend).toBe('0.00');
    });

    it('reports zeroes on an empty database rather than nulls', async () => {
      const token = await adminToken();

      const response = await request(server())
        .get('/api/payouts/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as StatsBody).data).toEqual({
        totalPrizePool: '0.00',
        paidOut: '0.00',
        pendingPayouts: '0.00',
        readyToSend: '0.00',
        blocked: '0.00',
        pendingReview: 0,
        owedToPlayers: '0.00',
        playersAwaiting: 0,
      });
    });
  });

  describe('GET /api/payouts/tracker', () => {
    it('returns a six-step rail for each payout', async () => {
      const user = await seedUser();
      await seedPayout(user.id, { status: PayoutStatus.APPROVED });

      const token = await adminToken();

      const response = await request(server())
        .get('/api/payouts/tracker')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rows = (response.body as { data: TrackerBody[] }).data;

      expect(rows.length).toBeGreaterThan(0);

      const first = rows[0] as TrackerBody;
      expect(first.steps).toHaveLength(6);
      expect(first.steps.map((step) => step.key)).toEqual([
        'PENDING_REVIEW',
        'IDENTITY_VERIFIED',
        'APPROVED',
        'PROCESSING',
        'SENT',
        'COMPLETED',
      ]);
    });

    it('narrows by status like the payouts list does', async () => {
      const user = await seedUser();
      await seedPayout(user.id, { status: PayoutStatus.CANCELLED });

      const token = await adminToken();

      const response = await request(server())
        .get('/api/payouts/tracker?status=CANCELLED')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rows = (response.body as { data: TrackerBody[] }).data;

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.status).toBe('CANCELLED');
      }
    });

    it('offers no advance action on a cancelled payout', async () => {
      const user = await seedUser();
      await seedPayout(user.id, { status: PayoutStatus.CANCELLED });

      const token = await adminToken();

      const response = await request(server())
        .get('/api/payouts/tracker?status=CANCELLED')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rows = (response.body as { data: TrackerBody[] }).data;

      for (const row of rows) {
        expect(row.advanceAction).toBeNull();
      }
    });

    it('counts a blocked payout under awaitingAction', async () => {
      const user = await seedUser();
      await seedPayout(user.id, {
        status: PayoutStatus.PENDING,
        blockerReason: 'KYC incomplete',
      });

      const token = await adminToken();

      const response = await request(server())
        .get('/api/payouts/tracker/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const stats = (response.body as { data: TrackerStatsBody }).data;

      expect(stats.awaitingAction).toBeGreaterThan(0);
      expect(stats.activePayouts).toBeGreaterThan(0);
    });

    it('lets an admin with only payouts.view read the tracker', async () => {
      const token = await supportToken();

      await request(server())
        .get('/api/payouts/tracker')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await request(server())
        .get('/api/payouts/tracker/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });
  });

  describe('GET /api/payouts/prize-distribution', () => {
    it('returns 404 for an unknown tournament', async () => {
      const token = await adminToken();

      await request(server())
        .get(`/api/payouts/prize-distribution?tournamentId=${UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns 400 without a tournamentId', async () => {
      const token = await adminToken();

      await request(server())
        .get('/api/payouts/prize-distribution')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('orders winners by placement and derives each status', async () => {
      const tournament = await seedTournament(seededAdminId);

      const verified = await seedUser();
      const unverified = await seedUser({
        stripeAccountStatus: StripeAccountStatus.PENDING,
      });

      const paid = await seedPayout(verified.id, {
        amount: new Prisma.Decimal('5000.00'),
        status: PayoutStatus.PAID,
        tournamentId: tournament.id,
      });
      const held = await seedPayout(unverified.id, {
        amount: new Prisma.Decimal('200.00'),
        status: PayoutStatus.PENDING_REVIEW,
        tournamentId: tournament.id,
      });

      await testPrisma.tournamentRegistration.create({
        data: {
          tournamentId: tournament.id,
          userId: verified.id,
          placement: 1,
          prizeWon: new Prisma.Decimal('5000.00'),
          payoutId: paid.id,
        },
      });
      await testPrisma.tournamentRegistration.create({
        data: {
          tournamentId: tournament.id,
          userId: unverified.id,
          placement: 2,
          prizeWon: new Prisma.Decimal('200.00'),
          payoutId: held.id,
        },
      });

      const token = await adminToken();

      const response = await request(server())
        .get(`/api/payouts/prize-distribution?tournamentId=${tournament.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rows = (response.body as { data: PrizeDistributionBody[] }).data;

      expect(rows).toHaveLength(2);

      const [first, second] = rows as [
        PrizeDistributionBody,
        PrizeDistributionBody,
      ];

      expect(first.placement).toBe(1);
      expect(first.prizeWon).toBe('5000.00');
      expect(first.status).toBe('SENT');
      // Held AND the recipient is unverified: the actionable state.
      expect(second.status).toBe('KYC_NEEDED');
    });

    it('omits registrations with no placement', async () => {
      const tournament = await seedTournament(seededAdminId);
      const player = await seedUser();

      await testPrisma.tournamentRegistration.create({
        data: { tournamentId: tournament.id, userId: player.id },
      });

      const token = await adminToken();

      const response = await request(server())
        .get(`/api/payouts/prize-distribution?tournamentId=${tournament.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as { data: unknown[] }).data).toHaveLength(0);
    });

    it('lets an admin with only payouts.view read both new routes', async () => {
      const token = await supportToken();

      await request(server())
        .get('/api/payouts/tournaments')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('lists only tournaments that have recorded results', async () => {
      const withResults = await seedTournament(seededAdminId);
      const withoutResults = await seedTournament(seededAdminId);
      const player = await seedUser();

      await testPrisma.tournamentRegistration.create({
        data: {
          tournamentId: withResults.id,
          userId: player.id,
          placement: 1,
          prizeWon: new Prisma.Decimal('100.00'),
        },
      });

      const token = await adminToken();

      const response = await request(server())
        .get('/api/payouts/tournaments')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const ids = (response.body as { data: { id: string }[] }).data.map(
        (entry) => entry.id,
      );

      expect(ids).toContain(withResults.id);
      expect(ids).not.toContain(withoutResults.id);
    });
  });

  describe('GET /api/payouts/:id', () => {
    it('returns 404 for an unknown id', async () => {
      const token = await adminToken();

      await request(server())
        .get(`/api/payouts/${UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('reports isPayable only for an approved, verified, positive payout', async () => {
      const verified = await seedUser();
      const unverified = await seedUser({
        stripeAccountStatus: StripeAccountStatus.PENDING,
      });

      const payable = await seedPayout(verified.id, {
        status: PayoutStatus.APPROVED,
      });
      const blocked = await seedPayout(unverified.id, {
        status: PayoutStatus.APPROVED,
      });

      const token = await adminToken();

      const first = await request(server())
        .get(`/api/payouts/${payable.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const second = await request(server())
        .get(`/api/payouts/${blocked.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((first.body as ItemBody).data.isPayable).toBe(true);
      expect((second.body as ItemBody).data.isPayable).toBe(false);
    });
  });

  describe('POST /api/payouts/:id/approve', () => {
    it('moves PENDING to APPROVED and records the approver', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id);
      const token = await adminToken();

      const response = await request(server())
        .post(`/api/payouts/${payout.id}/approve`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as ItemBody).data.status).toBe(
        PayoutStatus.APPROVED,
      );

      const stored = await testPrisma.payout.findUniqueOrThrow({
        where: { id: payout.id },
      });

      expect(stored.approvedByAdminId).toBe(seededAdminId);
      expect(stored.approvedAt).toBeInstanceOf(Date);
    });

    it('writes a high-priority audit entry', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id);
      const token = await adminToken();

      await request(server())
        .post(`/api/payouts/${payout.id}/approve`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const entry = await waitForActivity('payout.approved', payout.id);

      expect(entry.isHighPriority).toBe(true);
      expect(entry.category).toBe('PAYOUT');
    });

    it.each([PayoutStatus.PAID, PayoutStatus.CANCELLED, PayoutStatus.APPROVED])(
      'returns 422 approving a %s payout',
      async (status) => {
        const user = await seedUser();
        const payout = await seedPayout(user.id, { status });
        const token = await adminToken();

        await request(server())
          .post(`/api/payouts/${payout.id}/approve`)
          .set('Authorization', `Bearer ${token}`)
          .expect(422);
      },
    );

    it('returns 404 for an unknown payout', async () => {
      const token = await adminToken();

      await request(server())
        .post(`/api/payouts/${UNKNOWN_ID}/approve`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  describe('POST /api/payouts/:id/cancel', () => {
    it('cancels with a reason', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id);
      const token = await adminToken();

      const response = await request(server())
        .post(`/api/payouts/${payout.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Duplicate of payout #4821' })
        .expect(200);

      expect((response.body as ItemBody).data.status).toBe(
        PayoutStatus.CANCELLED,
      );

      await expect(
        testPrisma.payout.findUniqueOrThrow({ where: { id: payout.id } }),
      ).resolves.toMatchObject({ blockerReason: 'Duplicate of payout #4821' });
    });

    it('returns 400 without a reason', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id);
      const token = await adminToken();

      await request(server())
        .post(`/api/payouts/${payout.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
    });

    it('returns 422 cancelling a PAID payout', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id, { status: PayoutStatus.PAID });
      const token = await adminToken();

      await request(server())
        .post(`/api/payouts/${payout.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Changed my mind' })
        .expect(422);
    });
  });

  describe('POST /api/payouts/:id/process', () => {
    it('approve then process moves the payout to PAID and writes a PRIZE transaction', async () => {
      const user = await seedUser();
      const tournament = await seedTournament(seededAdminId);
      const payout = await seedPayout(user.id, {
        amount: new Prisma.Decimal('750.25'),
        tournamentId: tournament.id,
      });
      const token = await adminToken();

      await request(server())
        .post(`/api/payouts/${payout.id}/approve`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const response = await request(server())
        .post(`/api/payouts/${payout.id}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = (response.body as ItemBody).data;

      expect(body.status).toBe(PayoutStatus.PAID);
      expect(body.stripeTransferId).toBe('tr_fake_1');

      const stored = await testPrisma.payout.findUniqueOrThrow({
        where: { id: payout.id },
      });

      expect(stored.paidAt).toBeInstanceOf(Date);
      expect(stored.processedAt).toBeInstanceOf(Date);

      const rows = await testPrisma.transaction.findMany({
        where: { payoutId: payout.id },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe(TransactionType.PRIZE);
      expect(rows[0]?.amount.toFixed(2)).toBe('750.25');
      expect(rows[0]?.balanceBefore.toFixed(2)).toBe('0.00');
      expect(rows[0]?.balanceAfter.toFixed(2)).toBe('750.25');
      expect(rows[0]?.reference).toBe(`payout:${payout.id}`);

      await expect(balanceOf(user.id)).resolves.toBe('750.25');
      await expect(
        transactions.verifyLedgerIntegrity(user.id),
      ).resolves.toMatchObject({ balanced: true });
    });

    it('sends payout_{id} to Stripe as the idempotency key', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id, {
        status: PayoutStatus.APPROVED,
      });
      const token = await adminToken();

      await request(server())
        .post(`/api/payouts/${payout.id}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(stripe.transfers[0]).toMatchObject({
        idempotencyKey: `payout_${payout.id}`,
        amount: '750.25',
        destination: user.stripeConnectAccountId,
      });
    });

    it('a failed Stripe call leaves the balance AND the status unchanged', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('42.00') });
      const payout = await seedPayout(user.id, {
        status: PayoutStatus.APPROVED,
      });
      const token = await adminToken();

      stripe.transferError = new Error(
        'Your destination account is restricted',
      );

      await request(server())
        .post(`/api/payouts/${payout.id}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      const stored = await testPrisma.payout.findUniqueOrThrow({
        where: { id: payout.id },
      });

      expect(stored.status).toBe(PayoutStatus.APPROVED);
      expect(stored.stripeTransferId).toBeNull();
      expect(stored.paidAt).toBeNull();
      // Stripe's own words, so the operator sees a reason they can act on.
      expect(stored.failureReason).toBe(
        'Your destination account is restricted',
      );

      await expect(balanceOf(user.id)).resolves.toBe('42.00');
      await expect(
        testPrisma.transaction.count({ where: { payoutId: payout.id } }),
      ).resolves.toBe(0);
    });

    it('the same payout processed twice concurrently produces exactly ONE transfer', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id, {
        status: PayoutStatus.APPROVED,
      });
      const token = await adminToken();

      // Widen the window so both requests are genuinely in flight together.
      stripe.transferDelayMs = 150;

      const responses = await Promise.all([
        request(server())
          .post(`/api/payouts/${payout.id}/process`)
          .set('Authorization', `Bearer ${token}`),
        request(server())
          .post(`/api/payouts/${payout.id}/process`)
          .set('Authorization', `Bearer ${token}`),
      ]);

      const statuses = responses.map((response) => response.status).sort();

      expect(statuses).toEqual([200, 422]);
      // The assertion this whole suite exists for. A duplicated transfer is
      // unrecoverable — no amount of later correction gets the money back.
      expect(stripe.transfers).toHaveLength(1);

      await expect(
        testPrisma.transaction.count({ where: { payoutId: payout.id } }),
      ).resolves.toBe(1);
      await expect(balanceOf(user.id)).resolves.toBe('750.25');
    });

    it('refuses a second process of a PAID payout', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id, {
        status: PayoutStatus.APPROVED,
      });
      const token = await adminToken();

      await request(server())
        .post(`/api/payouts/${payout.id}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const second = await request(server())
        .post(`/api/payouts/${payout.id}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect((second.body as ErrorBody).error.message).toBe(
        'Payout has already been processed',
      );
      expect(stripe.transfers).toHaveLength(1);
      await expect(balanceOf(user.id)).resolves.toBe('750.25');
    });

    it('refuses a payout that has not been approved', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id);
      const token = await adminToken();

      const response = await request(server())
        .post(`/api/payouts/${payout.id}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect((response.body as ErrorBody).error.message).toBe(
        'Payout must be approved before processing',
      );
      expect(stripe.transfers).toHaveLength(0);
    });

    it.each([
      StripeAccountStatus.NOT_CONNECTED,
      StripeAccountStatus.PENDING,
      StripeAccountStatus.RESTRICTED,
    ])('refuses a payout to a %s recipient', async (stripeAccountStatus) => {
      const user = await seedUser({ stripeAccountStatus });
      const payout = await seedPayout(user.id, {
        status: PayoutStatus.APPROVED,
      });
      const token = await adminToken();

      const response = await request(server())
        .post(`/api/payouts/${payout.id}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect((response.body as ErrorBody).error.message).toBe(
        'User has not completed Stripe onboarding',
      );
    });

    it('refuses a zero-amount payout', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id, {
        status: PayoutStatus.APPROVED,
        amount: new Prisma.Decimal('0.00'),
      });
      const token = await adminToken();

      const response = await request(server())
        .post(`/api/payouts/${payout.id}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect((response.body as ErrorBody).error.message).toBe(
        'Payout amount must be positive',
      );
    });

    it('answers 503 when Stripe has no key configured, without stranding the payout', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id, {
        status: PayoutStatus.APPROVED,
      });
      const token = await adminToken();

      stripe.configured = false;

      await request(server())
        .post(`/api/payouts/${payout.id}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(503);

      await expect(
        testPrisma.payout.findUniqueOrThrow({ where: { id: payout.id } }),
      ).resolves.toMatchObject({ status: PayoutStatus.APPROVED });
    });
  });

  describe('POST /api/payouts/stripe/onboard/:userId', () => {
    it('creates the Connect account and returns a hosted link', async () => {
      const user = await seedUser({
        stripeConnectAccountId: null,
        stripeAccountStatus: StripeAccountStatus.NOT_CONNECTED,
      });
      const token = await adminToken();

      const response = await request(server())
        .post(`/api/payouts/stripe/onboard/${user.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = (response.body as { data: { url: string } }).data;

      expect(body.url).toBe('https://connect.stripe.com/setup/s/fake');

      const stored = await testPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(stored.stripeConnectAccountId).toMatch(/^acct_fake_/);
      // Created, not verified: only account.updated may promote it.
      expect(stored.stripeAccountStatus).toBe(StripeAccountStatus.PENDING);
    });

    it('returns 404 for an unknown user', async () => {
      const token = await adminToken();

      await request(server())
        .post(`/api/payouts/stripe/onboard/${UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  describe('POST /api/payouts/stripe/webhook', () => {
    it('is public — no token needed, and a bad signature is a 400', async () => {
      stripe.webhookError = new Error(
        'No signatures found matching the expected signature',
      );

      const response = await request(server())
        .post('/api/payouts/stripe/webhook')
        .set('stripe-signature', 't=1,v1=deadbeef')
        .send({ id: 'evt_1', type: 'account.updated' });

      expect(response.status).toBe(400);
    });

    it('returns 400 without a signature header', async () => {
      await request(server())
        .post('/api/payouts/stripe/webhook')
        .send({ id: 'evt_1' })
        .expect(400);
    });

    it('updates stripeAccountStatus from account.updated', async () => {
      const user = await seedUser({
        stripeConnectAccountId: 'acct_webhook_1',
        stripeAccountStatus: StripeAccountStatus.PENDING,
      });

      stripe.webhookEvent = {
        id: 'evt_account_1',
        type: 'account.updated',
        data: {
          object: {
            id: 'acct_webhook_1',
            payouts_enabled: true,
            charges_enabled: true,
            details_submitted: true,
          },
        },
      };

      await request(server())
        .post('/api/payouts/stripe/webhook')
        .set('stripe-signature', 't=1,v1=whatever')
        .send({ id: 'evt_account_1' })
        .expect(200);

      await expect(
        testPrisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).resolves.toMatchObject({
        stripeAccountStatus: StripeAccountStatus.VERIFIED,
      });
    });

    it('marks an account RESTRICTED when Stripe will not pay it', async () => {
      const user = await seedUser({
        stripeConnectAccountId: 'acct_webhook_2',
        stripeAccountStatus: StripeAccountStatus.PENDING,
      });

      stripe.webhookEvent = {
        id: 'evt_account_2',
        type: 'account.updated',
        data: {
          object: {
            id: 'acct_webhook_2',
            payouts_enabled: false,
            details_submitted: true,
          },
        },
      };

      await request(server())
        .post('/api/payouts/stripe/webhook')
        .set('stripe-signature', 't=1,v1=whatever')
        .send({ id: 'evt_account_2' })
        .expect(200);

      await expect(
        testPrisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).resolves.toMatchObject({
        stripeAccountStatus: StripeAccountStatus.RESTRICTED,
      });
    });

    it('marks the payout FAILED on transfer.failed', async () => {
      const user = await seedUser();
      const payout = await seedPayout(user.id, {
        status: PayoutStatus.PROCESSING,
        stripeTransferId: 'tr_gone_bad',
      });

      stripe.webhookEvent = {
        id: 'evt_transfer_1',
        type: 'transfer.failed',
        data: {
          object: { id: 'tr_gone_bad', failure_message: 'Account closed' },
        },
      };

      await request(server())
        .post('/api/payouts/stripe/webhook')
        .set('stripe-signature', 't=1,v1=whatever')
        .send({ id: 'evt_transfer_1' })
        .expect(200);

      await expect(
        testPrisma.payout.findUniqueOrThrow({ where: { id: payout.id } }),
      ).resolves.toMatchObject({
        status: PayoutStatus.FAILED,
        failureReason: 'Account closed',
      });
    });
  });

  describe('money wired into tournaments', () => {
    it('registration debits the entry fee through the ledger', async () => {
      const user = await seedFundedUser(transactions, '100.00');
      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
        entryFee: new Prisma.Decimal('25.00'),
      });
      const token = await adminToken();

      await request(server())
        .post(`/api/tournaments/${tournament.id}/registrations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id })
        .expect(201);

      await expect(balanceOf(user.id)).resolves.toBe('75.00');

      const rows = await testPrisma.transaction.findMany({
        where: { userId: user.id, type: TransactionType.ENTRY_FEE },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.amount.toFixed(2)).toBe('-25.00');
      expect(rows[0]?.balanceBefore.toFixed(2)).toBe('100.00');
      expect(rows[0]?.balanceAfter.toFixed(2)).toBe('75.00');
      expect(rows[0]?.tournamentId).toBe(tournament.id);

      await expect(
        transactions.verifyLedgerIntegrity(user.id),
      ).resolves.toMatchObject({ balanced: true });
    });

    it('refuses the registration outright when the balance cannot cover the fee', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('10.00') });
      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
        entryFee: new Prisma.Decimal('25.00'),
      });
      const token = await adminToken();

      await request(server())
        .post(`/api/tournaments/${tournament.id}/registrations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id })
        .expect(422);

      // Neither the fee nor the registration: they are one transaction.
      await expect(balanceOf(user.id)).resolves.toBe('10.00');
      await expect(
        testPrisma.tournamentRegistration.count({
          where: { tournamentId: tournament.id },
        }),
      ).resolves.toBe(0);
      await expect(
        testPrisma.transaction.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
    });

    it('charges nothing for a free tournament', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('0.00') });
      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
        entryFee: new Prisma.Decimal('0.00'),
      });
      const token = await adminToken();

      await request(server())
        .post(`/api/tournaments/${tournament.id}/registrations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id })
        .expect(201);

      await expect(
        testPrisma.transaction.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
    });

    it('cancelling a tournament refunds every entry fee', async () => {
      const alice = await seedFundedUser(transactions, '100.00');
      const bob = await seedFundedUser(transactions, '60.00');

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
        entryFee: new Prisma.Decimal('25.00'),
      });

      const token = await adminToken();

      for (const user of [alice, bob]) {
        await request(server())
          .post(`/api/tournaments/${tournament.id}/registrations`)
          .set('Authorization', `Bearer ${token}`)
          .send({ userId: user.id })
          .expect(201);
      }

      await expect(balanceOf(alice.id)).resolves.toBe('75.00');
      await expect(balanceOf(bob.id)).resolves.toBe('35.00');

      await request(server())
        .patch(`/api/tournaments/${tournament.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Venue unavailable' })
        .expect(200);

      await expect(balanceOf(alice.id)).resolves.toBe('100.00');
      await expect(balanceOf(bob.id)).resolves.toBe('60.00');

      const refunds = await testPrisma.transaction.findMany({
        where: { tournamentId: tournament.id, type: TransactionType.REFUND },
      });

      expect(refunds).toHaveLength(2);
      expect(refunds.every((row) => row.amount.toFixed(2) === '25.00')).toBe(
        true,
      );

      await expect(transactions.verifyLedgerIntegrity()).resolves.toMatchObject(
        { balanced: true },
      );
    });

    it('submitting results creates a payout row per prize and moves no money', async () => {
      const [winner, runnerUp, alsoRan] = await Promise.all([
        seedUser(),
        seedUser(),
        seedUser(),
      ]);

      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.IN_PROGRESS,
        entryFee: new Prisma.Decimal('0.00'),
      });

      await testPrisma.tournamentRegistration.createMany({
        data: [winner, runnerUp, alsoRan].map((user) => ({
          tournamentId: tournament.id,
          userId: user.id,
        })),
      });

      const token = await adminToken();

      await request(server())
        .post(`/api/tournaments/${tournament.id}/results`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          results: [
            { userId: winner.id, placement: 1, prizeWon: '750.25' },
            { userId: runnerUp.id, placement: 2, prizeWon: '250.00' },
            { userId: alsoRan.id, placement: 3 },
          ],
        })
        .expect(200);

      const payouts = await testPrisma.payout.findMany({
        where: { tournamentId: tournament.id },
        orderBy: { placement: 'asc' },
      });

      // Third place won nothing, so nothing is owed and no payout exists.
      expect(payouts).toHaveLength(2);
      expect(payouts[0]).toMatchObject({
        userId: winner.id,
        placement: 1,
        status: PayoutStatus.PENDING,
      });
      expect(payouts[0]?.amount.toFixed(2)).toBe('750.25');
      expect(payouts[1]?.amount.toFixed(2)).toBe('250.00');

      // The registration points at its payout.
      const registration =
        await testPrisma.tournamentRegistration.findFirstOrThrow({
          where: { tournamentId: tournament.id, userId: winner.id },
        });

      expect(registration.payoutId).toBe(payouts[0]?.id);

      // Results record what is owed; the money moves at /process.
      await expect(balanceOf(winner.id)).resolves.toBe('0.00');
      await expect(testPrisma.transaction.count()).resolves.toBe(0);
    });

    it('results through to a paid payout keeps the ledger balanced end to end', async () => {
      const winner = await seedFundedUser(transactions, '100.00');
      const tournament = await seedTournament(seededAdminId, {
        status: TournamentStatus.REGISTERING,
        entryFee: new Prisma.Decimal('25.00'),
      });
      const token = await adminToken();

      await request(server())
        .post(`/api/tournaments/${tournament.id}/registrations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: winner.id })
        .expect(201);

      await testPrisma.tournament.update({
        where: { id: tournament.id },
        data: { status: TournamentStatus.IN_PROGRESS },
      });

      await request(server())
        .post(`/api/tournaments/${tournament.id}/results`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          results: [{ userId: winner.id, placement: 1, prizeWon: '500.00' }],
        })
        .expect(200);

      const payout = await testPrisma.payout.findFirstOrThrow({
        where: { tournamentId: tournament.id },
      });

      await request(server())
        .post(`/api/payouts/${payout.id}/approve`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await request(server())
        .post(`/api/payouts/${payout.id}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // 100 opening, less a 25 entry fee, plus a 500 prize.
      await expect(balanceOf(winner.id)).resolves.toBe('575.00');
      await expect(
        transactions.verifyLedgerIntegrity(winner.id),
      ).resolves.toMatchObject({ balanced: true });
    });
  });
});
