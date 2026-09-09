import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import {
  DisputeRisk,
  DisputeStatus,
  GameMatchStatus,
  Prisma,
  RegistrationStatus,
  TournamentPrizeAwardStatus,
  TournamentStatus,
  TransactionStatus,
  TransactionType,
  UserSource,
  UserStatus,
  UserTier,
} from '@prisma/client';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';
import { TournamentProgressionService } from '../tournament-progression.service';

let counter = 0;

async function player(balance = '0.00') {
  counter += 1;
  return testPrisma.user.create({
    data: {
      firstName: `Bracket${counter}`,
      lastName: 'Player',
      email: `bracket-${counter}@example.com`,
      status: UserStatus.ACTIVE,
      tier: UserTier.PLAYER,
      source: UserSource.PLAYER,
      emailVerified: true,
      balance: new Prisma.Decimal(balance),
    },
  });
}

async function tournament(userIds: string[], prizePool = '100.00') {
  return testPrisma.tournament.create({
    data: {
      name: `F09 Cup ${++counter}`,
      entryFee: new Prisma.Decimal('10.00'),
      prizePool: new Prisma.Decimal(prizePool),
      maxPlayers: userIds.length,
      startsAt: new Date(Date.now() + 60_000),
      status: TournamentStatus.REGISTERING,
      visibility: 'PRIVATE',
      createdByPlayerId: userIds[0],
      registrations: {
        create: userIds.map((userId) => ({
          userId,
          status: RegistrationStatus.REGISTERED,
        })),
      },
    },
  });
}

describe('F09 tournament progression and wallet settlement', () => {
  let app: INestApplication;
  let progression: TournamentProgressionService;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp();
    progression = app.get(TournamentProgressionService);
  });

  afterAll(async () => app.close());

  async function applyWinner(matchId: string, winnerTeam = 0) {
    await testPrisma.gameMatch.update({
      where: { id: matchId },
      data: {
        status: GameMatchStatus.COMPLETED,
        winnerTeam,
        completedAt: new Date(),
      },
    });
    await testPrisma.$transaction((tx) =>
      progression.applyCompletedMatch(tx, matchId),
    );
  }

  it('draws stable teams, advances each match once and credits exactly the 70/30 pool', async () => {
    const players = await Promise.all(
      Array.from({ length: 8 }, () => player()),
    );
    const cup = await tournament(players.map((entry) => entry.id));

    await Promise.all([progression.start(cup.id), progression.start(cup.id)]);

    const started = await testPrisma.tournament.findUniqueOrThrow({
      where: { id: cup.id },
      include: {
        teams: { include: { registrations: true } },
        gameMatches: true,
      },
    });
    expect(started.status).toBe(TournamentStatus.IN_PROGRESS);
    expect(started.bracketSeed).toMatch(/^[a-f0-9]{64}$/);
    expect(started.bracketRounds).toBe(2);
    expect(started.teams).toHaveLength(4);
    expect(started.teams.every((team) => team.registrations.length === 2)).toBe(
      true,
    );
    expect(started.gameMatches).toHaveLength(2);

    const first = started.gameMatches.find(
      (match) => match.tournamentSlot === 0,
    )!;
    const second = started.gameMatches.find(
      (match) => match.tournamentSlot === 1,
    )!;
    await testPrisma.gameMatch.update({
      where: { id: first.id },
      data: {
        status: GameMatchStatus.COMPLETED,
        winnerTeam: 0,
        completedAt: new Date(),
      },
    });
    await Promise.all([
      testPrisma.$transaction((tx) =>
        progression.applyCompletedMatch(tx, first.id),
      ),
      testPrisma.$transaction((tx) =>
        progression.applyCompletedMatch(tx, first.id),
      ),
    ]);
    await applyWinner(second.id, 1);

    const finals = await testPrisma.gameMatch.findMany({
      where: { tournamentId: cup.id, tournamentRound: 2 },
    });
    expect(finals).toHaveLength(1);
    await applyWinner(finals[0]!.id, 0);

    const completed = await testPrisma.tournament.findUniqueOrThrow({
      where: { id: cup.id },
    });
    expect(completed.status).toBe(TournamentStatus.COMPLETED);
    expect(completed.settlementVersion).toBe(1);
    expect(completed.settledAt).toBeInstanceOf(Date);

    const awards = await testPrisma.tournamentPrizeAward.findMany({
      where: { tournamentId: cup.id },
      orderBy: [{ placement: 'asc' }, { userId: 'asc' }],
    });
    expect(awards).toHaveLength(4);
    expect(awards.map((award) => award.amount.toFixed(2))).toEqual([
      '35.00',
      '35.00',
      '15.00',
      '15.00',
    ]);
    expect(
      awards.every(
        (award) => award.status === TournamentPrizeAwardStatus.CREDITED,
      ),
    ).toBe(true);

    const ledger = await testPrisma.transaction.findMany({
      where: { tournamentId: cup.id, type: TransactionType.PRIZE },
    });
    expect(ledger).toHaveLength(4);
    expect(
      ledger
        .reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0))
        .toFixed(2),
    ).toBe('100.00');

    await testPrisma.$transaction((tx) =>
      progression.applyCompletedMatch(tx, finals[0]!.id),
    );
    await expect(
      testPrisma.transaction.count({
        where: { tournamentId: cup.id, type: TransactionType.PRIZE },
      }),
    ).resolves.toBe(4);

    const originalChampion = awards
      .filter((award) => award.placement === 1)
      .map((award) => award.userId);
    const originalRunnerUp = awards
      .filter((award) => award.placement === 2)
      .map((award) => award.userId);
    const correctionId = '99000000-0000-4000-8000-000000000001';
    await Promise.all([
      progression.correctResults(
        cup.id,
        originalRunnerUp,
        originalChampion,
        'Verified scoring correction.',
        correctionId,
      ),
      progression.correctResults(
        cup.id,
        originalRunnerUp,
        originalChampion,
        'Verified scoring correction.',
        correctionId,
      ),
    ]);
    await expect(
      testPrisma.tournamentResultCorrection.count({
        where: { tournamentId: cup.id },
      }),
    ).resolves.toBe(1);
    await expect(
      testPrisma.tournament.findUniqueOrThrow({ where: { id: cup.id } }),
    ).resolves.toMatchObject({ settlementVersion: 2 });
    const correctedLedger = await testPrisma.transaction.findMany({
      where: { tournamentId: cup.id, type: TransactionType.PRIZE },
    });
    expect(correctedLedger).toHaveLength(12);
    expect(
      correctedLedger
        .reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0))
        .toFixed(2),
    ).toBe('100.00');
    const correctedAwards = await testPrisma.tournamentPrizeAward.findMany({
      where: { tournamentId: cup.id },
    });
    expect(
      correctedAwards.filter(
        (award) => award.status === TournamentPrizeAwardStatus.REVERSED,
      ),
    ).toHaveLength(4);
    expect(
      correctedAwards.filter(
        (award) => award.status === TournamentPrizeAwardStatus.CREDITED,
      ),
    ).toHaveLength(4);
  });

  it('holds a disputed player prize without inflating the wallet', async () => {
    const players = await Promise.all(
      Array.from({ length: 4 }, () => player()),
    );
    const cup = await tournament(
      players.map((entry) => entry.id),
      '10.01',
    );
    await progression.start(cup.id);
    const match = await testPrisma.gameMatch.findFirstOrThrow({
      where: { tournamentId: cup.id },
      include: { seats: true },
    });
    const heldPlayer = match.seats.find((seat) => seat.team === 0)!.userId;
    await testPrisma.dispute.create({
      data: {
        caseNumber: `F09-${++counter}`,
        userId: heldPlayer,
        tournamentId: cup.id,
        reason: 'Result review',
        risk: DisputeRisk.HIGH,
        status: DisputeStatus.UNDER_REVIEW,
      },
    });
    await applyWinner(match.id, 0);

    const award = await testPrisma.tournamentPrizeAward.findFirstOrThrow({
      where: { tournamentId: cup.id, userId: heldPlayer },
    });
    expect(award.status).toBe(TournamentPrizeAwardStatus.HELD);
    expect(award.transactionId).toBeNull();
    await expect(
      testPrisma.user.findUniqueOrThrow({ where: { id: heldPlayer } }),
    ).resolves.toMatchObject({ balance: new Prisma.Decimal(0) });
    await expect(
      testPrisma.tournament.findUniqueOrThrow({ where: { id: cup.id } }),
    ).resolves.toMatchObject({
      status: TournamentStatus.COMPLETED,
      settledAt: null,
    });

    await testPrisma.dispute.updateMany({
      where: { tournamentId: cup.id, userId: heldPlayer },
      data: {
        status: DisputeStatus.CLEARED,
        resolvedAt: new Date(),
        resolutionNote: 'Verified.',
      },
    });
    await Promise.all([
      progression.releaseHeldAwards(cup.id, heldPlayer),
      progression.releaseHeldAwards(cup.id, heldPlayer),
    ]);
    await expect(
      testPrisma.transaction.count({
        where: { tournamentId: cup.id, type: TransactionType.PRIZE },
      }),
    ).resolves.toBe(4);
    await expect(
      testPrisma.tournamentPrizeAward.findUniqueOrThrow({
        where: { id: award.id },
      }),
    ).resolves.toMatchObject({ status: TournamentPrizeAwardStatus.CREDITED });
    expect(
      (await testPrisma.tournament.findUniqueOrThrow({ where: { id: cup.id } }))
        .settledAt,
    ).toBeInstanceOf(Date);
  });

  it('turns a disqualification into an authoritative team forfeit and withholds that team prize', async () => {
    const players = await Promise.all(
      Array.from({ length: 4 }, () => player()),
    );
    const cup = await tournament(players.map((entry) => entry.id));
    await progression.start(cup.id);
    const match = await testPrisma.gameMatch.findFirstOrThrow({
      where: { tournamentId: cup.id },
      include: { seats: true },
    });
    const disqualified = match.seats.find((seat) => seat.team === 0)!;
    await progression.disqualifyPlayer(cup.id, disqualified.userId, 'DSP-F09');

    const ended = await testPrisma.gameMatch.findUniqueOrThrow({
      where: { id: match.id },
    });
    expect(ended.status).toBe(GameMatchStatus.FORFEITED);
    expect(ended.winnerTeam).toBe(1);
    await expect(
      testPrisma.tournamentRegistration.findUniqueOrThrow({
        where: {
          tournamentId_userId: {
            tournamentId: cup.id,
            userId: disqualified.userId,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: RegistrationStatus.DISQUALIFIED,
      prizeWon: null,
    });
    const prizes = await testPrisma.transaction.findMany({
      where: { tournamentId: cup.id, type: TransactionType.PRIZE },
    });
    expect(prizes).toHaveLength(2);
    expect(
      prizes
        .reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0))
        .toFixed(2),
    ).toBe('70.00');
  });

  it('requires an authenticated admin and writes an audit row for a correction', async () => {
    const players = await Promise.all(
      Array.from({ length: 4 }, () => player()),
    );
    const cup = await tournament(players.map((entry) => entry.id));
    await progression.start(cup.id);
    const match = await testPrisma.gameMatch.findFirstOrThrow({
      where: { tournamentId: cup.id },
    });
    await applyWinner(match.id, 0);
    const awards = await testPrisma.tournamentPrizeAward.findMany({
      where: { tournamentId: cup.id },
    });
    const body = {
      requestId: '99000000-0000-4000-8000-000000000002',
      championUserIds: awards
        .filter((award) => award.placement === 2)
        .map((award) => award.userId),
      runnerUpUserIds: awards
        .filter((award) => award.placement === 1)
        .map((award) => award.userId),
      reason: 'Verified final score correction.',
    };
    await request(server())
      .post(`/api/tournaments/${cup.id}/results/corrections`)
      .send(body)
      .expect(401);
    const login = await request(server())
      .post('/api/auth/login')
      .send(SEEDED_ADMIN)
      .expect(200);
    const accessToken = (login.body as { data: { accessToken: string } }).data
      .accessToken;
    await request(server())
      .post(`/api/tournaments/${cup.id}/results/corrections`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body)
      .expect(200);
    await expect(
      testPrisma.activityLog.count({
        where: {
          action: 'tournament.results_corrected',
          entityId: cup.id,
        },
      }),
    ).resolves.toBe(1);
  });

  it('cancels an invalid bracket and refunds every collected entry once', async () => {
    const players = await Promise.all(
      Array.from({ length: 3 }, () => player('90.00')),
    );
    const cup = await tournament(players.map((entry) => entry.id));
    for (const entry of players) {
      await testPrisma.transaction.create({
        data: {
          userId: entry.id,
          tournamentId: cup.id,
          type: TransactionType.ENTRY_FEE,
          status: TransactionStatus.COMPLETED,
          amount: new Prisma.Decimal('-10.00'),
          balanceBefore: new Prisma.Decimal('100.00'),
          balanceAfter: new Prisma.Decimal('90.00'),
          reference: `entry_fee:${cup.id}:${entry.id}`,
        },
      });
    }

    await progression.start(cup.id);
    const cancelled = await testPrisma.tournament.findUniqueOrThrow({
      where: { id: cup.id },
    });
    expect(cancelled.status).toBe(TournamentStatus.CANCELLED);
    await expect(
      testPrisma.transaction.count({
        where: { tournamentId: cup.id, type: TransactionType.REFUND },
      }),
    ).resolves.toBe(3);
    const balances = await testPrisma.user.findMany({
      where: { id: { in: players.map((entry) => entry.id) } },
      select: { balance: true },
    });
    expect(balances.every((entry) => entry.balance.equals(100))).toBe(true);
  });
});
