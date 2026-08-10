import { Injectable } from '@nestjs/common';
import { PayoutMethod, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

const ACCOUNT_INCLUDE = {
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
} satisfies Prisma.PayoutMethodAccountInclude;

export type MethodAccountWithUser = Prisma.PayoutMethodAccountGetPayload<{
  include: typeof ACCOUNT_INCLUDE;
}>;

export interface MethodFilter {
  search?: string;
  method?: PayoutMethod;
  userId?: string;
}

export interface MethodAccountData {
  userId: string;
  method: PayoutMethod;
  label?: string | null;
  reference: string;
  isVerified?: boolean;
  isDefault?: boolean;
}

@Injectable()
export class PayoutMethodsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(
    filter: MethodFilter,
  ): Prisma.PayoutMethodAccountWhereInput {
    const where: Prisma.PayoutMethodAccountWhereInput = {};

    if (filter.method) where.method = filter.method;
    if (filter.userId) where.userId = filter.userId;

    if (filter.search) {
      const contains: Prisma.StringFilter = {
        contains: filter.search,
        mode: 'insensitive',
      };

      where.OR = [
        { user: { firstName: contains } },
        { user: { lastName: contains } },
        { user: { email: contains } },
        { label: contains },
        { reference: contains },
      ];
    }

    return where;
  }

  findMany(args: {
    filter: MethodFilter;
    skip: number;
    take: number;
  }): Promise<MethodAccountWithUser[]> {
    return this.prisma.payoutMethodAccount.findMany({
      where: this.buildWhere(args.filter),
      include: ACCOUNT_INCLUDE,
      orderBy: [{ isDefault: 'desc' }, { method: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: MethodFilter): Promise<number> {
    return this.prisma.payoutMethodAccount.count({
      where: this.buildWhere(filter),
    });
  }

  findById(id: string): Promise<MethodAccountWithUser | null> {
    return this.prisma.payoutMethodAccount.findUnique({
      where: { id },
      include: ACCOUNT_INCLUDE,
    });
  }

  /**
   * Connects a rail, or updates it if the player already had one.
   *
   * `@@unique([userId, method])` makes a second Zelle account for the same
   * player impossible at the database level rather than through a
   * check-then-insert race.
   */
  upsert(data: MethodAccountData): Promise<MethodAccountWithUser> {
    return this.prisma.payoutMethodAccount.upsert({
      where: { userId_method: { userId: data.userId, method: data.method } },
      update: {
        label: data.label ?? null,
        reference: data.reference,
        isVerified: data.isVerified ?? false,
      },
      create: data,
      include: ACCOUNT_INCLUDE,
    });
  }

  /**
   * Makes one account the default and clears the flag from the player's
   * others, in a transaction — two defaults would leave the operator guessing
   * which one a payout uses.
   */
  async setDefault(id: string, userId: string): Promise<MethodAccountWithUser> {
    const [, account] = await this.prisma.$transaction([
      this.prisma.payoutMethodAccount.updateMany({
        where: { userId, id: { not: id } },
        data: { isDefault: false },
      }),
      this.prisma.payoutMethodAccount.update({
        where: { id },
        data: { isDefault: true },
        include: ACCOUNT_INCLUDE,
      }),
    ]);

    return account;
  }

  setVerified(id: string, isVerified: boolean): Promise<MethodAccountWithUser> {
    return this.prisma.payoutMethodAccount.update({
      where: { id },
      data: { isVerified },
      include: ACCOUNT_INCLUDE,
    });
  }

  delete(id: string): Promise<{ id: string }> {
    return this.prisma.payoutMethodAccount.delete({
      where: { id },
      select: { id: true },
    });
  }
}
