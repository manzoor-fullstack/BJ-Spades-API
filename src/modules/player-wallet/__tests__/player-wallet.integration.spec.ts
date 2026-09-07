import type { INestApplication } from '@nestjs/common';
import { TransactionStatus, TransactionType } from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { TransactionsService } from '../../transactions/transactions.service';
import { PlayerEmailService } from '../../player-auth/services/player-email.service';

const ORIGIN = 'http://127.0.0.1:4173';

class CapturingEmailService {
  tokens = new Map<string, string>();

  verification(email: string, token: string): Promise<void> {
    this.tokens.set(email, token);
    return Promise.resolve();
  }

  passwordReset(): Promise<void> {
    return Promise.resolve();
  }
}

describe('Player wallet API (integration)', () => {
  let app: INestApplication;
  const email = new CapturingEmailService();

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: PlayerEmailService, useValue: email }],
    });
  });

  afterAll(async () => app?.close());

  const server = (): Server => app.getHttpServer() as Server;

  async function signedInPlayer(username: string, address: string) {
    const agent = request.agent(server());
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({ username, email: address, password: 'StrongPass123' })
      .expect(202);
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token: email.tokens.get(address) })
      .expect(200);
    await agent
      .post('/api/player/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: address, password: 'StrongPass123', rememberMe: false })
      .expect(200);
    return {
      agent,
      user: await testPrisma.user.findUniqueOrThrow({
        where: { email: address },
      }),
    };
  }

  it('returns only the signed-in player ledger with exact wallet formulas', async () => {
    const first = await signedInPlayer('wallet_one', 'wallet-one@example.com');
    const second = await signedInPlayer('wallet_two', 'wallet-two@example.com');
    const ledger = app.get(TransactionsService);

    await ledger.recordMany([
      {
        userId: first.user.id,
        type: TransactionType.DEPOSIT,
        amount: '100.50',
        description: 'Card deposit',
      },
      {
        userId: first.user.id,
        type: TransactionType.ENTRY_FEE,
        amount: '-25.25',
        description: 'Tournament entry',
      },
      {
        userId: first.user.id,
        type: TransactionType.PRIZE,
        amount: '40.00',
        description: 'First place',
      },
      {
        userId: first.user.id,
        type: TransactionType.REFUND,
        amount: '5.25',
        description: 'Entry refund',
      },
      {
        userId: first.user.id,
        type: TransactionType.WITHDRAWAL,
        status: TransactionStatus.PENDING,
        amount: '-10.00',
        description: 'Pending withdrawal',
      },
      {
        userId: second.user.id,
        type: TransactionType.DEPOSIT,
        amount: '999.00',
        description: 'Other player',
      },
    ]);

    const wallet = await first.agent
      .get('/api/player/v1/me/wallet')
      .expect(200);
    const walletBody = wallet.body as { data: Record<string, unknown> };
    expect(walletBody.data).toEqual({
      currency: 'USD',
      unit: 'TOKEN',
      tokenToUsdRate: '1.00',
      availableBalance: '110.50',
      pendingBalance: '10.00',
      depositedAmount: '100.50',
      lifetimeDeposits: '100.50',
      totalWinnings: '40.00',
      totalLosses: '25.25',
      tournamentEntries: '25.25',
      netProfit: '20.00',
      weeklyChange: '120.50',
    });

    const page = await first.agent
      .get('/api/player/v1/me/transactions?page=1&limit=3')
      .expect(200);
    const pageBody = page.body as {
      data: {
        items: Array<{ id: string; description: string }>;
        meta: Record<string, unknown>;
      };
    };
    expect(pageBody.data.items).toHaveLength(3);
    expect(pageBody.data.meta).toMatchObject({
      total: 5,
      page: 1,
      limit: 3,
      totalPages: 2,
    });
    expect(
      pageBody.data.items.every(
        (row: { description: string }) => row.description !== 'Other player',
      ),
    ).toBe(true);
    expect(pageBody.data.items[0]).not.toHaveProperty('userId');
    expect(pageBody.data.items[0]).not.toHaveProperty('reference');

    const ownId = pageBody.data.items[0]!.id;
    await first.agent
      .get(`/api/player/v1/me/transactions/${ownId}`)
      .expect(200);
    const otherTransaction = await testPrisma.transaction.findFirstOrThrow({
      where: { userId: second.user.id },
    });
    await first.agent
      .get(`/api/player/v1/me/transactions/${otherTransaction.id}`)
      .expect(404);
  });

  it('requires a player session and rejects invalid pagination', async () => {
    await request(server()).get('/api/player/v1/me/wallet').expect(401);
    const player = await signedInPlayer(
      'wallet_three',
      'wallet-three@example.com',
    );
    await player.agent
      .get('/api/player/v1/me/transactions?page=0&limit=101')
      .expect(400);
  });
});
