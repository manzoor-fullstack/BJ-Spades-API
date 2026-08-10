import type {
  PayoutStatus,
  StripeAccountStatus,
  TournamentStatus,
} from '@prisma/client';

import { formatMoney } from '../../../common/money/money.util';
import {
  initialsOf,
  joinFullName,
} from '../../../common/text/split-full-name.util';
import type { RegistrationWithPayout } from '../repositories/payouts.repository';

/**
 * The five badges the prototype shows, plus the three real states it omits: a
 * payout can fail, be cancelled, or not exist yet.
 */
export type DistributionStatus =
  | 'SENT'
  | 'PROCESSING'
  | 'APPROVED'
  | 'PENDING_REVIEW'
  | 'KYC_NEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'NOT_STARTED';

/** One option in the Overview tab's tournament selector. */
export interface PayoutTournamentOption {
  id: string;
  name: string;
  status: TournamentStatus;
}

export interface PrizeDistributionWinner {
  id: string;
  fullName: string;
  initials: string;
  email: string;
}

/**
 * One row of the Prize Distribution table.
 *
 * `prizeWon` is money only. The prototype's `$5,000 + Trophy` cannot be
 * rendered: nothing relates a registration to a `Merchandise` row, so which
 * physical prize a placement won is not recorded anywhere.
 */
export interface PrizeDistributionRow {
  registrationId: string;
  tournamentId: string;
  tournamentName: string;
  winner: PrizeDistributionWinner;
  placement: number;
  /** Two-decimal string. */
  prizeWon: string;
  /** Lowercase ISO 4217, from the payout; `usd` when there is no payout yet. */
  currency: string;
  payoutId: string | null;
  payoutStatus: PayoutStatus | null;
  status: DistributionStatus;
}

/**
 * Which badge a winner's row shows.
 *
 * `KYC_NEEDED` is tested before the generic held state because it is the
 * actionable one — it tells the operator the payout is stuck on the recipient,
 * not in their own review queue. It is deliberately NOT reported for a payout
 * that already moved: a recipient restricted after being paid has not undone
 * the transfer.
 */
export function deriveDistributionStatus(
  payoutStatus: PayoutStatus | null,
  stripeAccountStatus: StripeAccountStatus,
): DistributionStatus {
  if (payoutStatus === null) return 'NOT_STARTED';

  switch (payoutStatus) {
    case 'PAID':
      return 'SENT';
    case 'PROCESSING':
      return 'PROCESSING';
    case 'APPROVED':
      return 'APPROVED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'PENDING':
    case 'PENDING_REVIEW':
      return stripeAccountStatus === 'VERIFIED'
        ? 'PENDING_REVIEW'
        : 'KYC_NEEDED';
  }
}

export function toPrizeDistributionRow(
  registration: RegistrationWithPayout,
): PrizeDistributionRow {
  const payout = registration.payout;

  return {
    registrationId: registration.id,
    tournamentId: registration.tournamentId,
    tournamentName: registration.tournament.name,
    winner: {
      id: registration.user.id,
      fullName: joinFullName(
        registration.user.firstName,
        registration.user.lastName,
      ),
      initials: initialsOf(
        registration.user.firstName,
        registration.user.lastName,
      ),
      email: registration.user.email,
    },
    // The repository only returns rows that have a placement, so this cannot
    // be null in practice; the `?? 0` keeps the type honest without a cast.
    placement: registration.placement ?? 0,
    prizeWon: formatMoney(registration.prizeWon ?? 0),
    currency: payout?.currency ?? 'usd',
    payoutId: payout?.id ?? null,
    payoutStatus: payout?.status ?? null,
    status: deriveDistributionStatus(
      payout?.status ?? null,
      registration.user.stripeAccountStatus,
    ),
  };
}
