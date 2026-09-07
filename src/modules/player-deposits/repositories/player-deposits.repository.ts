import { Injectable } from '@nestjs/common';
import {
  DepositStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import type { Deposit } from '@prisma/client';

import { toMoney } from '../../../common/money/money.util';
import type { StripePaymentMethod } from '../../stripe/stripe.interface';
import { recordLedgerEntry } from '../../transactions/repositories/transactions.repository';
import { PrismaService } from '../../prisma/prisma.service';

export interface DepositSettlement {
  deposit: Deposit | null;
  changed: boolean;
}

@Injectable()
export class PlayerDepositsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findUser(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, stripeCustomerId: true },
    });
  }

  async setStripeCustomer(userId: string, customerId: string): Promise<string> {
    await this.prisma.user.updateMany({
      where: { id: userId, stripeCustomerId: null },
      data: { stripeCustomerId: customerId },
    });
    const user = await this.findUser(userId);
    if (!user?.stripeCustomerId)
      throw new Error('Player disappeared while creating Stripe customer');
    return user.stripeCustomerId;
  }

  createOrFind(userId: string, requestId: string, amount: string) {
    return this.prisma.deposit.upsert({
      where: { userId_requestId: { userId, requestId } },
      create: { userId, requestId, amount: toMoney(amount) },
      update: {},
    });
  }

  attachCheckout(
    id: string,
    checkout: { id: string; url: string; paymentIntentId: string | null },
  ) {
    return this.prisma.deposit.update({
      where: { id },
      data: {
        stripeCheckoutSessionId: checkout.id,
        stripeCheckoutUrl: checkout.url,
        stripePaymentIntentId: checkout.paymentIntentId,
        status: DepositStatus.CHECKOUT_CREATED,
      },
    });
  }

  findOwned(userId: string, id: string) {
    return this.prisma.deposit.findFirst({ where: { id, userId } });
  }

  findById(id: string) {
    return this.prisma.deposit.findUnique({ where: { id } });
  }

  listOwned(userId: string) {
    return this.prisma.deposit.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 50,
    });
  }

  listPaymentMethods(userId: string) {
    return this.prisma.playerPaymentMethod.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async savePaymentMethod(userId: string, method: StripePaymentMethod) {
    const existing = await this.prisma.playerPaymentMethod.count({
      where: { userId },
    });
    return this.prisma.playerPaymentMethod.upsert({
      where: { stripePaymentMethodId: method.id },
      create: {
        userId,
        stripePaymentMethodId: method.id,
        type: method.type,
        brand: method.brand,
        last4: method.last4,
        expMonth: method.expMonth,
        expYear: method.expYear,
        isDefault: existing === 0,
      },
      update: {
        type: method.type,
        brand: method.brand,
        last4: method.last4,
        expMonth: method.expMonth,
        expYear: method.expYear,
      },
    });
  }

  findByProviderIds(sessionId?: string, paymentIntentId?: string) {
    const conditions: Prisma.DepositWhereInput[] = [];
    if (sessionId) conditions.push({ stripeCheckoutSessionId: sessionId });
    if (paymentIntentId)
      conditions.push({ stripePaymentIntentId: paymentIntentId });
    if (conditions.length === 0) return Promise.resolve(null);
    return this.prisma.deposit.findFirst({ where: { OR: conditions } });
  }

  markProcessing(id: string, paymentIntentId: string | null) {
    return this.prisma.deposit.updateMany({
      where: { id, creditedAt: null },
      data: {
        status: DepositStatus.PROCESSING,
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      },
    });
  }

  markFailed(id: string, code: string | null, message: string) {
    return this.prisma.deposit.updateMany({
      where: { id, creditedAt: null },
      data: {
        status: DepositStatus.FAILED,
        failureCode: code,
        failureMessage: message,
        failedAt: new Date(),
      },
    });
  }

  markCanceled(id: string) {
    return this.prisma.deposit.updateMany({
      where: { id, creditedAt: null },
      data: { status: DepositStatus.CANCELED, canceledAt: new Date() },
    });
  }

  settle(
    id: string,
    paymentIntentId: string | null,
    method: StripePaymentMethod | null,
  ): Promise<DepositSettlement> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.deposit.updateMany({
        where: { id, creditedAt: null },
        data: {
          creditedAt: new Date(),
          status: DepositStatus.SUCCEEDED,
          failureCode: null,
          failureMessage: null,
          ...(paymentIntentId
            ? { stripePaymentIntentId: paymentIntentId }
            : {}),
        },
      });
      const deposit = await tx.deposit.findUnique({ where: { id } });
      if (!deposit || claimed.count === 0) return { deposit, changed: false };

      const ledger = await recordLedgerEntry(tx, {
        userId: deposit.userId,
        type: TransactionType.DEPOSIT,
        amount: deposit.amount,
        status: TransactionStatus.COMPLETED,
        reference: `stripe-deposit:${deposit.id}`,
        description: 'Stripe token deposit',
      });
      if (ledger.outcome !== 'RECORDED')
        throw new Error(`Deposit ledger write failed: ${ledger.outcome}`);

      if (method) {
        const existing = await tx.playerPaymentMethod.count({
          where: { userId: deposit.userId },
        });
        await tx.playerPaymentMethod.upsert({
          where: { stripePaymentMethodId: method.id },
          create: {
            userId: deposit.userId,
            stripePaymentMethodId: method.id,
            type: method.type,
            brand: method.brand,
            last4: method.last4,
            expMonth: method.expMonth,
            expYear: method.expYear,
            isDefault: existing === 0,
          },
          update: {
            type: method.type,
            brand: method.brand,
            last4: method.last4,
            expMonth: method.expMonth,
            expYear: method.expYear,
          },
        });
      }

      return { deposit, changed: true };
    });
  }

  reverse(
    id: string,
    kind: 'refund' | 'dispute',
    externalTotal: string,
    eventId: string,
  ): Promise<DepositSettlement> {
    return this.prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.findUnique({ where: { id } });
      if (!deposit?.creditedAt) return { deposit, changed: false };

      const previous =
        kind === 'refund' ? deposit.refundedAmount : deposit.disputedAmount;
      const other =
        kind === 'refund' ? deposit.disputedAmount : deposit.refundedAmount;
      const requested = toMoney(externalTotal);
      const capped = Prisma.Decimal.min(requested, deposit.amount.minus(other));
      const delta = capped.minus(previous);
      if (!delta.isPositive()) return { deposit, changed: false };

      const ledger = await recordLedgerEntry(tx, {
        userId: deposit.userId,
        type: TransactionType.DEPOSIT,
        amount: delta.negated(),
        status: TransactionStatus.REVERSED,
        reference: `stripe-deposit-${kind}:${deposit.id}:${eventId}`,
        description:
          kind === 'refund'
            ? 'Stripe deposit refund'
            : 'Stripe deposit dispute',
        allowNegativeBalance: true,
      });
      if (ledger.outcome !== 'RECORDED')
        throw new Error(`Deposit reversal failed: ${ledger.outcome}`);

      const refundedAmount =
        kind === 'refund' ? capped : deposit.refundedAmount;
      const disputedAmount =
        kind === 'dispute' ? capped : deposit.disputedAmount;
      const reversed = refundedAmount.plus(disputedAmount);
      const status =
        kind === 'dispute'
          ? DepositStatus.DISPUTED
          : reversed.greaterThanOrEqualTo(deposit.amount)
            ? DepositStatus.REFUNDED
            : DepositStatus.PARTIALLY_REFUNDED;
      const updated = await tx.deposit.update({
        where: { id },
        data: { refundedAmount, disputedAmount, status },
      });
      return { deposit: updated, changed: true };
    });
  }

  restoreDispute(id: string, eventId: string): Promise<DepositSettlement> {
    return this.prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.findUnique({ where: { id } });
      if (!deposit?.disputedAmount.isPositive())
        return { deposit, changed: false };
      const amount = deposit.disputedAmount;
      const ledger = await recordLedgerEntry(tx, {
        userId: deposit.userId,
        type: TransactionType.DEPOSIT,
        amount,
        status: TransactionStatus.REVERSED,
        reference: `stripe-deposit-dispute-won:${deposit.id}:${eventId}`,
        description: 'Stripe deposit dispute reversed',
        allowNegativeBalance: true,
      });
      if (ledger.outcome !== 'RECORDED')
        throw new Error(`Deposit restoration failed: ${ledger.outcome}`);
      const status = deposit.refundedAmount.isZero()
        ? DepositStatus.SUCCEEDED
        : deposit.refundedAmount.greaterThanOrEqualTo(deposit.amount)
          ? DepositStatus.REFUNDED
          : DepositStatus.PARTIALLY_REFUNDED;
      const updated = await tx.deposit.update({
        where: { id },
        data: { disputedAmount: 0, status },
      });
      return { deposit: updated, changed: true };
    });
  }
}
