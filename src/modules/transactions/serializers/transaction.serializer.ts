import type {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';

import { formatMoney } from '../../../common/money/money.util';

/**
 * A ledger row as the API renders it.
 *
 * Every money field is a two-decimal STRING. A JSON number would be parsed back
 * as an IEEE-754 double by the client, which is the exact failure the NUMERIC
 * column and `Prisma.Decimal` exist to prevent.
 */
export interface TransactionItem {
  id: string;
  userId: string;
  type: TransactionType;
  status: TransactionStatus;
  /** Signed: negative is a debit. */
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  description: string | null;
  reference: string | null;
  tournamentId: string | null;
  payoutId: string | null;
  createdByAdminId: string | null;
  createdAt: Date;
}

export function toTransactionItem(row: Transaction): TransactionItem {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    status: row.status,
    amount: formatMoney(row.amount),
    balanceBefore: formatMoney(row.balanceBefore),
    balanceAfter: formatMoney(row.balanceAfter),
    description: row.description,
    reference: row.reference,
    tournamentId: row.tournamentId,
    payoutId: row.payoutId,
    createdByAdminId: row.createdByAdminId,
    createdAt: row.createdAt,
  };
}
