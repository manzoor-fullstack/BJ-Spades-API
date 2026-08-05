import { Injectable, Logger } from '@nestjs/common';
import type { ActivityCategory } from '@prisma/client';

import { sanitizeMetadata } from '../../common/audit/metadata-sanitizer.util';
import {
  activityActionTitle,
  isHighPriorityAction,
} from '../../common/constants/activity-actions';
import {
  buildPaginationMeta,
  resolveSortField,
  SortOrder,
} from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';

import { QueryActivityDto } from './dto/query-activity.dto';
import {
  ActivityLogRepository,
  type ActivityFilter,
  type ListActivityArgs,
} from './repositories/activity.repository';
import {
  toActivityListItem,
  type ActivityListItem,
} from './serializers/activity.serializer';

/**
 * What a caller hands `record()`.
 *
 * `title` and `isHighPriority` are optional: left out, they come from the
 * action catalogue, which is the whole point of having one.
 */
export interface RecordActivityInput {
  category: ActivityCategory;
  action: string;
  title?: string;
  description?: string | null;
  adminId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  isHighPriority?: boolean;
}

const SORTABLE_FIELDS = [
  'createdAt',
  'category',
  'action',
  'isHighPriority',
] as const;

const DEFAULT_SORT_FIELD = 'createdAt';

/**
 * docs/phases/PHASE-2.md, "Retention". Phase 7 moves this into `Setting` so it
 * is configurable rather than compiled in.
 */
export const ACTIVITY_RETENTION_DAYS = 180;

const MS_PER_DAY = 86_400_000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A bare `2026-08-04` as an upper bound parses to midnight, which excludes
 * everything written during that day — the opposite of what the person who
 * typed it meant. A value carrying a time is left alone.
 */
function parseRangeEnd(value: string): Date {
  return new Date(DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value);
}

function parseRangeStart(value: string): Date {
  return new Date(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
}

@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(private readonly repository: ActivityLogRepository) {}

  /**
   * Writes one entry. Callable from anywhere — the interceptor covers
   * controller routes, but failed logins and token-reuse detection happen on a
   * throwing path the interceptor never sees.
   *
   * Never rejects. Losing an audit row is bad; failing a successful mutation
   * because the audit write failed is worse (docs/phases/PHASE-2.md).
   */
  async record(input: RecordActivityInput): Promise<void> {
    try {
      await this.repository.create({
        category: input.category,
        action: input.action,
        title: input.title ?? activityActionTitle(input.action),
        description: input.description ?? null,
        adminId: input.adminId ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        metadata: sanitizeMetadata(input.metadata),
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        isHighPriority:
          input.isHighPriority ?? isHighPriorityAction(input.action),
      });
    } catch (error) {
      this.logger.error(
        `Failed to write activity log entry "${input.action}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async findAll(
    query: QueryActivityDto,
  ): Promise<Paginated<ActivityListItem[]>> {
    const args = this.buildListArgs(query);

    const [rows, total] = await Promise.all([
      this.repository.findMany(args),
      this.repository.count(args.filter),
    ]);

    return {
      data: rows.map(toActivityListItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findRecent(limit: number): Promise<ActivityListItem[]> {
    const rows = await this.repository.findRecent(limit);

    return rows.map(toActivityListItem);
  }

  /**
   * Deletes entries older than the retention window and returns how many went.
   *
   * Not scheduled: `@nestjs/schedule` is deliberately not a dependency yet, so
   * this is invoked from a maintenance script or a platform cron until Phase 7
   * introduces the scheduler alongside the configurable window.
   */
  async pruneOlderThan(
    days: number = ACTIVITY_RETENTION_DAYS,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - days * MS_PER_DAY);
    const deleted = await this.repository.deleteOlderThan(cutoff);

    if (deleted > 0) {
      this.logger.log(
        `Pruned ${deleted} activity log entries older than ${cutoff.toISOString()}`,
      );
    }

    return deleted;
  }

  private buildListArgs(query: QueryActivityDto): ListActivityArgs {
    const filter: ActivityFilter = {
      category: query.category,
      adminId: query.adminId,
      entityType: query.entityType,
      entityId: query.entityId,
      isHighPriority: query.isHighPriority,
      from: query.from ? parseRangeStart(query.from) : undefined,
      to: query.to ? parseRangeEnd(query.to) : undefined,
      search: query.search?.trim() ? query.search.trim() : undefined,
    };

    return {
      filter,
      sortBy: resolveSortField(
        query.sortBy,
        SORTABLE_FIELDS,
        DEFAULT_SORT_FIELD,
      ),
      sortOrder: query.sortOrder === SortOrder.ASC ? 'asc' : 'desc',
      skip: query.skip,
      take: query.take,
    };
  }
}
