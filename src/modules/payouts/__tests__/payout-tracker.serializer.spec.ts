import { PayoutStatus, StripeAccountStatus } from '@prisma/client';

import { toMoney } from '../../../common/money/money.util';
import type { PayoutWithRelations } from '../repositories/payouts.repository';
import { toPayoutTrackerItem } from '../serializers/payout-tracker.serializer';

const PAYOUT_ID = '33333333-3333-4333-8333-000000000001';
const USER_ID = '11111111-1111-4111-8111-000000000001';

/**
 * Mirrors the fixture in payouts.service.spec.ts. Kept local rather than
 * exported from there: a shared fixture that two specs mutate differently is a
 * cross-test coupling waiting to bite.
 */
function payoutFixture(
  overrides: Partial<PayoutWithRelations> = {},
  userOverrides: Partial<PayoutWithRelations['user']> = {},
): PayoutWithRelations {
  return {
    id: PAYOUT_ID,
    userId: USER_ID,
    amount: toMoney('750.25'),
    currency: 'usd',
    method: 'STRIPE_CONNECT',
    status: PayoutStatus.APPROVED,
    tournamentId: null,
    placement: null,
    stripeTransferId: null,
    failureReason: null,
    blockerReason: null,
    owedSince: new Date('2026-05-01T00:00:00.000Z'),
    approvedAt: new Date('2026-05-02T00:00:00.000Z'),
    processedAt: null,
    paidAt: null,
    settledAt: null,
    approvedByAdminId: null,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    user: {
      id: USER_ID,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      stripeAccountStatus: StripeAccountStatus.VERIFIED,
      stripeConnectAccountId: 'acct_1',
      stripeVerifiedAt: new Date('2026-04-01T00:00:00.000Z'),
      ...userOverrides,
    },
    tournament: null,
    ...overrides,
  };
}

describe('toPayoutTrackerItem', () => {
  it('marks Pending Review current for a new payout to an unverified player', () => {
    const item = toPayoutTrackerItem(
      payoutFixture(
        { status: PayoutStatus.PENDING, approvedAt: null },
        {
          stripeAccountStatus: StripeAccountStatus.NOT_CONNECTED,
          stripeVerifiedAt: null,
        },
      ),
    );

    expect(item.steps[0]?.state).toBe('CURRENT');
    expect(item.steps[1]?.state).toBe('TODO');
    expect(item.currentStep).toBe(1);
  });

  it('counts identity verification even before approval', () => {
    // Verification belongs to the user, not the payout, so a verified player
    // has cleared step 2 the moment their payout is created. The rail reflects
    // that rather than pretending the steps are strictly sequential.
    const item = toPayoutTrackerItem(
      payoutFixture({ status: PayoutStatus.PENDING, approvedAt: null }),
    );

    expect(item.steps[0]?.state).toBe('DONE');
    expect(item.steps[1]?.state).toBe('CURRENT');
    expect(item.steps[2]?.state).toBe('TODO');
    expect(item.currentStep).toBe(2);
  });

  it('blocks the rail when a blockerReason is present', () => {
    const item = toPayoutTrackerItem(
      payoutFixture({
        status: PayoutStatus.PENDING_REVIEW,
        approvedAt: null,
        blockerReason: 'KYC incomplete',
      }),
    );

    expect(item.steps.some((step) => step.state === 'BLOCKED')).toBe(true);
    expect(item.blockerReason).toBe('KYC incomplete');
  });

  it('marks Identity Verified done only for a verified recipient', () => {
    const verified = toPayoutTrackerItem(
      payoutFixture({ status: PayoutStatus.APPROVED }),
    );
    expect(verified.steps[1]?.state).toBe('DONE');

    const unverified = toPayoutTrackerItem(
      payoutFixture(
        { status: PayoutStatus.PENDING_REVIEW, approvedAt: null },
        {
          stripeAccountStatus: StripeAccountStatus.PENDING,
          stripeVerifiedAt: null,
        },
      ),
    );
    expect(unverified.steps[1]?.state).not.toBe('DONE');
  });

  it('completes the rail only once settlement is observed', () => {
    const sent = toPayoutTrackerItem(
      payoutFixture({
        status: PayoutStatus.PAID,
        processedAt: new Date('2026-05-21T00:00:00.000Z'),
        paidAt: new Date('2026-05-22T00:00:00.000Z'),
        settledAt: null,
        stripeTransferId: 'tr_1',
      }),
    );

    // Sent is where it rests: the furthest step reached.
    expect(sent.steps[4]?.state).toBe('CURRENT');
    // Stripe accepted the transfer; nobody has said it landed.
    expect(sent.steps[5]?.state).toBe('TODO');
    expect(sent.progress).toBeLessThan(100);

    const settled = toPayoutTrackerItem(
      payoutFixture({
        status: PayoutStatus.PAID,
        processedAt: new Date('2026-05-21T00:00:00.000Z'),
        paidAt: new Date('2026-05-22T00:00:00.000Z'),
        settledAt: new Date('2026-05-23T00:00:00.000Z'),
        stripeTransferId: 'tr_1',
      }),
    );

    expect(settled.steps[5]?.state).toBe('DONE');
    expect(settled.progress).toBe(100);
  });

  it('offers APPROVE only from an approvable status', () => {
    expect(
      toPayoutTrackerItem(
        payoutFixture({ status: PayoutStatus.PENDING, approvedAt: null }),
      ).advanceAction,
    ).toBe('APPROVE');

    expect(
      toPayoutTrackerItem(
        payoutFixture({
          status: PayoutStatus.PROCESSING,
          processedAt: new Date('2026-05-21T00:00:00.000Z'),
        }),
      ).advanceAction,
    ).toBeNull();
  });

  it('offers PROCESS only for a payable payout', () => {
    // Approved, verified recipient, no transfer yet, positive amount.
    expect(
      toPayoutTrackerItem(payoutFixture({ status: PayoutStatus.APPROVED }))
        .advanceAction,
    ).toBe('PROCESS');

    // Approved but the recipient is not verified: process() would 422.
    expect(
      toPayoutTrackerItem(
        payoutFixture(
          { status: PayoutStatus.APPROVED },
          {
            stripeAccountStatus: StripeAccountStatus.RESTRICTED,
          },
        ),
      ).advanceAction,
    ).toBeNull();
  });

  it('offers no advance for a terminal payout', () => {
    expect(
      toPayoutTrackerItem(payoutFixture({ status: PayoutStatus.CANCELLED }))
        .advanceAction,
    ).toBeNull();

    expect(
      toPayoutTrackerItem(
        payoutFixture({
          status: PayoutStatus.PAID,
          paidAt: new Date('2026-05-22T00:00:00.000Z'),
        }),
      ).advanceAction,
    ).toBeNull();
  });

  it('marks Processing blocked and surfaces the reason on a failure', () => {
    const item = toPayoutTrackerItem(
      payoutFixture({
        status: PayoutStatus.FAILED,
        processedAt: new Date('2026-05-21T00:00:00.000Z'),
        failureReason: 'Insufficient funds in the platform account',
      }),
    );

    expect(item.steps[3]?.state).toBe('BLOCKED');
    expect(item.failureReason).toBe(
      'Insufficient funds in the platform account',
    );
  });
});
