/** A half-open interval, `[start, end)`. */
export interface Period {
  start: Date;
  end: Date;
}

/**
 * Periods are computed in UTC.
 *
 * `company.timezone` exists, but it is a *display* setting: it decides how a
 * timestamp is rendered, not which rows an aggregate counts. Bucketing the
 * database by a configurable timezone would make "users this month" change
 * meaning when someone edits a dropdown, and make the cached figure wrong for
 * everyone who does not share it.
 */
function utc(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
}

/**
 * The calendar month containing `now`, shifted back by `monthsAgo`.
 *
 * `Date.UTC` normalises an out-of-range month, so December of the previous year
 * comes out of `utc(2026, -1)` without a special case.
 */
export function monthPeriod(now: Date, monthsAgo = 0): Period {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - monthsAgo;

  return { start: utc(year, month), end: utc(year, month + 1) };
}

/** The calendar quarter containing `now`, shifted back by `quartersAgo`. */
export function quarterPeriod(now: Date, quartersAgo = 0): Period {
  const year = now.getUTCFullYear();
  const quarterStartMonth =
    Math.floor(now.getUTCMonth() / 3) * 3 - quartersAgo * 3;

  return {
    start: utc(year, quarterStartMonth),
    end: utc(year, quarterStartMonth + 3),
  };
}

/**
 * Percentage change from `previous` to `current`, to one decimal place.
 *
 * **Null when there is no baseline.** The first month of operation has no prior
 * month, and the naive formula divides by zero — the classic bug this endpoint
 * exists to avoid. Reporting `0` instead would say "no change" about a period
 * that grew from nothing, and reporting `100` would say the platform doubled.
 * Neither is true, so the API says it does not know and the card renders a dash.
 */
export function percentageChange(
  current: number,
  previous: number,
): number | null {
  if (previous === 0) {
    return null;
  }

  return Math.round(((current - previous) / previous) * 1000) / 10;
}
