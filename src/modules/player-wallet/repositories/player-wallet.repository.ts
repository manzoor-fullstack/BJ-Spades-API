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
    const settledWhere: Prisma.TransactionWhereInput = {
      userId,
      // REVERSED entries are real compensating movements (for example a card
      // refund), so excluding them would make the summary disagree with the
      // available balance.
      status: { in: [TransactionStatus.COMPLETED, TransactionStatus.REVERSED] },
      affectsBalance: true,
    };

    const [user, groups, weekly, pending, legacyPending] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { balance: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: settledWhere,
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { ...settledWhere, createdAt: { gte: since } },
        _sum: { amount: true },
      }),
      this.prisma.withdrawalRequest.aggregate({
        where: {
          userId,
          releaseTransactionId: null,
          payout: {
            status: {
              notIn: ['PAID', 'FAILED', 'CANCELLED'],
            },
          },
        },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: {
          userId,
          type: TransactionType.WITHDRAWAL,
          status: TransactionStatus.PENDING,
          withdrawalReservation: null,
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
      pendingWithdrawal: (pending._sum.amount ?? new Prisma.Decimal(0)).plus(
        (legacyPending._sum.amount ?? new Prisma.Decimal(0)).abs(),
      ),
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
