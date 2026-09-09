import { Injectable, NotFoundException } from '@nestjs/common';

import { PlayerOverviewRepository } from './player-overview.repository';
import { buildPlayerOverview } from './player-progression.formula';

@Injectable()
export class PlayerOverviewService {
  constructor(private readonly repository: PlayerOverviewRepository) {}

  async overview(userId: string) {
    const source = await this.repository.sourceFor(userId);
    if (!source) throw new NotFoundException('Player not found.');
    return buildPlayerOverview(source);
  }

  async stats(userId: string) {
    const overview = await this.overview(userId);
    return {
      formulaVersion: overview.formulaVersion,
      timeZone: overview.timeZone,
      asOf: overview.asOf,
      stats: overview.stats,
      trends: overview.trends,
      progression: overview.progression,
    };
  }

  async achievements(userId: string) {
    const overview = await this.overview(userId);
    return {
      formulaVersion: overview.formulaVersion,
      asOf: overview.asOf,
      achievements: overview.achievements,
    };
  }
}
