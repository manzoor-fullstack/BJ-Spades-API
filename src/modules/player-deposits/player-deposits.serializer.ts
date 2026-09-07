import type { Deposit, PlayerPaymentMethod } from '@prisma/client';

import { formatMoney } from '../../common/money/money.util';

export function toPlayerDeposit(deposit: Deposit) {
  return {
    id: deposit.id,
    amount: formatMoney(deposit.amount),
    currency: deposit.currency,
    status: deposit.status,
    checkoutUrl: deposit.stripeCheckoutUrl,
    refundedAmount: formatMoney(deposit.refundedAmount),
    disputedAmount: formatMoney(deposit.disputedAmount),
    failureMessage: deposit.failureMessage,
    creditedAt: deposit.creditedAt,
    createdAt: deposit.createdAt,
    updatedAt: deposit.updatedAt,
  };
}

export function toPlayerPaymentMethod(method: PlayerPaymentMethod) {
  return {
    id: method.id,
    type: method.type,
    brand: method.brand,
    last4: method.last4,
    expMonth: method.expMonth,
    expYear: method.expYear,
    isDefault: method.isDefault,
  };
}
