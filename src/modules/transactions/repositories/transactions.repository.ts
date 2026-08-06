import { Injectable } from '@nestjs/common';
import { Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import type { Transaction } from '@prisma/client';

import { toMoney } from '../../../common/money/money.util';
import type { Money, MoneyInput } from '../../../common/money/money.util';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * What a caller hands the ledger. `amount` is SIGNED — negative debits.
 *
 * `reference` is `@unique` on the table and is how idempotency is expressed:
 * a deterministic reference (`entry_fee:{tournamentId}:{userId}`) makes a
 * repeated write a database error rather than a duplicated movement.
 */
export interface LedgerEntryInput {
  userId: string;
  type: TransactionType;
  amount: MoneyInput;
  description?: string | null;
  reference?: string | null;
  tournamentId?: string | null;
  payoutId?: string | null;
  createdByAdminId?: string | null;
  /** Defaults to COMPLETED: everything written here has already moved money. */
  status?: TransactionStatus;
  /** Backdating, used only by the backfill. Defaults to now. */
  createdAt?: Date;
}

/**
 * Every way a ledger write can end.
 *
 * A discriminated union rather than thrown exceptions, for the same reason
 * `RegistrationOutcome` is one: the repository knows what the database said,
 * the service owns which HTTP status that maps to.
 */
export type LedgerOutcome =
  | { outcome: 'RECORDED'; transaction: Transaction }
  | { outcome: 'USER_NOT_FOUND' }
  | { outcome: 'INSUFFICIENT_BALANCE'; balance: Money; amount: Money };

export interface LedgerTotal {
  userId: string;
  balance: Money;
  ledgerTotal: Money;
  transactionCount: number;
}

export interface TransactionFilter {
  userId?: string;
  type?: TransactionType;
  status?: TransactionStatus;
  tournamentId?: string;
  payoutId?: string;
}

export interface ListTransactionsArgs {
  filter: TransactionFilter;
  /** Already checked against an allowlist by the service. */
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  skip: number;
  take: number;
}

/**
 * THE ONLY FUNCTION IN THE CODEBASE THAT WRITES `User.balance`.
 *
 * It takes a transaction client rather than owning one so a caller that is
 * already inside a `$transaction` — registering a player and debiting the entry
 * fee, paying a payout and crediting the prize — can make the balance move and
 * its surrounding write atomic. Splitting them would allow a registration with
 * no fee, or a Stripe transfer with no ledger row.
 *
 * Two properties matter:
 *
 *  1. **The check and the write are one statement.** A read-then-write
 *     ("is the balance big enough?" followed by "set it") lets two concurrent
 *     debits both pass the check against the same pre-image and jointly
 *     overdraw the account. `updateMany` with `balance: { gte: minimum }` is
 *     evaluated by Postgres against the row it is about to update, so exactly
 *     one of the two wins and the loser gets `count: 0`.
 *  2. **`balanceBefore` is derived, never re-read.** The UPDATE above holds a
 *     row lock for the rest of the transaction, so the balance read back is
 *     definitively post-image; subtracting the amount yields the pre-image
 *     without a second racy read.
 */
export async function recordLedgerEntry(
  tx: Prisma.TransactionClient,
  input: LedgerEntryInput,
): Promise<LedgerOutcome> {
  const amount = toMoney(input.amount);

  // A credit needs no floor. A debit needs the balance to be at least the size
  // of the debit, which is exactly "the result stays at or above zero".
  const minimum = amount.isNegative() ? amount.negated() : toMoney(0);

  const applied = await tx.user.updateMany({
    where: { id: input.userId, balance: { gte: minimum } },
    data: { balance: { increment: amount } },
  });

  if (applied.count === 0) {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { balance: true },
    });

    if (!user) {
      return { outcome: 'USER_NOT_FOUND' };
    }

    return { outcome: 'INSUFFICIENT_BALANCE', balance: user.balance, amount };
  }

  const { balance: balanceAfter } = await tx.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { balance: true },
  });

  const balanceBefore = balanceAfter.minus(amount);

  const transaction = await tx.transaction.create({
    data: {
      userId: input.userId,
      type: input.type,
      status: input.status ?? TransactionStatus.COMPLETED,
      amount,
      balanceBefore,
      balanceAfter,
      description: input.description ?? null,
      reference: input.reference ?? null,
      tournamentId: input.tournamentId ?? null,
      payoutId: input.payoutId ?? null,
      createdByAdminId: input.createdByAdminId ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });

  return { outcome: 'RECORDED', transaction };
}

@Injectable()
export class TransactionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: TransactionFilter): Prisma.TransactionWhereInput {
    const where: Prisma.TransactionWhereInput = {};

    if (filter.userId) {
      where.userId = filter.userId;
    }

    if (filter.type) {
      where.type = filter.type;
    }

    if (filter.status) {
      where.status = filter.status;
    }

    if (filter.tournamentId) {
      where.tournamentId = filter.tournamentId;
    }

    if (filter.payoutId) {
      where.payoutId = filter.payoutId;
    }

    return where;
  }

  /** One entry, in its own database transaction. */
  record(input: LedgerEntryInput): Promise<LedgerOutcome> {
    return this.prisma.$transaction((tx) => recordLedgerEntry(tx, input));
  }

  /**
   * Several entries, all-or-nothing.
   *
   * Refunding a cancelled tournament is the motivating case: half the players
   * refunded is worse than none, because nobody can tell which half.
   */
  recordMany(inputs: LedgerEntryInput[]): Promise<LedgerOutcome[]> {
    return this.prisma.$transaction(async (tx) => {
      const outcomes: LedgerOutcome[] = [];

      for (const input of inputs) {
        const outcome = await recordLedgerEntry(tx, input);

        // Anything other than success aborts the whole batch: returning a
        // partial list would commit the entries written before the failure.
        if (outcome.outcome !== 'RECORDED') {
          throw new LedgerBatchError(outcome);
        }

        outcomes.push(outcome);
      }

      return outcomes;
    });
  }

  findMany(args: ListTransactionsArgs): Promise<Transaction[]> {
    return this.prisma.transaction.findMany({
      where: this.buildWhere(args.filter),
      // The id tiebreak keeps paging stable when the sort column has ties.
      orderBy: [{ [args.sortBy]: args.sortOrder }, { id: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: TransactionFilter): Promise<number> {
    return this.prisma.transaction.count({ where: this.buildWhere(filter) });
  }

  findByReference(reference: string): Promise<Transaction | null> {
    return this.prisma.transaction.findUnique({ where: { reference } });
  }

  /**
   * Per-user balance against the sum of that user's ledger rows.
   *
   * Every row counts, including FAILED and REVERSED ones, because every row
   * this codebase writes has already moved the balance — a row that did not
   * move money would have to be written by something other than
   * `recordLedgerEntry`, which is the drift this check exists to catch.
   */
  async ledgerTotals(userId?: string): Promise<LedgerTotal[]> {
    const where = userId ? { id: userId } : {};

    const [users, groups] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: { id: true, balance: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['userId'],
        where: userId ? { userId } : {},
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    const byUser = new Map(groups.map((group) => [group.userId, group]));

    return users.map((user) => {
      const group = byUser.get(user.id);

      return {
        userId: user.id,
        balance: user.balance,
        ledgerTotal: toMoney(group?._sum.amount ?? 0),
        transactionCount: group?._count._all ?? 0,
      };
    });
  }
}

/** Internal control-flow signal; never escapes `recordMany`. */
export class LedgerBatchError extends Error {
  constructor(readonly outcome: LedgerOutcome) {
    super(`Ledger batch aborted: ${outcome.outcome}`);
    this.name = 'LedgerBatchError';
  }
}
