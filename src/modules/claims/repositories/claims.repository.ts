import { Injectable } from '@nestjs/common';
import { ClaimStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { ClaimStats } from '../serializers/claim.serializer';

const CLAIM_INCLUDE = {
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  tournament: { select: { id: true, name: true } },
} satisfies Prisma.PrizeClaimInclude;

export type ClaimWithRelations = Prisma.PrizeClaimGetPayload<{
  include: typeof CLAIM_INCLUDE;
}>;

export interface ClaimFilter {
  search?: string;
  status?: ClaimStatus;
}

export interface ListClaimsArgs {
  filter: ClaimFilter;
  skip: number;
  take: number;
}

@Injectable()
export class ClaimsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: ClaimFilter): Prisma.PrizeClaimWhereInput {
    const where: Prisma.PrizeClaimWhereInput = {};

    if (filter.status) where.status = filter.status;

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
        { prizeDescription: contains },
      ];
    }

    return where;
  }

  findMany(args: ListClaimsArgs): Promise<ClaimWithRelations[]> {
    return this.prisma.prizeClaim.findMany({
      where: this.buildWhere(args.filter),
      include: CLAIM_INCLUDE,
      // Oldest first: the tab is a review queue, and the claim that has waited
      // longest is the one to look at next.
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: ClaimFilter): Promise<number> {
    return this.prisma.prizeClaim.count({ where: this.buildWhere(filter) });
  }

  findById(id: string): Promise<ClaimWithRelations | null> {
    return this.prisma.prizeClaim.findUnique({
      where: { id },
      include: CLAIM_INCLUDE,
    });
  }

  /**
   * Decides a claim, but only from PENDING_REVIEW.
   *
   * The status is part of the WHERE clause rather than checked beforehand, so
   * two admins deciding the same claim at once resolve to one winner instead of
   * the second silently overwriting the first's decision and reviewer.
   */
  async decide(
    id: string,
    status: ClaimStatus,
    adminId: string,
    note: string | null,
  ): Promise<number> {
    const result = await this.prisma.prizeClaim.updateMany({
      where: { id, status: ClaimStatus.PENDING_REVIEW },
      data: {
        status,
        reviewedAt: new Date(),
        reviewedByAdminId: adminId,
        decisionNote: note,
      },
    });

    return result.count;
  }

  async stats(now: Date): Promise<ClaimStats> {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [pendingReview, approvedToday, declinedToday, decided] =
      await Promise.all([
        this.prisma.prizeClaim.count({
          where: { status: ClaimStatus.PENDING_REVIEW },
        }),
        this.prisma.prizeClaim.count({
          where: {
            status: ClaimStatus.APPROVED,
            reviewedAt: { gte: startOfToday },
          },
        }),
        this.prisma.prizeClaim.count({
          where: {
            status: ClaimStatus.DECLINED,
            reviewedAt: { gte: startOfToday },
          },
        }),
        this.prisma.prizeClaim.findMany({
          where: { reviewedAt: { gte: thirtyDaysAgo, not: null } },
          select: { submittedAt: true, reviewedAt: true },
        }),
      ]);

    return {
      pendingReview,
      approvedToday,
      declinedToday,
      averageReviewHours: averageHours(decided),
    };
  }
}

/**
 * Mean hours between submission and decision.
 *
 * Returns null rather than 0 for an empty set: "0h average review time" reads
 * as instant review, which is a different and wrong statement from "nothing has
 * been reviewed".
 */
function averageHours(
  rows: { submittedAt: Date; reviewedAt: Date | null }[],
): number | null {
  const durations = rows
    .filter((row): row is { submittedAt: Date; reviewedAt: Date } =>
      Boolean(row.reviewedAt),
    )
    .map((row) => row.reviewedAt.getTime() - row.submittedAt.getTime());

  if (durations.length === 0) return null;

  const meanMs =
    durations.reduce((total, value) => total + value, 0) / durations.length;

  return Math.round((meanMs / 3_600_000) * 10) / 10;
}
