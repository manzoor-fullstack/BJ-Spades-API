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

/**
 * A non-negative amount with at most two decimal places, as a string.
 *
 * Money is a string on the way in as well as on the way out. It reaches a
 * `NUMERIC(18,2)` column whose range exceeds what an IEEE-754 double holds
 * exactly, so parsing it as a number first would quietly round it. The pattern
 * also does the rejecting that the column would otherwise do silently: Postgres
 * *rounds* a third decimal rather than refusing it, so `19.999` would be stored
 * as `20.00` and the client would never learn its price changed.
 *
 * A leading `-` simply does not match, which is what rejects negatives.
 *
 * `create-tournament.dto.ts` carries its own copy predating this one; Phase 5 is
 * not permitted to touch the tournaments module, so the two are reconciled when
 * that file is next edited.
 */
export const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;

/** True when a string is a well-formed, non-negative two-decimal amount. */
export function isValidMoneyString(value: string): boolean {
  return MONEY_PATTERN.test(value);
}
