import { Injectable } from '@nestjs/common';

import {
  LeaderboardPeriod,
  LeaderboardQueryDto,
} from './dto/leaderboard-query.dto';
import { buildLeaderboard } from './leaderboard.formula';
import { LeaderboardRepository } from './leaderboard.repository';
import type { LeaderboardEntry, LeaderboardSource } from './leaderboard.types';

@Injectable()
export class LeaderboardService {
  private cached: {
    revision: string;
    source: LeaderboardSource;
    expiresAt: number;
  } | null = null;

  constructor(private readonly repository: LeaderboardRepository) {}

  private async source(): Promise<LeaderboardSource> {
    const revision = await this.repository.revision();
    const now = Date.now();
    if (
      this.cached &&
      this.cached.revision === revision &&
      this.cached.expiresAt > now
    ) {
      return this.cached.source;
    }
    const source = await this.repository.source();
    this.cached = { revision, source, expiresAt: now + 15_000 };
    return source;
  }

  async leaderboard(viewerId: string, query: LeaderboardQueryDto) {
    return buildLeaderboard(
      await this.source(),
      viewerId,
      query.period,
      query.page,
      query.limit,
    );
  }

  async me(viewerId: string, query: LeaderboardQueryDto) {
    const result = await this.leaderboard(viewerId, query);
    return {
      formulaVersion: result.formulaVersion,
      timeZone: result.timeZone,
      period: result.period,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      asOf: result.asOf,
      me: result.me,
    };
  }

  async entriesFor(
    playerIds: string[],
  ): Promise<Map<string, LeaderboardEntry>> {
    if (playerIds.length === 0) return new Map<string, LeaderboardEntry>();
    const source = await this.source();
    const result = buildLeaderboard(
      source,
      '',
      LeaderboardPeriod.ALL_TIME,
      1,
      Math.max(1, source.players.length),
    );
    const wanted = new Set(playerIds);
    return new Map(
      result.items
        .filter((entry) => wanted.has(entry.playerId))
        .map((entry) => [entry.playerId, entry]),
    );
  }
}
