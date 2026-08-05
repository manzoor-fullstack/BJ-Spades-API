import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { RoleWithMeta } from '../serializers/role.serializer';

const ROLE_INCLUDE = {
  permissions: {
    include: { permission: true },
  },
  _count: {
    select: { admins: true },
  },
} satisfies Prisma.RoleInclude;

export interface CreateRoleData {
  name: string;
  displayName: string;
  description?: string;
  isSystem?: boolean;
}

export type UpdateRoleData = Partial<CreateRoleData>;

export interface PermissionRef {
  id: string;
  code: string;
}

@Injectable()
export class RolesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMany(): Promise<RoleWithMeta[]> {
    return this.prisma.role.findMany({
      include: ROLE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  findById(id: string): Promise<RoleWithMeta | null> {
    return this.prisma.role.findUnique({
      where: { id },
      include: ROLE_INCLUDE,
    });
  }

  findByName(name: string): Promise<RoleWithMeta | null> {
    return this.prisma.role.findUnique({
      where: { name },
      include: ROLE_INCLUDE,
    });
  }

  create(data: CreateRoleData): Promise<RoleWithMeta> {
    return this.prisma.role.create({ data, include: ROLE_INCLUDE });
  }

  update(id: string, data: UpdateRoleData): Promise<RoleWithMeta> {
    return this.prisma.role.update({
      where: { id },
      data,
      include: ROLE_INCLUDE,
    });
  }

  delete(id: string): Promise<RoleWithMeta> {
    return this.prisma.role.delete({ where: { id }, include: ROLE_INCLUDE });
  }

  findPermissionsByCodes(codes: string[]): Promise<PermissionRef[]> {
    return this.prisma.permission.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
  }

  /** Ids of every admin holding this role, for cache invalidation. */
  async findAdminIdsByRoleId(roleId: string): Promise<string[]> {
    const rows = await this.prisma.admin.findMany({
      where: { roleId },
      select: { id: true },
    });

    return rows.map((row) => row.id);
  }

  /**
   * Replaces a role's permission set wholesale, in one transaction.
   *
   * The delete and the insert must not be separately observable: between them
   * the role holds no permissions at all, and a request landing in that window
   * would be refused as though every permission had been revoked.
   */
  async replacePermissions(
    roleId: string,
    permissionIds: string[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });

      if (permissionIds.length === 0) {
        return;
      }

      await tx.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
      });
    });
  }
}
