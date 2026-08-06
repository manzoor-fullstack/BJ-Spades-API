import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { StripeService, toMinorUnits } from '../stripe.service';

/** A ConfigService that answers only the two Stripe keys. */
function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('toMinorUnits', () => {
  it.each([
    ['0.00', 0],
    ['1.00', 100],
    ['19.99', 1999],
    ['750.25', 75025],
    ['0.01', 1],
    ['1000000.00', 100000000],
  ])('converts %s to %d cents', (amount, expected) => {
    expect(toMinorUnits(amount)).toBe(expected);
  });

  it('does not round-trip through a float', () => {
    // `19.99 * 100` is 1998.9999999999998 in IEEE-754, which truncates to 1998
    // — a cent short on every transfer.
    expect(19.99 * 100).not.toBe(1999);
    expect(toMinorUnits('19.99')).toBe(1999);
  });

  it('is exact for the amounts a ledger actually sees', () => {
    expect(toMinorUnits('1.10')).toBe(110);
    expect(toMinorUnits('2.30')).toBe(230);
    expect(toMinorUnits('4.70')).toBe(470);
  });
});

describe('StripeService without a secret key', () => {
  let service: StripeService;

  beforeEach(() => {
    service = new StripeService(
      config({
        'stripe.secretKey': undefined,
        'stripe.webhookSecret': undefined,
      }),
    );
  });

  it('constructs without throwing, so the API still boots', () => {
    // The whole point: an unconfigured payout feature must not take down
    // logins, tournaments and users with it.
    expect(service).toBeInstanceOf(StripeService);
  });

  it('reports itself unconfigured', () => {
    expect(service.isConfigured()).toBe(false);
  });

  it.each([
    [
      'createTransfer',
      () =>
        service.createTransfer({
          amount: '10.00',
          currency: 'usd',
          destination: 'acct_1',
          idempotencyKey: 'payout_1',
        }),
    ],
    [
      'createConnectAccount',
      () =>
        service.createConnectAccount({ email: 'a@b.com', userId: 'user-1' }),
    ],
    ['retrieveConnectAccount', () => service.retrieveConnectAccount('acct_1')],
    [
      'createAccountLink',
      () =>
        service.createAccountLink({
          accountId: 'acct_1',
          refreshUrl: 'http://x/refresh',
          returnUrl: 'http://x/return',
        }),
    ],
  ])(
    '%s fails with a message naming STRIPE_SECRET_KEY',
    async (_label, call) => {
      await expect(call()).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(call()).rejects.toThrow(/STRIPE_SECRET_KEY/);
    },
  );

  it('constructWebhookEvent names STRIPE_WEBHOOK_SECRET', () => {
    expect(() =>
      service.constructWebhookEvent(Buffer.from('{}'), 'sig'),
    ).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('treats a blank key as absent', () => {
    const blank = new StripeService(
      config({ 'stripe.secretKey': '   ', 'stripe.webhookSecret': '' }),
    );

    expect(blank.isConfigured()).toBe(false);
  });
});

describe('StripeService with a secret key', () => {
  it('reports itself configured without contacting Stripe', () => {
    // Construction is lazy: no client is built and no request is made until a
    // method is called, so this test cannot reach api.stripe.com.
    const service = new StripeService(
      config({
        'stripe.secretKey': 'sk_test_notarealkey',
        'stripe.webhookSecret': 'whsec_notarealsecret',
      }),
    );

    expect(service.isConfigured()).toBe(true);
  });
});
