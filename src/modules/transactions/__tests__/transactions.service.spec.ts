import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, TransactionStatus, TransactionType } from '@prisma/client';

import { toMoney } from '../../../common/money/money.util';
import type { Money } from '../../../common/money/money.util';
import {
  recordLedgerEntry,
  TransactionsRepository,
} from '../repositories/transactions.repository';
import type {
  LedgerEntryInput,
  LedgerTotal,
} from '../repositories/transactions.repository';
import { TransactionsService } from '../transactions.service';

type MockedRepository = { [K in keyof TransactionsRepository]: jest.Mock };

const USER_ID = '11111111-1111-4111-8111-000000000001';

interface CreatedRow {
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  type: TransactionType;
  status: TransactionStatus;
  reference: string | null;
  createdAt?: Date;
}

/**
 * A stand-in for `Prisma.TransactionClient` holding one user's balance.
 *
 * Reimplements only what `recordLedgerEntry` uses, and reimplements the
 * `updateMany` guard faithfully — `balance: { gte: minimum }` is a WHERE clause
 * Postgres evaluates against the row it is about to write, so the fake refuses
 * the update rather than clamping it. Without that fidelity the below-zero test
 * would pass against a fake that could never fail.
 */
function fakeTx(startingBalance: string | null) {
  let balance = startingBalance === null ? null : toMoney(startingBalance);
  const created: CreatedRow[] = [];

  const tx = {
    user: {
      updateMany: jest.fn(
        (args: {
          where: { balance: { gte: Money } };
          data: { balance: { increment: Money } };
        }) => {
          if (balance === null) {
            return Promise.resolve({ count: 0 });
          }

          if (balance.lessThan(args.where.balance.gte)) {
            return Promise.resolve({ count: 0 });
          }

          balance = balance.plus(args.data.balance.increment);

          return Promise.resolve({ count: 1 });
        },
      ),
      findUnique: jest.fn(() =>
        Promise.resolve(balance === null ? null : { balance }),
      ),
      findUniqueOrThrow: jest.fn(() => Promise.resolve({ balance })),
    },
    transaction: {
      create: jest.fn((args: { data: CreatedRow }) => {
        created.push(args.data);

        return Promise.resolve({ id: 'transaction-1', ...args.data });
      }),
    },
  };

  return {
    client: tx as unknown as Prisma.TransactionClient,
    created,
    balance: () => balance,
    /** The WHERE clause of the guarded UPDATE, which is where the floor lives. */
    guardFloor: (): Money | undefined =>
      (
        tx.user.updateMany.mock.calls[0] as
          [{ where: { balance: { gte: Money } } }] | undefined
      )?.[0].where.balance.gte,
  };
}

function entry(overrides: Partial<LedgerEntryInput> = {}): LedgerEntryInput {
  return {
    userId: USER_ID,
    type: TransactionType.ADJUSTMENT,
    amount: '10.00',
    ...overrides,
  };
}

describe('recordLedgerEntry — the only writer of User.balance', () => {
  describe('arithmetic', () => {
    it('a credit increases the balance by exactly the amount', async () => {
      const tx = fakeTx('100.00');

      const outcome = await recordLedgerEntry(
        tx.client,
        entry({ amount: '25.50' }),
      );

      expect(outcome.outcome).toBe('RECORDED');
      expect(tx.balance()?.toFixed(2)).toBe('125.50');
    });

    it('a debit decreases the balance by exactly the amount', async () => {
      const tx = fakeTx('100.00');

      await recordLedgerEntry(tx.client, entry({ amount: '-40.25' }));

      expect(tx.balance()?.toFixed(2)).toBe('59.75');
    });

    it('records balanceBefore and balanceAfter consistently with the amount', async () => {
      const tx = fakeTx('100.00');

      await recordLedgerEntry(tx.client, entry({ amount: '-40.25' }));

      const row = tx.created[0];

      expect(row?.balanceBefore.toFixed(2)).toBe('100.00');
      expect(row?.amount.toFixed(2)).toBe('-40.25');
      expect(row?.balanceAfter.toFixed(2)).toBe('59.75');
      expect(row?.balanceBefore.plus(row.amount).toFixed(2)).toBe(
        row?.balanceAfter.toFixed(2),
      );
    });

    it('is exact where floats are not — 0.1 + 0.2 is 0.3, not 0.30000000000000004', async () => {
      const tx = fakeTx('0.00');

      await recordLedgerEntry(tx.client, entry({ amount: '0.10' }));
      await recordLedgerEntry(tx.client, entry({ amount: '0.20' }));

      expect(tx.balance()?.toFixed(2)).toBe('0.30');
      expect(tx.balance()?.equals(toMoney('0.3'))).toBe(true);
      // The failure this guards against, spelled out.
      expect(0.1 + 0.2).not.toBe(0.3);
    });

    it('accumulates ten 0.1 credits to exactly 1.00', async () => {
      const tx = fakeTx('0.00');

      for (let i = 0; i < 10; i += 1) {
        await recordLedgerEntry(tx.client, entry({ amount: '0.10' }));
      }

      expect(tx.balance()?.toFixed(2)).toBe('1.00');
    });

    it('chains balanceBefore onto the previous balanceAfter across rows', async () => {
      const tx = fakeTx('50.00');

      await recordLedgerEntry(tx.client, entry({ amount: '25.00' }));
      await recordLedgerEntry(tx.client, entry({ amount: '-10.00' }));

      expect(tx.created[0]?.balanceAfter.toFixed(2)).toBe('75.00');
      expect(tx.created[1]?.balanceBefore.toFixed(2)).toBe('75.00');
      expect(tx.created[1]?.balanceAfter.toFixed(2)).toBe('65.00');
    });
  });

  describe('the below-zero guard', () => {
    it('refuses a debit that would go below zero and writes nothing', async () => {
      const tx = fakeTx('100.00');

      const outcome = await recordLedgerEntry(
        tx.client,
        entry({ amount: '-100.01' }),
      );

      expect(outcome.outcome).toBe('INSUFFICIENT_BALANCE');
      expect(tx.balance()?.toFixed(2)).toBe('100.00');
      expect(tx.created).toHaveLength(0);
    });

    it('allows a debit that lands exactly on zero', async () => {
      const tx = fakeTx('100.00');

      const outcome = await recordLedgerEntry(
        tx.client,
        entry({ amount: '-100.00' }),
      );

      expect(outcome.outcome).toBe('RECORDED');
      expect(tx.balance()?.toFixed(2)).toBe('0.00');
    });

    it('guards a debit with a floor equal to the debit, not zero', async () => {
      const tx = fakeTx('100.00');

      await recordLedgerEntry(tx.client, entry({ amount: '-40.00' }));

      // The check and the write are one statement: a read-then-write would let
      // two concurrent debits pass the same stale check and overdraw jointly.
      expect(tx.guardFloor()?.toFixed(2)).toBe('40.00');
    });

    it('requires no floor for a credit', async () => {
      const tx = fakeTx('0.00');

      await recordLedgerEntry(tx.client, entry({ amount: '10.00' }));

      expect(tx.guardFloor()?.toFixed(2)).toBe('0.00');
    });

    it('reports a missing user separately from an insufficient balance', async () => {
      const tx = fakeTx(null);

      const outcome = await recordLedgerEntry(tx.client, entry());

      expect(outcome.outcome).toBe('USER_NOT_FOUND');
    });
  });

  describe('the row it writes', () => {
    it('defaults to COMPLETED — everything written here has already moved money', async () => {
      const tx = fakeTx('10.00');

      await recordLedgerEntry(tx.client, entry());

      expect(tx.created[0]?.status).toBe(TransactionStatus.COMPLETED);
    });

    it('carries the reference through, so a repeat is a unique-constraint error', async () => {
      const tx = fakeTx('10.00');

      await recordLedgerEntry(
        tx.client,
        entry({ reference: 'entry_fee:t-1:u-1' }),
      );

      expect(tx.created[0]?.reference).toBe('entry_fee:t-1:u-1');
    });

    it('leaves createdAt to the database unless explicitly backdated', async () => {
      const tx = fakeTx('10.00');

      await recordLedgerEntry(tx.client, entry());

      expect(tx.created[0]?.createdAt).toBeUndefined();
    });

    it('backdates when asked, which is what the backfill needs', async () => {
      const tx = fakeTx('10.00');
      const when = new Date('2026-01-02T03:04:05.000Z');

      await recordLedgerEntry(tx.client, entry({ createdAt: when }));

      expect(tx.created[0]?.createdAt).toBe(when);
    });
  });
});

describe('TransactionsService', () => {
  let repository: MockedRepository;
  let service: TransactionsService;

  const recordedRow = (amount: string, before: string, after: string) => ({
    id: 'transaction-1',
    userId: USER_ID,
    type: TransactionType.ADJUSTMENT,
    status: TransactionStatus.COMPLETED,
    amount: toMoney(amount),
    balanceBefore: toMoney(before),
    balanceAfter: toMoney(after),
    description: null,
    reference: null,
    tournamentId: null,
    payoutId: null,
    createdByAdminId: null,
    createdAt: new Date('2026-08-06T00:00:00.000Z'),
  });

  beforeEach(() => {
    repository = {
      record: jest.fn(),
      recordMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findByReference: jest.fn().mockResolvedValue(null),
      ledgerTotals: jest.fn().mockResolvedValue([]),
    };

    service = new TransactionsService(
      repository as unknown as TransactionsRepository,
    );
  });

  describe('record', () => {
    it('serialises every money field as a two-decimal string', async () => {
      repository.record.mockResolvedValue({
        outcome: 'RECORDED',
        transaction: recordedRow('25.5', '100', '125.5'),
      });

      const result = await service.record(entry({ amount: '25.50' }));

      expect(result.amount).toBe('25.50');
      expect(result.balanceBefore).toBe('100.00');
      expect(result.balanceAfter).toBe('125.50');
    });

    it('turns an insufficient balance into 422', async () => {
      repository.record.mockResolvedValue({
        outcome: 'INSUFFICIENT_BALANCE',
        balance: toMoney('10.00'),
        amount: toMoney('-25.00'),
      });

      await expect(
        service.record(entry({ amount: '-25.00' })),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('reports the shortfall in the default message', async () => {
      repository.record.mockResolvedValue({
        outcome: 'INSUFFICIENT_BALANCE',
        balance: toMoney('10.00'),
        amount: toMoney('-25.00'),
      });

      await expect(service.record(entry({ amount: '-25.00' }))).rejects.toThrow(
        /10\.00 available.*-25\.00.*-15\.00/,
      );
    });

    it('lets the caller supply its own insufficient-balance message', async () => {
      repository.record.mockResolvedValue({
        outcome: 'INSUFFICIENT_BALANCE',
        balance: toMoney('10.00'),
        amount: toMoney('-25.00'),
      });

      await expect(
        service.record({
          ...entry({ amount: '-25.00' }),
          insufficientBalanceMessage: 'Entry fee not covered',
        }),
      ).rejects.toThrow('Entry fee not covered');
    });

    it('turns a missing user into 404', async () => {
      repository.record.mockResolvedValue({ outcome: 'USER_NOT_FOUND' });

      await expect(service.record(entry())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('recordMany', () => {
    it('writes nothing for an empty batch', async () => {
      await expect(service.recordMany([])).resolves.toEqual([]);
      expect(repository.recordMany).not.toHaveBeenCalled();
    });

    it('serialises every row in the batch', async () => {
      repository.recordMany.mockResolvedValue([
        { outcome: 'RECORDED', transaction: recordedRow('5', '0', '5') },
        { outcome: 'RECORDED', transaction: recordedRow('7.5', '5', '12.5') },
      ]);

      const rows = await service.recordMany([entry(), entry()]);

      expect(rows.map((row) => row.balanceAfter)).toEqual(['5.00', '12.50']);
    });
  });

  describe('verifyLedgerIntegrity', () => {
    const total = (
      balance: string,
      ledger: string,
      userId = USER_ID,
    ): LedgerTotal => ({
      userId,
      balance: toMoney(balance),
      ledgerTotal: toMoney(ledger),
      transactionCount: 3,
    });

    it('passes when the sum of transactions equals the balance', async () => {
      repository.ledgerTotals.mockResolvedValue([
        total('150.25', '150.25'),
        total('0.00', '0.00', 'user-2'),
      ]);

      const report = await service.verifyLedgerIntegrity();

      expect(report.balanced).toBe(true);
      expect(report.checked).toBe(2);
      expect(report.issues).toEqual([]);
    });

    it('detects a deliberately corrupted balance and names the drift', async () => {
      // Exactly what a direct `UPDATE "User" SET balance = ...` looks like from
      // the ledger's point of view: the column moved, no row explains it.
      repository.ledgerTotals.mockResolvedValue([total('999.99', '150.25')]);

      const report = await service.verifyLedgerIntegrity();

      expect(report.balanced).toBe(false);
      expect(report.issues).toEqual([
        {
          userId: USER_ID,
          balance: '999.99',
          ledgerTotal: '150.25',
          difference: '849.74',
          transactionCount: 3,
        },
      ]);
    });

    it('detects drift in the other direction too', async () => {
      repository.ledgerTotals.mockResolvedValue([total('10.00', '40.00')]);

      const report = await service.verifyLedgerIntegrity();

      expect(report.issues[0]?.difference).toBe('-30.00');
    });

    it('treats a user with no transactions and a zero balance as balanced', async () => {
      repository.ledgerTotals.mockResolvedValue([
        { ...total('0.00', '0.00'), transactionCount: 0 },
      ]);

      await expect(service.verifyLedgerIntegrity()).resolves.toMatchObject({
        balanced: true,
      });
    });

    it('flags a user with a balance and no transactions — the un-backfilled case', async () => {
      repository.ledgerTotals.mockResolvedValue([
        { ...total('500.00', '0.00'), transactionCount: 0 },
      ]);

      const report = await service.verifyLedgerIntegrity();

      expect(report.balanced).toBe(false);
      expect(report.issues[0]?.difference).toBe('500.00');
    });

    it('narrows to one user when given an id', async () => {
      repository.ledgerTotals.mockResolvedValue([total('1.00', '1.00')]);

      await service.verifyLedgerIntegrity(USER_ID);

      expect(repository.ledgerTotals).toHaveBeenCalledWith(USER_ID);
    });
  });
});
