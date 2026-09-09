import { UserStatus } from '@prisma/client';

import { LeaderboardPeriod } from '../dto/leaderboard-query.dto';
import { buildLeaderboard } from '../leaderboard.formula';
import type { LeaderboardSource } from '../leaderboard.types';

const NOW = new Date('2026-09-09T12:00:00.000Z');

function player(
  id: string,
  overrides: Partial<LeaderboardSource['players'][number]> = {},
): LeaderboardSource['players'][number] {
  return {
    id,
    displayName: `Player ${id}`,
    country: 'PK',
    avatarBackground: '#a855f7',
    status: UserStatus.ACTIVE,
    visible: true,
    ...overrides,
  };
}

function match(
  id: string,
  completedAt: string,
  winnerTeam: number,
  zero: string[],
  one: string[],
): LeaderboardSource['matches'][number] {
  return {
    id,
    completedAt: new Date(completedAt),
    winnerTeam,
    seats: [
      ...zero.map((userId) => ({ userId, team: 0, disqualified: false })),
      ...one.map((userId) => ({ userId, team: 1, disqualified: false })),
    ],
  };
}

describe('buildLeaderboard', () => {
  it('computes deterministic team ELO, ties and current-player position outside the page', () => {
    const source: LeaderboardSource = {
      players: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => player(id)),
      matches: [
        match('1', '2026-09-09T08:00:00.000Z', 0, ['a', 'b'], ['e', 'f']),
        match('2', '2026-09-09T09:00:00.000Z', 0, ['c', 'd'], ['e', 'f']),
      ],
    };

    const result = buildLeaderboard(
      source,
      'f',
      LeaderboardPeriod.TODAY,
      1,
      2,
      NOW,
    );

    expect(
      result.items.map(({ playerId, rank, rating }) => ({
        playerId,
        rank,
        rating,
      })),
    ).toEqual([
      { playerId: 'a', rank: 1, rating: 1512 },
      { playerId: 'b', rank: 1, rating: 1512 },
    ]);
    expect(result.meta).toEqual({ page: 1, limit: 2, total: 6, totalPages: 3 });
    expect(result.me).toMatchObject({
      playerId: 'f',
      rank: 5,
      rating: 1476,
      percentile: 84,
      localRank: 5,
    });
  });

  it.each([
    [LeaderboardPeriod.TODAY, 1, '2026-09-09T00:00:00.000Z'],
    [LeaderboardPeriod.WEEK, 2, '2026-09-07T00:00:00.000Z'],
    [LeaderboardPeriod.MONTH, 3, '2026-09-01T00:00:00.000Z'],
    [LeaderboardPeriod.SEASON, 4, '2026-07-01T00:00:00.000Z'],
    [LeaderboardPeriod.ALL_TIME, 5, null],
  ])('applies the %s UTC boundary', (period, gamesPlayed, periodStart) => {
    const source: LeaderboardSource = {
      players: [player('a'), player('b')],
      matches: [
        match('today', '2026-09-09T00:00:00.000Z', 0, ['a'], ['b']),
        match('week', '2026-09-07T00:00:00.000Z', 0, ['a'], ['b']),
        match('month', '2026-09-01T00:00:00.000Z', 0, ['a'], ['b']),
        match('season', '2026-07-01T00:00:00.000Z', 0, ['a'], ['b']),
        match('old', '2026-06-30T23:59:59.999Z', 0, ['a'], ['b']),
      ],
    };
    const result = buildLeaderboard(source, 'a', period, 1, 10, NOW);
    expect(result.me?.gamesPlayed).toBe(gamesPlayed);
    expect(result.periodStart).toBe(periodStart);
  });

  it('excludes hidden, suspended and disqualified players without exposing private fields', () => {
    const source: LeaderboardSource = {
      players: [
        player('viewer'),
        player('hidden', { visible: false }),
        player('suspended', { status: UserStatus.SUSPENDED }),
        player('opponent'),
      ],
      matches: [
        match(
          '1',
          '2026-09-09T10:00:00.000Z',
          0,
          ['viewer'],
          ['opponent', 'hidden', 'suspended'],
        ),
      ],
    };
    source.matches[0]!.seats.find(
      (seat) => seat.userId === 'opponent',
    )!.disqualified = true;

    const result = buildLeaderboard(
      source,
      'viewer',
      LeaderboardPeriod.TODAY,
      1,
      10,
      NOW,
    );

    expect(result.items).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/email|country|status|visible/i);
  });

  it('rebuilds immediately from a corrected winner', () => {
    const source: LeaderboardSource = {
      players: [player('a'), player('b')],
      matches: [match('1', '2026-09-09T10:00:00.000Z', 0, ['a'], ['b'])],
    };
    expect(
      buildLeaderboard(source, 'a', LeaderboardPeriod.TODAY, 1, 10, NOW)
        .items[0]?.playerId,
    ).toBe('a');
    source.matches[0]!.winnerTeam = 1;
    expect(
      buildLeaderboard(source, 'a', LeaderboardPeriod.TODAY, 1, 10, NOW)
        .items[0]?.playerId,
    ).toBe('b');
  });
});
