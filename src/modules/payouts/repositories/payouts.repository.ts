import { Injectable } from '@nestjs/common';
import {
  Prisma,
  PayoutMethod,
  PayoutStatus,
  StripeAccountStatus,
  TournamentStatus,
  TransactionType,
} from '@prisma/client';
import type { Transaction, User } from '@prisma/client';

import type { Money } from '../../../common/money/money.util';
import { PrismaService } from '../../prisma/prisma.service';
import { recordLedgerEntry } from '../../transactions/repositories/transactions.repository';
import type { LedgerEntryInput } from '../../transactions/repositories/transactions.repository';

/**
 * Recipient and tournament come back on every read: the payouts table renders
 * the player's name and verification badge on each row, and fetching them per
 * row would be an N+1 across a paginated list.
 */
const PAYOUT_INCLUDE = {
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      stripeAccountStatus: true,
      stripeConnectAccountId: true,
    },
  },
  tournament: { select: { id: true, name: true } },
} satisfies Prisma.PayoutInclude;

export type PayoutWithRelations = Prisma.PayoutGetPayload<{
  include: typeof PAYOUT_INCLUDE;
}>;

export interface PayoutFilter {
  search?: string;
  status?: PayoutStatus;
  method?: PayoutMethod;
  userId?: string;
  tournamentId?: string;
  owedFrom?: Date;
  owedTo?: Date;
}

export interface ListPayoutsArgs {
  filter: PayoutFilter;
  /** Already checked against an allowlist by the service. */
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  skip: number;
  take: number;
}

export interface PayoutStatsRow {
  totalPrizePool: Money | null;
  paidOut: Money | null;
  pendingPayouts: Money | null;
  owedToPlayers: Money | null;
  pendingReview: number;
  playersAwaiting: number;
}

/**
 * The outcome of trying to take a payout from APPROVED to PROCESSING.
 *
 * `CLAIMED` is granted to exactly one caller. This is double-payment guard #1,
 * and it is a *conditional update* rather than a read-then-write for the same
 * reason the ledger uses one: two concurrent process requests would otherwise
 * both read APPROVED and both call Stripe.
 */
export type ClaimOutcome =
  | { outcome: 'CLAIMED' }
  | { outcome: 'NOT_CLAIMED'; payout: PayoutWithRelations }
  | { outcome: 'NOT_FOUND' };

export interface MarkPaidInput {
  payoutId: string;
  stripeTransferId: string;
  ledger: LedgerEntryInput;
}

export type MarkPaidOutcome =
  | { outcome: 'PAID'; payout: PayoutWithRelations; transaction: Transaction }
  | { outcome: 'USER_NOT_FOUND' };

@Injectable()
export class PayoutsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: PayoutFilter): Prisma.PayoutWhereInput {
    const where: Prisma.PayoutWhereInput = {};

    if (filter.status) {
      where.status = filter.status;
    }

    if (filter.method) {
      where.method = filter.method;
    }

    if (filter.userId) {
      where.userId = filter.userId;
    }

    if (filter.tournamentId) {
      where.tournamentId = filter.tournamentId;
    }

    if (filter.owedFrom || filter.owedTo) {
      where.owedSince = {
        ...(filter.owedFrom ? { gte: filter.owedFrom } : {}),
        ...(filter.owedTo ? { lte: filter.owedTo } : {}),
      };
    }

    if (filter.search) {
      const contains: Prisma.StringFilter = {
        contains: filter.search,
        mode: 'insensitive',
      };

      where.OR = [
        { user: { firstName: contains } },
        { user: { lastName: contains } },
        { user: { email: contains } },
        { tournament: { name: contains } },
      ];
    }

    return where;
  }

  findMany(args: ListPayoutsArgs): Promise<PayoutWithRelations[]> {
    return this.prisma.payout.findMany({
      where: this.buildWhere(args.filter),
      include: PAYOUT_INCLUDE,
      // The id tiebreak keeps paging stable when the sort column has ties.
      orderBy: [{ [args.sortBy]: args.sortOrder }, { id: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: PayoutFilter): Promise<number> {
    return this.prisma.payout.count({ where: this.buildWhere(filter) });
  }

  findById(id: string): Promise<PayoutWithRelations | null> {
    return this.prisma.payout.findUnique({
      where: { id },
      include: PAYOUT_INCLUDE,
    });
  }

  findUserById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async stats(): Promise<PayoutStatsRow> {
    const outstanding: Prisma.PayoutWhereInput = {
      status: { notIn: [PayoutStatus.PAID, PayoutStatus.CANCELLED] },
    };

    const [prizePool, paidOut, pendingPayouts, owed, pendingReview, awaiting] =
      await Promise.all([
        // Cancelled tournaments are excluded: their prize money is not on offer.
        this.prisma.tournament.aggregate({
          where: { status: { not: TournamentStatus.CANCELLED } },
          _sum: { prizePool: true },
        }),
        this.prisma.payout.aggregate({
          where: { status: PayoutStatus.PAID },
          _sum: { amount: true },
        }),
        this.prisma.payout.aggregate({
          where: {
            status: { in: [PayoutStatus.APPROVED, PayoutStatus.PROCESSING] },
          },
          _sum: { amount: true },
        }),
        this.prisma.payout.aggregate({
          where: outstanding,
          _sum: { amount: true },
        }),
        this.prisma.payout.count({
          where: { status: PayoutStatus.PENDING_REVIEW },
        }),
        this.prisma.payout.findMany({
          where: outstanding,
          select: { userId: true },
          distinct: ['userId'],
        }),
      ]);

    return {
      totalPrizePool: prizePool._sum.prizePool,
      paidOut: paidOut._sum.amount,
      pendingPayouts: pendingPayouts._sum.amount,
      owedToPlayers: owed._sum.amount,
      pendingReview,
      playersAwaiting: awaiting.length,
    };
  }

  /**
   * Approves, but only from a status that permits it.
   *
   * The status is part of the WHERE clause rather than checked beforehand, so
   * a second approval racing the first updates zero rows instead of silently
   * overwriting `approvedAt` and the approver.
   */
  async approve(
    id: string,
    adminId: string,
    from: readonly PayoutStatus[],
  ): Promise<number> {
    const result = await this.prisma.payout.updateMany({
      where: { id, status: { in: [...from] } },
      data: {
        status: PayoutStatus.APPROVED,
        approvedAt: new Date(),
        approvedByAdminId: adminId,
        // Approval clears whatever was holding it; a new block must be a new
        // decision, not a stale string on a now-approved row.
        blockerReason: null,
        failureReason: null,
      },
    });

    return result.count;
  }

  async cancel(
    id: string,
    reason: string,
    from: readonly PayoutStatus[],
  ): Promise<number> {
    const result = await this.prisma.payout.updateMany({
      where: { id, status: { in: [...from] } },
      data: { status: PayoutStatus.CANCELLED, blockerReason: reason },
    });

    return result.count;
  }

  /**
   * Double-payment guard #1: exactly one caller moves APPROVED → PROCESSING.
   *
   * `stripeTransferId: null` in the WHERE is guard #2 expressed as a
   * precondition; the `@unique` index behind it is the backstop if this check
   * is ever bypassed.
   */
  async claimForProcessing(id: string): Promise<ClaimOutcome> {
    const result = await this.prisma.payout.updateMany({
      where: {
        id,
        status: PayoutStatus.APPROVED,
        stripeTransferId: null,
      },
      data: { status: PayoutStatus.PROCESSING, processedAt: new Date() },
    });

    if (result.count === 1) {
      return { outcome: 'CLAIMED' };
    }

    const payout = await this.findById(id);

    return payout
      ? { outcome: 'NOT_CLAIMED', payout }
      : { outcome: 'NOT_FOUND' };
  }

  /**
   * Records a completed transfer: payout to PAID and the matching ledger row,
   * in one database transaction.
   *
   * Splitting them would allow money to have left Stripe with no ledger entry,
   * which is precisely the drift `verifyLedgerIntegrity` exists to catch — and
   * unlike a failed transfer, this one cannot be retried away.
   */
  async markPaid(input: MarkPaidInput): Promise<MarkPaidOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      await tx.payout.update({
        where: { id: input.payoutId },
        data: {
          status: PayoutStatus.PAID,
          stripeTransferId: input.stripeTransferId,
          paidAt: now,
          failureReason: null,
        },
      });

      const ledger = await recordLedgerEntry(tx, input.ledger);

      if (ledger.outcome !== 'RECORDED') {
        // A credit cannot be short of funds, so this is only reachable if the
        // recipient vanished between the transfer and this write. Throwing
        // rolls the PAID update back with it.
        throw new PayoutLedgerError(ledger.outcome);
      }

      const payout = await tx.payout.findUniqueOrThrow({
        where: { id: input.payoutId },
        include: PAYOUT_INCLUDE,
      });

      return {
        outcome: 'PAID' as const,
        payout,
        transaction: ledger.transaction,
      };
    });
  }

  /**
   * Puts a payout back where it was after Stripe refused the transfer.
   *
   * Back to APPROVED, not FAILED: the operator asked for a transfer that did
   * not happen, so nothing about the payout's standing changed, and the phase
   * gate is explicit that a failed Stripe call leaves status and balance
   * untouched. `failureReason` carries Stripe's own words so the UI can show
   * them instead of a generic error.
   */
  async releaseAfterFailure(id: string, reason: string): Promise<void> {
    await this.prisma.payout.updateMany({
      where: { id, status: PayoutStatus.PROCESSING },
      data: {
        status: PayoutStatus.APPROVED,
        processedAt: null,
        failureReason: reason.slice(0, 500),
      },
    });
  }

  async setStripeAccount(
    userId: string,
    accountId: string,
    status: StripeAccountStatus,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { stripeConnectAccountId: accountId, stripeAccountStatus: status },
    });
  }

  /** Webhook path: the account id is all Stripe gives us to match on. */
  async setStripeStatusByAccountId(
    accountId: string,
    status: StripeAccountStatus,
  ): Promise<number> {
    const result = await this.prisma.user.updateMany({
      where: { stripeConnectAccountId: accountId },
      data: { stripeAccountStatus: status },
    });

    return result.count;
  }

  findByStripeTransferId(
    transferId: string,
  ): Promise<PayoutWithRelations | null> {
    return this.prisma.payout.findUnique({
      where: { stripeTransferId: transferId },
      include: PAYOUT_INCLUDE,
    });
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.prisma.payout.updateMany({
      where: { id, status: { in: [PayoutStatus.PROCESSING] } },
      data: {
        status: PayoutStatus.FAILED,
        failureReason: reason.slice(0, 500),
      },
    });
  }

  /** Ledger rows written against a payout — used by the detail view. */
  findTransactions(payoutId: string): Promise<Transaction[]> {
    return this.prisma.transaction.findMany({
      where: { payoutId },
      orderBy: { createdAt: 'asc' },
    });
  }

  countPrizeTransactions(payoutId: string): Promise<number> {
    return this.prisma.transaction.count({
      where: { payoutId, type: TransactionType.PRIZE },
    });
  }
}

/** Internal control-flow signal; never escapes `markPaid`. */
export class PayoutLedgerError extends Error {
  constructor(readonly outcome: string) {
    super(`Payout ledger write failed: ${outcome}`);
    this.name = 'PayoutLedgerError';
  }
}
