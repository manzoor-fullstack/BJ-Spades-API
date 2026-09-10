import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  AnimationCategory,
  AnimationEntitlementSource,
  ItemStatus,
  TransactionType,
  UserTier,
} from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp } from '../../../test/create-test-app';
import { testPrisma } from '../../../test/setup';
import { PlayerEmailService } from '../player-auth/services/player-email.service';
import { TransactionsService } from '../transactions/transactions.service';

const ORIGIN = 'http://127.0.0.1:4173';

class EmailCapture {
  tokens = new Map<string, string>();
  verification(email: string, token: string) {
    this.tokens.set(email, token);
    return Promise.resolve();
  }
  passwordReset() {
    return Promise.resolve();
  }
}

function cookie(response: request.Response, name: string) {
  const raw = (
    response.headers as Record<string, string[] | string | undefined>
  )['set-cookie'];
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const value = rows.find((row) => row.startsWith(`${name}=`));
  if (!value) throw new Error(`Missing ${name}`);
  return value.split(';')[0]!.slice(name.length + 1);
}

function data<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

describe('Player animations API (integration)', () => {
  let app: INestApplication;
  const emails = new EmailCapture();
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: PlayerEmailService, useValue: emails }],
    });
  });
  afterAll(async () => app?.close());

  async function player(
    label: string,
    balance = '500.00',
    tier: UserTier = UserTier.PLAYER,
  ) {
    const agent = request.agent(server());
    const email = `animation-${label}-${randomUUID().slice(0, 7)}@example.com`;
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: `anim_${label}_${randomUUID().slice(0, 7)}`,
        email,
        password: 'StrongPass123',
      })
      .expect(202);
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token: emails.tokens.get(email) })
      .expect(200);
    const login = await agent
      .post('/api/player/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: 'StrongPass123', rememberMe: false })
      .expect(200);
    const user = await testPrisma.user.findUniqueOrThrow({ where: { email } });
    await testPrisma.user.update({ where: { id: user.id }, data: { tier } });
    await app.get(TransactionsService).record({
      userId: user.id,
      type: TransactionType.ADJUSTMENT,
      amount: balance,
      reference: `animation-opening:${user.id}`,
    });
    return { agent, user, csrf: cookie(login, 'bjs_player_csrf') };
  }

  async function animation(
    overrides: Partial<{
      price: string;
      vipOnly: boolean;
      category: AnimationCategory;
    }> = {},
  ) {
    return testPrisma.animation.create({
      data: {
        name: `Crown ${randomUUID().slice(0, 5)}`,
        description: 'Real crown burst',
        category: AnimationCategory.WIN_VICTORY,
        price: '120.00',
        assetUrl: '/animations/crown-spade-burst.png',
        effectKey: 'crown-burst',
        status: ItemStatus.ACTIVE,
        ...overrides,
      },
    });
  }

  function purchase(
    owner: Awaited<ReturnType<typeof player>>,
    id: string,
    requestId = randomUUID(),
  ) {
    return owner.agent
      .post(`/api/player/v1/me/animations/${id}/purchase`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .send({ requestId });
  }

  it('purchases once, survives reload and equips only an owned animation', async () => {
    const owner = await player('owner');
    const item = await animation();
    const requestId = randomUUID();
    await purchase(owner, item.id, requestId).expect(201);
    await purchase(owner, item.id, requestId).expect(201);
    await purchase(owner, item.id).expect(409);
    await owner.agent
      .post(`/api/player/v1/me/animations/${item.id}/equip`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .expect(201);
    const owned = data<
      Array<{ id: string; equipped: boolean; assetUrl: string }>
    >(await owner.agent.get('/api/player/v1/me/animations').expect(200));
    expect(owned).toContainEqual(
      expect.objectContaining({
        id: item.id,
        equipped: true,
        assetUrl: '/animations/crown-spade-burst.png',
      }),
    );
    const balance = await testPrisma.user.findUniqueOrThrow({
      where: { id: owner.user.id },
    });
    expect(balance.balance.toFixed(2)).toBe('380.00');

    const stranger = await player('stranger');
    await stranger.agent
      .post(`/api/player/v1/me/animations/${item.id}/equip`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', stranger.csrf)
      .expect(409);
  });

  it('rolls back the losing concurrent duplicate purchase', async () => {
    const owner = await player('race');
    const item = await animation();
    const results = await Promise.all([
      purchase(owner, item.id),
      purchase(owner, item.id),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(
      await testPrisma.playerAnimationEntitlement.count({
        where: { userId: owner.user.id, animationId: item.id },
      }),
    ).toBe(1);
    const current = await testPrisma.user.findUniqueOrThrow({
      where: { id: owner.user.id },
    });
    expect(current.balance.toFixed(2)).toBe('380.00');
  });

  it('rejects insufficient funds and expired or revoked entitlement equips', async () => {
    const poor = await player('poor', '10.00');
    const item = await animation();
    await purchase(poor, item.id).expect(422);
    await testPrisma.playerAnimationEntitlement.create({
      data: {
        userId: poor.user.id,
        animationId: item.id,
        source: AnimationEntitlementSource.ACHIEVEMENT,
        expiresAt: new Date('2020-01-01T00:00:00Z'),
      },
    });
    await poor.agent
      .post(`/api/player/v1/me/animations/${item.id}/equip`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', poor.csrf)
      .expect(409);
  });

  it('grants VIP effects durably and revokes them after tier loss', async () => {
    const item = await animation({
      vipOnly: true,
      category: AnimationCategory.STREAK,
    });
    const vip = await player('vip', '0.00', UserTier.VIP);
    const catalog = data<Array<{ id: string; owned: boolean; source: string }>>(
      await vip.agent.get('/api/player/v1/animations').expect(200),
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({ id: item.id, owned: true, source: 'VIP' }),
    );
    await testPrisma.user.update({
      where: { id: vip.user.id },
      data: { tier: UserTier.PLAYER },
    });
    const after = data<Array<{ id: string; owned: boolean }>>(
      await vip.agent.get('/api/player/v1/animations').expect(200),
    );
    expect(after.find((row) => row.id === item.id)?.owned).toBe(false);
  });
});
