import { Injectable } from '@nestjs/common';
import {
  DisputeStatus,
  PayoutMethod,
  PayoutStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
  UserStatus,
  VerificationCheckState,
  WithdrawalRequestStatus,
} from '@prisma/client';

import { toMoney } from '../../../common/money/money.util';
import { PrismaService } from '../../prisma/prisma.service';
import { recordLedgerEntry } from '../../transactions/repositories/transactions.repository';
import { WITHDRAWAL_INCLUDE } from '../player-withdrawals.serializer';

export type CreateWithdrawalOutcome =
  | {
      outcome: 'CREATED';
      withdrawal: NonNullable<
        Awaited<ReturnType<PlayerWithdrawalsRepository['findOwned']>>
      >;
    }
  | {
      outcome: 'EXISTING';
      withdrawal: NonNullable<
        Awaited<ReturnType<PlayerWithdrawalsRepository['findOwned']>>
      >;
    }
  | { outcome: 'PLAYER_NOT_FOUND' }
  | { outcome: 'INELIGIBLE' }
  | { outcome: 'DESTINATION_INVALID' }
  | { outcome: 'OPEN_DISPUTE' }
  | { outcome: 'INSUFFICIENT_BALANCE'; balance: Prisma.Decimal };

const accepted = [
  VerificationCheckState.PASSED,
  VerificationCheckState.NOT_REQUIRED,
] as const;

@Injectable()
export class PlayerWithdrawalsRepository {
  constructor(private readonly prisma: PrismaService) {}

  listDestinations(userId: string) {
    return this.prisma.payoutMethodAccount.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  listOwned(userId: string) {
    return this.prisma.withdrawalRequest.findMany({
      where: { userId },
      include: WITHDRAWAL_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 50,
    });
  }

  findOwned(userId: string, id: string) {
    return this.prisma.withdrawalRequest.findFirst({
      where: { id, userId },
      include: WITHDRAWAL_INCLUDE,
    });
  }

  pendingTotal(userId: string) {
    return this.prisma.withdrawalRequest.aggregate({
      where: {
        userId,
        releaseTransactionId: null,
        payout: {
          status: {
            notIn: [
              PayoutStatus.PAID,
              PayoutStatus.FAILED,
              PayoutStatus.CANCELLED,
            ],
          },
        },
      },
      _sum: { amount: true },
    });
  }

  create(
    userId: string,
    input: {
      requestId: string;
      amount: string;
      destinationId: string;
      payloadHash: string;
    },
  ): Promise<CreateWithdrawalOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.withdrawalRequest.findUnique({
        where: { userId_requestId: { userId, requestId: input.requestId } },
        include: WITHDRAWAL_INCLUDE,
      });
      if (existing)
        return { outcome: 'EXISTING' as const, withdrawal: existing };

      const player = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        include: { verification: true },
      });
      if (!player) return { outcome: 'PLAYER_NOT_FOUND' as const };
      const verification = player.verification;
      const eligible =
        player.status === UserStatus.ACTIVE &&
        player.stripeAccountStatus === 'VERIFIED' &&
        verification !== null &&
        [
          verification.kycCheck,
          verification.ageCheck,
          verification.countryCheck,
          verification.taxCheck,
          verification.fraudCheck,
        ].every((state) =>
          accepted.includes(state as (typeof accepted)[number]),
        );
      if (!eligible) return { outcome: 'INELIGIBLE' as const };

      const dispute = await tx.dispute.findFirst({
        where: {
          userId,
          status: {
            in: [DisputeStatus.UNDER_REVIEW, DisputeStatus.APPEAL_FILED],
          },
        },
        select: { id: true },
      });
      if (dispute) return { outcome: 'OPEN_DISPUTE' as const };

      const destination = await tx.payoutMethodAccount.findFirst({
        where: {
          id: input.destinationId,
          userId,
          method: PayoutMethod.STRIPE_CONNECT,
          isVerified: true,
          reference: player.stripeConnectAccountId ?? '__missing__',
        },
      });
      if (!destination) return { outcome: 'DESTINATION_INVALID' as const };

      const amount = toMoney(input.amount);
      const reservation = await recordLedgerEntry(tx, {
        userId,
        type: TransactionType.WITHDRAWAL,
        amount: amount.negated(),
        status: TransactionStatus.PENDING,
        reference: `withdrawal-reservation:${userId}:${input.requestId}`,
        description: 'Withdrawal reserved for admin review',
      });
      if (reservation.outcome === 'INSUFFICIENT_BALANCE') {
        return {
          outcome: 'INSUFFICIENT_BALANCE' as const,
          balance: reservation.balance,
        };
      }
      if (reservation.outcome !== 'RECORDED')
        return { outcome: 'PLAYER_NOT_FOUND' as const };

      const withdrawal = await tx.withdrawalRequest.create({
        data: {
          userId,
          requestId: input.requestId,
          payloadHash: input.payloadHash,
          amount,
          destinationId: destination.id,
          destinationMethod: destination.method,
          destinationLabel: destination.label,
          destinationReference: destination.reference,
          reservationTransactionId: reservation.transaction.id,
        },
      });
      const payout = await tx.payout.create({
        data: {
          userId,
          amount,
          method: destination.method,
          status: PayoutStatus.PENDING_REVIEW,
          blockerReason: 'Awaiting admin review',
          withdrawalRequestId: withdrawal.id,
        },
      });
      await tx.transaction.update({
        where: { id: reservation.transaction.id },
        data: { payoutId: payout.id },
      });
      return {
        outcome: 'CREATED' as const,
        withdrawal: await tx.withdrawalRequest.findUniqueOrThrow({
          where: { id: withdrawal.id },
          include: WITHDRAWAL_INCLUDE,
        }),
      };
    });
  }

  cancelOwned(userId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.withdrawalRequest.updateMany({
        where: {
          id,
          userId,
          status: WithdrawalRequestStatus.PENDING_REVIEW,
          releaseTransactionId: null,
        },
        data: {
          status: WithdrawalRequestStatus.CANCELLED,
          reviewReason: 'Cancelled by player',
          cancelledAt: new Date(),
        },
      });
      if (claimed.count === 0) return null;
      const row = await tx.withdrawalRequest.findUniqueOrThrow({
        where: { id },
      });
      const release = await recordLedgerEntry(tx, {
        userId,
        type: TransactionType.REFUND,
        amount: row.amount,
        status: TransactionStatus.COMPLETED,
        reference: `withdrawal-release:${id}`,
        payoutId: (
          await tx.payout.findUnique({
            where: { withdrawalRequestId: id },
            select: { id: true },
          })
        )?.id,
        description: 'Cancelled withdrawal reservation released',
      });
      if (release.outcome !== 'RECORDED')
        throw new Error(`Withdrawal release failed: ${release.outcome}`);
      await tx.withdrawalRequest.update({
        where: { id },
        data: { releaseTransactionId: release.transaction.id },
      });
      await tx.transaction.update({
        where: { id: row.reservationTransactionId },
        data: { status: TransactionStatus.REVERSED },
      });
      await tx.payout.updateMany({
        where: { withdrawalRequestId: id },
        data: {
          status: PayoutStatus.CANCELLED,
          blockerReason: 'Cancelled by player',
        },
      });
      return tx.withdrawalRequest.findUniqueOrThrow({
        where: { id },
        include: WITHDRAWAL_INCLUDE,
      });
    });
  }
}
