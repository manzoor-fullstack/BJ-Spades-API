import { UnprocessableEntityException } from '@nestjs/common';
import { PayoutStatus } from '@prisma/client';

/**
 * The payout lifecycle.
 *
 *   PENDING ──▶ PENDING_REVIEW ──▶ APPROVED ──▶ PROCESSING ──▶ PAID
 *      │              │               │              │
 *      │              │               │              └──▶ FAILED ──▶ PENDING_REVIEW
 *      └──────────────┴───────────────┴──────────────────▶ CANCELLED
 *
 * The schema defines seven states. An earlier draft of this module assumed
 * `SENT`, `COMPLETED` and `KYC_NEEDED`, none of which exist:
 *
 *  - `SENT` and `COMPLETED` collapse into `PAID`. Stripe reports a transfer as
 *    created or failed; a "sent but not settled" state is one this system can
 *    never actually observe.
 *  - `KYC_NEEDED` is not a payout state. Verification belongs to the *user*
 *    (`User.stripeAccountStatus`) — a person is verified once, not per payment.
 *    Stripe performs the KYC during onboarding (docs/05-DEFERRED-SCOPE.md
 *    D-13), and why a specific payout is held sits in `Payout.blockerReason`.
 *
 * `PAID` and `CANCELLED` are terminal. There is deliberately no route from
 * `PROCESSING` back to `CANCELLED`: once a transfer is in flight at Stripe,
 * cancelling locally would leave the money moved and the record denying it.
 *
 * Encoded as data so the table itself is what a unit test asserts against.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<PayoutStatus, readonly PayoutStatus[]>
> = {
  [PayoutStatus.PENDING]: [
    PayoutStatus.PENDING_REVIEW,
    PayoutStatus.APPROVED,
    PayoutStatus.CANCELLED,
  ],
  [PayoutStatus.PENDING_REVIEW]: [
    PayoutStatus.APPROVED,
    PayoutStatus.CANCELLED,
  ],
  [PayoutStatus.APPROVED]: [PayoutStatus.PROCESSING, PayoutStatus.CANCELLED],
  [PayoutStatus.PROCESSING]: [PayoutStatus.PAID, PayoutStatus.FAILED],
  [PayoutStatus.PAID]: [],
  [PayoutStatus.FAILED]: [
    PayoutStatus.PENDING_REVIEW,
    PayoutStatus.APPROVED,
    PayoutStatus.CANCELLED,
  ],
  [PayoutStatus.CANCELLED]: [],
};

/** Statuses a payout can still be approved from. */
export const APPROVABLE_FROM: readonly PayoutStatus[] = [
  PayoutStatus.PENDING,
  PayoutStatus.PENDING_REVIEW,
  PayoutStatus.FAILED,
];

/** Statuses a payout can still be cancelled from. */
export const CANCELLABLE_FROM: readonly PayoutStatus[] = [
  PayoutStatus.PENDING,
  PayoutStatus.PENDING_REVIEW,
  PayoutStatus.APPROVED,
  PayoutStatus.FAILED,
];

export const TERMINAL_STATUSES: readonly PayoutStatus[] = [
  PayoutStatus.PAID,
  PayoutStatus.CANCELLED,
];

export function isTerminalPayoutStatus(status: PayoutStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Throws 422 naming the allowed set.
 *
 * Unlike the tournament equivalent, `from === to` is NOT a no-op: every payout
 * endpoint exists to *move* a payout, so "it is already APPROVED" is something
 * the caller needs to hear rather than a silent success that would overwrite
 * the original `approvedAt` and approver.
 */
export function assertPayoutTransition(
  from: PayoutStatus,
  to: PayoutStatus,
): void {
  if (canTransition(from, to)) {
    return;
  }

  const allowed = ALLOWED_TRANSITIONS[from];

  throw new UnprocessableEntityException(
    allowed.length === 0
      ? `A ${from} payout is final and cannot change status.`
      : `Cannot move a payout from ${from} to ${to}. Allowed from ${from}: ${allowed.join(', ')}.`,
  );
}
