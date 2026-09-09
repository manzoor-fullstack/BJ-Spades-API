import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { TransactionType } from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { PlayerEmailService } from '../../player-auth/services/player-email.service';
import { STRIPE_GATEWAY } from '../../stripe/stripe.interface';
import type {
  CreateAccountLinkParams,
  CreateCheckoutSessionParams,
  CreateConnectAccountParams,
  CreateStripeCustomerParams,
  CreateTransferParams,
  StripeGateway,
  StripeWebhookEvent,
} from '../../stripe/stripe.interface';
import { TransactionsService } from '../../transactions/transactions.service';

const ORIGIN = 'http://127.0.0.1:4173';

class CapturingEmailService {
  tokens = new Map<string, string>();
  verification(email: string, token: string) {
    this.tokens.set(email, token);
    return Promise.resolve();
  }
  passwordReset() {
    return Promise.resolve();
  }
}

class FakeStripe implements StripeGateway {
  event: StripeWebhookEvent | null = null;
  checkoutCalls: CreateCheckoutSessionParams[] = [];
  expiredSessions: string[] = [];
  isConfigured() {
    return true;
  }
  createTransfer(_params: CreateTransferParams) {
    return Promise.resolve({
      id: 'tr_1',
      amount: 1,
      currency: 'usd',
      destination: 'acct_1',
    });
  }
  createConnectAccount(_params: CreateConnectAccountParams) {
    return Promise.resolve({
      id: 'acct_1',
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
  }
  retrieveConnectAccount(id: string) {
    return Promise.resolve({
      id,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
  }
  createAccountLink(_params: CreateAccountLinkParams) {
    return Promise.resolve({
      url: 'https://connect.stripe.test',
      expiresAt: 1,
    });
  }
  createCustomer(params: CreateStripeCustomerParams) {
    return Promise.resolve({ id: `cus_${params.userId}` });
  }
  createCheckoutSession(params: CreateCheckoutSessionParams) {
    this.checkoutCalls.push(params);
    return Promise.resolve({
      id: `cs_${params.depositId}`,
      url: `https://checkout.stripe.test/${params.depositId}`,
      paymentIntentId: `pi_${params.depositId}`,
    });
  }
  expireCheckoutSession(sessionId: string) {
    this.expiredSessions.push(sessionId);
    return Promise.resolve();
  }
  retrievePaymentMethodForIntent() {
    return Promise.resolve({
      id: 'pm_4242',
      type: 'card',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
    });
  }
  constructWebhookEvent() {
    if (!this.event) throw new Error('Missing fake event');
    return this.event;
  }
}

function cookieValue(response: request.Response, name: string): string {
  const headers = (
    response.headers as Record<string, string | string[] | undefined>
  )['set-cookie'];
  const values = Array.isArray(headers) ? headers : headers ? [headers] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing ${name} cookie`);
  return cookie.split(';')[0]!.slice(name.length + 1);
}

function responseData<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

interface DepositBody {
  id: string;
  status: string;
}

interface WalletBody {
  availableBalance: string;
  depositedAmount: string;
}

describe('Player deposits API (integration)', () => {
  let app: INestApplication;
  const email = new CapturingEmailService();
  const stripe = new FakeStripe();
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [
        { provide: PlayerEmailService, useValue: email },
        { provide: STRIPE_GATEWAY, useValue: stripe },
      ],
    });
  });
  afterAll(async () => app?.close());
  beforeEach(() => {
    stripe.event = null;
    stripe.checkoutCalls = [];
    stripe.expiredSessions = [];
  });

  async function signedInPlayer(suffix: string) {
    const agent = request.agent(server());
    const address = `deposit-${suffix}@example.com`;
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: `deposit_${suffix}`,
        email: address,
        password: 'StrongPass123',
      })
      .expect(202);
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token: email.tokens.get(address) })
      .expect(200);
    const login = await agent
      .post('/api/player/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: address, password: 'StrongPass123', rememberMe: false })
      .expect(200);
    return {
      agent,
      csrf: cookieValue(login, 'bjs_player_csrf'),
      user: await testPrisma.user.findUniqueOrThrow({
        where: { email: address },
      }),
    };
  }

  function createDeposit(
    player: Awaited<ReturnType<typeof signedInPlayer>>,
    amount = '25.00',
    requestId = randomUUID(),
  ) {
    return player.agent
      .post('/api/player/v1/me/deposits')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .send({ amount, requestId });
  }

  function webhook(event: StripeWebhookEvent) {
    stripe.event = event;
    return request(server())
      .post('/api/payouts/stripe/webhook')
      .set('stripe-signature', 'valid')
      .send({ event: event.id });
  }

  it('creates one checkout for a retried request and never credits from the browser call', async () => {
    const player = await signedInPlayer('retry');
    const requestId = randomUUID();
    const first = await createDeposit(player, '25.00', requestId).expect(201);
    const second = await createDeposit(player, '25.00', requestId).expect(201);
    const firstDeposit = responseData<DepositBody>(first);
    const secondDeposit = responseData<DepositBody>(second);
    expect(firstDeposit.id).toBe(secondDeposit.id);
    expect(firstDeposit.status).toBe('CHECKOUT_CREATED');
    expect(stripe.checkoutCalls).toHaveLength(1);
    expect(stripe.checkoutCalls[0]).toMatchObject({
      amount: '25.00',
      currency: 'USD',
      idempotencyKey: `deposit_${firstDeposit.id}`,
    });
    await expect(testPrisma.transaction.count()).resolves.toBe(0);
    expect(
      (
        await testPrisma.user.findUniqueOrThrow({
          where: { id: player.user.id },
        })
      ).balance.toFixed(2),
    ).toBe('0.00');
    const canceled = await player.agent
      .post(`/api/player/v1/me/deposits/${firstDeposit.id}/cancel`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(200);
    expect(responseData<DepositBody>(canceled).status).toBe('CANCELED');
    expect(stripe.expiredSessions).toEqual([`cs_${firstDeposit.id}`]);
  });

  it('keeps an authenticated or delayed payment pending until Stripe confirms success', async () => {
    const player = await signedInPlayer('async');
    const created = await createDeposit(player, '30.00').expect(201);
    const id = responseData<DepositBody>(created).id;
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_${id}`,
          payment_intent: `pi_${id}`,
          payment_status: 'unpaid',
          amount_total: 3000,
          currency: 'usd',
          metadata: { depositId: id },
        },
      },
    }).expect(200);
    const processing = await player.agent
      .get(`/api/player/v1/me/deposits/${id}`)
      .expect(200);
    expect(responseData<DepositBody>(processing).status).toBe('PROCESSING');
    const before = await player.agent
      .get('/api/player/v1/me/wallet')
      .expect(200);
    expect(responseData<WalletBody>(before).availableBalance).toBe('0.00');

    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'checkout.session.async_payment_succeeded',
      data: {
        object: {
          id: `cs_${id}`,
          payment_intent: `pi_${id}`,
          payment_status: 'paid',
          amount_total: 3000,
          currency: 'usd',
          metadata: { depositId: id },
        },
      },
    }).expect(200);
    const after = await player.agent
      .get('/api/player/v1/me/wallet')
      .expect(200);
    expect(responseData<WalletBody>(after).availableBalance).toBe('30.00');
  });

  it('credits exactly once after a paid signed webhook and exposes the saved method only to its owner', async () => {
    const player = await signedInPlayer('paid');
    const other = await signedInPlayer('other');
    const created = await createDeposit(player).expect(201);
    const id = responseData<DepositBody>(created).id;
    const event: StripeWebhookEvent = {
      id: `evt_${randomUUID()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_${id}`,
          payment_intent: `pi_${id}`,
          payment_status: 'paid',
          amount_total: 2500,
          currency: 'usd',
          metadata: { depositId: id },
        },
      },
    };
    await webhook(event).expect(200);
    await webhook(event).expect(200);

    const wallet = await player.agent
      .get('/api/player/v1/me/wallet')
      .expect(200);
    const walletData = responseData<WalletBody>(wallet);
    expect(walletData.availableBalance).toBe('25.00');
    expect(walletData.depositedAmount).toBe('25.00');
    await expect(
      testPrisma.transaction.count({
        where: { userId: player.user.id, type: TransactionType.DEPOSIT },
      }),
    ).resolves.toBe(1);

    const methods = await player.agent
      .get('/api/player/v1/me/payment-methods')
      .expect(200);
    const savedMethods = responseData<
      Array<{
        id: string;
        type: string;
        brand: string;
        last4: string;
        expMonth: number;
        expYear: number;
        isDefault: boolean;
      }>
    >(methods);
    expect(savedMethods).toHaveLength(1);
    expect(typeof savedMethods[0]?.id).toBe('string');
    expect(savedMethods[0]).toMatchObject({
      type: 'card',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    });
    const otherMethods = await other.agent
      .get('/api/player/v1/me/payment-methods')
      .expect(200);
    expect(responseData<unknown[]>(otherMethods)).toEqual([]);
  });

  it('does not credit failed payments and reverses refunds even after tokens were spent', async () => {
    const player = await signedInPlayer('reversal');
    const failed = await createDeposit(player, '20.00').expect(201);
    const failedId = responseData<DepositBody>(failed).id;
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: `pi_${failedId}`,
          metadata: { depositId: failedId },
          last_payment_error: {
            code: 'card_declined',
            message: 'Your card was declined.',
          },
        },
      },
    }).expect(200);
    const failedDeposit = await player.agent
      .get(`/api/player/v1/me/deposits/${failedId}`)
      .expect(200);
    expect(responseData<DepositBody>(failedDeposit).status).toBe('FAILED');
    const emptyWallet = await player.agent
      .get('/api/player/v1/me/wallet')
      .expect(200);
    expect(responseData<WalletBody>(emptyWallet).availableBalance).toBe('0.00');

    const paid = await createDeposit(player, '25.00').expect(201);
    const paidId = responseData<DepositBody>(paid).id;
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: `pi_${paidId}`,
          amount_received: 2500,
          currency: 'usd',
          metadata: { depositId: paidId },
        },
      },
    }).expect(200);
    await app.get(TransactionsService).record({
      userId: player.user.id,
      type: TransactionType.ENTRY_FEE,
      amount: '-15.00',
    });
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_refunded',
          payment_intent: `pi_${paidId}`,
          amount_refunded: 2500,
        },
      },
    }).expect(200);

    const reversedWallet = await player.agent
      .get('/api/player/v1/me/wallet')
      .expect(200);
    expect(responseData<WalletBody>(reversedWallet).availableBalance).toBe(
      '-15.00',
    );
    expect(responseData<WalletBody>(reversedWallet).depositedAmount).toBe(
      '0.00',
    );
    const refundedDeposit = await player.agent
      .get(`/api/player/v1/me/deposits/${paidId}`)
      .expect(200);
    expect(responseData<DepositBody>(refundedDeposit).status).toBe('REFUNDED');
  });

  it('keeps a successful deposit authoritative when older failure and processing events arrive later', async () => {
    const player = await signedInPlayer('event_order');
    const created = await createDeposit(player, '40.00').expect(201);
    const id = responseData<DepositBody>(created).id;
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: `pi_${id}`,
          amount_received: 4000,
          currency: 'usd',
          metadata: { depositId: id },
        },
      },
    }).expect(200);
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: `pi_${id}`,
          metadata: { depositId: id },
          last_payment_error: { code: 'late_event', message: 'Older event' },
        },
      },
    }).expect(200);
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_${id}`,
          payment_intent: `pi_${id}`,
          payment_status: 'unpaid',
          amount_total: 4000,
          currency: 'usd',
          metadata: { depositId: id },
        },
      },
    }).expect(200);

    const deposit = await player.agent
      .get(`/api/player/v1/me/deposits/${id}`)
      .expect(200);
    expect(responseData<DepositBody>(deposit).status).toBe('SUCCEEDED');
    const wallet = await player.agent
      .get('/api/player/v1/me/wallet')
      .expect(200);
    expect(responseData<WalletBody>(wallet).availableBalance).toBe('40.00');
    await expect(
      testPrisma.transaction.count({
        where: { userId: player.user.id, type: TransactionType.DEPOSIT },
      }),
    ).resolves.toBe(1);
  });

  it('reverses disputed funds once and restores them when the dispute is won', async () => {
    const player = await signedInPlayer('dispute');
    const created = await createDeposit(player, '35.00').expect(201);
    const id = responseData<DepositBody>(created).id;
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: `pi_${id}`,
          amount_received: 3500,
          currency: 'usd',
          metadata: { depositId: id },
        },
      },
    }).expect(200);
    const disputedEvent: StripeWebhookEvent = {
      id: `evt_${randomUUID()}`,
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_created',
          payment_intent: `pi_${id}`,
          amount: 3500,
        },
      },
    };
    await webhook(disputedEvent).expect(200);
    await webhook(disputedEvent).expect(200);

    const disputed = await player.agent
      .get(`/api/player/v1/me/deposits/${id}`)
      .expect(200);
    expect(responseData<DepositBody>(disputed).status).toBe('DISPUTED');
    let wallet = await player.agent.get('/api/player/v1/me/wallet').expect(200);
    expect(responseData<WalletBody>(wallet).availableBalance).toBe('0.00');

    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'charge.dispute.closed',
      data: {
        object: {
          id: 'dp_created',
          payment_intent: `pi_${id}`,
          status: 'won',
        },
      },
    }).expect(200);
    const restored = await player.agent
      .get(`/api/player/v1/me/deposits/${id}`)
      .expect(200);
    expect(responseData<DepositBody>(restored).status).toBe('SUCCEEDED');
    wallet = await player.agent.get('/api/player/v1/me/wallet').expect(200);
    expect(responseData<WalletBody>(wallet).availableBalance).toBe('35.00');
  });

  it('rejects settlement when Stripe amount or currency does not match the deposit', async () => {
    const player = await signedInPlayer('mismatch');
    const created = await createDeposit(player, '25.00').expect(201);
    const id = responseData<DepositBody>(created).id;
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: `pi_${id}`,
          amount_received: 2400,
          currency: 'usd',
          metadata: { depositId: id },
        },
      },
    }).expect(422);

    const deposit = await player.agent
      .get(`/api/player/v1/me/deposits/${id}`)
      .expect(200);
    expect(responseData<DepositBody>(deposit).status).toBe('CHECKOUT_CREATED');
    const wallet = await player.agent
      .get('/api/player/v1/me/wallet')
      .expect(200);
    expect(responseData<WalletBody>(wallet).availableBalance).toBe('0.00');
  });
});
