import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { AdminWithRole } from '../serializers/admin.serializer';

/**
 * Loaded on every read path, because AdminListItem exposes the role summary and
 * the role's permission codes. One include keeps the two from drifting apart.
 */
const ADMIN_INCLUDE = {
  role: {
    include: {
      permissions: {
        include: { permission: true },
      },
    },
  },
} satisfies Prisma.AdminInclude;

/** A filter in domain terms; translating it to Prisma is this class's job. */
export interface AdminFilter {
  /** Matched case-insensitively against firstName, lastName and email. */
  search?: string;
  roleId?: string;
  /** Role `name`, e.g. `SUPER_ADMIN`. Accepted alongside roleId. */
  roleName?: string;
}

export interface ListAdminsArgs {
  filter: AdminFilter;
  /** Already validated against an allowlist by the service. */
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  skip: number;
  take: number;
}

export interface CreateAdminData {
  firstName: string;
  lastName: string;
  email: string;
  /** Already hashed by the service. Plaintext never reaches this layer. */
  password: string;
  roleId: string;
}

export interface UpdateAdminData {
  firstName?: string;
  lastName?: string;
  email?: string;
  password?: string;
  roleId?: string;
  isActive?: boolean;
  lastLogin?: Date;
}

@Injectable()
export class AdminsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: AdminFilter): Prisma.AdminWhereInput {
    const where: Prisma.AdminWhereInput = {};

    if (filter.roleId) {
      where.roleId = filter.roleId;
    }

    if (filter.roleName) {
      where.role = { name: filter.roleName };
    }

    if (filter.search) {
      const contains: Prisma.StringFilter = {
        contains: filter.search,
        mode: 'insensitive',
      };

      where.OR = [
        { firstName: contains },
        { lastName: contains },
        { email: contains },
      ];
    }

    return where;
  }

  findMany(args: ListAdminsArgs): Promise<AdminWithRole[]> {
    return this.prisma.admin.findMany({
      where: this.buildWhere(args.filter),
      include: ADMIN_INCLUDE,
      // The id tiebreaker keeps paging deterministic when the sort column has
      // ties — without it page 2 can repeat a row from page 1.
      orderBy: [{ [args.sortBy]: args.sortOrder }, { id: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: AdminFilter): Promise<number> {
    return this.prisma.admin.count({ where: this.buildWhere(filter) });
  }

  findById(id: string): Promise<AdminWithRole | null> {
    return this.prisma.admin.findUnique({
      where: { id },
      include: ADMIN_INCLUDE,
    });
  }

  findByEmail(email: string): Promise<AdminWithRole | null> {
    return this.prisma.admin.findUnique({
      where: { email },
      include: ADMIN_INCLUDE,
    });
  }

  create(data: CreateAdminData): Promise<AdminWithRole> {
    return this.prisma.admin.create({ data, include: ADMIN_INCLUDE });
  }

  update(id: string, data: UpdateAdminData): Promise<AdminWithRole> {
    return this.prisma.admin.update({
      where: { id },
      data,
      include: ADMIN_INCLUDE,
    });
  }

  /**
   * Returns the deleted row so the caller can name the person in the audit
   * entry instead of logging a bare UUID.
   */
  delete(id: string): Promise<AdminWithRole> {
    return this.prisma.admin.delete({
      where: { id },
      include: ADMIN_INCLUDE,
    });
  }

  /**
   * Active holders of a role, by role name.
   *
   * `isActive` is the point: an inactive super admin cannot sign in, so it does
   * not count towards "somebody can still administer this system".
   */
  countActiveByRoleName(roleName: string): Promise<number> {
    return this.prisma.admin.count({
      where: { isActive: true, role: { name: roleName } },
    });
  }
}
