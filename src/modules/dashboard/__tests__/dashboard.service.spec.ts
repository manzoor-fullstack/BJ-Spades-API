import { Prisma } from '@prisma/client';

import { DASHBOARD_CACHE_TTL_MS, DashboardService } from '../dashboard.service';
import { monthPeriod, percentageChange, quarterPeriod } from '../period.util';
import type { DashboardRepository } from '../repositories/dashboard.repository';

type MockedRepository = { [K in keyof DashboardRepository]: jest.Mock };

const NOW = new Date('2026-08-06T12:00:00.000Z');

function money(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('percentageChange', () => {
  it('reports growth', () => {
    expect(percentageChange(150, 100)).toBe(50);
  });

  it('reports decline as a negative', () => {
    expect(percentageChange(75, 100)).toBe(-25);
  });

  it('reports no change as zero', () => {
    expect(percentageChange(100, 100)).toBe(0);
  });

  it('rounds to one decimal place', () => {
    expect(percentageChange(1234, 1000)).toBe(23.4);
  });

  // The classic bug this endpoint exists to avoid: the first month of
  // operation has no prior month, and the naive formula divides by zero.
  it('returns null rather than dividing by zero when there is no baseline', () => {
    expect(percentageChange(500, 0)).toBeNull();
  });

  it('returns null even when the current period is also empty', () => {
    // 0 from 0 is not "no change" — there is nothing to have changed from.
    expect(percentageChange(0, 0)).toBeNull();
  });

  it('never returns Infinity or NaN', () => {
    for (const [current, previous] of [
      [1, 0],
      [0, 0],
      [-1, 0],
    ]) {
      const result = percentageChange(current!, previous!);

      expect(Number.isFinite(result ?? 0)).toBe(true);
    }
  });
});

describe('period boundaries', () => {
  it('bounds the current month half-open, in UTC', () => {
    expect(monthPeriod(NOW)).toEqual({
      start: new Date('2026-08-01T00:00:00.000Z'),
      end: new Date('2026-09-01T00:00:00.000Z'),
    });
  });

  it('bounds the previous month', () => {
    expect(monthPeriod(NOW, 1)).toEqual({
      start: new Date('2026-07-01T00:00:00.000Z'),
      end: new Date('2026-08-01T00:00:00.000Z'),
    });
  });

  it('rolls back across a year boundary', () => {
    expect(monthPeriod(new Date('2026-01-15T00:00:00.000Z'), 1)).toEqual({
      start: new Date('2025-12-01T00:00:00.000Z'),
      end: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('bounds the current quarter', () => {
    // August sits in Q3: July, August, September.
    expect(quarterPeriod(NOW)).toEqual({
      start: new Date('2026-07-01T00:00:00.000Z'),
      end: new Date('2026-10-01T00:00:00.000Z'),
    });
  });

  it('bounds the previous quarter', () => {
    expect(quarterPeriod(NOW, 1)).toEqual({
      start: new Date('2026-04-01T00:00:00.000Z'),
      end: new Date('2026-07-01T00:00:00.000Z'),
    });
  });

  it('rolls a quarter back across a year boundary', () => {
    expect(quarterPeriod(new Date('2026-02-10T00:00:00.000Z'), 1)).toEqual({
      start: new Date('2025-10-01T00:00:00.000Z'),
      end: new Date('2026-01-01T00:00:00.000Z'),
    });
  });
});

describe('DashboardService', () => {
  let repository: MockedRepository;
  let service: DashboardService;

  /**
   * `countUsersCreatedIn` is asked three questions — this month, this quarter,
   * last quarter — and the period it is handed is what distinguishes them.
   */
  function usersCreatedIn(counts: {
    thisMonth: number;
    thisQuarter: number;
    lastQuarter: number;
  }): jest.Mock {
    const thisMonth = monthPeriod(NOW);
    const thisQuarter = quarterPeriod(NOW);

    return jest.fn((period: { start: Date; end: Date }) => {
      if (period.start.getTime() === thisMonth.start.getTime()) {
        return Promise.resolve(counts.thisMonth);
      }

      if (period.start.getTime() === thisQuarter.start.getTime()) {
        return Promise.resolve(counts.thisQuarter);
      }

      return Promise.resolve(counts.lastQuarter);
    });
  }

  function revenueIn(thisMonth: string, lastMonth: string): jest.Mock {
    const current = monthPeriod(NOW);

    return jest.fn((period: { start: Date }) =>
      Promise.resolve(
        period.start.getTime() === current.start.getTime()
          ? money(thisMonth)
          : money(lastMonth),
      ),
    );
  }

  beforeEach(() => {
    repository = {
      countUsers: jest.fn().mockResolvedValue(2847),
      countUsersCreatedIn: usersCreatedIn({
        thisMonth: 124,
        thisQuarter: 300,
        lastQuarter: 250,
      }),
      sumEntryFeeRevenue: jest.fn().mockResolvedValue(money('48290.00')),
      sumEntryFeeRevenueIn: revenueIn('9000.00', '8000.00'),
      countActiveTournaments: jest.fn().mockResolvedValue(23),
    };

    service = new DashboardService(
      repository as unknown as DashboardRepository,
    );
  });

  it('builds all four cards from real aggregates', async () => {
    await expect(service.getStats(NOW)).resolves.toEqual({
      totalUsers: { value: 2847, change: 124, changeLabel: 'this month' },
      totalRevenue: {
        value: '48290.00',
        changePercent: 12.5,
        changeLabel: 'from last month',
      },
      activeTournaments: { value: 23, subLabel: '23 tournaments running' },
      platformGrowth: { value: 20, changeLabel: 'vs. last quarter' },
    });
  });

  it('serialises revenue as a fixed two-decimal string, never a float', async () => {
    repository.sumEntryFeeRevenue.mockResolvedValue(money('1234.5'));

    const stats = await service.getStats(NOW);

    expect(stats.totalRevenue.value).toBe('1234.50');
    expect(typeof stats.totalRevenue.value).toBe('string');
  });

  it('reports zero revenue as "0.00" rather than omitting the card', async () => {
    // The ledger may legitimately be empty before any entry fee has settled.
    repository.sumEntryFeeRevenue.mockResolvedValue(money('0'));
    repository.sumEntryFeeRevenueIn = revenueIn('0', '0');

    const stats = await service.getStats(NOW);

    expect(stats.totalRevenue.value).toBe('0.00');
    expect(stats.totalRevenue.changePercent).toBeNull();
  });

  it('does not divide by zero when last month had no revenue', async () => {
    repository.sumEntryFeeRevenueIn = revenueIn('500.00', '0');

    const stats = await service.getStats(NOW);

    expect(stats.totalRevenue.changePercent).toBeNull();
  });

  it('does not divide by zero when the previous quarter added no users', async () => {
    repository.countUsersCreatedIn = usersCreatedIn({
      thisMonth: 10,
      thisQuarter: 40,
      lastQuarter: 0,
    });

    const stats = await service.getStats(NOW);

    expect(stats.platformGrowth.value).toBeNull();
  });

  it('reports a decline as a negative percentage', async () => {
    repository.sumEntryFeeRevenueIn = revenueIn('6000.00', '8000.00');

    const stats = await service.getStats(NOW);

    expect(stats.totalRevenue.changePercent).toBe(-25);
  });

  it('reports an unchanged quarter as zero, not null', async () => {
    repository.countUsersCreatedIn = usersCreatedIn({
      thisMonth: 10,
      thisQuarter: 250,
      lastQuarter: 250,
    });

    const stats = await service.getStats(NOW);

    expect(stats.platformGrowth.value).toBe(0);
  });

  describe('cache', () => {
    it('serves a second call inside the window without re-querying', async () => {
      await service.getStats(NOW);
      await service.getStats(new Date(NOW.getTime() + 59_000));

      expect(repository.countUsers).toHaveBeenCalledTimes(1);
    });

    it('recomputes once the window has passed', async () => {
      await service.getStats(NOW);
      await service.getStats(
        new Date(NOW.getTime() + DASHBOARD_CACHE_TTL_MS + 1),
      );

      expect(repository.countUsers).toHaveBeenCalledTimes(2);
    });

    it('returns the figures that were cached, not the newer ones', async () => {
      const first = await service.getStats(NOW);

      repository.countUsers.mockResolvedValue(9999);

      const second = await service.getStats(new Date(NOW.getTime() + 1000));

      expect(second).toEqual(first);
      expect(second.totalUsers.value).toBe(2847);
    });

    it('recomputes immediately once the cache is cleared', async () => {
      await service.getStats(NOW);
      service.clearCache();
      await service.getStats(NOW);

      expect(repository.countUsers).toHaveBeenCalledTimes(2);
    });
  });
});
