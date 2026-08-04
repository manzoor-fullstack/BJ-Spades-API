import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { User, UserSource, UserStatus, UserTier } from '@prisma/client';

import type { Money } from '../../../common/money/money.util';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * A filter expressed in domain terms, not Prisma terms.
 *
 * The service composes one of these from the query DTO; translating it into a
 * `Prisma.UserWhereInput` is this repository's job. That keeps every Prisma
 * type behind the repository boundary and makes the service's filter logic
 * assertable in a unit test without a database.
 */
export interface UserFilter {
  search?: string;
  status?: UserStatus;
  tier?: UserTier;
  source?: UserSource;
  createdFrom?: Date;
  createdTo?: Date;
  /** Soft-deleted rows are hidden unless the caller asked for them. */
  includeDeleted?: boolean;
}

export interface ListUsersArgs {
  filter: UserFilter;
  /** Already validated against an allowlist by the service. */
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  skip: number;
  take: number;
}

export interface CreateUserData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  tier: UserTier;
  source: UserSource;
  balance: Money;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  createdByAdminId: string | null;
}

export type UpdateUserData = Partial<
  Omit<CreateUserData, 'balance' | 'source' | 'createdByAdminId'>
> & {
  deletedAt?: Date | null;
  lastActiveAt?: Date | null;
};

export interface GroupCount {
  key: string;
  count: number;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `status=DELETED` is the only way to see soft-deleted rows: asking for that
   * status implies the caller wants them, so the `deletedAt: null` guard is
   * lifted rather than contradicting itself.
   */
  private buildWhere(filter: UserFilter): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = {};

    if (!filter.includeDeleted) {
      where.deletedAt = null;
    }

    if (filter.status) {
      where.status = filter.status;
    }

    if (filter.tier) {
      where.tier = filter.tier;
    }

    if (filter.source) {
      where.source = filter.source;
    }

    if (filter.createdFrom || filter.createdTo) {
      where.createdAt = {
        ...(filter.createdFrom ? { gte: filter.createdFrom } : {}),
        ...(filter.createdTo ? { lte: filter.createdTo } : {}),
      };
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
        { phone: contains },
      ];
    }

    return where;
  }

  findMany(args: ListUsersArgs): Promise<User[]> {
    return this.prisma.user.findMany({
      where: this.buildWhere(args.filter),
      // A secondary key on the primary key makes paging deterministic when the
      // sort column has ties — without it page 2 can repeat a row from page 1.
      orderBy: [{ [args.sortBy]: args.sortOrder }, { id: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: UserFilter): Promise<number> {
    return this.prisma.user.count({ where: this.buildWhere(filter) });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { phone } });
  }

  create(data: CreateUserData): Promise<User> {
    return this.prisma.user.create({ data });
  }

  update(id: string, data: UpdateUserData): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }

  /**
   * Applies a signed delta in a single statement, refusing the update when the
   * balance is no longer high enough to absorb it.
   *
   * Read-then-write would let two concurrent debits both pass a "would this go
   * negative?" check and jointly overdraw the account. The `gte` guard makes
   * the check and the write one atomic operation; a return of 0 means the guard
   * rejected it.
   */
  async applyBalanceDelta(
    id: string,
    amount: Money,
    minimumBalance: Money,
  ): Promise<number> {
    const result = await this.prisma.user.updateMany({
      where: { id, deletedAt: null, balance: { gte: minimumBalance } },
      data: { balance: { increment: amount } },
    });

    return result.count;
  }

  private async groupBy(
    field: 'status' | 'source' | 'tier',
  ): Promise<GroupCount[]> {
    // `by` is a literal union in Prisma's types, so each branch is spelled out
    // rather than passed through a variable that widens to string[].
    if (field === 'status') {
      const rows = await this.prisma.user.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      });

      return rows.map((row) => ({
        key: row.status,
        count: row._count._all,
      }));
    }

    if (field === 'source') {
      const rows = await this.prisma.user.groupBy({
        by: ['source'],
        where: { deletedAt: null },
        _count: { _all: true },
      });

      return rows.map((row) => ({
        key: row.source,
        count: row._count._all,
      }));
    }

    const rows = await this.prisma.user.groupBy({
      by: ['tier'],
      where: { deletedAt: null },
      _count: { _all: true },
    });

    return rows.map((row) => ({ key: row.tier, count: row._count._all }));
  }

  countByStatus(): Promise<GroupCount[]> {
    return this.groupBy('status');
  }

  countBySource(): Promise<GroupCount[]> {
    return this.groupBy('source');
  }

  countByTier(): Promise<GroupCount[]> {
    return this.groupBy('tier');
  }

  countCreatedSince(since: Date): Promise<number> {
    return this.prisma.user.count({
      where: { deletedAt: null, createdAt: { gte: since } },
    });
  }
}
