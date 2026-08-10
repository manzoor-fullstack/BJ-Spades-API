import { PayoutStatus } from '@prisma/client';
import type { PayoutMethod } from '@prisma/client';

import { formatMoney } from '../../../common/money/money.util';
import {
  initialsOf,
  joinFullName,
} from '../../../common/text/split-full-name.util';
import { APPROVABLE_FROM } from '../payout-status';
import type { PayoutWithRelations } from '../repositories/payouts.repository';

import { isPayable } from './payout.serializer';

/**
 * The six nodes of the tracker rail.
 *
 * These are presentation steps, NOT payout states — the schema has seven
 * states and `payout-status.ts` explains why `SENT`/`COMPLETED`/`KYC_NEEDED`
 * are not among them. Each node below maps onto something the system actually
 * records:
 *
 *  1. PENDING_REVIEW    — status is PENDING or PENDING_REVIEW
 *  2. IDENTITY_VERIFIED — the *recipient* is VERIFIED (a user property; a
 *                         person is verified once, not per payment)
 *  3. APPROVED          — approvedAt
 *  4. PROCESSING        — processedAt
 *  5. SENT              — paidAt: Stripe accepted the transfer
 *  6. COMPLETED         — settledAt: Stripe confirmed it landed
 *
 * Steps 5 and 6 are genuinely different events. `settledAt` is never inferred
 * from `paidAt`; if Stripe never sends `transfer.paid`, a payout legitimately
 * rests at SENT and the rail says so rather than claiming a settlement.
 */
export const TRACKER_STEPS = [
  { key: 'PENDING_REVIEW', label: 'Pending Review' },
  { key: 'IDENTITY_VERIFIED', label: 'Identity Verified' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'PROCESSING', label: 'Processing' },
  { key: 'SENT', label: 'Sent' },
  { key: 'COMPLETED', label: 'Completed' },
] as const;

export type TrackerStepKey = (typeof TRACKER_STEPS)[number]['key'];

/**
 * `BLOCKED` outranks `CURRENT`: it is what an operator scans the list for.
 * `TODO` renders as the step's index, matching the prototype.
 */
export type StepState = 'DONE' | 'CURRENT' | 'TODO' | 'BLOCKED';

export interface TrackerStep {
  key: TrackerStepKey;
  label: string;
  state: StepState;
  /** When this step happened, where the system records a time for it. */
  at: Date | null;
}

/**
 * Which existing endpoint `Advance Step` should call, or `null` when no admin
 * action can move this payout.
 *
 * There is deliberately no `PROCESSING -> PAID` action: that transition is
 * Stripe's, executed inside `process()`. Offering a button for it would invite
 * an operator to click something that cannot work.
 */
export type AdvanceAction = 'APPROVE' | 'PROCESS' | null;

export interface TrackerRecipient {
  id: string;
  fullName: string;
  initials: string;
  email: string;
}

export interface PayoutTrackerItem {
  id: string;
  /** Two-decimal string. */
  amount: string;
  currency: string;
  method: PayoutMethod;
  status: PayoutStatus;
  user: TrackerRecipient;
  tournamentName: string | null;
  steps: TrackerStep[];
  /** 1-based index of the furthest step reached. */
  currentStep: number;
  /** Percentage of the six steps completed, 0-100. */
  progress: number;
  advanceAction: AdvanceAction;
  blockerReason: string | null;
  failureReason: string | null;
  stripeTransferId: string | null;
  paidAt: Date | null;
  settledAt: Date | null;
}

export interface PayoutTrackerStats {
  activePayouts: number;
  inProcessing: number;
  completed: number;
  awaitingAction: number;
}

/** Which of the six steps this payout has genuinely completed. */
function completionFlags(payout: PayoutWithRelations): boolean[] {
  const cancelled = payout.status === PayoutStatus.CANCELLED;

  // A cancelled payout completed nothing beyond entering the queue; showing
  // later steps as done would misdescribe a payment that never happened.
  if (cancelled) return [true, false, false, false, false, false];

  return [
    // Reaching the queue at all completes step 1.
    true,
    payout.user.stripeAccountStatus === 'VERIFIED',
    payout.approvedAt !== null,
    payout.processedAt !== null,
    payout.paidAt !== null,
    payout.settledAt !== null,
  ];
}

function stepTimestamp(
  index: number,
  payout: PayoutWithRelations,
): Date | null {
  switch (index) {
    case 0:
      return payout.owedSince;
    case 1:
      return payout.user.stripeVerifiedAt;
    case 2:
      return payout.approvedAt;
    case 3:
      return payout.processedAt;
    case 4:
      return payout.paidAt;
    case 5:
      return payout.settledAt;
    default:
      return null;
  }
}

/**
 * Which endpoint can move this payout, mirroring the guards those endpoints
 * enforce.
 *
 * `APPROVABLE_FROM` and `isPayable` are imported rather than restated: if the
 * button's condition and the endpoint's 422 ever drift, the operator gets a
 * control that fails on click.
 */
function resolveAdvanceAction(payout: PayoutWithRelations): AdvanceAction {
  if (isPayable(payout)) return 'PROCESS';
  if (APPROVABLE_FROM.includes(payout.status)) return 'APPROVE';

  return null;
}

export function toPayoutTrackerItem(
  payout: PayoutWithRelations,
): PayoutTrackerItem {
  const done = completionFlags(payout);
  const doneCount = done.filter(Boolean).length;

  // The furthest completed step, or step 1 when nothing is done yet.
  const currentIndex = Math.max(0, doneCount - 1);

  // A terminal payout cannot be blocked. `blockerReason` is not cleared on
  // cancellation, so without this a cancelled payout renders a red alert on a
  // step it will never reach again — the operator sees something to act on
  // where there is nothing.
  const terminal =
    payout.status === PayoutStatus.CANCELLED ||
    payout.status === PayoutStatus.PAID;

  const blocked = !terminal && payout.blockerReason !== null;
  const failed = payout.status === PayoutStatus.FAILED;

  const steps: TrackerStep[] = TRACKER_STEPS.map((step, index) => {
    let state: StepState;

    if (done[index]) {
      state = index === currentIndex ? 'CURRENT' : 'DONE';
    } else {
      state = 'TODO';
    }

    // A blocker halts the rail at the first step it has not completed; a
    // failure specifically halts Processing, which is where it happened.
    if (blocked && index === doneCount) state = 'BLOCKED';
    if (failed && step.key === 'PROCESSING') state = 'BLOCKED';

    return {
      key: step.key,
      label: step.label,
      state,
      at: done[index] ? stepTimestamp(index, payout) : null,
    };
  });

  // The last step is CURRENT while it is the furthest reached, but once every
  // step is done the rail is simply complete.
  if (doneCount === TRACKER_STEPS.length) {
    const last = steps[TRACKER_STEPS.length - 1];
    if (last) last.state = 'DONE';
  }

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
    },
    tournamentName: payout.tournament?.name ?? null,
    steps,
    currentStep: currentIndex + 1,
    progress: Math.round((doneCount / TRACKER_STEPS.length) * 100),
    advanceAction: resolveAdvanceAction(payout),
    blockerReason: payout.blockerReason,
    failureReason: payout.failureReason,
    stripeTransferId: payout.stripeTransferId,
    paidAt: payout.paidAt,
    settledAt: payout.settledAt,
  };
}
