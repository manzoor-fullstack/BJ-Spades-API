import type { INestApplication } from '@nestjs/common';
import { GameMatchStatus, UserSource, UserStatus } from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
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

describe('Player leaderboards API (integration)', () => {
  let app: INestApplication;
  const emailService = new CapturingEmailService();
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: PlayerEmailService, useValue: emailService }],
    });
  });
  afterAll(async () => app?.close());

  async function signedInPlayer() {
    const email = 'f11-viewer@example.com';
    const password = 'StrongPass123';
    const agent = request.agent(server());
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({ username: 'f11_viewer', email, password })
      .expect(202);
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token: emailService.tokens.get(email) })
      .expect(200);
    await agent
      .post('/api/player/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password, rememberMe: false })
      .expect(200);
    const user = await testPrisma.user.findUniqueOrThrow({ where: { email } });
    await testPrisma.user.update({
      where: { id: user.id },
      data: { country: 'PK' },
    });
    return { agent, user };
  }

  async function createPlayer(
    index: number,
    status: UserStatus = UserStatus.ACTIVE,
    visible = true,
  ) {
    return testPrisma.user.create({
      data: {
        firstName: `Ranked${index}`,
        lastName: 'Player',
        email: `f11-ranked-${index}@example.com`,
        source: UserSource.PLAYER,
        status,
        country: 'PK',
        emailVerified: true,
        playerProfile: {
          create: {
            displayName: `Ranked ${index}`,
            leaderboardVisible: visible,
          },
        },
      },
    });
  }

  async function createMatch(
    index: number,
    viewerId: string,
    opponentId: string,
    winnerTeam = 1,
  ) {
    return testPrisma.gameMatch.create({
      data: {
        status: GameMatchStatus.COMPLETED,
        rulesVersion: 'spades-partnership-v1',
        creationRequestId: `f11-match-${index}`,
        createdByPlayerId: viewerId,
        state: { phase: 'COMPLETED', winnerTeam },
        dealerSeat: 0,
        winnerTeam,
        completedAt: new Date(Date.now() - index * 1000),
        seats: {
          create: [
            { userId: viewerId, seat: 0, team: 0 },
            { userId: opponentId, seat: 1, team: 1 },
          ],
        },
      },
    });
  }

  it('requires authentication and rejects invalid periods', async () => {
    await request(server()).get('/api/player/v1/leaderboards').expect(401);
    const { agent } = await signedInPlayer();
    await agent.get('/api/player/v1/leaderboards?period=year').expect(400);
    await agent
      .post('/api/player/v1/leaderboards')
      .set('Origin', ORIGIN)
      .send({ rating: 9999 })
      .expect(404);
  });

  it('returns safe stable pages, excludes private/suspended players and invalidates after correction', async () => {
    const { user: viewer, agent } = await signedInPlayer();

    const opponents = await Promise.all(
      Array.from({ length: 11 }, (_, index) => createPlayer(index + 1)),
    );
    const matches = [];
    for (const [index, opponent] of opponents.entries()) {
      matches.push(await createMatch(index + 1, viewer.id, opponent.id));
    }
    const hidden = await createPlayer(20, UserStatus.ACTIVE, false);
    const suspended = await createPlayer(21, UserStatus.SUSPENDED, true);
    await createMatch(20, viewer.id, hidden.id);
    await createMatch(21, viewer.id, suspended.id);

    const response = await agent
      .get('/api/player/v1/leaderboards?period=today&page=1&limit=10')
      .expect(200);
    const data = (
      response.body as unknown as {
        data: {
          items: Array<{ playerId: string; rank: number }>;
          meta: { total: number; totalPages: number };
          me: { playerId: string; rank: number; localRank: number };
        };
      }
    ).data;
    expect(data.items).toHaveLength(10);
    expect(data.meta).toEqual({ page: 1, limit: 10, total: 12, totalPages: 2 });
    expect(data.me).toMatchObject({
      playerId: viewer.id,
      rank: 12,
      localRank: 12,
    });
    expect(data.items.map((item) => item.playerId)).not.toContain(hidden.id);
    expect(data.items.map((item) => item.playerId)).not.toContain(suspended.id);
    expect(JSON.stringify(response.body)).not.toMatch(
      /@example\.com|password|country|status/i,
    );

    const me = await agent
      .get('/api/player/v1/leaderboards/me?period=today')
      .expect(200);
    const meData = (me.body as unknown as { data: { me: { rank: number } } })
      .data;
    expect(meData.me.rank).toBe(12);

    await testPrisma.gameMatch.update({
      where: { id: matches[0]!.id },
      data: { winnerTeam: 0 },
    });
    const corrected = await agent
      .get('/api/player/v1/leaderboards?period=today')
      .expect(200);
    const correctedData = (
      corrected.body as unknown as {
        data: { me: { wins: number } };
      }
    ).data;
    expect(correctedData.me.wins).toBe(1);
  });
});
