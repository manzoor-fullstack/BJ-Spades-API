import { Injectable } from '@nestjs/common';

import { formatMoney } from '../../common/money/money.util';

import { DashboardStatsDto } from './dto/dashboard-stats.dto';
import { monthPeriod, percentageChange, quarterPeriod } from './period.util';
import { DashboardRepository } from './repositories/dashboard.repository';

/**
 * Sixty seconds, because none of these figures is operationally time-critical:
 * an admin does not need to see the user count change the instant it does. The
 * dashboard is the most-visited page and these are the heaviest queries in the
 * system, so one aggregation pass per minute regardless of how many admins are
 * watching is the trade being made (docs/phases/PHASE-8.md, 8.4).
 */
export const DASHBOARD_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: DashboardStatsDto;
  /** Epoch milliseconds after which the entry is stale. */
  expiresAt: number;
}

@Injectable()
export class DashboardService {
  private cache: CacheEntry | null = null;

  constructor(private readonly repository: DashboardRepository) {}

  async getStats(now: Date = new Date()): Promise<DashboardStatsDto> {
    const cached = this.cache;

    if (cached && cached.expiresAt > now.getTime()) {
      return cached.value;
    }

    const value = await this.computeStats(now);

    this.cache = { value, expiresAt: now.getTime() + DASHBOARD_CACHE_TTL_MS };

    return value;
  }

  /**
   * Drops the cached figures.
   *
   * Nothing in the application calls this — a stale count for up to a minute is
   * the whole point of the cache. It exists for the integration suite, which
   * writes rows and then asserts the endpoint reflects them.
   */
  clearCache(): void {
    this.cache = null;
  }

  private async computeStats(now: Date): Promise<DashboardStatsDto> {
    const thisMonth = monthPeriod(now);
    const lastMonth = monthPeriod(now, 1);
    const thisQuarter = quarterPeriod(now);
    const lastQuarter = quarterPeriod(now, 1);

    const [
      totalUsers,
      usersThisMonth,
      totalRevenue,
      revenueThisMonth,
      revenueLastMonth,
      activeTournaments,
      usersThisQuarter,
      usersLastQuarter,
    ] = await Promise.all([
      this.repository.countUsers(),
      this.repository.countUsersCreatedIn(thisMonth),
      this.repository.sumEntryFeeRevenue(),
      this.repository.sumEntryFeeRevenueIn(thisMonth),
      this.repository.sumEntryFeeRevenueIn(lastMonth),
      this.repository.countActiveTournaments(),
      this.repository.countUsersCreatedIn(thisQuarter),
      this.repository.countUsersCreatedIn(lastQuarter),
    ]);

    return {
      totalUsers: {
        value: totalUsers,
        change: usersThisMonth,
        changeLabel: 'this month',
      },
      totalRevenue: {
        value: formatMoney(totalRevenue),
        // toNumber() is safe here and only here: the comparison is a ratio
        // rendered to one decimal place, not a stored amount. Every figure that
        // is displayed as money stays a Decimal until formatMoney.
        changePercent: percentageChange(
          revenueThisMonth.toNumber(),
          revenueLastMonth.toNumber(),
        ),
        changeLabel: 'from last month',
      },
      activeTournaments: {
        value: activeTournaments,
        subLabel: `${activeTournaments} tournaments running`,
      },
      platformGrowth: {
        value: percentageChange(usersThisQuarter, usersLastQuarter),
        changeLabel: 'vs. last quarter',
      },
    };
  }
}
