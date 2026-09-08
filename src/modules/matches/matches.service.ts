import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  GameCommandType,
  GameEventType,
  GameMatchStatus,
  Prisma,
  UserStatus,
} from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { CreateMatchDto } from './dto/create-match.dto';
import { SubmitGameCommandDto } from './dto/submit-game-command.dto';
import {
  applyTurnTimeout,
  createSpadesState,
  forfeitMatch,
  placeBid,
  playCard,
  publicStateForSeat,
  SpadesRuleError,
} from './engine/spades.engine';
import {
  SPADES_RULES_V1,
  SPADES_RULESET_VERSION,
  type Card,
  type Seat,
  type SpadesState,
} from './engine/spades.types';

const ENTRY_TOKEN_TTL_MS = 15 * 60 * 1000;

const matchInclude = {
  seats: {
    orderBy: { seat: 'asc' as const },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          credential: { select: { username: true } },
          playerProfile: { select: { displayName: true } },
        },
      },
    },
  },
} satisfies Prisma.GameMatchInclude;

type MatchWithSeats = Prisma.GameMatchGetPayload<{
  include: typeof matchInclude;
}>;

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(tokenHash(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decodeState(value: Prisma.JsonValue): SpadesState {
  const state = value as unknown as SpadesState;
  if (
    state.rulesVersion !== SPADES_RULESET_VERSION ||
    !Array.isArray(state.hands) ||
    state.hands.length !== SPADES_RULES_V1.playerCount ||
    !Number.isInteger(state.version)
  ) {
    throw new ConflictException('The persisted match snapshot is invalid.');
  }
  return state;
}

function statusFor(state: SpadesState): GameMatchStatus {
  switch (state.phase) {
    case 'BIDDING':
      return GameMatchStatus.BIDDING;
    case 'PLAYING':
      return GameMatchStatus.PLAYING;
    case 'COMPLETED':
      return GameMatchStatus.COMPLETED;
    case 'FORFEITED':
      return GameMatchStatus.FORFEITED;
  }
}

@Injectable()
export class MatchesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(playerId: string, input: CreateMatchDto) {
    if (input.opponentIds.includes(playerId)) {
      throw new UnprocessableEntityException(
        'The creating player cannot also be an opponent.',
      );
    }

    const existing = await this.prisma.gameMatch.findUnique({
      where: {
        createdByPlayerId_creationRequestId: {
          createdByPlayerId: playerId,
          creationRequestId: input.requestId,
        },
      },
      include: matchInclude,
    });
    if (existing) return this.viewFor(existing, playerId, false);

    const players = await this.prisma.user.findMany({
      where: {
        id: { in: [playerId, ...input.opponentIds] },
        status: UserStatus.ACTIVE,
        deletedAt: null,
        emailVerified: true,
      },
      select: { id: true },
    });
    if (players.length !== SPADES_RULES_V1.playerCount) {
      throw new UnprocessableEntityException(
        'A match requires four distinct active, verified players.',
      );
    }

    const state = createSpadesState();
    const playerIds = [playerId, ...input.opponentIds];
    try {
      const match = await this.prisma.gameMatch.create({
        data: {
          status: GameMatchStatus.BIDDING,
          rulesVersion: SPADES_RULESET_VERSION,
          creationRequestId: input.requestId,
          createdByPlayerId: playerId,
          state: state as unknown as Prisma.InputJsonValue,
          version: state.version,
          handNumber: state.handNumber,
          dealerSeat: state.dealerSeat,
          currentSeat: state.currentSeat,
          actionDeadlineAt: this.nextDeadline(),
          seats: {
            create: playerIds.map((userId, seat) => ({
              userId,
              seat,
              team: seat % 2,
            })),
          },
          events: {
            create: {
              sequence: state.version,
              type: GameEventType.MATCH_CREATED,
              actorUserId: playerId,
              payload: {
                rulesVersion: SPADES_RULESET_VERSION,
                dealerSeat: state.dealerSeat,
                currentSeat: state.currentSeat,
              },
            },
          },
        },
        include: matchInclude,
      });
      return this.viewFor(match, playerId, false);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const duplicate = await this.prisma.gameMatch.findUniqueOrThrow({
          where: {
            createdByPlayerId_creationRequestId: {
              createdByPlayerId: playerId,
              creationRequestId: input.requestId,
            },
          },
          include: matchInclude,
        });
        return this.viewFor(duplicate, playerId, false);
      }
      throw error;
    }
  }

  /**
   * Creates the F07 match inside the caller's transaction. F08 uses this only
   * after both two-player friend challenges have been accepted. Team members
   * are deliberately placed opposite each other (0/2 and 1/3).
   */
  async createForAcceptedTeams(
    tx: Prisma.TransactionClient,
    teamOne: readonly [string, string],
    teamTwo: readonly [string, string],
    requestId: string,
  ): Promise<string> {
    const playerIds = [teamOne[0], teamTwo[0], teamOne[1], teamTwo[1]];
    const players = await tx.user.findMany({
      where: {
        id: { in: playerIds },
        status: UserStatus.ACTIVE,
        deletedAt: null,
        emailVerified: true,
      },
      select: { id: true },
    });
    if (players.length !== SPADES_RULES_V1.playerCount) {
      throw new UnprocessableEntityException(
        'A match requires four distinct active, verified players.',
      );
    }

    const state = createSpadesState();
    const match = await tx.gameMatch.create({
      data: {
        status: GameMatchStatus.BIDDING,
        rulesVersion: SPADES_RULESET_VERSION,
        creationRequestId: requestId,
        createdByPlayerId: teamOne[0],
        state: state as unknown as Prisma.InputJsonValue,
        version: state.version,
        handNumber: state.handNumber,
        dealerSeat: state.dealerSeat,
        currentSeat: state.currentSeat,
        actionDeadlineAt: this.nextDeadline(),
        seats: {
          create: playerIds.map((userId, seat) => ({
            userId,
            seat,
            team: seat % 2,
          })),
        },
        events: {
          create: {
            sequence: state.version,
            type: GameEventType.MATCH_CREATED,
            actorUserId: teamOne[0],
            payload: {
              rulesVersion: SPADES_RULESET_VERSION,
              dealerSeat: state.dealerSeat,
              currentSeat: state.currentSeat,
              source: 'FRIEND_CHALLENGE',
            },
          },
        },
      },
      select: { id: true },
    });
    return match.id;
  }

  async list(playerId: string) {
    const matches = await this.prisma.gameMatch.findMany({
      where: { seats: { some: { userId: playerId } } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: matchInclude,
    });
    return matches.map((match) => this.viewFor(match, playerId, false));
  }

  async join(playerId: string, matchId: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ENTRY_TOKEN_TTL_MS);
    const seat = await this.prisma.gameSeat.findUnique({
      where: { matchId_userId: { matchId, userId: playerId } },
      include: { match: { include: matchInclude } },
    });
    if (!seat) throw new NotFoundException('Match not found.');
    if (
      seat.match.status === GameMatchStatus.COMPLETED ||
      seat.match.status === GameMatchStatus.FORFEITED ||
      seat.match.status === GameMatchStatus.CANCELLED
    ) {
      throw new ConflictException('The match has already ended.');
    }
    await this.prisma.gameSeat.update({
      where: { id: seat.id },
      data: {
        entryTokenHash: tokenHash(token),
        entryTokenExpiresAt: expiresAt,
        joinedAt: new Date(),
      },
    });
    return {
      ...this.viewFor(seat.match, playerId, true),
      entryToken: token,
      entryTokenExpiresAt: expiresAt.toISOString(),
    };
  }

  async get(playerId: string, matchId: string, entryToken: string | undefined) {
    const match = await this.authorizedMatch(playerId, matchId, entryToken);
    return this.viewFor(match, playerId, true);
  }

  async revealHand(
    playerId: string,
    matchId: string,
    entryToken: string | undefined,
  ) {
    const match = await this.authorizedMatch(playerId, matchId, entryToken);
    const state = decodeState(match.state);
    const seat = match.seats.find((entry) => entry.userId === playerId)!;
    if (state.phase !== 'BIDDING' && state.phase !== 'PLAYING') {
      throw new ConflictException('The match has already ended.');
    }
    await this.prisma.gameSeat.update({
      where: { id: seat.id },
      data: { revealedHandNumber: state.handNumber },
    });
    seat.revealedHandNumber = state.handNumber;
    return this.viewFor(match, playerId, true);
  }

  async events(
    playerId: string,
    matchId: string,
    entryToken: string | undefined,
    after: number,
  ) {
    await this.authorizedMatch(playerId, matchId, entryToken);
    return this.prisma.gameEvent.findMany({
      where: { matchId, sequence: { gt: after } },
      orderBy: { sequence: 'asc' },
      take: 100,
      select: {
        sequence: true,
        type: true,
        actorUserId: true,
        payload: true,
        createdAt: true,
      },
    });
  }

  async command(
    playerId: string,
    matchId: string,
    entryToken: string | undefined,
    input: SubmitGameCommandDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "GameMatch" WHERE "id" = ${matchId} FOR UPDATE`;
      const match = await tx.gameMatch.findUnique({
        where: { id: matchId },
        include: matchInclude,
      });
      if (!match) throw new NotFoundException('Match not found.');
      const seatRecord = this.authorizeSeat(match, playerId, entryToken);
      const seat = seatRecord.seat as Seat;

      const duplicate = await tx.gameCommand.findUnique({
        where: {
          matchId_userId_idempotencyKey: {
            matchId,
            userId: playerId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (duplicate) {
        return { ...this.viewFor(match, playerId, true), duplicate: true };
      }
      if (match.version !== input.expectedVersion) {
        throw new ConflictException({
          message: 'Match version is stale.',
          currentVersion: match.version,
        });
      }

      const state = decodeState(match.state);
      let next: SpadesState;
      let eventType: GameEventType;
      let payload: Prisma.InputJsonObject;
      try {
        if (input.type === GameCommandType.BID) {
          if (
            input.blindNil &&
            seatRecord.revealedHandNumber >= state.handNumber
          ) {
            throw new UnprocessableEntityException(
              'Blind nil must be declared before revealing the hand.',
            );
          }
          next = placeBid(state, seat, {
            amount: input.bid!,
            blindNil: input.blindNil ?? false,
          });
          eventType = GameEventType.BID_PLACED;
          payload = {
            seat,
            bid: input.bid!,
            blindNil: input.blindNil ?? false,
          };
        } else if (input.type === GameCommandType.PLAY_CARD) {
          const previousHand = state.handNumber;
          const previousTrickSize = state.currentTrick.length;
          next = playCard(state, seat, input.card as Card);
          eventType =
            next.phase === 'COMPLETED'
              ? GameEventType.MATCH_COMPLETED
              : next.handNumber !== previousHand
                ? GameEventType.HAND_COMPLETED
                : previousTrickSize === 3
                  ? GameEventType.TRICK_COMPLETED
                  : GameEventType.CARD_PLAYED;
          payload = {
            seat,
            card: input.card!,
            phase: next.phase,
            handNumber: next.handNumber,
            teamScores: next.teamScores,
          };
        } else if (input.type === GameCommandType.CLAIM_TIMEOUT) {
          if (
            !match.actionDeadlineAt ||
            match.actionDeadlineAt.getTime() > Date.now()
          ) {
            throw new ConflictException('The current turn has not timed out.');
          }
          const timedOutSeat = state.currentSeat;
          next = applyTurnTimeout(state);
          eventType = GameEventType.TURN_TIMED_OUT;
          payload = {
            timedOutSeat,
            timeoutCount:
              timedOutSeat === null ? null : next.timeoutCounts[timedOutSeat],
            phase: next.phase,
            winnerTeam: next.winnerTeam,
          };
        } else {
          next = forfeitMatch(state, seat);
          eventType = GameEventType.PLAYER_FORFEITED;
          payload = { seat, winnerTeam: next.winnerTeam };
        }
      } catch (error) {
        if (error instanceof SpadesRuleError) {
          throw new UnprocessableEntityException(error.message);
        }
        throw error;
      }

      const ended = next.phase === 'COMPLETED' || next.phase === 'FORFEITED';
      const updated = await tx.gameMatch.update({
        where: { id: matchId },
        data: {
          state: next as unknown as Prisma.InputJsonValue,
          status: statusFor(next),
          version: next.version,
          handNumber: next.handNumber,
          dealerSeat: next.dealerSeat,
          currentSeat: next.currentSeat,
          winnerTeam: next.winnerTeam,
          actionDeadlineAt: ended ? null : this.nextDeadline(),
          completedAt: ended ? new Date() : null,
          commands: {
            create: {
              userId: playerId,
              idempotencyKey: input.idempotencyKey,
              expectedVersion: input.expectedVersion,
              resultVersion: next.version,
              type: input.type,
              payload: input as unknown as Prisma.InputJsonObject,
            },
          },
          events: {
            create: {
              sequence: next.version,
              type: eventType,
              actorUserId: playerId,
              payload,
            },
          },
        },
        include: matchInclude,
      });
      return { ...this.viewFor(updated, playerId, true), duplicate: false };
    });
  }

  private async authorizedMatch(
    playerId: string,
    matchId: string,
    token: string | undefined,
  ): Promise<MatchWithSeats> {
    const match = await this.prisma.gameMatch.findUnique({
      where: { id: matchId },
      include: matchInclude,
    });
    if (!match) throw new NotFoundException('Match not found.');
    this.authorizeSeat(match, playerId, token);
    return match;
  }

  private authorizeSeat(
    match: MatchWithSeats,
    playerId: string,
    token: string | undefined,
  ): MatchWithSeats['seats'][number] {
    const seat = match.seats.find((entry) => entry.userId === playerId);
    if (!seat) throw new NotFoundException('Match not found.');
    if (
      !token ||
      !seat.entryTokenHash ||
      !seat.entryTokenExpiresAt ||
      seat.entryTokenExpiresAt.getTime() <= Date.now() ||
      !tokenMatches(token, seat.entryTokenHash)
    ) {
      throw new UnauthorizedException(
        'Game entry authorization is invalid or expired.',
      );
    }
    if (seat.seat < 0 || seat.seat > 3) {
      throw new ForbiddenException('The assigned game seat is invalid.');
    }
    return seat;
  }

  private viewFor(
    match: MatchWithSeats,
    playerId: string,
    allowPrivateState: boolean,
  ) {
    const seat = match.seats.find((entry) => entry.userId === playerId);
    if (!seat || seat.seat < 0 || seat.seat > 3) {
      throw new NotFoundException('Match not found.');
    }
    const state = decodeState(match.state);
    return {
      id: match.id,
      status: match.status,
      rulesVersion: match.rulesVersion,
      seat: seat.seat,
      team: seat.team,
      actionDeadlineAt: match.actionDeadlineAt?.toISOString() ?? null,
      completedAt: match.completedAt?.toISOString() ?? null,
      players: match.seats.map((entry) => ({
        id: entry.user.id,
        seat: entry.seat,
        team: entry.team,
        username: entry.user.credential?.username ?? null,
        displayName:
          entry.user.playerProfile?.displayName ??
          `${entry.user.firstName} ${entry.user.lastName}`.trim(),
      })),
      state: publicStateForSeat(
        state,
        seat.seat as Seat,
        allowPrivateState &&
          (state.phase !== 'BIDDING' ||
            seat.revealedHandNumber >= state.handNumber),
      ),
    };
  }

  private nextDeadline(): Date {
    return new Date(Date.now() + SPADES_RULES_V1.turnSeconds * 1000);
  }
}
