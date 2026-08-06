import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import {
  Prisma,
  TournamentStatus,
  TransactionType,
  UserSource,
  UserStatus,
  UserTier,
} from '@prisma/client';
import request from 'supertest';

import {
  backfillTransactions,
  openingReference,
} from '../../../../prisma/seed/backfill-transactions';
import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { TransactionsService } from '../transactions.service';

interface LoginBody {
  data: { accessToken: string };
}

let fixtureCounter = 0;

async function seedUser(
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  fixtureCounter += 1;

  return testPrisma.user.create({
    data: {
      firstName: `Ledger${fixtureCounter}`,
      lastName: `Test${fixtureCounter}`,
      email: `ledger${fixtureCounter}@example.com`,
      status: UserStatus.ACTIVE,
      tier: UserTier.PLAYER,
      source: UserSource.ADMIN,
      balance: new Prisma.Decimal(0),
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
      name: `Ledger Tournament ${fixtureCounter}`,
      entryFee: new Prisma.Decimal('25.00'),
      prizePool: new Prisma.Decimal('500.00'),
      maxPlayers: 16,
      startsAt: new Date('2026-09-01T18:00:00.000Z'),
      status: TournamentStatus.REGISTERING,
      createdByAdminId: adminId,
      ...overrides,
    },
  });
}

const balanceOf = async (userId: string): Promise<string> =>
  (
    await testPrisma.user.findUniqueOrThrow({ where: { id: userId } })
  ).balance.toFixed(2);

describe('Transactions ledger (integration)', () => {
  let app: INestApplication;
  let transactions: TransactionsService;
  let seededAdminId: string;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();
    transactions = app.get(TransactionsService);

    const admin = await testPrisma.admin.findUniqueOrThrow({
      where: { email: SEEDED_ADMIN.email },
      select: { id: true },
    });

    seededAdminId = admin.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const adminToken = async (): Promise<string> => {
    const response = await request(server())
      .post('/api/auth/login')
      .send(SEEDED_ADMIN);

    return (response.body as LoginBody).data.accessToken;
  };

  describe('record', () => {
    it('writes the row and moves the balance in one transaction', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('100.00') });

      const entry = await transactions.record({
        userId: user.id,
        type: TransactionType.ADJUSTMENT,
        amount: '50.25',
        description: 'Goodwill credit',
      });

      expect(entry.balanceBefore).toBe('100.00');
      expect(entry.amount).toBe('50.25');
      expect(entry.balanceAfter).toBe('150.25');
      await expect(balanceOf(user.id)).resolves.toBe('150.25');
    });

    it('debits with a negative amount', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('100.00') });

      await transactions.record({
        userId: user.id,
        type: TransactionType.ENTRY_FEE,
        amount: '-40.00',
      });

      await expect(balanceOf(user.id)).resolves.toBe('60.00');
    });

    it('refuses a debit below zero with 422 and writes nothing', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('100.00') });

      await expect(
        transactions.record({
          userId: user.id,
          type: TransactionType.ENTRY_FEE,
          amount: '-100.01',
        }),
      ).rejects.toMatchObject({ status: 422 });

      await expect(balanceOf(user.id)).resolves.toBe('100.00');
      await expect(
        testPrisma.transaction.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
    });

    it('holds the line under concurrency — two debits cannot jointly overdraw', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('100.00') });

      // Both would pass a read-then-write check against the same pre-image of
      // 100.00; the conditional UPDATE is what makes exactly one of them win.
      const results = await Promise.allSettled([
        transactions.record({
          userId: user.id,
          type: TransactionType.ENTRY_FEE,
          amount: '-60.00',
          reference: `concurrency:${user.id}:a`,
        }),
        transactions.record({
          userId: user.id,
          type: TransactionType.ENTRY_FEE,
          amount: '-60.00',
          reference: `concurrency:${user.id}:b`,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');

      expect(fulfilled).toHaveLength(1);
      await expect(balanceOf(user.id)).resolves.toBe('40.00');
      await expect(
        testPrisma.transaction.count({ where: { userId: user.id } }),
      ).resolves.toBe(1);
    });

    it('refuses a duplicate reference at the database', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('100.00') });
      const reference = `unique-probe:${user.id}`;

      await transactions.record({
        userId: user.id,
        type: TransactionType.ADJUSTMENT,
        amount: '10.00',
        reference,
      });

      await expect(
        transactions.record({
          userId: user.id,
          type: TransactionType.ADJUSTMENT,
          amount: '10.00',
          reference,
        }),
      ).rejects.toThrow();

      // The failed write rolled the balance back with it.
      await expect(balanceOf(user.id)).resolves.toBe('110.00');
    });

    it('is exact across a hundred cent-level movements', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('0.00') });

      for (let i = 0; i < 100; i += 1) {
        await transactions.record({
          userId: user.id,
          type: TransactionType.ADJUSTMENT,
          amount: '0.01',
          reference: `cents:${user.id}:${i}`,
        });
      }

      await expect(balanceOf(user.id)).resolves.toBe('1.00');
      await expect(
        transactions.verifyLedgerIntegrity(user.id),
      ).resolves.toMatchObject({ balanced: true });
    });
  });

  describe('verifyLedgerIntegrity', () => {
    it('passes for a user whose every movement went through the ledger', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('0.00') });

      await transactions.record({
        userId: user.id,
        type: TransactionType.ADJUSTMENT,
        amount: '500.00',
      });
      await transactions.record({
        userId: user.id,
        type: TransactionType.ENTRY_FEE,
        amount: '-25.00',
      });

      await expect(
        transactions.verifyLedgerIntegrity(user.id),
      ).resolves.toEqual({ checked: 1, balanced: true, issues: [] });
    });

    it('detects a balance corrupted behind the ledger', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('0.00') });

      await transactions.record({
        userId: user.id,
        type: TransactionType.ADJUSTMENT,
        amount: '100.00',
      });

      // Exactly what a stray `UPDATE "User" SET balance` looks like. This is
      // the drift the check exists to find, so it is worth doing for real.
      await testPrisma.user.update({
        where: { id: user.id },
        data: { balance: new Prisma.Decimal('999.99') },
      });

      const report = await transactions.verifyLedgerIntegrity(user.id);

      expect(report.balanced).toBe(false);
      expect(report.issues[0]).toMatchObject({
        userId: user.id,
        balance: '999.99',
        ledgerTotal: '100.00',
        difference: '899.99',
      });
    });

    it('flags a Phase 1 style balance with no ledger behind it', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('250.00') });

      const report = await transactions.verifyLedgerIntegrity(user.id);

      expect(report.balanced).toBe(false);
      expect(report.issues[0]?.transactionCount).toBe(0);
    });
  });

  describe('POST /api/users/:id/balance/adjust writes through the ledger', () => {
    it('leaves an ADJUSTMENT row and a ledger that balances', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('0.00') });
      const token = await adminToken();

      await request(server())
        .post(`/api/users/${user.id}/balance/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 120.5, reason: 'Goodwill credit' })
        .expect(200);

      const rows = await testPrisma.transaction.findMany({
        where: { userId: user.id },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe(TransactionType.ADJUSTMENT);
      expect(rows[0]?.balanceBefore.toFixed(2)).toBe('0.00');
      expect(rows[0]?.balanceAfter.toFixed(2)).toBe('120.50');
      expect(rows[0]?.description).toBe('Goodwill credit');
      expect(rows[0]?.createdByAdminId).toBe(seededAdminId);

      await expect(
        transactions.verifyLedgerIntegrity(user.id),
      ).resolves.toMatchObject({ balanced: true });
    });

    it('writes no row when the adjustment is refused', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('10.00') });
      const token = await adminToken();

      await request(server())
        .post(`/api/users/${user.id}/balance/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: -50, reason: 'Chargeback #99' })
        .expect(422);

      await expect(
        testPrisma.transaction.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
      await expect(balanceOf(user.id)).resolves.toBe('10.00');
    });
  });

  describe('the Phase 1 / Phase 4 backfill', () => {
    it('produces a ledger that passes the integrity check', async () => {
      // The state Phase 6 inherits: balances written directly by Phase 1.5,
      // and registrations recorded by Phase 4 that never debited anybody.
      const withBalance = await seedUser({
        balance: new Prisma.Decimal('500.00'),
      });
      const withFees = await seedUser({ balance: new Prisma.Decimal('75.00') });
      const untouched = await seedUser({ balance: new Prisma.Decimal('0.00') });

      const paid = await seedTournament(seededAdminId, {
        entryFee: new Prisma.Decimal('25.00'),
      });
      const free = await seedTournament(seededAdminId, {
        entryFee: new Prisma.Decimal('0.00'),
      });

      await testPrisma.tournamentRegistration.createMany({
        data: [
          { tournamentId: paid.id, userId: withFees.id },
          { tournamentId: free.id, userId: withFees.id },
          { tournamentId: paid.id, userId: untouched.id },
        ],
      });

      // Before: every user with a balance or a fee is out of step.
      const before = await transactions.verifyLedgerIntegrity();
      expect(before.balanced).toBe(false);

      const summary = await backfillTransactions(testPrisma);

      expect(summary.openingAdjustments).toBeGreaterThanOrEqual(3);
      // Two paid registrations; the zero-fee tournament contributes nothing.
      expect(summary.entryFees).toBe(2);

      const after = await transactions.verifyLedgerIntegrity();

      expect(after.issues).toEqual([]);
      expect(after.balanced).toBe(true);

      // The Phase 1 case specifically: a balance set directly, no fees, now
      // explained by exactly one opening row.
      const opening = await testPrisma.transaction.findMany({
        where: { userId: withBalance.id },
      });

      expect(opening).toHaveLength(1);
      expect(opening[0]?.amount.toFixed(2)).toBe('500.00');
    });

    it('leaves every balance untouched — it records history, it does not replay it', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('500.00') });
      const tournament = await seedTournament(seededAdminId, {
        entryFee: new Prisma.Decimal('25.00'),
      });

      await testPrisma.tournamentRegistration.create({
        data: { tournamentId: tournament.id, userId: user.id },
      });

      await backfillTransactions(testPrisma);

      await expect(balanceOf(user.id)).resolves.toBe('500.00');
    });

    it('opens at balance + fees, so the chain lands on the current balance', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('75.00') });
      const tournament = await seedTournament(seededAdminId, {
        entryFee: new Prisma.Decimal('25.00'),
      });

      await testPrisma.tournamentRegistration.create({
        data: { tournamentId: tournament.id, userId: user.id },
      });

      await backfillTransactions(testPrisma);

      const rows = await testPrisma.transaction.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
      });

      expect(rows).toHaveLength(2);
      // 75.00 held now, 25.00 paid out in fees, so it opened at 100.00.
      expect(rows[0]?.type).toBe(TransactionType.ADJUSTMENT);
      expect(rows[0]?.balanceBefore.toFixed(2)).toBe('0.00');
      expect(rows[0]?.amount.toFixed(2)).toBe('100.00');
      expect(rows[0]?.reference).toBe(openingReference(user.id));

      expect(rows[1]?.type).toBe(TransactionType.ENTRY_FEE);
      expect(rows[1]?.amount.toFixed(2)).toBe('-25.00');
      expect(rows[1]?.balanceAfter.toFixed(2)).toBe('75.00');
    });

    it('dates each row to what it describes, not to the moment it ran', async () => {
      const registeredAt = new Date('2026-07-04T12:00:00.000Z');
      const user = await seedUser({
        balance: new Prisma.Decimal('75.00'),
        createdAt: new Date('2026-06-01T09:00:00.000Z'),
      });
      const tournament = await seedTournament(seededAdminId);

      await testPrisma.tournamentRegistration.create({
        data: { tournamentId: tournament.id, userId: user.id, registeredAt },
      });

      await backfillTransactions(testPrisma);

      const rows = await testPrisma.transaction.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
      });

      expect(rows[0]?.createdAt.toISOString()).toBe('2026-06-01T09:00:00.000Z');
      expect(rows[1]?.createdAt.toISOString()).toBe(registeredAt.toISOString());
    });

    it('is idempotent — running it twice writes nothing the second time', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('500.00') });
      const tournament = await seedTournament(seededAdminId);

      await testPrisma.tournamentRegistration.create({
        data: { tournamentId: tournament.id, userId: user.id },
      });

      await backfillTransactions(testPrisma);
      const first = await testPrisma.transaction.count();

      const second = await backfillTransactions(testPrisma);

      expect(second.openingAdjustments).toBe(0);
      expect(second.entryFees).toBe(0);
      expect(second.skippedUsersWithLedger).toBeGreaterThanOrEqual(1);
      await expect(testPrisma.transaction.count()).resolves.toBe(first);
      await expect(transactions.verifyLedgerIntegrity()).resolves.toMatchObject(
        { balanced: true },
      );
    });

    it('writes nothing for a user with no balance and no fees', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('0.00') });

      await backfillTransactions(testPrisma);

      await expect(
        testPrisma.transaction.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
    });

    it('leaves a user who already has ledger rows alone', async () => {
      const user = await seedUser({ balance: new Prisma.Decimal('0.00') });

      await transactions.record({
        userId: user.id,
        type: TransactionType.ADJUSTMENT,
        amount: '300.00',
      });

      const summary = await backfillTransactions(testPrisma);

      expect(summary.skippedUsersWithLedger).toBeGreaterThanOrEqual(1);
      await expect(
        testPrisma.transaction.count({ where: { userId: user.id } }),
      ).resolves.toBe(1);
      await expect(
        transactions.verifyLedgerIntegrity(user.id),
      ).resolves.toMatchObject({ balanced: true });
    });
  });
});
