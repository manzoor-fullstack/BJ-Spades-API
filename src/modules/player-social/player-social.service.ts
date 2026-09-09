import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  GameChallengeStatus,
  GameMatchStatus,
  PlayerFriendshipStatus,
  Prisma,
  UserStatus,
} from '@prisma/client';

import { MatchesService } from '../matches/matches.service';
import { LeaderboardService } from '../leaderboards/leaderboard.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateChallengeDto } from './dto/create-challenge.dto';

const PRESENCE_TTL_MS = 60_000;
const CHALLENGE_TTL_MS = 2 * 60_000;
const OPEN_CHALLENGE_STATUSES: GameChallengeStatus[] = [
  GameChallengeStatus.PENDING,
  GameChallengeStatus.ACCEPTED,
];
const PLAYING_MATCH_STATUSES: GameMatchStatus[] = [
  GameMatchStatus.BIDDING,
  GameMatchStatus.PLAYING,
];

const playerSelect = {
  id: true,
  firstName: true,
  lastName: true,
  tier: true,
  credential: { select: { username: true } },
  playerProfile: {
    select: {
      displayName: true,
      avatarName: true,
      avatarBackground: true,
    },
  },
} satisfies Prisma.UserSelect;

const challengeInclude = {
  challenger: { select: playerSelect },
  challenged: { select: playerSelect },
} satisfies Prisma.GameChallengeInclude;

type ChallengeWithPlayers = Prisma.GameChallengeGetPayload<{
  include: typeof challengeInclude;
}>;

@Injectable()
export class PlayerSocialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matches: MatchesService,
    private readonly leaderboards: LeaderboardService,
  ) {}

  async heartbeat(playerId: string) {
    const now = new Date();
    await this.prisma.playerPresence.upsert({
      where: { userId: playerId },
      create: { userId: playerId, heartbeatAt: now },
      update: { heartbeatAt: now },
    });
    return {
      status: 'ONLINE',
      expiresAt: new Date(now.getTime() + PRESENCE_TTL_MS),
    };
  }

  async listFriends(playerId: string) {
    const now = new Date();
    await this.expireChallenges(this.prisma, now);
    const friendships = await this.prisma.playerFriendship.findMany({
      where: {
        status: PlayerFriendshipStatus.ACCEPTED,
        OR: [{ playerOneId: playerId }, { playerTwoId: playerId }],
      },
      include: {
        playerOne: { select: playerSelect },
        playerTwo: { select: playerSelect },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const friendIds = friendships.map((friendship) =>
      friendship.playerOneId === playerId
        ? friendship.playerTwoId
        : friendship.playerOneId,
    );
    const [presences, busySeats, challenges, rankings] = await Promise.all([
      this.prisma.playerPresence.findMany({
        where: { userId: { in: friendIds } },
        select: { userId: true, heartbeatAt: true },
      }),
      this.prisma.gameSeat.findMany({
        where: {
          userId: { in: friendIds },
          match: { status: { in: PLAYING_MATCH_STATUSES } },
        },
        select: { userId: true },
      }),
      this.prisma.gameChallenge.findMany({
        where: {
          AND: [
            {
              OR: [
                { challengerId: playerId, challengedId: { in: friendIds } },
                { challengedId: playerId, challengerId: { in: friendIds } },
              ],
            },
            {
              OR: [
                { status: { in: OPEN_CHALLENGE_STATUSES } },
                {
                  status: GameChallengeStatus.MATCHED,
                  match: { status: { in: PLAYING_MATCH_STATUSES } },
                },
              ],
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.leaderboards.entriesFor(friendIds),
    ]);
    const presenceByUser = new Map(
      presences.map((presence) => [presence.userId, presence.heartbeatAt]),
    );
    const busy = new Set(busySeats.map((seat) => seat.userId));

    return friendships.map((friendship) => {
      const friend =
        friendship.playerOneId === playerId
          ? friendship.playerTwo
          : friendship.playerOne;
      const challenge = challenges.find(
        (item) =>
          item.challengerId === friend.id || item.challengedId === friend.id,
      );
      const heartbeatAt = presenceByUser.get(friend.id);
      const ranking = rankings.get(friend.id);
      const status = busy.has(friend.id)
        ? 'INGAME'
        : heartbeatAt && heartbeatAt.getTime() > now.getTime() - PRESENCE_TTL_MS
          ? 'ONLINE'
          : 'OFFLINE';
      return {
        id: friend.id,
        username: friend.credential?.username ?? null,
        displayName:
          friend.playerProfile?.displayName ||
          friend.credential?.username ||
          `${friend.firstName} ${friend.lastName}`.trim(),
        avatarName: friend.playerProfile?.avatarName ?? 'Ace of Spades',
        avatarBackground: friend.playerProfile?.avatarBackground ?? '#7c3aed',
        tier: friend.tier,
        elo: ranking?.rating ?? null,
        winRate: ranking?.winRate ?? null,
        rankingTier: ranking?.tier ?? null,
        status,
        challenge: challenge
          ? {
              id: challenge.id,
              direction:
                challenge.challengerId === playerId ? 'OUTGOING' : 'INCOMING',
              status: challenge.status,
              expiresAt: challenge.expiresAt.toISOString(),
              matchId: challenge.matchId,
            }
          : null,
      };
    });
  }

  async listFriendRequests(playerId: string) {
    const requests = await this.prisma.playerFriendship.findMany({
      where: {
        status: PlayerFriendshipStatus.PENDING,
        OR: [{ playerOneId: playerId }, { playerTwoId: playerId }],
      },
      include: {
        playerOne: { select: playerSelect },
        playerTwo: { select: playerSelect },
      },
      orderBy: { createdAt: 'desc' },
    });
    return requests.map((request) => {
      const other =
        request.playerOneId === playerId
          ? request.playerTwo
          : request.playerOne;
      return {
        id: request.id,
        direction: request.requestedById === playerId ? 'OUTGOING' : 'INCOMING',
        createdAt: request.createdAt.toISOString(),
        player: {
          id: other.id,
          username: other.credential?.username ?? null,
          displayName:
            other.playerProfile?.displayName ||
            other.credential?.username ||
            `${other.firstName} ${other.lastName}`.trim(),
        },
      };
    });
  }

  async requestFriend(playerId: string, otherPlayerId: string) {
    if (playerId === otherPlayerId) {
      throw new UnprocessableEntityException(
        'You cannot add yourself as a friend.',
      );
    }
    await this.assertPlayerAvailable(otherPlayerId);
    await this.assertNotBlocked(playerId, otherPlayerId);
    const [playerOneId, playerTwoId] = this.canonicalPair(
      playerId,
      otherPlayerId,
    );
    const existing = await this.prisma.playerFriendship.findUnique({
      where: { playerOneId_playerTwoId: { playerOneId, playerTwoId } },
    });
    if (existing?.status === PlayerFriendshipStatus.ACCEPTED) return existing;
    if (existing?.status === PlayerFriendshipStatus.PENDING) {
      throw new ConflictException('A friend request is already pending.');
    }
    return this.prisma.playerFriendship.upsert({
      where: { playerOneId_playerTwoId: { playerOneId, playerTwoId } },
      create: {
        playerOneId,
        playerTwoId,
        requestedById: playerId,
        status: PlayerFriendshipStatus.PENDING,
      },
      update: {
        requestedById: playerId,
        status: PlayerFriendshipStatus.PENDING,
        respondedAt: null,
      },
    });
  }

  async respondToFriend(playerId: string, requestId: string, accept: boolean) {
    const request = await this.prisma.playerFriendship.findUnique({
      where: { id: requestId },
    });
    if (
      !request ||
      ![request.playerOneId, request.playerTwoId].includes(playerId)
    ) {
      throw new NotFoundException('Friend request not found.');
    }
    if (request.requestedById === playerId) {
      throw new ForbiddenException('Only the receiving player can respond.');
    }
    if (request.status !== PlayerFriendshipStatus.PENDING) return request;
    await this.assertNotBlocked(request.playerOneId, request.playerTwoId);
    return this.prisma.playerFriendship.update({
      where: { id: request.id },
      data: {
        status: accept
          ? PlayerFriendshipStatus.ACCEPTED
          : PlayerFriendshipStatus.DECLINED,
        respondedAt: new Date(),
      },
    });
  }

  async removeFriend(playerId: string, friendId: string) {
    const [playerOneId, playerTwoId] = this.canonicalPair(playerId, friendId);
    await this.prisma.playerFriendship.deleteMany({
      where: { playerOneId, playerTwoId },
    });
    return { removed: true };
  }

  async block(playerId: string, blockedId: string) {
    if (playerId === blockedId) {
      throw new UnprocessableEntityException('You cannot block yourself.');
    }
    await this.assertPlayerAvailable(blockedId);
    const [playerOneId, playerTwoId] = this.canonicalPair(playerId, blockedId);
    await this.prisma.$transaction(async (tx) => {
      await tx.playerBlock.upsert({
        where: { blockerId_blockedId: { blockerId: playerId, blockedId } },
        create: { blockerId: playerId, blockedId },
        update: {},
      });
      await tx.playerFriendship.deleteMany({
        where: { playerOneId, playerTwoId },
      });
      await tx.gameChallenge.updateMany({
        where: {
          status: { in: OPEN_CHALLENGE_STATUSES },
          OR: [
            { challengerId: playerId, challengedId: blockedId },
            { challengerId: blockedId, challengedId: playerId },
          ],
        },
        data: { status: GameChallengeStatus.CANCELLED, resolvedAt: new Date() },
      });
    });
    return { blocked: true };
  }

  async unblock(playerId: string, blockedId: string) {
    await this.prisma.playerBlock.deleteMany({
      where: { blockerId: playerId, blockedId },
    });
    return { blocked: false };
  }

  async createChallenge(playerId: string, input: CreateChallengeDto) {
    if (playerId === input.friendId) {
      throw new UnprocessableEntityException('You cannot challenge yourself.');
    }
    const existingRequest = await this.prisma.gameChallenge.findUnique({
      where: {
        challengerId_requestId: {
          challengerId: playerId,
          requestId: input.requestId,
        },
      },
      include: challengeInclude,
    });
    if (existingRequest) return this.challengeView(existingRequest, playerId);

    await this.assertAcceptedFriend(playerId, input.friendId);
    await this.assertNotBlocked(playerId, input.friendId);
    await this.assertCanPlay(playerId);
    await this.assertCanPlay(input.friendId);
    const presence = await this.prisma.playerPresence.findUnique({
      where: { userId: input.friendId },
    });
    if (
      !presence ||
      presence.heartbeatAt.getTime() <= Date.now() - PRESENCE_TTL_MS
    ) {
      throw new ConflictException('This friend is offline.');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(8082026)`;
      const now = new Date();
      await this.expireChallenges(tx, now);
      const active = await tx.gameChallenge.findFirst({
        where: {
          status: { in: OPEN_CHALLENGE_STATUSES },
          OR: [
            { challengerId: playerId, challengedId: input.friendId },
            { challengerId: input.friendId, challengedId: playerId },
          ],
        },
      });
      if (active) throw new ConflictException('A challenge is already active.');
      return tx.gameChallenge.create({
        data: {
          challengerId: playerId,
          challengedId: input.friendId,
          requestId: input.requestId,
          expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
        },
        include: challengeInclude,
      });
    });
    return this.challengeView(created, playerId);
  }

  async getChallenge(playerId: string, challengeId: string) {
    await this.expireChallenges(this.prisma, new Date());
    const challenge = await this.prisma.gameChallenge.findUnique({
      where: { id: challengeId },
      include: challengeInclude,
    });
    this.assertChallengeParticipant(challenge, playerId);
    return this.challengeView(challenge, playerId);
  }

  async acceptChallenge(playerId: string, challengeId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(8082026)`;
      const now = new Date();
      await this.expireChallenges(tx, now);
      const challenge = await tx.gameChallenge.findUnique({
        where: { id: challengeId },
        include: challengeInclude,
      });
      this.assertChallengeParticipant(challenge, playerId);
      if (challenge.challengedId !== playerId) {
        throw new ForbiddenException('Only the challenged player can accept.');
      }
      if (challenge.status === GameChallengeStatus.MATCHED) {
        return this.challengeView(challenge, playerId);
      }
      if (
        challenge.status !== GameChallengeStatus.PENDING &&
        challenge.status !== GameChallengeStatus.ACCEPTED
      ) {
        throw new ConflictException('This challenge is no longer available.');
      }
      await this.assertPairCanPlay(
        tx,
        challenge.challengerId,
        challenge.challengedId,
      );
      const accepted =
        challenge.status === GameChallengeStatus.ACCEPTED
          ? challenge
          : await tx.gameChallenge.update({
              where: { id: challengeId },
              data: { status: GameChallengeStatus.ACCEPTED, acceptedAt: now },
              include: challengeInclude,
            });

      const waiting = await tx.gameChallenge.findMany({
        where: {
          id: { not: accepted.id },
          status: GameChallengeStatus.ACCEPTED,
          matchId: null,
          expiresAt: { gt: now },
        },
        orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }],
        include: challengeInclude,
      });
      const participantIds = new Set([
        accepted.challengerId,
        accepted.challengedId,
      ]);
      const opponentPair = waiting.find(
        (item) =>
          !participantIds.has(item.challengerId) &&
          !participantIds.has(item.challengedId),
      );
      if (!opponentPair) return this.challengeView(accepted, playerId);

      await this.assertPairCanPlay(
        tx,
        opponentPair.challengerId,
        opponentPair.challengedId,
      );
      const matchId = await this.matches.createForAcceptedTeams(
        tx,
        [accepted.challengerId, accepted.challengedId],
        [opponentPair.challengerId, opponentPair.challengedId],
        `${accepted.id}:${opponentPair.id}`,
      );
      await tx.gameChallenge.updateMany({
        where: { id: { in: [accepted.id, opponentPair.id] } },
        data: {
          status: GameChallengeStatus.MATCHED,
          matchId,
          resolvedAt: now,
        },
      });
      const matched = await tx.gameChallenge.findUniqueOrThrow({
        where: { id: accepted.id },
        include: challengeInclude,
      });
      return this.challengeView(matched, playerId);
    });
  }

  async resolveChallenge(
    playerId: string,
    challengeId: string,
    resolution: 'DECLINED' | 'CANCELLED',
  ) {
    const challenge = await this.prisma.gameChallenge.findUnique({
      where: { id: challengeId },
      include: challengeInclude,
    });
    this.assertChallengeParticipant(challenge, playerId);
    if (resolution === 'DECLINED' && challenge.challengedId !== playerId) {
      throw new ForbiddenException('Only the challenged player can decline.');
    }
    if (resolution === 'CANCELLED' && challenge.challengerId !== playerId) {
      throw new ForbiddenException('Only the challenger can cancel.');
    }
    if (!OPEN_CHALLENGE_STATUSES.includes(challenge.status)) {
      if (challenge.status === GameChallengeStatus[resolution]) {
        return this.challengeView(challenge, playerId);
      }
      throw new ConflictException('This challenge is no longer available.');
    }
    const updated = await this.prisma.gameChallenge.update({
      where: { id: challengeId },
      data: {
        status: GameChallengeStatus[resolution],
        resolvedAt: new Date(),
      },
      include: challengeInclude,
    });
    return this.challengeView(updated, playerId);
  }

  private async assertPlayerAvailable(playerId: string) {
    const player = await this.prisma.user.findFirst({
      where: {
        id: playerId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        emailVerified: true,
      },
      select: { id: true },
    });
    if (!player) throw new NotFoundException('Player not found.');
  }

  private async assertAcceptedFriend(playerId: string, friendId: string) {
    const [playerOneId, playerTwoId] = this.canonicalPair(playerId, friendId);
    const friendship = await this.prisma.playerFriendship.findUnique({
      where: { playerOneId_playerTwoId: { playerOneId, playerTwoId } },
    });
    if (friendship?.status !== PlayerFriendshipStatus.ACCEPTED) {
      throw new ForbiddenException('Only accepted friends can be challenged.');
    }
  }

  private async assertNotBlocked(playerId: string, otherPlayerId: string) {
    const block = await this.prisma.playerBlock.findFirst({
      where: {
        OR: [
          { blockerId: playerId, blockedId: otherPlayerId },
          { blockerId: otherPlayerId, blockedId: playerId },
        ],
      },
      select: { id: true },
    });
    if (block) throw new ForbiddenException('This player is unavailable.');
  }

  private async assertCanPlay(playerId: string) {
    const busy = await this.prisma.gameSeat.findFirst({
      where: {
        userId: playerId,
        match: { status: { in: PLAYING_MATCH_STATUSES } },
      },
      select: { id: true },
    });
    if (busy) throw new ConflictException('This player is already in a game.');
  }

  private async assertPairCanPlay(
    tx: Prisma.TransactionClient,
    firstId: string,
    secondId: string,
  ) {
    const busy = await tx.gameSeat.findFirst({
      where: {
        userId: { in: [firstId, secondId] },
        match: { status: { in: PLAYING_MATCH_STATUSES } },
      },
      select: { id: true },
    });
    const block = await tx.playerBlock.findFirst({
      where: {
        OR: [
          { blockerId: firstId, blockedId: secondId },
          { blockerId: secondId, blockedId: firstId },
        ],
      },
      select: { id: true },
    });
    if (busy) throw new ConflictException('A player is already in a game.');
    if (block) throw new ForbiddenException('This player is unavailable.');
  }

  private expireChallenges(
    db: PrismaService | Prisma.TransactionClient,
    now: Date,
  ) {
    return db.gameChallenge.updateMany({
      where: {
        status: { in: OPEN_CHALLENGE_STATUSES },
        expiresAt: { lte: now },
      },
      data: { status: GameChallengeStatus.EXPIRED, resolvedAt: now },
    });
  }

  private canonicalPair(firstId: string, secondId: string): [string, string] {
    return firstId < secondId ? [firstId, secondId] : [secondId, firstId];
  }

  private assertChallengeParticipant(
    challenge: ChallengeWithPlayers | null,
    playerId: string,
  ): asserts challenge is ChallengeWithPlayers {
    if (
      !challenge ||
      (challenge.challengerId !== playerId &&
        challenge.challengedId !== playerId)
    ) {
      throw new NotFoundException('Challenge not found.');
    }
  }

  private challengeView(challenge: ChallengeWithPlayers, playerId: string) {
    const opponent =
      challenge.challengerId === playerId
        ? challenge.challenged
        : challenge.challenger;
    return {
      id: challenge.id,
      status: challenge.status,
      direction: challenge.challengerId === playerId ? 'OUTGOING' : 'INCOMING',
      expiresAt: challenge.expiresAt.toISOString(),
      acceptedAt: challenge.acceptedAt?.toISOString() ?? null,
      matchId: challenge.matchId,
      opponent: {
        id: opponent.id,
        username: opponent.credential?.username ?? null,
        displayName:
          opponent.playerProfile?.displayName ||
          opponent.credential?.username ||
          `${opponent.firstName} ${opponent.lastName}`.trim(),
      },
    };
  }
}
