import type { GameEventType, GameMatchStatus, Prisma } from '@prisma/client';

export interface PlayerOverviewMatch {
  id: string;
  seat: number;
  team: number;
  winnerTeam: number;
  status: GameMatchStatus;
  completedAt: Date;
  events: Array<{
    sequence: number;
    type: GameEventType;
    payload: Prisma.JsonValue;
  }>;
}

export interface PlayerOverviewTournamentWin {
  completedAt: Date;
  xpMultiplier: Prisma.Decimal;
}

export interface PlayerOverviewPrizeEntry {
  amount: Prisma.Decimal;
  createdAt: Date;
}

export interface PlayerOverviewSource {
  firstName: string;
  matches: PlayerOverviewMatch[];
  tournamentWins: PlayerOverviewTournamentWin[];
  prizeEntries: PlayerOverviewPrizeEntry[];
}
