import type { INestApplication } from '@nestjs/common';
import {
  Prisma,
  TournamentStatus,
  TournamentVisibility,
  TransactionType,
  UserStatus,
} from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';

import { createTestApp } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { PlayerEmailService } from '../../player-auth/services/player-email.service';
import { TransactionsService } from '../../transactions/transactions.service';

const ORIGIN = 'http://127.0.0.1:4173';
const FUTURE = new Date('2027-06-05T23:00:00.000Z');

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
  const raw = (
    response.headers as Record<string, string | string[] | undefined>
  )['set-cookie'];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing ${name} cookie`);
  return cookie.split(';')[0]!.slice(name.length + 1);
}

function responseData<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

interface PlayerTournamentBody {
  id: string;
  name: string;
  status: string;
  visibility: string;
  entryFee: string;
  prizePool: string;
  isRegistered: boolean;
  isHostedByMe: boolean;
  canJoin: boolean;
}

interface DashboardBody {
  featured: PlayerTournamentBody | null;
  upcoming: PlayerTournamentBody[];
  scheduled: PlayerTournamentBody[];
  past: PlayerTournamentBody[];
  stats: {
    tournamentsPlayed: number;
    totalWinnings: string;
    upcoming: number;
    scheduled: number;
  };
}

describe('Player tournaments API (integration)', () => {
  let app: INestApplication;
  const email = new CapturingEmailService();
  const server = (): Server => app.getHttpServer() as Server;
  let adminId: string;

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: PlayerEmailService, useValue: email }],
    });
    adminId = (
      await testPrisma.admin.findUniqueOrThrow({
        where: { email: 'admin@bjspades.com' },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => app?.close());

  async function signedInPlayer(suffix: string) {
    const agent = request.agent(server());
    const address = `f06-${suffix}@example.com`;
    await agent
      .post('/api/player/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({
        username: `f06_${suffix}`,
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

  function seedPublic(
    overrides: Partial<Prisma.TournamentUncheckedCreateInput> = {},
  ) {
    return testPrisma.tournament.create({
      data: {
        name: `F06 public ${crypto.randomUUID()}`,
        entryFee: new Prisma.Decimal('10.00'),
        prizePool: new Prisma.Decimal('500.00'),
        maxPlayers: 16,
        startsAt: FUTURE,
        status: TournamentStatus.REGISTERING,
        visibility: TournamentVisibility.PUBLIC,
        createdByAdminId: adminId,
        ...overrides,
      },
    });
  }

  async function fund(userId: string, amount = '100.00') {
    await app.get(TransactionsService).record({
      userId,
      type: TransactionType.ADJUSTMENT,
      amount,
      description: 'F06 test funding',
    });
  }

  async function balanceOf(userId: string) {
    return (
      await testPrisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { balance: true },
      })
    ).balance.toFixed(2);
  }

  it('returns player-safe public, joined, past, featured and owned-private views without leaking another private tournament', async () => {
    const player = await signedInPlayer('catalog');
    const other = await signedInPlayer('private_owner');
    const featured = await seedPublic({
      name: 'Authoritative Featured Cup',
      isFeatured: true,
      featuredSubtitle: 'Server supplied subtitle',
      xpMultiplier: new Prisma.Decimal('2.50'),
      featuredRewards: ['Server supplied reward'],
    });
    const past = await seedPublic({
      name: 'Player Past Cup',
      status: TournamentStatus.COMPLETED,
      startsAt: new Date('2026-01-01T12:00:00.000Z'),
    });
    await testPrisma.tournamentRegistration.create({
      data: {
        tournamentId: past.id,
        userId: player.user.id,
        placement: 2,
        prizeWon: new Prisma.Decimal('75.00'),
      },
    });
    const mine = await testPrisma.tournament.create({
      data: {
        name: 'My Private Cup',
        entryFee: 0,
        prizePool: 0,
        maxPlayers: 8,
        startsAt: FUTURE,
        status: TournamentStatus.SCHEDULED,
        visibility: TournamentVisibility.PRIVATE,
        createdByPlayerId: player.user.id,
      },
    });
    await testPrisma.tournamentRegistration.create({
      data: { tournamentId: mine.id, userId: player.user.id },
    });
    const secret = await testPrisma.tournament.create({
      data: {
        name: 'Someone Else Private Cup',
        entryFee: 0,
        prizePool: 0,
        maxPlayers: 8,
        startsAt: FUTURE,
        status: TournamentStatus.SCHEDULED,
        visibility: TournamentVisibility.PRIVATE,
        createdByPlayerId: other.user.id,
      },
    });

    const response = await player.agent
      .get('/api/player/v1/tournaments/dashboard')
      .expect(200);
    const dashboard = responseData<DashboardBody>(response);
    expect(dashboard.featured).toMatchObject({
      id: featured.id,
      name: 'Authoritative Featured Cup',
    });
    expect(dashboard.scheduled.map((item) => item.id)).toContain(mine.id);
    expect(dashboard.past.map((item) => item.id)).toContain(past.id);
    expect(JSON.stringify(dashboard)).not.toContain(secret.id);
    expect(dashboard.stats).toMatchObject({
      tournamentsPlayed: 1,
      totalWinnings: '75.00',
    });
    await player.agent
      .get(`/api/player/v1/tournaments/${secret.id}`)
      .expect(404);
  });

  it('charges once, rejects a duplicate, refunds once, and charges a new attempt on rejoin', async () => {
    const player = await signedInPlayer('accounting');
    await fund(player.user.id);
    const tournament = await seedPublic();
    const path = `/api/player/v1/tournaments/${tournament.id}/registrations`;

    await player.agent
      .post(path)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(201);
    await expect(balanceOf(player.user.id)).resolves.toBe('90.00');
    await player.agent
      .post(path)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(409);
    await player.agent
      .post(`${path}/cancel`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(200);
    await player.agent
      .post(`${path}/cancel`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(200);
    await expect(balanceOf(player.user.id)).resolves.toBe('100.00');
    await player.agent
      .post(path)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(201);
    await expect(balanceOf(player.user.id)).resolves.toBe('90.00');
    await expect(
      testPrisma.transaction.count({
        where: { tournamentId: tournament.id, userId: player.user.id },
      }),
    ).resolves.toBe(3);
  });

  it('rejects a suspended player before tournament registration', async () => {
    const player = await signedInPlayer('suspended');
    const tournament = await seedPublic();
    await testPrisma.user.update({
      where: { id: player.user.id },
      data: { status: UserStatus.SUSPENDED },
    });

    await player.agent
      .post(`/api/player/v1/tournaments/${tournament.id}/registrations`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(401);
    expect(
      await testPrisma.tournamentRegistration.count({
        where: { tournamentId: tournament.id, userId: player.user.id },
      }),
    ).toBe(0);
  });

  it('rejects registration after the start time and when the balance is insufficient', async () => {
    const player = await signedInPlayer('eligibility');
    const closed = await seedPublic({
      startsAt: new Date('2026-01-01T12:00:00.000Z'),
    });
    await player.agent
      .post(`/api/player/v1/tournaments/${closed.id}/registrations`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(422);
    const costly = await seedPublic({ entryFee: new Prisma.Decimal('500.00') });
    await player.agent
      .post(`/api/player/v1/tournaments/${costly.id}/registrations`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', player.csrf)
      .expect(422);
    await expect(balanceOf(player.user.id)).resolves.toBe('0.00');
  });

  it('creates a future private tournament with no player-controlled money and only lets its host cancel it', async () => {
    const host = await signedInPlayer('host');
    const other = await signedInPlayer('not_host');
    const created = await host.agent
      .post('/api/player/v1/tournaments')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', host.csrf)
      .send({
        name: 'Private Friends Cup',
        description: 'Invite-only table',
        maxPlayers: 8,
        startDate: '2027-06-05',
        startTime: '23:00',
      })
      .expect(201);
    const tournament = responseData<PlayerTournamentBody>(created);
    expect(tournament).toMatchObject({
      visibility: 'PRIVATE',
      entryFee: '0.00',
      prizePool: '0.00',
      isRegistered: true,
      isHostedByMe: true,
    });
    await expect(
      testPrisma.tournament.findUniqueOrThrow({
        where: { id: tournament.id },
        select: { entryFee: true, prizePool: true },
      }),
    ).resolves.toMatchObject({
      entryFee: new Prisma.Decimal('0.00'),
      prizePool: new Prisma.Decimal('0.00'),
    });
    await host.agent
      .post('/api/player/v1/tournaments')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', host.csrf)
      .send({
        name: 'Invalid Money Cup',
        maxPlayers: 8,
        startDate: '2027-06-06',
        startTime: '23:00',
        prizePool: '999999.00',
      })
      .expect(400);
    await other.agent
      .get(`/api/player/v1/tournaments/${tournament.id}`)
      .expect(404);
    await other.agent
      .post(`/api/player/v1/tournaments/${tournament.id}/cancel`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', other.csrf)
      .expect(404);
    const cancelled = await host.agent
      .post(`/api/player/v1/tournaments/${tournament.id}/cancel`)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', host.csrf)
      .expect(200);
    expect(responseData<PlayerTournamentBody>(cancelled).status).toBe(
      'CANCELLED',
    );
  });

  it('lets exactly one player take the final public slot', async () => {
    const [first, second] = await Promise.all([
      signedInPlayer('last_one'),
      signedInPlayer('last_two'),
    ]);
    await Promise.all([fund(first.user.id), fund(second.user.id)]);
    const tournament = await seedPublic({ maxPlayers: 1 });
    const join = (player: Awaited<ReturnType<typeof signedInPlayer>>) =>
      player.agent
        .post(`/api/player/v1/tournaments/${tournament.id}/registrations`)
        .set('Origin', ORIGIN)
        .set('x-csrf-token', player.csrf);
    const responses = await Promise.all([join(first), join(second)]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 422,
    ]);
    await expect(
      testPrisma.tournamentRegistration.count({
        where: {
          tournamentId: tournament.id,
          status: { in: ['REGISTERED', 'CHECKED_IN'] },
        },
      }),
    ).resolves.toBe(1);
  });
});
