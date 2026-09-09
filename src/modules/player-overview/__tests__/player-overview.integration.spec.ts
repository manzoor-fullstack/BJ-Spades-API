import type { INestApplication } from '@nestjs/common';
import {
  GameMatchStatus,
  Prisma,
  RegistrationStatus,
  TournamentStatus,
  TransactionStatus,
  TransactionType,
  UserSource,
} from '@prisma/client';
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

interface OverviewBody {
  data: {
    firstName: string;
    formulaVersion: string;
    stats: {
      gamesPlayed: number;
      wins: number;
      losses: number;
      winRate: number;
      currentStreak: number;
      tournamentWins: number;
      totalWinnings: string;
      lastTenGames: string[];
    };
    trends: Record<string, unknown>;
    progression: { xp: number; rank: string };
    achievements: Array<{ code: string; unlocked: boolean }>;
  };
}

describe('Player overview API (integration)', () => {
  let app: INestApplication;
  const email = new CapturingEmailService();
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: PlayerEmailService, useValue: email }],
    });
  });

  afterAll(async () => app?.close());

  async function signedInPlayer(suffix: string) {
    const address = `f10-${suffix}@example.com`;
    const password = 'StrongPass123';
    const agent = request.agent(server());
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({ username: `f10_${suffix}`, email: address, password })
      .expect(202);
    await agent
      .post('/api/player/v1/auth/verify-email')
      .set('Origin', ORIGIN)
      .send({ token: email.tokens.get(address) })
      .expect(200);
    await agent
      .post('/api/player/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: address, password, rememberMe: false })
      .expect(200);
    return {
      agent,
      address,
      password,
      user: await testPrisma.user.findUniqueOrThrow({
        where: { email: address },
      }),
    };
  }

  async function secondDevice(address: string, password: string) {
    const agent = request.agent(server());
    await agent
      .post('/api/player/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: address, password, rememberMe: false })
      .expect(200);
    return agent;
  }

  async function seedMatch(
    playerId: string,
    suffix: string,
    completedAt: Date,
    winnerTeam: 0 | 1,
  ) {
    const opponents = await Promise.all(
      [1, 2, 3].map((number) =>
        testPrisma.user.create({
          data: {
            firstName: `Opponent${number}`,
            lastName: suffix,
            email: `f10-${suffix}-${number}@example.com`,
            source: UserSource.PLAYER,
            emailVerified: true,
            emailVerifiedAt: completedAt,
          },
        }),
      ),
    );
    return testPrisma.gameMatch.create({
      data: {
        status: GameMatchStatus.COMPLETED,
        rulesVersion: 'spades-partnership-v1',
        creationRequestId: `f10-${suffix}`,
        createdByPlayerId: playerId,
        state: { phase: 'COMPLETED', winnerTeam },
        dealerSeat: 0,
        winnerTeam,
        completedAt,
        seats: {
          create: [
            { userId: playerId, seat: 0, team: 0 },
            { userId: opponents[0]!.id, seat: 1, team: 1 },
            { userId: opponents[1]!.id, seat: 2, team: 0 },
            { userId: opponents[2]!.id, seat: 3, team: 1 },
          ],
        },
      },
    });
  }

  async function seedTournamentWin(playerId: string, completedAt: Date) {
    const tournament = await testPrisma.tournament.create({
      data: {
        name: 'F10 Championship',
        entryFee: new Prisma.Decimal(0),
        prizePool: new Prisma.Decimal(100),
        maxPlayers: 4,
        startsAt: new Date(completedAt.getTime() - 86_400_000),
        status: TournamentStatus.COMPLETED,
        xpMultiplier: new Prisma.Decimal(2),
        settledAt: completedAt,
        createdByPlayerId: playerId,
      },
    });
    const registration = await testPrisma.tournamentRegistration.create({
      data: {
        tournamentId: tournament.id,
        userId: playerId,
        status: RegistrationStatus.REGISTERED,
        placement: 1,
        prizeWon: new Prisma.Decimal(100),
      },
    });
    return { tournament, registration };
  }

  async function seedPrize(
    playerId: string,
    amount: string,
    createdAt: Date,
    reference: string,
  ) {
    return testPrisma.transaction.create({
      data: {
        userId: playerId,
        type: TransactionType.PRIZE,
        status: TransactionStatus.COMPLETED,
        amount: new Prisma.Decimal(amount),
        balanceBefore: new Prisma.Decimal(0),
        balanceAfter: new Prisma.Decimal(amount),
        affectsBalance: true,
        reference,
        createdAt,
      },
    });
  }

  it('requires a player session', async () => {
    await request(server()).get('/api/player/v1/me/overview').expect(401);
    await request(server()).get('/api/player/v1/me/stats').expect(401);
    await request(server()).get('/api/player/v1/me/achievements').expect(401);
  });

  it('returns stable empty-history stats from all three contracts', async () => {
    const player = await signedInPlayer('empty');
    const overview = await player.agent
      .get('/api/player/v1/me/overview')
      .expect(200);
    const body = (overview.body as OverviewBody).data;

    expect(body.formulaVersion).toBe('player-progression-v1');
    expect(body.stats).toMatchObject({
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      currentStreak: 0,
      tournamentWins: 0,
      totalWinnings: '0.00',
      lastTenGames: [],
    });
    expect(body.progression).toMatchObject({ xp: 0, rank: 'ROOKIE' });
    expect(body.achievements.every((item) => !item.unlocked)).toBe(true);

    await player.agent.get('/api/player/v1/me/stats').expect(200);
    await player.agent.get('/api/player/v1/me/achievements').expect(200);
    expect(JSON.stringify(body)).not.toContain('NaN');
  });

  it('rebuilds exact stats across retries, corrections and a second device', async () => {
    const player = await signedInPlayer('history');
    const now = new Date();
    await seedMatch(
      player.user.id,
      'older-loss',
      new Date(now.getTime() - 2 * 86_400_000),
      1,
    );
    const newest = await seedMatch(
      player.user.id,
      'newer-win',
      new Date(now.getTime() - 60_000),
      0,
    );
    const { registration } = await seedTournamentWin(
      player.user.id,
      new Date(now.getTime() - 30_000),
    );
    await seedPrize(
      player.user.id,
      '100.00',
      new Date(now.getTime() - 20_000),
      'f10-prize',
    );

    const first = (
      await player.agent.get('/api/player/v1/me/overview').expect(200)
    ).body as OverviewBody;
    expect(first.data.stats).toMatchObject({
      gamesPlayed: 2,
      wins: 1,
      losses: 1,
      winRate: 50,
      currentStreak: 1,
      tournamentWins: 1,
      totalWinnings: '100.00',
      lastTenGames: ['W', 'L'],
    });
    expect(first.data.progression).toMatchObject({ xp: 570, rank: 'BRONZE' });

    const otherAgent = await secondDevice(player.address, player.password);
    const other = (
      await otherAgent.get('/api/player/v1/me/overview').expect(200)
    ).body as OverviewBody;
    expect(other.data.stats).toEqual(first.data.stats);
    expect(other.data.progression).toEqual(first.data.progression);

    await testPrisma.gameMatch.update({
      where: { id: newest.id },
      data: { winnerTeam: 1 },
    });
    await testPrisma.tournamentRegistration.update({
      where: { id: registration.id },
      data: { placement: 2 },
    });
    await seedPrize(
      player.user.id,
      '-100.00',
      new Date(),
      'f10-prize-reversal',
    );

    const corrected = (
      await player.agent.get('/api/player/v1/me/overview').expect(200)
    ).body as OverviewBody;
    expect(corrected.data.stats).toMatchObject({
      gamesPlayed: 2,
      wins: 0,
      losses: 2,
      winRate: 0,
      currentStreak: 0,
      tournamentWins: 0,
      totalWinnings: '0.00',
      lastTenGames: ['L', 'L'],
    });
    expect(corrected.data.progression).toMatchObject({
      xp: 40,
      rank: 'ROOKIE',
    });

    const replay = (
      await player.agent.get('/api/player/v1/me/overview').expect(200)
    ).body as OverviewBody;
    expect(replay.data.stats).toEqual(corrected.data.stats);
    expect(replay.data.progression).toEqual(corrected.data.progression);
  });
});
