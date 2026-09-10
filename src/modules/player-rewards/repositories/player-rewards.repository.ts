import { Injectable } from '@nestjs/common';
import {
  ItemStatus,
  Prisma,
  RewardDeliveryStatus,
  RewardRedemptionStatus,
  TransactionStatus,
  TransactionType,
  UserStatus,
} from '@prisma/client';

import { toMoney } from '../../../common/money/money.util';
import { PrismaService } from '../../prisma/prisma.service';
import { recordLedgerEntry } from '../../transactions/repositories/transactions.repository';

export const PLAYER_REDEMPTION_INCLUDE = {
  reward: { include: { image: true } },
  delivery: true,
} satisfies Prisma.RewardRedemptionInclude;

export type PlayerRedemptionRow = Prisma.RewardRedemptionGetPayload<{
  include: typeof PLAYER_REDEMPTION_INCLUDE;
}>;

export type CreateRedemptionOutcome =
  | { outcome: 'CREATED' | 'EXISTING'; redemption: PlayerRedemptionRow }
  | {
      outcome:
        'PLAYER_NOT_FOUND' | 'REWARD_UNAVAILABLE' | 'INVALID_DENOMINATION';
    }
  | { outcome: 'INSUFFICIENT_BALANCE'; balance: Prisma.Decimal };

class StockRaceError extends Error {}

@Injectable()
export class PlayerRewardsRepository {
  constructor(private readonly prisma: PrismaService) {}

  listCatalog(now: Date) {
    return this.prisma.reward.findMany({
      where: {
        deletedAt: null,
        status: ItemStatus.ACTIVE,
        denomination: { not: null },
        tokenCost: { gt: 0 },
        AND: [
          { OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
          { OR: [{ availableUntil: null }, { availableUntil: { gt: now } }] },
          { OR: [{ stock: null }, { stock: { gt: 0 } }] },
        ],
      },
      include: { image: true },
      orderBy: [{ bonusPercent: 'desc' }, { company: 'asc' }, { id: 'asc' }],
    });
  }

  listOwned(userId: string) {
    return this.prisma.rewardRedemption.findMany({
      where: { userId },
      include: PLAYER_REDEMPTION_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 100,
    });
  }

  findOwned(userId: string, id: string) {
    return this.prisma.rewardRedemption.findFirst({
      where: { id, userId },
      include: PLAYER_REDEMPTION_INCLUDE,
    });
  }

  findById(id: string) {
    return this.prisma.rewardRedemption.findUnique({
      where: { id },
      include: PLAYER_REDEMPTION_INCLUDE,
    });
  }

  async create(
    userId: string,
    input: {
      rewardId: string;
      denomination: string;
      requestId: string;
      payloadHash: string;
    },
  ): Promise<CreateRedemptionOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.rewardRedemption.findUnique({
          where: { userId_requestId: { userId, requestId: input.requestId } },
          include: PLAYER_REDEMPTION_INCLUDE,
        });
        if (existing)
          return { outcome: 'EXISTING' as const, redemption: existing };

        const now = new Date();
        const reward = await tx.reward.findFirst({
          where: {
            id: input.rewardId,
            deletedAt: null,
            status: ItemStatus.ACTIVE,
            denomination: { not: null },
            tokenCost: { gt: 0 },
            AND: [
              {
                OR: [{ availableFrom: null }, { availableFrom: { lte: now } }],
              },
              {
                OR: [{ availableUntil: null }, { availableUntil: { gt: now } }],
              },
            ],
          },
        });
        if (!reward || !reward.denomination || !reward.tokenCost) {
          return { outcome: 'REWARD_UNAVAILABLE' as const };
        }
        if (!reward.denomination.equals(toMoney(input.denomination))) {
          return { outcome: 'INVALID_DENOMINATION' as const };
        }
        const player = await tx.user.findFirst({
          where: { id: userId, status: UserStatus.ACTIVE, deletedAt: null },
          select: { id: true },
        });
        if (!player) return { outcome: 'PLAYER_NOT_FOUND' as const };

        const purchase = await recordLedgerEntry(tx, {
          userId,
          type: TransactionType.REWARD_PURCHASE,
          amount: reward.tokenCost.negated(),
          status: TransactionStatus.COMPLETED,
          reference: `reward-purchase:${userId}:${input.requestId}`,
          description: `${reward.company} ${reward.name}`,
        });
        if (purchase.outcome === 'INSUFFICIENT_BALANCE') {
          return {
            outcome: 'INSUFFICIENT_BALANCE' as const,
            balance: purchase.balance,
          };
        }
        if (purchase.outcome !== 'RECORDED') {
          return { outcome: 'PLAYER_NOT_FOUND' as const };
        }

        const reserved = await tx.reward.updateMany({
          where: {
            id: reward.id,
            OR: [{ stock: null }, { stock: { gt: 0 } }],
          },
          data: {
            stock: { decrement: 1 },
            redeemedCount: { increment: 1 },
          },
        });
        if (reserved.count !== 1) throw new StockRaceError();

        const redemption = await tx.rewardRedemption.create({
          data: {
            userId,
            rewardId: reward.id,
            requestId: input.requestId,
            payloadHash: input.payloadHash,
            denomination: reward.denomination,
            tokenCost: reward.tokenCost,
            purchaseTransactionId: purchase.transaction.id,
            delivery: { create: { status: RewardDeliveryStatus.PENDING } },
          },
          include: PLAYER_REDEMPTION_INCLUDE,
        });
        return { outcome: 'CREATED' as const, redemption };
      });
    } catch (error) {
      if (error instanceof StockRaceError) {
        return { outcome: 'REWARD_UNAVAILABLE' };
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.rewardRedemption.findUnique({
          where: { userId_requestId: { userId, requestId: input.requestId } },
          include: PLAYER_REDEMPTION_INCLUDE,
        });
        if (existing) return { outcome: 'EXISTING', redemption: existing };
      }
      throw error;
    }
  }

  cancelOwned(userId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.rewardRedemption.updateMany({
        where: {
          id,
          userId,
          status: RewardRedemptionStatus.PENDING_FULFILLMENT,
        },
        data: {
          status: RewardRedemptionStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });
      if (claimed.count === 0) return null;
      const row = await tx.rewardRedemption.findUniqueOrThrow({
        where: { id },
      });
      const refund = await recordLedgerEntry(tx, {
        userId,
        type: TransactionType.REFUND,
        amount: row.tokenCost,
        status: TransactionStatus.COMPLETED,
        reference: `reward-refund:${id}`,
        description: 'Cancelled reward order refunded',
      });
      if (refund.outcome !== 'RECORDED') {
        throw new Error(`Reward refund failed: ${refund.outcome}`);
      }
      await tx.rewardRedemption.update({
        where: { id },
        data: { refundTransactionId: refund.transaction.id },
      });
      await tx.reward.update({
        where: { id: row.rewardId },
        data: { stock: { increment: 1 }, redeemedCount: { decrement: 1 } },
      });
      return tx.rewardRedemption.findUniqueOrThrow({
        where: { id },
        include: PLAYER_REDEMPTION_INCLUDE,
      });
    });
  }

  fulfill(
    id: string,
    input: {
      encryptedCode: string;
      supplierReference: string;
      expiresAt: Date | null;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.rewardRedemption.findUnique({
        where: { id },
        include: PLAYER_REDEMPTION_INCLUDE,
      });
      if (!existing) return null;
      if (
        existing.status === RewardRedemptionStatus.FULFILLED ||
        existing.status === RewardRedemptionStatus.REDEEMED
      ) {
        return existing;
      }
      if (existing.status !== RewardRedemptionStatus.PENDING_FULFILLMENT)
        return existing;
      const now = new Date();
      await tx.rewardDelivery.upsert({
        where: { redemptionId: id },
        create: {
          redemptionId: id,
          status: RewardDeliveryStatus.DELIVERED,
          supplierReference: input.supplierReference,
          encryptedCode: input.encryptedCode,
          deliveredAt: now,
        },
        update: {
          status: RewardDeliveryStatus.DELIVERED,
          supplierReference: input.supplierReference,
          encryptedCode: input.encryptedCode,
          failureReason: null,
          deliveredAt: now,
        },
      });
      return tx.rewardRedemption.update({
        where: { id },
        data: {
          status: RewardRedemptionStatus.FULFILLED,
          fulfilledAt: now,
          expiresAt: input.expiresAt,
        },
        include: PLAYER_REDEMPTION_INCLUDE,
      });
    });
  }

  markRedeemed(userId: string, id: string, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      await tx.rewardRedemption.updateMany({
        where: {
          id,
          userId,
          status: RewardRedemptionStatus.FULFILLED,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        data: { status: RewardRedemptionStatus.REDEEMED, redeemedAt: now },
      });
      return tx.rewardRedemption.findFirst({
        where: { id, userId },
        include: PLAYER_REDEMPTION_INCLUDE,
      });
    });
  }

  async expireOwned(userId: string, now: Date) {
    await this.prisma.rewardRedemption.updateMany({
      where: {
        userId,
        status: RewardRedemptionStatus.FULFILLED,
        expiresAt: { lte: now },
      },
      data: { status: RewardRedemptionStatus.EXPIRED },
    });
  }
}
