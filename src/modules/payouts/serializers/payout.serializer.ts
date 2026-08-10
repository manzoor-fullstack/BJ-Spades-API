import type {
  PayoutMethod,
  PayoutStatus,
  StripeAccountStatus,
} from '@prisma/client';

import { formatMoney } from '../../../common/money/money.util';
import {
  initialsOf,
  joinFullName,
} from '../../../common/text/split-full-name.util';
import type { PayoutWithRelations } from '../repositories/payouts.repository';

/** Just enough of the recipient for the payouts table and its badges. */
export interface PayoutRecipient {
  id: string;
  fullName: string;
  initials: string;
  email: string;
  /** Drives the verification badge; only VERIFIED can be paid. */
  stripeAccountStatus: StripeAccountStatus;
  stripeConnectAccountId: string | null;
}

export interface PayoutTournamentSummary {
  id: string;
  name: string;
}

/**
 * A payout row as the payouts page renders it.
 *
 * `amount` is a two-decimal string. `isPayable` is computed here rather than in
 * the frontend so the button's enabled state and the API's 422 can never
 * disagree about whether a payout can be sent.
 */
export interface PayoutListItem {
  id: string;
  amount: string;
  currency: string;
  method: PayoutMethod;
  status: PayoutStatus;
  user: PayoutRecipient;
  tournament: PayoutTournamentSummary | null;
  placement: number | null;
  stripeTransferId: string | null;
  failureReason: string | null;
  blockerReason: string | null;
  isPayable: boolean;
  owedSince: Date;
  approvedAt: Date | null;
  processedAt: Date | null;
  paidAt: Date | null;
  approvedByAdminId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The five cards on the payouts page.
 *
 * `Escrowed`, `USDC`, `Zelle`, `ACH` and the KYC blocker count from the mock
 * are NOT here — docs/05-DEFERRED-SCOPE.md D-11 and D-12. "Escrowed" is
 * replaced by `pendingPayouts`, which is a number this system can actually
 * compute: there is no escrow account.
 */
export interface PayoutStats {
  /** Sum of prize pools across every non-cancelled tournament. */
  totalPrizePool: string;
  paidOut: string;
  /** Approved or in flight — committed, not yet delivered. */
  pendingPayouts: string;
  /**
   * Sum of payouts that would succeed if sent right now. The four conditions
   * behind it are exactly `isPayable()` below and the four guards in
   * `PayoutsService.process`, so this card and that 422 cannot disagree.
   */
  readyToSend: string;
  /**
   * Sum of outstanding payouts held by a blocker reason or awaiting review.
   *
   * `readyToSend + blocked` is NOT `owedToPlayers`: a PENDING payout that is
   * neither payable nor blocked belongs to neither figure.
   */
  blocked: string;
  /** Count, not money: how many payouts are held for review. */
  pendingReview: number;
  /** Everything not yet paid or cancelled. */
  owedToPlayers: string;
  /** Distinct users behind `owedToPlayers`. */
  playersAwaiting: number;
}

export function toPayoutListItem(payout: PayoutWithRelations): PayoutListItem {
  return {
    id: payout.id,
    amount: formatMoney(payout.amount),
    currency: payout.currency,
    method: payout.method,
    status: payout.status,
    user: {
      id: payout.user.id,
      fullName: joinFullName(payout.user.firstName, payout.user.lastName),
      initials: initialsOf(payout.user.firstName, payout.user.lastName),
      email: payout.user.email,
      stripeAccountStatus: payout.user.stripeAccountStatus,
      stripeConnectAccountId: payout.user.stripeConnectAccountId,
    },
    tournament: payout.tournament
      ? { id: payout.tournament.id, name: payout.tournament.name }
      : null,
    placement: payout.placement,
    stripeTransferId: payout.stripeTransferId,
    failureReason: payout.failureReason,
    blockerReason: payout.blockerReason,
    isPayable: isPayable(payout),
    owedSince: payout.owedSince,
    approvedAt: payout.approvedAt,
    processedAt: payout.processedAt,
    paidAt: payout.paidAt,
    approvedByAdminId: payout.approvedByAdminId,
    createdAt: payout.createdAt,
    updatedAt: payout.updatedAt,
  };
}

/**
 * Mirrors the eligibility guards in `PayoutsService.process` exactly.
 *
 * The method check is not optional here. `PayoutMethod` gained eight members
 * for the Methods tab, and only STRIPE_CONNECT can actually be executed — so
 * without it the payouts table's Process button and the Tracker's Send
 * Transfer would both offer to send a Zelle or USDC payout that the API then
 * refuses with 422.
 */
export function isPayable(payout: PayoutWithRelations): boolean {
  return (
    payout.method === 'STRIPE_CONNECT' &&
    payout.status === 'APPROVED' &&
    payout.user.stripeAccountStatus === 'VERIFIED' &&
    payout.stripeTransferId === null &&
    payout.amount.greaterThan(0)
  );
}
