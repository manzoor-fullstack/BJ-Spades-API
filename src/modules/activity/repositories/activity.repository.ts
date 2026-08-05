import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ActivityCategory } from '@prisma/client';

import type { JsonValue } from '../../../common/audit/metadata-sanitizer.util';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * A filter in domain terms. Translating it into a `Prisma.ActivityLogWhereInput`
 * is this repository's job, so the service stays free of Prisma types and its
 * filter logic is assertable without a database.
 */
export interface ActivityFilter {
  category?: ActivityCategory;
  adminId?: string;
  entityType?: string;
  entityId?: string;
  isHighPriority?: boolean;
  /** Inclusive at both ends. */
  from?: Date;
  to?: Date;
  /** Matched against title and description. */
  search?: string;
}

export interface ListActivityArgs {
  filter: ActivityFilter;
  /** Already validated against an allowlist by the service. */
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  skip: number;
  take: number;
}

export interface CreateActivityLogData {
  category: ActivityCategory;
  action: string;
  title: string;
  description?: string | null;
  adminId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: JsonValue;
  ipAddress?: string | null;
  userAgent?: string | null;
  isHighPriority: boolean;
}

const ACTIVITY_WITH_ADMIN = {
  admin: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.ActivityLogInclude;

export type ActivityLogWithAdmin = Prisma.ActivityLogGetPayload<{
  include: typeof ACTIVITY_WITH_ADMIN;
}>;

@Injectable()
export class ActivityLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: ActivityFilter): Prisma.ActivityLogWhereInput {
    const where: Prisma.ActivityLogWhereInput = {};

    if (filter.category) {
      where.category = filter.category;
    }

    if (filter.adminId) {
      where.adminId = filter.adminId;
    }

    if (filter.entityType) {
      where.entityType = filter.entityType;
    }

    if (filter.entityId) {
      where.entityId = filter.entityId;
    }

    if (filter.isHighPriority !== undefined) {
      where.isHighPriority = filter.isHighPriority;
    }

    if (filter.from || filter.to) {
      where.createdAt = {
        ...(filter.from ? { gte: filter.from } : {}),
        ...(filter.to ? { lte: filter.to } : {}),
      };
    }

    if (filter.search) {
      const contains: Prisma.StringFilter = {
        contains: filter.search,
        mode: 'insensitive',
      };

      where.OR = [{ title: contains }, { description: contains }];
    }

    return where;
  }

  async create(data: CreateActivityLogData): Promise<void> {
    await this.prisma.activityLog.create({
      data: {
        category: data.category,
        action: data.action,
        title: data.title,
        description: data.description ?? null,
        adminId: data.adminId ?? null,
        entityType: data.entityType ?? null,
        entityId: data.entityId ?? null,
        // Already sanitized and JSON-safe; the cast only bridges our JsonValue
        // to Prisma's generated input type.
        ...(data.metadata === undefined
          ? {}
          : { metadata: data.metadata as Prisma.InputJsonValue }),
        ipAddress: data.ipAddress ?? null,
        userAgent: data.userAgent ?? null,
        isHighPriority: data.isHighPriority,
      },
    });
  }

  findMany(args: ListActivityArgs): Promise<ActivityLogWithAdmin[]> {
    return this.prisma.activityLog.findMany({
      where: this.buildWhere(args.filter),
      include: ACTIVITY_WITH_ADMIN,
      // A secondary key on the primary key keeps paging deterministic when
      // several entries share a timestamp — without it page 2 can repeat a row.
      orderBy: [{ [args.sortBy]: args.sortOrder }, { id: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: ActivityFilter): Promise<number> {
    return this.prisma.activityLog.count({ where: this.buildWhere(filter) });
  }

  findRecent(limit: number): Promise<ActivityLogWithAdmin[]> {
    return this.prisma.activityLog.findMany({
      include: ACTIVITY_WITH_ADMIN,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
    });
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await this.prisma.activityLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    return result.count;
  }
}
