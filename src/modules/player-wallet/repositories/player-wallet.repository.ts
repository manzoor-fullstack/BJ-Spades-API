import { Injectable } from '@nestjs/common';
import { Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import type { Transaction } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export interface PlayerWalletTotals {
  balance: Prisma.Decimal;
  byType: Map<TransactionType, Prisma.Decimal>;
  weeklyChange: Prisma.Decimal;
  pendingWithdrawal: Prisma.Decimal;
}

@Injectable()
export class PlayerWalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  async totals(
    userId: string,
    since: Date,
  ): Promise<PlayerWalletTotals | null> {
    const completedWhere: Prisma.TransactionWhereInput = {
      userId,
      status: TransactionStatus.COMPLETED,
      affectsBalance: true,
    };

    const [user, groups, weekly, pending] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { balance: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: completedWhere,
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { ...completedWhere, createdAt: { gte: since } },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: {
          userId,
          type: TransactionType.WITHDRAWAL,
          status: TransactionStatus.PENDING,
        },
        _sum: { amount: true },
      }),
    ]);

    if (!user) return null;

    return {
      balance: user.balance,
      byType: new Map(
        groups.map((group) => [
          group.type,
          group._sum.amount ?? new Prisma.Decimal(0),
        ]),
      ),
      weeklyChange: weekly._sum.amount ?? new Prisma.Decimal(0),
      pendingWithdrawal: pending._sum.amount ?? new Prisma.Decimal(0),
    };
  }

  findOwnedTransaction(
    userId: string,
    transactionId: string,
  ): Promise<Transaction | null> {
    return this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
    });
  }
}
