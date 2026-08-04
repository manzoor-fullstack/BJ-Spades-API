import { Prisma } from '@prisma/client';

/** Anything the database or an inbound DTO can hand us for a money column. */
export type MoneyInput = Prisma.Decimal | string | number;

export type Money = Prisma.Decimal;

/**
 * Money is NUMERIC(18,2) in Postgres and `Decimal` in the Prisma client.
 *
 * Every arithmetic operation on a balance goes through this helper so no code
 * path ever falls back to IEEE-754 floats — `0.1 + 0.2` in a ledger becomes an
 * accounting discrepancy nobody can reconcile.
 */
export function toMoney(value: MoneyInput): Money {
  return new Prisma.Decimal(value);
}

/**
 * Money is serialised as a fixed two-decimal STRING in every API response.
 * A JSON number would be parsed back as a float by the client and lose the
 * precision the database went to the trouble of keeping.
 */
export function formatMoney(value: MoneyInput): string {
  return toMoney(value).toFixed(2);
}

export function isNegativeMoney(value: MoneyInput): boolean {
  return toMoney(value).isNegative();
}
