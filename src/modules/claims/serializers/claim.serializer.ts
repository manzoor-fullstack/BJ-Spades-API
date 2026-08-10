import type { ClaimStatus } from '@prisma/client';

import { formatMoney } from '../../../common/money/money.util';
import {
  initialsOf,
  joinFullName,
} from '../../../common/text/split-full-name.util';
import type { ClaimWithRelations } from '../repositories/claims.repository';

export interface ClaimClaimant {
  id: string;
  fullName: string;
  initials: string;
  email: string;
}

/** One row of the Claims tab. */
export interface ClaimListItem {
  id: string;
  user: ClaimClaimant;
  tournamentName: string | null;
  placement: number | null;
  prizeDescription: string;
  /** Two-decimal string, or null for a purely physical prize. */
  prizeAmount: string | null;
  termsAccepted: boolean;
  shippingProvided: boolean;
  status: ClaimStatus;
  submittedAt: Date;
  reviewedAt: Date | null;
  decisionNote: string | null;
  /**
   * Whether Approve/Decline should be offered.
   *
   * Computed here rather than in the frontend so the button's enabled state
   * and the API's 422 can never disagree — the same reasoning as `isPayable`
   * on a payout.
   */
  isReviewable: boolean;
}

export interface ClaimStats {
  pendingReview: number;
  approvedToday: number;
  declinedToday: number;
  /**
   * Mean hours from submission to decision, over claims decided in the last 30
   * days. Null when nothing has been decided in that window — a mean of zero
   * would read as "instant", which is a different and wrong claim.
   */
  averageReviewHours: number | null;
}

export function toClaimListItem(claim: ClaimWithRelations): ClaimListItem {
  return {
    id: claim.id,
    user: {
      id: claim.user.id,
      fullName: joinFullName(claim.user.firstName, claim.user.lastName),
      initials: initialsOf(claim.user.firstName, claim.user.lastName),
      email: claim.user.email,
    },
    tournamentName: claim.tournament?.name ?? null,
    placement: claim.placement,
    prizeDescription: claim.prizeDescription,
    prizeAmount:
      claim.prizeAmount === null ? null : formatMoney(claim.prizeAmount),
    termsAccepted: claim.termsAccepted,
    shippingProvided: claim.shippingProvided,
    status: claim.status,
    submittedAt: claim.submittedAt,
    reviewedAt: claim.reviewedAt,
    decisionNote: claim.decisionNote,
    isReviewable: claim.status === 'PENDING_REVIEW',
  };
}
