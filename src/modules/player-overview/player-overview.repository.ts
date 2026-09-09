import { Injectable } from '@nestjs/common';
import {
  GameMatchStatus,
  RegistrationStatus,
  TournamentStatus,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { PlayerOverviewSource } from './player-overview.types';

@Injectable()
export class PlayerOverviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async sourceFor(userId: string): Promise<PlayerOverviewSource | null> {
    const [user, seats, tournamentWins, prizeEntries] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { firstName: true },
      }),
      this.prisma.gameSeat.findMany({
        where: {
          userId,
          match: {
            completedAt: { not: null },
            winnerTeam: { not: null },
            status: {
              in: [GameMatchStatus.COMPLETED, GameMatchStatus.FORFEITED],
            },
          },
        },
        select: {
          seat: true,
          team: true,
          match: {
            select: {
              id: true,
              status: true,
              winnerTeam: true,
              completedAt: true,
              events: {
                orderBy: { sequence: 'asc' },
                select: {
                  sequence: true,
                  type: true,
                  payload: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.tournamentRegistration.findMany({
        where: {
          userId,
          placement: 1,
          status: {
            in: [RegistrationStatus.REGISTERED, RegistrationStatus.CHECKED_IN],
          },
          tournament: { status: TournamentStatus.COMPLETED },
        },
        select: {
          tournament: {
            select: {
              xpMultiplier: true,
              settledAt: true,
              updatedAt: true,
            },
          },
        },
      }),
      this.prisma.transaction.findMany({
        where: {
          userId,
          type: TransactionType.PRIZE,
          status: {
            in: [TransactionStatus.COMPLETED, TransactionStatus.REVERSED],
          },
          affectsBalance: true,
        },
        select: { amount: true, createdAt: true },
      }),
    ]);

    if (!user) return null;

    return {
      firstName: user.firstName,
      matches: seats.map(({ seat, team, match }) => ({
        id: match.id,
        seat,
        team,
        status: match.status,
        winnerTeam: match.winnerTeam!,
        completedAt: match.completedAt!,
        events: match.events,
      })),
      tournamentWins: tournamentWins.map(({ tournament }) => ({
        completedAt: tournament.settledAt ?? tournament.updatedAt,
        xpMultiplier: tournament.xpMultiplier,
      })),
      prizeEntries,
    };
  }
}
