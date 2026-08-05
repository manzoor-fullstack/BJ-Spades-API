import type { Permission, Role, RolePermission } from '@prisma/client';

/** A Role loaded with its permission rows and its admin headcount. */
export type RoleWithMeta = Role & {
  permissions: (RolePermission & { permission: Permission })[];
  _count: { admins: number };
};

/**
 * The role shape the UI renders.
 *
 * `adminCount` is here so the permissions modal can warn "changes affect N
 * admins" without a second round trip — the warning is the whole point of D-16,
 * where a per-admin modal became a per-role one.
 */
export interface RoleListItem {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  adminCount: number;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

export function toRoleListItem(role: RoleWithMeta): RoleListItem {
  return {
    id: role.id,
    name: role.name,
    displayName: role.displayName,
    description: role.description,
    isSystem: role.isSystem,
    adminCount: role._count.admins,
    permissions: role.permissions.map((entry) => entry.permission.code).sort(),
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}
