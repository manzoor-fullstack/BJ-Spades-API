import type { Prisma } from '@prisma/client';

import { formatMoney } from '../../common/money/money.util';

export const WITHDRAWAL_INCLUDE = {
  destination: true,
  payout: true,
  reservationTransaction: true,
  releaseTransaction: true,
} satisfies Prisma.WithdrawalRequestInclude;

export type WithdrawalRecord = Prisma.WithdrawalRequestGetPayload<{
  include: typeof WITHDRAWAL_INCLUDE;
}>;

export function toPlayerPayoutDestination(row: {
  id: string;
  method: string;
  label: string | null;
  reference: string;
  isVerified: boolean;
  isDefault: boolean;
}) {
  return {
    id: row.id,
    method: row.method,
    label: row.label,
    reference: row.reference,
    isVerified: row.isVerified,
    isDefault: row.isDefault,
  };
}

export function toPlayerWithdrawal(row: WithdrawalRecord) {
  const settlementStatus = row.payout?.status ?? null;
  const status =
    row.status === 'DECLINED' || row.status === 'CANCELLED'
      ? row.status
      : settlementStatus === 'PAID' && row.payout?.settledAt
        ? 'SETTLED'
        : (settlementStatus ?? row.status);

  return {
    id: row.id,
    amount: formatMoney(row.amount),
    currency: row.currency.toUpperCase(),
    requestStatus: row.status,
    settlementStatus,
    status,
    reviewReason: row.reviewReason,
    destination: toPlayerPayoutDestination({
      id: row.destinationId,
      method: row.destinationMethod,
      label: row.destinationLabel,
      reference: row.destinationReference,
      isVerified: row.destination.isVerified,
      isDefault: row.destination.isDefault,
    }),
    payoutId: row.payout?.id ?? null,
    providerOperationId: row.payout?.stripeTransferId ?? null,
    reservedAt: row.reservationTransaction.createdAt,
    approvedAt: row.approvedAt,
    paidAt: row.payout?.paidAt ?? null,
    settledAt: row.payout?.settledAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
