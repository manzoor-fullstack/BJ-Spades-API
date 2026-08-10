import { Injectable } from '@nestjs/common';
import { DisputeRisk, DisputeStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  OPEN_DISPUTE_STATUSES,
  type DisputeStats,
} from '../serializers/dispute.serializer';

const DISPUTE_INCLUDE = {
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  tournament: { select: { id: true, name: true } },
} satisfies Prisma.DisputeInclude;

export type DisputeWithRelations = Prisma.DisputeGetPayload<{
  include: typeof DISPUTE_INCLUDE;
}>;

export interface DisputeFilter {
  search?: string;
  status?: DisputeStatus;
  risk?: DisputeRisk;
}

export interface ListDisputesArgs {
  filter: DisputeFilter;
  skip: number;
  take: number;
}

@Injectable()
export class DisputesRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: DisputeFilter): Prisma.DisputeWhereInput {
    const where: Prisma.DisputeWhereInput = {};

    if (filter.status) where.status = filter.status;
    if (filter.risk) where.risk = filter.risk;

    if (filter.search) {
      const contains: Prisma.StringFilter = {
        contains: filter.search,
        mode: 'insensitive',
      };

      where.OR = [
        { caseNumber: contains },
        { user: { firstName: contains } },
        { user: { lastName: contains } },
        { user: { email: contains } },
        { reason: contains },
        { matchReference: contains },
      ];
    }

    return where;
  }

  findMany(args: ListDisputesArgs): Promise<DisputeWithRelations[]> {
    return this.prisma.dispute.findMany({
      where: this.buildWhere(args.filter),
      include: DISPUTE_INCLUDE,
      // Newest first: an anti-cheat queue is driven by what just happened,
      // unlike the claims queue where the longest wait matters most.
      orderBy: [{ filedAt: 'desc' }, { id: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: DisputeFilter): Promise<number> {
    return this.prisma.dispute.count({ where: this.buildWhere(filter) });
  }

  findById(id: string): Promise<DisputeWithRelations | null> {
    return this.prisma.dispute.findUnique({
      where: { id },
      include: DISPUTE_INCLUDE,
    });
  }

  /**
   * Resolves a dispute, but only from an open state.
   *
   * The status is in the WHERE clause so two admins resolving the same case at
   * once produce one winner rather than the second overwriting the first's
   * verdict and resolver.
   */
  async resolve(
    id: string,
    status: DisputeStatus,
    adminId: string,
    note: string,
  ): Promise<number> {
    const result = await this.prisma.dispute.updateMany({
      where: { id, status: { in: [...OPEN_DISPUTE_STATUSES] } },
      data: {
        status,
        resolvedAt: new Date(),
        resolvedByAdminId: adminId,
        resolutionNote: note,
      },
    });

    return result.count;
  }

  async stats(): Promise<DisputeStats> {
    const [openCases, highRisk, cleared, disqualified] = await Promise.all([
      this.prisma.dispute.count({
        where: { status: { in: [...OPEN_DISPUTE_STATUSES] } },
      }),
      // High and critical among OPEN cases only: a resolved critical case is
      // not something anyone still needs to act on.
      this.prisma.dispute.count({
        where: {
          status: { in: [...OPEN_DISPUTE_STATUSES] },
          risk: { in: [DisputeRisk.HIGH, DisputeRisk.CRITICAL] },
        },
      }),
      this.prisma.dispute.count({ where: { status: DisputeStatus.CLEARED } }),
      this.prisma.dispute.count({
        where: { status: DisputeStatus.DISQUALIFIED },
      }),
    ]);

    return { openCases, highRisk, cleared, disqualified };
  }
}
