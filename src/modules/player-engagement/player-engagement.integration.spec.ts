import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PlayerMembershipStatus, UserTier } from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp } from '../../../test/create-test-app';
import { testPrisma } from '../../../test/setup';
import { PlayerEmailService } from '../player-auth/services/player-email.service';

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

describe('Player engagement API (integration)', () => {
  let app: INestApplication;
  const emails = new EmailCapture();
  const server = (): Server => app.getHttpServer() as Server;
  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: PlayerEmailService, useValue: emails }],
    });
  });
  afterAll(async () => app?.close());

  async function player(label: string, tier: UserTier = UserTier.PLAYER) {
    const agent = request.agent(server());
    const safeLabel = label.replace(/[^a-z0-9]/gi, '').slice(0, 10);
    const email = `engagement-${label}-${randomUUID().slice(0, 7)}@example.com`;
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: `eng_${safeLabel}_${randomUUID().slice(0, 7)}`,
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
    return { agent, user, email, csrf: cookie(login, 'bjs_player_csrf') };
  }

  it('persists private read state and honors in-app delivery preferences', async () => {
    const owner = await player('notify-owner');
    const stranger = await player('notify-stranger');
    const feed = data<{
      items: Array<{ id: string; unread: boolean }>;
      unreadCount: number;
    }>(await owner.agent.get('/api/player/v1/notifications').expect(200));
    expect(feed.unreadCount).toBe(1);
    expect(feed.items[0]?.unread).toBe(true);
    const paged = data<{
      items: unknown[];
      meta: { page: number; limit: number; total: number };
    }>(
      await owner.agent
        .get('/api/player/v1/notifications?page=1&limit=1')
        .expect(200),
    );
    expect(paged.items).toHaveLength(1);
    expect(paged.meta).toEqual({
      page: 1,
      limit: 1,
      total: 1,
      totalPages: 1,
    });
    await owner.agent
      .get('/api/player/v1/notifications?page=1&limit=51')
      .expect(422);
    await stranger.agent
      .post(`/api/player/v1/notifications/${feed.items[0]!.id}/read`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', stranger.csrf)
      .expect(404);
    const read = data<{ unread: boolean }>(
      await owner.agent
        .post(`/api/player/v1/notifications/${feed.items[0]!.id}/read`)
        .set('Origin', ORIGIN)
        .set('x-csrf-token', owner.csrf)
        .expect(201),
    );
    expect(read.unread).toBe(false);
    await owner.agent
      .patch('/api/player/v1/me/notification-preferences')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .send({ inAppEnabled: false })
      .expect(200);
    expect(
      data<{ items: unknown[] }>(
        await owner.agent.get('/api/player/v1/notifications').expect(200),
      ).items,
    ).toEqual([]);
    await owner.agent
      .patch('/api/player/v1/me/notification-preferences')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .send({ emailEnabled: true })
      .expect(422);
  });

  it('searches approved domains without exposing players or another host private tournament', async () => {
    const owner = await player('search-owner');
    const stranger = await player('search-stranger');
    const marker = `SecretTable${randomUUID().slice(0, 7)}`;
    const privateTournament = await testPrisma.tournament.create({
      data: {
        name: marker,
        maxPlayers: 8,
        startsAt: new Date('2099-01-01T00:00:00Z'),
        visibility: 'PRIVATE',
        createdByPlayerId: owner.user.id,
      },
    });
    const ownerResults = data<Array<{ id: string; type: string }>>(
      await owner.agent.get(`/api/player/v1/search?q=${marker}`).expect(200),
    );
    expect(ownerResults).toContainEqual(
      expect.objectContaining({ id: privateTournament.id, type: 'TOURNAMENT' }),
    );
    const strangerResults = data<Array<{ id: string; type: string }>>(
      await stranger.agent.get(`/api/player/v1/search?q=${marker}`).expect(200),
    );
    expect(strangerResults).toEqual([]);
    expect(ownerResults.some((row) => row.type === 'USER')).toBe(false);
  });

  it('captures consented leads idempotently without granting a paid tier', async () => {
    const owner = await player('lead');
    await owner.agent
      .post('/api/player/v1/sales-funnel/leads')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', owner.csrf)
      .send({ email: owner.email, consent: false })
      .expect(400);
    for (let index = 0; index < 2; index += 1) {
      await owner.agent
        .post('/api/player/v1/sales-funnel/leads')
        .set('Origin', ORIGIN)
        .set('x-csrf-token', owner.csrf)
        .send({ email: owner.email.toUpperCase(), consent: true })
        .expect(201);
    }
    expect(
      await testPrisma.earlyAccessLead.count({
        where: { userId: owner.user.id },
      }),
    ).toBe(1);
    const membership = data<{ status: string; tier: string }>(
      await owner.agent.get('/api/player/v1/me/membership').expect(200),
    );
    expect(membership).toEqual(
      expect.objectContaining({ status: 'WAITLISTED', tier: 'PLAYER' }),
    );
    expect(
      (
        await testPrisma.user.findUniqueOrThrow({
          where: { id: owner.user.id },
        })
      ).tier,
    ).toBe(UserTier.PLAYER);
    expect(
      await testPrisma.playerNotification.count({
        where: { userId: owner.user.id, eventKey: 'early-access:joined' },
      }),
    ).toBe(1);
  });

  it('reflects server-owned premium access and revokes it on cancellation', async () => {
    const vip = await player('vip', UserTier.VIP);
    const active = data<{ status: string; tier: string; canCancel: boolean }>(
      await vip.agent.get('/api/player/v1/me/membership').expect(200),
    );
    expect(active).toEqual(
      expect.objectContaining({
        status: 'ACTIVE',
        tier: 'VIP',
        canCancel: true,
      }),
    );
    const cancelled = data<{ status: string; tier: string }>(
      await vip.agent
        .post('/api/player/v1/me/membership/cancel')
        .set('Origin', ORIGIN)
        .set('x-csrf-token', vip.csrf)
        .expect(201),
    );
    expect(cancelled).toEqual(
      expect.objectContaining({
        status: PlayerMembershipStatus.CANCELLED,
        tier: 'PLAYER',
      }),
    );
    expect(
      (await testPrisma.user.findUniqueOrThrow({ where: { id: vip.user.id } }))
        .tier,
    ).toBe(UserTier.PLAYER);
  });
});
