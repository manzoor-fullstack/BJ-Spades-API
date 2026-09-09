import { Injectable } from '@nestjs/common';
import { GameMatchStatus, RegistrationStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { LeaderboardSource } from './leaderboard.types';

@Injectable()
export class LeaderboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  async revision(): Promise<string> {
    const [matches, users, profiles, disqualifications] = await Promise.all([
      this.prisma.gameMatch.aggregate({
        where: {
          completedAt: { not: null },
          winnerTeam: { not: null },
          status: {
            in: [GameMatchStatus.COMPLETED, GameMatchStatus.FORFEITED],
          },
        },
        _count: { id: true },
        _max: { updatedAt: true },
      }),
      this.prisma.user.aggregate({
        _count: { id: true },
        _max: { updatedAt: true },
      }),
      this.prisma.playerProfile.aggregate({
        _count: { id: true },
        _max: { updatedAt: true },
      }),
      this.prisma.tournamentRegistration.findMany({
        where: { status: RegistrationStatus.DISQUALIFIED },
        orderBy: { id: 'asc' },
        select: { id: true },
      }),
    ]);
    return [
      matches._count.id,
      matches._max.updatedAt?.toISOString() ?? '',
      users._count.id,
      users._max.updatedAt?.toISOString() ?? '',
      profiles._count.id,
      profiles._max.updatedAt?.toISOString() ?? '',
      disqualifications.map((item) => item.id).join(','),
    ].join(':');
  }

  async source(): Promise<LeaderboardSource> {
    const [players, seats, disqualified] = await Promise.all([
      this.prisma.user.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          country: true,
          status: true,
          credential: { select: { username: true } },
          playerProfile: {
            select: {
              displayName: true,
              avatarBackground: true,
              leaderboardVisible: true,
            },
          },
        },
      }),
      this.prisma.gameSeat.findMany({
        where: {
          match: {
            completedAt: { not: null },
            winnerTeam: { not: null },
            status: {
              in: [GameMatchStatus.COMPLETED, GameMatchStatus.FORFEITED],
            },
          },
        },
        select: {
          userId: true,
          team: true,
          match: {
            select: {
              id: true,
              completedAt: true,
              winnerTeam: true,
              tournamentId: true,
            },
          },
        },
      }),
      this.prisma.tournamentRegistration.findMany({
        where: { status: RegistrationStatus.DISQUALIFIED },
        select: { tournamentId: true, userId: true },
      }),
    ]);

    const disqualifiedKeys = new Set(
      disqualified.map((item) => `${item.tournamentId}:${item.userId}`),
    );
    const matches = new Map<string, LeaderboardSource['matches'][number]>();
    for (const seat of seats) {
      let match = matches.get(seat.match.id);
      if (!match) {
        match = {
          id: seat.match.id,
          completedAt: seat.match.completedAt!,
          winnerTeam: seat.match.winnerTeam!,
          seats: [],
        };
        matches.set(seat.match.id, match);
      }
      match.seats.push({
        userId: seat.userId,
        team: seat.team,
        disqualified: seat.match.tournamentId
          ? disqualifiedKeys.has(`${seat.match.tournamentId}:${seat.userId}`)
          : false,
      });
    }

    return {
      players: players.map((player) => ({
        id: player.id,
        displayName:
          player.playerProfile?.displayName ||
          player.credential?.username ||
          `${player.firstName} ${player.lastName}`.trim(),
        country: player.country,
        avatarBackground: player.playerProfile?.avatarBackground ?? '#a855f7',
        status: player.status,
        visible: player.playerProfile?.leaderboardVisible ?? true,
      })),
      matches: [...matches.values()],
    };
  }
}
