import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ItemStatus, TransactionType } from '@prisma/client';
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

describe('Player merchandise API (integration)', () => {
  let app: INestApplication;
  const email = new CapturingEmailService();
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: PlayerEmailService, useValue: email }],
    });
  });
  afterAll(async () => app?.close());

  async function player(label: string, opening = '500.00') {
    const agent = request.agent(server());
    const address = `merch-${label}-${randomUUID().slice(0, 8)}@example.com`;
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: `m_${label.replace(/[^a-z0-9]/gi, '')}_${randomUUID().slice(0, 8)}`,
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
      reference: `merch-opening:${user.id}`,
    });
    return { agent, user, csrf: cookieValue(login, 'bjs_player_csrf') };
  }

  async function product(stock = 2) {
    const admin = await testPrisma.admin.findFirstOrThrow();
    const merchandise = await testPrisma.merchandise.create({
      data: {
        name: `Team Jersey ${randomUUID().slice(0, 6)}`,
        description: 'Breathable club jersey',
        price: '39.95',
        tokenCost: '200.00',
        status: ItemStatus.ACTIVE,
        createdByAdminId: admin.id,
      },
    });
    const variant = await testPrisma.merchandiseVariant.create({
      data: {
        merchandiseId: merchandise.id,
        size: 'M',
        color: 'Black',
        sku: `MERCH-${randomUUID()}`,
        stock,
      },
    });
    return { merchandise, variant };
  }

  const address = {
    shippingName: 'John Doe',
    addressLine1: '123 Main St',
    addressLine2: 'Apt 4B',
    city: 'New York',
    state: 'NY',
    postalCode: '10001',
    country: 'United States',
  };

  function claim(
    owner: Awaited<ReturnType<typeof player>>,
    merchandiseId: string,
    variantId: string,
    requestId = randomUUID(),
    override: Record<string, unknown> = {},
  ) {
    return owner.agent
      .post('/api/player/v1/me/shipments')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .send({ merchandiseId, variantId, requestId, ...address, ...override });
  }

  async function adminToken() {
    const login = await request(server())
      .post('/api/auth/login')
      .send(SEEDED_ADMIN)
      .expect(200);
    return data<{ accessToken: string }>(login).accessToken;
  }

  it('is idempotent, snapshots the address, and cancels with one refund/restock', async () => {
    const owner = await player('retry');
    const item = await product();
    const requestId = randomUUID();
    const first = data<{ id: string }>(
      await claim(
        owner,
        item.merchandise.id,
        item.variant.id,
        requestId,
      ).expect(201),
    );
    const retry = data<{ id: string }>(
      await claim(
        owner,
        item.merchandise.id,
        item.variant.id,
        requestId,
      ).expect(201),
    );
    expect(retry.id).toBe(first.id);
    await claim(owner, item.merchandise.id, item.variant.id, requestId, {
      city: 'Boston',
    }).expect(422);

    await testPrisma.user.update({
      where: { id: owner.user.id },
      data: { city: 'Los Angeles', addressLine1: '999 Changed Ave' },
    });
    const owned = data<
      Array<{ address: { city: string; addressLine1: string } }>
    >(await owner.agent.get('/api/player/v1/me/shipments').expect(200));
    expect(owned[0]?.address).toMatchObject({
      city: 'New York',
      addressLine1: '123 Main St',
    });

    await owner.agent
      .post(`/api/player/v1/me/shipments/${first.id}/cancel`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .expect(200);
    await owner.agent
      .post(`/api/player/v1/me/shipments/${first.id}/cancel`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .expect(409);

    const current = await testPrisma.user.findUniqueOrThrow({
      where: { id: owner.user.id },
    });
    const restored = await testPrisma.merchandiseVariant.findUniqueOrThrow({
      where: { id: item.variant.id },
    });
    expect(current.balance.toFixed(2)).toBe('500.00');
    expect(restored.stock).toBe(2);
  });

  it('allows only one player to reserve the last variant', async () => {
    const first = await player('race-a');
    const second = await player('race-b');
    const item = await product(1);
    const responses = await Promise.all([
      claim(first, item.merchandise.id, item.variant.id),
      claim(second, item.merchandise.id, item.variant.id),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      await testPrisma.shipment.count({
        where: { merchandiseId: item.merchandise.id },
      }),
    ).toBe(1);
  });

  it('rejects insufficient funds, wrong-product variants and incomplete addresses', async () => {
    const poor = await player('poor', '10.00');
    const funded = await player('funded');
    const first = await product();
    const second = await product();
    await claim(poor, first.merchandise.id, first.variant.id).expect(422);
    await claim(funded, first.merchandise.id, second.variant.id).expect(422);
    await claim(funded, first.merchandise.id, first.variant.id, randomUUID(), {
      postalCode: '',
    }).expect(400);
  });

  it('shares one shipment with admin progression and rejects terminal rollback', async () => {
    const owner = await player('progress');
    const item = await product();
    const created = data<{ id: string }>(
      await claim(owner, item.merchandise.id, item.variant.id).expect(201),
    );
    const token = await adminToken();
    await request(server())
      .patch(`/api/shipments/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'IN_TRANSIT', carrier: 'UPS', trackingNumber: '1ZTEST' })
      .expect(200);
    await request(server())
      .patch(`/api/shipments/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'DELIVERED' })
      .expect(200);
    await request(server())
      .patch(`/api/shipments/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'PENDING' })
      .expect(409);

    const list = data<Array<{ id: string; address: { line1: string } }>>(
      await request(server())
        .get(`/api/shipments?userId=${owner.user.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200),
    );
    expect(list.find((row) => row.id === created.id)?.address.line1).toBe(
      '123 Main St',
    );
  });
});
