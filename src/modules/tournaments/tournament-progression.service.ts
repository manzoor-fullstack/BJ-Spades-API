import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DisputeStatus,
  GameEventType,
  GameMatchStatus,
  Prisma,
  RegistrationStatus,
  TournamentPrizeAwardStatus,
  TournamentStatus,
  TournamentTeamStatus,
  TransactionType,
  UserStatus,
} from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

import {
  createSpadesState,
  forfeitMatch,
} from '../matches/engine/spades.engine';
import {
  SPADES_RULESET_VERSION,
  type Seat,
  type SpadesState,
} from '../matches/engine/spades.types';
import { PrismaService } from '../prisma/prisma.service';
import { recordLedgerEntry } from '../transactions/repositories/transactions.repository';

const PRIZE_RULE_VERSION = 'team-70-30-v1';
const TURN_SECONDS = 30;

type TransactionClient = Prisma.TransactionClient;

interface LockedTournament {
  id: string;
  name: string;
  status: TournamentStatus;
  prizePool: Prisma.Decimal;
  bracketStartedAt: Date | null;
  bracketRounds: number | null;
  settlementVersion: number;
}

function isPowerOfTwo(value: number): boolean {
  return value >= 1 && (value & (value - 1)) === 0;
}

function stableDraw(seed: string, ids: string[]): string[] {
  return [...ids].sort((left, right) => {
    const leftHash = createHash('sha256')
      .update(`${seed}:${left}`)
      .digest('hex');
    const rightHash = createHash('sha256')
      .update(`${seed}:${right}`)
      .digest('hex');
    return leftHash.localeCompare(rightHash) || left.localeCompare(right);
  });
}

function nextDeadline(): Date {
  return new Date(Date.now() + TURN_SECONDS * 1000);
}

@Injectable()
export class TournamentProgressionService {
  constructor(private readonly prisma: PrismaService) {}

  async start(tournamentId: string) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedTournament[]>`
        SELECT "id", "name", "status", "prizePool", "bracketStartedAt",
               "bracketRounds", "settlementVersion"
        FROM "Tournament"
        WHERE "id" = ${tournamentId}
        FOR UPDATE
      `;
      const tournament = rows[0];
      if (!tournament) throw new NotFoundException('Tournament not found.');

      if (tournament.bracketStartedAt) {
        if (tournament.status !== TournamentStatus.IN_PROGRESS) {
          throw new ConflictException(
            'The stored tournament bracket is not active.',
          );
        }
        return this.summary(tx, tournamentId);
      }
      if (tournament.status !== TournamentStatus.REGISTERING) {
        throw new UnprocessableEntityException(
          'Only a registering tournament can start.',
        );
      }

      const registrations = await tx.tournamentRegistration.findMany({
        where: {
          tournamentId,
          status: {
            in: [RegistrationStatus.REGISTERED, RegistrationStatus.CHECKED_IN],
          },
          user: {
            status: UserStatus.ACTIVE,
            deletedAt: null,
            emailVerified: true,
          },
        },
        orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
        select: { id: true, userId: true },
      });

      if (registrations.length < 4 || !isPowerOfTwo(registrations.length)) {
        await this.cancelUnstartable(tx, tournamentId);
        return this.summary(tx, tournamentId);
      }

      const seed = randomBytes(32).toString('hex');
      const byUser = new Map(
        registrations.map((entry) => [entry.userId, entry]),
      );
      const draw = stableDraw(
        seed,
        registrations.map((entry) => entry.userId),
      );
      const teams: Array<{ id: string; users: [string, string] }> = [];

      for (let index = 0; index < draw.length; index += 2) {
        const users: [string, string] = [draw[index]!, draw[index + 1]!];
        const team = await tx.tournamentTeam.create({
          data: { tournamentId, seed: teams.length + 1 },
          select: { id: true },
        });
        await tx.tournamentRegistration.updateMany({
          where: { id: { in: users.map((userId) => byUser.get(userId)!.id) } },
          data: { teamId: team.id },
        });
        teams.push({ id: team.id, users });
      }

      const rounds = Math.log2(teams.length);
      for (let slot = 0; slot < teams.length / 2; slot += 1) {
        await this.createMatch(
          tx,
          tournamentId,
          1,
          slot,
          teams[slot * 2]!,
          teams[slot * 2 + 1]!,
        );
      }

      await tx.tournament.update({
        where: { id: tournamentId },
        data: {
          status: TournamentStatus.IN_PROGRESS,
          bracketStartedAt: new Date(),
          bracketSeed: seed,
          bracketRounds: rounds,
          prizeRuleVersion: PRIZE_RULE_VERSION,
        },
      });

      return this.summary(tx, tournamentId);
    });
  }

  async applyCompletedMatch(
    tx: TransactionClient,
    matchId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "GameMatch" WHERE "id" = ${matchId} FOR UPDATE`;
    const match = await tx.gameMatch.findUnique({
      where: { id: matchId },
      include: { seats: { orderBy: { seat: 'asc' } } },
    });
    if (
      !match?.tournamentId ||
      match.resultAppliedAt ||
      match.tournamentRound === null ||
      match.tournamentSlot === null ||
      match.winnerTeam === null ||
      (match.status !== GameMatchStatus.COMPLETED &&
        match.status !== GameMatchStatus.FORFEITED)
    ) {
      return;
    }

    const teamIds = [
      ...new Set(
        match.seats.map((seat) => seat.tournamentTeamId).filter(Boolean),
      ),
    ] as string[];
    const winnerTeamId = match.seats.find(
      (seat) => seat.team === match.winnerTeam,
    )?.tournamentTeamId;
    const loserTeamId = teamIds.find((id) => id !== winnerTeamId);
    if (!winnerTeamId || !loserTeamId || teamIds.length !== 2) {
      throw new ConflictException(
        'Tournament match team assignments are invalid.',
      );
    }

    const tournamentRows = await tx.$queryRaw<LockedTournament[]>`
      SELECT "id", "name", "status", "prizePool", "bracketStartedAt",
             "bracketRounds", "settlementVersion"
      FROM "Tournament"
      WHERE "id" = ${match.tournamentId}
      FOR UPDATE
    `;
    const tournament = tournamentRows[0];
    if (
      !tournament ||
      tournament.status !== TournamentStatus.IN_PROGRESS ||
      !tournament.bracketRounds
    ) {
      throw new ConflictException('The tournament bracket is not active.');
    }

    const loserPlacement =
      2 ** (tournament.bracketRounds - match.tournamentRound) + 1;
    const loserTeam = await tx.tournamentTeam.findUniqueOrThrow({
      where: { id: loserTeamId },
    });
    await tx.tournamentTeam.update({
      where: { id: loserTeamId },
      data: {
        status:
          loserTeam.status === TournamentTeamStatus.DISQUALIFIED
            ? TournamentTeamStatus.DISQUALIFIED
            : match.tournamentRound === tournament.bracketRounds
              ? TournamentTeamStatus.RUNNER_UP
              : TournamentTeamStatus.ELIMINATED,
        placement: loserPlacement,
        eliminatedRound: match.tournamentRound,
      },
    });
    await tx.gameMatch.update({
      where: { id: matchId },
      data: { resultAppliedAt: new Date() },
    });

    if (match.tournamentRound === tournament.bracketRounds) {
      await tx.tournamentTeam.update({
        where: { id: winnerTeamId },
        data: { status: TournamentTeamStatus.CHAMPION, placement: 1 },
      });
      await this.settle(tx, tournament, winnerTeamId, loserTeamId, matchId);
      return;
    }

    const nextRound = match.tournamentRound + 1;
    const nextSlot = Math.floor(match.tournamentSlot / 2);
    const sourceSlots = [nextSlot * 2, nextSlot * 2 + 1];
    const sources = await tx.gameMatch.findMany({
      where: {
        tournamentId: match.tournamentId,
        tournamentRound: match.tournamentRound,
        tournamentSlot: { in: sourceSlots },
        resultAppliedAt: { not: null },
      },
      orderBy: { tournamentSlot: 'asc' },
      include: { seats: true },
    });
    if (sources.length !== 2) return;

    const winners = sources.map((source) => {
      const tournamentTeamId = source.seats.find(
        (seat) => seat.team === source.winnerTeam,
      )?.tournamentTeamId;
      if (!tournamentTeamId)
        throw new ConflictException('A bracket source has no winner team.');
      const users = source.seats
        .filter((seat) => seat.tournamentTeamId === tournamentTeamId)
        .sort((a, b) => a.seat - b.seat)
        .map((seat) => seat.userId) as [string, string];
      return { id: tournamentTeamId, users };
    });
    await this.createMatch(
      tx,
      match.tournamentId,
      nextRound,
      nextSlot,
      winners[0]!,
      winners[1]!,
    );
  }

  async correctResults(
    tournamentId: string,
    championUserIds: readonly string[],
    runnerUpUserIds: readonly string[],
    reason: string,
    requestId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedTournament[]>`
        SELECT "id", "name", "status", "prizePool", "bracketStartedAt",
               "bracketRounds", "settlementVersion"
        FROM "Tournament"
        WHERE "id" = ${tournamentId}
        FOR UPDATE
      `;
      const tournament = rows[0];
      if (!tournament) throw new NotFoundException('Tournament not found.');
      const duplicate = await tx.tournamentResultCorrection.findUnique({
        where: { tournamentId_requestId: { tournamentId, requestId } },
        select: { id: true },
      });
      if (duplicate) return this.summary(tx, tournamentId);
      if (
        tournament.status !== TournamentStatus.COMPLETED ||
        !tournament.bracketStartedAt
      ) {
        throw new UnprocessableEntityException(
          'Only a completed authoritative tournament can be corrected.',
        );
      }
      const submitted = [...championUserIds, ...runnerUpUserIds];
      if (new Set(submitted).size !== 4) {
        throw new UnprocessableEntityException(
          'The corrected finalist players must be distinct.',
        );
      }
      const registrations = await tx.tournamentRegistration.findMany({
        where: { tournamentId, userId: { in: submitted } },
        orderBy: { userId: 'asc' },
      });
      if (
        registrations.length !== 4 ||
        registrations.some((entry) => !entry.teamId)
      ) {
        throw new UnprocessableEntityException(
          'Every corrected finalist must be registered on a tournament team.',
        );
      }
      const teamFor = (ids: readonly string[]) => {
        const teams = new Set(
          registrations
            .filter((entry) => ids.includes(entry.userId))
            .map((entry) => entry.teamId),
        );
        if (teams.size !== 1) {
          throw new UnprocessableEntityException(
            'Each corrected placement must contain one complete two-player team.',
          );
        }
        return [...teams][0]!;
      };
      const championTeamId = teamFor(championUserIds);
      const runnerUpTeamId = teamFor(runnerUpUserIds);
      if (championTeamId === runnerUpTeamId) {
        throw new UnprocessableEntityException(
          'Champion and runner-up must be different teams.',
        );
      }

      const oldAwards = await tx.tournamentPrizeAward.findMany({
        where: {
          tournamentId,
          settlementVersion: tournament.settlementVersion,
          status: TournamentPrizeAwardStatus.CREDITED,
        },
      });
      for (const award of oldAwards) {
        const outcome = await recordLedgerEntry(tx, {
          userId: award.userId,
          type: TransactionType.PRIZE,
          amount: award.amount.negated(),
          allowNegativeBalance: true,
          reference: `tournament_prize_reversal:${tournamentId}:${award.userId}:v${award.settlementVersion}`,
          description: `${tournament.name} - corrected result reversal`,
          tournamentId,
        });
        if (outcome.outcome !== 'RECORDED') {
          throw new ConflictException(
            `Prize reversal failed: ${outcome.outcome}.`,
          );
        }
        await tx.tournamentPrizeAward.update({
          where: { id: award.id },
          data: {
            status: TournamentPrizeAwardStatus.REVERSED,
            reversalTransactionId: outcome.transaction.id,
            correctionReason: reason,
          },
        });
      }
      await tx.tournamentPrizeAward.updateMany({
        where: {
          tournamentId,
          settlementVersion: tournament.settlementVersion,
          status: TournamentPrizeAwardStatus.HELD,
        },
        data: {
          status: TournamentPrizeAwardStatus.REVERSED,
          correctionReason: reason,
        },
      });
      await tx.tournamentRegistration.updateMany({
        where: { tournamentId },
        data: { prizeWon: null },
      });
      await tx.tournamentTeam.updateMany({
        where: {
          tournamentId,
          status: {
            in: [TournamentTeamStatus.CHAMPION, TournamentTeamStatus.RUNNER_UP],
          },
        },
        data: { status: TournamentTeamStatus.ELIMINATED },
      });
      await tx.tournamentTeam.update({
        where: { id: championTeamId },
        data: { status: TournamentTeamStatus.CHAMPION, placement: 1 },
      });
      await tx.tournamentTeam.update({
        where: { id: runnerUpTeamId },
        data: { status: TournamentTeamStatus.RUNNER_UP, placement: 2 },
      });
      await tx.tournamentRegistration.updateMany({
        where: { teamId: championTeamId },
        data: { placement: 1 },
      });
      await tx.tournamentRegistration.updateMany({
        where: { teamId: runnerUpTeamId },
        data: { placement: 2 },
      });

      const version = tournament.settlementVersion + 1;
      const championPool = tournament.prizePool
        .mul('0.70')
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
      await this.creditCorrectionTeam(
        tx,
        tournament,
        championTeamId,
        1,
        championPool,
        version,
        reason,
      );
      await this.creditCorrectionTeam(
        tx,
        tournament,
        runnerUpTeamId,
        2,
        tournament.prizePool.minus(championPool),
        version,
        reason,
      );
      const heldCount = await tx.tournamentPrizeAward.count({
        where: {
          tournamentId,
          settlementVersion: version,
          status: TournamentPrizeAwardStatus.HELD,
        },
      });
      await tx.tournament.update({
        where: { id: tournamentId },
        data: {
          settlementVersion: version,
          settledAt: heldCount === 0 ? new Date() : null,
        },
      });
      await tx.tournamentResultCorrection.create({
        data: { tournamentId, requestId, reason, settlementVersion: version },
      });
      return this.summary(tx, tournamentId);
    });
  }

  async releaseHeldAwards(tournamentId: string, userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Tournament" WHERE "id" = ${tournamentId} FOR UPDATE`;
      const stillOpen = await tx.dispute.count({
        where: {
          tournamentId,
          userId,
          status: {
            in: [DisputeStatus.UNDER_REVIEW, DisputeStatus.APPEAL_FILED],
          },
        },
      });
      if (stillOpen > 0) return;
      const awards = await tx.tournamentPrizeAward.findMany({
        where: {
          tournamentId,
          userId,
          status: TournamentPrizeAwardStatus.HELD,
        },
        include: { tournament: { select: { name: true } } },
      });
      for (const award of awards) {
        const outcome = await recordLedgerEntry(tx, {
          userId,
          type: TransactionType.PRIZE,
          amount: award.amount,
          reference: `tournament_prize:${tournamentId}:${userId}:v${award.settlementVersion}`,
          description: `${award.tournament.name} - held prize released`,
          tournamentId,
        });
        if (outcome.outcome !== 'RECORDED')
          throw new ConflictException(
            `Held prize release failed: ${outcome.outcome}.`,
          );
        await tx.tournamentPrizeAward.update({
          where: { id: award.id },
          data: {
            status: TournamentPrizeAwardStatus.CREDITED,
            transactionId: outcome.transaction.id,
            holdReason: null,
          },
        });
        await tx.tournamentRegistration.update({
          where: { id: award.registrationId },
          data: { prizeWon: award.amount },
        });
      }
      const remaining = await tx.tournamentPrizeAward.count({
        where: { tournamentId, status: TournamentPrizeAwardStatus.HELD },
      });
      if (remaining === 0) {
        await tx.tournament.update({
          where: { id: tournamentId },
          data: { settledAt: new Date() },
        });
      }
    });
  }

  async disqualifyPlayer(
    tournamentId: string,
    userId: string,
    caseNumber: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Tournament" WHERE "id" = ${tournamentId} FOR UPDATE`;
      const registration = await tx.tournamentRegistration.findUnique({
        where: { tournamentId_userId: { tournamentId, userId } },
      });
      if (!registration) return;
      await tx.tournamentRegistration.update({
        where: { id: registration.id },
        data: { status: RegistrationStatus.DISQUALIFIED, prizeWon: null },
      });
      if (registration.teamId) {
        await tx.tournamentTeam.update({
          where: { id: registration.teamId },
          data: { status: TournamentTeamStatus.DISQUALIFIED },
        });
      }
      await tx.tournamentPrizeAward.updateMany({
        where: {
          tournamentId,
          userId,
          status: TournamentPrizeAwardStatus.HELD,
        },
        data: {
          status: TournamentPrizeAwardStatus.REVERSED,
          correctionReason: `Disqualified by ${caseNumber}.`,
        },
      });

      const match = await tx.gameMatch.findFirst({
        where: {
          tournamentId,
          status: { in: [GameMatchStatus.BIDDING, GameMatchStatus.PLAYING] },
          seats: { some: { userId } },
        },
        include: { seats: true },
      });
      if (!match) return;
      const seat = match.seats.find((entry) => entry.userId === userId)!
        .seat as Seat;
      const next = forfeitMatch(match.state as unknown as SpadesState, seat);
      await tx.gameMatch.update({
        where: { id: match.id },
        data: {
          state: next as unknown as Prisma.InputJsonValue,
          status: GameMatchStatus.FORFEITED,
          version: next.version,
          winnerTeam: next.winnerTeam,
          currentSeat: null,
          actionDeadlineAt: null,
          completedAt: new Date(),
          events: {
            create: {
              sequence: next.version,
              type: GameEventType.PLAYER_FORFEITED,
              actorUserId: null,
              payload: {
                seat,
                winnerTeam: next.winnerTeam,
                source: 'DISQUALIFICATION',
                caseNumber,
              },
            },
          },
        },
      });
      await this.applyCompletedMatch(tx, match.id);
    });
  }

  private async creditCorrectionTeam(
    tx: TransactionClient,
    tournament: LockedTournament,
    teamId: string,
    placement: number,
    teamPool: Prisma.Decimal,
    version: number,
    reason: string,
  ): Promise<void> {
    const registrations = await tx.tournamentRegistration.findMany({
      where: { teamId },
      orderBy: { userId: 'asc' },
    });
    const first = teamPool.div(2).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
    const amounts = [first, teamPool.minus(first)];
    for (let index = 0; index < registrations.length; index += 1) {
      const registration = registrations[index]!;
      const amount = amounts[index]!;
      const held = await tx.dispute.findFirst({
        where: {
          userId: registration.userId,
          tournamentId: tournament.id,
          status: {
            in: [DisputeStatus.UNDER_REVIEW, DisputeStatus.APPEAL_FILED],
          },
        },
        select: { caseNumber: true },
      });
      if (held) {
        await tx.tournamentPrizeAward.create({
          data: {
            tournamentId: tournament.id,
            registrationId: registration.id,
            userId: registration.userId,
            placement,
            amount,
            settlementVersion: version,
            status: TournamentPrizeAwardStatus.HELD,
            holdReason: `Dispute ${held.caseNumber} is pending.`,
            correctionReason: reason,
          },
        });
        continue;
      }
      const outcome = await recordLedgerEntry(tx, {
        userId: registration.userId,
        type: TransactionType.PRIZE,
        amount,
        reference: `tournament_prize:${tournament.id}:${registration.userId}:v${version}`,
        description: `${tournament.name} - corrected ${placement === 1 ? '1st' : '2nd'} Place`,
        tournamentId: tournament.id,
      });
      if (outcome.outcome !== 'RECORDED')
        throw new ConflictException(
          `Corrected prize failed: ${outcome.outcome}.`,
        );
      await tx.tournamentPrizeAward.create({
        data: {
          tournamentId: tournament.id,
          registrationId: registration.id,
          userId: registration.userId,
          placement,
          amount,
          settlementVersion: version,
          status: TournamentPrizeAwardStatus.CREDITED,
          transactionId: outcome.transaction.id,
          correctionReason: reason,
        },
      });
      await tx.tournamentRegistration.update({
        where: { id: registration.id },
        data: { prizeWon: amount },
      });
    }
  }

  private async settle(
    tx: TransactionClient,
    tournament: LockedTournament,
    championTeamId: string,
    runnerUpTeamId: string,
    finalMatchId: string,
  ): Promise<void> {
    const version = tournament.settlementVersion + 1;
    const championPool = tournament.prizePool
      .mul('0.70')
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
    const runnerUpPool = tournament.prizePool.minus(championPool);

    const allTeams = await tx.tournamentTeam.findMany({
      where: { tournamentId: tournament.id },
      include: { registrations: { orderBy: { userId: 'asc' } } },
    });
    for (const team of allTeams) {
      if (team.placement) {
        await tx.tournamentRegistration.updateMany({
          where: { teamId: team.id },
          data: { placement: team.placement },
        });
      }
    }

    for (const [teamId, placement, teamPool] of [
      [championTeamId, 1, championPool],
      [runnerUpTeamId, 2, runnerUpPool],
    ] as const) {
      const team = allTeams.find((entry) => entry.id === teamId);
      if (!team || team.registrations.length !== 2) {
        throw new ConflictException(
          'A prize-winning team must contain exactly two players.',
        );
      }
      if (team.status === TournamentTeamStatus.DISQUALIFIED) continue;
      const firstAmount = teamPool
        .div(2)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
      const amounts = [firstAmount, teamPool.minus(firstAmount)];

      for (let index = 0; index < team.registrations.length; index += 1) {
        const registration = team.registrations[index]!;
        const amount = amounts[index]!;
        const held = await tx.dispute.findFirst({
          where: {
            userId: registration.userId,
            status: {
              in: [DisputeStatus.UNDER_REVIEW, DisputeStatus.APPEAL_FILED],
            },
            OR: [
              { tournamentId: tournament.id },
              { matchReference: finalMatchId },
            ],
          },
          select: { caseNumber: true },
        });

        if (held) {
          await tx.tournamentPrizeAward.create({
            data: {
              tournamentId: tournament.id,
              registrationId: registration.id,
              userId: registration.userId,
              placement,
              amount,
              settlementVersion: version,
              status: TournamentPrizeAwardStatus.HELD,
              holdReason: `Dispute ${held.caseNumber} is pending.`,
            },
          });
          continue;
        }

        const outcome = await recordLedgerEntry(tx, {
          userId: registration.userId,
          type: TransactionType.PRIZE,
          amount,
          reference: `tournament_prize:${tournament.id}:${registration.userId}:v${version}`,
          description: `${tournament.name} - ${placement === 1 ? '1st' : '2nd'} Place`,
          tournamentId: tournament.id,
        });
        if (outcome.outcome !== 'RECORDED') {
          throw new ConflictException(
            `Prize ledger entry failed: ${outcome.outcome}.`,
          );
        }
        await tx.tournamentPrizeAward.create({
          data: {
            tournamentId: tournament.id,
            registrationId: registration.id,
            userId: registration.userId,
            placement,
            amount,
            settlementVersion: version,
            status: TournamentPrizeAwardStatus.CREDITED,
            transactionId: outcome.transaction.id,
          },
        });
        await tx.tournamentRegistration.update({
          where: { id: registration.id },
          data: { prizeWon: amount },
        });
      }
    }

    const heldCount = await tx.tournamentPrizeAward.count({
      where: {
        tournamentId: tournament.id,
        settlementVersion: version,
        status: TournamentPrizeAwardStatus.HELD,
      },
    });
    await tx.tournament.update({
      where: { id: tournament.id },
      data: {
        status: TournamentStatus.COMPLETED,
        settlementVersion: version,
        settledAt: heldCount === 0 ? new Date() : null,
      },
    });
  }

  private async createMatch(
    tx: TransactionClient,
    tournamentId: string,
    round: number,
    slot: number,
    teamOne: { id: string; users: [string, string] },
    teamTwo: { id: string; users: [string, string] },
  ): Promise<void> {
    const state = createSpadesState();
    const seats = [
      {
        userId: teamOne.users[0],
        seat: 0,
        team: 0,
        tournamentTeamId: teamOne.id,
      },
      {
        userId: teamTwo.users[0],
        seat: 1,
        team: 1,
        tournamentTeamId: teamTwo.id,
      },
      {
        userId: teamOne.users[1],
        seat: 2,
        team: 0,
        tournamentTeamId: teamOne.id,
      },
      {
        userId: teamTwo.users[1],
        seat: 3,
        team: 1,
        tournamentTeamId: teamTwo.id,
      },
    ];
    await tx.gameMatch.create({
      data: {
        tournamentId,
        tournamentRound: round,
        tournamentSlot: slot,
        status: GameMatchStatus.BIDDING,
        rulesVersion: SPADES_RULESET_VERSION,
        creationRequestId: `tournament:${tournamentId}:r${round}:s${slot}`,
        createdByPlayerId: teamOne.users[0],
        state: state as unknown as Prisma.InputJsonValue,
        version: state.version,
        handNumber: state.handNumber,
        dealerSeat: state.dealerSeat,
        currentSeat: state.currentSeat,
        actionDeadlineAt: nextDeadline(),
        seats: { create: seats },
        events: {
          create: {
            sequence: state.version,
            type: GameEventType.MATCH_CREATED,
            actorUserId: null,
            payload: { source: 'TOURNAMENT', tournamentId, round, slot },
          },
        },
      },
    });
  }

  private async cancelUnstartable(
    tx: TransactionClient,
    tournamentId: string,
  ): Promise<void> {
    const fees = await tx.transaction.findMany({
      where: { tournamentId, type: TransactionType.ENTRY_FEE },
      select: { userId: true, amount: true, reference: true },
    });
    for (const fee of fees) {
      if (!fee.reference) continue;
      const reference = fee.reference.replace(/^entry_fee:/, 'refund:');
      if (
        await tx.transaction.findUnique({
          where: { reference },
          select: { id: true },
        })
      )
        continue;
      const outcome = await recordLedgerEntry(tx, {
        userId: fee.userId,
        type: TransactionType.REFUND,
        amount: fee.amount.negated(),
        reference,
        description:
          'Entry fee refunded — tournament could not form a valid bracket',
        tournamentId,
      });
      if (outcome.outcome !== 'RECORDED') {
        throw new ConflictException(
          `Tournament refund failed: ${outcome.outcome}.`,
        );
      }
    }
    await tx.tournamentRegistration.updateMany({
      where: {
        tournamentId,
        status: {
          in: [RegistrationStatus.REGISTERED, RegistrationStatus.CHECKED_IN],
        },
      },
      data: { status: RegistrationStatus.WITHDRAWN },
    });
    await tx.tournament.update({
      where: { id: tournamentId },
      data: {
        status: TournamentStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: 'Not enough eligible players to form a complete bracket.',
      },
    });
  }

  private async summary(tx: TransactionClient, tournamentId: string) {
    return tx.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
      include: { _count: { select: { teams: true, gameMatches: true } } },
    });
  }
}
