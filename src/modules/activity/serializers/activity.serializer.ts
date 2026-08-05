import type { ActivityCategory } from '@prisma/client';

import { joinFullName } from '../../../common/text/split-full-name.util';
import type { ActivityLogWithAdmin } from '../repositories/activity.repository';

export interface ActivityAdminSummary {
  id: string;
  fullName: string;
}

/**
 * The row shape rendered by `/activity` and the dashboard sidebar.
 *
 * `createdAt` is an ISO-8601 string, not a Date: the relative rendering
 * ("2 minutes ago") is the frontend's job (docs/03-API-CONTRACT.md).
 */
export interface ActivityListItem {
  id: string;
  category: ActivityCategory;
  action: string;
  title: string;
  description: string | null;
  /** Null once the acting admin has been deleted — `onDelete: SetNull`. */
  admin: ActivityAdminSummary | null;
  entityType: string | null;
  entityId: string | null;
  isHighPriority: boolean;
  createdAt: string;
}

export function toActivityListItem(
  row: ActivityLogWithAdmin,
): ActivityListItem {
  return {
    id: row.id,
    category: row.category,
    action: row.action,
    title: row.title,
    description: row.description,
    admin: row.admin
      ? {
          id: row.admin.id,
          fullName: joinFullName(row.admin.firstName, row.admin.lastName),
        }
      : null,
    entityType: row.entityType,
    entityId: row.entityId,
    isHighPriority: row.isHighPriority,
    createdAt: row.createdAt.toISOString(),
  };
}
