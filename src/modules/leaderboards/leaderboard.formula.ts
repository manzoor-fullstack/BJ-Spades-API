import { UserStatus } from '@prisma/client';

import { LeaderboardPeriod } from './dto/leaderboard-query.dto';
import type {
  LeaderboardEntry,
  LeaderboardSource,
  LeaderboardView,
} from './leaderboard.types';

export const LEADERBOARD_FORMULA_VERSION = 'team-elo-v1' as const;
export const LEADERBOARD_TIME_ZONE = 'UTC' as const;
const INITIAL_RATING = 1500;
const K_FACTOR = 24;

function startOfPeriod(period: LeaderboardPeriod, now: Date): Date | null {
  if (period === LeaderboardPeriod.ALL_TIME) return null;
  if (period === LeaderboardPeriod.TODAY) {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
  if (period === LeaderboardPeriod.WEEK) {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    return start;
  }
  if (period === LeaderboardPeriod.MONTH) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  const quarterMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(now.getUTCFullYear(), quarterMonth, 1));
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

function tierFor(rating: number): string {
  if (rating >= 2000) return 'Legend';
  if (rating >= 1800) return 'Table Boss';
  if (rating >= 1650) return 'Pro';
  return 'Regular';
}

function currentStreak(results: boolean[]): number {
  let result = 0;
  for (let index = results.length - 1; index >= 0 && results[index]; index -= 1)
    result += 1;
  return result;
}

interface MutableStats {
  rating: number;
  wins: number;
  results: boolean[];
}

export function buildLeaderboard(
  source: LeaderboardSource,
  viewerId: string,
  period: LeaderboardPeriod,
  page = 1,
  limit = 10,
  now: Date = new Date(),
): LeaderboardView {
  const periodStart = startOfPeriod(period, now);
  const eligiblePlayers = new Map(
    source.players
      .filter((player) => player.status === UserStatus.ACTIVE && player.visible)
      .map((player) => [player.id, player]),
  );
  const stats = new Map<string, MutableStats>();
  const getStats = (id: string) => {
    let value = stats.get(id);
    if (!value) {
      value = { rating: INITIAL_RATING, wins: 0, results: [] };
      stats.set(id, value);
    }
    return value;
  };

  const matches = source.matches
    .filter(
      (match) =>
        match.completedAt.getTime() < now.getTime() &&
        (!periodStart || match.completedAt.getTime() >= periodStart.getTime()),
    )
    .sort(
      (left, right) =>
        left.completedAt.getTime() - right.completedAt.getTime() ||
        left.id.localeCompare(right.id),
    );

  for (const match of matches) {
    const seats = match.seats.filter(
      (seat) => eligiblePlayers.has(seat.userId) && !seat.disqualified,
    );
    const teamZero = seats.filter((seat) => seat.team === 0);
    const teamOne = seats.filter((seat) => seat.team === 1);
    if (teamZero.length === 0 || teamOne.length === 0) continue;

    const average = (team: typeof seats) =>
      team.reduce((sum, seat) => sum + getStats(seat.userId).rating, 0) /
      team.length;
    const ratingZero = average(teamZero);
    const ratingOne = average(teamOne);
    const expectedZero = 1 / (1 + 10 ** ((ratingOne - ratingZero) / 400));
    const deltaZero = Math.round(
      K_FACTOR * ((match.winnerTeam === 0 ? 1 : 0) - expectedZero),
    );

    for (const seat of seats) {
      const won = seat.team === match.winnerTeam;
      const item = getStats(seat.userId);
      item.results.push(won);
      if (won) item.wins += 1;
      item.rating += seat.team === 0 ? deltaZero : -deltaZero;
    }
  }

  const entries = [...stats.entries()].map(([playerId, item]) => {
    const player = eligiblePlayers.get(playerId)!;
    const gamesPlayed = item.results.length;
    return {
      playerId,
      rank: 0,
      displayName: player.displayName,
      initials: initials(player.displayName),
      avatarBackground: player.avatarBackground,
      tier: tierFor(item.rating),
      rating: item.rating,
      winRate: Math.round((item.wins / gamesPlayed) * 100),
      currentStreak: currentStreak(item.results),
      gamesPlayed,
      wins: item.wins,
    } satisfies LeaderboardEntry;
  });

  entries.sort(
    (left, right) =>
      right.rating - left.rating ||
      right.wins - left.wins ||
      right.gamesPlayed - left.gamesPlayed ||
      left.displayName.localeCompare(right.displayName) ||
      left.playerId.localeCompare(right.playerId),
  );
  let prior: LeaderboardEntry | undefined;
  entries.forEach((entry, index) => {
    const tied =
      prior &&
      entry.rating === prior.rating &&
      entry.wins === prior.wins &&
      entry.gamesPlayed === prior.gamesPlayed;
    entry.rank = tied ? prior!.rank : index + 1;
    prior = entry;
  });

  const viewer = entries.find((entry) => entry.playerId === viewerId) ?? null;
  const viewerPlayer = source.players.find((player) => player.id === viewerId);
  let localRank: number | null = null;
  if (viewer && viewerPlayer?.country) {
    localRank =
      1 +
      entries.filter((entry) => {
        const player = eligiblePlayers.get(entry.playerId);
        return (
          player?.country === viewerPlayer.country &&
          (entry.rating > viewer.rating ||
            (entry.rating === viewer.rating && entry.wins > viewer.wins) ||
            (entry.rating === viewer.rating &&
              entry.wins === viewer.wins &&
              entry.gamesPlayed > viewer.gamesPlayed))
        );
      }).length;
  }
  const me = viewer
    ? {
        ...viewer,
        percentile: Math.max(
          1,
          Math.ceil((viewer.rank / entries.length) * 100),
        ),
        localRank,
        eligible: true,
      }
    : null;
  const offset = (page - 1) * limit;

  return {
    formulaVersion: LEADERBOARD_FORMULA_VERSION,
    timeZone: LEADERBOARD_TIME_ZONE,
    period,
    periodStart: periodStart?.toISOString() ?? null,
    periodEnd: now.toISOString(),
    asOf: now.toISOString(),
    items: entries.slice(offset, offset + limit),
    meta: {
      page,
      limit,
      total: entries.length,
      totalPages: Math.ceil(entries.length / limit),
    },
    me,
  };
}
