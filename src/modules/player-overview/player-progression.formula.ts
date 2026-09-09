import { GameEventType, Prisma } from '@prisma/client';

import { formatMoney } from '../../common/money/money.util';
import type {
  PlayerOverviewMatch,
  PlayerOverviewSource,
} from './player-overview.types';

export const PLAYER_PROGRESSION_FORMULA_VERSION =
  'player-progression-v1' as const;
export const PLAYER_STATS_TIME_ZONE = 'UTC' as const;

const PARTICIPATION_XP = 20;
const WIN_XP = 30;
const TOURNAMENT_WIN_XP = 250;

const RANKS = [
  { name: 'ROOKIE', threshold: 0 },
  { name: 'BRONZE', threshold: 500 },
  { name: 'SILVER', threshold: 1_500 },
  { name: 'GOLD', threshold: 3_500 },
  { name: 'PLATINUM', threshold: 7_000 },
  { name: 'DIAMOND', threshold: 12_000 },
  { name: 'MASTER', threshold: 20_000 },
] as const;

export type PlayerRank = (typeof RANKS)[number]['name'];

export interface PlayerAchievementView {
  code: 'FIRST_WIN' | 'NIL_MASTER' | 'PERFECT_GAME' | 'COMEBACK_KING';
  title: string;
  description: string;
  unlocked: boolean;
  progress: number;
  target: number;
}

export interface PlayerOverviewView {
  formulaVersion: typeof PLAYER_PROGRESSION_FORMULA_VERSION;
  timeZone: typeof PLAYER_STATS_TIME_ZONE;
  asOf: string;
  firstName: string;
  stats: {
    gamesPlayed: number;
    wins: number;
    losses: number;
    winRate: number;
    currentStreak: number;
    bestStreak: number;
    tournamentWins: number;
    totalWinnings: string;
    lastTenGames: Array<'W' | 'L'>;
  };
  trends: {
    gamesPlayed: number;
    tournamentWins: number;
    totalWinnings: string;
    winRatePoints: number;
  };
  progression: {
    xp: number;
    rank: PlayerRank;
    nextRank: PlayerRank | null;
    xpIntoRank: number;
    xpForNextRank: number;
    rankProgressPercent: number;
  };
  achievements: PlayerAchievementView[];
}

interface MatchAccomplishments {
  successfulNilBids: number;
  exactBidWin: boolean;
  comebackWin: boolean;
}

function payloadObject(value: Prisma.JsonValue): Prisma.JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function payloadNumber(payload: Prisma.JsonObject, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function payloadScores(payload: Prisma.JsonObject): [number, number] | null {
  const value = payload.teamScores;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((score) => typeof score !== 'number' || !Number.isFinite(score))
  ) {
    return null;
  }
  return [value[0] as number, value[1] as number];
}

const CARD_RANK = new Map(
  ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'].map(
    (rank, index) => [rank, index],
  ),
);

function trickWinner(
  cards: Array<{ seat: number; card: string }>,
): number | null {
  if (cards.length !== 4) return null;
  const leadSuit = cards[0]!.card.slice(-1);
  let winner = cards[0]!;
  for (const play of cards.slice(1)) {
    const suit = play.card.slice(-1);
    const winnerSuit = winner.card.slice(-1);
    const isBetterSuit =
      (suit === 'S' && winnerSuit !== 'S') ||
      (suit === leadSuit && winnerSuit !== 'S' && winnerSuit !== leadSuit);
    const sameSuitHigher =
      suit === winnerSuit &&
      (CARD_RANK.get(play.card.slice(0, -1)) ?? -1) >
        (CARD_RANK.get(winner.card.slice(0, -1)) ?? -1);
    if (isBetterSuit || sameSuitHigher) winner = play;
  }
  return winner.seat;
}

function analyzeMatch(
  match: PlayerOverviewMatch,
  playerSeat: number,
): MatchAccomplishments {
  const bids = new Map<number, number>();
  const tricks = new Map<number, number>();
  let currentTrick: Array<{ seat: number; card: string }> = [];
  let successfulNilBids = 0;
  let exactBid = false;
  let previousScores: [number, number] = [0, 0];
  let wasDownByTwoHundred = false;

  for (const event of match.events) {
    const payload = payloadObject(event.payload);
    if (event.type === GameEventType.BID_PLACED) {
      const seat = payloadNumber(payload, 'seat');
      const bid = payloadNumber(payload, 'bid');
      if (seat !== null && bid !== null) bids.set(seat, bid);
      continue;
    }

    const isCardEvent =
      event.type === GameEventType.CARD_PLAYED ||
      event.type === GameEventType.TRICK_COMPLETED ||
      event.type === GameEventType.HAND_COMPLETED ||
      event.type === GameEventType.MATCH_COMPLETED;
    if (!isCardEvent) {
      continue;
    }

    const seat = payloadNumber(payload, 'seat');
    const card = payload.card;
    if (
      seat !== null &&
      typeof card === 'string' &&
      /^[2-9TJQKA][CDHS]$/.test(card)
    ) {
      currentTrick.push({ seat, card });
    }
    if (currentTrick.length === 4) {
      const winner = trickWinner(currentTrick);
      if (winner !== null) tricks.set(winner, (tricks.get(winner) ?? 0) + 1);
      currentTrick = [];
    }

    if (
      event.type !== GameEventType.HAND_COMPLETED &&
      event.type !== GameEventType.MATCH_COMPLETED
    ) {
      continue;
    }

    const bid = bids.get(playerSeat);
    const wonTricks = tricks.get(playerSeat) ?? 0;
    if (bid === 0 && wonTricks === 0) successfulNilBids += 1;
    if (bid !== undefined && bid > 0 && bid === wonTricks) exactBid = true;

    const ownTeam = match.team === 1 ? 1 : 0;
    const opponentTeam = ownTeam === 0 ? 1 : 0;
    if (previousScores[opponentTeam] - previousScores[ownTeam] >= 200) {
      wasDownByTwoHundred = true;
    }
    previousScores = payloadScores(payload) ?? previousScores;
    bids.clear();
    tricks.clear();
    currentTrick = [];
  }

  const wonMatch = match.team === match.winnerTeam;
  return {
    successfulNilBids,
    exactBidWin: wonMatch && exactBid,
    comebackWin: wonMatch && wasDownByTwoHundred,
  };
}

function startOfUtcWeek(value: Date): Date {
  const start = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return start;
}

function startOfUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function inRange(value: Date, start: Date, end: Date): boolean {
  return value.getTime() >= start.getTime() && value.getTime() < end.getTime();
}

function rate(wins: number, games: number): number {
  return games === 0 ? 0 : Math.round((wins / games) * 100);
}

function streaks(results: boolean[]): { current: number; best: number } {
  let best = 0;
  let running = 0;
  for (const won of results) {
    running = won ? running + 1 : 0;
    best = Math.max(best, running);
  }

  let current = 0;
  for (const won of [...results].reverse()) {
    if (!won) break;
    current += 1;
  }
  return { current, best };
}

function progressionFor(xp: number): PlayerOverviewView['progression'] {
  let index = 0;
  for (let next = 1; next < RANKS.length; next += 1) {
    if (xp < RANKS[next]!.threshold) break;
    index = next;
  }
  const rank = RANKS[index]!;
  const next = RANKS[index + 1] ?? null;
  const xpIntoRank = xp - rank.threshold;
  const xpForNextRank = next ? next.threshold - rank.threshold : 0;
  return {
    xp,
    rank: rank.name,
    nextRank: next?.name ?? null,
    xpIntoRank,
    xpForNextRank,
    rankProgressPercent: next
      ? Math.min(100, Math.floor((xpIntoRank / xpForNextRank) * 100))
      : 100,
  };
}

export function buildPlayerOverview(
  source: PlayerOverviewSource,
  now: Date = new Date(),
): PlayerOverviewView {
  const matches = [...source.matches].sort(
    (left, right) => left.completedAt.getTime() - right.completedAt.getTime(),
  );
  const results = matches.map((match) => match.team === match.winnerTeam);
  const wins = results.filter(Boolean).length;
  const gamesPlayed = results.length;
  const streak = streaks(results);

  const weekStart = startOfUtcWeek(now);
  const previousWeekStart = new Date(weekStart.getTime() - 7 * 86_400_000);
  const monthStart = startOfUtcMonth(now);
  const previousMonthStart = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 1, 1),
  );

  const currentWeekMatches = matches.filter((match) =>
    inRange(match.completedAt, weekStart, now),
  );
  const previousWeekMatches = matches.filter((match) =>
    inRange(match.completedAt, previousWeekStart, weekStart),
  );
  const currentMonthMatches = matches.filter((match) =>
    inRange(match.completedAt, monthStart, now),
  );
  const previousMonthMatches = matches.filter((match) =>
    inRange(match.completedAt, previousMonthStart, monthStart),
  );
  const currentMonthWins = currentMonthMatches.filter(
    (match) => match.team === match.winnerTeam,
  ).length;
  const previousMonthWins = previousMonthMatches.filter(
    (match) => match.team === match.winnerTeam,
  ).length;

  const currentWeekTournamentWins = source.tournamentWins.filter((win) =>
    inRange(win.completedAt, weekStart, now),
  ).length;
  const previousWeekTournamentWins = source.tournamentWins.filter((win) =>
    inRange(win.completedAt, previousWeekStart, weekStart),
  ).length;

  const sumPrizes = (start?: Date, end?: Date) =>
    source.prizeEntries.reduce((sum, entry) => {
      if (start && end && !inRange(entry.createdAt, start, end)) return sum;
      return sum.plus(entry.amount);
    }, new Prisma.Decimal(0));
  const totalWinnings = sumPrizes();
  const weeklyPrizeTrend = sumPrizes(weekStart, now).minus(
    sumPrizes(previousWeekStart, weekStart),
  );

  const accomplishments = matches.map((match) =>
    analyzeMatch(match, match.seat),
  );
  const successfulNilBids = accomplishments.reduce(
    (sum, item) => sum + item.successfulNilBids,
    0,
  );
  const exactBidWins = accomplishments.filter(
    (item) => item.exactBidWin,
  ).length;
  const comebackWins = accomplishments.filter(
    (item) => item.comebackWin,
  ).length;

  const xp =
    gamesPlayed * PARTICIPATION_XP +
    wins * WIN_XP +
    source.tournamentWins.reduce(
      (sum, win) =>
        sum + Math.floor(TOURNAMENT_WIN_XP * win.xpMultiplier.toNumber()),
      0,
    );

  const achievement = (
    code: PlayerAchievementView['code'],
    title: string,
    description: string,
    progress: number,
    target: number,
  ): PlayerAchievementView => ({
    code,
    title,
    description,
    unlocked: progress >= target,
    progress: Math.min(progress, target),
    target,
  });

  const currentMonthRate = rate(currentMonthWins, currentMonthMatches.length);
  const previousMonthRate = rate(
    previousMonthWins,
    previousMonthMatches.length,
  );

  return {
    formulaVersion: PLAYER_PROGRESSION_FORMULA_VERSION,
    timeZone: PLAYER_STATS_TIME_ZONE,
    asOf: now.toISOString(),
    firstName: source.firstName,
    stats: {
      gamesPlayed,
      wins,
      losses: gamesPlayed - wins,
      winRate: rate(wins, gamesPlayed),
      currentStreak: streak.current,
      bestStreak: streak.best,
      tournamentWins: source.tournamentWins.length,
      totalWinnings: formatMoney(totalWinnings),
      lastTenGames: results
        .slice(-10)
        .reverse()
        .map((won) => (won ? 'W' : 'L')),
    },
    trends: {
      gamesPlayed: currentWeekMatches.length - previousWeekMatches.length,
      tournamentWins: currentWeekTournamentWins - previousWeekTournamentWins,
      totalWinnings: formatMoney(weeklyPrizeTrend),
      winRatePoints:
        currentMonthMatches.length > 0 && previousMonthMatches.length > 0
          ? currentMonthRate - previousMonthRate
          : 0,
    },
    progression: progressionFor(xp),
    achievements: [
      achievement('FIRST_WIN', 'First Win', 'Win your first game', wins, 1),
      achievement(
        'NIL_MASTER',
        'Nil Master',
        'Successfully complete 10 nil bids',
        successfulNilBids,
        10,
      ),
      achievement(
        'PERFECT_GAME',
        'Perfect Game',
        'Win with exactly your bid',
        exactBidWins,
        1,
      ),
      achievement(
        'COMEBACK_KING',
        'Comeback King',
        'Win after being down 200+ points',
        comebackWins,
        1,
      ),
    ],
  };
}
