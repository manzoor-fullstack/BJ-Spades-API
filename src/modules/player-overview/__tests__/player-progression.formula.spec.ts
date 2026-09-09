import { GameEventType, GameMatchStatus, Prisma } from '@prisma/client';

import type {
  PlayerOverviewMatch,
  PlayerOverviewSource,
} from '../player-overview.types';
import {
  buildPlayerOverview,
  PLAYER_PROGRESSION_FORMULA_VERSION,
} from '../player-progression.formula';

const NOW = new Date('2026-09-09T12:00:00.000Z');

function match(
  id: string,
  completedAt: string,
  won: boolean,
  events: PlayerOverviewMatch['events'] = [],
): PlayerOverviewMatch {
  return {
    id,
    seat: 0,
    team: 0,
    winnerTeam: won ? 0 : 1,
    status: GameMatchStatus.COMPLETED,
    completedAt: new Date(completedAt),
    events,
  };
}

function source(
  input: Partial<Omit<PlayerOverviewSource, 'firstName'>> = {},
): PlayerOverviewSource {
  return {
    firstName: 'John',
    matches: input.matches ?? [],
    tournamentWins: input.tournamentWins ?? [],
    prizeEntries: input.prizeEntries ?? [],
  };
}

describe('player progression formula v1', () => {
  it('returns honest zero-history values without NaN or fabricated trends', () => {
    const result = buildPlayerOverview(source(), NOW);

    expect(result.formulaVersion).toBe(PLAYER_PROGRESSION_FORMULA_VERSION);
    expect(result.stats).toEqual({
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      currentStreak: 0,
      bestStreak: 0,
      tournamentWins: 0,
      totalWinnings: '0.00',
      lastTenGames: [],
    });
    expect(result.trends).toEqual({
      gamesPlayed: 0,
      tournamentWins: 0,
      totalWinnings: '0.00',
      winRatePoints: 0,
    });
    expect(result.progression).toMatchObject({
      xp: 0,
      rank: 'ROOKIE',
      nextRank: 'BRONZE',
      rankProgressPercent: 0,
    });
    expect(JSON.stringify(result)).not.toContain('NaN');
  });

  it('calculates exact totals, UTC period trends, streaks and XP', () => {
    const result = buildPlayerOverview(
      source({
        matches: [
          match('august-loss', '2026-08-20T10:00:00.000Z', false),
          match('previous-week-win', '2026-09-02T10:00:00.000Z', true),
          match('current-week-win-1', '2026-09-08T10:00:00.000Z', true),
          match('current-week-win-2', '2026-09-09T10:00:00.000Z', true),
        ],
        tournamentWins: [
          {
            completedAt: new Date('2026-09-02T12:00:00.000Z'),
            xpMultiplier: new Prisma.Decimal('1.00'),
          },
          {
            completedAt: new Date('2026-09-08T12:00:00.000Z'),
            xpMultiplier: new Prisma.Decimal('2.50'),
          },
        ],
        prizeEntries: [
          {
            amount: new Prisma.Decimal('40.00'),
            createdAt: new Date('2026-09-02T12:00:00.000Z'),
          },
          {
            amount: new Prisma.Decimal('100.00'),
            createdAt: new Date('2026-09-08T12:00:00.000Z'),
          },
        ],
      }),
      NOW,
    );

    expect(result.stats).toMatchObject({
      gamesPlayed: 4,
      wins: 3,
      losses: 1,
      winRate: 75,
      currentStreak: 3,
      bestStreak: 3,
      tournamentWins: 2,
      totalWinnings: '140.00',
      lastTenGames: ['W', 'W', 'W', 'L'],
    });
    expect(result.trends).toEqual({
      gamesPlayed: 1,
      tournamentWins: 0,
      totalWinnings: '60.00',
      winRatePoints: 100,
    });
    expect(result.progression).toMatchObject({ xp: 1_045, rank: 'BRONZE' });
  });

  it('reconstructs achievements from authoritative event history', () => {
    let sequence = 1;
    const events: PlayerOverviewMatch['events'] = [];
    for (let hand = 1; hand <= 10; hand += 1) {
      events.push({
        sequence: sequence++,
        type: GameEventType.BID_PLACED,
        payload: { seat: 0, bid: 0, blindNil: false },
      });
      events.push({
        sequence: sequence++,
        type: GameEventType.HAND_COMPLETED,
        payload: { seat: 3, card: '2C', teamScores: [0, 250] },
      });
    }
    events.push({
      sequence: sequence++,
      type: GameEventType.BID_PLACED,
      payload: { seat: 0, bid: 1, blindNil: false },
    });
    events.push(
      {
        sequence: sequence++,
        type: GameEventType.CARD_PLAYED,
        payload: { seat: 0, card: 'AS', teamScores: [0, 250] },
      },
      {
        sequence: sequence++,
        type: GameEventType.CARD_PLAYED,
        payload: { seat: 1, card: '2H', teamScores: [0, 250] },
      },
      {
        sequence: sequence++,
        type: GameEventType.CARD_PLAYED,
        payload: { seat: 2, card: '3H', teamScores: [0, 250] },
      },
      {
        sequence: sequence++,
        type: GameEventType.MATCH_COMPLETED,
        payload: { seat: 3, card: '4H', teamScores: [500, 250] },
      },
    );

    const result = buildPlayerOverview(
      source({
        matches: [
          match('achievement-match', '2026-09-09T10:00:00.000Z', true, events),
        ],
      }),
      NOW,
    );

    expect(
      Object.fromEntries(
        result.achievements.map((achievement) => [
          achievement.code,
          achievement.unlocked,
        ]),
      ),
    ).toEqual({
      FIRST_WIN: true,
      NIL_MASTER: true,
      PERFECT_GAME: true,
      COMEBACK_KING: true,
    });
  });

  it('rebuilds from corrected sources instead of accumulating counters', () => {
    const original = source({
      matches: [match('same-result', '2026-09-09T10:00:00.000Z', true)],
      tournamentWins: [
        {
          completedAt: new Date('2026-09-09T10:00:00.000Z'),
          xpMultiplier: new Prisma.Decimal(1),
        },
      ],
      prizeEntries: [
        {
          amount: new Prisma.Decimal(100),
          createdAt: new Date('2026-09-09T10:00:00.000Z'),
        },
      ],
    });

    expect(buildPlayerOverview(original, NOW).progression.xp).toBe(300);
    expect(buildPlayerOverview(original, NOW).progression.xp).toBe(300);

    const corrected = source({
      matches: [match('same-result', '2026-09-09T10:00:00.000Z', false)],
      prizeEntries: [
        {
          amount: new Prisma.Decimal(100),
          createdAt: new Date('2026-09-09T10:00:00.000Z'),
        },
        {
          amount: new Prisma.Decimal(-100),
          createdAt: new Date('2026-09-09T11:00:00.000Z'),
        },
      ],
    });
    const rebuilt = buildPlayerOverview(corrected, NOW);
    expect(rebuilt.progression.xp).toBe(20);
    expect(rebuilt.stats.totalWinnings).toBe('0.00');
    expect(rebuilt.stats.tournamentWins).toBe(0);
  });

  it.each([
    [0, 'ROOKIE', 'BRONZE'],
    [500, 'BRONZE', 'SILVER'],
    [1_500, 'SILVER', 'GOLD'],
    [3_500, 'GOLD', 'PLATINUM'],
    [7_000, 'PLATINUM', 'DIAMOND'],
    [12_000, 'DIAMOND', 'MASTER'],
    [20_000, 'MASTER', null],
  ] as const)(
    'assigns %i XP to %s with next rank %s',
    (xp, expectedRank, expectedNextRank) => {
      const result = buildPlayerOverview(
        source({
          tournamentWins: Array.from({ length: xp / 250 }, () => ({
            completedAt: NOW,
            xpMultiplier: new Prisma.Decimal(1),
          })),
        }),
        new Date(NOW.getTime() + 1),
      );

      expect(result.progression).toMatchObject({
        xp,
        rank: expectedRank,
        nextRank: expectedNextRank,
      });
    },
  );
});
