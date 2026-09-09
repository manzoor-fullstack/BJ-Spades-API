import { Injectable } from '@nestjs/common';
import {
  Prisma,
  PayoutMethod,
  PayoutStatus,
  StripeAccountStatus,
  TournamentStatus,
  TransactionStatus,
  TransactionType,
  WithdrawalRequestStatus,
  WebhookEventStatus,
} from '@prisma/client';
import type { Transaction, User } from '@prisma/client';

import { formatMoney, toMoney } from '../../../common/money/money.util';
import type { Money } from '../../../common/money/money.util';
import { PrismaService } from '../../prisma/prisma.service';
import {
  HISTORY_TYPES,
  type PayoutHistoryStats,
} from '../serializers/payout-history.serializer';
import type { PayoutTrackerStats } from '../serializers/payout-tracker.serializer';
import type { PayoutTournamentOption } from '../serializers/prize-distribution.serializer';
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
      // The tracker's "Identity Verified" step needs a date, not just a state.
      stripeVerifiedAt: true,
    },
  },
  tournament: { select: { id: true, name: true } },
  withdrawalRequest: {
    select: {
      id: true,
      status: true,
      destinationReference: true,
      reservationTransactionId: true,
      releaseTransactionId: true,
    },
  },
} satisfies Prisma.PayoutInclude;

export type PayoutWithRelations = Prisma.PayoutGetPayload<{
  include: typeof PAYOUT_INCLUDE;
}>;

/**
 * Everything a Prize Distribution row needs, in one query.
 *
 * `stripeAccountStatus` is selected because the row's badge distinguishes
 * "held for our review" from "held on the recipient" — see
 * `deriveDistributionStatus`.
 */
const DISTRIBUTION_INCLUDE = {
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      stripeAccountStatus: true,
    },
  },
  tournament: { select: { id: true, name: true } },
  payout: { select: { id: true, status: true, currency: true } },
  prizeAwards: {
    select: { status: true, settlementVersion: true },
    orderBy: { settlementVersion: 'desc' as const },
    take: 1,
  },
} satisfies Prisma.TournamentRegistrationInclude;

export type RegistrationWithPayout = Prisma.TournamentRegistrationGetPayload<{
  include: typeof DISTRIBUTION_INCLUDE;
}>;

/** Everything a History row renders, in one query. */
const HISTORY_INCLUDE = {
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  tournament: { select: { id: true, name: true } },
  payout: { select: { id: true, method: true, stripeTransferId: true } },
} satisfies Prisma.TransactionInclude;

export type HistoryTransactionRow = Prisma.TransactionGetPayload<{
  include: typeof HISTORY_INCLUDE;
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
  readyToSend: Money | null;
  blocked: Money | null;
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
  | { outcome: 'RESUMED' }
  | { outcome: 'NOT_CLAIMED'; payout: PayoutWithRelations }
  | { outcome: 'NOT_FOUND' };

/** A live request gets this long before another process may recover its work. */
export const PAYOUT_PROCESSING_RECOVERY_MS = 30_000;

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

    const [
      prizePool,
      paidOut,
      pendingPayouts,
      owed,
      pendingReview,
      awaiting,
      readyToSend,
      blocked,
    ] = await Promise.all([
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
      // Mirrors isPayable() in the serializer and the four guards in
      // PayoutsService.process. Kept in lockstep with them by hand — a
      // divergence shows up as a card offering to send an unsendable payout.
      this.prisma.payout.aggregate({
        where: {
          status: PayoutStatus.APPROVED,
          stripeTransferId: null,
          amount: { gt: 0 },
          user: { stripeAccountStatus: StripeAccountStatus.VERIFIED },
        },
        _sum: { amount: true },
      }),
      this.prisma.payout.aggregate({
        where: {
          ...outstanding,
          OR: [
            { blockerReason: { not: null } },
            { status: PayoutStatus.PENDING_REVIEW },
          ],
        },
        _sum: { amount: true },
      }),
    ]);

    return {
      totalPrizePool: prizePool._sum.prizePool,
      paidOut: paidOut._sum.amount,
      pendingPayouts: pendingPayouts._sum.amount,
      owedToPlayers: owed._sum.amount,
      readyToSend: readyToSend._sum.amount,
      blocked: blocked._sum.amount,
      pendingReview,
      playersAwaiting: awaiting.length,
    };
  }

  /**
   * Transactions behind the History tab, newest first.
   *
   * Ordered by user then date so the serializer's grouping walks contiguous
   * blocks, and a player's rows are never split across the result.
   */
  findHistory(args: {
    search?: string;
    from?: Date;
    to?: Date;
    skip: number;
    take: number;
  }): Promise<HistoryTransactionRow[]> {
    return this.prisma.transaction.findMany({
      where: this.historyWhere(args),
      include: HISTORY_INCLUDE,
      orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  countHistory(args: {
    search?: string;
    from?: Date;
    to?: Date;
  }): Promise<number> {
    return this.prisma.transaction.count({ where: this.historyWhere(args) });
  }

  /** The four History cards. */
  async historyStats(): Promise<PayoutHistoryStats> {
    const base: Prisma.TransactionWhereInput = {
      type: { in: [...HISTORY_TYPES] },
    };

    const [players, transactions, paid, refunded] = await Promise.all([
      this.prisma.transaction.findMany({
        where: base,
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.prisma.transaction.count({ where: base }),
      this.prisma.transaction.aggregate({
        where: {
          status: TransactionStatus.COMPLETED,
          type: { in: [TransactionType.PRIZE, TransactionType.WITHDRAWAL] },
        },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: {
          status: TransactionStatus.COMPLETED,
          type: TransactionType.REFUND,
        },
        _sum: { amount: true },
      }),
    ]);

    return {
      players: players.length,
      transactions,
      totalPaid: formatMoney(paid._sum.amount ?? 0),
      // Reported as a positive figure: refunds are stored signed, and a card
      // reading "-$2,575 Refunded" states the sign twice.
      refunded: formatMoney((refunded._sum.amount ?? toMoney(0)).abs()),
    };
  }

  private historyWhere(args: {
    search?: string;
    from?: Date;
    to?: Date;
  }): Prisma.TransactionWhereInput {
    const where: Prisma.TransactionWhereInput = {
      type: { in: [...HISTORY_TYPES] },
    };

    if (args.from || args.to) {
      where.createdAt = {
        ...(args.from ? { gte: args.from } : {}),
        ...(args.to ? { lte: args.to } : {}),
      };
    }

    if (args.search) {
      const contains: Prisma.StringFilter = {
        contains: args.search,
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

  /**
   * The four Tracker cards.
   *
   * `awaitingAction` is the one an operator acts on: held for review, or held
   * by a blocker reason. It overlaps `activePayouts` by design — they answer
   * different questions ("how much is in flight" vs "how much needs me").
   */
  async trackerStats(): Promise<PayoutTrackerStats> {
    const outstanding: Prisma.PayoutWhereInput = {
      status: { notIn: [PayoutStatus.PAID, PayoutStatus.CANCELLED] },
    };

    const [activePayouts, inProcessing, completed, awaitingAction] =
      await Promise.all([
        this.prisma.payout.count({ where: outstanding }),
        this.prisma.payout.count({
          where: { status: PayoutStatus.PROCESSING },
        }),
        this.prisma.payout.count({ where: { status: PayoutStatus.PAID } }),
        this.prisma.payout.count({
          where: {
            ...outstanding,
            OR: [
              { status: PayoutStatus.PENDING_REVIEW },
              { blockerReason: { not: null } },
            ],
          },
        }),
      ]);

    return { activePayouts, inProcessing, completed, awaitingAction };
  }

  /**
   * Winners of one tournament, best placement first.
   *
   * Only rows with a placement come back: a registration without one is a
   * player who entered, not a winner, and has no place in a prize table.
   */
  findPrizeDistribution(
    tournamentId: string,
    currency?: string,
  ): Promise<RegistrationWithPayout[]> {
    return this.prisma.tournamentRegistration.findMany({
      where: {
        tournamentId,
        placement: { not: null },
        ...(currency
          ? {
              OR: [
                { payout: { currency } },
                ...(currency.toLowerCase() === 'usd' ? [{ payout: null }] : []),
              ],
            }
          : {}),
      },
      include: DISTRIBUTION_INCLUDE,
      orderBy: [{ placement: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Tournaments that have results, for the Overview selector.
   *
   * A tournament nobody has placed in would render an empty table, so it is
   * not offered at all. Newest first — the operator almost always wants the
   * tournament that just finished.
   */
  findPayoutTournaments(): Promise<PayoutTournamentOption[]> {
    return this.prisma.tournament.findMany({
      where: { registrations: { some: { placement: { not: null } } } },
      select: { id: true, name: true, status: true },
      orderBy: { startsAt: 'desc' },
    });
  }

  async tournamentExists(id: string): Promise<boolean> {
    const found = await this.prisma.tournament.findUnique({
      where: { id },
      select: { id: true },
    });

    return found !== null;
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
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const result = await tx.payout.updateMany({
        where: { id, status: { in: [...from] } },
        data: {
          status: PayoutStatus.APPROVED,
          approvedAt: now,
          approvedByAdminId: adminId,
          blockerReason: null,
          failureReason: null,
        },
      });
      if (result.count === 1) {
        await tx.withdrawalRequest.updateMany({
          where: {
            payout: { id },
            status: WithdrawalRequestStatus.PENDING_REVIEW,
          },
          data: {
            status: WithdrawalRequestStatus.APPROVED,
            approvedAt: now,
            reviewReason: null,
          },
        });
      }
      return result.count;
    });
  }

  async cancel(
    id: string,
    reason: string,
    from: readonly PayoutStatus[],
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.payout.updateMany({
        where: { id, status: { in: [...from] } },
        data: { status: PayoutStatus.CANCELLED, blockerReason: reason },
      });
      if (result.count !== 1) return result.count;

      const withdrawal = await tx.withdrawalRequest.findFirst({
        where: { payout: { id }, releaseTransactionId: null },
      });
      if (!withdrawal) return result.count;

      const release = await recordLedgerEntry(tx, {
        userId: withdrawal.userId,
        type: TransactionType.REFUND,
        amount: withdrawal.amount,
        status: TransactionStatus.COMPLETED,
        reference: `withdrawal-release:${withdrawal.id}`,
        payoutId: id,
        description: 'Declined withdrawal reservation released',
      });
      if (release.outcome !== 'RECORDED') {
        throw new PayoutLedgerError(`WITHDRAWAL_RELEASE_${release.outcome}`);
      }
      await tx.withdrawalRequest.update({
        where: { id: withdrawal.id },
        data: {
          status: WithdrawalRequestStatus.DECLINED,
          reviewReason: reason,
          declinedAt: new Date(),
          releaseTransactionId: release.transaction.id,
        },
      });
      await tx.transaction.update({
        where: { id: withdrawal.reservationTransactionId },
        data: { status: TransactionStatus.REVERSED },
      });
      return result.count;
    });
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

    // A process can stop after Stripe accepted the idempotent transfer but
    // before markPaid committed. Reclaim only stale work, and refresh the
    // timestamp atomically so exactly one recovery worker reaches Stripe.
    const resumed = await this.prisma.payout.updateMany({
      where: {
        id,
        status: PayoutStatus.PROCESSING,
        stripeTransferId: null,
        processedAt: {
          lte: new Date(Date.now() - PAYOUT_PROCESSING_RECOVERY_MS),
        },
      },
      data: { processedAt: new Date() },
    });

    if (resumed.count === 1) {
      return { outcome: 'RESUMED' };
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

      const claimed = await tx.payout.updateMany({
        where: {
          id: input.payoutId,
          status: { in: [PayoutStatus.PROCESSING, PayoutStatus.APPROVED] },
          stripeTransferId: null,
        },
        data: {
          status: PayoutStatus.PAID,
          stripeTransferId: input.stripeTransferId,
          paidAt: now,
          failureReason: null,
        },
      });

      if (claimed.count !== 1) {
        const [payout, transaction] = await Promise.all([
          tx.payout.findUnique({
            where: { id: input.payoutId },
            include: PAYOUT_INCLUDE,
          }),
          tx.transaction.findFirst({
            where: {
              payoutId: input.payoutId,
              type: { in: [TransactionType.PRIZE, TransactionType.WITHDRAWAL] },
            },
          }),
        ]);

        // Two recovery workers can receive the same Stripe transfer because
        // they use the same idempotency key. The database loser returns the
        // already-committed result instead of crediting the player again.
        if (
          payout?.status === PayoutStatus.PAID &&
          payout.stripeTransferId === input.stripeTransferId &&
          transaction
        ) {
          return { outcome: 'PAID' as const, payout, transaction };
        }

        throw new PayoutLedgerError('PAYOUT_NOT_PROCESSABLE');
      }

      const withdrawal = await tx.withdrawalRequest.findFirst({
        where: { payout: { id: input.payoutId } },
      });
      if (withdrawal) {
        const transaction = await tx.transaction.update({
          where: { id: withdrawal.reservationTransactionId },
          data: { status: TransactionStatus.COMPLETED },
        });
        const payout = await tx.payout.findUniqueOrThrow({
          where: { id: input.payoutId },
          include: PAYOUT_INCLUDE,
        });
        return { outcome: 'PAID' as const, payout, transaction };
      }

      const owner = await tx.user.findUnique({
        where: { id: input.ledger.userId },
        select: { balance: true },
      });

      if (!owner) throw new PayoutLedgerError('USER_NOT_FOUND');

      // Stripe already sent this money externally. Keep the real amount in
      // transaction history, while leaving the spendable wallet unchanged so
      // the same prize cannot also be spent inside the application.
      const transaction = await tx.transaction.create({
        data: {
          userId: input.ledger.userId,
          type: input.ledger.type,
          status: input.ledger.status ?? TransactionStatus.COMPLETED,
          amount: toMoney(input.ledger.amount),
          balanceBefore: owner.balance,
          balanceAfter: owner.balance,
          affectsBalance: false,
          description: input.ledger.description ?? null,
          reference: input.ledger.reference ?? null,
          tournamentId: input.ledger.tournamentId ?? null,
          payoutId: input.ledger.payoutId ?? null,
          createdByAdminId: input.ledger.createdByAdminId ?? null,
        },
      });

      const payout = await tx.payout.findUniqueOrThrow({
        where: { id: input.payoutId },
        include: PAYOUT_INCLUDE,
      });

      return {
        outcome: 'PAID' as const,
        payout,
        transaction,
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

  async syncStripeDestination(
    userId: string,
    accountId: string,
    verified: boolean,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const existingMethods = await tx.payoutMethodAccount.count({
        where: { userId },
      });
      return tx.payoutMethodAccount.upsert({
        where: {
          userId_method: { userId, method: PayoutMethod.STRIPE_CONNECT },
        },
        create: {
          userId,
          method: PayoutMethod.STRIPE_CONNECT,
          label: 'Stripe Connect',
          reference: accountId,
          isVerified: verified,
          isDefault: existingMethods === 0,
        },
        update: {
          reference: accountId,
          isVerified: verified,
        },
      });
    });
  }

  /** Webhook path: the account id is all Stripe gives us to match on. */
  /**
   * Records Stripe's verdict on a connected account.
   *
   * The first transition into VERIFIED also stamps `stripeVerifiedAt`. It is a
   * second, guarded write rather than part of the first: folding
   * `stripeVerifiedAt: null` into the main WHERE would stop the *status* from
   * updating on every later webhook for an already-verified account.
   */
  async setStripeStatusByAccountId(
    accountId: string,
    status: StripeAccountStatus,
  ): Promise<number> {
    const result = await this.prisma.user.updateMany({
      where: { stripeConnectAccountId: accountId },
      data: { stripeAccountStatus: status },
    });

    if (status === StripeAccountStatus.VERIFIED) {
      // Stamped once. A re-verification after a restriction must not move the
      // original date, and Stripe redelivers webhooks freely.
      await this.prisma.user.updateMany({
        where: { stripeConnectAccountId: accountId, stripeVerifiedAt: null },
        data: { stripeVerifiedAt: new Date() },
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { stripeConnectAccountId: accountId },
      select: { id: true },
    });
    if (user) {
      await this.syncStripeDestination(
        user.id,
        accountId,
        status === StripeAccountStatus.VERIFIED,
      );
    }

    return result.count;
  }

  /**
   * Stamps settlement, once.
   *
   * The `settledAt: null` guard makes a redelivered `transfer.paid` update
   * zero rows rather than moving the date — Stripe retries, and an idempotent
   * write is the difference between a stable timestamp and a drifting one.
   */
  async markSettled(stripeTransferId: string): Promise<number> {
    const result = await this.prisma.payout.updateMany({
      where: { stripeTransferId, status: PayoutStatus.PAID, settledAt: null },
      data: { settledAt: new Date() },
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

  async markFailed(id: string, reason: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.payout.updateMany({
        where: {
          id,
          status: { in: [PayoutStatus.PROCESSING, PayoutStatus.PAID] },
        },
        data: {
          status: PayoutStatus.FAILED,
          paidAt: null,
          settledAt: null,
          failureReason: reason.slice(0, 500),
        },
      });

      if (result.count > 0) {
        const withdrawal = await tx.withdrawalRequest.findFirst({
          where: { payout: { id }, releaseTransactionId: null },
        });
        if (withdrawal) {
          const release = await recordLedgerEntry(tx, {
            userId: withdrawal.userId,
            type: TransactionType.REFUND,
            amount: withdrawal.amount,
            status: TransactionStatus.COMPLETED,
            reference: `withdrawal-release:${withdrawal.id}`,
            payoutId: id,
            description: 'Failed withdrawal reservation released',
          });
          if (release.outcome !== 'RECORDED') {
            throw new PayoutLedgerError(
              `WITHDRAWAL_RELEASE_${release.outcome}`,
            );
          }
          await tx.withdrawalRequest.update({
            where: { id: withdrawal.id },
            data: {
              reviewReason: reason.slice(0, 500),
              releaseTransactionId: release.transaction.id,
            },
          });
          await tx.transaction.update({
            where: { id: withdrawal.reservationTransactionId },
            data: { status: TransactionStatus.REVERSED },
          });
        }
        await tx.transaction.updateMany({
          where: { payoutId: id, affectsBalance: false },
          data: { status: TransactionStatus.FAILED },
        });
      }

      return result.count;
    });
  }

  /** Claims a Stripe event once, while allowing a previously failed event to retry. */
  async claimStripeWebhook(event: {
    id: string;
    type: string;
    data: { object: Record<string, unknown> };
  }): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          eventId: event.id,
          source: 'STRIPE',
          type: event.type,
          payload: JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue,
          status: WebhookEventStatus.RECEIVED,
        },
      });
      return true;
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }

      const retried = await this.prisma.webhookEvent.updateMany({
        where: {
          eventId: event.id,
          source: 'STRIPE',
          status: WebhookEventStatus.FAILED,
        },
        data: {
          status: WebhookEventStatus.RECEIVED,
          errorMessage: null,
          processedAt: null,
          attempts: { increment: 1 },
        },
      });

      return retried.count === 1;
    }
  }

  async markStripeWebhookProcessed(eventId: string): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: {
        eventId,
        source: 'STRIPE',
        status: WebhookEventStatus.RECEIVED,
      },
      data: { status: WebhookEventStatus.PROCESSED, processedAt: new Date() },
    });
  }

  async markStripeWebhookFailed(
    eventId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: {
        eventId,
        source: 'STRIPE',
        status: WebhookEventStatus.RECEIVED,
      },
      data: {
        status: WebhookEventStatus.FAILED,
        errorMessage: reason.slice(0, 500),
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
