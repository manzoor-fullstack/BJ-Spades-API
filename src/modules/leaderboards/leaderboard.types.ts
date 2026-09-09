import type { UserStatus } from '@prisma/client';

import type { LeaderboardPeriod } from './dto/leaderboard-query.dto';

export interface LeaderboardPlayerSource {
  id: string;
  displayName: string;
  country: string | null;
  avatarBackground: string;
  status: UserStatus;
  visible: boolean;
}

export interface LeaderboardMatchSource {
  id: string;
  completedAt: Date;
  winnerTeam: number;
  seats: Array<{
    userId: string;
    team: number;
    disqualified: boolean;
  }>;
}

export interface LeaderboardSource {
  players: LeaderboardPlayerSource[];
  matches: LeaderboardMatchSource[];
}

export interface LeaderboardEntry {
  playerId: string;
  rank: number;
  displayName: string;
  initials: string;
  avatarBackground: string;
  tier: string;
  rating: number;
  winRate: number;
  currentStreak: number;
  gamesPlayed: number;
  wins: number;
}

export interface LeaderboardView {
  formulaVersion: 'team-elo-v1';
  timeZone: 'UTC';
  period: LeaderboardPeriod;
  periodStart: string | null;
  periodEnd: string;
  asOf: string;
  items: LeaderboardEntry[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  me:
    | (LeaderboardEntry & {
        percentile: number;
        localRank: number | null;
        eligible: boolean;
      })
    | null;
}
