import type { TransactionStatus, TransactionType } from '@prisma/client';

import { formatMoney, toMoney } from '../../../common/money/money.util';
import type { Money } from '../../../common/money/money.util';
import {
  initialsOf,
  joinFullName,
} from '../../../common/text/split-full-name.util';
import type { HistoryTransactionRow } from '../repositories/payouts.repository';

/**
 * The transaction types the History tab shows.
 *
 * The prototype's subtitle is "lifetime winnings, withdrawals, and refunds",
 * which is exactly these three. `DEPOSIT`, `ENTRY_FEE` and `ADJUSTMENT` are
 * money moving for other reasons and belong to the player's ledger, not to a
 * payouts history.
 */
export const HISTORY_TYPES: readonly TransactionType[] = [
  'PRIZE',
  'WITHDRAWAL',
  'REFUND',
];

export interface HistoryTransaction {
  id: string;
  /** ISO instant. */
  date: Date;
  tournamentName: string | null;
  /** Two-decimal string. Signed: negative is a debit. */
  amount: string;
  type: TransactionType;
  status: TransactionStatus;
  /**
   * The payout's method where this transaction came from one. Null for
   * transactions with no payout behind them.
   */
  method: string | null;
  /** Stripe's transfer id where there is one — the prototype's `Receipt` ref. */
  reference: string | null;
  payoutId: string | null;
}

export interface HistoryPlayer {
  id: string;
  fullName: string;
  initials: string;
  email: string;
}

/** One player's block in the History tab. */
export interface PlayerHistoryGroup {
  user: HistoryPlayer;
  /** Two-decimal string: the sum of this player's rows. */
  total: string;
  transactionCount: number;
  transactions: HistoryTransaction[];
}

export interface PayoutHistoryStats {
  /** Distinct players with at least one history transaction. */
  players: number;
  transactions: number;
  /** Two-decimal string: completed prizes and withdrawals. */
  totalPaid: string;
  /** Two-decimal string, positive: completed refunds. */
  refunded: string;
}

function toHistoryTransaction(row: HistoryTransactionRow): HistoryTransaction {
  return {
    id: row.id,
    date: row.createdAt,
    tournamentName: row.tournament?.name ?? null,
    amount: formatMoney(row.amount),
    type: row.type,
    status: row.status,
    method: row.payout?.method ?? null,
    reference: row.payout?.stripeTransferId ?? row.reference,
    payoutId: row.payoutId,
  };
}

/**
 * Groups flat transaction rows by player, newest player block first.
 *
 * Grouping happens here rather than in SQL because the tab renders a nested
 * shape — a player header with its own rows — and a `GROUP BY` would still
 * need a second query for the rows. The row set is already bounded by the
 * caller's paging.
 */
export function toPlayerHistoryGroups(
  rows: HistoryTransactionRow[],
): PlayerHistoryGroup[] {
  const groups = new Map<string, PlayerHistoryGroup>();
  // Summed as Decimals in one pass, so rounding happens once at the end rather
  // than accumulating per-row error through the formatted strings.
  const totals = new Map<string, Money>();

  for (const row of rows) {
    let group = groups.get(row.userId);

    if (!group) {
      group = {
        user: {
          id: row.user.id,
          fullName: joinFullName(row.user.firstName, row.user.lastName),
          initials: initialsOf(row.user.firstName, row.user.lastName),
          email: row.user.email,
        },
        total: '0.00',
        transactionCount: 0,
        transactions: [],
      };

      groups.set(row.userId, group);
      totals.set(row.userId, toMoney(0));
    }

    group.transactions.push(toHistoryTransaction(row));
    group.transactionCount += 1;

    totals.set(row.userId, totals.get(row.userId)!.add(row.amount));
  }

  for (const [userId, group] of groups) {
    group.total = formatMoney(totals.get(userId) ?? 0);
  }

  return [...groups.values()];
}
