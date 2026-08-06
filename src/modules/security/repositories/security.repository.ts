import { Injectable } from '@nestjs/common';
import { ActivityCategory, Prisma } from '@prisma/client';

import { ACTIVITY_ACTIONS } from '../../../common/constants/activity-actions';
import { PrismaService } from '../../prisma/prisma.service';
import type { ActivityLogWithAdmin } from '../../activity/repositories/activity.repository';

const ACTIVITY_WITH_ADMIN = {
  admin: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.ActivityLogInclude;

export interface ListAlertsArgs {
  /** Narrow the feed to high-priority entries only. */
  highPriorityOnly: boolean;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  skip: number;
  take: number;
}

/**
 * Reads for the security page.
 *
 * There is no `SecurityAlert` query here, and that is the point (D-06). The
 * `SecurityAlert` table exists in the schema but nothing writes to it, because
 * writing to it would mean inventing an alert — Milestone 1 has no anomaly
 * detection, no geo-IP correlation, and no triage model. The feed is built from
 * `ActivityLog` instead, where every row corresponds to something that actually
 * happened: a failed sign-in, a suspension, a balance adjustment, a revocation.
 */
@Injectable()
export class SecurityRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Security-relevant activity: anything filed under SECURITY, plus anything
   * flagged high priority wherever it was filed. The second half is what pulls
   * in failed logins (AUTH) and balance adjustments (USER).
   */
  private buildAlertWhere(
    highPriorityOnly: boolean,
  ): Prisma.ActivityLogWhereInput {
    if (highPriorityOnly) {
      return { isHighPriority: true };
    }

    return {
      OR: [{ category: ActivityCategory.SECURITY }, { isHighPriority: true }],
    };
  }

  findAlerts(args: ListAlertsArgs): Promise<ActivityLogWithAdmin[]> {
    return this.prisma.activityLog.findMany({
      where: this.buildAlertWhere(args.highPriorityOnly),
      include: ACTIVITY_WITH_ADMIN,
      // The id tiebreak keeps paging stable when several rows share a
      // timestamp — without it page 2 can repeat a row from page 1.
      orderBy: [{ [args.sortBy]: args.sortOrder }, { id: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  countAlerts(highPriorityOnly: boolean): Promise<number> {
    return this.prisma.activityLog.count({
      where: this.buildAlertWhere(highPriorityOnly),
    });
  }

  /**
   * Failed sign-ins since `since`.
   *
   * Read from `ActivityLog` because that is where `AuthService` records them —
   * on the throwing path, where no interceptor runs. Each row is a real
   * rejected attempt.
   */
  countFailedLoginsSince(since: Date): Promise<number> {
    return this.prisma.activityLog.count({
      where: {
        action: ACTIVITY_ACTIONS.AUTH_LOGIN_FAILED.code,
        createdAt: { gte: since },
      },
    });
  }

  countHighPriorityAlertsSince(since: Date): Promise<number> {
    return this.prisma.activityLog.count({
      where: { isHighPriority: true, createdAt: { gte: since } },
    });
  }
}
