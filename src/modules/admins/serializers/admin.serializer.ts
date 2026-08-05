import type { Admin, Permission, Role, RolePermission } from '@prisma/client';

import {
  initialsOf,
  joinFullName,
} from '../../../common/text/split-full-name.util';

/** An Admin loaded with its role and that role's permission rows. */
export type AdminWithRole = Admin & {
  role: Role & {
    permissions: (RolePermission & { permission: Permission })[];
  };
};

export interface AdminRoleSummary {
  id: string;
  name: string;
  displayName: string;
}

/**
 * The row shape the admin-users table renders.
 *
 * Every field is listed explicitly, which is the whole point: `password` is a
 * column on Admin, and a spread of the model would put the bcrypt hash in an
 * HTTP response. Serialising by allowlist makes that impossible rather than
 * merely unlikely (docs/phases/PHASE-3.md, task 3.4).
 *
 * `fullName` and `initials` are computed here so the table, the avatars and the
 * audit titles can never disagree about how a name is displayed.
 */
export interface AdminListItem {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  initials: string;
  email: string;
  isActive: boolean;
  lastLogin: Date | null;
  role: AdminRoleSummary;
  /** Permission codes granted through the role, for the UI's chips. */
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

export function toAdminListItem(admin: AdminWithRole): AdminListItem {
  return {
    id: admin.id,
    firstName: admin.firstName,
    lastName: admin.lastName,
    fullName: joinFullName(admin.firstName, admin.lastName),
    initials: initialsOf(admin.firstName, admin.lastName),
    email: admin.email,
    isActive: admin.isActive,
    lastLogin: admin.lastLogin,
    role: {
      id: admin.role.id,
      name: admin.role.name,
      displayName: admin.role.displayName,
    },
    permissions: admin.role.permissions
      .map((entry) => entry.permission.code)
      .sort(),
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
  };
}
