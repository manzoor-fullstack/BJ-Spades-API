import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TournamentStatus,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { Period } from '../period.util';

/**
 * A tournament is "active" while players can still join it or are still
 * playing it. SCHEDULED is excluded: registration has not opened, so nothing is
 * happening yet. COMPLETED and CANCELLED are over.
 *
 * This card replaces the mock "Active Games" one — there is no game engine and
 * no match model, so a live-game count has no possible source (D-03).
 */
const ACTIVE_TOURNAMENT_STATUSES = [
  TournamentStatus.REGISTERING,
  TournamentStatus.IN_PROGRESS,
];

/**
 * Revenue is entry fees that actually settled.
 *
 * `Transaction.amount` is signed from the *user's* point of view — an entry fee
 * is money leaving their balance — so the magnitude is what the platform took.
 * `.abs()` is applied when the sum is read, which is correct under either sign
 * convention and cannot silently report negative revenue if the ledger stores
 * entry fees as debits.
 *
 * PENDING and FAILED rows are excluded: money that has not moved is not
 * revenue.
 */
const REVENUE_WHERE: Prisma.TransactionWhereInput = {
  type: TransactionType.ENTRY_FEE,
  status: TransactionStatus.COMPLETED,
};

@Injectable()
export class DashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Soft-deleted users are not users. Every count here honours that. */
  countUsers(): Promise<number> {
    return this.prisma.user.count({ where: { deletedAt: null } });
  }

  countUsersCreatedIn(period: Period): Promise<number> {
    return this.prisma.user.count({
      where: {
        deletedAt: null,
        createdAt: { gte: period.start, lt: period.end },
      },
    });
  }

  async sumEntryFeeRevenue(): Promise<Prisma.Decimal> {
    const result = await this.prisma.transaction.aggregate({
      where: REVENUE_WHERE,
      _sum: { amount: true },
    });

    return (result._sum.amount ?? new Prisma.Decimal(0)).abs();
  }

  async sumEntryFeeRevenueIn(period: Period): Promise<Prisma.Decimal> {
    const result = await this.prisma.transaction.aggregate({
      where: {
        ...REVENUE_WHERE,
        createdAt: { gte: period.start, lt: period.end },
      },
      _sum: { amount: true },
    });

    return (result._sum.amount ?? new Prisma.Decimal(0)).abs();
  }

  countActiveTournaments(): Promise<number> {
    return this.prisma.tournament.count({
      where: { status: { in: ACTIVE_TOURNAMENT_STATUSES } },
    });
  }
}
