import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  PayoutMethod,
  StripeAccountStatus,
  TransactionType,
  VerificationCheckState,
} from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { PlayerEmailService } from '../../player-auth/services/player-email.service';
import { STRIPE_GATEWAY } from '../../stripe/stripe.interface';
import type {
  CreateAccountLinkParams,
  CreateConnectAccountParams,
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
  transfers: CreateTransferParams[] = [];
  event: StripeWebhookEvent | null = null;
  isConfigured() {
    return true;
  }
  createTransfer(params: CreateTransferParams) {
    this.transfers.push(params);
    return Promise.resolve({
      id: `tr_withdrawal_${this.transfers.length}`,
      amount: Math.round(Number(params.amount) * 100),
      currency: params.currency,
      destination: params.destination,
    });
  }
  createConnectAccount(_params: CreateConnectAccountParams) {
    return Promise.resolve({
      id: 'acct_new',
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
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
      url: 'https://connect.stripe.test/onboard',
      expiresAt: 2_000_000_000,
    });
  }
  createCustomer() {
    return Promise.resolve({ id: 'cus_test' });
  }
  createCheckoutSession() {
    return Promise.resolve({
      id: 'cs_test',
      url: 'https://checkout.test',
      paymentIntentId: null,
    });
  }
  expireCheckoutSession() {
    return Promise.resolve();
  }
  retrievePaymentMethodForIntent() {
    return Promise.resolve(null);
  }
  constructWebhookEvent() {
    if (!this.event) throw new Error('Missing fake event');
    return this.event;
  }
}

function cookieValue(response: request.Response, name: string): string {
  const header = (
    response.headers as Record<string, string[] | string | undefined>
  )['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const value = values.find((entry) => entry.startsWith(`${name}=`));
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value.split(';')[0]!.slice(name.length + 1);
}

function data<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

describe('Player withdrawals API (integration)', () => {
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
    stripe.transfers = [];
    stripe.event = null;
  });

  async function eligiblePlayer(suffix: string, opening = '500.00') {
    const id = `${suffix}-${randomUUID().slice(0, 8)}`;
    const agent = request.agent(server());
    const address = `withdraw-${id}@example.com`;
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: `w_${id.replace(/-/g, '').slice(0, 20)}`,
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
    const user = await testPrisma.user.findUniqueOrThrow({
      where: { email: address },
    });
    const accountId = `acct_${id}`;
    await testPrisma.user.update({
      where: { id: user.id },
      data: {
        stripeConnectAccountId: accountId,
        stripeAccountStatus: StripeAccountStatus.VERIFIED,
      },
    });
    await testPrisma.playerVerification.create({
      data: {
        userId: user.id,
        kycCheck: VerificationCheckState.PASSED,
        ageCheck: VerificationCheckState.PASSED,
        countryCheck: VerificationCheckState.PASSED,
        taxCheck: VerificationCheckState.PASSED,
        fraudCheck: VerificationCheckState.PASSED,
      },
    });
    const destination = await testPrisma.payoutMethodAccount.create({
      data: {
        userId: user.id,
        method: PayoutMethod.STRIPE_CONNECT,
        label: 'Stripe Connect',
        reference: accountId,
        isVerified: true,
        isDefault: true,
      },
    });
    await app.get(TransactionsService).record({
      userId: user.id,
      type: TransactionType.ADJUSTMENT,
      amount: opening,
      reference: `withdrawal-test-opening:${user.id}`,
    });
    return {
      agent,
      csrf: cookieValue(login, 'bjs_player_csrf'),
      user,
      destination,
    };
  }

  function createWithdrawal(
    player: Awaited<ReturnType<typeof eligiblePlayer>>,
    amount = '100.00',
    requestId = randomUUID(),
  ) {
    return player.agent
      .post('/api/player/v1/me/withdrawals')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .send({ amount, destinationId: player.destination.id, requestId });
  }

  async function adminToken() {
    const login = await request(server())
      .post('/api/auth/login')
      .send(SEEDED_ADMIN)
      .expect(200);
    return data<{ accessToken: string }>(login).accessToken;
  }

  it('reserves once for an idempotent request and exposes pending wallet state', async () => {
    const player = await eligiblePlayer('retry');
    const requestId = randomUUID();
    const first = await createWithdrawal(player, '125.25', requestId).expect(
      201,
    );
    const second = await createWithdrawal(player, '125.25', requestId).expect(
      201,
    );
    expect(data<{ id: string }>(second).id).toBe(
      data<{ id: string }>(first).id,
    );
    await createWithdrawal(player, '126.00', requestId).expect(422);

    const wallet = data<{ availableBalance: string; pendingBalance: string }>(
      await player.agent.get('/api/player/v1/me/wallet').expect(200),
    );
    expect(wallet).toMatchObject({
      availableBalance: '374.75',
      pendingBalance: '125.25',
    });
    expect(
      await testPrisma.withdrawalRequest.count({
        where: { userId: player.user.id },
      }),
    ).toBe(1);
    expect(
      await testPrisma.payout.count({ where: { userId: player.user.id } }),
    ).toBe(1);
  });

  it('allows only one of two parallel reservations that exceed the balance together', async () => {
    const player = await eligiblePlayer('race');
    const responses = await Promise.all([
      createWithdrawal(player, '400.00'),
      createWithdrawal(player, '400.00'),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 422,
    ]);
    const current = await testPrisma.user.findUniqueOrThrow({
      where: { id: player.user.id },
    });
    expect(current.balance.toFixed(2)).toBe('100.00');
  });

  it('releases a player-cancelled reservation exactly once', async () => {
    const player = await eligiblePlayer('cancel');
    const created = data<{ id: string }>(
      await createWithdrawal(player).expect(201),
    );
    await player.agent
      .post(`/api/player/v1/me/withdrawals/${created.id}/cancel`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(200);
    await player.agent
      .post(`/api/player/v1/me/withdrawals/${created.id}/cancel`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(422);
    const current = await testPrisma.user.findUniqueOrThrow({
      where: { id: player.user.id },
    });
    expect(current.balance.toFixed(2)).toBe('500.00');
    expect(
      await testPrisma.transaction.count({ where: { userId: player.user.id } }),
    ).toBe(3);
  });

  it('uses the destination snapshot through admin approval and provider settlement without a second debit', async () => {
    const player = await eligiblePlayer('settle');
    const created = data<{ payoutId: string }>(
      await createWithdrawal(player).expect(201),
    );
    const token = await adminToken();
    await request(server())
      .post(`/api/payouts/${created.payoutId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await testPrisma.user.update({
      where: { id: player.user.id },
      data: {
        stripeConnectAccountId: `acct_changed_${randomUUID().slice(0, 8)}`,
      },
    });
    const processed = data<{ stripeTransferId: string }>(
      await request(server())
        .post(`/api/payouts/${created.payoutId}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200),
    );
    expect(stripe.transfers).toHaveLength(1);
    expect(stripe.transfers[0]?.destination).toBe(player.destination.reference);
    expect(
      (
        await testPrisma.user.findUniqueOrThrow({
          where: { id: player.user.id },
        })
      ).balance.toFixed(2),
    ).toBe('400.00');

    stripe.event = {
      id: `evt_${randomUUID()}`,
      type: 'transfer.paid',
      data: { object: { id: processed.stripeTransferId } },
    };
    await request(server())
      .post('/api/payouts/stripe/webhook')
      .set('stripe-signature', 'valid')
      .send({})
      .expect(200);
    const view = data<Array<{ status: string }>>(
      await player.agent.get('/api/player/v1/me/withdrawals').expect(200),
    );
    expect(view[0]?.status).toBe('SETTLED');
  });

  it('releases once when admin declines and reports the review reason to the owner', async () => {
    const player = await eligiblePlayer('decline');
    const created = data<{ payoutId: string }>(
      await createWithdrawal(player).expect(201),
    );
    const token = await adminToken();
    await request(server())
      .post(`/api/payouts/${created.payoutId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Destination ownership needs review' })
      .expect(200);
    const list = data<Array<{ status: string; reviewReason: string }>>(
      await player.agent.get('/api/player/v1/me/withdrawals').expect(200),
    );
    expect(list[0]).toMatchObject({
      status: 'DECLINED',
      reviewReason: 'Destination ownership needs review',
    });
    expect(
      (
        await testPrisma.user.findUniqueOrThrow({
          where: { id: player.user.id },
        })
      ).balance.toFixed(2),
    ).toBe('500.00');
  });

  it('releases after a provider failure and ignores a later reordered paid event', async () => {
    const player = await eligiblePlayer('failure');
    const created = data<{ payoutId: string }>(
      await createWithdrawal(player).expect(201),
    );
    const token = await adminToken();
    await request(server())
      .post(`/api/payouts/${created.payoutId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const processed = data<{ stripeTransferId: string }>(
      await request(server())
        .post(`/api/payouts/${created.payoutId}/process`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200),
    );

    const failedEvent = `evt_${randomUUID()}`;
    stripe.event = {
      id: failedEvent,
      type: 'transfer.failed',
      data: {
        object: {
          id: processed.stripeTransferId,
          failure_message: 'Destination rejected the transfer',
        },
      },
    };
    await request(server())
      .post('/api/payouts/stripe/webhook')
      .set('stripe-signature', 'valid')
      .send({})
      .expect(200);
    await request(server())
      .post('/api/payouts/stripe/webhook')
      .set('stripe-signature', 'valid')
      .send({})
      .expect(200);

    stripe.event = {
      id: `evt_${randomUUID()}`,
      type: 'transfer.paid',
      data: { object: { id: processed.stripeTransferId } },
    };
    await request(server())
      .post('/api/payouts/stripe/webhook')
      .set('stripe-signature', 'valid')
      .send({})
      .expect(200);

    const payout = await testPrisma.payout.findUniqueOrThrow({
      where: { id: created.payoutId },
    });
    expect(payout.status).toBe('FAILED');
    expect(payout.settledAt).toBeNull();
    expect(
      (
        await testPrisma.user.findUniqueOrThrow({
          where: { id: player.user.id },
        })
      ).balance.toFixed(2),
    ).toBe('500.00');
    expect(
      await testPrisma.transaction.count({
        where: { payoutId: created.payoutId, type: TransactionType.REFUND },
      }),
    ).toBe(1);
  });

  it('rejects another player destination and holds requests with an open dispute', async () => {
    const player = await eligiblePlayer('owner');
    const other = await eligiblePlayer('other');
    await player.agent
      .post('/api/player/v1/me/withdrawals')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .send({
        amount: '100.00',
        destinationId: other.destination.id,
        requestId: randomUUID(),
      })
      .expect(422);
    await testPrisma.dispute.create({
      data: {
        caseNumber: `DSP-${randomUUID()}`,
        userId: player.user.id,
        reason: 'Test hold',
      },
    });
    await createWithdrawal(player).expect(422);
  });
});
