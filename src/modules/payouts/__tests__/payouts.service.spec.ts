import {
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  PayoutMethod,
  PayoutStatus,
  StripeAccountStatus,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { toMoney } from '../../../common/money/money.util';
import type { ActivityLogService } from '../../activity/activity.service';
import type { AuthenticatedAdmin } from '../../auth/interfaces/authenticated-admin.interface';
import type { StripeGateway } from '../../stripe/stripe.interface';
import { CancelPayoutDto } from '../dto/payout-action.dto';
import {
  ALLOWED_TRANSITIONS,
  assertPayoutTransition,
  canTransition,
  isTerminalPayoutStatus,
} from '../payout-status';
import {
  PROCESS_ERRORS,
  PayoutsService,
  mapAccountStatus,
  transferIdempotencyKey,
} from '../payouts.service';
import { PayoutsRepository } from '../repositories/payouts.repository';
import type { PayoutWithRelations } from '../repositories/payouts.repository';

type MockedRepository = { [K in keyof PayoutsRepository]: jest.Mock };
type MockedStripe = { [K in keyof StripeGateway]: jest.Mock };

const ADMIN: AuthenticatedAdmin = {
  id: 'admin-1',
  email: 'admin@bjspades.com',
  role: 'SUPER_ADMIN',
  roleId: 'role-1',
  sessionId: 'session-1',
};

const PAYOUT_ID = '33333333-3333-4333-8333-000000000001';
const USER_ID = '11111111-1111-4111-8111-000000000001';
const TOURNAMENT_ID = '44444444-4444-4444-8444-000000000001';

const ALL_STATUSES = Object.values(PayoutStatus);

/** `jest.Mock.mock.calls` is `any[][]`; this keeps the assertions typed. */
function callsOf<T extends unknown[]>(mock: { mock: { calls: T[] } }): T[] {
  return mock.mock.calls;
}

interface MarkPaidCall {
  payoutId: string;
  stripeTransferId: string;
  ledger: { type: TransactionType; reference: string; payoutId: string };
}

interface ActivityCall {
  action: string;
  metadata?: Record<string, unknown>;
}

function payoutFixture(
  overrides: Partial<PayoutWithRelations> = {},
  userOverrides: Partial<PayoutWithRelations['user']> = {},
): PayoutWithRelations {
  return {
    id: PAYOUT_ID,
    userId: USER_ID,
    amount: toMoney('750.25'),
    currency: 'usd',
    method: PayoutMethod.STRIPE_CONNECT,
    status: PayoutStatus.APPROVED,
    tournamentId: 'tournament-1',
    placement: 1,
    stripeTransferId: null,
    failureReason: null,
    blockerReason: null,
    owedSince: new Date('2026-08-01T00:00:00.000Z'),
    approvedAt: new Date('2026-08-02T00:00:00.000Z'),
    processedAt: null,
    paidAt: null,
    approvedByAdminId: ADMIN.id,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-02T00:00:00.000Z'),
    user: {
      id: USER_ID,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      stripeAccountStatus: StripeAccountStatus.VERIFIED,
      stripeConnectAccountId: 'acct_123',
      ...userOverrides,
    },
    tournament: { id: 'tournament-1', name: 'Friday Night Spades' },
    ...overrides,
  };
}

function ledgerRow() {
  return {
    id: 'transaction-1',
    userId: USER_ID,
    type: TransactionType.PRIZE,
    status: TransactionStatus.COMPLETED,
    amount: toMoney('750.25'),
    balanceBefore: toMoney('0.00'),
    balanceAfter: toMoney('750.25'),
    description: null,
    reference: `payout:${PAYOUT_ID}`,
    tournamentId: 'tournament-1',
    payoutId: PAYOUT_ID,
    createdByAdminId: ADMIN.id,
    createdAt: new Date('2026-08-06T00:00:00.000Z'),
  };
}

describe('payout status transitions', () => {
  it('PAID and CANCELLED are terminal', () => {
    expect(ALLOWED_TRANSITIONS[PayoutStatus.PAID]).toEqual([]);
    expect(ALLOWED_TRANSITIONS[PayoutStatus.CANCELLED]).toEqual([]);
    expect(isTerminalPayoutStatus(PayoutStatus.PAID)).toBe(true);
    expect(isTerminalPayoutStatus(PayoutStatus.CANCELLED)).toBe(true);
  });

  it('offers no route out of PROCESSING except PAID or FAILED', () => {
    // Cancelling a transfer already in flight at Stripe would leave the money
    // moved and the record denying it.
    expect(ALLOWED_TRANSITIONS[PayoutStatus.PROCESSING]).toEqual([
      PayoutStatus.PAID,
      PayoutStatus.FAILED,
    ]);
  });

  it('treats a no-op as an error — every endpoint exists to move the payout', () => {
    expect(canTransition(PayoutStatus.APPROVED, PayoutStatus.APPROVED)).toBe(
      false,
    );
  });

  it.each(ALL_STATUSES)(
    'throws 422 for every illegal move out of %s',
    (from) => {
      const allowed = ALLOWED_TRANSITIONS[from];
      const illegal = ALL_STATUSES.filter((to) => !allowed.includes(to));

      expect(illegal.length).toBeGreaterThan(0);

      for (const to of illegal) {
        expect(() => assertPayoutTransition(from, to)).toThrow(
          UnprocessableEntityException,
        );
      }
    },
  );

  it.each(ALL_STATUSES)('permits every legal move out of %s', (from) => {
    for (const to of ALLOWED_TRANSITIONS[from]) {
      expect(() => assertPayoutTransition(from, to)).not.toThrow();
    }
  });

  it('names the allowed set in the message', () => {
    expect(() =>
      assertPayoutTransition(PayoutStatus.PENDING, PayoutStatus.PAID),
    ).toThrow(/Allowed from PENDING: PENDING_REVIEW, APPROVED, CANCELLED/);
  });

  it('says a terminal payout is final rather than listing an empty set', () => {
    expect(() =>
      assertPayoutTransition(PayoutStatus.PAID, PayoutStatus.APPROVED),
    ).toThrow('A PAID payout is final and cannot change status.');
  });
});

describe('transferIdempotencyKey', () => {
  it('is payout_{id} — the format Stripe collapses retries on', () => {
    // Changing this format silently disables the only protection against a
    // transfer that succeeded at Stripe while the response was lost.
    expect(transferIdempotencyKey(PAYOUT_ID)).toBe(`payout_${PAYOUT_ID}`);
  });
});

describe('mapAccountStatus', () => {
  it('is VERIFIED once Stripe will send the account money', () => {
    expect(mapAccountStatus({ payouts_enabled: true })).toBe(
      StripeAccountStatus.VERIFIED,
    );
  });

  it('is RESTRICTED when details are in but payouts are still off', () => {
    expect(
      mapAccountStatus({ payouts_enabled: false, details_submitted: true }),
    ).toBe(StripeAccountStatus.RESTRICTED);
  });

  it('is RESTRICTED when Stripe names a blocker', () => {
    expect(
      mapAccountStatus({
        requirements: { disabled_reason: 'requirements.past_due' },
      }),
    ).toBe(StripeAccountStatus.RESTRICTED);
  });

  it('is PENDING for a freshly created account', () => {
    expect(mapAccountStatus({})).toBe(StripeAccountStatus.PENDING);
  });
});

describe('PayoutsService', () => {
  let repository: MockedRepository;
  let activity: { record: jest.Mock };
  let stripe: MockedStripe;
  let service: PayoutsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findById: jest.fn().mockResolvedValue(payoutFixture()),
      findUserById: jest.fn().mockResolvedValue(null),
      stats: jest.fn(),
      approve: jest.fn().mockResolvedValue(1),
      cancel: jest.fn().mockResolvedValue(1),
      claimForProcessing: jest.fn().mockResolvedValue({ outcome: 'CLAIMED' }),
      markPaid: jest.fn(),
      releaseAfterFailure: jest.fn().mockResolvedValue(undefined),
      setStripeAccount: jest.fn().mockResolvedValue(undefined),
      setStripeStatusByAccountId: jest.fn().mockResolvedValue(1),
      findByStripeTransferId: jest.fn().mockResolvedValue(null),
      markFailed: jest.fn().mockResolvedValue(undefined),
      findTransactions: jest.fn().mockResolvedValue([]),
      countPrizeTransactions: jest.fn().mockResolvedValue(0),
      findPrizeDistribution: jest.fn().mockResolvedValue([]),
      findPayoutTournaments: jest.fn().mockResolvedValue([]),
      tournamentExists: jest.fn().mockResolvedValue(true),
    };

    activity = { record: jest.fn().mockResolvedValue(undefined) };

    stripe = {
      isConfigured: jest.fn().mockReturnValue(true),
      createTransfer: jest.fn().mockResolvedValue({
        id: 'tr_123',
        amount: 75025,
        currency: 'usd',
        destination: 'acct_123',
      }),
      createConnectAccount: jest.fn(),
      retrieveConnectAccount: jest.fn(),
      createAccountLink: jest.fn(),
      constructWebhookEvent: jest.fn(),
    };

    repository.markPaid.mockResolvedValue({
      outcome: 'PAID',
      payout: payoutFixture({
        status: PayoutStatus.PAID,
        stripeTransferId: 'tr_123',
        paidAt: new Date('2026-08-06T00:00:00.000Z'),
      }),
      transaction: ledgerRow(),
    });

    service = new PayoutsService(
      repository as unknown as PayoutsRepository,
      activity as unknown as ActivityLogService,
      {
        get: jest.fn().mockReturnValue('http://localhost:5000'),
      } as unknown as ConfigService,
      stripe,
    );
  });

  describe('stats', () => {
    it('renders every money figure as a two-decimal string', async () => {
      repository.stats.mockResolvedValue({
        totalPrizePool: toMoney('12000'),
        paidOut: toMoney('7500'),
        pendingPayouts: toMoney('1200.5'),
        owedToPlayers: toMoney('5150'),
        readyToSend: toMoney('3500'),
        blocked: toMoney('1650'),
        pendingReview: 7,
        playersAwaiting: 6,
      });

      await expect(service.stats()).resolves.toEqual({
        totalPrizePool: '12000.00',
        paidOut: '7500.00',
        pendingPayouts: '1200.50',
        pendingReview: 7,
        owedToPlayers: '5150.00',
        readyToSend: '3500.00',
        blocked: '1650.00',
        playersAwaiting: 6,
      });
    });

    it('reports zeroes rather than nulls on an empty database', async () => {
      repository.stats.mockResolvedValue({
        totalPrizePool: null,
        paidOut: null,
        pendingPayouts: null,
        owedToPlayers: null,
        readyToSend: null,
        blocked: null,
        pendingReview: 0,
        playersAwaiting: 0,
      });

      await expect(service.stats()).resolves.toMatchObject({
        totalPrizePool: '0.00',
        paidOut: '0.00',
        pendingPayouts: '0.00',
        owedToPlayers: '0.00',
        readyToSend: '0.00',
        blocked: '0.00',
      });
    });
  });

  describe('prizeDistribution', () => {
    it('throws 404 for an unknown tournament', async () => {
      repository.tournamentExists.mockResolvedValue(false);

      await expect(
        service.prizeDistribution({ tournamentId: TOURNAMENT_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns an empty list for a tournament with no placements', async () => {
      repository.tournamentExists.mockResolvedValue(true);
      repository.findPrizeDistribution.mockResolvedValue([]);

      await expect(
        service.prizeDistribution({ tournamentId: TOURNAMENT_ID }),
      ).resolves.toEqual([]);
    });

    it('passes the currency filter through to the repository', async () => {
      repository.tournamentExists.mockResolvedValue(true);

      await service.prizeDistribution({
        tournamentId: TOURNAMENT_ID,
        currency: 'usd',
      });

      expect(repository.findPrizeDistribution).toHaveBeenCalledWith(
        TOURNAMENT_ID,
        'usd',
      );
    });

    it('does not query the winners of a tournament that does not exist', async () => {
      repository.tournamentExists.mockResolvedValue(false);

      await expect(
        service.prizeDistribution({ tournamentId: TOURNAMENT_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(repository.findPrizeDistribution).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('throws 404 for an unknown id', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(PAYOUT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('marks an approved, verified, positive payout as payable', async () => {
      const result = await service.findOne(PAYOUT_ID);

      expect(result.isPayable).toBe(true);
      expect(result.amount).toBe('750.25');
    });

    it.each<[string, Partial<PayoutWithRelations>]>([
      ['not approved', { status: PayoutStatus.PENDING }],
      ['already transferred', { stripeTransferId: 'tr_1' }],
      ['zero amount', { amount: toMoney(0) }],
    ])('is not payable when %s', async (_label, overrides) => {
      repository.findById.mockResolvedValue(payoutFixture(overrides));

      await expect(service.findOne(PAYOUT_ID)).resolves.toMatchObject({
        isPayable: false,
      });
    });

    it('is not payable when the recipient is unverified', async () => {
      repository.findById.mockResolvedValue(
        payoutFixture({}, { stripeAccountStatus: StripeAccountStatus.PENDING }),
      );

      await expect(service.findOne(PAYOUT_ID)).resolves.toMatchObject({
        isPayable: false,
      });
    });
  });

  describe('approve', () => {
    it('rejects an illegal transition with 422', async () => {
      repository.findById.mockResolvedValue(
        payoutFixture({ status: PayoutStatus.PAID }),
      );

      await expect(service.approve(PAYOUT_ID, ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );

      expect(repository.approve).not.toHaveBeenCalled();
    });

    it('refuses to re-approve an already APPROVED payout', async () => {
      // Silently succeeding would overwrite approvedAt and the approver.
      await expect(service.approve(PAYOUT_ID, ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('reports 422 when a concurrent change made the guarded update a no-op', async () => {
      repository.findById.mockResolvedValue(
        payoutFixture({ status: PayoutStatus.PENDING }),
      );
      repository.approve.mockResolvedValue(0);

      await expect(service.approve(PAYOUT_ID, ADMIN)).rejects.toThrow(
        /changed while it was being approved/,
      );
    });

    it('records the approver', async () => {
      repository.findById.mockResolvedValue(
        payoutFixture({ status: PayoutStatus.PENDING }),
      );

      await service.approve(PAYOUT_ID, ADMIN);

      expect(repository.approve).toHaveBeenCalledWith(
        PAYOUT_ID,
        ADMIN.id,
        expect.arrayContaining([PayoutStatus.PENDING]),
      );
    });
  });

  describe('cancel', () => {
    const dto = plainToInstance(CancelPayoutDto, {
      reason: '  Duplicate of payout #4821  ',
    });

    it('requires a reason of at least three characters', () => {
      expect(
        validateSync(plainToInstance(CancelPayoutDto, { reason: 'no' })),
      ).not.toHaveLength(0);
      expect(
        validateSync(plainToInstance(CancelPayoutDto, {})),
      ).not.toHaveLength(0);
    });

    it('trims the reason before storing it', async () => {
      await service.cancel(PAYOUT_ID, dto, ADMIN);

      expect(repository.cancel).toHaveBeenCalledWith(
        PAYOUT_ID,
        'Duplicate of payout #4821',
        expect.any(Array),
      );
    });

    it.each([PayoutStatus.PAID, PayoutStatus.CANCELLED])(
      'refuses to cancel a %s payout',
      async (status) => {
        repository.findById.mockResolvedValue(payoutFixture({ status }));

        await expect(
          service.cancel(PAYOUT_ID, dto, ADMIN),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
      },
    );

    it('refuses to cancel a payout already in flight at Stripe', async () => {
      repository.findById.mockResolvedValue(
        payoutFixture({ status: PayoutStatus.PROCESSING }),
      );

      await expect(
        service.cancel(PAYOUT_ID, dto, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe('process — eligibility', () => {
    it('refuses a payout that is not APPROVED', async () => {
      repository.findById.mockResolvedValue(
        payoutFixture({ status: PayoutStatus.PENDING }),
      );

      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toThrow(
        PROCESS_ERRORS.NOT_APPROVED,
      );

      expect(stripe.createTransfer).not.toHaveBeenCalled();
    });

    it('refuses a payout for an unverified recipient', async () => {
      repository.findById.mockResolvedValue(
        payoutFixture(
          {},
          { stripeAccountStatus: StripeAccountStatus.RESTRICTED },
        ),
      );

      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toThrow(
        PROCESS_ERRORS.NOT_VERIFIED,
      );
    });

    it('refuses a payout that already carries a transfer id', async () => {
      repository.findById.mockResolvedValue(
        payoutFixture({ stripeTransferId: 'tr_existing' }),
      );

      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toThrow(
        PROCESS_ERRORS.ALREADY_PROCESSED,
      );
    });

    it('says "already processed" for a PAID payout, not "not approved"', async () => {
      repository.findById.mockResolvedValue(
        payoutFixture({
          status: PayoutStatus.PAID,
          stripeTransferId: 'tr_existing',
        }),
      );

      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toThrow(
        PROCESS_ERRORS.ALREADY_PROCESSED,
      );
    });

    it.each(['0.00', '-5.00'])('refuses an amount of %s', async (amount) => {
      repository.findById.mockResolvedValue(
        payoutFixture({ amount: toMoney(amount) }),
      );

      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toThrow(
        PROCESS_ERRORS.NOT_POSITIVE,
      );
    });

    it('every refusal is a 422', async () => {
      repository.findById.mockResolvedValue(
        payoutFixture({ status: PayoutStatus.CANCELLED }),
      );

      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('throws 404 for an unknown payout', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('answers 503, not 422, when Stripe has no key configured', async () => {
      stripe.isConfigured.mockReturnValue(false);

      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      // Never claimed, so the payout is not stranded in PROCESSING.
      expect(repository.claimForProcessing).not.toHaveBeenCalled();
    });
  });

  describe('process — the transfer', () => {
    it('sends payout_{id} as the idempotency key', async () => {
      await service.process(PAYOUT_ID, ADMIN);

      expect(stripe.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `payout_${PAYOUT_ID}`,
          amount: '750.25',
          currency: 'usd',
          destination: 'acct_123',
        }),
      );
    });

    it('claims the payout before calling Stripe', async () => {
      await service.process(PAYOUT_ID, ADMIN);

      const claimOrder = repository.claimForProcessing.mock
        .invocationCallOrder[0] as number;
      const transferOrder = stripe.createTransfer.mock
        .invocationCallOrder[0] as number;

      // The conditional APPROVED → PROCESSING update is what makes exactly one
      // of two concurrent requests reach Stripe.
      expect(claimOrder).toBeLessThan(transferOrder);
    });

    it('writes a PRIZE transaction referenced to the payout', async () => {
      await service.process(PAYOUT_ID, ADMIN);

      const call = callsOf<[MarkPaidCall]>(repository.markPaid)[0]?.[0];

      expect(call?.payoutId).toBe(PAYOUT_ID);
      expect(call?.stripeTransferId).toBe('tr_123');
      expect(call?.ledger.type).toBe(TransactionType.PRIZE);
      // Deterministic and unique: a second credit for the same payout would
      // fail at the database rather than silently doubling the prize.
      expect(call?.ledger.reference).toBe(`payout:${PAYOUT_ID}`);
      expect(call?.ledger.payoutId).toBe(PAYOUT_ID);
    });

    it('returns the payout as PAID', async () => {
      const result = await service.process(PAYOUT_ID, ADMIN);

      expect(result.status).toBe(PayoutStatus.PAID);
      expect(result.stripeTransferId).toBe('tr_123');
    });

    it('audits the processed payout at high priority', async () => {
      await service.process(PAYOUT_ID, ADMIN);

      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'payout.processed',
          adminId: ADMIN.id,
        }),
      );
    });

    it('rejects the loser of a race with the reason from the fresh row', async () => {
      repository.claimForProcessing.mockResolvedValue({
        outcome: 'NOT_CLAIMED',
        payout: payoutFixture({
          status: PayoutStatus.PAID,
          stripeTransferId: 'tr_123',
        }),
      });

      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toThrow(
        PROCESS_ERRORS.ALREADY_PROCESSED,
      );

      expect(stripe.createTransfer).not.toHaveBeenCalled();
    });

    it('falls back to "must be approved" when the loser cannot be characterised', async () => {
      repository.claimForProcessing.mockResolvedValue({
        outcome: 'NOT_CLAIMED',
        payout: payoutFixture({ status: PayoutStatus.PROCESSING }),
      });

      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toThrow(
        PROCESS_ERRORS.NOT_APPROVED,
      );
    });
  });

  describe('process — a failed transfer', () => {
    beforeEach(() => {
      stripe.createTransfer.mockRejectedValue(
        new Error('Insufficient funds in the platform account'),
      );
    });

    it('puts the payout back and records nothing in the ledger', async () => {
      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );

      expect(repository.releaseAfterFailure).toHaveBeenCalledWith(
        PAYOUT_ID,
        'Insufficient funds in the platform account',
      );
      expect(repository.markPaid).not.toHaveBeenCalled();
    });

    it("surfaces Stripe's own reason rather than a generic error", async () => {
      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toThrow(
        /Insufficient funds in the platform account/,
      );
    });

    it('audits the failure', async () => {
      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toThrow();

      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'payout.failed' }),
      );
    });

    it('releases the payout when the recipient has no Connect account id', async () => {
      repository.findById.mockResolvedValue(
        payoutFixture({}, { stripeConnectAccountId: null }),
      );

      await expect(service.process(PAYOUT_ID, ADMIN)).rejects.toThrow(
        PROCESS_ERRORS.NOT_VERIFIED,
      );

      expect(repository.releaseAfterFailure).toHaveBeenCalled();
      expect(stripe.createTransfer).not.toHaveBeenCalled();
    });
  });

  describe('createOnboardingLink', () => {
    const user = {
      id: USER_ID,
      email: 'ada@example.com',
      deletedAt: null,
      stripeConnectAccountId: null,
      stripeAccountStatus: StripeAccountStatus.NOT_CONNECTED,
    };

    beforeEach(() => {
      repository.findUserById.mockResolvedValue(user);
      stripe.createConnectAccount.mockResolvedValue({
        id: 'acct_new',
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      });
      stripe.createAccountLink.mockResolvedValue({
        url: 'https://connect.stripe.com/setup/s/abc',
        expiresAt: 1_800_000_000,
      });
    });

    it('creates the Connect account and stores it as PENDING, never VERIFIED', async () => {
      await service.createOnboardingLink(USER_ID, ADMIN);

      // Only `account.updated` may promote an account to VERIFIED — the account
      // existing is not the same as Stripe agreeing to pay it.
      expect(repository.setStripeAccount).toHaveBeenCalledWith(
        USER_ID,
        'acct_new',
        StripeAccountStatus.PENDING,
      );
    });

    it('reuses an existing Connect account', async () => {
      repository.findUserById.mockResolvedValue({
        ...user,
        stripeConnectAccountId: 'acct_existing',
      });

      await service.createOnboardingLink(USER_ID, ADMIN);

      expect(stripe.createConnectAccount).not.toHaveBeenCalled();
      expect(stripe.createAccountLink).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'acct_existing' }),
      );
    });

    it('returns the hosted link and its expiry as a Date', async () => {
      const result = await service.createOnboardingLink(USER_ID, ADMIN);

      expect(result.url).toBe('https://connect.stripe.com/setup/s/abc');
      expect(result.expiresAt.getTime()).toBe(1_800_000_000 * 1000);
    });

    it('never puts the link itself in the audit metadata', async () => {
      await service.createOnboardingLink(USER_ID, ADMIN);

      const call = callsOf<[ActivityCall]>(activity.record)[0]?.[0];

      // An onboarding link is a bearer credential for someone's identity check.
      expect(JSON.stringify(call?.metadata)).not.toContain(
        'connect.stripe.com',
      );
    });

    it('throws 404 for an unknown user', async () => {
      repository.findUserById.mockResolvedValue(null);

      await expect(
        service.createOnboardingLink(USER_ID, ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to onboard a deleted user', async () => {
      repository.findUserById.mockResolvedValue({
        ...user,
        deletedAt: new Date(),
      });

      await expect(
        service.createOnboardingLink(USER_ID, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('answers 503 when Stripe has no key configured', async () => {
      stripe.isConfigured.mockReturnValue(false);

      await expect(
        service.createOnboardingLink(USER_ID, ADMIN),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('handleWebhook', () => {
    const body = Buffer.from('{"id":"evt_1"}');

    it('rejects a missing signature with 400', async () => {
      await expect(service.handleWebhook(body, undefined)).rejects.toThrow(
        'Missing stripe-signature header',
      );
    });

    it('rejects an empty body with 400', async () => {
      await expect(
        service.handleWebhook(Buffer.alloc(0), 'sig'),
      ).rejects.toThrow('Missing request body');
    });

    it('rejects a bad signature with 400 and changes nothing', async () => {
      stripe.constructWebhookEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature');
      });

      await expect(service.handleWebhook(body, 'sig')).rejects.toThrow(
        'Invalid Stripe signature',
      );

      expect(repository.setStripeStatusByAccountId).not.toHaveBeenCalled();
    });

    it('syncs stripeAccountStatus from account.updated', async () => {
      stripe.constructWebhookEvent.mockReturnValue({
        id: 'evt_1',
        type: 'account.updated',
        data: { object: { id: 'acct_123', payouts_enabled: true } },
      });

      const result = await service.handleWebhook(body, 'sig');

      expect(repository.setStripeStatusByAccountId).toHaveBeenCalledWith(
        'acct_123',
        StripeAccountStatus.VERIFIED,
      );
      expect(result).toMatchObject({ received: true, handled: true });
    });

    it('marks the payout FAILED on transfer.failed', async () => {
      repository.findByStripeTransferId.mockResolvedValue(
        payoutFixture({ status: PayoutStatus.PROCESSING }),
      );
      stripe.constructWebhookEvent.mockReturnValue({
        id: 'evt_2',
        type: 'transfer.failed',
        data: { object: { id: 'tr_123', failure_message: 'Account closed' } },
      });

      await service.handleWebhook(body, 'sig');

      expect(repository.markFailed).toHaveBeenCalledWith(
        PAYOUT_ID,
        'Account closed',
      );
    });

    it('acknowledges an event it does not act on', async () => {
      stripe.constructWebhookEvent.mockReturnValue({
        id: 'evt_3',
        type: 'transfer.paid',
        data: { object: { id: 'tr_123' } },
      });

      await expect(service.handleWebhook(body, 'sig')).resolves.toMatchObject({
        received: true,
        handled: false,
      });
    });

    it('acknowledges an entirely unknown event type', async () => {
      stripe.constructWebhookEvent.mockReturnValue({
        id: 'evt_4',
        type: 'invoice.paid',
        data: { object: {} },
      });

      await expect(service.handleWebhook(body, 'sig')).resolves.toMatchObject({
        received: true,
        handled: false,
      });
    });
  });
});
