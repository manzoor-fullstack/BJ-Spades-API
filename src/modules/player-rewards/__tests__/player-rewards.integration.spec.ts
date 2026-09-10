import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ItemStatus, RewardCategory, TransactionType } from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { PlayerEmailService } from '../../player-auth/services/player-email.service';
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

describe('Player rewards API (integration)', () => {
  let app: INestApplication;
  const email = new CapturingEmailService();
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    process.env.REWARD_CODE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString(
      'base64',
    );
    app = await createTestApp({
      overrides: [{ provide: PlayerEmailService, useValue: email }],
    });
  });
  afterAll(async () => app?.close());

  async function player(label: string, opening = '100.00') {
    const agent = request.agent(server());
    const address = `reward-${label}-${randomUUID().slice(0, 8)}@example.com`;
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: `r_${label.replace(/[^a-z0-9]/gi, '')}_${randomUUID().slice(0, 8)}`,
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
    await app.get(TransactionsService).record({
      userId: user.id,
      type: TransactionType.ADJUSTMENT,
      amount: opening,
      reference: `reward-opening:${user.id}`,
    });
    return {
      agent,
      user,
      csrf: cookieValue(login, 'bjs_player_csrf'),
    };
  }

  async function reward(
    stock: number | null = 2,
    overrides: Partial<{
      denomination: string;
      tokenCost: string;
      availableUntil: Date;
      status: ItemStatus;
    }> = {},
  ) {
    const admin = await testPrisma.admin.findFirstOrThrow();
    return testPrisma.reward.create({
      data: {
        name: 'Coffee card',
        company: 'Starbucks',
        category: RewardCategory.FOOD,
        value: '$10',
        denomination: '10.00',
        tokenCost: '10.00',
        bonusPercent: 8,
        stock,
        status: ItemStatus.ACTIVE,
        createdByAdminId: admin.id,
        ...overrides,
      },
    });
  }

  function purchase(
    owner: Awaited<ReturnType<typeof player>>,
    rewardId: string,
    requestId = randomUUID(),
    denomination = '10.00',
  ) {
    return owner.agent
      .post('/api/player/v1/me/redemptions')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .send({ rewardId, denomination, requestId });
  }

  async function adminToken() {
    const login = await request(server())
      .post('/api/auth/login')
      .send(SEEDED_ADMIN)
      .expect(200);
    return data<{ accessToken: string }>(login).accessToken;
  }

  it('purchases once, rejects a changed retry, and cancels with one refund', async () => {
    const owner = await player('retry');
    const item = await reward();
    const requestId = randomUUID();
    const first = data<{ id: string }>(
      await purchase(owner, item.id, requestId).expect(201),
    );
    const retry = data<{ id: string }>(
      await purchase(owner, item.id, requestId).expect(201),
    );
    expect(retry.id).toBe(first.id);
    await purchase(owner, item.id, requestId, '20.00').expect(422);
    await owner.agent
      .post(`/api/player/v1/me/redemptions/${first.id}/cancel`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .expect(200);
    await owner.agent
      .post(`/api/player/v1/me/redemptions/${first.id}/cancel`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .expect(409);

    const current = await testPrisma.user.findUniqueOrThrow({
      where: { id: owner.user.id },
    });
    const restored = await testPrisma.reward.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(current.balance.toFixed(2)).toBe('100.00');
    expect(restored.stock).toBe(2);
    expect(
      await testPrisma.transaction.count({ where: { userId: owner.user.id } }),
    ).toBe(3);
  });

  it('allows only one player to reserve the last item', async () => {
    const first = await player('race-a');
    const second = await player('race-b');
    const item = await reward(1);
    const responses = await Promise.all([
      purchase(first, item.id),
      purchase(second, item.id),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      await testPrisma.rewardRedemption.count({ where: { rewardId: item.id } }),
    ).toBe(1);
  });

  it('rejects insufficient funds, invalid denominations, and expired catalogue rows', async () => {
    const poor = await player('poor', '5.00');
    const funded = await player('funded');
    const item = await reward();
    await purchase(poor, item.id).expect(422);
    await purchase(funded, item.id, randomUUID(), '20.00').expect(422);

    const expired = await reward(3, {
      availableUntil: new Date('2020-01-01T00:00:00.000Z'),
    });
    await purchase(funded, expired.id).expect(409);
    const catalog = data<Array<{ id: string }>>(
      await funded.agent.get('/api/player/v1/rewards').expect(200),
    );
    expect(catalog.map((entry) => entry.id)).toContain(item.id);
    expect(catalog.map((entry) => entry.id)).not.toContain(expired.id);
  });

  it('keeps the bearer code private except in the owning detail response', async () => {
    const owner = await player('owner');
    const stranger = await player('stranger');
    const item = await reward();
    const created = data<{ id: string }>(
      await purchase(owner, item.id).expect(201),
    );
    const token = await adminToken();
    const fulfilled = data<{ code: string | null }>(
      await request(server())
        .post(`/api/rewards/redemptions/${created.id}/fulfill`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: 'REAL-PRIVATE-CODE',
          supplierReference: `manual-${created.id}`,
          expiresAt: '2027-01-01T00:00:00.000Z',
        })
        .expect(201),
    );
    expect(fulfilled.code).toBeNull();
    await request(server())
      .post(`/api/rewards/redemptions/${created.id}/fulfill`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'REAL-PRIVATE-CODE',
        supplierReference: `manual-${created.id}`,
        expiresAt: '2027-01-01T00:00:00.000Z',
      })
      .expect(201);
    await request(server())
      .post(`/api/rewards/redemptions/${created.id}/fulfill`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'DIFFERENT-CODE',
        supplierReference: `manual-${created.id}`,
      })
      .expect(409);
    const list = data<Array<{ code: string | null }>>(
      await owner.agent.get('/api/player/v1/me/redemptions').expect(200),
    );
    expect(list[0]?.code).toBeNull();
    const detail = data<{ code: string }>(
      await owner.agent
        .get(`/api/player/v1/me/redemptions/${created.id}`)
        .expect(200),
    );
    expect(detail.code).toBe('REAL-PRIVATE-CODE');
    await stranger.agent
      .get(`/api/player/v1/me/redemptions/${created.id}`)
      .expect(404);

    const stored = await testPrisma.rewardDelivery.findUniqueOrThrow({
      where: { redemptionId: created.id },
    });
    expect(stored.encryptedCode).not.toContain('REAL-PRIVATE-CODE');
  });
});
