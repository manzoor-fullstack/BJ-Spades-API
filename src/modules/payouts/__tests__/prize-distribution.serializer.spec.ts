import { PayoutStatus, StripeAccountStatus } from '@prisma/client';

import { deriveDistributionStatus } from '../serializers/prize-distribution.serializer';
import type { DistributionStatus } from '../serializers/prize-distribution.serializer';

describe('deriveDistributionStatus', () => {
  it('is NOT_STARTED when no payout exists', () => {
    expect(deriveDistributionStatus(null, StripeAccountStatus.VERIFIED)).toBe(
      'NOT_STARTED',
    );
  });

  it('maps the settled payout statuses one to one', () => {
    const cases: [PayoutStatus, DistributionStatus][] = [
      [PayoutStatus.PAID, 'SENT'],
      [PayoutStatus.PROCESSING, 'PROCESSING'],
      [PayoutStatus.APPROVED, 'APPROVED'],
      [PayoutStatus.FAILED, 'FAILED'],
      [PayoutStatus.CANCELLED, 'CANCELLED'],
    ];

    for (const [status, expected] of cases) {
      expect(
        deriveDistributionStatus(status, StripeAccountStatus.VERIFIED),
      ).toBe(expected);
    }
  });

  it('reports KYC_NEEDED when a held payout has an unverified recipient', () => {
    expect(
      deriveDistributionStatus(
        PayoutStatus.PENDING_REVIEW,
        StripeAccountStatus.PENDING,
      ),
    ).toBe('KYC_NEEDED');

    expect(
      deriveDistributionStatus(
        PayoutStatus.PENDING,
        StripeAccountStatus.RESTRICTED,
      ),
    ).toBe('KYC_NEEDED');

    expect(
      deriveDistributionStatus(
        PayoutStatus.PENDING,
        StripeAccountStatus.NOT_CONNECTED,
      ),
    ).toBe('KYC_NEEDED');
  });

  it('reports PENDING_REVIEW when the recipient is verified', () => {
    expect(
      deriveDistributionStatus(
        PayoutStatus.PENDING_REVIEW,
        StripeAccountStatus.VERIFIED,
      ),
    ).toBe('PENDING_REVIEW');

    expect(
      deriveDistributionStatus(
        PayoutStatus.PENDING,
        StripeAccountStatus.VERIFIED,
      ),
    ).toBe('PENDING_REVIEW');
  });

  it('does not report KYC_NEEDED for a payout that already moved', () => {
    // A paid payout's recipient may since have been restricted. The money has
    // gone; saying "KYC Needed" about it would be wrong.
    expect(
      deriveDistributionStatus(
        PayoutStatus.PAID,
        StripeAccountStatus.RESTRICTED,
      ),
    ).toBe('SENT');
  });
});
